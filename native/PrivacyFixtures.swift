import Foundation
@preconcurrency import AVFoundation
import CoreVideo
import CoreText

@main struct PrivacyFixtures {
    static func main() async {
        do {
            guard CommandLine.arguments.count == 2 else { throw CaptureFailure(code: "fixture_arguments", message: "Pass an output directory.") }
            let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let normal = directory.appendingPathComponent("synthetic-privacy.mp4")
            let writer = try MediaWriter(url: normal, width: 1280, height: 800, fps: 30)
            for index in 0..<6 {
                try writer.append(frame(at: Double(index) * 0.5), video: true, sourceClock: nil, timeline: RecordingTimeline(anchor: .zero))
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            try writer.end(at: CMTime(seconds: 3, preferredTimescale: 30), fps: 30)
            try await writer.finish()
            let source = AVURLAsset(url: normal)
            let track = try await source.loadTracks(withMediaType: .video)[0]
            let composition = AVMutableComposition()
            let destination = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
            try destination.insertTimeRange(CMTimeRange(start: .zero, duration: CMTime(seconds: 3, preferredTimescale: 30)), of: track, at: .zero)
            destination.preferredTransform = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 800, ty: 0)
            let rotated = directory.appendingPathComponent("synthetic-privacy-rotated.mov")
            let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough)!
            if #available(macOS 15, *) {
                try await exporter.export(to: rotated, as: .mov)
            } else {
                exporter.outputURL = rotated
                exporter.outputFileType = .mov
                await withCheckedContinuation { continuation in
                    exporter.exportAsynchronously { continuation.resume() }
                }
                guard exporter.status == .completed else { throw exporter.error ?? CaptureFailure(code: "fixture_export_failed", message: "Cannot export rotated fixture.") }
            }
            print("Created synthetic privacy fixtures: \(normal.path), \(rotated.path)")
        } catch {
            try? FileHandle.standardError.write(contentsOf: Data("Privacy fixture failed: \(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }

    private static func frame(at seconds: Double) throws -> CMSampleBuffer {
        var buffer: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, 1280, 800, kCVPixelFormatType_32BGRA,
                                 [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary, &buffer) == kCVReturnSuccess,
              let buffer else { throw CaptureFailure(code: "fixture_allocation_failed", message: "Cannot allocate fixture pixels.") }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: 1280, height: 800, bitsPerComponent: 8,
                                      bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue) else {
            throw CaptureFailure(code: "fixture_context_failed", message: "Cannot draw synthetic fixture.")
        }
        context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 1280, height: 800))
        let font = CTFontCreateWithName("Menlo" as CFString, 36, nil)
        let lines = ["LOCAL SYNTHETIC PRIVACY TEST", "alex@example.test", "+1 (202) 555-0147", "4242 4242 4242 4242", "api_key: sk_test_1234567890abcdefghijklmnop", "Nothing sensitive on this line"]
        for (index, value) in lines.enumerated() {
            let attributes: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String): font,
                                                            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1)]
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: value, attributes: attributes))
            context.textPosition = CGPoint(x: 55, y: 700 - index * 110)
            CTLineDraw(line, context)
        }
        var description: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescriptionOut: &description) == noErr,
              let description else { throw CaptureFailure(code: "fixture_format_failed", message: "Cannot describe fixture pixels.") }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30), presentationTimeStamp: CMTime(seconds: seconds, preferredTimescale: 30), decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescription: description, sampleTiming: &timing, sampleBufferOut: &sample) == noErr,
              let sample else { throw CaptureFailure(code: "fixture_sample_failed", message: "Cannot create fixture sample.") }
        return sample
    }
}
