import Foundation
import AppKit
import Darwin

struct ReadyEvent: Encodable {
    let type = "ready"
    let output: String
    let cursorOutput: String
    let width: Int
    let height: Int
    let fps: Int
    let systemAudio: Bool
    let microphone: Bool
    let camera: Bool
    let cameraDeviceID: String?
    let microphoneDeviceID: String?
}

struct StoppedEvent: Encodable {
    let type = "stopped"
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
    let cursorSourceSize: RecordingInfo.CursorSourceSize

    init(_ result: RecordingInfo) {
        output = result.output; cursorOutput = result.cursorOutput; activityOutput = result.activityOutput; duration = result.duration
        width = result.width; height = result.height; cameraPath = result.cameraPath; microphonePath = result.microphonePath
        cameraStartTime = result.cameraStartTime
        cameraEndTime = result.cameraEndTime
        droppedVideoFrames = result.droppedVideoFrames; droppedAudioBuffers = result.droppedAudioBuffers
        cursorSourceSize = result.cursorSourceSize
    }
}

@MainActor final class RecordingCommand {
    private var recorder: Recorder?
    private var starting = true
    private var stopping = false
    private var stopRequested = false
    private var failure: Error?
    private var continuation: CheckedContinuation<Int32, Never>?
    private var signals: [DispatchSourceSignal] = []
    private let cancellation = CaptureCancellation()

    func run(options: CaptureOptions) async -> Int32 {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            let recorder = Recorder(options: options, cancellation: cancellation) { [weak self] error in
                Task { @MainActor in self?.requestStop(error: error) }
            }
            self.recorder = recorder
            observeStopCommands()
            Task { @MainActor in
                do {
                    try await recorder.start()
                    try self.cancellation.check()
                    self.starting = false
                    if self.stopRequested {
                        await self.finish()
                    } else {
                        ProtocolOutput.emit(ReadyEvent(output: options.output.path, cursorOutput: options.cursorOutput.path,
                                                      width: recorder.width, height: recorder.height, fps: options.fps,
                                                      systemAudio: options.systemAudio, microphone: options.microphone, camera: options.camera,
                                                      cameraDeviceID: recorder.cameraDeviceID, microphoneDeviceID: recorder.microphoneDeviceID))
                        ProtocolOutput.emit(recorder.stateSnapshot())
                        recorder.activateLiveOutput()
                    }
                } catch {
                    self.starting = false
                    self.failure = self.failure ?? error
                    await self.finish()
                }
            }
        }
    }

    private func observeStopCommands() {
        let cancellation = self.cancellation
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in
                cancellation.cancel()
                Task { @MainActor in self?.requestStop() }
            }
            signals.append(source)
            source.resume()
        }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while let line = readLine() {
                let command = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if command == "stop" {
                    cancellation.cancel()
                    Task { @MainActor in self?.requestStop() }
                    return
                }
                if command == "pause" || command == "resume" {
                    Task { @MainActor in
                        guard let self, !self.starting, !self.stopping, !self.stopRequested, let recorder = self.recorder else { return }
                        do { ProtocolOutput.emit(try recorder.setPaused(command == "pause")) }
                        catch { self.requestStop(error: error) }
                    }
                }
                if command == "flag" {
                    Task { @MainActor in
                        guard let self, !self.starting, !self.stopping, !self.stopRequested, let recorder = self.recorder else { return }
                        do { if let flag = try recorder.markFlag() { ProtocolOutput.emit(flag) } }
                        catch { self.requestStop(error: error) }
                    }
                }
                if command == "preview-camera true" || command == "preview-camera false" {
                    Task { @MainActor in
                        guard let self, !self.stopping else { return }
                        do { try self.recorder?.setCameraPreview(command == "preview-camera true") }
                        catch { ProtocolOutput.emit(InputErrorEvent(error, mediaType: "camera", recoverable: true)) }
                    }
                }
                if command == "camera-effects" {
                    Task { @MainActor in
                        guard let self, !self.starting, !self.stopping, !self.stopRequested, let recorder = self.recorder else { return }
                        do { ProtocolOutput.emit(["type": "camera-effects", "deviceID": try recorder.showCameraEffects()]) }
                        catch { ProtocolOutput.emit(InputErrorEvent(error, mediaType: "camera", recoverable: true)) }
                    }
                }
            }
            cancellation.cancel()
            Task { @MainActor in self?.requestStop() }
        }
    }

    private func requestStop(error: Error? = nil) {
        cancellation.cancel()
        stopRequested = true
        failure = failure ?? error
        if starting { recorder?.cancelPendingStart() }
        guard !starting, !stopping else { return }
        Task { @MainActor in await finish() }
    }

    private func finish() async {
        guard !stopping, let recorder else { return }
        stopping = true
        var result: RecordingInfo?
        do { result = try await recorder.stop() }
        catch { failure = failure ?? error }
        if let failure { ProtocolOutput.error(failure) }
        else if let result { ProtocolOutput.emit(StoppedEvent(result)) }
        for source in signals { source.cancel() }
        signals.removeAll()
        let completion = continuation
        continuation = nil
        completion?.resume(returning: failure == nil ? 0 : 1)
    }
}

@main struct CaptureMain {
    @MainActor static func main() async {
        signal(SIGPIPE, SIG_IGN)
        // Loading AppKit lets macOS associate permission sheets and device capture with this process.
        _ = NSApplication.shared
        NSApplication.shared.setActivationPolicy(.prohibited)
        let arguments = Array(CommandLine.arguments.dropFirst())
        do {
            switch arguments.first {
            case "permissions":
                guard arguments.count == 1 else { throw invalidArguments() }
                ProtocolOutput.emit(CaptureSources.permissions())
            case "list":
                guard arguments.count == 1 || (arguments.count == 3 && arguments[1] == "--exclude-process-id") else { throw invalidArguments() }
                let excluded = try CaptureOptions.processID(arguments.count == 3 ? arguments[2] : nil)
                ProtocolOutput.emit(try await CaptureSources.list(excludingProcessID: excluded))
            case "list-devices":
                guard arguments.count == 1 else { throw invalidArguments() }
                ProtocolOutput.emit(CaptureDevices.list())
            case "list-audio-applications":
                guard arguments.count == 1 || (arguments.count == 3 && arguments[1] == "--exclude-process-id") else { throw invalidArguments() }
                let excluded = try CaptureOptions.processID(arguments.count == 3 ? arguments[2] : nil)
                ProtocolOutput.emit(try await CaptureSources.audioApplications(excludingProcessID: excluded))
            case "record":
                let options = try CaptureOptions.parse(Array(arguments.dropFirst()))
                let status = await RecordingCommand().run(options: options)
                exit(status)
            case "monitor-inputs":
                let options = try InputMonitorOptions.parse(Array(arguments.dropFirst()))
                exit(await InputMonitorCommand().run(options: options))
            case "analyze-privacy":
                let options = try PrivacyOptions.parse(Array(arguments.dropFirst()))
                exit(await PrivacyCommand.run(options: options))
            case "segment-camera":
                let options = try CameraSegmentationOptions.parse(Array(arguments.dropFirst()))
                exit(await CameraSegmentationCommand.run(options: options))
            case "analyze-camera":
                let options = try CameraAnalysisOptions.parse(Array(arguments.dropFirst()))
                exit(await CameraAnalysisCommand.run(options: options))
            case "upscale-video":
                let options = try SuperResolutionOptions.parse(Array(arguments.dropFirst()))
                exit(await SuperResolutionCommand.run(options: options))
            case "recover-camera":
                let options = try CameraRecoveryOptions.parse(Array(arguments.dropFirst()))
                exit(await CameraRecoveryCommand.run(options: options))
            case "speech-status":
                guard arguments.count == 1 || (arguments.count == 3 && arguments[1] == "--locale") else { throw invalidArguments() }
                ProtocolOutput.emit(SpeechTranscriptionCommand.status(locale: arguments.count == 3 ? arguments[2] : nil))
            case "transcribe-speech":
                let options = try SpeechTranscriptionOptions.parse(Array(arguments.dropFirst()))
                exit(await SpeechTranscriptionCommand.run(options: options))
            case "resize-window":
                ProtocolOutput.emit(try WindowUtilities.resize(Array(arguments.dropFirst())))
            case "desktop-icons":
                ProtocolOutput.emit(try await WindowUtilities.desktop(Array(arguments.dropFirst())))
            case "--help", "help", nil:
                ProtocolOutput.emit(["usage": "reva-capture list [--exclude-process-id PID] | list-devices | permissions | record --source display:ID|window:ID --output /path/video.mp4 --cursor-output /path/cursor.json [--fps 24|30|60] [--system-audio true|false] [--microphone true|false] [--camera true|false] [--area x,y,width,height] [--camera-device-id ID] [--microphone-device-id ID] [--camera-max-resolution 720|1080|2160] [--exclude-process-id PID]",
                                     "privacy": "reva-capture analyze-privacy --input /path/video.mp4 --output /path/new.json --sensitive true|false --faces true|false",
                                     "cameraSegmentation": "reva-capture segment-camera --input /path/camera.mp4 --output-directory /path/new-directory [--quality balanced|accurate]",
                                     "superResolution": "reva-capture upscale-video --input /path/video.mp4 --model /path/model.mlpackage --output-directory /path/new-directory. Local Core ML 2x processing preserves video timestamps; originals are unchanged.",
                                     "liveInputs": "reva-capture monitor-inputs [--microphones all|selected|none] [--microphone-device-id ID] [--camera true|false] [--camera-device-id ID] [--exclude-microphone-device-id ID]. Record accepts --preview-camera true|false --monitor-microphone true|false; send preview-camera true|false on stdin to toggle recording-camera frames.",
                                     "audioApplications": "list-audio-applications [--exclude-process-id PID]. Record accepts --audio-applications JSON_ARRAY_OF_BUNDLE_IDS; omission captures all eligible Mac apps, an explicit empty group is rejected.",
                                     "connectedDevices": "list-devices includes screenDevices. Record accepts --source device:EXACT_DEVICE_ID for connected USB screen devices, with optional separate camera/microphone and device audio.",
                                     "shortcuts": "Record accepts --record-shortcuts true|false. Shortcut capture needs Input Monitoring; ordinary unmodified printable text is never captured.",
                                     "stop": "Send pause/resume or flag followed by a newline to stdin; state events acknowledge the pause-adjusted elapsedMs. Send stop to finalize. EOF, SIGINT, and SIGTERM finalize recording or cancel analysis. Interrupted recordings retain fragmented media and an adjacent .recovery.json journal."])
            default: throw invalidArguments()
            }
        } catch {
            ProtocolOutput.error(error)
            exit(1)
        }
    }

    private static func invalidArguments() -> CaptureFailure {
        CaptureFailure(code: "invalid_arguments", message: "Use reva-capture --help for the command protocol.")
    }
}
