import Foundation
@preconcurrency import AVFoundation
@preconcurrency import Vision
import CryptoKit
import Darwin

struct PrivacyOptions {
    let input: URL
    let output: URL
    let sensitive: Bool
    let faces: Bool
    var customPhrases: [String] = []

    static func parse(_ arguments: [String]) throws -> PrivacyOptions {
        var values: [String: String] = [:]
        var index = 0
        while index < arguments.count {
            guard ["--input", "--output", "--sensitive", "--faces", "--custom-phrases"].contains(arguments[index]), index + 1 < arguments.count,
                  values[arguments[index]] == nil else {
                throw CaptureFailure(code: "invalid_arguments", message: "Privacy analysis received an unknown, duplicate, or incomplete option.")
            }
            values[arguments[index]] = arguments[index + 1]
            index += 2
        }
        func path(_ key: String) throws -> URL {
            guard let value = values[key], value.hasPrefix("/"), !value.utf8.contains(0) else {
                throw CaptureFailure(code: "invalid_arguments", message: "\(key) must be an absolute filesystem path.")
            }
            // Foundation's standardizedFileURL rewrites /private/var to /var.
            // Keep the caller's absolute path for the process protocol; the
            // host has already resolved and authorized its file identity.
            return URL(fileURLWithPath: value)
        }
        func flag(_ key: String) throws -> Bool {
            guard let value = values[key], ["true", "false"].contains(value) else {
                throw CaptureFailure(code: "invalid_arguments", message: "\(key) must be true or false.")
            }
            return value == "true"
        }
        var result = try PrivacyOptions(input: path("--input"), output: path("--output"), sensitive: flag("--sensitive"), faces: flag("--faces"))
        if let text = values["--custom-phrases"] {
            guard text.utf8.count <= 262144, let data = text.data(using: .utf8), let phrases = try? JSONDecoder().decode([String].self, from: data), phrases.count <= 100,
                  phrases.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.count <= 500 && !$0.utf8.contains(0) }) else { throw CaptureFailure(code: "invalid_arguments", message: "Custom privacy phrases must be a list of at most 100 nonempty phrases, each at most 500 characters.") }
            result.customPhrases = Array(Set(phrases)).sorted()
        }
        guard result.sensitive || result.faces else { throw CaptureFailure(code: "invalid_arguments", message: "Enable at least one privacy detector.") }
        guard result.input != result.output, result.output.pathExtension.lowercased() == "json" else {
            throw CaptureFailure(code: "invalid_arguments", message: "Privacy output must be a new .json file distinct from the source video.")
        }
        var sourceInfo = stat()
        guard stat(result.input.path, &sourceInfo) == 0, sourceInfo.st_mode & S_IFMT == S_IFREG else {
            throw CaptureFailure(code: "input_unavailable", message: "Privacy input must be an existing regular video file.")
        }
        var outputInfo = stat()
        guard lstat(result.output.path, &outputInfo) != 0, errno == ENOENT else {
            throw CaptureFailure(code: "output_exists", message: "Refusing to replace an existing privacy output.")
        }
        return result
    }
}

/// Owns exactly one decoder and the current frame's Vision requests.
final class PrivacyControl: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var generator: AVAssetImageGenerator?
    private var requests: [VNRequest] = []

    func cancel() {
        lock.lock()
        cancelled = true
        let generator = self.generator
        let requests = self.requests
        lock.unlock()
        generator?.cancelAllCGImageGeneration()
        requests.forEach { $0.cancel() }
    }

    func check() throws {
        lock.lock(); let value = cancelled; lock.unlock()
        if value { throw CaptureFailure(code: "privacy_cancelled", message: "Privacy analysis was cancelled.") }
    }

    func own(generator: AVAssetImageGenerator?) {
        lock.lock(); self.generator = generator; let cancelled = self.cancelled; lock.unlock()
        if cancelled { generator?.cancelAllCGImageGeneration() }
    }

    func own(requests: [VNRequest]) {
        lock.lock(); self.requests = requests; let cancelled = self.cancelled; lock.unlock()
        if cancelled { requests.forEach { $0.cancel() } }
    }

    /// Serializes publication with cancellation: an accepted cancellation never publishes a result.
    func publish(_ operation: () throws -> Void) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !cancelled else { throw CaptureFailure(code: "privacy_cancelled", message: "Privacy analysis was cancelled.") }
        try operation()
    }
}

struct PrivacyRegion: Codable {
    let start: Double
    let end: Double
    let kind: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let confidence: Double
}

struct PrivacySample: Codable {
    let requestedTime: Double
    let actualTime: Double
    let analysisWidth: Int
    let analysisHeight: Int
}

struct PrivacySource: Encodable {
    let path: String
    let sha256: String
    let width: Int
    let height: Int
    let duration: Double
}

struct PrivacySettings: Encodable {
    let sensitive: Bool
    let faces: Bool
    var customPhrases: [String] = []
    let sampleInterval = 0.5
    let faceTrackingInterval = 0.1
    let faceTrackingMethod = "vision-object-tracking"
    let maximumAnalysisDimension = 4096
    let ocrRevision = 3
    let faceRevision = 3
    let patternRevision = 1
}

struct PrivacyCoverage: Encodable {
    struct Interval: Encodable { let start: Double; let end: Double }
    let complete: Bool
    let sampledFrames: Int
    let plannedFrames: Int
    let intervals: [Interval]
    var trackedFrames: Int = 0
    let meaning = "complete means every planned sampling request succeeded; it is not a guarantee that every sensitive object was detected"
    let limitations = [
        "Text and face re-detection use 0.5-second samples. Detected faces are tracked every 0.1 seconds; brief new appearances, rapid movement, and lost tracks can still be missed.",
        "OCR and face recognition can miss objects or produce false positives. Review the rendered recording before sharing.",
        "Email, phone, card, and key detection uses documented local patterns, not the reference application's unknown algorithm.",
        "Images larger than 4096 pixels per side are downscaled for analysis; small text may be missed.",
        "Sensitive text masks cover the entire recognized text line plus padding; face masks include padding.",
    ]
}

enum PrivacyPatterns {
    private static let email = try! NSRegularExpression(pattern: #"(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}"#)
    private static let number = try! NSRegularExpression(pattern: #"(?<![\w\d])\+?\d[\d(). \u00a0-]{5,}\d(?![\w\d])"#)
    private static let token = try! NSRegularExpression(pattern: #"(?i)(?:sk[-_](?:proj[-_])?[A-Z0-9_-]{16,}|gh[pousr]_[A-Z0-9_]{20,}|AIza[A-Z0-9_-]{30,}|AKIA[A-Z0-9]{16}|eyJ[A-Z0-9_-]{8,}\.[A-Z0-9_-]{8,}\.[A-Z0-9_-]{8,})"#)
    private static let labelledKey = try! NSRegularExpression(pattern: #"(?i)(?:api[_ -]?key|secret|access[_ -]?token|private[_ -]?key)\s*[:=]\s*["']?[A-Z0-9_./+=-]{8,}"#)

    static func kinds(in text: String) -> [String] {
        let full = NSRange(text.startIndex..<text.endIndex, in: text)
        var kinds = Set<String>()
        if email.firstMatch(in: text, range: full) != nil { kinds.insert("email") }
        if token.firstMatch(in: text, range: full) != nil || labelledKey.firstMatch(in: text, range: full) != nil { kinds.insert("key") }
        for match in number.matches(in: text, range: full) {
            guard let range = Range(match.range, in: text) else { continue }
            let candidate = String(text[range])
            let digits = candidate.compactMap { $0.wholeNumberValue }
            if (13...19).contains(digits.count), luhn(digits) { kinds.insert("card") }
            else if (7...15).contains(digits.count), candidate.hasPrefix("+") || digits.count >= 10 || candidate.filter({ "(). -".contains($0) }).count >= 2 {
                kinds.insert("phone")
            }
        }
        return kinds.sorted()
    }

    private static func luhn(_ digits: [Int]) -> Bool {
        guard Set(digits).count > 1 else { return false }
        let sum = digits.reversed().enumerated().reduce(0) { sum, item in
            let value = item.offset % 2 == 1 ? item.element * 2 : item.element
            return sum + (value > 9 ? value - 9 : value)
        }
        return sum % 10 == 0
    }
}

enum PrivacyVision {
    static func regions(image: CGImage, start: Double, end: Double, options: PrivacyOptions, control: PrivacyControl, tracker: PrivacyFaceTracker? = nil, time: Double = 0) throws -> [PrivacyRegion] {
        var requests: [VNRequest] = []
        let textRequest = VNRecognizeTextRequest()
        if options.sensitive {
            textRequest.revision = VNRecognizeTextRequestRevision3
            textRequest.recognitionLevel = .accurate
            textRequest.usesLanguageCorrection = false
            textRequest.automaticallyDetectsLanguage = true
            requests.append(textRequest)
        }
        let faceRequest = VNDetectFaceRectanglesRequest()
        if options.faces { faceRequest.revision = VNDetectFaceRectanglesRequestRevision3; requests.append(faceRequest) }
        control.own(requests: requests)
        defer { control.own(requests: []) }
        try control.check()
        do { try VNImageRequestHandler(cgImage: image, orientation: .up, options: [:]).perform(requests) }
        catch {
            try control.check()
            throw CaptureFailure(code: "vision_analysis_failed", message: "Apple Vision could not analyze a frame: \(error.localizedDescription)")
        }
        try control.check()
        var result: [PrivacyRegion] = []
        if options.sensitive {
            for observation in textRequest.results ?? [] {
                guard let candidate = observation.topCandidates(1).first else { continue }
                var kinds = PrivacyPatterns.kinds(in: candidate.string)
                if options.customPhrases.contains(where: { candidate.string.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive]) != nil }) { kinds.append("phrase") }
                for kind in kinds {
                    result.append(region(observation.boundingBox, kind: kind, confidence: candidate.confidence,
                                         paddingX: max(4 / Double(image.width), observation.boundingBox.height * 0.12),
                                         paddingY: max(4 / Double(image.height), observation.boundingBox.height * 0.18), start: start, end: end))
                }
            }
        }
        if options.faces {
            try tracker?.seed(image: image, observations: faceRequest.results ?? [], time: time, control: control)
            for observation in faceRequest.results ?? [] {
                result.append(region(observation.boundingBox, kind: "face", confidence: observation.confidence,
                                     paddingX: observation.boundingBox.width * 0.15, paddingY: observation.boundingBox.height * 0.15,
                                     start: tracker == nil ? start : time, end: tracker == nil ? end : min(end, time + 0.1)))
            }
        }
        return result
    }

    static func region(_ box: CGRect, kind: String, confidence: Float, paddingX: Double, paddingY: Double, start: Double, end: Double) -> PrivacyRegion {
        let left = max(0, box.minX - paddingX)
        let top = max(0, 1 - box.maxY - paddingY)
        let right = min(1, box.maxX + paddingX)
        let bottom = min(1, 1 - box.minY + paddingY)
        return PrivacyRegion(start: start, end: end, kind: kind, x: left, y: top, width: max(0, right - left), height: max(0, bottom - top), confidence: min(1, max(0, Double(confidence))))
    }
}

/// Actual Vision sequence tracking between periodic face detections. Each
/// interval covers both bounding boxes, avoiding uncovered motion between the
/// analyzed frames. No identity is inferred when Vision loses the object.
final class PrivacyFaceTracker {
    private var sequence = VNSequenceRequestHandler()
    private var requests: [VNTrackObjectRequest] = []
    private var previousTime = 0.0
    private(set) var trackedFrames = 0
    var active: Bool { !requests.isEmpty }

    func seed(image: CGImage, observations: [VNFaceObservation], time: Double, control: PrivacyControl) throws {
        sequence = VNSequenceRequestHandler()
        requests = observations.map { observation in
            let request = VNTrackObjectRequest(detectedObjectObservation: observation)
            request.trackingLevel = .accurate
            return request
        }
        previousTime = time
        guard active else { return }
        try perform(image: image, control: control)
        for request in requests {
            if let observation = request.results?.first as? VNDetectedObjectObservation { request.inputObservation = observation }
        }
    }

    func regions(image: CGImage, time: Double, end: Double, control: PrivacyControl) throws -> [PrivacyRegion] {
        guard active else { return [] }
        let previous = requests.map { $0.inputObservation.boundingBox }
        try perform(image: image, control: control)
        var retained: [VNTrackObjectRequest] = []
        var regions: [PrivacyRegion] = []
        for (index, request) in requests.enumerated() {
            guard let observation = request.results?.first as? VNDetectedObjectObservation, observation.confidence > 0,
                  observation.boundingBox.width > 0, observation.boundingBox.height > 0 else { continue }
            let box = previous[index].union(observation.boundingBox)
            regions.append(PrivacyVision.region(box, kind: "face", confidence: observation.confidence,
                                                paddingX: box.width * 0.15, paddingY: box.height * 0.15,
                                                start: max(0, previousTime), end: end))
            request.inputObservation = observation
            retained.append(request)
        }
        requests = retained
        previousTime = time
        return regions
    }

    private func perform(image: CGImage, control: PrivacyControl) throws {
        control.own(requests: requests)
        defer { control.own(requests: []) }
        try control.check()
        do { try sequence.perform(requests, on: image, orientation: .up) }
        catch {
            try control.check()
            throw CaptureFailure(code: "vision_tracking_failed", message: "Apple Vision could not track a face between video samples: \(error.localizedDescription)")
        }
        trackedFrames += 1
        try control.check()
    }
}

/// Three exclusive local spool files bound memory and allow atomic no-replace publication.
final class PrivacyOutput {
    private let target: URL
    private var files: [(url: URL, handle: FileHandle, device: dev_t, inode: ino_t)] = []
    private var bytes = 0
    private(set) var regionCount = 0
    private(set) var sampleCount = 0
    private let encoder = JSONEncoder()

    init(target: URL) throws {
        self.target = target
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        do {
            for suffix in ["regions", "samples", "result"] {
                let url = target.deletingLastPathComponent().appendingPathComponent(".reva-privacy-\(UUID().uuidString).\(suffix).tmp")
                let descriptor = open(url.path, O_RDWR | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
                guard descriptor >= 0 else { throw CaptureFailure(code: "privacy_output_failed", message: "Cannot create private analysis output: \(String(cString: strerror(errno)))") }
                var identity = stat()
                guard fstat(descriptor, &identity) == 0 else { close(descriptor); throw CaptureFailure(code: "privacy_output_failed", message: "Cannot establish ownership of an analysis spool file.") }
                files.append((url, FileHandle(fileDescriptor: descriptor, closeOnDealloc: true), identity.st_dev, identity.st_ino))
            }
        } catch { _ = cleanup(); throw error }
    }

    deinit { _ = cleanup() }

    func append(regions: [PrivacyRegion], sample: PrivacySample) throws {
        try append(regions: regions)
        try append(sample, to: files[1].handle, comma: sampleCount > 0)
        sampleCount += 1
    }

    func append(regions: [PrivacyRegion]) throws {
        guard regions.count <= 500_000 - regionCount else {
            throw CaptureFailure(code: "privacy_output_limit", message: "Privacy metadata exceeded its 500,000 region budget; analyze a shorter video.")
        }
        for region in regions { try append(region, to: files[0].handle, comma: regionCount > 0); regionCount += 1 }
    }

    func finish(source: PrivacySource, settings: PrivacySettings, coverage: PrivacyCoverage, control: PrivacyControl) throws {
        let destination = files[2].handle
        try destination.write(contentsOf: Data("{\"version\":1,\"coordinateSpace\":\"oriented-top-left-normalized\",\"source\":".utf8))
        try destination.write(contentsOf: encoder.encode(source))
        try destination.write(contentsOf: Data(",\"settings\":".utf8))
        try destination.write(contentsOf: encoder.encode(settings))
        try destination.write(contentsOf: Data(",\"coverage\":".utf8))
        try destination.write(contentsOf: encoder.encode(coverage))
        try destination.write(contentsOf: Data(",\"samples\":[".utf8))
        try copy(files[1].handle, to: destination, control: control)
        try destination.write(contentsOf: Data("],\"regions\":[".utf8))
        try copy(files[0].handle, to: destination, control: control)
        try destination.write(contentsOf: Data("]}\n".utf8))
        guard try destination.offset() <= 64 * 1024 * 1024 else {
            throw CaptureFailure(code: "privacy_output_limit", message: "Privacy metadata exceeded its 64 MB output budget; analyze a shorter video.")
        }
        try destination.synchronize()
        try control.publish {
            guard link(files[2].url.path, target.path) == 0 else {
                throw CaptureFailure(code: errno == EEXIST ? "output_exists" : "privacy_output_failed", message: "Cannot atomically publish privacy output without replacing a file: \(String(cString: strerror(errno)))")
            }
        }
        let remaining = cleanup()
        guard remaining.isEmpty else {
            throw CaptureFailure(code: "privacy_cleanup_failed", message: "The complete output was published, but owned temporary files still need cleanup: \(remaining.joined(separator: ", ")).")
        }
    }

    private func append<T: Encodable>(_ value: T, to handle: FileHandle, comma: Bool) throws {
        var data = try encoder.encode(value)
        if comma { data.insert(0x2c, at: 0) }
        bytes += data.count
        guard bytes <= 64 * 1024 * 1024 else { throw CaptureFailure(code: "privacy_output_limit", message: "Privacy metadata exceeded its 64 MB output budget; analyze a shorter video.") }
        try handle.write(contentsOf: data)
    }

    private func copy(_ source: FileHandle, to destination: FileHandle, control: PrivacyControl) throws {
        try source.seek(toOffset: 0)
        while true {
            try control.check()
            guard let data = try source.read(upToCount: 1024 * 1024), !data.isEmpty else { break }
            try destination.write(contentsOf: data)
        }
    }

    @discardableResult func cleanup() -> [String] {
        var remaining: [(url: URL, handle: FileHandle, device: dev_t, inode: ino_t)] = []
        for file in files {
            try? file.handle.close()
            var identity = stat()
            if lstat(file.url.path, &identity) != 0 {
                if errno != ENOENT { remaining.append(file) }
                continue
            }
            guard identity.st_dev == file.device, identity.st_ino == file.inode else {
                remaining.append(file)
                continue
            }
            do { try FileManager.default.removeItem(at: file.url) }
            catch { remaining.append(file) }
        }
        files = remaining
        return remaining.map { $0.url.path }
    }
}

struct PrivacyProgress: Encodable {
    let type = "progress"
    let progress: Double
    let t: Double
    let sampledFrames: Int
    let plannedFrames: Int
}

enum PrivacyAnalyzer {
    static func run(options: PrivacyOptions, control: PrivacyControl) async throws -> (regions: Int, sampledFrames: Int) {
        try control.check()
        let digest = try hash(options.input, control: control)
        let asset = AVURLAsset(url: options.input)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw CaptureFailure(code: "no_video_track", message: "The supplied file has no video track.")
        }
        let duration = try await asset.load(.duration).seconds
        let natural = try await track.load(.naturalSize)
        let transform = try await track.load(.preferredTransform)
        guard duration.isFinite, duration >= 0.001, duration <= 86400 else { throw CaptureFailure(code: "invalid_video_duration", message: "Privacy analysis requires a video between 1 millisecond and 24 hours long.") }
        let segments = try await track.load(.segments)
        guard let firstMediaSegment = segments.filter({ !$0.isEmpty }).min(by: { $0.timeMapping.target.start.seconds < $1.timeMapping.target.start.seconds }) else {
            throw CaptureFailure(code: "no_video_track", message: "The video track contains no media segment.")
        }
        let trackStart = max(0, firstMediaSegment.timeMapping.target.start.seconds)
        guard trackStart.isFinite, trackStart < duration else {
            throw CaptureFailure(code: "invalid_video_duration", message: "The video has no decodable frames within its timeline.")
        }
        // AVAssetImageGenerator documents support only for orthogonal, unscaled rotations.
        let rotations: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [(1, 0, 0, 1), (0, 1, -1, 0), (-1, 0, 0, -1), (0, -1, 1, 0)]
        guard rotations.contains(where: { abs(transform.a - $0.0) < 0.0001 && abs(transform.b - $0.1) < 0.0001 && abs(transform.c - $0.2) < 0.0001 && abs(transform.d - $0.3) < 0.0001 }) else {
            throw CaptureFailure(code: "unsupported_video_transform", message: "Privacy analysis supports upright video and 90°, 180°, or 270° rotations; scaled or mirrored track transforms need preprocessing.")
        }
        let oriented = CGRect(origin: .zero, size: natural).applying(transform).standardized.size
        guard oriented.width.isFinite, oriented.height.isFinite, oriented.width > 0, oriented.height > 0,
              oriented.width <= 32768, oriented.height <= 32768 else { throw CaptureFailure(code: "invalid_video_dimensions", message: "The video has unsupported display dimensions.") }
        let source = PrivacySource(path: options.input.path, sha256: digest, width: Int(oriented.width.rounded()), height: Int(oriented.height.rounded()), duration: duration)
        let settings = PrivacySettings(sensitive: options.sensitive, faces: options.faces, customPhrases: options.customPhrases)
        let tracker = options.faces ? PrivacyFaceTracker() : nil
        // A leading empty edit has no source image. Start at the first real
        // video frame and keep that gap explicit in the coverage intervals.
        let planned = Int(ceil((duration - trackStart) / settings.sampleInterval))
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: settings.maximumAnalysisDimension, height: settings.maximumAnalysisDimension)
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        control.own(generator: generator)
        defer { generator.cancelAllCGImageGeneration(); control.own(generator: nil) }
        let output = try PrivacyOutput(target: options.output)
        do {
        struct Ready: Encodable { let type = "ready"; let duration: Double; let plannedFrames: Int; let sampleInterval: Double }
        ProtocolOutput.emit(Ready(duration: duration, plannedFrames: planned, sampleInterval: settings.sampleInterval))
        for index in 0..<planned {
            try control.check()
            let requested = trackStart + Double(index) * settings.sampleInterval
            let result: (image: CGImage, actualTime: CMTime)
            do { result = try await generator.image(at: CMTime(seconds: requested, preferredTimescale: 60000)) }
            catch {
                try control.check()
                throw CaptureFailure(code: "video_decode_failed", message: "Cannot decode the planned video sample at \(requested) seconds: \(error.localizedDescription)")
            }
            let actual = result.actualTime.seconds
            guard actual.isFinite, actual >= 0, actual <= duration else { throw CaptureFailure(code: "invalid_sample_time", message: "The decoder returned an invalid sample timestamp.") }
            let regions = try autoreleasepool {
                try PrivacyVision.regions(image: result.image, start: max(0, min(actual, requested) - settings.sampleInterval),
                                          end: min(duration, max(actual, requested) + settings.sampleInterval), options: options, control: control, tracker: tracker, time: requested)
            }
            try output.append(regions: regions, sample: PrivacySample(requestedTime: requested, actualTime: actual,
                                                                     analysisWidth: result.image.width, analysisHeight: result.image.height))
            if let tracker {
                let steps = Int((settings.sampleInterval / settings.faceTrackingInterval).rounded())
                for step in 1..<steps where tracker.active {
                    try control.check()
                    let time = requested + Double(step) * settings.faceTrackingInterval
                    if time >= duration - 1e-9 { break }
                    let tracked: (image: CGImage, actualTime: CMTime)
                    do { tracked = try await generator.image(at: CMTime(seconds: time, preferredTimescale: 60000)) }
                    catch {
                        try control.check()
                        throw CaptureFailure(code: "video_decode_failed", message: "Cannot decode a planned face-tracking frame at \(time) seconds: \(error.localizedDescription)")
                    }
                    let trackedRegions = try autoreleasepool {
                        try tracker.regions(image: tracked.image, time: time, end: min(duration, time + settings.faceTrackingInterval), control: control)
                    }
                    try output.append(regions: trackedRegions)
                }
            }
            ProtocolOutput.emit(PrivacyProgress(progress: Double(index + 1) / Double(planned), t: actual, sampledFrames: index + 1, plannedFrames: planned))
        }
        try control.check()
        guard try hash(options.input, control: control) == digest else { throw CaptureFailure(code: "source_changed", message: "The input video changed during privacy analysis; no result was published.") }
        let coverage = PrivacyCoverage(complete: true, sampledFrames: output.sampleCount, plannedFrames: planned, intervals: [.init(start: trackStart, end: duration)], trackedFrames: tracker?.trackedFrames ?? 0)
        try output.finish(source: source, settings: settings, coverage: coverage, control: control)
        return (output.regionCount, output.sampleCount)
        } catch {
            let remaining = output.cleanup()
            guard remaining.isEmpty else {
                throw CaptureFailure(code: "privacy_cleanup_failed", message: "Analysis failed (\(error.localizedDescription)); these owned temporary paths still need cleanup: \(remaining.joined(separator: ", ")).")
            }
            throw error
        }
    }

    private static func hash(_ url: URL, control: PrivacyControl) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var digest = SHA256()
        while true {
            try control.check()
            guard let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty else { break }
            digest.update(data: data)
        }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

@MainActor enum PrivacyCommand {
    static func run(options: PrivacyOptions) async -> Int32 {
        let control = PrivacyControl()
        var signals: [DispatchSourceSignal] = []
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global(qos: .userInitiated))
            source.setEventHandler { control.cancel() }
            source.resume()
            signals.append(source)
        }
        defer { signals.forEach { $0.cancel() } }
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine() {
                if ["stop", "cancel"].contains(line.trimmingCharacters(in: .whitespacesAndNewlines)) { control.cancel(); return }
            }
            control.cancel()
        }
        do {
            let result = try await PrivacyAnalyzer.run(options: options, control: control)
            struct Completed: Encodable { let type = "completed"; let output: String; let regions: Int; let sampledFrames: Int }
            ProtocolOutput.emit(Completed(output: options.output.path, regions: result.regions, sampledFrames: result.sampledFrames))
            return 0
        } catch {
            if (error as? CaptureFailure)?.code == "privacy_cancelled" {
                ProtocolOutput.emit(["type": "cancelled"])
                return 130
            }
            ProtocolOutput.error(error)
            return 1
        }
    }
}
