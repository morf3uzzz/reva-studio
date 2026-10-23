import Foundation
import AVFoundation
import CoreImage
import CoreVideo

/// Confined to Recorder's sample queue. Native camera identity and timing remain
/// intact; only oversized/odd encoded image dimensions change.
final class CameraFrameScaler {
    private let maximumHeight: Int
    private var context: CIContext?
    private var pool: CVPixelBufferPool?
    private var size: (width: Int, height: Int)?
    private(set) var droppedFrames = 0
    init(maximumHeight: Int) { self.maximumHeight = maximumHeight }

    func sample(_ sample: CMSampleBuffer) throws -> CMSampleBuffer? {
        guard let input = CMSampleBufferGetImageBuffer(sample) else { throw CaptureFailure(code: "invalid_camera_frame", message: "The selected camera returned no image.") }
        let width = CVPixelBufferGetWidth(input), height = CVPixelBufferGetHeight(input)
        guard let output = CaptureDevices.encodedCameraSize(width: width, height: height, maximumHeight: maximumHeight) else {
            throw CaptureFailure(code: "camera_frame_too_large", message: "The selected camera frame exceeds the 16-megapixel capture limit.")
        }
        if output.width == width && output.height == height { return sample }
        if size?.width != output.width || size?.height != output.height {
            let attributes: [String: Any] = [kCVPixelBufferWidthKey as String: output.width, kCVPixelBufferHeightKey as String: output.height,
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
            guard CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary, &pool) == kCVReturnSuccess else {
                throw CaptureFailure(code: "camera_scaling_failed", message: "Cannot allocate the camera scaling pool.")
            }
            size = output
        }
        var pixels: CVPixelBuffer?
        let status = CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(kCFAllocatorDefault, pool!, [kCVPixelBufferPoolAllocationThresholdKey as String: 3] as CFDictionary, &pixels)
        if status == kCVReturnWouldExceedAllocationThreshold { droppedFrames += 1; return nil }
        guard status == kCVReturnSuccess, let pixels else { throw CaptureFailure(code: "camera_scaling_failed", message: "Cannot allocate a scaled camera frame (\(status)).") }
        let context = self.context ?? CIContext(options: [.cacheIntermediates: false])
        self.context = context
        let image = CIImage(cvPixelBuffer: input).transformed(by: CGAffineTransform(scaleX: Double(output.width) / Double(width), y: Double(output.height) / Double(height)))
        context.render(image, to: pixels, bounds: CGRect(x: 0, y: 0, width: output.width, height: output.height), colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
        var description: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels, formatDescriptionOut: &description) == noErr else {
            throw CaptureFailure(code: "camera_scaling_failed", message: "Cannot describe the scaled camera frame.")
        }
        var timing = CMSampleTimingInfo()
        guard CMSampleBufferGetSampleTimingInfo(sample, at: 0, timingInfoOut: &timing) == noErr else {
            throw CaptureFailure(code: "camera_scaling_failed", message: "Cannot preserve the camera frame timing.")
        }
        var result: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels, formatDescription: description!, sampleTiming: &timing, sampleBufferOut: &result) == noErr else {
            throw CaptureFailure(code: "camera_scaling_failed", message: "Cannot create the scaled camera sample.")
        }
        return result
    }
}
