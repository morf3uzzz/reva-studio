import Foundation
@preconcurrency import AVFoundation
@preconcurrency import CoreML
import CoreImage
import CryptoKit
import ImageIO
import Darwin

struct SuperResolutionOptions {
    let input: URL; let model: URL; let outputDirectory: URL
    static func parse(_ arguments: [String]) throws -> SuperResolutionOptions {
        var values: [String: String] = [:], index = 0
        while index < arguments.count {
            let key = arguments[index]
            guard ["--input", "--model", "--output-directory"].contains(key), index + 1 < arguments.count, values[key] == nil else { throw CaptureFailure(code: "invalid_arguments", message: "Super-resolution received an unknown, duplicate, or incomplete option.") }
            values[key] = arguments[index + 1]; index += 2
        }
        func path(_ key: String) throws -> URL {
            guard let value = values[key], value.hasPrefix("/"), !value.utf8.contains(0) else { throw CaptureFailure(code: "invalid_arguments", message: "\(key) must be an absolute local path.") }; return URL(fileURLWithPath: value)
        }
        let value = try SuperResolutionOptions(input: path("--input"), model: path("--model"), outputDirectory: path("--output-directory"))
        var info = stat()
        guard stat(value.input.path, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { throw CaptureFailure(code: "input_unavailable", message: "Select an existing regular screen recording.") }
        guard lstat(value.model.path, &info) == 0, info.st_mode & S_IFMT != S_IFLNK, ["mlpackage", "mlmodel", "mlmodelc"].contains(value.model.pathExtension.lowercased()) else { throw CaptureFailure(code: "model_unavailable", message: "Select a local CoreML .mlpackage, .mlmodel, or .mlmodelc model.") }
        guard lstat(value.outputDirectory.path, &info) != 0, errno == ENOENT else { throw CaptureFailure(code: "output_exists", message: "Refusing to replace an existing enhancement output directory or symlink.") }
        return value
    }
}

final class SuperResolutionControl: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false, committed = false
    private var reader: AVAssetReader?
    func cancel() { lock.lock(); guard !committed else { lock.unlock(); return }; cancelled = true; let reader = reader; lock.unlock(); reader?.cancelReading() }
    func check() throws { lock.lock(); defer { lock.unlock() }; if cancelled { throw CaptureFailure(code: "upscale_cancelled", message: "Local super-resolution was cancelled.") } }
    // Writer transitions have one owner: the producing task. Cancellation stops
    // the reader and sets the flag, then finalization drains before cleanup.
    // Cancelling a writer concurrently with startWriting triggers an Objective-C
    // exception rather than a catchable Swift failure.
    func begin(reader: AVAssetReader, writer: AVAssetWriter) throws {
        lock.lock(); defer { lock.unlock() }
        if cancelled { throw CaptureFailure(code: "upscale_cancelled", message: "Local super-resolution was cancelled.") }
        guard writer.startWriting(), reader.startReading() else { throw writer.error ?? reader.error ?? CaptureFailure(code: "upscale_start_failed", message: "Cannot start local video enhancement.") }
        writer.startSession(atSourceTime: .zero); self.reader = reader
    }
    func releaseReader() { lock.lock(); reader = nil; lock.unlock() }
    func commit(_ operation: () throws -> Void) throws { lock.lock(); defer { lock.unlock() }; if cancelled { throw CaptureFailure(code: "upscale_cancelled", message: "Local super-resolution was cancelled.") }; try operation(); committed = true }
}

struct SuperResolutionSource: Encodable { let path: String; let sha256: String; let width: Int; let height: Int; let duration: Double }
struct SuperResolutionModel: Encodable {
    let path: String; let sha256: String; let name: String
    let inputName: String; let outputName: String
    let inputWidth: Int; let inputHeight: Int; let outputWidth: Int; let outputHeight: Int; let scale: Int; let overlap: Int
}
struct SuperResolutionManifest: Encodable {
    struct Video: Encodable { let file = "enhanced.mp4"; let codec = "h264"; let width: Int; let height: Int }
    struct Timing: Encodable { let firstPTS: Double; let lastPTS: Double; let endTime: Double; let duration: Double; let frames: Int; let preservesVariableFrameRate = true }
    let version = 1
    let source: SuperResolutionSource; let model: SuperResolutionModel; let video: Video; let timing: Timing
    let limitations = ["Local CoreML image-to-image inference with independent overlapping tile/stitch implementation; this is not the reference application's proprietary model.", "The derived H.264 video uses high-quality lossy compression and contains no audio. Preview and export retain audio from the original source.", "Only opaque RGB screen content and fixed image-input/image-output integer-scale CoreML models are supported."]
}

/// Fixed image-to-image model inference. Own code; no upstream inference source.
final class SuperResolutionTiles {
    let model: MLModel; let description: SuperResolutionModel
    private let input: CVPixelBuffer; private let normalizedOutput: CVPixelBuffer
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    init(model: MLModel, path: URL, digest: String) throws {
        self.model = model
        let inputs = model.modelDescription.inputDescriptionsByName, outputs = model.modelDescription.outputDescriptionsByName
        guard inputs.count == 1, outputs.count == 1, let first = inputs.first, first.value.type == .image, let source = first.value.imageConstraint,
              let last = outputs.first(where: { $0.value.type == .image }), let destination = last.value.imageConstraint else { throw CaptureFailure(code: "unsupported_upscale_model", message: "The CoreML model needs one image input and an image output.") }
        let width = source.pixelsWide, height = source.pixelsHigh, outWidth = destination.pixelsWide, outHeight = destination.pixelsHigh
        guard (32...512).contains(width), (32...512).contains(height), outWidth > width, outWidth <= width * 4, outHeight > height, outHeight <= height * 4, outWidth % width == 0, outHeight % height == 0, outWidth / width == outHeight / height else { throw CaptureFailure(code: "unsupported_upscale_model", message: "Use fixed 32…512-pixel image tiles and an equal integer 2×…4× image output scale.") }
        let overlap = min(16, min(width, height) / 8)
        description = SuperResolutionModel(path: path.path, sha256: digest, name: path.deletingPathExtension().lastPathComponent, inputName: first.key, outputName: last.key, inputWidth: width, inputHeight: height, outputWidth: outWidth, outputHeight: outHeight, scale: outWidth / width, overlap: overlap)
        input = try Self.buffer(width: width, height: height); normalizedOutput = try Self.buffer(width: outWidth, height: outHeight)
    }
    static func buffer(width: Int, height: Int) throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true, kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &buffer) == kCVReturnSuccess, let buffer else { throw CaptureFailure(code: "upscale_allocation_failed", message: "Cannot allocate a bounded super-resolution pixel buffer.") }; return buffer
    }
    func frame(_ source: CVPixelBuffer, orientation: CGImagePropertyOrientation, control: SuperResolutionControl) throws -> CVPixelBuffer {
        var orientedImage = CIImage(cvPixelBuffer: source).oriented(orientation)
        orientedImage = orientedImage.transformed(by: CGAffineTransform(translationX: -orientedImage.extent.minX, y: -orientedImage.extent.minY))
        let width = Int(orientedImage.extent.width), height = Int(orientedImage.extent.height), scale = description.scale
        let oriented = try Self.buffer(width: width, height: height), result = try Self.buffer(width: width * scale, height: height * scale)
        context.render(orientedImage, to: oriented, bounds: CGRect(x: 0, y: 0, width: width, height: height), colorSpace: colorSpace)
        CVPixelBufferLockBaseAddress(oriented, .readOnly); CVPixelBufferLockBaseAddress(result, [])
        defer { CVPixelBufferUnlockBaseAddress(oriented, .readOnly); CVPixelBufferUnlockBaseAddress(result, []) }
        guard let sourceBase = CVPixelBufferGetBaseAddress(oriented), let resultBase = CVPixelBufferGetBaseAddress(result) else { throw CaptureFailure(code: "upscale_pixels_unavailable", message: "Cannot access decoded enhancement pixels.") }
        let sourceStride = CVPixelBufferGetBytesPerRow(oriented), resultStride = CVPixelBufferGetBytesPerRow(result)
        let tileWidth = description.inputWidth, tileHeight = description.inputHeight, overlap = description.overlap
        let stepX = tileWidth - overlap * 2, stepY = tileHeight - overlap * 2
        for y in stride(from: 0, to: height, by: stepY) { for x in stride(from: 0, to: width, by: stepX) {
            try control.check()
            try autoreleasepool {
                CVPixelBufferLockBaseAddress(input, [])
                guard let base = CVPixelBufferGetBaseAddress(input) else { CVPixelBufferUnlockBaseAddress(input, []); throw CaptureFailure(code: "upscale_pixels_unavailable", message: "Cannot access a model input tile.") }
                let inputStride = CVPixelBufferGetBytesPerRow(input)
                for row in 0..<tileHeight { for column in 0..<tileWidth {
                    let sx = min(width - 1, max(0, x + column - overlap)), sy = min(height - 1, max(0, y + row - overlap))
                    let pixel = sourceBase.advanced(by: sy * sourceStride + sx * 4).assumingMemoryBound(to: UInt8.self)
                    guard pixel[3] == 255 else { CVPixelBufferUnlockBaseAddress(input, []); throw CaptureFailure(code: "unsupported_transparent_video", message: "This RGB enhancement model supports opaque screen recordings; transparent source pixels cannot be preserved by it.") }
                    memcpy(base.advanced(by: row * inputStride + column * 4), pixel, 4)
                } }
                CVPixelBufferUnlockBaseAddress(input, [])
                let features = try MLDictionaryFeatureProvider(dictionary: [description.inputName: MLFeatureValue(pixelBuffer: input)])
                let prediction = try model.prediction(from: features)
                try control.check()
                guard let tile = prediction.featureValue(for: description.outputName)?.imageBufferValue, CVPixelBufferGetWidth(tile) == description.outputWidth, CVPixelBufferGetHeight(tile) == description.outputHeight else { throw CaptureFailure(code: "invalid_model_output", message: "CoreML returned an unexpected image size or output type.") }
                context.render(CIImage(cvPixelBuffer: tile), to: normalizedOutput, bounds: CGRect(x: 0, y: 0, width: description.outputWidth, height: description.outputHeight), colorSpace: colorSpace)
                CVPixelBufferLockBaseAddress(normalizedOutput, .readOnly); defer { CVPixelBufferUnlockBaseAddress(normalizedOutput, .readOnly) }
                guard let output = CVPixelBufferGetBaseAddress(normalizedOutput) else { throw CaptureFailure(code: "upscale_pixels_unavailable", message: "Cannot read CoreML output pixels.") }
                let outputStride = CVPixelBufferGetBytesPerRow(normalizedOutput), copyWidth = min(stepX, width - x) * scale, copyHeight = min(stepY, height - y) * scale
                for row in 0..<copyHeight { memcpy(resultBase.advanced(by: (y * scale + row) * resultStride + x * scale * 4), output.advanced(by: (overlap * scale + row) * outputStride + overlap * scale * 4), copyWidth * 4) }
            }
        } }
        return result
    }
}

enum SuperResolutionEngine {
    static func digest(_ file: URL, control: SuperResolutionControl) throws -> String {
        let input = try FileHandle(forReadingFrom: file); defer { try? input.close() }; var hash = SHA256()
        while true { try control.check(); guard let bytes = try input.read(upToCount: 1024 * 1024), !bytes.isEmpty else { break }; hash.update(data: bytes) }; return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    static func modelDigest(_ model: URL, control: SuperResolutionControl) throws -> String {
        var directory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: model.path, isDirectory: &directory) else { throw CaptureFailure(code: "model_unavailable", message: "The selected local model is unavailable.") }
        if !directory.boolValue { return try digest(model, control: control) }
        guard let iterator = FileManager.default.enumerator(at: model, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey], options: []) else { throw CaptureFailure(code: "model_unavailable", message: "Cannot inspect the local model package.") }
        var files: [(String, URL, Int)] = [], total = 0
        for case let file as URL in iterator {
            try control.check(); let facts = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard facts.isSymbolicLink != true else { throw CaptureFailure(code: "invalid_model_package", message: "Model packages must not contain symlinks.") }
            if facts.isRegularFile == true { let size = facts.fileSize ?? 0; total += size; guard files.count < 20000, total <= 4 * 1024 * 1024 * 1024 else { throw CaptureFailure(code: "model_capacity", message: "The model exceeds the 20,000-file or 4 GiB resource budget.") }; files.append((String(file.path.dropFirst(model.path.count + 1)), file, size)) }
        }
        var hash = SHA256()
        for (relative, file, size) in files.sorted(by: { $0.0 < $1.0 }) { hash.update(data: Data("\(relative.utf8.count):\(relative):\(size):".utf8)); hash.update(data: Data(try digest(file, control: control).utf8)) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    static func run(options: SuperResolutionOptions, control: SuperResolutionControl) async throws {
        let manager = FileManager.default, asset = AVURLAsset(url: options.input)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw CaptureFailure(code: "video_unavailable", message: "No video track is available for enhancement.") }
        let natural = try await track.load(.naturalSize), transform = try await track.load(.preferredTransform), orientation = try CameraVideoGeometry.orientation(transform)
        try CameraVideoGeometry.validate(natural)
        let oriented = natural.applying(transform), width = Int(abs(oriented.width).rounded()), height = Int(abs(oriented.height).rounded()), duration = try await asset.load(.duration).seconds
        guard width > 0, height > 0, width * height <= 2_073_600, duration.isFinite, duration > 0, duration <= 86400 else { throw CaptureFailure(code: "upscale_input_capacity", message: "Local enhancement accepts opaque video up to 1080p (2,073,600 pixels) and 24 hours; the app's enhanced output is capped at 4K.") }
        // AVAssetReader can materialize empty edits as decoded black samples.
        // Segment target ranges are the owning source of real frame coverage.
        let segments = try await track.load(.segments)
        let mediaRanges = segments.filter { !$0.isEmpty }.map { $0.timeMapping.target }.sorted { $0.start.seconds < $1.start.seconds }
        guard !mediaRanges.isEmpty, mediaRanges.allSatisfy({ $0.start.seconds.isFinite && $0.duration.seconds.isFinite && $0.duration.seconds > 0 }) else { throw CaptureFailure(code: "invalid_upscale_timeline", message: "The video has no finite nonempty media segment.") }
        let sourceTimeScale = try await track.load(.naturalTimeScale)
        guard sourceTimeScale > 0 else { throw CaptureFailure(code: "invalid_upscale_timeline", message: "The source video does not expose a valid media time scale.") }
        let sourceHash = try digest(options.input, control: control), modelHash = try modelDigest(options.model, control: control)
        try control.check()
        try manager.createDirectory(at: options.outputDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        var directoryIdentity = stat(); guard lstat(options.outputDirectory.path, &directoryIdentity) == 0 else { throw CaptureFailure(code: "upscale_output_unavailable", message: "Cannot identify the newly created enhancement directory.") }
        var compiled: URL? = nil, writer: AVAssetWriter? = nil, reader: AVAssetReader? = nil
        func cleanupCompiled() throws { if let url = compiled { try manager.removeItem(at: url); compiled = nil } }
        do {
            let modelURL: URL
            if options.model.pathExtension.lowercased() == "mlmodelc" { modelURL = options.model } else { let url = try await MLModel.compileModel(at: options.model); compiled = url; modelURL = url }
            try control.check()
            let configuration = MLModelConfiguration(); configuration.computeUnits = .all
            let model = try MLModel(contentsOf: modelURL, configuration: configuration), tiles = try SuperResolutionTiles(model: model, path: options.model, digest: modelHash)
            let scale = tiles.description.scale, outputWidth = width * scale, outputHeight = height * scale
            guard max(outputWidth, outputHeight) <= 3840, min(outputWidth, outputHeight) <= 2160, outputWidth * outputHeight <= 8_294_400 else { throw CaptureFailure(code: "upscale_output_capacity", message: "This model scale exceeds the local 3840×2160 landscape/portrait output budget for the selected source.") }
            struct Ready: Encodable { let type = "ready"; let width: Int; let height: Int; let duration: Double; let scale: Int; let model: String }
            ProtocolOutput.emit(Ready(width: outputWidth, height: outputHeight, duration: duration, scale: scale, model: tiles.description.name))
            let videoURL = options.outputDirectory.appendingPathComponent("enhanced.mp4"), encoder = try AVAssetWriter(outputURL: videoURL, fileType: .mp4)
            encoder.movieTimeScale = sourceTimeScale
            writer = encoder
            let compression: [String: Any] = [AVVideoAverageBitRateKey: min(80_000_000, max(8_000_000, outputWidth * outputHeight * 8)), AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel, AVVideoAllowFrameReorderingKey: false, AVVideoMaxKeyFrameIntervalKey: 60]
            let settings: [String: Any] = [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: outputWidth, AVVideoHeightKey: outputHeight, AVVideoCompressionPropertiesKey: compression]
            guard encoder.canApply(outputSettings: settings, forMediaType: .video) else { throw CaptureFailure(code: "upscale_encoder_unavailable", message: "The local H.264 encoder cannot accept this enhanced video size.") }
            let destination = AVAssetWriterInput(mediaType: .video, outputSettings: settings); destination.expectsMediaDataInRealTime = false; destination.mediaTimeScale = sourceTimeScale
            guard encoder.canAdd(destination) else { throw CaptureFailure(code: "upscale_encoder_unavailable", message: "Cannot add the enhanced video stream.") }; encoder.add(destination)
            let decoder = try AVAssetReader(asset: asset); reader = decoder
            let source = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]); source.alwaysCopiesSampleData = false
            guard decoder.canAdd(source) else { throw CaptureFailure(code: "upscale_decoder_unavailable", message: "The source video cannot be decoded for local enhancement.") }; decoder.add(source)
            try control.begin(reader: decoder, writer: encoder)
            var frames = 0, firstPTS = 0.0, lastPTS = -1.0, endTime = 0.0, rangeIndex = 0
            var outputDescription: CMVideoFormatDescription? = nil
            struct Progress: Encodable { let type = "progress"; let progress: Double; let frames: Int }
            var current = source.copyNextSampleBuffer()
            while let sample = current {
                try control.check()
                // Some codecs omit decoded sample duration. Keep at most one
                // lookahead sample so the next real presentation time resolves
                // it without replacing variable timing with a nominal FPS.
                current = source.copyNextSampleBuffer()
                let pts = CMSampleBufferGetPresentationTimeStamp(sample), seconds = pts.seconds
                guard seconds.isFinite, seconds >= 0, seconds > lastPTS, let buffer = CMSampleBufferGetImageBuffer(sample) else { throw CaptureFailure(code: "invalid_video_timestamp", message: "Enhanced source frames must have finite, increasing original presentation times.") }
                while rangeIndex < mediaRanges.count && CMTimeCompare(pts, CMTimeRangeGetEnd(mediaRanges[rangeIndex])) >= 0 { rangeIndex += 1 }
                guard rangeIndex < mediaRanges.count else { CMSampleBufferInvalidate(sample); continue }
                guard CMTimeCompare(pts, mediaRanges[rangeIndex].start) >= 0 else { CMSampleBufferInvalidate(sample); continue }
                let enhanced = try tiles.frame(buffer, orientation: orientation, control: control)
                if outputDescription == nil { guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: enhanced, formatDescriptionOut: &outputDescription) == noErr else { throw CaptureFailure(code: "upscale_format_failed", message: "Cannot describe the enhanced pixels.") } }
                let rawDuration = CMSampleBufferGetDuration(sample), availableDuration = CMTimeSubtract(CMTimeMinimum(CMTimeRangeGetEnd(mediaRanges[rangeIndex]), CMTime(seconds: duration, preferredTimescale: sourceTimeScale)), pts)
                var sampleDuration = rawDuration
                if !sampleDuration.isNumeric || sampleDuration.seconds <= 0 { sampleDuration = current.map { CMTimeSubtract(CMSampleBufferGetPresentationTimeStamp($0), pts) } ?? availableDuration }
                guard sampleDuration.isNumeric, sampleDuration.seconds > 0, availableDuration.seconds > 0 else { throw CaptureFailure(code: "invalid_video_timestamp", message: "A real source frame does not expose a usable duration, following PTS, or track end.") }
                sampleDuration = CMTimeMinimum(sampleDuration, availableDuration)
                var timing = CMSampleTimingInfo(duration: sampleDuration, presentationTimeStamp: pts, decodeTimeStamp: .invalid), outputSample: CMSampleBuffer? = nil
                guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: enhanced, formatDescription: outputDescription!, sampleTiming: &timing, sampleBufferOut: &outputSample) == noErr, let outputSample else { throw CaptureFailure(code: "upscale_sample_failed", message: "Cannot package an enhanced video frame.") }
                let deadline = ProcessInfo.processInfo.systemUptime + 30
                while !destination.isReadyForMoreMediaData { try control.check(); guard encoder.status == .writing, ProcessInfo.processInfo.systemUptime < deadline else { throw encoder.error ?? CaptureFailure(code: "upscale_encoder_stalled", message: "The enhanced video encoder stopped accepting frames.") }; try await Task.sleep(nanoseconds: 2_000_000) }
                guard destination.append(outputSample) else { throw encoder.error ?? CaptureFailure(code: "upscale_encode_failed", message: "Cannot append the enhanced video frame.") }
                if frames == 0 { firstPTS = seconds }; frames += 1; lastPTS = seconds
                endTime = max(endTime, CMTimeAdd(pts, sampleDuration).seconds)
                ProtocolOutput.emit(Progress(progress: min(0.98, seconds / duration * 0.98), frames: frames))
                CMSampleBufferInvalidate(sample)
            }
            try control.check()
            guard decoder.status == .completed, frames > 0 else { throw decoder.error ?? CaptureFailure(code: "upscale_decode_failed", message: "The source video did not decode completely.") }
            endTime = max(endTime, duration); encoder.endSession(atSourceTime: CMTime(seconds: endTime, preferredTimescale: sourceTimeScale)); destination.markAsFinished()
            await withCheckedContinuation { continuation in encoder.finishWriting { continuation.resume() } }
            try control.check(); guard encoder.status == .completed else { throw encoder.error ?? CaptureFailure(code: "upscale_encode_failed", message: "The enhanced video did not finalize.") }
            control.releaseReader()
            guard try digest(options.input, control: control) == sourceHash, try modelDigest(options.model, control: control) == modelHash else { throw CaptureFailure(code: "source_changed", message: "The source recording or CoreML model changed during inference; no enhanced result was published.") }
            try cleanupCompiled(); try control.check()
            let manifest = SuperResolutionManifest(source: .init(path: options.input.path, sha256: sourceHash, width: width, height: height, duration: duration), model: tiles.description, video: .init(width: outputWidth, height: outputHeight), timing: .init(firstPTS: firstPTS, lastPTS: lastPTS, endTime: endTime, duration: duration, frames: frames))
            let data = try JSONEncoder().encode(manifest)
            try control.commit { try data.write(to: options.outputDirectory.appendingPathComponent("manifest.json"), options: .withoutOverwriting) }
            ProtocolOutput.emit(Progress(progress: 1, frames: frames))
        } catch {
            reader?.cancelReading()
            if let writer, writer.status == .writing || writer.status == .unknown { writer.cancelWriting() }
            control.releaseReader()
            var failures: [String] = []
            do { try cleanupCompiled() } catch { if let compiled { failures.append(compiled.path) } }
            var actual = stat()
            if lstat(options.outputDirectory.path, &actual) == 0, actual.st_dev == directoryIdentity.st_dev, actual.st_ino == directoryIdentity.st_ino, actual.st_mode & S_IFMT == S_IFDIR {
                do { try manager.removeItem(at: options.outputDirectory) } catch { failures.append(options.outputDirectory.path) }
            } else { failures.append(options.outputDirectory.path) }
            if !failures.isEmpty { throw CaptureFailure(code: "upscale_cleanup_failed", message: "Enhancement failed (\(error.localizedDescription)); owned paths still need cleanup: \(failures.joined(separator: ", ")).") }; throw error
        }
    }
}

@MainActor enum SuperResolutionCommand {
    static func run(options: SuperResolutionOptions) async -> Int32 {
        let control = SuperResolutionControl(); var signals: [DispatchSourceSignal] = []
        for number in [SIGINT, SIGTERM] { signal(number, SIG_IGN); let source = DispatchSource.makeSignalSource(signal: number, queue: .global(qos: .userInitiated)); source.setEventHandler { control.cancel() }; source.resume(); signals.append(source) }; defer { signals.forEach { $0.cancel() } }
        DispatchQueue.global(qos: .userInitiated).async { while let line = readLine() { if ["cancel", "stop"].contains(line.trimmingCharacters(in: .whitespacesAndNewlines)) { control.cancel(); return } }; control.cancel() }
        do {
            try await SuperResolutionEngine.run(options: options, control: control)
            struct Complete: Encodable { let type = "completed"; let output: String }; ProtocolOutput.emit(Complete(output: options.outputDirectory.path)); return 0
        } catch {
            if (error as? CaptureFailure)?.code != "upscale_cleanup_failed" { do { try control.check() } catch { ProtocolOutput.emit(["type": "cancelled"]); return 130 } }
            ProtocolOutput.error(error); return 1
        }
    }
}
