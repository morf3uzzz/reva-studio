import Foundation
import AVFoundation
import AudioToolbox
import CoreMedia
import Darwin
import UniformTypeIdentifiers

/// Owns the actual destination bytes rather than AVAssetWriter's private staging
/// file. Every complete initialization/media segment is synchronized before the
/// next segment; partial tails remain removable without changing earlier data.
private final class CaptureFragmentOutput: NSObject, AVAssetWriterDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let handle: FileHandle
    private var failure: Error?
    private var closed = false

    init(url: URL) throws {
        let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw CaptureFailure(code: "media_output_failed", message: "Cannot create recording media: \(String(cString: strerror(errno)))") }
        handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }

    func assetWriter(_ writer: AVAssetWriter, didOutputSegmentData segmentData: Data, segmentType: AVAssetSegmentType) {
        lock.lock()
        defer { lock.unlock() }
        guard !closed, failure == nil else { return }
        do {
            try handle.write(contentsOf: segmentData)
            try handle.synchronize()
        } catch { failure = error }
    }

    func check() throws {
        lock.lock()
        defer { lock.unlock() }
        if let failure { throw CaptureFailure(code: "media_output_failed", message: "Cannot write recording media: \(failure.localizedDescription)") }
    }

    func close() throws {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return }
        if let failure { throw CaptureFailure(code: "media_output_failed", message: "Cannot finish recording media: \(failure.localizedDescription)") }
        try handle.synchronize()
        try handle.close()
        closed = true
    }
}

/// All calls except finish() are confined to Recorder's media queue.
final class MediaWriter {
    let url: URL
    private let writer: AVAssetWriter
    private let fragments: CaptureFragmentOutput
    private let video: AVAssetWriterInput?
    private let audio: AVAssetWriterInput?
    private var started = false
    private var lastVideo: CMSampleBuffer?
    private var lastVideoTime: CMTime = .invalid
    private(set) var firstVideoTime: CMTime?
    private(set) var videoFrames = 0
    private(set) var audioBuffers = 0
    private(set) var droppedVideoFrames = 0
    private(set) var droppedAudioBuffers = 0

    init(url: URL, width: Int? = nil, height: Int? = nil, fps: Int = 30, audioChannels: Int? = nil) throws {
        self.url = url
        fragments = try CaptureFragmentOutput(url: url)
        writer = AVAssetWriter(contentType: .mpeg4Movie)
        writer.outputFileTypeProfile = .mpeg4AppleHLS
        writer.preferredOutputSegmentInterval = CMTime(seconds: 2, preferredTimescale: 600)
        writer.initialSegmentStartTime = .zero
        writer.delegate = fragments
        if let width, let height {
            let settings: [String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: min(100_000_000, max(4_000_000, width * height * fps / 6)),
                    AVVideoExpectedSourceFrameRateKey: fps,
                    AVVideoMaxKeyFrameIntervalKey: fps * 2,
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                    AVVideoAllowFrameReorderingKey: false,
                ],
                AVVideoColorPropertiesKey: [
                    AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                    AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
                ],
            ]
            guard writer.canApply(outputSettings: settings, forMediaType: .video) else {
                throw CaptureFailure(code: "unsupported_dimensions", message: "The H.264 encoder cannot record \(width) × \(height). Select a smaller area.")
            }
            let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
            input.expectsMediaDataInRealTime = true
            guard writer.canAdd(input) else { throw CaptureFailure(code: "encoder_unavailable", message: "The video encoder could not be added.") }
            writer.add(input)
            video = input
        } else { video = nil }
        if let channels = audioChannels {
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: channels,
                AVEncoderBitRateKey: channels == 1 ? 128_000 : 192_000,
            ])
            input.expectsMediaDataInRealTime = true
            guard writer.canAdd(input) else { throw CaptureFailure(code: "encoder_unavailable", message: "The audio encoder could not be added.") }
            writer.add(input)
            audio = input
        } else { audio = nil }
    }

    func append(_ sample: CMSampleBuffer, video isVideo: Bool, sourceClock: CMClock?, timeline: RecordingTimeline) throws {
        guard CMSampleBufferDataIsReady(sample) else { return }
        let originalTime = CMSampleBufferGetPresentationTimeStamp(sample)
        func host(_ time: CMTime) -> CMTime { sourceClock.map { CMSyncConvertTime(time, from: $0, to: CMClockGetHostTimeClock()) } ?? time }
        let hostTime = host(originalTime)
        if isVideo {
            guard let relativeTime = timeline.sampleTime(at: hostTime) else { return }
            try appendMapped(sample, video: true, at: relativeTime)
            return
        }
        guard let description = CMSampleBufferGetFormatDescription(sample),
              let format = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee,
              format.mFormatID == kAudioFormatLinearPCM, format.mSampleRate > 0 else {
            throw CaptureFailure(code: "unsupported_audio_format", message: "Pause synchronization requires PCM capture audio.")
        }
        let count = CMSampleBufferGetNumSamples(sample)
        guard count > 0 else { return }
        guard count <= Int(Int32.max) else { throw CaptureFailure(code: "audio_buffer_too_large", message: "Capture audio exceeds the supported PCM frame count.") }
        let sampleStep = CMTime(seconds: 1 / format.mSampleRate, preferredTimescale: Int32(format.mSampleRate))
        let hostEnd = host(CMTimeAdd(originalTime, CMTimeMultiply(sampleStep, multiplier: Int32(count))))
        let hostDuration = CMTimeSubtract(hostEnd, hostTime).seconds
        guard hostDuration > 0 else { return }
        for range in timeline.activeRanges(from: hostTime, to: hostEnd) {
            // Keep complete PCM frames only; the boundary loss is less than one
            // audio frame. Never retain sound captured during a paused span.
            let first = max(0, min(count, Int((CMTimeSubtract(range.start, hostTime).seconds / hostDuration * Double(count) - 1e-7).rounded(.up))))
            let last = max(first, min(count, Int((CMTimeSubtract(CMTimeRangeGetEnd(range), hostTime).seconds / hostDuration * Double(count) + 1e-7).rounded(.down))))
            guard last > first else { continue }
            var part: CMSampleBuffer?
            if first == 0 && last == count { part = sample }
            else {
                part = try trimmedPCM(sample, from: first, count: last - first)
            }
            guard let part, let relativeTime = timeline.sampleTime(at: host(CMSampleBufferGetPresentationTimeStamp(part))) else { continue }
            try appendMapped(part, video: false, at: relativeTime)
        }
    }

    private func appendMapped(_ sample: CMSampleBuffer, video isVideo: Bool, at relativeTime: CMTime) throws {
        try fragments.check()
        guard let input = isVideo ? video : audio else { return }
        // A recovery checkpoint advances the written video clock to host time.
        // ScreenCaptureKit can subsequently deliver an older queued frame. The
        // encoder must never receive that frame (or duplicate presentation times).
        if isVideo, lastVideoTime.isNumeric, CMTimeCompare(relativeTime, lastVideoTime) <= 0 {
            droppedVideoFrames += 1
            return
        }
        if !started {
            guard writer.startWriting() else { throw failure("Could not start the media encoder.") }
            writer.startSession(atSourceTime: .zero)
            started = true
            // Apple's M4A writer removes an initial empty edit. Explicit PCM silence
            // keeps a microphone that starts late aligned with the screen timeline.
            if !isVideo, video == nil, CMTimeCompare(relativeTime, .zero) > 0,
               let silence = try initialSilence(duration: relativeTime, matching: sample) {
                guard input.append(silence) else { throw failure("Could not preserve the microphone's initial timing.") }
            }
        }
        guard writer.status == .writing else { throw failure("The media encoder stopped accepting samples.") }
        if !input.isReadyForMoreMediaData {
            if isVideo { droppedVideoFrames += 1 } else { droppedAudioBuffers += 1 }
            return
        }
        let copy = try retime(sample, to: relativeTime)
        guard input.append(copy) else { throw failure("Could not append a \(isVideo ? "video" : "audio") sample.") }
        if isVideo {
            if firstVideoTime == nil { firstVideoTime = relativeTime }
            lastVideo = copy
            lastVideoTime = relativeTime
            videoFrames += 1
        } else { audioBuffers += 1 }
    }

    /// Extends the last real image through idle desktop time without recording a new screen image.
    func checkpoint(at duration: CMTime) throws {
        guard started, let input = video, let lastVideo, input.isReadyForMoreMediaData, writer.status == .writing else { return }
        let timestamp = duration
        guard timestamp.isNumeric, CMTimeCompare(timestamp, lastVideoTime) > 0 else { return }
        guard input.append(try retime(lastVideo, to: timestamp)) else { throw failure("Could not checkpoint the current video frame.") }
        lastVideoTime = timestamp
    }

    /// Extends the last real image through idle desktop time without recording a new screen image.
    func end(at duration: CMTime, fps: Int) throws {
        guard started else { writer.cancelWriting(); try fragments.close(); return }
        defer {
            if writer.status == .writing {
                video?.markAsFinished()
                audio?.markAsFinished()
            }
            lastVideo = nil
        }
        guard writer.status == .writing else { throw failure("The encoder failed before finalization.") }
        if let input = video, let lastVideo, input.isReadyForMoreMediaData {
            let endTime = CMTimeSubtract(duration, CMTime(value: 1, timescale: Int32(fps)))
            if CMTimeCompare(endTime, lastVideoTime) > 0 {
                guard input.append(try retime(lastVideo, to: endTime)) else { throw failure("Could not finalize the last video frame.") }
            }
        }
        if duration.isNumeric, CMTimeCompare(duration, .zero) > 0 { writer.endSession(atSourceTime: duration) }
    }

    func finish() async throws {
        guard started else {
            throw CaptureFailure(code: "empty_track", message: "No media samples were received for \(url.lastPathComponent).")
        }
        guard writer.status == .writing else { throw failure("The encoder failed before the output could be finalized.") }
        await writer.finishWriting()
        try fragments.check()
        guard writer.status == .completed else { throw failure("Could not finish \(url.lastPathComponent).") }
        try fragments.close()
        if audio == nil, let firstVideoTime, CMTimeCompare(firstVideoTime, .zero) > 0 {
            try await preserveInitialVideoGap(firstVideoTime)
        }
    }

    /// Fragmented/HLS readers normalize the first video timestamp to zero. A
    /// late camera therefore needs an explicit empty edit in the completed file.
    /// Passthrough retains compressed samples; the recoverable source remains in
    /// place until the corrected file has completed and is atomically installed.
    private func preserveInitialVideoGap(_ gap: CMTime) async throws {
        let source = AVURLAsset(url: url)
        let tracks = try await source.loadTracks(withMediaType: .video)
        guard let track = tracks.first else { throw CaptureFailure(code: "camera_timing_failed", message: "The completed camera file has no video track.") }
        let range = try await track.load(.timeRange)
        let composition = AVMutableComposition()
        guard let destination = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw CaptureFailure(code: "camera_timing_failed", message: "Cannot preserve the camera's initial timing gap.")
        }
        try destination.insertTimeRange(range, of: track, at: gap)
        destination.preferredTransform = try await track.load(.preferredTransform)
        guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
            throw CaptureFailure(code: "camera_timing_failed", message: "Cannot create a lossless camera-timing finalizer.")
        }
        let temporary = url.deletingLastPathComponent().appendingPathComponent(".camera-timing-\(UUID().uuidString).mp4")
        export.outputURL = temporary; export.outputFileType = .mp4
        export.shouldOptimizeForNetworkUse = false
        do {
            await export.export()
            guard export.status == .completed else { throw CaptureFailure(code: "camera_timing_failed", message: export.error.map { CaptureFailure.describe($0) } ?? "Could not preserve camera timing.") }
            guard rename(temporary.path, url.path) == 0 else {
                throw CaptureFailure(code: "camera_timing_failed", message: "Cannot install finalized camera timing: \(String(cString: strerror(errno)))")
            }
        } catch {
            if FileManager.default.fileExists(atPath: temporary.path) {
                do { try FileManager.default.removeItem(at: temporary) }
                catch let cleanup { throw CaptureFailure(code: "camera_timing_cleanup_failed", message: "\(error.localizedDescription) Retained \(temporary.path): \(cleanup.localizedDescription)") }
            }
            throw error
        }
    }

    func cancel() { writer.cancelWriting(); lastVideo = nil }

    private func failure(_ fallback: String) -> CaptureFailure {
        CaptureFailure(code: "encoding_failed", message: writer.error.map { fallback + " " + CaptureFailure.describe($0) } ?? fallback)
    }

    private func initialSilence(duration: CMTime, matching sample: CMSampleBuffer) throws -> CMSampleBuffer? {
        guard let description = CMSampleBufferGetFormatDescription(sample),
              let stream = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee,
              stream.mFormatID == kAudioFormatLinearPCM, stream.mSampleRate > 0 else {
            throw CaptureFailure(code: "unsupported_audio_format", message: "Microphone timing requires uncompressed PCM capture samples.")
        }
        let frameCount = (duration.seconds * stream.mSampleRate).rounded(.down)
        if frameCount < 1 { return nil }
        let planes = stream.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0 ? stream.mChannelsPerFrame : 1
        let byteCount = frameCount * Double(stream.mBytesPerFrame) * Double(planes)
        guard frameCount.isFinite, frameCount <= Double(UInt32.max), byteCount.isFinite, byteCount <= 32 * 1024 * 1024 else {
            throw CaptureFailure(code: "audio_start_gap_too_large", message: "The microphone's initial timing gap exceeds the 32 MB silence buffer limit.")
        }
        let format = AVAudioFormat(cmAudioFormatDescription: description)
        guard let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frameCount)) else {
            throw CaptureFailure(code: "audio_allocation_failed", message: "Cannot allocate initial microphone silence.")
        }
        pcm.frameLength = AVAudioFrameCount(frameCount)
        for buffer in UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList) {
            if let address = buffer.mData { memset(address, 0, Int(buffer.mDataByteSize)) }
        }
        return try pcmSample(pcm, description: description, at: .zero)
    }

    private func trimmedPCM(_ sample: CMSampleBuffer, from first: Int, count: Int) throws -> CMSampleBuffer {
        guard let description = CMSampleBufferGetFormatDescription(sample), let format = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee else {
            throw CaptureFailure(code: "unsupported_audio_format", message: "Cannot describe captured PCM audio.")
        }
        let planes = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0 ? format.mChannelsPerFrame : 1
        let bytes = Double(count) * Double(format.mBytesPerFrame) * Double(planes)
        guard count <= Int(UInt32.max), bytes <= 32 * 1024 * 1024,
              let pcm = AVAudioPCMBuffer(pcmFormat: AVAudioFormat(cmAudioFormatDescription: description), frameCapacity: AVAudioFrameCount(count)) else {
            throw CaptureFailure(code: "audio_buffer_too_large", message: "Paused PCM trimming exceeds the 32 MiB audio buffer limit.")
        }
        pcm.frameLength = AVAudioFrameCount(count)
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: Int32(first), frameCount: Int32(count), into: pcm.mutableAudioBufferList)
        guard status == noErr else { throw CaptureFailure(code: "audio_timing_failed", message: "Cannot trim paused PCM audio (\(status)).") }
        let timestamp = CMTimeAdd(CMSampleBufferGetPresentationTimeStamp(sample), CMTime(value: Int64(first), timescale: Int32(format.mSampleRate)))
        return try pcmSample(pcm, description: description, at: timestamp)
    }

    private func pcmSample(_ pcm: AVAudioPCMBuffer, description: CMAudioFormatDescription, at timestamp: CMTime) throws -> CMSampleBuffer {
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: Int32(pcm.format.sampleRate)), presentationTimeStamp: timestamp, decodeTimeStamp: .invalid)
        var result: CMSampleBuffer?
        let createStatus = CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
                                               makeDataReadyCallback: nil, refcon: nil, formatDescription: description,
                                               sampleCount: Int(pcm.frameLength), sampleTimingEntryCount: 1, sampleTimingArray: &timing,
                                               sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &result)
        guard createStatus == noErr, let result else {
            throw CaptureFailure(code: "audio_timing_failed", message: "Cannot create synchronized PCM sample (\(createStatus)).")
        }
        let dataStatus = CMSampleBufferSetDataBufferFromAudioBufferList(result, blockBufferAllocator: kCFAllocatorDefault,
                                                                     blockBufferMemoryAllocator: kCFAllocatorDefault,
                                                                     flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
                                                                     bufferList: pcm.audioBufferList)
        guard dataStatus == noErr, CMSampleBufferSetDataReady(result) == noErr else {
            throw CaptureFailure(code: "audio_timing_failed", message: "Cannot attach synchronized PCM data (\(dataStatus)).")
        }
        return result
    }

    private func retime(_ sample: CMSampleBuffer, to timestamp: CMTime) throws -> CMSampleBuffer {
        var count = 0
        let queryStatus = CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count)
        guard queryStatus == noErr, count > 0 else {
            throw CaptureFailure(code: "invalid_sample_timing", message: "Capture sample has no timing information (\(queryStatus)).")
        }
        var timings = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: .invalid, decodeTimeStamp: .invalid), count: count)
        let status = CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: count, arrayToFill: &timings, entriesNeededOut: &count)
        guard status == noErr else { throw CaptureFailure(code: "invalid_sample_timing", message: "Cannot read sample timing (\(status)).") }
        let offset = CMTimeSubtract(timestamp, CMSampleBufferGetPresentationTimeStamp(sample))
        for index in timings.indices {
            timings[index].presentationTimeStamp = CMTimeAdd(timings[index].presentationTimeStamp, offset)
            if timings[index].decodeTimeStamp.isNumeric { timings[index].decodeTimeStamp = CMTimeAdd(timings[index].decodeTimeStamp, offset) }
        }
        var result: CMSampleBuffer?
        let copyStatus = CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: sample, sampleTimingEntryCount: count, sampleTimingArray: &timings, sampleBufferOut: &result)
        guard copyStatus == noErr, let result else {
            throw CaptureFailure(code: "invalid_sample_timing", message: "Cannot synchronize sample timing (\(copyStatus)).")
        }
        return result
    }
}

/// Incremental JSON avoids retaining a recording-length cursor history in memory.
final class CaptureJSONWriter<Value: Encodable> {
    private let handle: FileHandle
    private let encoder = JSONEncoder()
    private var buffer = Data()
    private var prefixLength: UInt64 = 1
    private var hasPoint = false
    private var closed = false

    init(url: URL) throws {
        let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw CaptureFailure(code: "cursor_output_failed", message: "Cannot create cursor file: \(String(cString: strerror(errno)))") }
        handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        try handle.write(contentsOf: Data("[]".utf8))
    }

    func append(_ point: Value) throws {
        guard !closed else { return }
        if hasPoint { buffer.append(0x2c) }
        buffer.append(try encoder.encode(point))
        hasPoint = true
        if buffer.count >= 4096 { try flush() }
    }

    func finish() throws {
        guard !closed else { return }
        _ = try checkpoint()
        try handle.close()
        closed = true
    }

    /// Recovery reads exactly this committed prefix, then supplies its own ']'.
    /// A later interrupted write cannot invalidate already checkpointed values.
    func checkpoint() throws -> UInt64 {
        guard !closed else { return prefixLength }
        try flush()
        try handle.synchronize()
        return prefixLength
    }

    private func flush() throws {
        guard !buffer.isEmpty else { return }
        try handle.seek(toOffset: prefixLength)
        try handle.write(contentsOf: buffer)
        prefixLength += UInt64(buffer.count)
        try handle.write(contentsOf: Data([0x5d]))
        buffer.removeAll(keepingCapacity: true)
    }
}

typealias CursorWriter = CaptureJSONWriter<CursorPoint>

enum RecordingActivity: Encodable {
    case pause(RecordingPause)
    case typing(RecordingTypingSample)
    case flag(RecordingFlag)
    case shortcut(RecordingShortcut)
    func encode(to encoder: Encoder) throws {
        switch self {
        case .pause(let value): try value.encode(to: encoder)
        case .typing(let value): try value.encode(to: encoder)
        case .flag(let value): try value.encode(to: encoder)
        case .shortcut(let value): try value.encode(to: encoder)
        }
    }
}
