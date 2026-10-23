import Foundation
import AVFoundation
import AudioToolbox
import CoreImage
import ImageIO

struct InputLevelsEvent: Encodable {
    let type = "levels"
    let deviceID: String
    let rms: Double
    let peak: Double
}

struct CameraFrameEvent: Encodable {
    let type = "camera-frame"
    let deviceID: String
    let jpegBase64: String
    let width: Int
    let height: Int
}

struct InputErrorEvent: Encodable {
    let type = "error"
    let code: String
    let message: String
    let deviceID: String?
    let mediaType: String?
    let recoverable: Bool

    init(_ error: Error, deviceID: String? = nil, mediaType: String? = nil, recoverable: Bool) {
        let failure = error as? CaptureFailure
        code = failure?.code ?? "input_failed"
        message = failure?.message ?? CaptureFailure.describe(error)
        self.deviceID = deviceID; self.mediaType = mediaType; self.recoverable = recoverable
    }
}

enum InputSamples {
    /// Read the buffer's declared PCM layout once. Interleaved and planar Float32,
    /// Int16 and Int32 are supported; padding is not interpreted as audio samples.
    static func levels(_ sample: CMSampleBuffer, deviceID: String) throws -> InputLevelsEvent {
        guard sample.isValid, let description = CMSampleBufferGetFormatDescription(sample),
              let pointer = CMAudioFormatDescriptionGetStreamBasicDescription(description) else {
            throw CaptureFailure(code: "invalid_audio_sample", message: "The microphone returned an invalid audio sample.")
        }
        let format = pointer.pointee
        let channels = Int(format.mChannelsPerFrame), frames = CMSampleBufferGetNumSamples(sample)
        let floating = format.mFormatFlags & kAudioFormatFlagIsFloat != 0
        let planar = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let signed = format.mFormatFlags & kAudioFormatFlagIsSignedInteger != 0
        let bytes = Int(format.mBitsPerChannel / 8)
        guard format.mFormatID == kAudioFormatLinearPCM, format.mFormatFlags & kAudioFormatFlagIsBigEndian == 0,
              format.mFormatFlags & kAudioFormatFlagIsPacked != 0,
              channels > 0, channels <= 64, frames > 0, frames <= 1_048_576 / channels,
              (floating && format.mBitsPerChannel == 32) || (!floating && signed && [16, 32].contains(format.mBitsPerChannel)),
              Int(format.mBytesPerFrame) == bytes * (planar ? 1 : channels) else {
            throw CaptureFailure(code: "unsupported_audio_format", message: "The microphone's PCM layout is not supported for live metering.")
        }
        let expectedBuffers = planar ? channels : 1
        let maximumCapacity = MemoryLayout<AudioBufferList>.size + (expectedBuffers - 1) * MemoryLayout<AudioBuffer>.stride
        var needed = 0
        let queried = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: &needed,
            bufferListOut: nil, bufferListSize: 0, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: 0, blockBufferOut: nil)
        guard queried == noErr, needed >= MemoryLayout<AudioBufferList>.size, needed <= maximumCapacity else {
            throw CaptureFailure(code: "invalid_audio_sample", message: "The microphone's PCM buffer-list size does not match its declared layout (status \(queried), size \(needed)).")
        }
        let capacity = needed
        let memory = UnsafeMutableRawPointer.allocate(byteCount: capacity, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { memory.deallocate() }
        memory.initializeMemory(as: UInt8.self, repeating: 0, count: capacity)
        let list = memory.bindMemory(to: AudioBufferList.self, capacity: 1)
        list.pointee.mNumberBuffers = UInt32(expectedBuffers)
        var block: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: &needed,
            bufferListOut: list, bufferListSize: capacity, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment), blockBufferOut: &block)
        guard status == noErr, needed <= capacity else {
            throw CaptureFailure(code: "invalid_audio_sample", message: "The microphone's PCM buffers could not be read (status \(status), required \(needed), capacity \(capacity)).")
        }
        defer { withExtendedLifetime(block) {} }
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        guard buffers.count == (planar ? channels : 1) else {
            throw CaptureFailure(code: "invalid_audio_sample", message: "The microphone's PCM channel layout does not match its buffers.")
        }
        var squares = 0.0, peak = 0.0, count = 0
        for buffer in buffers {
            let bufferChannels = Int(buffer.mNumberChannels)
            let sampleCount = frames * bufferChannels
            guard bufferChannels == (planar ? 1 : channels), let data = buffer.mData,
                  Int(buffer.mDataByteSize) >= sampleCount * bytes else {
                throw CaptureFailure(code: "invalid_audio_sample", message: "The microphone's PCM buffer is shorter than its declared samples.")
            }
            for index in 0..<sampleCount {
                let raw = UnsafeRawPointer(data).advanced(by: index * bytes)
                let value: Double
                if floating { value = Double(raw.loadUnaligned(as: Float.self)) }
                else if bytes == 2 { value = Double(raw.loadUnaligned(as: Int16.self)) / 32768 }
                else { value = Double(raw.loadUnaligned(as: Int32.self)) / 2_147_483_648 }
                guard value.isFinite else { throw CaptureFailure(code: "invalid_audio_sample", message: "The microphone returned non-finite samples.") }
                squares += value * value; peak = max(peak, abs(value)); count += 1
            }
        }
        return InputLevelsEvent(deviceID: deviceID, rms: min(1, sqrt(squares / Double(count))), peak: min(1, peak))
    }

    static func cameraFrame(_ sample: CMSampleBuffer, deviceID: String, context: CIContext) throws -> CameraFrameEvent {
        guard sample.isValid, let pixels = CMSampleBufferGetImageBuffer(sample) else {
            throw CaptureFailure(code: "invalid_camera_frame", message: "The camera returned an invalid image.")
        }
        let input = CIImage(cvPixelBuffer: pixels)
        let scale = min(1, 360 / max(input.extent.width, input.extent.height))
        let width = max(1, Int((input.extent.width * scale).rounded(.down)))
        let height = max(1, Int((input.extent.height * scale).rounded(.down)))
        let image = input.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let rendered = context.createCGImage(image, from: CGRect(x: 0, y: 0, width: width, height: height)) else {
            throw CaptureFailure(code: "camera_preview_failed", message: "The camera preview could not be resized.")
        }
        let bytes = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(bytes, "public.jpeg" as CFString, 1, nil) else {
            throw CaptureFailure(code: "camera_preview_failed", message: "The camera preview JPEG encoder is unavailable.")
        }
        CGImageDestinationAddImage(destination, rendered, [kCGImageDestinationLossyCompressionQuality: 0.65] as CFDictionary)
        guard CGImageDestinationFinalize(destination), bytes.length <= 256 * 1024 else {
            throw CaptureFailure(code: "camera_preview_failed", message: "The camera preview exceeded its 256 KiB JPEG budget.")
        }
        return CameraFrameEvent(deviceID: deviceID, jpegBase64: (bytes as Data).base64EncodedString(), width: width, height: height)
    }
}

/// Capture delegates never wait for encoding or stdout. At most one camera image
/// and one sample per microphone are retained; a stalled consumer drops new work.
final class LiveInputOutput: @unchecked Sendable {
    // CMSampleBuffer is retained, never mutated, and inspected by one telemetry
    // queue. The capture writer may independently read the same immutable media.
    private struct PendingSample: @unchecked Sendable { let value: CMSampleBuffer }
    private let queue = DispatchQueue(label: "com.reva.studio.live-input", qos: .userInitiated)
    private var context: CIContext? // telemetry queue; no GPU context for meters-only use
    private let lock = NSLock()
    private var active = false
    private var finished = false
    private var preview: Bool
    private var microphoneLevels: Bool
    private var pendingCamera = false
    private var pendingMicrophones = Set<String>()
    private var nextCamera: UInt64 = 0
    private var nextLevels: [String: UInt64] = [:]
    private var reportedErrors = Set<String>() // queue-owned, one diagnostic per source
    private let onLevels: (InputLevelsEvent) -> Void
    private let onFrame: (CameraFrameEvent) -> Void
    private let onError: (InputErrorEvent) -> Void

    init(previewCamera: Bool, monitorMicrophone: Bool,
         onLevels: @escaping (InputLevelsEvent) -> Void = { ProtocolOutput.emit($0) },
         onFrame: @escaping (CameraFrameEvent) -> Void = { ProtocolOutput.emit($0) },
         onError: @escaping (InputErrorEvent) -> Void = { ProtocolOutput.emit($0) }) {
        preview = previewCamera; microphoneLevels = monitorMicrophone
        self.onLevels = onLevels; self.onFrame = onFrame; self.onError = onError
    }
    func activate() { lock.lock(); if !finished { active = true }; lock.unlock() }
    func setCameraPreview(_ enabled: Bool) { lock.lock(); preview = enabled; lock.unlock() }
    private func allows(_ camera: Bool) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return active && (camera ? preview : microphoneLevels)
    }
    func video(_ sample: CMSampleBuffer, deviceID: String) {
        lock.lock()
        let now = DispatchTime.now().uptimeNanoseconds
        guard active, preview, !pendingCamera, now >= nextCamera else { lock.unlock(); return }
        pendingCamera = true; nextCamera = now + 66_666_667; lock.unlock()
        let retained = PendingSample(value: sample)
        queue.async {
            defer { self.lock.lock(); self.pendingCamera = false; self.lock.unlock() }
            guard self.allows(true) else { return }
            autoreleasepool {
                do {
                    let context = self.context ?? CIContext(options: [.cacheIntermediates: false])
                    self.context = context
                    let event = try InputSamples.cameraFrame(retained.value, deviceID: deviceID, context: context)
                    if self.allows(true) { self.onFrame(event) }
                } catch { self.report(error, deviceID: deviceID, mediaType: "camera") }
            }
        }
    }
    func audio(_ sample: CMSampleBuffer, deviceID: String) {
        lock.lock()
        let now = DispatchTime.now().uptimeNanoseconds
        guard active, microphoneLevels, !pendingMicrophones.contains(deviceID), now >= (nextLevels[deviceID] ?? 0) else { lock.unlock(); return }
        pendingMicrophones.insert(deviceID); nextLevels[deviceID] = now + 50_000_000; lock.unlock()
        let retained = PendingSample(value: sample)
        queue.async {
            defer { self.lock.lock(); self.pendingMicrophones.remove(deviceID); self.lock.unlock() }
            guard self.allows(false) else { return }
            autoreleasepool {
                do {
                    let event = try InputSamples.levels(retained.value, deviceID: deviceID)
                    if self.allows(false) { self.onLevels(event) }
                } catch { self.report(error, deviceID: deviceID, mediaType: "microphone") }
            }
        }
    }
    private func report(_ error: Error, deviceID: String, mediaType: String) {
        guard allows(mediaType == "camera"), reportedErrors.insert(mediaType + deviceID).inserted else { return }
        onError(InputErrorEvent(error, deviceID: deviceID, mediaType: mediaType, recoverable: true))
    }
    private func deactivate() { lock.lock(); active = false; finished = true; lock.unlock() }
    func finish() async {
        deactivate()
        await withCheckedContinuation { continuation in queue.async { self.context = nil; continuation.resume() } }
    }
}
