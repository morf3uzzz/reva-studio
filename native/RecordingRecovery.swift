import Foundation
import Darwin

struct RecordingRecovery: Encodable {
    let schemaVersion = 1
    let type = "reva-recording-recovery"
    let id: String
    let createdAt: String
    var updatedAt: String
    var status: String
    let source: String
    let output: String
    let cursorOutput: String
    let activityOutput: String
    let cameraPath: String?
    let microphonePath: String?
    let fps: Int
    var width: Int
    var height: Int
    var duration: Double
    var cursorPrefixBytes: UInt64
    var activityPrefixBytes: UInt64
    var cameraStartTime: Double?
    var error: String?
}

/// Confined to the recording sample queue. The journal is atomically replaced
/// only after cursor/activity prefixes have been synchronized to storage.
final class RecordingRecoveryJournal {
    let url: URL
    private var value: RecordingRecovery
    private let encoder: JSONEncoder

    init(options: CaptureOptions, width: Int, height: Int) throws {
        url = options.recoveryOutput
        let now = ISO8601DateFormatter().string(from: Date())
        value = RecordingRecovery(id: UUID().uuidString, createdAt: now, updatedAt: now, status: "recording", source: options.source,
                                  output: options.output.path, cursorOutput: options.cursorOutput.path, activityOutput: options.activityOutput.path,
                                  cameraPath: options.camera ? options.cameraOutput.path : nil, microphonePath: options.microphone ? options.microphoneOutput.path : nil,
                                  fps: options.fps, width: width, height: height, duration: 0, cursorPrefixBytes: 1, activityPrefixBytes: 1, cameraStartTime: nil, error: nil)
        encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw CaptureFailure(code: "recovery_journal_failed", message: "Cannot create recording recovery journal: \(String(cString: strerror(errno)))") }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        do {
            try handle.write(contentsOf: encoder.encode(value))
            try handle.synchronize()
            try handle.close()
        } catch {
            try? handle.close()
            throw error
        }
    }

    func checkpoint(duration: Double, width: Int, height: Int, cursor: UInt64, activity: UInt64, cameraStartTime: Double? = nil, status: String = "recording", error: String? = nil) throws {
        value.duration = max(0, duration)
        value.width = width; value.height = height
        value.cursorPrefixBytes = cursor; value.activityPrefixBytes = activity
        value.cameraStartTime = cameraStartTime
        value.updatedAt = ISO8601DateFormatter().string(from: Date())
        value.status = status; value.error = error
        try encoder.encode(value).write(to: url, options: .atomic)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.synchronize()
    }
}
