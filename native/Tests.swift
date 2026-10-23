import Foundation
import AVFoundation
import CoreVideo
import AudioToolbox
import CoreImage
import ImageIO

@main struct NativeTests {
    static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw CaptureFailure(code: "test_failed", message: message) }
    }

    static func expectFailure(_ code: String, _ operation: () throws -> Void) throws {
        do {
            try operation()
            throw CaptureFailure(code: "test_failed", message: "Expected \(code).")
        } catch let failure as CaptureFailure {
            try require(failure.code == code, "Expected \(code), received \(failure.code): \(failure.message)")
        }
    }

    static func main() async {
        do {
            if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--recovery-fixture" {
                try await interruptedFixture(directory: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true))
            } else { try await run() }
        }
        catch {
            let message = "Native tests failed: \(error.localizedDescription)\nIf AVAssetWriter cannot add AAC audio, run this synthetic-only test with access to macOS codec services outside the agent sandbox.\n"
            try? FileHandle.standardError.write(contentsOf: Data(message.utf8))
            exit(1)
        }
    }

    static func run() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("reva-native-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let output = directory.appendingPathComponent("capture.mp4")
        let cursor = directory.appendingPathComponent("cursor.json")
        let arguments = ["--source", "display:7", "--output", output.path, "--cursor-output", cursor.path]
        let options = try CaptureOptions.parse(arguments + ["--fps", "60", "--camera", "true", "--area", "10,20,400,300"])
        try require(options.fps == 60 && options.camera && !options.microphone, "Selected flags were not preserved.")
        try require(options.cameraOutput.lastPathComponent == "capture.camera.mp4", "Camera output is not adjacent to the recording.")
        try require(options.cameraMaxResolution == 1080 && options.cameraDeviceID == nil && options.microphoneDeviceID == nil && options.excludedProcessID == nil, "Default device selection changed.")
        let selected = try CaptureOptions.parse(arguments + ["--camera-device-id", "camera:opaque/ ID", "--microphone-device-id", "mic:opaque/ ID", "--camera-max-resolution", "2160", "--exclude-process-id", "4321"])
        try require(selected.cameraDeviceID == "camera:opaque/ ID" && selected.microphoneDeviceID == "mic:opaque/ ID" && selected.cameraMaxResolution == 2160 && selected.excludedProcessID == 4321, "Explicit device identities, resolution, or excluded process were not preserved.")
        for invalid in [["--camera-max-resolution", "480"], ["--camera-device-id", ""], ["--microphone-device-id", "bad\0id"], ["--exclude-process-id", "0"], ["--exclude-process-id", "-1"], ["--exclude-process-id", "2147483648"], ["--camera-device-id", "a", "--camera-device-id", "b"]] {
            try expectFailure("invalid_arguments") { _ = try CaptureOptions.parse(arguments + invalid) }
        }
        let nativeFailure = NSError(domain: AVFoundationErrorDomain, code: -11800, userInfo: [NSLocalizedDescriptionKey: "The operation could not be completed", NSUnderlyingErrorKey: NSError(domain: NSOSStatusErrorDomain, code: -16364)])
        let nativeMessage = CaptureFailure.describe(nativeFailure)
        try require(nativeMessage.contains("AVFoundationErrorDomain -11800") && nativeMessage.contains("NSOSStatusErrorDomain -16364"), "The capture protocol lost the native failure identity.")
        try await checkCheckpointOrdering(directory: directory)
        try await checkWindowCorners(directory: directory)
        try checkCameraFormatSelection()
        try await checkCameraScaling(directory: directory)
        try await checkRecordingExtensions(directory: directory)
        try await checkLiveInputs(arguments: arguments)
        let privateOutput = "/private/var/tmp/reva-caller-path-\(UUID().uuidString).mp4"
        let privateOptions = try CaptureOptions.parse(["--source", "display:7", "--output", privateOutput, "--cursor-output", privateOutput + ".json"])
        try require(privateOptions.output.path == privateOutput && privateOptions.cursorOutput.path == privateOutput + ".json", "Caller paths were rewritten in the process protocol.")
        try expectFailure("invalid_arguments") { _ = try CaptureOptions.parse(arguments + ["--fps", "0"]) }
        try expectFailure("invalid_arguments") { _ = try CaptureOptions.parse(arguments + ["--camera", "yes"]) }
        try expectFailure("invalid_arguments") { _ = try CaptureOptions.parse(arguments + ["--fps", "30", "--fps", "60"]) }
        try expectFailure("invalid_arguments") { _ = try CaptureOptions.parse(arguments + ["--area", "nan,0,1,1"]) }
        try expectFailure("invalid_arguments") { _ = try CaptureOptions.parse(arguments + ["--unknown", "true"]) }
        try expectFailure("invalid_arguments") { _ = try CaptureOptions.parse(["--source", "window:0", "--output", output.path, "--cursor-output", cursor.path]) }
        try expectFailure("invalid_arguments") { _ = try CaptureOptions.parse(["--source", "display:1", "--output", output.path, "--cursor-output", output.path]) }
        let cancelled = CaptureCancellation()
        try cancelled.check()
        cancelled.cancel()
        cancelled.cancel()
        try expectFailure("recording_cancelled") { try cancelled.check() }
        try expectFailure("invalid_area") { _ = try CaptureGeometry.crop(CGRect(x: 90, y: 0, width: 20, height: 20), sourceSize: CGSize(width: 100, height: 100)) }
        let pixelWidth = try CaptureGeometry.pixels(101.75, scale: 2)
        try require(pixelWidth == 202, "Encoder dimensions were not rounded to even pixels.")
        let point = CaptureGeometry.cursor(point: CGPoint(x: -800, y: 150), bounds: CGRect(x: -1000, y: 50, width: 400, height: 200), t: 2, pressed: true)
        try require(point.x == 0.5 && point.y == 0.5 && point.click && point.visible, "Cursor coordinates failed on a display with negative origin.")
        let outside = CaptureGeometry.cursor(point: CGPoint(x: 500, y: 300), bounds: CGRect(x: 0, y: 0, width: 400, height: 200), t: 3, pressed: true)
        try require(outside.x == 1 && outside.y == 1 && !outside.click && !outside.visible, "An outside click was attributed to the selected source.")
        let inset = CaptureGeometry.cursor(point: CGPoint(x: 50, y: 50), bounds: CGRect(x: 0, y: 0, width: 100, height: 100), destination: CGRect(x: 0.25, y: 0, width: 0.5, height: 1), t: 0, pressed: false)
        try require(inset.x == 0.5 && inset.y == 0.5, "Content inset was not applied.")
        let cursorWriter = try CursorWriter(url: cursor)
        try cursorWriter.append(point)
        try cursorWriter.append(outside)
        try cursorWriter.finish()
        try cursorWriter.finish()
        let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: cursor)) as? [[String: Any]]
        try require(saved?.count == 2 && saved?[1]["visible"] as? Bool == false, "Cursor JSON was not finalized correctly.")
        try expectFailure("output_exists") { _ = try CaptureOptions.parse(arguments) }
        try expectFailure("cursor_output_failed") { _ = try CursorWriter(url: cursor) }

        // Synthetic video/audio exercises the actual AVAssetWriter and file finalization.
        // It never initializes ScreenCaptureKit, a microphone, a camera, or TCC requests.
        let writer = try MediaWriter(url: output, width: 320, height: 180, fps: 30, audioChannels: 1)
        let anchor = CMTime(seconds: 10, preferredTimescale: 48_000)
        try writer.append(video(at: anchor), video: true, sourceClock: nil, timeline: RecordingTimeline(anchor: anchor))
        for index in 0..<12 {
            let timestamp = CMTimeAdd(anchor, CMTime(value: Int64(index * 1024), timescale: 48_000))
            try writer.append(audio(at: timestamp), video: false, sourceClock: nil, timeline: RecordingTimeline(anchor: anchor))
            try await Task.sleep(nanoseconds: 2_000_000)
        }
        try writer.append(video(at: CMTimeAdd(anchor, CMTime(seconds: 0.3, preferredTimescale: 30))), video: true, sourceClock: nil, timeline: RecordingTimeline(anchor: anchor))
        try await Task.sleep(nanoseconds: 100_000_000)
        try writer.end(at: CMTime(seconds: 2, preferredTimescale: 30), fps: 30)
        try await writer.finish()
        let asset = AVURLAsset(url: output)
        let duration = try await asset.load(.duration)
        let videos = try await asset.loadTracks(withMediaType: .video)
        let audios = try await asset.loadTracks(withMediaType: .audio)
        try require(videos.count == 1 && audios.count == 1, "The synthesized movie did not contain both media tracks.")
        let dimensions = try await videos[0].load(.naturalSize)
        try require(dimensions == CGSize(width: 320, height: 180), "Video dimensions changed in the encoder.")
        try require(abs(duration.seconds - 2) < 0.05, "The final idle frame did not extend the video through the requested duration: \(duration.seconds).")
        try require(writer.videoFrames >= 1 && writer.audioBuffers > 0, "The real encoder did not accept media.")
        let microphoneURL = directory.appendingPathComponent("microphone.m4a")
        let microphoneWriter = try MediaWriter(url: microphoneURL, audioChannels: 1)
        let delayedTime = CMTimeAdd(anchor, CMTime(seconds: 0.25, preferredTimescale: 48_000))
        for index in 0..<4 {
            let timestamp = CMTimeAdd(delayedTime, CMTime(value: Int64(index * 1024), timescale: 48_000))
            try microphoneWriter.append(audio(at: timestamp), video: false, sourceClock: nil, timeline: RecordingTimeline(anchor: anchor))
            try await Task.sleep(nanoseconds: 2_000_000)
        }
        try microphoneWriter.end(at: CMTime(seconds: 0.5, preferredTimescale: 48_000), fps: 30)
        try await microphoneWriter.finish()
        let microphoneAsset = AVURLAsset(url: microphoneURL)
        let microphoneTracks = try await microphoneAsset.loadTracks(withMediaType: .audio)
        try require(microphoneTracks.count == 1, "The separate microphone file was not encoded.")
        let microphoneDuration = try await microphoneAsset.load(.duration)
        let reader = try AVAssetReader(asset: microphoneAsset)
        let audioOutput = AVAssetReaderTrackOutput(track: microphoneTracks[0], outputSettings: nil)
        reader.add(audioOutput)
        try require(reader.startReading(), "Cannot read the encoded microphone timeline.")
        let firstAudioTime = audioOutput.copyNextSampleBuffer().map { CMSampleBufferGetPresentationTimeStamp($0).seconds }
        reader.cancelReading()
        try require(firstAudioTime != nil && abs(firstAudioTime!) < 0.005, "The microphone file does not start at the screen's zero point.")
        try require(microphoneDuration.seconds > 0.31 && microphoneDuration.seconds < 0.6, "Initial microphone silence did not preserve its delayed start: \(microphoneDuration.seconds).")
        let cameraURL = directory.appendingPathComponent("camera.mp4")
        let cameraWriter = try MediaWriter(url: cameraURL, width: 320, height: 180, fps: 30)
        try cameraWriter.append(video(at: delayedTime), video: true, sourceClock: nil, timeline: RecordingTimeline(anchor: anchor))
        try await Task.sleep(nanoseconds: 50_000_000)
        try cameraWriter.end(at: CMTime(seconds: 0.5, preferredTimescale: 30), fps: 30)
        try await cameraWriter.finish()
        let cameraAsset = AVURLAsset(url: cameraURL)
        let cameraDuration = try await cameraAsset.load(.duration)
        let cameraTracks = try await cameraAsset.loadTracks(withMediaType: .video)
        let cameraSegments = try await cameraTracks[0].load(.segments)
        let firstCameraSegment = cameraSegments.first { !$0.isEmpty }
        if abs(cameraDuration.seconds - 0.5) >= 0.05 {
            let diagnostic = FileManager.default.temporaryDirectory.appendingPathComponent("reva-delayed-camera-fragments-\(UUID().uuidString).mp4")
            try FileManager.default.copyItem(at: cameraURL, to: diagnostic)
            let segmentDescriptions = cameraSegments.map { "empty=\($0.isEmpty),start=\($0.timeMapping.target.start.seconds),duration=\($0.timeMapping.target.duration.seconds),source=\($0.timeMapping.source.start.seconds)" }
            print("Delayed-camera diagnostic: \(diagnostic.path), duration=\(cameraDuration.seconds), segments=\(segmentDescriptions)")
        }
        try require(abs(cameraDuration.seconds - 0.5) < 0.05, "The camera file lost its shared timeline duration: \(cameraDuration.seconds).")
        try require(firstCameraSegment != nil && abs(firstCameraSegment!.timeMapping.target.start.seconds - 0.25) < 0.05, "The camera file lost its delayed start relative to the screen.")
        try await checkPauseTimeline(directory: directory)
        print("Native tests passed: argument/device validation, camera format fallback and bounded scaling/encoding, poll cursor transitions, live PCM/JPEG bounds, cancellation, geometry, cursor ownership, H.264/AAC encoding, idle-frame finalization, delayed microphone/camera synchronization, shared pause clock, PCM boundary trimming, paused-stop metadata, and typing counter privacy.")
    }

    static func checkRecordingExtensions(directory: URL) async throws {
        let arguments = ["--source", "window:7", "--output", directory.appendingPathComponent("extensions.mp4").path, "--cursor-output", directory.appendingPathComponent("extensions.cursor.json").path]
        let options = try CaptureOptions.parse(arguments + ["--system-audio", "true", "--audio-applications", "[\"com.example.one\",\"com.example.two\"]", "--record-shortcuts", "true"])
        try require(options.systemAudioApplications == ["com.example.one","com.example.two"] && options.recordShortcuts, "Application audio identities or shortcut opt-in were lost.")
        for invalid in ["[]", "{}", "[\"\"]", "[\"one\",\"one\"]", "[1]"] {
            try expectFailure("invalid_arguments") { _ = try CaptureOptions.parse(arguments + ["--audio-applications", invalid]) }
        }
        let deviceArguments = ["--source", "device:opaque:USB/identity", "--output", directory.appendingPathComponent("device.mp4").path, "--cursor-output", directory.appendingPathComponent("device.cursor.json").path]
        let device = try CaptureOptions.parse(deviceArguments)
        try require(device.screenDeviceID == "opaque:USB/identity", "A connected-device identity was rewritten.")
        try expectFailure("invalid_arguments") { _ = try CaptureOptions.parse(deviceArguments + ["--area","0,0,10,10"]) }
        try expectFailure("invalid_arguments") { _ = try CaptureOptions.parse(deviceArguments + ["--audio-applications","[\"com.example.one\"]"]) }
        try expectFailure("invalid_arguments") { _ = try CaptureOptions.parse(deviceArguments + ["--record-shortcuts","true"]) }
        try require(CaptureShortcutKeys.keys(code: 0, flags: [], autorepeat: false) == nil && CaptureShortcutKeys.keys(code: 0, flags: .maskShift, autorepeat: false) == nil, "Ordinary printable text leaked into shortcut metadata.")
        try require(CaptureShortcutKeys.keys(code: 0, flags: [.maskCommand,.maskShift], autorepeat: false) == ["shift","command","A"], "Modifier command identity was not preserved.")
        try require(CaptureShortcutKeys.keys(code: 123, flags: [], autorepeat: false) == ["ArrowLeft"] && CaptureShortcutKeys.keys(code: 0, flags: .maskCommand, autorepeat: true) == nil, "Navigation/auto-repeat classification changed.")

        let metadata = try CaptureJSONWriter<RecordingActivity>(url: options.activityOutput)
        let flag = RecordingFlag(time: 2.25, id: "fixture-flag")
        try metadata.append(.flag(flag))
        try metadata.append(.shortcut(RecordingShortcut(time: 2.5, keys: ["command","S"], keyCode: 1)))
        let prefix = try metadata.checkpoint()
        let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: options.activityOutput)) as! [[String: Any]]
        try require(saved.count == 2 && saved[0]["time"] as? Double == 2.25 && saved[1]["keys"] as? [String] == ["command","S"], "Flags or shortcut source timing failed to round trip.")
        let interrupted = directory.appendingPathComponent("interrupted.activity.json")
        try FileManager.default.copyItem(at: options.activityOutput, to: interrupted)
        let partial = try FileHandle(forWritingTo: interrupted)
        try partial.seek(toOffset: prefix); try partial.write(contentsOf: Data(", {\"unfinished".utf8)); try partial.close()
        var committed = Data(try Data(contentsOf: interrupted).prefix(Int(prefix)))
        committed.append(0x5d)
        let recovered = try JSONSerialization.jsonObject(with: committed) as? [[String: Any]]
        try require(recovered?.count == 2, "An interrupted append invalidated the committed activity prefix.")
        let journal = try RecordingRecoveryJournal(options: options, width: 320, height: 180)
        try journal.checkpoint(duration: 2.5, width: 320, height: 180, cursor: 1, activity: prefix, status: "failed", error: "synthetic interruption")
        let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: options.recoveryOutput)) as! [String: Any]
        try require(manifest["type"] as? String == "reva-recording-recovery" && manifest["status"] as? String == "failed" && manifest["activityPrefixBytes"] as? UInt64 == prefix, "Recovery journal lost its committed source/prefix identity.")
        try metadata.finish()

        let scaler = try ConnectedScreenFrameScaler(width: 320, height: 180)
        let rotated = try video(at: CMTime(seconds: 1, preferredTimescale: 30), width: 180, height: 320)
        let scaled = try scaler.sample(rotated)
        let pixels = scaled.flatMap { CMSampleBufferGetImageBuffer($0) }
        try require(pixels != nil && CVPixelBufferGetWidth(pixels!) == 320 && CVPixelBufferGetHeight(pixels!) == 180, "Rotating device changed the encoded track dimensions.")
        try require(abs(CMSampleBufferGetPresentationTimeStamp(scaled!).seconds - 1) < 1e-7, "Device fitting changed source timing.")
        CVPixelBufferLockBaseAddress(pixels!, .readOnly)
        if let address = CVPixelBufferGetBaseAddress(pixels!) {
            let bytes = address.assumingMemoryBound(to: UInt8.self), row = CVPixelBufferGetBytesPerRow(pixels!) * 90
            try require(bytes[row] == 0 && bytes[row + 160 * 4] > 0, "A rotated complete device screen was stretched or cropped instead of fitted.")
        } else { throw CaptureFailure(code: "test_failed", message: "Cannot inspect fitted device pixels.") }
        CVPixelBufferUnlockBaseAddress(pixels!, .readOnly)
    }

    /// Parent test deliberately SIGKILLs this owned synthetic process. It never
    /// opens a display, camera, microphone, event tap, or permission prompt.
    static func interruptedFixture(directory: URL) async throws {
        let options = try CaptureOptions.parse(["--source","display:7","--output",directory.appendingPathComponent("screen.mp4").path,"--cursor-output",directory.appendingPathComponent("screen.cursor.json").path,"--microphone","true","--camera","true"])
        let screen = try MediaWriter(url: options.output, width: 320, height: 180, fps: 30, audioChannels: 1)
        let microphone = try MediaWriter(url: options.microphoneOutput, audioChannels: 1)
        let camera = try MediaWriter(url: options.cameraOutput, width: 320, height: 180, fps: 30)
        let cursor = try CursorWriter(url: options.cursorOutput)
        let activity = try CaptureJSONWriter<RecordingActivity>(url: options.activityOutput)
        let journal = try RecordingRecoveryJournal(options: options, width: 320, height: 180)
        let timeline = RecordingTimeline(anchor: .zero)
        for index in 0..<300 {
            let timestamp = CMTime(value: Int64(index), timescale: 30)
            try screen.append(video(at: timestamp), video: true, sourceClock: nil, timeline: timeline)
            try screen.append(audio(at: timestamp), video: false, sourceClock: nil, timeline: timeline)
            try microphone.append(audio(at: timestamp), video: false, sourceClock: nil, timeline: timeline)
            if index >= 8 {
                let cameraTime = CMTime(seconds: 0.25 + Double(index - 8) / 30, preferredTimescale: 60000)
                try camera.append(video(at: cameraTime), video: true, sourceClock: nil, timeline: timeline)
            }
            try cursor.append(CursorPoint(t: timestamp.seconds, x: 0.5, y: 0.5, click: false, visible: true, event: nil, button: nil))
            if index > 0 && index % 60 == 0 {
                try activity.append(.flag(RecordingFlag(time: timestamp.seconds, id: "flag-\(index)")))
                try journal.checkpoint(duration: timestamp.seconds, width: 320, height: 180, cursor: cursor.checkpoint(), activity: activity.checkpoint(), cameraStartTime: 0.25)
            }
            try await Task.sleep(nanoseconds: 33_333_333)
        }
        throw CaptureFailure(code: "test_failed", message: "The interruption fixture was not stopped by its parent.")
    }

    static func checkPauseTimeline(directory: URL) async throws {
        func time(_ seconds: Double) -> CMTime { CMTime(seconds: seconds, preferredTimescale: 48_000) }
        var timeline = RecordingTimeline(anchor: time(10))
        try timeline.pause(at: time(10.25))
        try timeline.pause(at: time(10.5))
        try require(timeline.isPaused && timeline.pauses.count == 1 && abs(timeline.elapsed(at: time(12)).seconds - 0.25) < 1e-7, "Pausing did not freeze the shared active clock or was not idempotent.")
        let firstPause = timeline.resume(at: time(12.25))
        try require(firstPause?.time == 0.25 && firstPause?.duration == 2 && timeline.resume(at: time(12.3)) == nil, "Resume did not preserve the pause boundary/duration.")
        try require(timeline.sampleTime(at: time(11)) == nil && timeline.sampleTime(at: time(12.25))?.seconds == 0.25, "Late samples inside a past pause were accepted or resume changed the source clock.")
        let crossing = timeline.activeRanges(from: time(10.24), to: time(12.26))
        try require(crossing.count == 2 && abs(crossing[0].duration.seconds - 0.01) < 1e-7 && abs(crossing[1].duration.seconds - 0.01) < 1e-7, "Audio spans did not exclude the exact paused interval.")
        try timeline.pause(at: time(12.6))
        try require(abs(timeline.elapsed(at: time(30)).seconds - 0.6) < 1e-7 && timeline.sampleTime(at: time(12.7)) == nil, "Stopping while paused would include paused wall-clock time.")
        let metadata = try CaptureJSONWriter<RecordingActivity>(url: directory.appendingPathComponent("activity.json"))
        try metadata.append(.pause(firstPause!))
        var counter = TypingCounter()
        counter.reset(to: 100)
        try require(counter.observe(100, time: 0) == nil, "An unchanged counter invented typing.")
        let typing = counter.observe(103, time: 0.3)
        try require(typing?.count == 3 && typing?.time == 0.3, "Typing counter lost activity deltas.")
        try metadata.append(.typing(typing!))
        counter.reset(to: 200) // Resume baseline discards all activity during pause.
        try require(counter.observe(200, time: 0.3) == nil && counter.observe(1, time: 0.4) == nil, "A reset or paused counter invented typing.")
        var closed = timeline
        let secondPause = closed.resume(at: time(12.9))!
        try require(abs(secondPause.time - 0.6) < 1e-7 && abs(secondPause.duration - 0.3) < 1e-7, "Paused-stop marker is not on the active source timeline.")
        try metadata.append(.pause(secondPause)); try metadata.finish()
        let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("activity.json"))) as! [[String: Any]]
        try require(saved.count == 3 && Set(saved[1].keys) == Set(["type", "time", "count"]), "Typing persistence contains data beyond activity time/count.")

        // Exercise production MediaWriter timing with actual H.264 and AAC files.
        let screen = try MediaWriter(url: directory.appendingPathComponent("paused-screen.mp4"), width: 320, height: 180, fps: 30, audioChannels: 1)
        let camera = try MediaWriter(url: directory.appendingPathComponent("paused-camera.mp4"), width: 320, height: 180, fps: 30)
        let microphone = try MediaWriter(url: directory.appendingPathComponent("paused-microphone.m4a"), audioChannels: 1)
        for stamp in [10.0, 10.2, 11.0, 12.25, 12.5, 12.7] {
            let sample = try video(at: time(stamp))
            try screen.append(sample, video: true, sourceClock: nil, timeline: timeline)
            try camera.append(sample, video: true, sourceClock: nil, timeline: timeline)
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        try require(screen.videoFrames == 4 && camera.videoFrames == 4, "Video or camera included a paused frame.")
        let before: [Double] = (0..<13).map { 10.0 + Double($0 * 1024) / 48_000.0 }
        let after: [Double] = (0..<18).map { 12.24 + Double($0 * 1024) / 48_000.0 }
        let stamps = before + [11.0] + after
        for stamp in stamps {
            let sample = try audio(at: time(stamp))
            try screen.append(sample, video: false, sourceClock: nil, timeline: timeline)
            try microphone.append(sample, video: false, sourceClock: nil, timeline: timeline)
            try await Task.sleep(nanoseconds: 2_000_000)
        }
        try require(screen.audioBuffers == 29 && microphone.audioBuffers == 29, "PCM buffers crossing pause/resume were not trimmed consistently (screen \(screen.audioBuffers), microphone \(microphone.audioBuffers)).")
        try await Task.sleep(nanoseconds: 100_000_000)
        let duration = timeline.elapsed(at: time(12.9))
        for writer in [screen, camera, microphone] { try writer.end(at: duration, fps: 30); try await writer.finish() }
        for name in ["paused-screen.mp4", "paused-camera.mp4", "paused-microphone.m4a"] {
            let asset = AVURLAsset(url: directory.appendingPathComponent(name))
            let actual = try await asset.load(.duration)
            try require(abs(actual.seconds - 0.6) < 0.05, "\(name) retained paused duration: \(actual.seconds).")
            let tracks = try await asset.load(.tracks)
            let reader = try AVAssetReader(asset: asset)
            let outputs = tracks.map { AVAssetReaderTrackOutput(track: $0, outputSettings: nil) }
            for output in outputs { reader.add(output) }
            try require(reader.startReading(), "Cannot inspect the encoded paused recording.")
            for output in outputs {
                var previous = -Double.infinity, previousEnd = -Double.infinity, maxGap = 0.0
                while let sample = output.copyNextSampleBuffer() {
                    if CMSampleBufferGetNumSamples(sample) == 0 { continue } // AVAssetReader end-of-track marker has no media timestamp.
                    let stamp = CMSampleBufferGetPresentationTimeStamp(sample).seconds
                    if previousEnd.isFinite { maxGap = max(maxGap, stamp - previousEnd) }
                    try require(stamp >= previous && stamp < 0.65, "Encoded \(name) \(output.track.mediaType.rawValue) timestamps are unordered or include pause time: \(previous) -> \(stamp).")
                    previous = stamp
                    let sampleDuration = CMSampleBufferGetDuration(sample).seconds
                    previousEnd = stamp + (sampleDuration.isFinite ? sampleDuration : 0)
                }
                try require(maxGap <= 0.251, "Encoded \(name) \(output.track.mediaType.rawValue) retained a pause-length gap: \(maxGap).")
            }
            reader.cancelReading()
        }

        // Real planar PCM has no per-frame sample-size table. Its paused middle
        // contains a much louder tone, which must be absent after AAC decoding.
        var samples = [Int16](); samples.reserveCapacity(96_000)
        for channel in 0..<2 {
            for frame in 0..<48_000 {
                let paused = frame >= 12_000 && frame < 36_000
                let amplitude = paused ? 0.8 : (channel == 0 ? 0.1 : 0.2)
                samples.append(Int16((sin(Double(frame) * 2 * .pi * 440 / 48_000) * amplitude * 32767).rounded()))
            }
        }
        let data = samples.withUnsafeBytes { Data($0) }
        let planarSample = try pcm(data: data, frames: 48_000, channels: 2, bits: 16, floating: false, planar: true)
        var planarTimeline = RecordingTimeline(anchor: .zero)
        try planarTimeline.pause(at: time(0.25)); _ = planarTimeline.resume(at: time(0.75))
        let planarURL = directory.appendingPathComponent("paused-planar.m4a")
        let planarWriter = try MediaWriter(url: planarURL, audioChannels: 2)
        try planarWriter.append(planarSample, video: false, sourceClock: nil, timeline: planarTimeline)
        try require(planarWriter.audioBuffers == 2, "Planar pause trimming lost an active PCM interval.")
        try await Task.sleep(nanoseconds: 50_000_000)
        try planarWriter.end(at: time(0.5), fps: 30); try await planarWriter.finish()
        let planarAsset = AVURLAsset(url: planarURL)
        let planarTracks = try await planarAsset.loadTracks(withMediaType: .audio)
        let planarReader = try AVAssetReader(asset: planarAsset)
        let decoded = AVAssetReaderTrackOutput(track: planarTracks[0], outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false])
        planarReader.add(decoded); try require(planarReader.startReading(), "Cannot decode trimmed planar PCM output.")
        var energy = 0.0, frames = 0
        while let sample = decoded.copyNextSampleBuffer() {
            let count = CMSampleBufferGetNumSamples(sample)
            if count == 0 { continue }
            let levels = try InputSamples.levels(sample, deviceID: "synthetic-planar")
            energy += levels.rms * levels.rms * Double(count); frames += count
        }
        let rms = sqrt(energy / Double(max(1, frames)))
        try require(frames >= 23_000 && frames <= 25_000 && rms > 0.09 && rms < 0.14, "Paused PCM leaked into decoded audio or channels were corrupted: frames=\(frames), rms=\(rms).")
        planarReader.cancelReading()
    }

    static func checkCameraFormatSelection() throws {
        func format(_ width: Int, _ height: Int, _ min: Double = 15, _ max: Double = 30) -> CameraFormatSpec {
            CameraFormatSpec(width: width, height: height, rates: [.init(min: min, max: max)])
        }
        let formats = [format(3840, 2160), format(1280, 720), format(1920, 1080, 15, 29.97), format(640, 480), format(1920, 1080, 30, 60)]
        let hd = CaptureDevices.chooseFormat(formats, maximumHeight: 720)
        let fullHD = CaptureDevices.chooseFormat(formats, maximumHeight: 1080)
        let ultraHD = CaptureDevices.chooseFormat(formats, maximumHeight: 2160)
        try require(hd?.format == 1 && hd?.fps == 30, "Equivalent outputs did not prefer the smaller native source.")
        try require(fullHD?.format == 4 && fullHD?.fps == 30, "Equivalent dimensions did not prefer the supported rate nearest 30 fps.")
        try require(ultraHD?.format == 0, "4K selection did not use the greatest available pixel area.")
        let fractional = CaptureDevices.chooseFormat([format(1280, 720, 29.97, 29.97)], maximumHeight: 1080)
        try require(fractional?.fps == 29.97, "An exact fractional device rate was changed or the format was upscaled.")
        let slower = CaptureDevices.chooseFormat([format(1920, 1080, 5, 15), format(1280, 720, 30, 60)], maximumHeight: 1080)
        try require(slower?.format == 0 && slower?.fps == 15, "The documented pixel-area priority changed.")
        let largeOnly = CaptureDevices.chooseFormat([format(3840, 2160)], maximumHeight: 1080)
        let highRateOnly = CaptureDevices.chooseFormat([format(1920, 1440, 60, 60)], maximumHeight: 1080)
        try require(largeOnly?.format == 0 && largeOnly?.fps == 30, "A usable high-resolution-only camera was rejected by the output ceiling.")
        try require(highRateOnly?.format == 0 && highRateOnly?.fps == 60, "A camera whose minimum supported rate exceeds 30 was rejected or assigned an unsupported rate.")
        let scaled = CaptureDevices.encodedCameraSize(width: 3840, height: 2160, maximumHeight: 1080)
        let odd = CaptureDevices.encodedCameraSize(width: 1281, height: 721, maximumHeight: 1080)
        try require(scaled?.width == 1920 && scaled?.height == 1080 && odd?.width == 1280 && odd?.height == 720, "Camera output was not proportionally bounded and rounded to encoder-safe even dimensions.")
        let invalid = [format(0, 720), format(1280, 720, .nan, 30), format(1280, 720, 10, .infinity), format(Int.max, 720), format(1280, 720, 0, 30)]
        try require(CaptureDevices.chooseFormat(invalid, maximumHeight: 1080) == nil, "Unsupported or oversized formats did not fail closed.")
        try require(CaptureDevices.chooseFormat([format(16384, 2160)], maximumHeight: 2160) == nil, "The camera pixel budget was exceeded.")
    }

    static func checkWindowCorners(directory: URL) async throws {
        let anchor = CMTime(value: 401, timescale: 30)
        let source = try video(at: anchor)
        let pixels = CMSampleBufferGetImageBuffer(source)!
        CVPixelBufferLockBaseAddress(pixels, [])
        let bytes = CVPixelBufferGetBaseAddress(pixels)!.assumingMemoryBound(to: UInt8.self), stride = CVPixelBufferGetBytesPerRow(pixels)
        for y in 0..<180 { for x in 0..<320 {
            let i = y * stride + x * 4
            bytes[i] = 70; bytes[i + 1] = 110; bytes[i + 2] = 160
            bytes[i + 3] = y == 0 || y == 179 || (y < 20 && (x < 20 - y || x >= 300 + y)) || (y >= 160 && (x < y - 159 || x >= 479 - y)) ? 0 : 255
        } }
        bytes[90 * stride + 160 * 4] = 230
        CVPixelBufferUnlockBaseAddress(pixels, [])
        let normalizer = WindowFrameNormalizer()
        let normalized = try normalizer.sample(source)!
        try require(CMSampleBufferGetPresentationTimeStamp(normalized) == anchor && CMSampleBufferGetDuration(normalized) == CMSampleBufferGetDuration(source), "Window edge cleanup changed capture timing.")
        let output = CMSampleBufferGetImageBuffer(normalized)!
        CVPixelBufferLockBaseAddress(pixels, .readOnly); CVPixelBufferLockBaseAddress(output, .readOnly)
        let original = CVPixelBufferGetBaseAddress(pixels)!.assumingMemoryBound(to: UInt8.self), result = CVPixelBufferGetBaseAddress(output)!.assumingMemoryBound(to: UInt8.self), outputStride = CVPixelBufferGetBytesPerRow(output)
        var preserved = true, opaque = true
        for y in 0..<180 { for x in 0..<320 {
            let i = y * stride + x * 4, j = y * outputStride + x * 4
            if original[i + 3] == 255 { for component in 0..<4 { preserved = preserved && original[i + component] == result[j + component] } }
            opaque = opaque && result[j + 3] == 255
        } }
        let untouched = original[3] == 0, filled = result[0] == 70 && result[1] == 110 && result[2] == 160
        CVPixelBufferUnlockBaseAddress(output, .readOnly); CVPixelBufferUnlockBaseAddress(pixels, .readOnly)
        try require(preserved && opaque && untouched && filled, "Window cleanup changed opaque content, mutated the capture buffer, or retained a corner matte.")
        let alreadyOpaque = try normalizer.sample(normalized)
        try require(alreadyOpaque === normalized, "Already opaque window frames should not be copied.")
        let writer = try MediaWriter(url: directory.appendingPathComponent("window-corners.mp4"), width: 320, height: 180, fps: 30)
        try writer.append(normalized, video: true, sourceClock: nil, timeline: RecordingTimeline(anchor: anchor))
        try await Task.sleep(nanoseconds: 50_000_000)
        try writer.end(at: CMTime(value: 1, timescale: 2), fps: 30); try await writer.finish()
        let asset = AVURLAsset(url: directory.appendingPathComponent("window-corners.mp4"))
        let reader = try AVAssetReader(asset: asset)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let decoded = AVAssetReaderTrackOutput(track: tracks[0], outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(decoded); try require(reader.startReading(), "Cannot decode cleaned window recording.")
        guard let sample = decoded.copyNextSampleBuffer(), let decodedPixels = CMSampleBufferGetImageBuffer(sample) else { throw CaptureFailure(code: "test_failed", message: "Cleaned window recording has no frame.") }
        CVPixelBufferLockBaseAddress(decodedPixels, .readOnly)
        let corner = CVPixelBufferGetBaseAddress(decodedPixels)!.assumingMemoryBound(to: UInt8.self)
        let clean = abs(Int(corner[0]) - 70) < 15 && abs(Int(corner[1]) - 110) < 15 && abs(Int(corner[2]) - 160) < 15
        CVPixelBufferUnlockBaseAddress(decodedPixels, .readOnly)
        try require(clean, "The actual H.264 window recording reintroduced white corners.")
    }

    static func checkCameraScaling(directory: URL) async throws {
        let anchor = CMTime(value: 401, timescale: 30)
        let source = try video(at: anchor, width: 1920, height: 1440)
        let pixels = CMSampleBufferGetImageBuffer(source)!
        CVPixelBufferLockBaseAddress(pixels, [])
        let bytes = CVPixelBufferGetBaseAddress(pixels)!.assumingMemoryBound(to: UInt8.self), stride = CVPixelBufferGetBytesPerRow(pixels)
        for y in 0..<1440 { for x in 0..<1920 {
            let i = y * stride + x * 4
            bytes[i] = x < 960 ? 64 : 192; bytes[i + 1] = 128; bytes[i + 2] = x < 960 ? 192 : 64; bytes[i + 3] = 255
        } }
        CVPixelBufferUnlockBaseAddress(pixels, [])
        let scaler = CameraFrameScaler(maximumHeight: 720)
        let scaled = try scaler.sample(source)!
        let outputPixels = CMSampleBufferGetImageBuffer(scaled)!
        try require(CVPixelBufferGetWidth(outputPixels) == 960 && CVPixelBufferGetHeight(outputPixels) == 720, "A 4:3 high-resolution camera did not retain its aspect at the output ceiling.")
        try require(CMSampleBufferGetPresentationTimeStamp(scaled) == anchor && CMSampleBufferGetDuration(scaled) == CMSampleBufferGetDuration(source) && !CMSampleBufferGetDecodeTimeStamp(scaled).isValid, "Scaling changed camera timestamps or frame duration.")
        CVPixelBufferLockBaseAddress(outputPixels, .readOnly)
        let outputBytes = CVPixelBufferGetBaseAddress(outputPixels)!.assumingMemoryBound(to: UInt8.self), row = 360 * CVPixelBufferGetBytesPerRow(outputPixels)
        let left = row + 100 * 4, right = row + 800 * 4
        let colorsPreserved = abs(Int(outputBytes[left]) - 64) <= 2 && abs(Int(outputBytes[left + 2]) - 192) <= 2 && abs(Int(outputBytes[right]) - 192) <= 2 && abs(Int(outputBytes[right + 2]) - 64) <= 2
        CVPixelBufferUnlockBaseAddress(outputPixels, .readOnly)
        try require(colorsPreserved, "Core Image did not preserve the actual source pixels across scaling.")
        let native = try video(at: anchor)
        let unchanged = try scaler.sample(native)
        try require(unchanged === native, "A small even camera frame was copied or upscaled.")

        let bounded = CameraFrameScaler(maximumHeight: 720)
        var retained: [CMSampleBuffer] = []
        for _ in 0..<3 { retained.append(try bounded.sample(source)!) }
        let dropped = try bounded.sample(source)
        try require(dropped == nil && bounded.droppedFrames == 1, "Scaled camera frames exceeded the three-buffer allocation budget.")
        retained.removeAll()
        let recovered = try bounded.sample(source)
        try require(recovered != nil, "The camera scaling pool did not recover after consumers released frames.")

        let url = directory.appendingPathComponent("scaled-camera.mp4")
        let writer = try MediaWriter(url: url, width: 960, height: 720, fps: 30)
        try writer.append(scaled, video: true, sourceClock: nil, timeline: RecordingTimeline(anchor: anchor))
        try await Task.sleep(nanoseconds: 50_000_000)
        try writer.end(at: CMTime(value: 1, timescale: 2), fps: 30)
        try await writer.finish()
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let dimensions = try await tracks[0].load(.naturalSize)
        let duration = try await asset.load(.duration)
        try require(dimensions == CGSize(width: 960, height: 720) && abs(duration.seconds - 0.5) < 0.04, "The actual scaled H.264 camera file lost its output dimensions or timeline.")
        let reader = try AVAssetReader(asset: asset)
        let decoded = AVAssetReaderTrackOutput(track: tracks[0], outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(decoded)
        try require(reader.startReading(), "Cannot decode the actual scaled camera file.")
        let first = decoded.copyNextSampleBuffer()
        try require(first != nil && CMSampleBufferGetPresentationTimeStamp(first!).seconds == 0 && CMSampleBufferGetImageBuffer(first!) != nil, "The scaled H.264 camera frame did not decode at the shared zero point.")
        reader.cancelReading()
    }

    static func checkLiveInputs(arguments: [String]) async throws {
        var poll = CursorPollState()
        let p = CGPoint(x: 10, y: 20)
        try require(poll.observe(point: p, buttons: [.left], inside: true).event == nil, "Startup invented a mouse down.")
        try require(poll.observe(point: p, buttons: [], inside: true).event == nil, "A pre-existing button hold invented an up.")
        let down = poll.observe(point: p, buttons: [.right], inside: true)
        try require(down.event == .mouseDown && down.button == .right, "Observed right down was lost.")
        try require(poll.observe(point: CGPoint(x: 11, y: 20), buttons: [.right], inside: true).event == .mouseDragged, "Drag movement was not classified.")
        let up = poll.observe(point: p, buttons: [], inside: true)
        try require(up.event == .mouseUp && up.button == .right, "Observed release was not preserved.")
        try require(poll.observe(point: p, buttons: [.left, .right], inside: true).event == nil, "Compound transitions were assigned an invented ordering.")
        _ = poll.observe(point: p, buttons: [], inside: false)
        _ = poll.observe(point: p, buttons: [.left], inside: false)
        try require(poll.observe(point: p, buttons: [], inside: true).event == nil, "An outside press invented a captured release.")
        let selected = try CaptureOptions.parse(arguments + ["--camera", "true", "--microphone", "true", "--preview-camera", "true", "--monitor-microphone", "true"])
        try require(selected.previewCamera && selected.monitorMicrophone, "Live recording flags were lost.")
        for flags in [["--preview-camera", "true"], ["--monitor-microphone", "true"], ["--preview-camera", "yes"]] {
            try expectFailure("invalid_arguments") { _ = try CaptureOptions.parse(arguments + flags) }
        }
        let monitor = try InputMonitorOptions.parse(["--microphones", "none", "--camera", "true", "--camera-device-id", "opaque camera:/ ID", "--exclude-microphone-device-id", "opaque mic ID"])
        try require(monitor.camera && !monitor.microphones && monitor.cameraDeviceID == "opaque camera:/ ID" && monitor.excludeMicrophoneDeviceID == "opaque mic ID", "Monitor changed explicit selections.")
        for flags in [["--camera", "yes"], ["--microphones", "invalid"], ["--camera-device-id", ""], ["--camera-device-id", "bad\0id"], ["--camera", "true", "--camera", "false"], ["--extra", "false"]] {
            try expectFailure("invalid_arguments") { _ = try InputMonitorOptions.parse(flags) }
        }
        let selectedMonitor = try InputMonitorOptions.parse(["--microphones", "selected", "--microphone-device-id", "opaque selected mic"])
        try require(selectedMonitor.microphones && selectedMonitor.microphoneMode == "selected" && selectedMonitor.microphoneDeviceID == "opaque selected mic", "Selected microphone monitoring lost the explicit device identity.")
        try expectFailure("invalid_arguments") { _ = try InputMonitorOptions.parse(["--microphones", "selected", "--microphone-device-id", ""]) }
        let input = try audio(at: .zero)
        let block = CMSampleBufferGetDataBuffer(input)!
        let pattern = (0..<1024).map { Float([1.0, -1.0, 0, 0][$0 % 4]) }
        let status = pattern.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: $0.count) }
        try require(status == noErr, "Cannot fill metering fixture.")
        let measured = try InputSamples.levels(input, deviceID: "mic ID")
        try require(measured.deviceID == "mic ID" && abs(measured.rms - sqrt(0.5)) < 0.000001 && measured.peak == 1, "RMS/peak were not measured from actual PCM.")
        let silence = try InputSamples.levels(audio(at: .zero), deviceID: "silent")
        try require(silence.rms == 0 && silence.peak == 0, "Silent input generated a fake level.")
        var invalid = Float.nan
        _ = withUnsafeBytes(of: &invalid) { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: $0.count) }
        try expectFailure("invalid_audio_sample") { _ = try InputSamples.levels(input, deviceID: "bad PCM") }
        for planar in [false, true] {
            let values: [Float] = planar ? [1, -0.5, 0, 0.5] : [1, 0, -0.5, 0.5]
            let bytes = values.withUnsafeBytes { Data($0) }
            let stereo = try pcm(data: bytes, frames: 2, channels: 2, bits: 32, floating: true, planar: planar)
            let level: InputLevelsEvent
            do { level = try InputSamples.levels(stereo, deviceID: "stereo") }
            catch { throw CaptureFailure(code: "test_failed", message: "Stereo fixture planar=\(planar): \(error.localizedDescription)") }
            try require(abs(level.rms - sqrt(0.375)) < 0.000001 && level.peak == 1, "Stereo/planar PCM layout was misread.")
        }
        for planar in [false, true] {
            // Each channel occupies a distinct plane when declared planar. The
            // uneven amplitudes detect treating padding or a plane as silence.
            let i16: [Int16] = planar ? [16384, -16384, 8192, -8192] : [16384, 8192, -16384, -8192]
            let i32: [Int32] = planar ? [1_073_741_824, -1_073_741_824, 536_870_912, -536_870_912] : [1_073_741_824, 536_870_912, -1_073_741_824, -536_870_912]
            for (bits, bytes) in [(16, i16.withUnsafeBytes { Data($0) }), (32, i32.withUnsafeBytes { Data($0) })] {
                let integerPCM = try pcm(data: bytes, frames: 2, channels: 2, bits: bits, floating: false, planar: planar)
                let level: InputLevelsEvent
                do { level = try InputSamples.levels(integerPCM, deviceID: "integer") }
                catch { throw CaptureFailure(code: "test_failed", message: "Integer fixture bits=\(bits), planar=\(planar): \(error.localizedDescription)") }
                try require(abs(level.rms - sqrt(0.15625)) < 0.000001 && level.peak == 0.5, "Signed integer PCM normalization or channel layout was incorrect.")
            }
        }
        let video = try self.video(at: .zero, width: 1920, height: 1080)
        let frame = try InputSamples.cameraFrame(video, deviceID: "camera ID", context: CIContext(options: [.useSoftwareRenderer: true]))
        let jpeg = Data(base64Encoded: frame.jpegBase64)!
        let image = CGImageSourceCreateWithData(jpeg as CFData, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) }
        try require(frame.width == 360 && frame.height == 202 && jpeg.count <= 256 * 1024 && image?.width == 360 && image?.height == 202, "Preview JPEG did not decode at bounded actual dimensions.")
        var levels: [InputLevelsEvent] = [], frames: [CameraFrameEvent] = [], errors: [InputErrorEvent] = []
        let quiet = try audio(at: .zero)
        let release = DispatchSemaphore(value: 0)
        var live: LiveInputOutput!
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            live = LiveInputOutput(previewCamera: true, monitorMicrophone: true,
                onLevels: { levels.append($0); release.wait() },
                onFrame: { frames.append($0); done.resume() }, onError: { errors.append($0); done.resume() })
            live.audio(quiet, deviceID: "before ready")
            live.activate()
            for _ in 0..<1000 { live.audio(quiet, deviceID: "mic"); live.video(video, deviceID: "camera") }
            release.signal()
        }
        await live.finish()
        try require(levels.count == 1 && frames.count == 1 && errors.isEmpty, "Live input scheduling did not bound pending work or preserve ready/terminal ordering.")
        live.activate() // A late handshake must not resurrect completed telemetry.
        live.audio(quiet, deviceID: "after stop"); live.video(video, deviceID: "after stop")
        await live.finish()
        try require(levels.count == 1 && frames.count == 1, "Completed live telemetry emitted more samples.")
    }

    /// A checkpoint can overtake a frame still in ScreenCaptureKit's delivery
    /// queue. This sequence reproduced AVFoundation -11800 / OSStatus -16364.
    static func checkCheckpointOrdering(directory: URL) async throws {
        let url = directory.appendingPathComponent("checkpoint-ordering.mp4")
        let writer = try MediaWriter(url: url, width: 320, height: 180, fps: 60)
        let anchor = CMTime(seconds: 10, preferredTimescale: 600)
        let timeline = RecordingTimeline(anchor: anchor)
        try writer.append(video(at: anchor), video: true, sourceClock: nil, timeline: timeline)
        try await Task.sleep(nanoseconds: 150_000_000)
        try writer.checkpoint(at: CMTime(seconds: 2, preferredTimescale: 600))
        try await Task.sleep(nanoseconds: 150_000_000)
        for value in [11.99, 12.0, 12.05] {
            try writer.append(video(at: CMTime(seconds: value, preferredTimescale: 600)), video: true, sourceClock: nil, timeline: timeline)
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        try writer.end(at: CMTime(seconds: 2.2, preferredTimescale: 600), fps: 60)
        try await writer.finish()
        try require(writer.droppedVideoFrames == 2 && writer.videoFrames == 2, "Queued frames were appended behind a recovery checkpoint.")
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: tracks[0], outputSettings: nil)
        reader.add(output)
        try require(reader.startReading(), "The checkpoint recording could not be decoded.")
        var last = CMTime.invalid, count = 0
        while let sample = output.copyNextSampleBuffer() {
            // A fragmented reader may emit zero-sample boundary markers at the
            // preceding timestamp. Only actual encoded samples carry frames.
            if CMSampleBufferGetNumSamples(sample) == 0 { continue }
            let timestamp = CMSampleBufferGetPresentationTimeStamp(sample)
            try require(!last.isNumeric || CMTimeCompare(timestamp, last) > 0, "Final video timestamps are not strictly increasing at sample \(count): \(last.seconds) → \(timestamp.seconds).")
            last = timestamp; count += 1
        }
        try require(reader.status == .completed && count >= 3, "The checkpoint regression did not produce a complete playable video.")
        let duration = try await asset.load(.duration)
        try require(abs(duration.seconds - 2.2) < 0.04, "Skipping queued frames changed the recording duration.")
    }

    static func video(at time: CMTime, width: Int = 320, height: Int = 180) throws -> CMSampleBuffer {
        var image: CVPixelBuffer?
        let attributes: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        try require(CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, attributes as CFDictionary, &image) == kCVReturnSuccess, "Cannot create synthetic pixel buffer.")
        guard let image else { throw CaptureFailure(code: "test_failed", message: "Missing synthetic image.") }
        CVPixelBufferLockBaseAddress(image, [])
        if let address = CVPixelBufferGetBaseAddress(image) { memset(address, 120, CVPixelBufferGetDataSize(image)) }
        CVPixelBufferUnlockBaseAddress(image, [])
        var description: CMVideoFormatDescription?
        try require(CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image, formatDescriptionOut: &description) == noErr, "Cannot describe synthetic image.")
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30), presentationTimeStamp: time, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        try require(CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image, formatDescription: description!, sampleTiming: &timing, sampleBufferOut: &sample) == noErr, "Cannot create synthetic video sample.")
        return sample!
    }

    static func pcm(data: Data, frames: Int, channels: Int, bits: Int, floating: Bool, planar: Bool) throws -> CMSampleBuffer {
        let flags = kAudioFormatFlagIsPacked | (floating ? kAudioFormatFlagIsFloat : kAudioFormatFlagIsSignedInteger) | (planar ? kAudioFormatFlagIsNonInterleaved : 0)
        let bytesPerFrame = UInt32(bits / 8 * (planar ? 1 : channels))
        var format = AudioStreamBasicDescription(mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM, mFormatFlags: flags, mBytesPerPacket: bytesPerFrame, mFramesPerPacket: 1, mBytesPerFrame: bytesPerFrame, mChannelsPerFrame: UInt32(channels), mBitsPerChannel: UInt32(bits), mReserved: 0)
        var description: CMAudioFormatDescription?
        try require(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &format, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description) == noErr, "Cannot describe PCM layout fixture.")
        var block: CMBlockBuffer?
        try require(CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: data.count, blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0, dataLength: data.count, flags: 0, blockBufferOut: &block) == noErr, "Cannot allocate PCM layout fixture.")
        let status = data.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: $0.count) }
        try require(status == noErr, "Cannot fill PCM layout fixture.")
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48_000), presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        try require(CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: description!, sampleCount: frames, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sample) == noErr, "Cannot create PCM layout fixture.")
        return sample!
    }

    static func audio(at time: CMTime) throws -> CMSampleBuffer {
        var format = AudioStreamBasicDescription(mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
        var description: CMAudioFormatDescription?
        try require(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &format, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description) == noErr, "Cannot describe synthetic audio.")
        var block: CMBlockBuffer?
        try require(CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: 4096, blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0, dataLength: 4096, flags: 0, blockBufferOut: &block) == noErr, "Cannot allocate synthetic audio.")
        try require(CMBlockBufferFillDataBytes(with: 0, blockBuffer: block!, offsetIntoDestination: 0, dataLength: 4096) == noErr, "Cannot fill synthetic audio.")
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48_000), presentationTimeStamp: time, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        try require(CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: description, sampleCount: 1024, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sample) == noErr, "Cannot create synthetic audio sample.")
        return sample!
    }
}
