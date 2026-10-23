import Foundation
import AVFoundation
import Speech
import CryptoKit
import Darwin

struct SpeechTranscriptionOptions {
    let input: URL
    let outputDirectory: URL
    let locale: String
    let track: String
    let offset: Double
    let contextualStrings: [String]

    static func parse(_ arguments: [String]) throws -> SpeechTranscriptionOptions {
        var values: [String: String] = [:]
        var context: [String] = []
        var index = 0
        while index < arguments.count {
            let key = arguments[index]
            guard ["--input", "--output-directory", "--locale", "--track", "--offset", "--contextual-string"].contains(key), index + 1 < arguments.count else {
                throw CaptureFailure(code: "invalid_arguments", message: "Unknown or incomplete speech option: \(key)")
            }
            let value = arguments[index + 1]
            guard !value.contains("\0") else { throw CaptureFailure(code: "invalid_arguments", message: "Speech options cannot contain NUL.") }
            if key == "--contextual-string" { context.append(value) }
            else {
                guard values[key] == nil else { throw CaptureFailure(code: "invalid_arguments", message: "Duplicate speech option: \(key)") }
                values[key] = value
            }
            index += 2
        }
        guard let input = values["--input"], input.hasPrefix("/"),
              let directory = values["--output-directory"], directory.hasPrefix("/"),
              let locale = values["--locale"], !locale.isEmpty, locale.utf8.count <= 128,
              let track = values["--track"], ["microphone", "system"].contains(track),
              let offset = Double(values["--offset"] ?? "0"), offset.isFinite, offset >= 0, offset <= 604800,
              context.count <= 100, context.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 1024 }) else {
            throw CaptureFailure(code: "invalid_arguments", message: "Speech requires absolute input/output-directory paths, a locale, a microphone/system track, and a finite nonnegative offset.")
        }
        return SpeechTranscriptionOptions(input: URL(fileURLWithPath: input), outputDirectory: URL(fileURLWithPath: directory, isDirectory: true), locale: locale, track: track, offset: offset, contextualStrings: context)
    }
}

struct SpeechStatusEvent: Encodable {
    let available: Bool
    let method = "apple-on-device"
    let engine = "SFSpeechRecognizer (legacy, on-device only)"
    let permission: String
    let locale: String
    let locales: [String]
    let reason: String?
}
private struct SpeechReadyEvent: Encodable {
    let type = "ready"
    let duration: Double
    let chunks: Int
}
private struct SpeechProgressEvent: Encodable {
    let type = "progress"
    let progress: Double
}

private final class SpeechCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var cancelWork: (() -> Void)?
    func check() throws {
        lock.lock(); let value = cancelled; lock.unlock()
        if value { throw CancellationError() }
    }
    @discardableResult func install(_ callback: (() -> Void)?) -> Bool {
        lock.lock(); cancelWork = callback; let invoke = cancelled; lock.unlock()
        if invoke { callback?() }
        return !invoke
    }
    func cancel() {
        lock.lock(); cancelled = true; let callback = cancelWork; lock.unlock()
        callback?()
    }
}

private final class SpeechRecognitionRun {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<SFSpeechRecognitionResult, Error>?
    private var task: SFSpeechRecognitionTask?
    init(_ continuation: CheckedContinuation<SFSpeechRecognitionResult, Error>) { self.continuation = continuation }
    func install(_ task: SFSpeechRecognitionTask) {
        lock.lock(); self.task = task; let complete = continuation == nil; lock.unlock()
        if complete { task.cancel() }
    }
    func finish(_ result: Result<SFSpeechRecognitionResult, Error>) {
        lock.lock(); let completion = continuation; continuation = nil; task = nil; lock.unlock()
        completion?.resume(with: result)
    }
    func cancel() {
        lock.lock(); let task = self.task; lock.unlock()
        task?.cancel()
        finish(.failure(CancellationError()))
    }
}

struct SpeechTranscriptWord: Encodable {
    let id: String
    let start: Double
    let end: Double
    let text: String
    let confidence: Float
    let timing: String
}
struct SpeechTranscriptDocument: Encodable {
    struct Source: Encodable {
        let path: String
        let sha256: String
        let duration: Double
        let offset: Double
        let track: String
    }
    let version = 1
    let generator = "apple-on-device"
    let language: String
    let source: Source
    let words: [SpeechTranscriptWord]
    let limitations = [
        "Uses Apple's legacy SFSpeechRecognizer with requiresOnDeviceRecognition. This is not macOS 26 SpeechAnalyzer.",
        "No model or asset download is requested. The selected language must support installed on-device recognition.",
        "The legacy recognizer runs consecutive 45-second local chunks; recognition and punctuation can differ at chunk boundaries.",
        "Filler words may be omitted by the speech engine. Word timestamps are recognizer estimates."
    ]
}

enum SpeechTranscriptionCommand {
    static func permissionName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not-determined"
        @unknown default: return "unknown"
        }
    }

    static func status(locale: String? = nil) -> SpeechStatusEvent {
        let identifier = locale ?? Locale.current.identifier
        let authorization = SFSpeechRecognizer.authorizationStatus()
        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: identifier))
        var reasons: [String] = []
        if authorization == .denied || authorization == .restricted { reasons.append("Speech Recognition permission is \(permissionName(authorization)). Enable it for REVA Studio in System Settings.") }
        if recognizer == nil { reasons.append("The selected locale is not supported by Apple speech recognition.") }
        else if recognizer?.supportsOnDeviceRecognition != true { reasons.append("On-device speech recognition is unavailable for this language. No cloud request or model download will be made.") }
        else if recognizer?.isAvailable != true { reasons.append("Apple's on-device recognizer is currently unavailable. No cloud fallback is used.") }
        return SpeechStatusEvent(available: reasons.isEmpty, permission: permissionName(authorization), locale: identifier,
                                 locales: SFSpeechRecognizer.supportedLocales().map(\.identifier).sorted(), reason: reasons.isEmpty ? nil : reasons.joined(separator: " "))
    }

    /// This factory is also tested: local-only policy must never depend on a UI toggle.
    static func request(url: URL, contextualStrings: [String]) -> SFSpeechURLRecognitionRequest {
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        request.taskHint = .dictation
        request.contextualStrings = contextualStrings
        request.addsPunctuation = true
        return request
    }

    static func run(options: SpeechTranscriptionOptions) async -> Int32 {
        let cancellation = SpeechCancellation()
        var signals: [DispatchSourceSignal] = []
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler { cancellation.cancel() }
            source.resume(); signals.append(source)
        }
        DispatchQueue.global().async {
            while let line = readLine() {
                if line.trimmingCharacters(in: .whitespacesAndNewlines) == "cancel" { cancellation.cancel(); return }
            }
            cancellation.cancel()
        }
        defer { signals.forEach { $0.cancel() } }
        do {
            let initial = status(locale: options.locale)
            guard initial.available else { throw CaptureFailure(code: "speech_unavailable", message: initial.reason ?? "Local speech is unavailable.") }
            if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
                let authorized = await withCheckedContinuation { completion in SFSpeechRecognizer.requestAuthorization { completion.resume(returning: $0) } }
                guard authorized == .authorized else { throw CaptureFailure(code: "speech_permission", message: "Speech Recognition permission was not granted.") }
            }
            try cancellation.check()
            guard SFSpeechRecognizer.authorizationStatus() == .authorized,
                  let recognizer = SFSpeechRecognizer(locale: Locale(identifier: options.locale)), recognizer.supportsOnDeviceRecognition else {
                throw CaptureFailure(code: "speech_unavailable", message: "Local speech recognition is unavailable or permission was not granted.")
            }
            let asset = AVURLAsset(url: options.input)
            let duration = CMTimeGetSeconds(try await asset.load(.duration))
            guard duration.isFinite, duration > 0, duration <= 604800,
                  !(try await asset.loadTracks(withMediaType: .audio)).isEmpty else {
                throw CaptureFailure(code: "speech_no_audio", message: "The selected recording has no usable audio track.")
            }
            let hash = try digest(options.input, cancellation)
            let chunksDirectory = options.outputDirectory.appendingPathComponent("speech-chunks", isDirectory: true)
            // The wrapper supplies an existing unique private directory; never overwrite its contents.
            try FileManager.default.createDirectory(at: chunksDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            defer { try? FileManager.default.removeItem(at: chunksDirectory) }
            let count = Int(ceil(duration / 45))
            ProtocolOutput.emit(SpeechReadyEvent(duration: duration, chunks: count))
            var words: [SpeechTranscriptWord] = []
            for chunk in 0..<count {
                try cancellation.check()
                let start = Double(chunk) * 45, span = min(45, duration - start)
                let url = chunksDirectory.appendingPathComponent("chunk-\(chunk).m4a")
                guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
                    throw CaptureFailure(code: "speech_audio_conversion", message: "Cannot prepare a local audio chunk for recognition.")
                }
                export.outputURL = url; export.outputFileType = .m4a
                export.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 48000), duration: CMTime(seconds: span, preferredTimescale: 48000))
                cancellation.install { export.cancelExport() }
                await withCheckedContinuation { completion in export.exportAsynchronously { completion.resume() } }
                cancellation.install(nil); try cancellation.check()
                guard export.status == .completed else { throw export.error ?? CaptureFailure(code: "speech_audio_conversion", message: "Cannot prepare local speech audio.") }
                let result: SFSpeechRecognitionResult = try await withCheckedThrowingContinuation { completion in
                    let owner = SpeechRecognitionRun(completion)
                    guard cancellation.install({ owner.cancel() }) else { return }
                    let task = recognizer.recognitionTask(with: request(url: url, contextualStrings: options.contextualStrings)) { result, error in
                        if let result, result.isFinal { owner.finish(.success(result)) }
                        else if let error { owner.finish(.failure(error)) }
                    }
                    owner.install(task)
                }
                cancellation.install(nil); try cancellation.check()
                for segment in result.bestTranscription.segments {
                    let from = options.offset + start + max(0, segment.timestamp)
                    let end = options.offset + min(duration, start + span, start + segment.timestamp + segment.duration)
                    guard end > from, !segment.substring.isEmpty else { continue }
                    guard words.count < 200000 else { throw CaptureFailure(code: "speech_capacity", message: "The transcript exceeds the 200000-token project bound.") }
                    words.append(SpeechTranscriptWord(id: "apple-\(words.count)", start: from, end: end, text: segment.substring, confidence: segment.confidence,
                                                      timing: segment.substring.split(whereSeparator: { $0.isWhitespace }).count > 1 ? "segment" : "word"))
                }
                try FileManager.default.removeItem(at: url)
                ProtocolOutput.emit(SpeechProgressEvent(progress: Double(chunk + 1) / Double(count)))
            }
            try cancellation.check()
            let document = SpeechTranscriptDocument(language: options.locale,
                source: .init(path: options.input.path, sha256: hash, duration: duration, offset: options.offset, track: options.track), words: words)
            let output = options.outputDirectory.appendingPathComponent("transcript.json")
            let data = try JSONEncoder().encode(document)
            guard data.count <= 32 * 1024 * 1024 else { throw CaptureFailure(code: "speech_capacity", message: "The transcript exceeds the 32 MiB result bound.") }
            try data.write(to: output, options: [.withoutOverwriting])
            try cancellation.check()
            ProtocolOutput.emit(["type": "completed", "output": output.path])
            return 0
        } catch is CancellationError {
            ProtocolOutput.emit(["type": "cancelled"]); return 130
        } catch {
            ProtocolOutput.error(error); return 1
        }
    }

    private static func digest(_ url: URL, _ cancellation: SpeechCancellation) throws -> String {
        let file = try FileHandle(forReadingFrom: url)
        defer { try? file.close() }
        var hash = SHA256()
        while let data = try file.read(upToCount: 1024 * 1024), !data.isEmpty { try cancellation.check(); hash.update(data: data) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
