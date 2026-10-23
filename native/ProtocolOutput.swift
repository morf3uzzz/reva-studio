import Foundation

enum ProtocolOutput {
    // Multiple device callbacks share one JSONL transport. A line is atomic even
    // when a camera frame and microphone event arrive on different queues.
    private static let lock = NSLock()
    static func emit<T: Encodable>(_ value: T) {
        lock.lock()
        defer { lock.unlock() }
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            var data = try encoder.encode(value)
            data.append(0x0a)
            try FileHandle.standardOutput.write(contentsOf: data)
        } catch {
            // Closing stdout is a caller disconnect. The stdin EOF/signal path still owns cleanup.
            try? FileHandle.standardError.write(contentsOf: Data("Cannot write capture protocol: \(error.localizedDescription)\n".utf8))
        }
    }

    static func error(_ error: Error) {
        let failure = error as? CaptureFailure ?? CaptureFailure(code: "capture_failed", message: CaptureFailure.describe(error))
        emit(["type": "error", "code": failure.code, "message": failure.message])
    }
}
