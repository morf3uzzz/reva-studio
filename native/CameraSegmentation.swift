import Foundation
@preconcurrency import AVFoundation
@preconcurrency import Vision
import ImageIO
import Darwin

struct CameraSegmentationOptions {
    let input: URL
    let outputDirectory: URL
    let quality: String

    static func parse(_ arguments: [String]) throws -> CameraSegmentationOptions {
        var values: [String: String] = [:]
        var index = 0
        while index < arguments.count {
            let key = arguments[index]
            guard ["--input", "--output-directory", "--quality"].contains(key), index + 1 < arguments.count, values[key] == nil else {
                throw CaptureFailure(code: "invalid_arguments", message: "Camera segmentation received an unknown, duplicate, or incomplete option.")
            }
            values[key] = arguments[index + 1]; index += 2
        }
        func path(_ key: String) throws -> URL {
            guard let path = values[key], path.hasPrefix("/"), !path.utf8.contains(0), !path.split(separator: "/").contains("..") else {
                throw CaptureFailure(code: "invalid_arguments", message: "\(key) must be an absolute filesystem path without parent traversal.")
            }
            return URL(fileURLWithPath: path)
        }
        let quality = values["--quality"] ?? "balanced"
        guard ["balanced", "accurate"].contains(quality) else { throw CaptureFailure(code: "invalid_arguments", message: "Camera quality must be balanced or accurate.") }
        let result = try CameraSegmentationOptions(input: path("--input"), outputDirectory: path("--output-directory"), quality: quality)
        var info = stat()
        guard stat(result.input.path, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { throw CaptureFailure(code: "input_unavailable", message: "Supply an existing regular camera video file.") }
        guard lstat(result.outputDirectory.path, &info) != 0, errno == ENOENT else { throw CaptureFailure(code: "output_exists", message: "Refusing to replace an existing camera output directory or symlink.") }
        return result
    }
}

/// Cancellation owns the decoder and active Vision request. The serial pipeline
/// drains/finalizes its writer before any owned-file cleanup.
final class CameraSegmentationControl: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var committed = false
    private var reader: AVAssetReader?
    private var request: VNRequest?

    func cancel() {
        lock.lock()
        guard !committed else { lock.unlock(); return }
        cancelled = true
        let reader = reader, request = request
        lock.unlock()
        reader?.cancelReading(); request?.cancel()
    }
    func check() throws {
        lock.lock(); defer { lock.unlock() }
        if cancelled { throw CaptureFailure(code: "segmentation_cancelled", message: "Camera segmentation was cancelled.") }
    }
    func own(reader: AVAssetReader?, request: VNRequest?) {
        lock.lock(); self.reader = reader; self.request = request; let cancelled = cancelled; lock.unlock()
        if cancelled { reader?.cancelReading(); request?.cancel() }
    }
    func checked(_ operation: () throws -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        if cancelled { throw CaptureFailure(code: "segmentation_cancelled", message: "Camera segmentation was cancelled.") }
        try operation()
    }
    func commit(_ operation: () throws -> Void) throws {
        try checked { try operation(); committed = true }
    }
}

struct CameraTime: Codable {
    let value: Int64
    let timescale: Int32
    let seconds: Double
    init(_ time: CMTime) { value = time.value; timescale = time.timescale; seconds = time.seconds }
}

struct CameraMaskManifest: Encodable {
    struct Source: Encodable { let path: String; let sha256: String; let width: Int; let height: Int; let duration: Double; let orientation: UInt32 }
    struct Mask: Encodable {
        let file = "camera-mask.mp4"
        let width: Int; let height: Int
        let codec = "h264"
        let channel = "red"
        let background = 0; let foreground = 1
        let interpretation = "alpha = decoded RGB red / 255; video alpha is opaque; stretch over oriented full source before applying identical crop/mirror to source and mask"
    }
    struct Timing: Encodable {
        let sourceTimeOrigin: Double
        let firstPTS: CameraTime; let lastPTS: CameraTime; let sourceEnd: CameraTime
        let duration: Double; let frameCount: Int
        let preservesVariableFrameRate = true
        let mapping = "maskTime = cameraSourceTime - sourceTimeOrigin; outside the source range the mask is unavailable"
        let finalDurationSource: String
    }
    struct Settings: Encodable {
        let visionRevision = 1
        let quality: String
        let osVersion = ProcessInfo.processInfo.operatingSystemVersionString
        let outputPixelFormat = "OneComponent8"
        let analysis = "all decoded video frames; independent Apple Vision person segmentation, not the reference application's model"
    }
    let version = 1
    let coordinateSpace = "oriented-top-left-normalized"
    let source: Source; let mask: Mask; let timing: Timing; let settings: Settings
}

enum CameraVideoGeometry {
    static func orientation(_ transform: CGAffineTransform) throws -> CGImagePropertyOrientation {
        let choices: [(CGFloat, CGFloat, CGFloat, CGFloat, CGImagePropertyOrientation)] = [
            (1, 0, 0, 1, .up), (0, 1, -1, 0, .right), (-1, 0, 0, -1, .down), (0, -1, 1, 0, .left),
            (-1, 0, 0, 1, .upMirrored), (1, 0, 0, -1, .downMirrored), (0, 1, 1, 0, .leftMirrored), (0, -1, -1, 0, .rightMirrored),
        ]
        guard transform.tx.isFinite, transform.ty.isFinite,
              let choice = choices.first(where: { abs(transform.a - $0.0) < 0.0001 && abs(transform.b - $0.1) < 0.0001 && abs(transform.c - $0.2) < 0.0001 && abs(transform.d - $0.3) < 0.0001 }) else {
            throw CaptureFailure(code: "unsupported_video_transform", message: "Camera segmentation supports orthogonal rotations and reflections; scaled or skewed track transforms need preprocessing.")
        }
        return choice.4
    }

    static func validate(_ size: CGSize) throws {
        // Two decoded BGRA buffers require at most 128 MiB; Vision has additional
        // framework-owned memory. Dimensions are checked before decoder allocation.
        guard size.width.isFinite, size.height.isFinite, size.width >= 1, size.height >= 1,
              size.width <= 8192, size.height <= 8192, size.width * size.height <= 16_777_216 else {
            throw CaptureFailure(code: "segmentation_input_limit", message: "Camera video exceeds the 16-megapixel or 8192-pixel-side decode budget.")
        }
    }
}

final class CameraMaskWriter {
    let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    let width: Int; let height: Int
    private var closed = false

    init(url: URL, width: Int, height: Int, frameRate: Float) throws {
        self.width = width; self.height = height
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let fps = max(1, min(240, frameRate.isFinite ? Double(frameRate) : 30))
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width, AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: Int(min(20_000_000, max(2_000_000, Double(width * height) * fps))),
                AVVideoExpectedSourceFrameRateKey: fps,
                AVVideoMaxKeyFrameIntervalKey: max(1, Int(fps)),
                AVVideoAllowFrameReorderingKey: false,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ]
        guard writer.canApply(outputSettings: settings, forMediaType: .video) else { throw CaptureFailure(code: "encoder_unavailable", message: "The H.264 mask encoder cannot accept these dimensions.") }
        input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = false
        guard writer.canAdd(input) else { throw CaptureFailure(code: "encoder_unavailable", message: "The H.264 mask encoder is unavailable.") }
        writer.add(input)
        guard writer.startWriting() else { throw failure("Cannot start the camera mask encoder.") }
        writer.startSession(atSourceTime: .zero)
    }

    func append(_ sample: CMSampleBuffer, control: CameraSegmentationControl) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 30
        while !input.isReadyForMoreMediaData {
            try control.check()
            guard writer.status == .writing else { throw failure("The mask encoder stopped accepting samples.") }
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw CaptureFailure(code: "encoder_stalled", message: "The camera mask encoder made no progress for 30 seconds.") }
            try await Task.sleep(nanoseconds: 2_000_000)
        }
        try control.check()
        guard input.append(sample) else { throw failure("Cannot append a camera mask frame.") }
    }

    func finish(at end: CMTime) async throws {
        guard !closed else { return }
        guard writer.status == .writing else { throw failure("The mask encoder failed before finalization.") }
        writer.endSession(atSourceTime: end)
        input.markAsFinished()
        // Cancellation is checked after this completion callback. Cleanup never
        // races an asynchronous writer still touching its owned output file.
        await withCheckedContinuation { continuation in writer.finishWriting { continuation.resume() } }
        closed = true
        guard writer.status == .completed else { throw failure("The mask encoder could not finish.") }
    }

    func cancel() { if !closed { writer.cancelWriting(); closed = true } }
    private func failure(_ message: String) -> CaptureFailure { CaptureFailure(code: "mask_encode_failed", message: "\(message) \(writer.error?.localizedDescription ?? "")") }
}

enum CameraSegmentationPixels {
    /// Vision returns a one-channel matte. Repeat its encoded values in RGB;
    /// consumer must read red as alpha rather than use this video's opaque alpha.
    static func sample(mask: CVPixelBuffer, at time: CMTime, duration: CMTime) throws -> (sample: CMSampleBuffer, width: Int, height: Int) {
        let sourceWidth = CVPixelBufferGetWidth(mask), sourceHeight = CVPixelBufferGetHeight(mask)
        guard CVPixelBufferGetPixelFormatType(mask) == kCVPixelFormatType_OneComponent8,
              sourceWidth > 0, sourceHeight > 0, sourceWidth <= 4096, sourceHeight <= 4096 else {
            throw CaptureFailure(code: "unsupported_mask_format", message: "Vision returned an unsupported mask pixel format or size.")
        }
        let width = (sourceWidth + 1) / 2 * 2, height = (sourceHeight + 1) / 2 * 2
        var pixels: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pixels) == kCVReturnSuccess, let pixels else {
            throw CaptureFailure(code: "mask_allocation_failed", message: "Cannot allocate the current mask frame.")
        }
        CVPixelBufferLockBaseAddress(mask, .readOnly); CVPixelBufferLockBaseAddress(pixels, [])
        defer { CVPixelBufferUnlockBaseAddress(pixels, []); CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
        guard let source = CVPixelBufferGetBaseAddress(mask)?.assumingMemoryBound(to: UInt8.self),
              let output = CVPixelBufferGetBaseAddress(pixels)?.assumingMemoryBound(to: UInt8.self) else { throw CaptureFailure(code: "mask_allocation_failed", message: "Cannot access the current mask pixels.") }
        let sourceRow = CVPixelBufferGetBytesPerRow(mask), outputRow = CVPixelBufferGetBytesPerRow(pixels)
        for y in 0..<height {
            let from = source.advanced(by: (y * sourceHeight / height) * sourceRow)
            let to = output.advanced(by: y * outputRow)
            for x in 0..<width {
                let value = from[x * sourceWidth / width]
                to[x * 4] = value; to[x * 4 + 1] = value; to[x * 4 + 2] = value; to[x * 4 + 3] = 255
            }
        }
        var format: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels, formatDescriptionOut: &format) == noErr, let format else { throw CaptureFailure(code: "mask_format_failed", message: "Cannot describe the mask pixels.") }
        var timing = CMSampleTimingInfo(duration: duration, presentationTimeStamp: time, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels, formatDescription: format, sampleTiming: &timing, sampleBufferOut: &sample) == noErr, let sample else { throw CaptureFailure(code: "mask_format_failed", message: "Cannot timestamp the mask pixels.") }
        return (sample, width, height)
    }
}

enum CameraSegmenter {
    struct Result { let manifest: CameraMaskManifest; let output: URL }
    private struct Progress: Encodable { let type = "progress"; let phase: String; let progress: Double; let t: Double; let frames: Int }

    static func run(options: CameraSegmentationOptions, control: CameraSegmentationControl) async throws -> Result {
        try control.check()
        let sourceFile = try CameraInputFile(url: options.input)
        let digest = try sourceFile.hash(control: control)
        let asset = AVURLAsset(url: options.input)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw CaptureFailure(code: "no_video_track", message: "The camera input has no video track.") }
        let duration = try await asset.load(.duration)
        let natural = try await track.load(.naturalSize)
        let transform = try await track.load(.preferredTransform)
        let range = try await track.load(.timeRange)
        let segments = try await track.load(.segments)
        let mediaRanges = segments.filter { !$0.isEmpty }.map { $0.timeMapping.target }.sorted { $0.start.seconds < $1.start.seconds }
        guard !mediaRanges.isEmpty, mediaRanges.allSatisfy({ $0.start.isNumeric && $0.duration.isNumeric && $0.duration.seconds > 0 }) else {
            throw CaptureFailure(code: "invalid_video_duration", message: "The camera track has no finite nonempty media segment.")
        }
        let frameRate = try await track.load(.nominalFrameRate)
        let formats = try await track.load(.formatDescriptions)
        guard duration.isNumeric, duration.seconds >= 0.001, duration.seconds <= 86400,
              range.start.isNumeric, range.duration.isNumeric, range.duration.seconds > 0 else { throw CaptureFailure(code: "invalid_video_duration", message: "Camera segmentation requires a video between 1 millisecond and 24 hours with a valid track range.") }
        try CameraVideoGeometry.validate(natural)
        for format in formats {
            let coded = CMVideoFormatDescriptionGetDimensions(format)
            try CameraVideoGeometry.validate(CGSize(width: Int(coded.width), height: Int(coded.height)))
            guard abs(Double(coded.width) - natural.width) < 1, abs(Double(coded.height) - natural.height) < 1 else { throw CaptureFailure(code: "unsupported_pixel_aspect", message: "Non-square pixel aspect or track aperture transforms require preprocessing.") }
        }
        let orientation = try CameraVideoGeometry.orientation(transform)
        let oriented = CGRect(origin: .zero, size: natural).applying(transform).standardized.size
        let request = VNGeneratePersonSegmentationRequest()
        request.revision = VNGeneratePersonSegmentationRequestRevision1
        request.qualityLevel = options.quality == "accurate" ? .accurate : .balanced
        request.outputPixelFormat = kCVPixelFormatType_OneComponent8
        let reader = try AVAssetReader(asset: asset)
        let decoded = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        decoded.alwaysCopiesSampleData = false
        guard reader.canAdd(decoded) else { throw CaptureFailure(code: "video_decode_failed", message: "Cannot attach the camera video decoder.") }
        reader.add(decoded)
        control.own(reader: reader, request: request)
        defer { reader.cancelReading(); control.own(reader: nil, request: nil) }
        try control.check()
        let output = try CameraMaskOutput(target: options.outputDirectory)
        var writer: CameraMaskWriter?
        do {
            guard reader.startReading() else { throw CaptureFailure(code: "video_decode_failed", message: "Cannot start the camera decoder: \(reader.error?.localizedDescription ?? "")") }
            struct Ready: Encodable { let type = "ready"; let duration: Double; let width: Int; let height: Int; let quality: String }
            try control.checked { ProtocolOutput.emit(Ready(duration: duration.seconds, width: Int(oriented.width.rounded()), height: Int(oriented.height.rounded()), quality: options.quality)) }
            var current = decoded.copyNextSampleBuffer()
            var first = CMTime.invalid, last = CMTime.invalid, end = CMTime.invalid
            var frames = 0, lastProgress = 0.0
            var finalDurationSource = "sample"
            var rangeIndex = 0
            while let sample = current {
                try control.check()
                let next = decoded.copyNextSampleBuffer()
                current = next
                let pts = CMSampleBufferGetPresentationTimeStamp(sample)
                guard pts.isNumeric, pts.epoch == 0, pts.seconds >= 0, pts.seconds < duration.seconds + 0.001,
                      !last.isNumeric || CMTimeCompare(pts, last) > 0 else { throw CaptureFailure(code: "invalid_sample_time", message: "Camera timestamps must be finite, nonnegative and strictly increasing within the source duration.") }
                // AVAssetReader synthesizes an image at t=0 for a leading empty
                // edit. It is not an encoded camera frame. Keep mask origin and
                // frame coverage on the actual nonempty source segments.
                while rangeIndex < mediaRanges.count && CMTimeCompare(pts, CMTimeRangeGetEnd(mediaRanges[rangeIndex])) >= 0 { rangeIndex += 1 }
                guard rangeIndex < mediaRanges.count else { continue }
                guard CMTimeCompare(pts, mediaRanges[rangeIndex].start) >= 0 else { continue }
                if !first.isNumeric { first = pts }
                var sampleDuration = CMSampleBufferGetDuration(sample)
                finalDurationSource = "sample"
                if !sampleDuration.isNumeric || sampleDuration.seconds <= 0 {
                    sampleDuration = next.map { CMTimeSubtract(CMSampleBufferGetPresentationTimeStamp($0), pts) } ?? CMTimeSubtract(CMTimeRangeGetEnd(range), pts)
                    finalDurationSource = next == nil ? "track-end" : "next-pts"
                }
                sampleDuration = CMTimeMinimum(sampleDuration, CMTimeSubtract(CMTimeRangeGetEnd(mediaRanges[rangeIndex]), pts))
                guard sampleDuration.isNumeric, sampleDuration.seconds > 0, CMTimeAdd(pts, sampleDuration).seconds <= duration.seconds + 0.001 else { throw CaptureFailure(code: "invalid_sample_duration", message: "The camera frame has no valid duration within the source timeline.") }
                let frame = try autoreleasepool { () throws -> (sample: CMSampleBuffer, width: Int, height: Int) in
                    do { try VNImageRequestHandler(cmSampleBuffer: sample, orientation: orientation, options: [:]).perform([request]) }
                    catch { try control.check(); throw CaptureFailure(code: "vision_segmentation_failed", message: "Apple Vision could not segment a camera frame: \(error.localizedDescription)") }
                    try control.check()
                    guard let mask = request.results?.first?.pixelBuffer else { throw CaptureFailure(code: "vision_segmentation_empty", message: "Vision returned no mask for a decoded frame; no complete result will be published.") }
                    return try CameraSegmentationPixels.sample(mask: mask, at: CMTimeSubtract(pts, first), duration: sampleDuration)
                }
                if writer == nil {
                    do { writer = try CameraMaskWriter(url: output.url("camera-mask.mp4"), width: frame.width, height: frame.height, frameRate: frameRate) }
                    catch { if FileManager.default.fileExists(atPath: output.url("camera-mask.mp4").path) { try output.ownFile("camera-mask.mp4") }; throw error }
                    try output.ownFile("camera-mask.mp4")
                }
                guard let activeWriter = writer, activeWriter.width == frame.width, activeWriter.height == frame.height else { throw CaptureFailure(code: "mask_dimensions_changed", message: "Vision changed mask dimensions within a camera track.") }
                try await activeWriter.append(frame.sample, control: control)
                frames += 1; last = pts; end = CMTimeAdd(pts, sampleDuration)
                let now = ProcessInfo.processInfo.systemUptime
                if frames == 1 || now - lastProgress >= 0.1 {
                    ProtocolOutput.emit(Progress(phase: "segmenting", progress: min(0.95, 0.95 * end.seconds / duration.seconds), t: pts.seconds, frames: frames)); lastProgress = now
                }
            }
            try control.check()
            guard reader.status == .completed else { throw CaptureFailure(code: "video_decode_failed", message: "The camera decoder did not complete: \(reader.error?.localizedDescription ?? "")") }
            guard let activeWriter = writer, frames > 0, first.isNumeric, end.isNumeric else { throw CaptureFailure(code: "empty_video", message: "No camera frames were decoded.") }
            ProtocolOutput.emit(Progress(phase: "finalizing", progress: 0.95, t: end.seconds, frames: frames))
            try await activeWriter.finish(at: CMTimeSubtract(end, first))
            try control.check()
            guard try sourceFile.hash(control: control) == digest else { throw CaptureFailure(code: "source_changed", message: "The camera input changed during segmentation; no result was published.") }
            let manifest = CameraMaskManifest(
                source: .init(path: options.input.path, sha256: digest, width: Int(oriented.width.rounded()), height: Int(oriented.height.rounded()), duration: duration.seconds, orientation: orientation.rawValue),
                mask: .init(width: activeWriter.width, height: activeWriter.height),
                timing: .init(sourceTimeOrigin: first.seconds, firstPTS: CameraTime(first), lastPTS: CameraTime(last), sourceEnd: CameraTime(end), duration: CMTimeSubtract(end, first).seconds, frameCount: frames, finalDurationSource: finalDurationSource),
                settings: .init(quality: options.quality))
            try output.writeManifest(manifest)
            try output.publish(control: control)
            return Result(manifest: manifest, output: options.outputDirectory)
        } catch {
            writer?.cancel()
            let remaining = output.cleanup()
            if !remaining.isEmpty { throw CameraCleanupFailure(cause: error, ownedPaths: remaining) }
            throw error
        }
    }
}

@MainActor enum CameraSegmentationCommand {
    static func run(options: CameraSegmentationOptions) async -> Int32 {
        let control = CameraSegmentationControl()
        var signals: [DispatchSourceSignal] = []
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global(qos: .userInitiated))
            source.setEventHandler { control.cancel() }; source.resume(); signals.append(source)
        }
        defer { signals.forEach { $0.cancel() } }
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine() {
                if ["stop", "cancel"].contains(line.trimmingCharacters(in: .whitespacesAndNewlines)) { control.cancel(); return }
            }
            control.cancel()
        }
        do {
            let result = try await CameraSegmenter.run(options: options, control: control)
            struct Completed: Encodable { let type = "completed"; let outputDirectory: String; let maskPath: String; let manifestPath: String; let frames: Int; let duration: Double }
            ProtocolOutput.emit(Completed(outputDirectory: result.output.path, maskPath: result.output.appendingPathComponent("camera-mask.mp4").path, manifestPath: result.output.appendingPathComponent("manifest.json").path, frames: result.manifest.timing.frameCount, duration: result.manifest.timing.duration))
            return 0
        } catch {
            if let cleanup = error as? CameraCleanupFailure {
                struct CleanupError: Encodable { let type = "error"; let code = "segmentation_cleanup_failed"; let message: String; let ownedPaths: [String] }
                ProtocolOutput.emit(CleanupError(message: cleanup.localizedDescription, ownedPaths: cleanup.ownedPaths))
            } else if (error as? CaptureFailure)?.code == "segmentation_cancelled" {
                ProtocolOutput.emit(["type": "cancelled"]); return 130
            } else { ProtocolOutput.error(error) }
            return 1
        }
    }
}
