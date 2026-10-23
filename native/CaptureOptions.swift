import Foundation
import CoreGraphics
import Darwin

struct CaptureFailure: Error, LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }

    /// Keep native error identity and its underlying cause at the protocol boundary.
    /// localizedDescription alone often reduces codec failures to a generic sentence.
    static func describe(_ error: Error) -> String {
        if let failure = error as? CaptureFailure { return failure.message }
        var parts: [String] = []
        var current: NSError? = error as NSError
        var seen = Set<ObjectIdentifier>()
        while let value = current, parts.count < 4, seen.insert(ObjectIdentifier(value)).inserted {
            var detail = "\(value.localizedDescription) [\(value.domain) \(value.code)]"
            if let reason = value.localizedFailureReason, reason != value.localizedDescription { detail += " \(reason)" }
            parts.append(String(detail.prefix(2048)))
            current = value.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return parts.joined(separator: " → ")
    }
}

final class CaptureCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    func check() throws {
        lock.lock()
        let value = cancelled
        lock.unlock()
        if value { throw CaptureFailure(code: "recording_cancelled", message: "Recording was cancelled before it became ready.") }
    }
}

struct CaptureOptions {
    let source: String
    let output: URL
    let cursorOutput: URL
    let fps: Int
    let systemAudio: Bool
    let microphone: Bool
    let camera: Bool
    let area: CGRect?
    let cameraDeviceID: String?
    let microphoneDeviceID: String?
    let cameraMaxResolution: Int
    let previewCamera: Bool
    let monitorMicrophone: Bool
    let excludedProcessID: pid_t?
    let systemAudioApplications: [String]?
    let recordShortcuts: Bool

    var activityOutput: URL { output.deletingPathExtension().appendingPathExtension("activity.json") }
    var cameraOutput: URL { output.deletingPathExtension().appendingPathExtension("camera.mp4") }
    var microphoneOutput: URL { output.deletingPathExtension().appendingPathExtension("microphone.m4a") }
    var recoveryOutput: URL { output.deletingPathExtension().appendingPathExtension("recovery.json") }
    var screenDeviceID: String? { source.hasPrefix("device:") ? String(source.dropFirst(7)) : nil }

    static func parse(_ arguments: [String]) throws -> CaptureOptions {
        let names: Set<String> = ["source", "output", "cursor-output", "fps", "system-audio", "microphone", "camera", "area", "camera-device-id", "microphone-device-id", "camera-max-resolution", "preview-camera", "monitor-microphone", "exclude-process-id", "audio-applications", "record-shortcuts"]
        var values: [String: String] = [:]
        var index = 0
        while index < arguments.count {
            let flag = arguments[index]
            guard flag.hasPrefix("--"), names.contains(String(flag.dropFirst(2))), index + 1 < arguments.count else {
                throw CaptureFailure(code: "invalid_arguments", message: "Unknown option or missing value: \(flag)")
            }
            let name = String(flag.dropFirst(2))
            guard values[name] == nil else { throw CaptureFailure(code: "invalid_arguments", message: "Duplicate option: \(flag)") }
            values[name] = arguments[index + 1]
            index += 2
        }
        func required(_ name: String) throws -> String {
            guard let value = values[name], !value.isEmpty else {
                throw CaptureFailure(code: "invalid_arguments", message: "Missing --\(name).")
            }
            return value
        }
        func path(_ name: String) throws -> URL {
            let value = try required(name)
            guard value.hasPrefix("/"), !value.utf8.contains(0) else {
                throw CaptureFailure(code: "invalid_arguments", message: "--\(name) must be an absolute filesystem path.")
            }
            // Preserve protocol paths, including the caller's /private prefix.
            return URL(fileURLWithPath: value)
        }
        func boolean(_ name: String) throws -> Bool {
            switch values[name] ?? "false" {
            case "true": return true
            case "false": return false
            default: throw CaptureFailure(code: "invalid_arguments", message: "--\(name) must be true or false.")
            }
        }
        let source = try required("source")
        let components = source.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard components.count == 2, !components[1].isEmpty, !source.utf8.contains(0),
              (components[0] == "device" || (["display", "window"].contains(String(components[0])) && UInt32(components[1]).map { $0 > 0 } == true)) else {
            throw CaptureFailure(code: "invalid_arguments", message: "--source must be display:ID, window:ID, or device:DEVICE_ID.")
        }
        var audioApplications: [String]?
        if let text = values["audio-applications"] {
            guard let data = text.data(using: .utf8), let identifiers = try? JSONDecoder().decode([String].self, from: data),
                  !identifiers.isEmpty, identifiers.allSatisfy({ !$0.isEmpty && !$0.utf8.contains(0) }),
                  Set(identifiers).count == identifiers.count else {
                throw CaptureFailure(code: "invalid_arguments", message: "--audio-applications must be a nonempty JSON array of distinct application bundle identifiers. Omit it to capture all applications.")
            }
            guard components[0] != "device" else {
                throw CaptureFailure(code: "invalid_arguments", message: "A connected-device recording captures that device's audio; Mac application audio selection applies to display and window sources.")
            }
            audioApplications = identifiers
        }
        guard let fps = Int(values["fps"] ?? "30"), [24, 30, 60].contains(fps) else {
            throw CaptureFailure(code: "invalid_arguments", message: "--fps must be 24, 30, or 60.")
        }
        guard let cameraMaxResolution = Int(values["camera-max-resolution"] ?? "1080"), [720, 1080, 2160].contains(cameraMaxResolution) else {
            throw CaptureFailure(code: "invalid_arguments", message: "--camera-max-resolution must be 720, 1080, or 2160.")
        }
        func deviceID(_ name: String) throws -> String? {
            guard let value = values[name] else { return nil }
            guard !value.isEmpty, !value.utf8.contains(0) else { throw CaptureFailure(code: "invalid_arguments", message: "--\(name) must be a nonempty device identity.") }
            return value
        }
        var area: CGRect?
        if let text = values["area"] {
            guard components[0] != "device" else { throw CaptureFailure(code: "invalid_arguments", message: "Select a display or window to record a cropped area. Connected devices record their complete screen.") }
            let components = text.split(separator: ",", omittingEmptySubsequences: false)
            let numbers = components.compactMap { Double($0) }
            guard numbers.count == 4, numbers.allSatisfy({ $0.isFinite }), numbers[0] >= 0, numbers[1] >= 0,
                  numbers[2] > 0, numbers[3] > 0 else {
                throw CaptureFailure(code: "invalid_arguments", message: "--area must be finite x,y,width,height in logical points with positive size and nonnegative origin.")
            }
            area = CGRect(x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3])
        }
        let options = try CaptureOptions(source: source, output: path("output"), cursorOutput: path("cursor-output"), fps: fps,
                                         systemAudio: boolean("system-audio"), microphone: boolean("microphone"), camera: boolean("camera"), area: area,
                                         cameraDeviceID: deviceID("camera-device-id"), microphoneDeviceID: deviceID("microphone-device-id"),
                                         cameraMaxResolution: cameraMaxResolution, previewCamera: boolean("preview-camera"), monitorMicrophone: boolean("monitor-microphone"),
                                         excludedProcessID: processID(values["exclude-process-id"]), systemAudioApplications: audioApplications,
                                         recordShortcuts: boolean("record-shortcuts"))
        guard !options.previewCamera || options.camera, !options.monitorMicrophone || options.microphone else {
            throw CaptureFailure(code: "invalid_arguments", message: "Camera preview and microphone metering require their corresponding recording input.")
        }
        guard options.screenDeviceID == nil || !options.recordShortcuts else {
            throw CaptureFailure(code: "invalid_arguments", message: "Mac keyboard shortcut recording applies to Mac display/window sources, not a connected device's keyboard.")
        }
        guard options.output.pathExtension.lowercased() == "mp4" else {
            throw CaptureFailure(code: "invalid_arguments", message: "--output must have an .mp4 extension.")
        }
        let paths = [options.output, options.cursorOutput, options.activityOutput, options.recoveryOutput] + (options.camera ? [options.cameraOutput] : []) + (options.microphone ? [options.microphoneOutput] : [])
        guard Set(paths.map { $0.standardizedFileURL.path }).count == paths.count else {
            throw CaptureFailure(code: "invalid_arguments", message: "Recording, cursor, microphone, and camera paths must be distinct.")
        }
        for url in paths where FileManager.default.fileExists(atPath: url.path) {
            throw CaptureFailure(code: "output_exists", message: "Refusing to overwrite existing file: \(url.path)")
        }
        return options
    }

    static func processID(_ value: String?) throws -> pid_t? {
        guard let value else { return nil }
        guard let pid = Int32(value), pid > 0 else { throw CaptureFailure(code: "invalid_arguments", message: "--exclude-process-id must be a positive process ID.") }
        return pid
    }
}

struct CursorPoint: Encodable {
    let t: Double
    let x: Double
    let y: Double
    let click: Bool
    let visible: Bool
    let event: CursorEvent?
    let button: CursorButton?
}

enum CursorEvent: String, Encodable { case mouseMoved, mouseDragged, mouseDown, mouseUp }
enum CursorButton: String, Encodable, CaseIterable { case left, right, center }

/// Poll-derived transitions, not an event tap. A button held before startup has
/// no observed down and therefore cannot produce an invented up. Compound changes
/// within one poll remain unclassified rather than guessing their order.
struct CursorPollState {
    private var previousPoint: CGPoint?
    private var previousButtons: Set<CursorButton>?
    private var observedDown = Set<CursorButton>()

    mutating func observe(point: CGPoint, buttons: Set<CursorButton>, inside: Bool) -> (event: CursorEvent?, button: CursorButton?) {
        defer { previousPoint = point; previousButtons = buttons }
        guard let previousButtons else { return (nil, nil) }
        let down = buttons.subtracting(previousButtons), up = previousButtons.subtracting(buttons)
        let knownUp = up.intersection(observedDown)
        observedDown.subtract(up)
        if inside { observedDown.formUnion(down) }
        if down.count + up.count == 1 {
            if inside, let button = down.first { return (.mouseDown, button) }
            if let button = knownUp.first { return (.mouseUp, button) }
        } else if !down.isEmpty || !up.isEmpty { return (nil, nil) }
        if inside, previousPoint != point {
            if buttons.isEmpty { return (.mouseMoved, nil) }
            if buttons.count == 1 { return (.mouseDragged, buttons.first) }
        }
        return (nil, nil)
    }
}

enum CaptureGeometry {
    static func crop(_ area: CGRect?, sourceSize: CGSize) throws -> CGRect {
        let bounds = CGRect(origin: .zero, size: sourceSize)
        let crop = area ?? bounds
        guard sourceSize.width.isFinite, sourceSize.height.isFinite, sourceSize.width > 0, sourceSize.height > 0,
              crop.width > 0, crop.height > 0, bounds.contains(crop) else {
            throw CaptureFailure(code: "invalid_area", message: "The selected area must be entirely inside the source's logical bounds.")
        }
        return crop
    }

    static func pixels(_ points: CGFloat, scale: CGFloat) throws -> Int {
        let value = (points * scale / 2).rounded(.down) * 2
        guard value.isFinite, value >= 2, value <= 16384 else {
            throw CaptureFailure(code: "unsupported_dimensions", message: "The selected source must produce even video dimensions from 2 to 16384 pixels per side.")
        }
        return Int(value)
    }

    static func cursor(point: CGPoint, bounds: CGRect, destination: CGRect = CGRect(x: 0, y: 0, width: 1, height: 1), t: Double, pressed: Bool, event: CursorEvent? = nil, button: CursorButton? = nil) -> CursorPoint {
        let inside = bounds.width > 0 && bounds.height > 0 && bounds.contains(point)
        let localX = bounds.width > 0 ? (point.x - bounds.minX) / bounds.width : 0
        let localY = bounds.height > 0 ? (point.y - bounds.minY) / bounds.height : 0
        let x = min(1, max(0, destination.minX + localX * destination.width))
        let y = min(1, max(0, destination.minY + localY * destination.height))
        return CursorPoint(t: max(0, t), x: x, y: y, click: inside && pressed, visible: inside, event: event, button: button)
    }
}
