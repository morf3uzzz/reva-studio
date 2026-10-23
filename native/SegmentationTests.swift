import Foundation
import AVFoundation
import CoreVideo
import Darwin

@main struct SegmentationTests {
    static func require(_ value: @autoclosure () -> Bool, _ message: String) throws {
        if !value() { throw CaptureFailure(code: "test_failed", message: message) }
    }
    static func fails(_ code: String, _ operation: () throws -> Void) throws {
        do { try operation(); throw CaptureFailure(code: "test_failed", message: "Expected \(code).") }
        catch let failure as CaptureFailure { try require(failure.code == code, "Expected \(code), got \(failure.code): \(failure.message)") }
    }
    static func main() async {
        do {
            guard CommandLine.arguments.count == 2 else { throw CaptureFailure(code: "invalid_arguments", message: "Supply a new test directory.") }
            let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try ownership(directory)
            try geometry()
            try await pixelsAndTiming(directory)
            print("Camera native semantics passed: options, 8 orientations, pixel conversion, VFR encoder, cancellation, collision, ownership replacement and cleanup retry.")
        } catch {
            try? FileHandle.standardError.write(contentsOf: Data("Camera native test failed: \(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }

    static func ownership(_ directory: URL) throws {
        let source = directory.appendingPathComponent("owned-input.bin")
        try Data("source identity".utf8).write(to: source, options: .withoutOverwriting)
        let target = directory.appendingPathComponent("result")
        let args = ["--input", source.path, "--output-directory", target.path]
        let options = try CameraSegmentationOptions.parse(args)
        try require(options.quality == "balanced" && options.input.path == source.path, "Options did not preserve input/default.")
        for bad in [["--quality", "fast"], ["--quality", "accurate", "--quality", "balanced"], ["--unknown", "1"]] {
            try fails("invalid_arguments") { _ = try CameraSegmentationOptions.parse(args + bad) }
        }
        let ownedSource = try CameraInputFile(url: source)
        let digest = try ownedSource.hash(control: CameraSegmentationControl())
        try require(digest.count == 64, "SHA256 missing.")
        let displaced = directory.appendingPathComponent("displaced-input.bin")
        try FileManager.default.moveItem(at: source, to: displaced)
        try Data("replacement".utf8).write(to: source, options: .withoutOverwriting)
        try fails("source_changed") { _ = try ownedSource.hash(control: CameraSegmentationControl()) }
        try FileManager.default.removeItem(at: source)
        try FileManager.default.moveItem(at: displaced, to: source)

        let early = CameraSegmentationControl(); early.cancel(); early.cancel()
        try fails("segmentation_cancelled") { try early.check() }
        var ran = false
        try fails("segmentation_cancelled") { try early.checked { ran = true } }
        try require(!ran, "A late ready was emitted after accepted cancellation.")
        let committed = CameraSegmentationControl()
        try committed.commit { ran = true }
        committed.cancel(); try committed.check()
        try require(ran, "Commit did not run.")

        let output = try CameraMaskOutput(target: target)
        try Data("malformed-but-owned".utf8).write(to: output.url("camera-mask.mp4"), options: .withoutOverwriting)
        try output.ownFile("camera-mask.mp4")
        try output.writeManifest(["version": 1])
        try fails("segmentation_cancelled") { try output.publish(control: early) }
        try require(!FileManager.default.fileExists(atPath: target.path), "Cancelled finalization published a result.")

        let original = output.url("camera-mask.mp4")
        let saved = output.temporary.appendingPathComponent("held-original")
        try FileManager.default.moveItem(at: original, to: saved)
        try Data("foreign".utf8).write(to: original, options: .withoutOverwriting)
        try require(!output.cleanup().isEmpty, "Cleanup lost ownership after child replacement.")
        let foreign = try Data(contentsOf: original)
        try require(foreign == Data("foreign".utf8), "Cleanup removed a foreign replacement.")
        try FileManager.default.removeItem(at: original)
        try FileManager.default.moveItem(at: saved, to: original)
        try require(output.cleanup().isEmpty, "Cleanup could not retry its retained child identity.")

        let movedOutput = try CameraMaskOutput(target: directory.appendingPathComponent("moved-result"))
        let moved = directory.appendingPathComponent("held-directory")
        try FileManager.default.moveItem(at: movedOutput.temporary, to: moved)
        try FileManager.default.createDirectory(at: movedOutput.temporary, withIntermediateDirectories: false)
        let foreignChild = movedOutput.temporary.appendingPathComponent("foreign.txt")
        try Data("keep".utf8).write(to: foreignChild)
        try require(!movedOutput.cleanup().isEmpty && FileManager.default.fileExists(atPath: foreignChild.path), "Cleanup deleted a replaced directory.")
        try FileManager.default.removeItem(at: movedOutput.temporary)
        try FileManager.default.moveItem(at: moved, to: movedOutput.temporary)
        try require(movedOutput.cleanup().isEmpty, "Directory identity cleanup retry failed.")

        let collision = try CameraMaskOutput(target: target)
        try Data("owned".utf8).write(to: collision.url("camera-mask.mp4")); try collision.ownFile("camera-mask.mp4")
        try collision.writeManifest(["version": 1])
        try Data("foreign output".utf8).write(to: target, options: .withoutOverwriting)
        try fails("output_exists") { try collision.publish(control: CameraSegmentationControl()) }
        try require(collision.cleanup().isEmpty, "Collision cleanup leaked owned temporary directory.")
        let preserved = try Data(contentsOf: target)
        try require(preserved == Data("foreign output".utf8), "Publication replaced a pre-existing destination.")
        try fails("output_exists") { _ = try CameraSegmentationOptions.parse(args) }
        try FileManager.default.removeItem(at: target)
        try FileManager.default.createSymbolicLink(at: target, withDestinationURL: directory.appendingPathComponent("missing"))
        try fails("output_exists") { _ = try CameraSegmentationOptions.parse(args) }
        try FileManager.default.removeItem(at: target)

        let success = try CameraMaskOutput(target: target)
        try Data("encoded-owned".utf8).write(to: success.url("camera-mask.mp4")); try success.ownFile("camera-mask.mp4")
        try success.writeManifest(["version": 1]); let finalControl = CameraSegmentationControl()
        try success.publish(control: finalControl); finalControl.cancel()
        try require(success.published && success.cleanup().isEmpty, "Published ownership was not released.")
        try require(FileManager.default.fileExists(atPath: target.appendingPathComponent("camera-mask.mp4").path), "Late cancellation removed committed artifacts.")
        try FileManager.default.removeItem(at: target)
    }

    static func geometry() throws {
        let transforms: [(CGAffineTransform, UInt32)] = [
            (.identity, 1), (.init(a: 0,b: 1,c: -1,d: 0,tx: 1080,ty: 0), 6),
            (.init(a: -1,b: 0,c: 0,d: -1,tx: 1920,ty: 1080), 3), (.init(a: 0,b: -1,c: 1,d: 0,tx: 0,ty: 1920), 8),
            (.init(a: -1,b: 0,c: 0,d: 1,tx: 1920,ty: 0), 2), (.init(a: 1,b: 0,c: 0,d: -1,tx: 0,ty: 1080), 4),
            (.init(a: 0,b: 1,c: 1,d: 0,tx: 0,ty: 0), 5), (.init(a: 0,b: -1,c: -1,d: 0,tx: 1080,ty: 1920), 7),
        ]
        for (transform, expected) in transforms { let value = try CameraVideoGeometry.orientation(transform); try require(value.rawValue == expected, "Orientation mapping changed.") }
        try fails("unsupported_video_transform") { _ = try CameraVideoGeometry.orientation(.init(scaleX: 2,y: 1)) }
        try fails("segmentation_input_limit") { try CameraVideoGeometry.validate(.init(width: 8192,height: 8192)) }
    }

    static func mask(width: Int, height: Int) throws -> CVPixelBuffer {
        var pixels: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_OneComponent8, nil, &pixels) == kCVReturnSuccess, let pixels else { throw CaptureFailure(code: "fixture_failed", message: "Cannot create test matte.") }
        CVPixelBufferLockBaseAddress(pixels, [])
        defer { CVPixelBufferUnlockBaseAddress(pixels, []) }
        let base = CVPixelBufferGetBaseAddress(pixels)!.assumingMemoryBound(to: UInt8.self)
        let row = CVPixelBufferGetBytesPerRow(pixels)
        for y in 0..<height { for x in 0..<width { base[y * row + x] = UInt8(x * 255 / (width - 1)) } }
        return pixels
    }

    static func pixelsAndTiming(_ directory: URL) async throws {
        let odd = try CameraSegmentationPixels.sample(mask: mask(width: 5,height: 3), at: .zero, duration: CMTime(value: 1,timescale: 30))
        try require(odd.width == 6 && odd.height == 4, "Odd matte dimensions did not map to even encoder dimensions.")
        let image = CMSampleBufferGetImageBuffer(odd.sample)!
        CVPixelBufferLockBaseAddress(image, .readOnly)
        let data = CVPixelBufferGetBaseAddress(image)!.assumingMemoryBound(to: UInt8.self)
        try require(data[0] == 0 && data[3] == 255 && data[20] == 255 && data[23] == 255, "Matte RGB/alpha conversion failed.")
        CVPixelBufferUnlockBaseAddress(image, .readOnly)

        let source = directory.appendingPathComponent("synthetic-vfr.mp4")
        let writer = try CameraMaskWriter(url: source, width: 320,height: 180,frameRate: 30)
        let times = [0.0, 0.1, 0.35], durations = [0.1, 0.25, 0.15]
        for index in times.indices {
            let frame = try CameraSegmentationPixels.sample(mask: mask(width: 320,height: 180), at: CMTime(seconds: times[index],preferredTimescale: 60000), duration: CMTime(seconds: durations[index],preferredTimescale: 60000))
            try await writer.append(frame.sample, control: CameraSegmentationControl())
        }
        try await writer.finish(at: CMTime(seconds: 0.5,preferredTimescale: 60000))
        let asset = AVURLAsset(url: source)
        let track = try await asset.loadTracks(withMediaType: .video)[0]
        let duration = try await asset.load(.duration)
        try require(abs(duration.seconds - 0.5) < 0.0001, "Encoder lost final frame duration.")
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track,outputSettings: [kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA])
        reader.add(output); try require(reader.startReading(), "Cannot read encoded timing fixture.")
        var index = 0
        while let sample = output.copyNextSampleBuffer() {
            try require(index < times.count && abs(CMSampleBufferGetPresentationTimeStamp(sample).seconds - times[index]) < 0.0001, "Variable frame timestamp was not preserved.")
            if index == 0 {
                let pixel = CMSampleBufferGetImageBuffer(sample)!
                CVPixelBufferLockBaseAddress(pixel,.readOnly)
                let bytes = CVPixelBufferGetBaseAddress(pixel)!.assumingMemoryBound(to:UInt8.self)
                try require(bytes[2] <= 3 && bytes[(319 * 4) + 2] >= 252, "H.264 decoded matte black/white levels changed.")
                CVPixelBufferUnlockBaseAddress(pixel,.readOnly)
            }
            index += 1
        }
        try require(index == 3 && reader.status == .completed, "VFR fixture did not decode completely.")

        let delayed = try CameraMaskWriter(url: directory.appendingPathComponent("synthetic-nonzero.mp4"), width: 320,height: 180,frameRate: 30)
        for index in times.indices {
            let frame = try CameraSegmentationPixels.sample(mask: mask(width: 320,height: 180), at: CMTime(seconds: times[index] + 2,preferredTimescale: 60000), duration: CMTime(seconds: durations[index],preferredTimescale: 60000))
            try await delayed.append(frame.sample, control: CameraSegmentationControl())
        }
        try await delayed.finish(at: CMTime(seconds: 2.5,preferredTimescale: 60000))
    }
}
