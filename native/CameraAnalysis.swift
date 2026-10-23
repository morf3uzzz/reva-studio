import Foundation
@preconcurrency import AVFoundation
@preconcurrency import Vision
import CryptoKit
import Darwin

struct CameraAnalysisOptions {
    let input: URL; let output: URL; let audioInput: URL
    let faces: Bool; let silence: Bool
    let thresholdDB: Double; let minimumSeconds: Double

    static func parse(_ arguments: [String]) throws -> CameraAnalysisOptions {
        var values: [String: String] = [:], index = 0
        while index < arguments.count {
            let key = arguments[index]
            guard ["--input", "--output", "--audio-input", "--faces", "--silence", "--silence-threshold-db", "--silence-minimum-seconds"].contains(key), index + 1 < arguments.count, values[key] == nil else {
                throw CaptureFailure(code: "invalid_arguments", message: "Camera analysis received an unknown, duplicate, or incomplete option.")
            }
            values[key] = arguments[index + 1]; index += 2
        }
        func path(_ key: String, fallback: URL? = nil) throws -> URL {
            if values[key] == nil, let fallback { return fallback }
            guard let value = values[key], value.hasPrefix("/"), !value.utf8.contains(0) else { throw CaptureFailure(code: "invalid_arguments", message: "\(key) must be an absolute filesystem path.") }
            return URL(fileURLWithPath: value)
        }
        func flag(_ key: String) throws -> Bool {
            guard let value = values[key], ["true", "false"].contains(value) else { throw CaptureFailure(code: "invalid_arguments", message: "\(key) must be true or false.") }
            return value == "true"
        }
        let input = try path("--input"), output = try path("--output"), audio = try path("--audio-input", fallback: input)
        let faces = try flag("--faces"), silence = try flag("--silence")
        let threshold = Double(values["--silence-threshold-db"] ?? "-40") ?? .nan
        let minimum = Double(values["--silence-minimum-seconds"] ?? "1") ?? .nan
        guard faces || silence, threshold.isFinite, (-96 ... -6).contains(threshold), minimum.isFinite, (0.1 ... 60).contains(minimum), output != input, output != audio, output.pathExtension.lowercased() == "json" else { throw CaptureFailure(code: "invalid_arguments", message: "Enable a detector; silence threshold must be -96…-6 dBFS, minimum 0.1…60 seconds, and output a distinct new JSON file.") }
        for file in Set(([input] + (silence ? [audio] : [])).map(\.path)) {
            var info = stat(); guard stat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { throw CaptureFailure(code: "input_unavailable", message: "Camera analysis inputs must be existing regular media files.") }
        }
        var info = stat(); guard lstat(output.path, &info) != 0, errno == ENOENT else { throw CaptureFailure(code: "output_exists", message: "Refusing to replace an existing camera analysis output or symlink.") }
        return CameraAnalysisOptions(input: input, output: output, audioInput: audio, faces: faces, silence: silence, thresholdDB: threshold, minimumSeconds: minimum)
    }
}

/// Owns the currently active decoder and Vision request through publication.
final class CameraAnalysisControl: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false, committed = false
    private var generator: AVAssetImageGenerator?
    private var request: VNRequest?
    private var reader: AVAssetReader?
    func cancel() {
        lock.lock(); guard !committed else { lock.unlock(); return }; cancelled = true
        let generator = generator, request = request, reader = reader; lock.unlock()
        generator?.cancelAllCGImageGeneration(); request?.cancel(); reader?.cancelReading()
    }
    func check() throws { lock.lock(); defer { lock.unlock() }; if cancelled { throw CaptureFailure(code: "camera_analysis_cancelled", message: "Camera analysis was cancelled.") } }
    func own(generator: AVAssetImageGenerator? = nil, request: VNRequest? = nil, reader: AVAssetReader? = nil) {
        lock.lock(); self.generator = generator; self.request = request; self.reader = reader; let cancelled = cancelled; lock.unlock()
        if cancelled { generator?.cancelAllCGImageGeneration(); request?.cancel(); reader?.cancelReading() }
    }
    func commit(_ operation: () throws -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        guard !cancelled else { throw CaptureFailure(code: "camera_analysis_cancelled", message: "Camera analysis was cancelled.") }
        try operation(); committed = true
    }
}

struct CameraAnalysisInterval: Encodable { let start: Double; let end: Double }
struct CameraAnalysisSource: Encodable { let path: String; let sha256: String; let duration: Double; var width: Int? = nil; var height: Int? = nil }
struct CameraAnalysisCoverage: Encodable { let complete = true; let intervals: [CameraAnalysisInterval]; let limitations: [String] }
struct CameraFaceObservation: Encodable { let x: Double; let y: Double; let width: Double; let height: Double; let confidence: Float }
struct CameraFaceSample: Encodable {
    let t: Double; let requestedTime: Double; let face: CameraFaceObservation?
    // A successful frame with no face is different from a missing frame.
    enum CodingKeys: String, CodingKey { case t, requestedTime, face }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(t, forKey: .t); try values.encode(requestedTime, forKey: .requestedTime)
        if let face { try values.encode(face, forKey: .face) } else { try values.encodeNil(forKey: .face) }
    }
}
struct CameraFaceAnalysis: Encodable {
    let version = 1; let coordinateSpace = "oriented-top-left-normalized"; let sampleInterval = 0.2
    let source: CameraAnalysisSource; let samples: [CameraFaceSample]; let coverage: CameraAnalysisCoverage
}
struct CameraSilenceAnalysis: Encodable {
    let version = 1; let windowSeconds = 0.02
    let source: CameraAnalysisSource; let thresholdDB: Double; let minimumSeconds: Double
    let intervals: [CameraAnalysisInterval]; let coverage: CameraAnalysisCoverage
}
struct CameraAnalysisResult: Encodable { let faceTrack: CameraFaceAnalysis?; let silence: CameraSilenceAnalysis? }

enum CameraAnalyzer {
    static func digest(_ url: URL, control: CameraAnalysisControl) throws -> String {
        let input = try FileHandle(forReadingFrom: url); defer { try? input.close() }
        var digest = SHA256()
        while true { try control.check(); guard let data = try input.read(upToCount: 1024 * 1024), !data.isEmpty else { break }; digest.update(data: data) }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }
    static func duration(_ asset: AVURLAsset) async throws -> Double {
        let duration = try await asset.load(.duration).seconds
        guard duration.isFinite, duration > 0, duration <= 86400 else { throw CaptureFailure(code: "invalid_media_duration", message: "Camera analysis requires a finite positive media duration of at most 24 hours.") }
        return duration
    }
    static func faces(_ options: CameraAnalysisOptions, control: CameraAnalysisControl, progress: (Double) -> Void) async throws -> CameraFaceAnalysis {
        let asset = AVURLAsset(url: options.input), duration = try await duration(asset)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw CaptureFailure(code: "camera_video_unavailable", message: "No camera video track is available for face following.") }
        let natural = try await track.load(.naturalSize), transform = try await track.load(.preferredTransform)
        let oriented = natural.applying(transform), width = Int(abs(oriented.width).rounded()), height = Int(abs(oriented.height).rounded())
        guard width > 0, height > 0 else { throw CaptureFailure(code: "invalid_camera_geometry", message: "Camera video dimensions are invalid.") }
        let segments = try await track.load(.segments)
        // Track timeRange can include a leading empty edit. Segment target time
        // is the presentation clock; media/source mapping has different meaning.
        guard let firstMediaSegment = segments.filter({ !$0.isEmpty }).min(by: { $0.timeMapping.target.start.seconds < $1.timeMapping.target.start.seconds }) else { throw CaptureFailure(code: "camera_video_unavailable", message: "The camera track contains no media segment.") }
        let trackStart = max(0, firstMediaSegment.timeMapping.target.start.seconds)
        guard trackStart.isFinite, trackStart < duration else { throw CaptureFailure(code: "invalid_camera_timestamp", message: "The camera video track has no usable source-time range.") }
        let planned = Int(ceil((duration - trackStart) / 0.2))
        // Each sample has at most one face. Bound expanded JSON before retaining observations.
        guard planned <= 100_000 else { throw CaptureFailure(code: "camera_analysis_capacity", message: "The 5 fps face track exceeds the 100,000-observation memory budget. Split the recording before analysis.") }
        let sha = try digest(options.input, control: control)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true; generator.maximumSize = CGSize(width: 1280, height: 1280)
        generator.requestedTimeToleranceBefore = .zero; generator.requestedTimeToleranceAfter = .zero
        let request = VNDetectFaceRectanglesRequest(); request.revision = VNDetectFaceRectanglesRequestRevision3
        control.own(generator: generator, request: request); defer { control.own() }
        var samples: [CameraFaceSample] = []; samples.reserveCapacity(planned)
        var previous: CGRect? = nil
        for index in 0..<planned {
            try control.check()
            let requested = trackStart + Double(index) * 0.2
            let result: (image: CGImage, actualTime: CMTime)
            do { result = try await generator.image(at: CMTime(seconds: requested, preferredTimescale: 60000)) }
            catch { try control.check(); throw CaptureFailure(code: "camera_frame_unavailable", message: "Cannot decode camera frame at source time \(requested)s (first nonempty edit \(trackStart)s): \(error.localizedDescription)") }
            try control.check()
            try VNImageRequestHandler(cgImage: result.image, orientation: .up, options: [:]).perform([request])
            try control.check()
            // Maintain the nearest visible face, selecting the largest initially.
            let observations = (request.results ?? []).filter { $0.confidence >= 0.5 }
            let selected = observations.max { left, right in
                func score(_ face: VNFaceObservation) -> Double {
                    let box = face.boundingBox, area = box.width * box.height
                    guard let previous else { return area }
                    let distance = hypot(box.midX - previous.midX, box.midY - previous.midY)
                    return area / (0.05 + distance)
                }
                return score(left) < score(right)
            }
            let face = selected.map { observation -> CameraFaceObservation in
                let box = observation.boundingBox
                return CameraFaceObservation(x: box.minX, y: 1 - box.maxY, width: box.width, height: box.height, confidence: observation.confidence)
            }
            previous = selected?.boundingBox
            let actual = max(0, result.actualTime.seconds)
            guard actual.isFinite, actual <= duration else { throw CaptureFailure(code: "invalid_camera_timestamp", message: "The camera decoder returned an invalid frame timestamp.") }
            if samples.last?.t != actual { samples.append(CameraFaceSample(t: actual, requestedTime: requested, face: face)) }
            progress(Double(index + 1) / Double(planned))
        }
        try control.check()
        guard try digest(options.input, control: control) == sha else { throw CaptureFailure(code: "source_changed", message: "The camera recording changed during face analysis.") }
        return CameraFaceAnalysis(source: .init(path: options.input.path, sha256: sha, duration: duration, width: width, height: height), samples: samples, coverage: .init(intervals: [.init(start: trackStart, end: duration)], limitations: ["Local Apple Vision face rectangles sampled every 0.2 seconds at a maximum 1280-pixel analysis dimension; short appearances and small or occluded faces can be missed.", "The selected largest/nearest face is not a verified person identity; review recordings with multiple people."]))
    }

    static func silence(_ options: CameraAnalysisOptions, control: CameraAnalysisControl, progress: (Double) -> Void) async throws -> CameraSilenceAnalysis {
        let asset = AVURLAsset(url: options.audioInput), duration = try await duration(asset)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else { throw CaptureFailure(code: "camera_audio_unavailable", message: "The selected camera or microphone recording has no audio track. Import microphone audio to measure silence.") }
        let sha = try digest(options.audioInput, control: control)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 8000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw CaptureFailure(code: "audio_decoder_unavailable", message: "The local audio decoder cannot measure this recording.") }
        reader.add(output); control.own(reader: reader); defer { control.own(); reader.cancelReading() }
        guard reader.startReading() else { throw reader.error ?? CaptureFailure(code: "audio_decoder_unavailable", message: "Cannot start local audio decoding.") }
        let windowSamples = 160, threshold = pow(10, options.thresholdDB / 20)
        var sum = 0.0, count = 0, windowStart = 0.0, latestEnd = 0.0
        var silentStart: Double? = nil, intervals: [CameraAnalysisInterval] = [], coverage: [CameraAnalysisInterval] = []
        var coverageStart: Double? = nil
        func finishSilence(_ end: Double) {
            if let start = silentStart, end - start + 1e-8 >= options.minimumSeconds { intervals.append(.init(start: start, end: end)) }
            silentStart = nil
        }
        func window(_ start: Double, _ end: Double) {
            guard count > 0 else { return }
            let rms = sqrt(sum / Double(count))
            if rms <= threshold { if silentStart == nil { silentStart = start } } else { finishSilence(start) }
            sum = 0; count = 0; latestEnd = end
        }
        while let sample = output.copyNextSampleBuffer() {
            try control.check()
            let pts = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            guard pts.isFinite, pts >= 0, let block = CMSampleBufferGetDataBuffer(sample) else { throw CaptureFailure(code: "invalid_audio_sample", message: "Audio decoder returned an invalid PCM sample.") }
            if coverageStart == nil { coverageStart = pts; latestEnd = pts }
            if pts > latestEnd + 0.04 && count == 0 {
                finishSilence(latestEnd); if let start = coverageStart, latestEnd > start { coverage.append(.init(start: start, end: latestEnd)) }; coverageStart = pts
            }
            let length = CMBlockBufferGetDataLength(block)
            guard length % MemoryLayout<Float>.size == 0, length <= 4 * 1024 * 1024 else { throw CaptureFailure(code: "invalid_audio_sample", message: "Audio decoder returned an oversized or misaligned PCM buffer.") }
            var data = Data(count: length)
            let status = data.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
            guard status == kCMBlockBufferNoErr else { throw CaptureFailure(code: "invalid_audio_sample", message: "Cannot read the decoded audio buffer.") }
            try data.withUnsafeBytes { raw in
                let values = raw.bindMemory(to: Float.self)
                for index in 0..<values.count {
                    let time = pts + Double(index) / 8000
                    if count == 0 { windowStart = time }
                    let value = Double(values[index]); guard value.isFinite else { throw CaptureFailure(code: "invalid_audio_sample", message: "Audio samples must be finite.") }
                    sum += value * value; count += 1
                    if count == windowSamples { window(windowStart, min(duration, time + 1 / 8000.0)) }
                }
            }
            progress(min(1, pts / duration))
            CMSampleBufferInvalidate(sample)
        }
        try control.check()
        guard reader.status == .completed else { throw reader.error ?? CaptureFailure(code: "audio_decode_failed", message: "Audio decoding did not complete.") }
        if count > 0 { window(windowStart, min(duration, windowStart + Double(count) / 8000)) }
        finishSilence(latestEnd)
        if let start = coverageStart, latestEnd > start { coverage.append(.init(start: start, end: latestEnd)) }
        guard !coverage.isEmpty else { throw CaptureFailure(code: "audio_unavailable", message: "No audio samples were available for silence analysis.") }
        guard try digest(options.audioInput, control: control) == sha else { throw CaptureFailure(code: "source_changed", message: "The audio recording changed during silence analysis.") }
        progress(1)
        return CameraSilenceAnalysis(source: .init(path: options.audioInput.path, sha256: sha, duration: duration), thresholdDB: options.thresholdDB, minimumSeconds: options.minimumSeconds, intervals: intervals, coverage: .init(intervals: coverage, limitations: ["Silence is measured from mono 8 kHz decoded audio using 20 ms RMS windows and an explicit dBFS threshold; this is sound-level detection, not speech recognition.", "Only decoded audio coverage can hide the camera. Audio gaps and missing audio are not assumed silent."]))
    }

    static func run(options: CameraAnalysisOptions, control: CameraAnalysisControl) async throws {
        let asset = AVURLAsset(url: options.input), duration = try await duration(asset)
        struct Ready: Encodable { let type = "ready"; let duration: Double }
        struct Progress: Encodable { let type = "progress"; let progress: Double }
        ProtocolOutput.emit(Ready(duration: duration))
        let stages = Double((options.faces ? 1 : 0) + (options.silence ? 1 : 0))
        let faceTrack = options.faces ? try await faces(options, control: control, progress: { ProtocolOutput.emit(Progress(progress: $0 / stages)) }) : nil
        let offset = options.faces ? 1.0 : 0
        let silenceTrack = options.silence ? try await silence(options, control: control, progress: { ProtocolOutput.emit(Progress(progress: (offset + $0) / stages)) }) : nil
        try control.check()
        let data = try JSONEncoder().encode(CameraAnalysisResult(faceTrack: faceTrack, silence: silenceTrack))
        guard data.count <= 64 * 1024 * 1024 else { throw CaptureFailure(code: "camera_analysis_capacity", message: "Expanded camera analysis exceeds the 64 MiB result budget.") }
        try control.commit {
            let fd = open(options.output.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
            guard fd >= 0 else { throw CaptureFailure(code: "output_unavailable", message: "Cannot exclusively create the camera analysis output.") }
            var identity = stat(); _ = fstat(fd, &identity)
            do {
                try data.withUnsafeBytes { raw in
                    var offset = 0
                    while offset < raw.count { let count = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset); if count < 0 && errno == EINTR { continue }; guard count > 0 else { throw CaptureFailure(code: "output_write_failed", message: "Cannot finish the camera analysis output.") }; offset += count }
                }
                guard fsync(fd) == 0 else { throw CaptureFailure(code: "output_write_failed", message: "Cannot synchronize the camera analysis output.") }
                close(fd)
            } catch {
                close(fd); var current = stat()
                if lstat(options.output.path, &current) == 0, current.st_dev == identity.st_dev, current.st_ino == identity.st_ino { if unlink(options.output.path) != 0 { throw CaptureFailure(code: "camera_analysis_cleanup_failed", message: "Camera analysis failed; owned partial output still needs removal: \(options.output.path)") } }
                throw error
            }
        }
    }
}

@MainActor enum CameraAnalysisCommand {
    static func run(options: CameraAnalysisOptions) async -> Int32 {
        let control = CameraAnalysisControl()
        var signals: [DispatchSourceSignal] = []
        for number in [SIGINT, SIGTERM] { signal(number, SIG_IGN); let source = DispatchSource.makeSignalSource(signal: number, queue: .global(qos: .userInitiated)); source.setEventHandler { control.cancel() }; source.resume(); signals.append(source) }
        defer { signals.forEach { $0.cancel() } }
        DispatchQueue.global(qos: .userInitiated).async { while let line = readLine() { if ["stop", "cancel"].contains(line.trimmingCharacters(in: .whitespacesAndNewlines)) { control.cancel(); return } }; control.cancel() }
        do {
            try await CameraAnalyzer.run(options: options, control: control)
            struct Complete: Encodable { let type = "completed"; let output: String }
            ProtocolOutput.emit(Complete(output: options.output.path)); return 0
        } catch {
            // Framework cancellation can surface as a decoder/Vision error.
            // Keep cleanup failures visible even if cancellation raced them.
            if (error as? CaptureFailure)?.code != "camera_analysis_cleanup_failed" {
                do { try control.check() }
                catch { ProtocolOutput.emit(["type": "cancelled"]); return 130 }
            }
            if (error as? CaptureFailure)?.code == "camera_analysis_cancelled" { ProtocolOutput.emit(["type": "cancelled"]); return 130 }
            ProtocolOutput.error(error); return 1
        }
    }
}
