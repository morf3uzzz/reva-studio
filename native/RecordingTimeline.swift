import Foundation
import CoreMedia

/// One host-clock mapping owns every captured track, cursor, and activity timestamp.
/// Keeping closed spans also rejects device buffers delivered late after a resume.
struct RecordingTimeline {
    struct Pause { let start: CMTime; var end: CMTime?; let removedBefore: CMTime }
    let anchor: CMTime
    private(set) var pauses: [Pause] = []
    var isPaused: Bool { pauses.last.map { $0.end == nil } ?? false }

    mutating func pause(at time: CMTime) throws {
        guard !isPaused else { return }
        guard pauses.count < 100_000 else { throw CaptureFailure(code: "pause_limit", message: "This recording reached the 100,000 pause metadata limit.") }
        let removed = pauses.last.map { CMTimeAdd($0.removedBefore, CMTimeSubtract($0.end!, $0.start)) } ?? .zero
        pauses.append(Pause(start: CMTimeMaximum(time, anchor), end: nil, removedBefore: removed))
    }

    mutating func resume(at time: CMTime) -> RecordingPause? {
        guard isPaused else { return nil }
        let index = pauses.count - 1, start = pauses[index].start
        let end = CMTimeMaximum(time, start)
        let position = elapsed(at: start)
        pauses[index].end = end
        return RecordingPause(time: position.seconds, duration: CMTimeSubtract(end, start).seconds)
    }

    func elapsed(at time: CMTime) -> CMTime {
        let index = lastPause(startingBeforeOrAt: time)
        guard let index else { return CMTimeMaximum(.zero, CMTimeSubtract(time, anchor)) }
        let pause = pauses[index]
        let end = pause.end.map { CMTimeMinimum(time, $0) } ?? time
        return CMTimeMaximum(.zero, CMTimeSubtract(CMTimeSubtract(time, anchor), CMTimeAdd(pause.removedBefore, CMTimeSubtract(end, pause.start))))
    }

    func sampleTime(at time: CMTime) -> CMTime? {
        guard time.isNumeric, CMTimeCompare(time, anchor) >= 0 else { return nil }
        if let index = lastPause(startingBeforeOrAt: time) {
            guard let end = pauses[index].end, CMTimeCompare(time, end) >= 0 else { return nil }
        }
        return elapsed(at: time)
    }

    /// Active portions of an audio buffer, excluding both historical and open pauses.
    func activeRanges(from start: CMTime, to end: CMTime) -> [CMTimeRange] {
        var cursor = CMTimeMaximum(start, anchor)
        guard CMTimeCompare(cursor, end) < 0 else { return [] }
        var result: [CMTimeRange] = []
        var index = lastPause(startingBeforeOrAt: cursor) ?? 0
        while index < pauses.count {
            let pause = pauses[index]
            if CMTimeCompare(pause.start, end) >= 0 { break }
            if let pauseEnd = pause.end, CMTimeCompare(pauseEnd, cursor) <= 0 { index += 1; continue }
            if CMTimeCompare(pause.start, cursor) > 0 { result.append(CMTimeRange(start: cursor, end: pause.start)) }
            guard let pauseEnd = pause.end else { return result }
            cursor = CMTimeMaximum(cursor, pauseEnd)
            if CMTimeCompare(cursor, end) >= 0 { return result }
            index += 1
        }
        result.append(CMTimeRange(start: cursor, end: end))
        return result
    }

    private func lastPause(startingBeforeOrAt time: CMTime) -> Int? {
        var lower = 0, upper = pauses.count
        while lower < upper {
            let middle = (lower + upper) / 2
            if CMTimeCompare(pauses[middle].start, time) <= 0 { lower = middle + 1 } else { upper = middle }
        }
        return lower == 0 ? nil : lower - 1
    }
}

struct RecordingPause: Encodable { let type = "pause"; let time: Double; let duration: Double }
struct RecordingTypingSample: Encodable { let type = "typing"; let time: Double; let count: UInt32 }
struct RecordingState: Encodable { let type = "state"; let status: String; let elapsedMs: Double }

/// Counter deltas preserve activity only. No key code, character, or modifier is read.
struct TypingCounter {
    private var previous: UInt32?
    mutating func reset(to count: UInt32) { previous = count }
    mutating func observe(_ count: UInt32, time: Double) -> RecordingTypingSample? {
        defer { previous = count }
        guard let previous, count != previous else { return nil }
        // A WindowServer counter reset is not a typing burst; wrapping is equally
        // ambiguous, so do not invent activity at that boundary.
        guard count > previous else { return nil }
        return RecordingTypingSample(time: time, count: count - previous)
    }
}
