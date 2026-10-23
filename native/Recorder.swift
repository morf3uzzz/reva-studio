import AppKit
@preconcurrency import AVFoundation
import ScreenCaptureKit
import CoreMedia
import CoreVideo

struct RecordingInfo: Encodable {
    struct CursorSourceSize: Encodable { let width: Double; let height: Double }
    let output: String
    let cursorOutput: String
    let activityOutput: String
    let duration: Double
    let width: Int
    let height: Int
    let cameraPath: String?
    let microphonePath: String?
    let cameraStartTime: Double?
    let cameraEndTime: Double?
    let droppedVideoFrames: Int
    let droppedAudioBuffers: Int
    let cursorSourceSize: CursorSourceSize
}

/// Main-actor methods own capture lifecycle; sampleQueue alone owns writers and media timing.
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    let options: CaptureOptions
    let onFailure: (Error) -> Void
    let cancellation: CaptureCancellation
    private let sampleQueue = DispatchQueue(label: "com.reva.studio.capture.samples", qos: .userInitiated)
    private let deviceQueue = DispatchQueue(label: "com.reva.studio.capture.devices", qos: .userInitiated)
    private var stream: SCStream?
    private var audioStream: SCStream?
    private var audioStreamStarted = false
    private var session: AVCaptureSession?
    private var sessionErrorObserver: NSObjectProtocol?
    private var cameraOutput: AVCaptureVideoDataOutput?
    private var microphoneOutput: AVCaptureAudioDataOutput?
    private var screenDeviceOutput: AVCaptureVideoDataOutput?
    private var screenDeviceAudioOutput: AVCaptureAudioDataOutput?
    private var screenDeviceScaler: ConnectedScreenFrameScaler?
    private var shortcutMonitor: CaptureShortcutMonitor?
    private var cursorTimer: DispatchSourceTimer?
    private var screenWriter: MediaWriter?
    private var cameraWriter: MediaWriter?
    private let cameraScaler: CameraFrameScaler
    private var microphoneWriter: MediaWriter?
    private var cursorWriter: CursorWriter?
    private var cursorPoll = CursorPollState()
    private var timeline: RecordingTimeline?
    private var activityWriter: CaptureJSONWriter<RecordingActivity>?
    private var typingCounter = TypingCounter()
    private var recoveryJournal: RecordingRecoveryJournal?
    private var lastCheckpoint = 0.0
    private var acceptingSamples = false
    private var reportedFailure = false
    private var firstFrameWaiter: CheckedContinuation<Void, Error>?
    private var firstFrameError: Error?
    private var sourceBounds = CGRect.zero
    private var cursorBounds = CGRect.zero
    private var cursorDestination = CGRect(x: 0, y: 0, width: 1, height: 1)
    private var sourceWindow: CGWindowID?
    private var crop: CGRect = .zero
    private(set) var width = 0
    private(set) var height = 0
    private var streamStarted = false
    private var stopped = false
    private let live: LiveInputOutput
    private(set) var cameraDeviceID: String?
    private(set) var microphoneDeviceID: String?

    init(options: CaptureOptions, cancellation: CaptureCancellation, onFailure: @escaping (Error) -> Void) {
        self.options = options
        cameraScaler = CameraFrameScaler(maximumHeight: options.cameraMaxResolution)
        self.cancellation = cancellation
        self.onFailure = onFailure
        live = LiveInputOutput(previewCamera: options.previewCamera, monitorMicrophone: options.monitorMicrophone)
    }

    func activateLiveOutput() { live.activate() }
    func setCameraPreview(_ enabled: Bool) throws {
        guard options.camera else { throw CaptureFailure(code: "camera_not_recording", message: "No camera is being recorded by this helper.") }
        live.setCameraPreview(enabled)
    }

    @MainActor func showCameraEffects() throws -> String {
        guard options.camera, let cameraDeviceID, session?.isRunning == true, !stopped else {
            throw CaptureFailure(code: "camera_not_active", message: "Start a camera preview or camera recording before opening macOS Video Effects.")
        }
        AVCaptureDevice.showSystemUserInterface(.videoEffects)
        return cameraDeviceID
    }


    func stateSnapshot() -> RecordingState {
        sampleQueue.sync {
            RecordingState(status: timeline?.isPaused == true ? "paused" : "recording", elapsedMs: (timeline?.elapsed(at: CMClockGetTime(CMClockGetHostTimeClock())).seconds ?? 0) * 1000)
        }
    }

    func setPaused(_ paused: Bool) throws -> RecordingState {
        try sampleQueue.sync {
            guard acceptingSamples, var timeline else { throw CaptureFailure(code: "recording_not_active", message: "The recording is not ready to pause or resume.") }
            let now = CMClockGetTime(CMClockGetHostTimeClock())
            if paused && !timeline.isPaused {
                sampleCursor(at: now)
                try timeline.pause(at: now)
            } else if !paused, let marker = timeline.resume(at: now) {
                try activityWriter?.append(.pause(marker))
                cursorPoll = CursorPollState()
                typingCounter.reset(to: CGEventSource.counterForEventType(.combinedSessionState, eventType: .keyDown))
            }
            self.timeline = timeline
            return RecordingState(status: timeline.isPaused ? "paused" : "recording", elapsedMs: timeline.elapsed(at: now).seconds * 1000)
        }
    }

    func markFlag() throws -> RecordingFlag? {
        try sampleQueue.sync {
            guard acceptingSamples, let timeline, let time = timeline.sampleTime(at: CMClockGetTime(CMClockGetHostTimeClock())) else { return nil }
            let flag = RecordingFlag(time: time.seconds, id: UUID().uuidString)
            try activityWriter?.append(.flag(flag))
            try checkpointRecovery(at: time.seconds)
            return flag
        }
    }

    @MainActor func start() async throws {
        try cancellation.check()
        try await CaptureSources.requestPermissions(options, cancellation: cancellation)
        if options.recordShortcuts {
            let monitor = CaptureShortcutMonitor { [weak self] keys, code in
                guard let self else { return }
                self.sampleQueue.async {
                    guard self.acceptingSamples, let timeline = self.timeline,
                          let position = timeline.sampleTime(at: CMClockGetTime(CMClockGetHostTimeClock())) else { return }
                    do { try self.activityWriter?.append(.shortcut(RecordingShortcut(time: position.seconds, keys: keys, keyCode: code))) }
                    catch { self.fail(error) }
                }
            }
            try monitor.start()
            shortcutMonitor = monitor
        }
        if options.screenDeviceID != nil {
            try await startConnectedDevice()
            return
        }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        try cancellation.check()
        let components = options.source.split(separator: ":")
        guard let identifier = UInt32(components[1]) else { throw CaptureFailure(code: "source_unavailable", message: "The source identity is invalid.") }
        let filter: SCContentFilter
        if components[0] == "display" {
            guard let display = content.displays.first(where: { $0.displayID == identifier }) else {
                throw CaptureFailure(code: "source_unavailable", message: "The selected display is no longer available.")
            }
            let excluded = content.applications.filter { $0.processID == getpid() || $0.processID == options.excludedProcessID }
            filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
            sourceBounds = display.frame
        } else {
            guard let window = content.windows.first(where: { $0.windowID == identifier }) else {
                throw CaptureFailure(code: "source_unavailable", message: "The selected window is no longer available.")
            }
            guard window.owningApplication?.processID != getpid(),
                  options.excludedProcessID == nil || window.owningApplication?.processID != options.excludedProcessID else {
                throw CaptureFailure(code: "source_excluded", message: "The recording controls cannot be selected as a recording source.")
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
            sourceBounds = window.frame
            sourceWindow = identifier
        }
        crop = try CaptureGeometry.crop(options.area, sourceSize: sourceBounds.size)
        cursorBounds = crop.offsetBy(dx: sourceBounds.minX, dy: sourceBounds.minY)
        let scale = CGFloat(filter.pointPixelScale)
        width = try CaptureGeometry.pixels(crop.width, scale: scale)
        height = try CaptureGeometry.pixels(crop.height, scale: scale)
        // Bound the six-frame ScreenCaptureKit queue to roughly 800 MB at BGRA.
        guard width * height <= 33_554_432 else {
            throw CaptureFailure(code: "unsupported_dimensions", message: "The selected source exceeds the 32 megapixel capture limit. Select a smaller area.")
        }

        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.minimumFrameInterval = CMTime(value: 1, timescale: Int32(options.fps))
        config.queueDepth = 6
        config.showsCursor = false
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.colorSpaceName = CGColorSpace.sRGB
        if options.area != nil { config.sourceRect = crop }
        config.scalesToFit = true
        config.preservesAspectRatio = true
        config.ignoreShadowsSingleWindow = true
        config.shouldBeOpaque = true
        config.capturesAudio = false
        config.excludesCurrentProcessAudio = false
        config.sampleRate = 48_000
        config.channelCount = 2
        config.streamName = "Reva Studio recording"

        try cancellation.check()
        try prepareWriters()
        if options.camera || options.microphone { try configureDevices() }
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        self.stream = stream
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        if options.systemAudio { try prepareAudioStream(content: content) }
        sampleQueue.sync { acceptingSamples = true }
        try await startDeviceSession()
        try cancellation.check()
        try await stream.startCapture()
        streamStarted = true
        if let audioStream {
            try await audioStream.startCapture()
            audioStreamStarted = true
        }
        try cancellation.check()
        try await waitForFirstFrame()
        try cancellation.check()
    }

    @MainActor func stop() async throws -> RecordingInfo {
        guard !stopped else { throw CaptureFailure(code: "already_stopped", message: "This capture has already stopped.") }
        stopped = true
        shortcutMonitor?.stop()
        shortcutMonitor = nil
        var errors: [Error] = []
        let stopTime = CMClockGetTime(CMClockGetHostTimeClock())
        let duration: CMTime = sampleQueue.sync {
            acceptingSamples = false
            cursorTimer?.cancel()
            cursorTimer = nil
            let duration = timeline?.elapsed(at: stopTime) ?? .zero
            if timeline != nil { sampleCursor(at: stopTime) }
            if let marker = timeline?.resume(at: stopTime) {
                do { try activityWriter?.append(.pause(marker)) } catch { errors.append(error) }
            }
            if let waiter = firstFrameWaiter {
                firstFrameWaiter = nil
                waiter.resume(throwing: CaptureFailure(code: "recording_cancelled", message: "Recording stopped before a screen frame was received."))
            }
            return duration
        }
        if let stream, streamStarted {
            do { try await stream.stopCapture(); streamStarted = false } catch { errors.append(error) }
        }
        if let audioStream, audioStreamStarted {
            do { try await audioStream.stopCapture(); audioStreamStarted = false } catch { errors.append(error) }
        }
        if let session {
            await withCheckedContinuation { continuation in
                deviceQueue.async { session.stopRunning(); continuation.resume() }
            }
            if session.isRunning { errors.append(CaptureFailure(code: "device_stop_failed", message: "A capture device did not stop; the helper process will release it on exit.")) }
        }
        if let observer = sessionErrorObserver { NotificationCenter.default.removeObserver(observer); sessionErrorObserver = nil }
        cameraOutput?.setSampleBufferDelegate(nil, queue: nil)
        microphoneOutput?.setSampleBufferDelegate(nil, queue: nil)
        screenDeviceOutput?.setSampleBufferDelegate(nil, queue: nil)
        screenDeviceAudioOutput?.setSampleBufferDelegate(nil, queue: nil)
        await live.finish()
        let writers = sampleQueue.sync { [screenWriter, cameraWriter, microphoneWriter].compactMap { $0 } }
        sampleQueue.sync {
            do { try checkpointRecovery(at: duration.seconds, status: "finalizing") } catch { errors.append(error) }
            do { try cursorWriter?.finish(); try activityWriter?.finish() } catch { errors.append(error) }
            for writer in writers {
                do { try writer.end(at: duration, fps: options.fps) } catch { errors.append(error) }
            }
        }
        for writer in writers {
            do { try await writer.finish() } catch { errors.append(error) }
        }
        // Keep references to any resource whose shutdown failed until process exit.
        if !streamStarted { self.stream = nil }
        if !audioStreamStarted { self.audioStream = nil }
        if self.session?.isRunning != true { self.session = nil }
        if (screenWriter?.videoFrames ?? 0) == 0 { errors.append(CaptureFailure(code: "empty_recording", message: "The screen recording contained no video frames.")) }
        if options.camera && (cameraWriter?.videoFrames ?? 0) == 0 { errors.append(CaptureFailure(code: "empty_camera_track", message: "The camera did not deliver any video frames.")) }
        if options.microphone && (microphoneWriter?.audioBuffers ?? 0) == 0 { errors.append(CaptureFailure(code: "empty_microphone_track", message: "The microphone did not deliver any audio samples.")) }
        var cameraEndTime: Double?
        if options.camera && errors.isEmpty {
            do {
                let end = try await AVURLAsset(url: options.cameraOutput).load(.duration).seconds
                guard end.isFinite, end > (cameraWriter?.firstVideoTime?.seconds ?? 0) else {
                    throw CaptureFailure(code: "camera_timing_failed", message: "The completed camera file has no finite presentation endpoint.")
                }
                cameraEndTime = end
            } catch { errors.append(error) }
        }
        sampleQueue.sync {
            do { try checkpointRecovery(at: duration.seconds, status: errors.isEmpty ? "complete" : "failed", error: errors.isEmpty ? nil : errors.map { $0.localizedDescription }.joined(separator: "; ")) }
            catch { errors.append(error) }
        }
        guard errors.isEmpty else { throw CaptureFailure(code: "finalization_failed", message: errors.map { $0.localizedDescription }.joined(separator: "; ")) }
        return RecordingInfo(output: options.output.path, cursorOutput: options.cursorOutput.path, activityOutput: options.activityOutput.path, duration: duration.seconds,
                             width: width, height: height, cameraPath: options.camera ? options.cameraOutput.path : nil,
                             microphonePath: options.microphone ? options.microphoneOutput.path : nil,
                             cameraStartTime: cameraWriter?.firstVideoTime?.seconds,
                             cameraEndTime: cameraEndTime,
                             droppedVideoFrames: writers.reduce(0) { $0 + $1.droppedVideoFrames } + cameraScaler.droppedFrames + (screenDeviceScaler?.droppedFrames ?? 0),
                             droppedAudioBuffers: writers.reduce(0) { $0 + $1.droppedAudioBuffers },
                             cursorSourceSize: .init(width: Double(crop.width), height: Double(crop.height)))
    }

    func cancelPendingStart() {
        cancellation.cancel()
        sampleQueue.async {
            guard let waiter = self.firstFrameWaiter else { return }
            self.firstFrameWaiter = nil
            waiter.resume(throwing: CaptureFailure(code: "recording_cancelled", message: "Recording was cancelled before it became ready."))
        }
    }

    private func prepareOutputDirectories() throws {
        for url in [options.output, options.cursorOutput, options.activityOutput] {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            guard !FileManager.default.fileExists(atPath: url.path) else {
                throw CaptureFailure(code: "output_exists", message: "Refusing to overwrite existing file: \(url.path)")
            }
        }
    }

    private func prepareWriters() throws {
        try prepareOutputDirectories()
        if options.screenDeviceID == nil {
            screenWriter = try MediaWriter(url: options.output, width: width, height: height, fps: options.fps, audioChannels: options.systemAudio ? 2 : nil)
        }
        cursorWriter = try CursorWriter(url: options.cursorOutput)
        activityWriter = try CaptureJSONWriter<RecordingActivity>(url: options.activityOutput)
        recoveryJournal = try RecordingRecoveryJournal(options: options, width: width, height: height)
        if options.microphone { microphoneWriter = try MediaWriter(url: options.microphoneOutput, audioChannels: 1) }
    }

    @MainActor private func startConnectedDevice() async throws {
        try cancellation.check()
        try prepareWriters()
        try configureDevices()
        sampleQueue.sync { acceptingSamples = true }
        try await startDeviceSession()
        try cancellation.check()
        try await waitForFirstFrame()
        try cancellation.check()
    }

    @MainActor private func startDeviceSession() async throws {
        guard let session else { return }
        await withCheckedContinuation { continuation in
            deviceQueue.async { session.startRunning(); continuation.resume() }
        }
        guard session.isRunning else { throw CaptureFailure(code: "device_start_failed", message: "The selected screen device, camera, or microphone could not start.") }
    }

    /// Audio has its own app filter. A video window selection must not silently
    /// narrow an explicit all-apps/group audio selection to that window's app.
    @MainActor private func prepareAudioStream(content: SCShareableContent) throws {
        guard let display = content.displays.first else { throw CaptureFailure(code: "audio_source_unavailable", message: "No display is available for system-audio capture.") }
        let filter: SCContentFilter
        if let identifiers = options.systemAudioApplications {
            let applications = content.applications.filter { identifiers.contains($0.bundleIdentifier) && $0.processID != getpid() && $0.processID != options.excludedProcessID }
            guard Set(applications.map { $0.bundleIdentifier }) == Set(identifiers) else {
                throw CaptureFailure(code: "audio_application_unavailable", message: "A selected audio application is no longer available. Choose the application group again; audio capture was not broadened to all applications.")
            }
            filter = SCContentFilter(display: display, including: applications, exceptingWindows: [])
        } else {
            filter = SCContentFilter(display: display, excludingApplications: content.applications.filter { $0.processID == getpid() || $0.processID == options.excludedProcessID }, exceptingWindows: [])
        }
        let configuration = SCStreamConfiguration()
        configuration.width = 2; configuration.height = 2
        configuration.minimumFrameInterval = CMTime(seconds: 1, preferredTimescale: 600)
        configuration.queueDepth = 3
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = false
        configuration.sampleRate = 48_000; configuration.channelCount = 2
        configuration.streamName = "Reva Studio selected application audio"
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
        audioStream = stream
    }

    private func checkpointRecovery(at duration: Double, status: String = "recording", error: String? = nil) throws {
        for writer in [screenWriter, cameraWriter].compactMap({ $0 }) { try writer.checkpoint(at: CMTime(seconds: duration, preferredTimescale: 48_000)) }
        let cursor = try cursorWriter?.checkpoint() ?? 1
        let activity = try activityWriter?.checkpoint() ?? 1
        try recoveryJournal?.checkpoint(duration: duration, width: width, height: height, cursor: cursor, activity: activity, cameraStartTime: cameraWriter?.firstVideoTime?.seconds, status: status, error: error)
        lastCheckpoint = duration
    }

    private func configureDevices() throws {
        let session = AVCaptureSession()
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        var selectedCamera: AVCaptureDevice?
        if let identity = options.screenDeviceID {
            let device = try CaptureDevices.resolveScreen(id: identity)
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else { throw CaptureFailure(code: "device_unavailable", message: "The connected screen device cannot be added to the recording.") }
            session.addInput(input)
            let output = AVCaptureVideoDataOutput()
            output.alwaysDiscardsLateVideoFrames = true
            output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            output.setSampleBufferDelegate(self, queue: sampleQueue)
            try addDeviceOutput(output, input: input, mediaType: .video, session: session, name: "connected screen device")
            screenDeviceOutput = output
            if options.systemAudio {
                let audio = AVCaptureAudioDataOutput()
                audio.setSampleBufferDelegate(self, queue: sampleQueue)
                try addDeviceOutput(audio, input: input, mediaType: .audio, session: session, name: "connected-device audio")
                screenDeviceAudioOutput = audio
            }
            try CaptureDevices.configureScreen(device, fps: options.fps)
        }
        if options.camera {
            let device = try CaptureDevices.resolve(.video, id: options.cameraDeviceID)
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else { throw CaptureFailure(code: "camera_unavailable", message: "The selected camera cannot be added to the recording.") }
            session.addInput(input)
            selectedCamera = device
            cameraDeviceID = device.uniqueID
            let output = AVCaptureVideoDataOutput()
            output.alwaysDiscardsLateVideoFrames = true
            output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            output.setSampleBufferDelegate(self, queue: sampleQueue)
            try addDeviceOutput(output, input: input, mediaType: .video, session: session, name: "camera")
            cameraOutput = output
        }
        if options.microphone {
            let device = try CaptureDevices.resolve(.audio, id: options.microphoneDeviceID)
            microphoneDeviceID = device.uniqueID
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else { throw CaptureFailure(code: "microphone_unavailable", message: "The selected microphone cannot be added to the recording.") }
            session.addInput(input)
            let output = AVCaptureAudioDataOutput()
            output.setSampleBufferDelegate(self, queue: sampleQueue)
            try addDeviceOutput(output, input: input, mediaType: .audio, session: session, name: "microphone")
            microphoneOutput = output
        }
        if let selectedCamera {
            try CaptureDevices.configureCamera(selectedCamera, maximumHeight: options.cameraMaxResolution)
        }
        self.session = session
        sessionErrorObserver = NotificationCenter.default.addObserver(forName: .AVCaptureSessionRuntimeError, object: session, queue: nil) { [weak self] notification in
            let error = notification.userInfo?[AVCaptureSessionErrorKey] as? Error ?? CaptureFailure(code: "device_failed", message: "A capture device stopped unexpectedly.")
            self?.sampleQueue.async { self?.fail(error) }
        }
    }

    private func addDeviceOutput(_ output: AVCaptureOutput, input: AVCaptureDeviceInput, mediaType: AVMediaType, session: AVCaptureSession, name: String) throws {
        let ports = input.ports.filter { $0.mediaType == mediaType }
        guard !ports.isEmpty, session.canAddOutput(output) else { throw CaptureFailure(code: "device_output_unavailable", message: "The selected \(name) cannot produce \(mediaType.rawValue) samples.") }
        session.addOutputWithNoConnections(output)
        let connection = AVCaptureConnection(inputPorts: ports, output: output)
        guard session.canAddConnection(connection) else { throw CaptureFailure(code: "device_output_unavailable", message: "Cannot connect the selected \(name) to its media output.") }
        session.addConnection(connection)
    }

    private func waitForFirstFrame() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            sampleQueue.async {
                if let error = self.firstFrameError { continuation.resume(throwing: error); return }
                if self.startupIsReady { continuation.resume(); return }
                self.firstFrameWaiter = continuation
                self.sampleQueue.asyncAfter(deadline: .now() + 12) { [weak self] in
                    guard let self, let waiter = self.firstFrameWaiter else { return }
                    self.firstFrameWaiter = nil
                    waiter.resume(throwing: CaptureFailure(code: "recording_start_timeout", message: "The selected screen, camera, or microphone did not deliver media within 12 seconds. Check permissions and the selected devices."))
                }
            }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard acceptingSamples, sampleBuffer.isValid else { return }
        do {
            if type == .screen {
                guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                      let frame = attachments.first, let rawStatus = frame[.status] as? Int,
                      SCFrameStatus(rawValue: rawStatus) == .complete,
                      CMSampleBufferGetImageBuffer(sampleBuffer) != nil else { return }
                updateWindowGeometry(frame)
                let clock = stream.synchronizationClock
                if timeline == nil {
                    let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                    timeline = RecordingTimeline(anchor: clock.map { CMSyncConvertTime(timestamp, from: $0, to: CMClockGetHostTimeClock()) } ?? timestamp)
                    typingCounter.reset(to: CGEventSource.counterForEventType(.combinedSessionState, eventType: .keyDown))
                }
                guard let timeline else { return }
                try screenWriter?.append(sampleBuffer, video: true, sourceClock: clock, timeline: timeline)
                if cursorTimer == nil {
                    startCursorTimer()
                }
                completeStartupIfReady()
            } else if type == .audio, let timeline {
                try screenWriter?.append(sampleBuffer, video: false, sourceClock: stream.synchronizationClock, timeline: timeline)
            }
        } catch { fail(error) }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        sampleQueue.async { [weak self] in
            guard let self, self.acceptingSamples else { return }
            self.fail(error)
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard acceptingSamples, sampleBuffer.isValid else { return }
        if output === cameraOutput, let cameraDeviceID { live.video(sampleBuffer, deviceID: cameraDeviceID) }
        if output === microphoneOutput, let microphoneDeviceID { live.audio(sampleBuffer, deviceID: microphoneDeviceID) }
        if output === screenDeviceOutput {
            do {
                guard let image = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
                let clock = session?.synchronizationClock
                if timeline == nil {
                    let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                    timeline = RecordingTimeline(anchor: clock.map { CMSyncConvertTime(timestamp, from: $0, to: CMClockGetHostTimeClock()) } ?? timestamp)
                    width = try CaptureGeometry.pixels(CGFloat(CVPixelBufferGetWidth(image)), scale: 1)
                    height = try CaptureGeometry.pixels(CGFloat(CVPixelBufferGetHeight(image)), scale: 1)
                    guard width * height <= 33_554_432 else { throw CaptureFailure(code: "unsupported_dimensions", message: "The connected device exceeds the 32-megapixel capture limit.") }
                    crop = CGRect(x: 0, y: 0, width: width, height: height)
                    sourceBounds = crop
                    screenWriter = try MediaWriter(url: options.output, width: width, height: height, fps: options.fps, audioChannels: options.systemAudio ? 2 : nil)
                    screenDeviceScaler = try ConnectedScreenFrameScaler(width: width, height: height)
                }
                if let timeline, let scaled = try screenDeviceScaler?.sample(sampleBuffer) {
                    try screenWriter?.append(scaled, video: true, sourceClock: clock, timeline: timeline)
                    if cursorTimer == nil { startCursorTimer() }
                    completeStartupIfReady()
                }
            } catch { fail(error) }
            return
        }
        guard let timeline else { return }
        do {
            if output === cameraOutput {
                guard let sampleBuffer = try cameraScaler.sample(sampleBuffer) else { return }
                if cameraWriter == nil {
                    guard let image = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
                    cameraWriter = try MediaWriter(url: options.cameraOutput, width: CVPixelBufferGetWidth(image), height: CVPixelBufferGetHeight(image), fps: 30)
                }
                try cameraWriter?.append(sampleBuffer, video: true, sourceClock: session?.synchronizationClock, timeline: timeline)
            } else if output === microphoneOutput {
                try microphoneWriter?.append(sampleBuffer, video: false, sourceClock: session?.synchronizationClock, timeline: timeline)
            } else if output === screenDeviceAudioOutput {
                try screenWriter?.append(sampleBuffer, video: false, sourceClock: session?.synchronizationClock, timeline: timeline)
            }
            completeStartupIfReady()
        } catch { fail(error) }
    }

    private func startCursorTimer() {
        sampleCursor(at: CMClockGetTime(CMClockGetHostTimeClock()))
        let timer = DispatchSource.makeTimerSource(queue: sampleQueue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(options.screenDeviceID == nil ? 8 : 100), leeway: .milliseconds(2))
        timer.setEventHandler { [weak self] in self?.sampleCursor(at: CMClockGetTime(CMClockGetHostTimeClock())) }
        cursorTimer = timer
        timer.resume()
    }

    private func sampleCursor(at time: CMTime) {
        guard let timeline, !timeline.isPaused, let position = timeline.sampleTime(at: time) else { return }
        if position.seconds >= lastCheckpoint + 2 {
            do { try checkpointRecovery(at: position.seconds) } catch { fail(error) }
        }
        guard options.screenDeviceID == nil else { return }
        if let activity = typingCounter.observe(CGEventSource.counterForEventType(.combinedSessionState, eventType: .keyDown), time: position.seconds) {
            do { try activityWriter?.append(.typing(activity)) } catch { fail(error) }
        }
        guard let event = CGEvent(source: nil) else { return }
        var buttons = Set<CursorButton>()
        if CGEventSource.buttonState(.combinedSessionState, button: .left) { buttons.insert(.left) }
        if CGEventSource.buttonState(.combinedSessionState, button: .right) { buttons.insert(.right) }
        if CGEventSource.buttonState(.combinedSessionState, button: .center) { buttons.insert(.center) }
        let transition = cursorPoll.observe(point: event.location, buttons: buttons, inside: cursorBounds.contains(event.location))
        let point = CaptureGeometry.cursor(point: event.location, bounds: cursorBounds, destination: cursorDestination, t: position.seconds, pressed: !buttons.isEmpty, event: transition.event, button: transition.button)
        do { try cursorWriter?.append(point) } catch { fail(error) }
    }

    private func updateWindowGeometry(_ frame: [SCStreamFrameInfo: Any]) {
        guard let sourceWindow else { return }
        // ScreenCaptureKit supplies global geometry, including window movement, with each complete frame.
        if options.area == nil, let dictionary = frame[.screenRect] as? [String: Any],
           let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary), bounds.width > 0, bounds.height > 0 {
            sourceBounds = bounds
        } else {
            // A cropped frame's screenRect may describe the crop itself. Query the
            // selected window identity to keep its local crop origin unambiguous.
            if let entries = CGWindowListCopyWindowInfo(.optionIncludingWindow, sourceWindow) as? [[String: Any]],
               let dictionary = entries.first?[kCGWindowBounds as String] as? [String: Any],
               let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary) { sourceBounds = bounds }
        }
        cursorBounds = options.area == nil ? sourceBounds : crop.offsetBy(dx: sourceBounds.minX, dy: sourceBounds.minY)
        // A cropped window retains the selected local area even if the outer window is resized.
        // Frame contentRect is in surface points and scaleFactor converts it to output pixels.
        if let dictionary = frame[.contentRect] as? [String: Any], let rect = CGRect(dictionaryRepresentation: dictionary as CFDictionary),
           let scale = frame[.scaleFactor] as? CGFloat, scale > 0 {
            let destination = CGRect(x: rect.minX * scale / CGFloat(width), y: rect.minY * scale / CGFloat(height),
                                     width: rect.width * scale / CGFloat(width), height: rect.height * scale / CGFloat(height))
            if destination.width > 0, destination.height > 0, destination.minX >= 0, destination.minY >= 0,
               destination.maxX <= 1.01, destination.maxY <= 1.01 { cursorDestination = destination }
        }
    }

    private func fail(_ error: Error) {
        guard !reportedFailure else { return }
        reportedFailure = true
        firstFrameError = error
        firstFrameWaiter?.resume(throwing: error)
        firstFrameWaiter = nil
        DispatchQueue.main.async { self.onFailure(error) }
    }

    private var startupIsReady: Bool {
        (screenWriter?.videoFrames ?? 0) > 0
            && (!options.camera || (cameraWriter?.videoFrames ?? 0) > 0)
            && (!options.microphone || (microphoneWriter?.audioBuffers ?? 0) > 0)
    }

    private func completeStartupIfReady() {
        guard startupIsReady, let waiter = firstFrameWaiter else { return }
        firstFrameWaiter = nil
        waiter.resume()
    }
}
