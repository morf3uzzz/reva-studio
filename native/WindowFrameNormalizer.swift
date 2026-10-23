import AVFoundation
import CoreVideo

/// H.264 has no alpha channel. Extend only the transparent outer window edges
/// before encoding so the editor can apply its own corner radius without a
/// white matte. The captured window's opaque pixels and timing stay unchanged.
/// Confined to Recorder's sample queue; never mutates ScreenCaptureKit's buffer.
final class WindowFrameNormalizer {
    private var pool: CVPixelBufferPool?
    private var size = CGSize.zero
    private(set) var droppedFrames = 0

    func sample(_ sample: CMSampleBuffer) throws -> CMSampleBuffer? {
        guard let input = CMSampleBufferGetImageBuffer(sample), CVPixelBufferGetPixelFormatType(input) == kCVPixelFormatType_32BGRA else {
            throw CaptureFailure(code: "invalid_window_frame", message: "The selected window returned an unsupported image.")
        }
        let width = CVPixelBufferGetWidth(input), height = CVPixelBufferGetHeight(input)
        guard CVPixelBufferLockBaseAddress(input, .readOnly) == kCVReturnSuccess else {
            throw CaptureFailure(code: "invalid_window_frame", message: "Cannot read the selected window image.")
        }
        defer { CVPixelBufferUnlockBaseAddress(input, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(input) else { return nil }
        let stride = CVPixelBufferGetBytesPerRow(input)
        var spans = [(Int, Int)]()
        spans.reserveCapacity(height)
        var needsFill = false, firstContentRow: Int?
        for y in 0..<height {
            let row = base.advanced(by: y * stride).assumingMemoryBound(to: UInt8.self)
            var left = 0, right = width - 1
            while left < width && row[left * 4 + 3] != 255 { left += 1 }
            while right >= left && row[right * 4 + 3] != 255 { right -= 1 }
            spans.append((left, right))
            if left <= right && firstContentRow == nil { firstContentRow = y }
            needsFill = needsFill || left != 0 || right != width - 1
        }
        guard needsFill else { return sample }
        // An entirely empty frame cannot establish a window's edge color.
        guard let firstContentRow else { droppedFrames += 1; return nil }
        if size != CGSize(width: width, height: height) {
            let attributes: [String: Any] = [kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
            guard CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary, &pool) == kCVReturnSuccess else {
                throw CaptureFailure(code: "window_frame_failed", message: "Cannot allocate the window frame pool.")
            }
            size = CGSize(width: width, height: height)
        }
        var output: CVPixelBuffer?
        let status = CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(kCFAllocatorDefault, pool!, [kCVPixelBufferPoolAllocationThresholdKey as String: 3] as CFDictionary, &output)
        if status == kCVReturnWouldExceedAllocationThreshold { droppedFrames += 1; return nil }
        guard status == kCVReturnSuccess, let output, CVPixelBufferLockBaseAddress(output, []) == kCVReturnSuccess else {
            throw CaptureFailure(code: "window_frame_failed", message: "Cannot allocate an opaque window frame (\(status)).")
        }
        defer { CVPixelBufferUnlockBaseAddress(output, []) }
        guard let target = CVPixelBufferGetBaseAddress(output) else { return nil }
        let targetStride = CVPixelBufferGetBytesPerRow(output)
        var nearestContentRow = firstContentRow
        for y in 0..<height {
            let row = base.advanced(by: y * stride).assumingMemoryBound(to: UInt32.self)
            let destination = target.advanced(by: y * targetStride).assumingMemoryBound(to: UInt32.self)
            memcpy(destination, row, width * 4)
            let (left, right) = spans[y]
            if left <= right {
                nearestContentRow = y
                for x in 0..<left { destination[x] = row[left] }
                if right + 1 < width { for x in (right + 1)..<width { destination[x] = row[right] } }
            } else {
                let reference = base.advanced(by: nearestContentRow * stride).assumingMemoryBound(to: UInt32.self)
                let (start, end) = spans[nearestContentRow]
                let color = reference[(start + end) / 2]
                for x in 0..<width { destination[x] = color }
            }
        }
        var description: CMVideoFormatDescription?, timing = CMSampleTimingInfo(), result: CMSampleBuffer?
        guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: output, formatDescriptionOut: &description) == noErr,
              CMSampleBufferGetSampleTimingInfo(sample, at: 0, timingInfoOut: &timing) == noErr,
              CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: output, formatDescription: description!, sampleTiming: &timing, sampleBufferOut: &result) == noErr else {
            throw CaptureFailure(code: "window_frame_failed", message: "Cannot preserve the selected window frame timing.")
        }
        return result
    }
}
