import Foundation
@preconcurrency import AVFoundation
import CryptoKit
import Darwin

struct CameraRecoveryOptions {
    let input: URL
    let output: URL
    let startTime: Double

    static func parse(_ arguments: [String]) throws -> CameraRecoveryOptions {
        var values: [String: String] = [:], index = 0
        while index < arguments.count {
            let key = arguments[index]
            guard ["--input", "--output", "--start-time"].contains(key), index + 1 < arguments.count, values[key] == nil else {
                throw CaptureFailure(code: "invalid_arguments", message: "Camera recovery received an unknown, duplicate, or incomplete option.")
            }
            values[key] = arguments[index + 1]; index += 2
        }
        guard let input = values["--input"], input.hasPrefix("/"), !input.contains("\0"),
              let output = values["--output"], output.hasPrefix("/"), !output.contains("\0"),
              let start = Double(values["--start-time"] ?? ""), start.isFinite, start >= 0, start <= 86400 else {
            throw CaptureFailure(code: "invalid_arguments", message: "Camera recovery requires absolute input/output paths and the first camera frame's finite nonnegative source timestamp.")
        }
        let source = URL(fileURLWithPath: input), destination = URL(fileURLWithPath: output)
        var facts = stat()
        guard lstat(source.path, &facts) == 0, facts.st_mode & S_IFMT == S_IFREG else {
            throw CaptureFailure(code: "input_unavailable", message: "The interrupted camera source must be an existing regular file.")
        }
        guard lstat(destination.path, &facts) != 0, errno == ENOENT else {
            throw CaptureFailure(code: "output_exists", message: "Camera recovery never replaces an existing output or symlink.")
        }
        return CameraRecoveryOptions(input: source, output: destination, startTime: start)
    }
}

private final class CameraRecoveryControl: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false, committed = false
    private var export: AVAssetExportSession?
    func cancel() {
        lock.lock(); guard !committed else { lock.unlock(); return }
        cancelled = true; let export = export; lock.unlock(); export?.cancelExport()
    }
    func check() throws {
        lock.lock(); defer { lock.unlock() }
        if cancelled { throw CaptureFailure(code: "recovery_cancelled", message: "Camera recovery was cancelled.") }
    }
    func own(_ export: AVAssetExportSession?) {
        lock.lock(); self.export = export; let cancelled = cancelled; lock.unlock()
        if cancelled { export?.cancelExport() }
    }
    func commit(_ operation: () throws -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        if cancelled { throw CaptureFailure(code: "recovery_cancelled", message: "Camera recovery was cancelled.") }
        try operation(); committed = true
    }
}

@MainActor enum CameraRecoveryCommand {
    private static func digest(_ file: URL, control: CameraRecoveryControl) throws -> String {
        let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
        var hash = SHA256()
        while true {
            try control.check()
            guard let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty else { break }
            hash.update(data: data)
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func run(options: CameraRecoveryOptions) async -> Int32 {
        let control = CameraRecoveryControl()
        var signals: [DispatchSourceSignal] = []
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let signalSource = DispatchSource.makeSignalSource(signal: number, queue: .global(qos: .userInitiated))
            signalSource.setEventHandler { control.cancel() }; signals.append(signalSource); signalSource.resume()
        }
        defer { signals.forEach { $0.cancel() } }
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine() {
                if ["stop", "cancel"].contains(line.trimmingCharacters(in: .whitespacesAndNewlines)) { control.cancel(); return }
            }
            control.cancel()
        }
        var staging: URL?, identity: stat?
        func cleanup() throws {
            guard let directory = staging, let expected = identity else { return }
            var actual = stat()
            guard lstat(directory.path, &actual) == 0, actual.st_dev == expected.st_dev,
                  actual.st_ino == expected.st_ino, actual.st_mode & S_IFMT == S_IFDIR else {
                throw CaptureFailure(code: "recovery_cleanup_failed", message: "The owned camera recovery directory changed identity and was preserved: \(directory.path)")
            }
            do { try FileManager.default.removeItem(at: directory) }
            catch { throw CaptureFailure(code: "recovery_cleanup_failed", message: "Cannot remove owned camera recovery output at \(directory.path): \(error.localizedDescription)") }
            staging = nil; identity = nil
        }
        do {
            let sourceHash = try digest(options.input, control: control)
            let asset = AVURLAsset(url: options.input)
            guard let track = try await asset.loadTracks(withMediaType: .video).first else {
                throw CaptureFailure(code: "no_video_track", message: "No completed camera video fragment can be recovered.")
            }
            let segments = try await track.load(.segments).filter { !$0.isEmpty }
            guard let first = segments.map({ $0.timeMapping.target.start }).min(by: { CMTimeCompare($0, $1) < 0 }),
                  let end = segments.map({ CMTimeRangeGetEnd($0.timeMapping.target) }).max(by: { CMTimeCompare($0, $1) < 0 }),
                  first.seconds.isFinite, first.seconds >= 0, end.seconds.isFinite, end.seconds > first.seconds,
                  end.seconds - first.seconds <= 86400 else {
                throw CaptureFailure(code: "no_video_fragment", message: "The camera track contains no usable completed media range.")
            }
            try control.check()
            let range = CMTimeRange(start: first, duration: CMTimeSubtract(end, first))
            let composition = AVMutableComposition()
            guard let destination = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                throw CaptureFailure(code: "recovery_failed", message: "Cannot create a camera recovery track.")
            }
            try destination.insertTimeRange(range, of: track, at: CMTime(seconds: options.startTime, preferredTimescale: 60000))
            destination.preferredTransform = try await track.load(.preferredTransform)
            guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
                throw CaptureFailure(code: "recovery_failed", message: "A lossless camera recovery export is unavailable.")
            }
            let directory = options.output.deletingLastPathComponent().appendingPathComponent(".reva-camera-recovery-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            staging = directory
            var facts = stat()
            guard lstat(directory.path, &facts) == 0 else { throw CaptureFailure(code: "recovery_cleanup_failed", message: "Cannot identify the owned camera recovery directory: \(directory.path)") }
            identity = facts
            let temporary = directory.appendingPathComponent("camera.mp4")
            control.own(export); defer { control.own(nil) }
            struct Ready: Encodable { let type = "ready"; let startTime: Double; let duration: Double }
            ProtocolOutput.emit(Ready(startTime: options.startTime, duration: options.startTime + range.duration.seconds))
            if #available(macOS 15.0, *) {
                try await export.export(to: temporary, as: .mp4)
            } else {
                export.outputURL = temporary; export.outputFileType = .mp4
                await withCheckedContinuation { continuation in
                    export.exportAsynchronously { continuation.resume() }
                }
                guard export.status == .completed else { throw export.error ?? CaptureFailure(code: "recovery_failed", message: "The camera recovery export did not finish.") }
            }
            try control.check()
            guard try digest(options.input, control: control) == sourceHash else {
                throw CaptureFailure(code: "source_changed", message: "The interrupted camera file changed during recovery; no result was published.")
            }
            let recovered = AVURLAsset(url: temporary)
            let duration = try await recovered.load(.duration).seconds
            guard duration.isFinite, abs(duration - (options.startTime + range.duration.seconds)) < 0.05 else {
                throw CaptureFailure(code: "recovery_timing_failed", message: "The recovered camera file did not retain its shared-clock duration.")
            }
            try control.commit {
                guard link(temporary.path, options.output.path) == 0 else {
                    throw CaptureFailure(code: "recovery_publish_failed", message: "Camera recovery could not publish a new file without replacing another: \(String(cString: strerror(errno)))")
                }
            }
            try cleanup()
            struct Completed: Encodable { let type = "completed"; let output: String; let duration: Double; let startTime: Double; let sourceSHA256: String }
            ProtocolOutput.emit(Completed(output: options.output.path, duration: duration, startTime: options.startTime, sourceSHA256: sourceHash))
            return 0
        } catch {
            do { try cleanup() } catch { ProtocolOutput.error(error); return 1 }
            do { try control.check() } catch { ProtocolOutput.emit(["type": "cancelled"]); return 130 }
            ProtocolOutput.error(error); return 1
        }
    }
}
