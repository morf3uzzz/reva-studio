import AVFoundation
import CoreImage
import CoreVideo

/// Fixed encoded dimensions preserve one continuous device track when its input
/// rotates or changes format. The complete screen is fitted, never stretched.
final class ConnectedScreenFrameScaler {
    private let width: Int
    private let height: Int
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var pool: CVPixelBufferPool?
    private(set) var droppedFrames = 0

    init(width: Int, height: Int) throws {
        self.width = width; self.height = height
        let attributes: [String: Any] = [kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
                                       kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        guard CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary, &pool) == kCVReturnSuccess else {
            throw CaptureFailure(code: "device_scaling_failed", message: "Cannot allocate connected-device video buffers.")
        }
    }

    func sample(_ sample: CMSampleBuffer) throws -> CMSampleBuffer? {
        guard let input = CMSampleBufferGetImageBuffer(sample) else { throw CaptureFailure(code: "invalid_device_frame", message: "The connected device returned a frame without an image.") }
        let inputWidth = CVPixelBufferGetWidth(input), inputHeight = CVPixelBufferGetHeight(input)
        if inputWidth == width && inputHeight == height { return sample }
        guard inputWidth >= 2, inputHeight >= 2, inputWidth <= 16384, inputHeight <= 16384, inputWidth * inputHeight <= 33_554_432 else {
            throw CaptureFailure(code: "device_frame_too_large", message: "The connected-device image exceeds the supported capture dimensions.")
        }
        var pixels: CVPixelBuffer?
        let status = CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(kCFAllocatorDefault, pool!, [kCVPixelBufferPoolAllocationThresholdKey as String: 3] as CFDictionary, &pixels)
        if status == kCVReturnWouldExceedAllocationThreshold { droppedFrames += 1; return nil }
        guard status == kCVReturnSuccess, let pixels else { throw CaptureFailure(code: "device_scaling_failed", message: "Cannot allocate a connected-device frame (\(status)).") }
        let scale = min(Double(width) / Double(inputWidth), Double(height) / Double(inputHeight))
        let image = CIImage(cvPixelBuffer: input).transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            .transformed(by: CGAffineTransform(translationX: (Double(width) - Double(inputWidth) * scale) / 2, y: (Double(height) - Double(inputHeight) * scale) / 2))
        let bounds = CGRect(x: 0, y: 0, width: width, height: height)
        let fitted = image.composited(over: CIImage(color: .black).cropped(to: bounds))
        context.render(fitted, to: pixels, bounds: bounds, colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
        var description: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels, formatDescriptionOut: &description) == noErr else {
            throw CaptureFailure(code: "device_scaling_failed", message: "Cannot describe a connected-device frame.")
        }
        var timing = CMSampleTimingInfo()
        guard CMSampleBufferGetSampleTimingInfo(sample, at: 0, timingInfoOut: &timing) == noErr else {
            throw CaptureFailure(code: "device_scaling_failed", message: "Cannot preserve connected-device frame timing.")
        }
        var result: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels, formatDescription: description!, sampleTiming: &timing, sampleBufferOut: &result) == noErr else {
            throw CaptureFailure(code: "device_scaling_failed", message: "Cannot create the connected-device sample.")
        }
        return result
    }
}
