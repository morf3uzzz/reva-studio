import Foundation
@preconcurrency import AVFoundation
import Darwin

struct InputMonitorOptions {
    let microphoneMode: String
    var microphones: Bool { microphoneMode != "none" }
    let microphoneDeviceID: String?
    let camera: Bool
    let cameraDeviceID: String?
    let excludeMicrophoneDeviceID: String?

    static func parse(_ arguments: [String]) throws -> InputMonitorOptions {
        let names: Set<String> = ["microphones", "camera", "camera-device-id", "microphone-device-id", "exclude-microphone-device-id"]
        var values: [String: String] = [:]
        var index = 0
        while index < arguments.count {
            let flag = arguments[index], name = String(flag.dropFirst(2))
            guard flag.hasPrefix("--"), names.contains(name), index + 1 < arguments.count, values[name] == nil else {
                throw CaptureFailure(code: "invalid_arguments", message: "Unknown, duplicate, or incomplete monitor option: \(flag)")
            }
            values[name] = arguments[index + 1]; index += 2
        }
        let microphones = values["microphones"] ?? "all", camera = values["camera"] ?? "false"
        guard ["all", "selected", "none"].contains(microphones), ["true", "false"].contains(camera) else {
            throw CaptureFailure(code: "invalid_arguments", message: "Use --microphones all|selected|none and --camera true|false.")
        }
        func deviceID(_ name: String) throws -> String? {
            guard let value = values[name] else { return nil }
            guard !value.isEmpty, value.utf8.count <= 4096, !value.utf8.contains(0) else {
                throw CaptureFailure(code: "invalid_arguments", message: "--\(name) requires a nonempty device identity of at most 4096 bytes.")
            }
            return value
        }
        return try InputMonitorOptions(microphoneMode: microphones, microphoneDeviceID: deviceID("microphone-device-id"), camera: camera == "true", cameraDeviceID: deviceID("camera-device-id"), excludeMicrophoneDeviceID: deviceID("exclude-microphone-device-id"))
    }
}

struct InputMonitorReady: Encodable {
    let type = "ready"
    let kind = "input-monitor"
    let cameraDeviceID: String?
    let microphoneDeviceIDs: [String]
    let microphonePermission: String
}

struct InputPermissionEvent: Encodable {
    let type = "permission"
    let mediaType = "microphone"
    let status: String
}

/// Each microphone owns a separate AVCaptureSession so an output's identity cannot
/// be confused with the system default or another device. One optional camera.
final class LiveInputMonitor: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    private struct Device {
        let session: AVCaptureSession
        let output: AVCaptureOutput
        let id: String
        let type: AVMediaType
        let observer: NSObjectProtocol
    }
    private let options: InputMonitorOptions
    private let cancellation: CaptureCancellation
    private let onFailure: (Error) -> Void
    private let deviceQueue = DispatchQueue(label: "com.reva.studio.monitor.devices", qos: .userInitiated)
    private let sampleQueue = DispatchQueue(label: "com.reva.studio.monitor.samples", qos: .userInitiated)
    private let live: LiveInputOutput
    private var devices: [Device] = [] // main-actor lifecycle
    private var identities: [ObjectIdentifier: (String, AVMediaType)] = [:] // sampleQueue
    private var acceptingSamples = true // sampleQueue

    init(options: InputMonitorOptions, cancellation: CaptureCancellation, onFailure: @escaping (Error) -> Void) {
        self.options = options; self.cancellation = cancellation; self.onFailure = onFailure
        live = LiveInputOutput(previewCamera: options.camera, monitorMicrophone: options.microphones)
    }
    @MainActor func start() async throws -> InputMonitorReady {
        try cancellation.check()
        if options.microphones { ProtocolOutput.emit(InputPermissionEvent(status: CaptureDevices.authorization(.audio))) }
        for type in [AVMediaType.audio, .video] {
            let requested = type == .audio ? options.microphones : options.camera
            guard requested else { continue }
            do {
                try await CaptureDevices.requestPermission(type, cancellation: cancellation)
                if type == .audio { ProtocolOutput.emit(InputPermissionEvent(status: CaptureDevices.authorization(.audio))) }
                let selected: [AVCaptureDevice]
                if type == .video { selected = [try CaptureDevices.resolve(.video, id: options.cameraDeviceID)] }
                else if options.microphoneMode == "selected" { selected = [try CaptureDevices.resolve(.audio, id: options.microphoneDeviceID)] }
                else {
                    var seen = Set<String>()
                    selected = CaptureDevices.devices(.audio).filter { $0.uniqueID != options.excludeMicrophoneDeviceID && seen.insert($0.uniqueID).inserted }
                    guard selected.count <= 32 else { throw CaptureFailure(code: "input_capacity", message: "Live input monitoring supports at most 32 simultaneous microphones; disconnect unused devices.") }
                    guard !selected.isEmpty else { throw CaptureFailure(code: "microphone_unavailable", message: "No microphone is connected. Choose an available device.") }
                }
                for device in selected where type != .audio || device.uniqueID != options.excludeMicrophoneDeviceID {
                    try cancellation.check()
                    do { try await startDevice(device, type: type) }
                    catch {
                        try cancellation.check()
                        ProtocolOutput.emit(InputErrorEvent(error, deviceID: device.uniqueID, mediaType: type == .audio ? "microphone" : "camera", recoverable: true))
                    }
                }
            } catch {
                try cancellation.check()
                if type == .audio { ProtocolOutput.emit(InputPermissionEvent(status: CaptureDevices.authorization(.audio))) }
                ProtocolOutput.emit(InputErrorEvent(error, deviceID: type == .video ? options.cameraDeviceID : options.microphoneDeviceID, mediaType: type == .audio ? "microphone" : "camera", recoverable: true))
            }
        }
        try cancellation.check()
        let running = devices.filter { $0.session.isRunning }
        return InputMonitorReady(cameraDeviceID: running.first { $0.type == .video }?.id, microphoneDeviceIDs: running.filter { $0.type == .audio }.map(\.id), microphonePermission: CaptureDevices.authorization(.audio))
    }
    @MainActor private func startDevice(_ device: AVCaptureDevice, type: AVMediaType) async throws {
        let session = AVCaptureSession()
        session.beginConfiguration()
        var committed = false
        defer { if !committed { session.commitConfiguration() } }
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else { throw CaptureFailure(code: "input_unavailable", message: "The selected input cannot be monitored.") }
        session.addInput(input)
        let output: AVCaptureOutput
        if type == .video {
            let video = AVCaptureVideoDataOutput()
            video.alwaysDiscardsLateVideoFrames = true
            video.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            video.setSampleBufferDelegate(self, queue: sampleQueue)
            output = video
        } else {
            let audio = AVCaptureAudioDataOutput()
            audio.setSampleBufferDelegate(self, queue: sampleQueue)
            output = audio
        }
        guard session.canAddOutput(output) else { throw CaptureFailure(code: "input_unavailable", message: "The selected input cannot provide live samples.") }
        session.addOutput(output)
        if type == .video { try CaptureDevices.configureCamera(device, maximumHeight: 1080) }
        session.commitConfiguration(); committed = true
        sampleQueue.sync { identities[ObjectIdentifier(output)] = (device.uniqueID, type) }
        let observer = NotificationCenter.default.addObserver(forName: .AVCaptureSessionRuntimeError, object: session, queue: nil) { [weak self] notification in
            let error = notification.userInfo?[AVCaptureSessionErrorKey] as? Error ?? CaptureFailure(code: "input_failed", message: "An input stopped unexpectedly.")
            self?.onFailure(error)
        }
        devices.append(Device(session: session, output: output, id: device.uniqueID, type: type, observer: observer))
        await withCheckedContinuation { continuation in deviceQueue.async { session.startRunning(); continuation.resume() } }
        guard session.isRunning else { throw CaptureFailure(code: "input_start_failed", message: "The selected input could not start.") }
        try cancellation.check()
    }
    func activate() { live.activate() }
    @MainActor func showCameraEffects() throws -> String {
        guard let device = devices.first(where: { $0.type == .video && $0.session.isRunning }) else {
            throw CaptureFailure(code: "camera_not_active", message: "Start a camera preview before opening macOS Video Effects.")
        }
        AVCaptureDevice.showSystemUserInterface(.videoEffects)
        return device.id
    }
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard acceptingSamples, let (id, type) = identities[ObjectIdentifier(output)] else { return }
        if type == .video { live.video(sampleBuffer, deviceID: id) }
        else { live.audio(sampleBuffer, deviceID: id) }
    }
    @MainActor func stop() async throws {
        sampleQueue.sync { acceptingSamples = false }
        for device in devices {
            await withCheckedContinuation { continuation in deviceQueue.async { device.session.stopRunning(); continuation.resume() } }
            NotificationCenter.default.removeObserver(device.observer)
            (device.output as? AVCaptureVideoDataOutput)?.setSampleBufferDelegate(nil, queue: nil)
            (device.output as? AVCaptureAudioDataOutput)?.setSampleBufferDelegate(nil, queue: nil)
        }
        await live.finish()
        // Failed resources remain owned until process exit; do not report success.
        devices.removeAll { !$0.session.isRunning }
        guard devices.isEmpty else { throw CaptureFailure(code: "input_stop_failed", message: "An input did not stop; the helper must exit to release it.") }
    }
}

@MainActor final class InputMonitorCommand {
    private var monitor: LiveInputMonitor?
    private let cancellation = CaptureCancellation()
    private var signals: [DispatchSourceSignal] = []
    private var continuation: CheckedContinuation<Int32, Never>?
    private var starting = true, stopping = false, stopRequested = false
    private var failure: Error?

    func run(options: InputMonitorOptions) async -> Int32 {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            let monitor = LiveInputMonitor(options: options, cancellation: cancellation) { [weak self] error in
                Task { @MainActor in self?.requestStop(error) }
            }
            self.monitor = monitor
            observeStop()
            Task { @MainActor in
                do {
                    let ready = try await monitor.start()
                    self.starting = false
                    if self.stopRequested { await self.finish() }
                    else { ProtocolOutput.emit(ready); monitor.activate() }
                } catch {
                    self.starting = false
                    if !self.stopRequested { self.failure = self.failure ?? error }
                    await self.finish()
                }
            }
        }
    }
    private func observeStop() {
        let cancellation = self.cancellation
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in cancellation.cancel(); self?.requestStop() }
            signals.append(source); source.resume()
        }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while let line = readLine() {
                let command = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if command == "stop" {
                    cancellation.cancel(); Task { @MainActor in self?.requestStop() }; return
                }
                if command == "camera-effects" {
                    Task { @MainActor in
                        guard let self, !self.starting, !self.stopping, !self.stopRequested, let monitor = self.monitor else { return }
                        do { ProtocolOutput.emit(["type": "camera-effects", "deviceID": try monitor.showCameraEffects()]) }
                        catch { ProtocolOutput.emit(InputErrorEvent(error, mediaType: "camera", recoverable: true)) }
                    }
                }
            }
            cancellation.cancel(); Task { @MainActor in self?.requestStop() }
        }
    }
    private func requestStop(_ error: Error? = nil) {
        cancellation.cancel(); stopRequested = true; failure = failure ?? error
        guard !starting, !stopping else { return }
        Task { @MainActor in await finish() }
    }
    private func finish() async {
        guard !stopping else { return }; stopping = true
        do { try await monitor?.stop() } catch { failure = failure ?? error }
        if let failure { ProtocolOutput.emit(InputErrorEvent(failure, recoverable: false)) }
        else { ProtocolOutput.emit(["type":"stopped", "kind":"input-monitor"]) }
        for source in signals { source.cancel() }; signals.removeAll()
        let result = continuation; continuation = nil
        result?.resume(returning: failure == nil ? 0 : 1)
    }
}
