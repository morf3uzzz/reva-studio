import AppKit
import AVFoundation
import ScreenCaptureKit

struct CaptureSource: Encodable {
    let id: String
    let name: String
    let kind: String
    let width: Int
    let height: Int
    let bounds: CaptureSourceBounds
    let ownerPID: pid_t?
    /// Front-to-back Quartz window order. Omitted when the window was not in that snapshot.
    let zIndex: Int?
}

struct CaptureSourceBounds: Encodable {
    let x: Double; let y: Double; let width: Double; let height: Double
    init(_ rect: CGRect) { x = rect.minX; y = rect.minY; width = rect.width; height = rect.height }
}

enum CaptureSources {
    static func permissions() -> [String: String] {
        // This API only reports whether access is currently usable. A false
        // result does not distinguish a first request, denial or stale grant.
        ["screen": CGPreflightScreenCaptureAccess() ? "granted" : "not-granted",
         "microphone": CaptureDevices.authorization(.audio), "camera": CaptureDevices.authorization(.video),
         "keyboard": CGPreflightListenEventAccess() ? "granted" : "not-granted"]
    }

    /// CoreGraphics can enumerate display geometry without presenting a TCC prompt.
    /// Window enumeration is performed only when permission has already been granted.
    @MainActor static func list(excludingProcessID: pid_t? = nil) async throws -> [CaptureSource] {
        let devices = (try? CaptureDevices.screenDevices())?.compactMap { device -> CaptureSource? in
            let size = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
            guard size.width > 0, size.height > 0 else { return nil }
            let bounds = CGRect(x: 0, y: 0, width: Int(size.width), height: Int(size.height))
            return CaptureSource(id: "device:\(device.uniqueID)", name: device.localizedName, kind: "device", width: Int(size.width), height: Int(size.height), bounds: CaptureSourceBounds(bounds), ownerPID: nil, zIndex: nil)
        } ?? []
        if !CGPreflightScreenCaptureAccess() {
            var count: UInt32 = 0
            guard CGGetActiveDisplayList(0, nil, &count) == .success else {
                throw CaptureFailure(code: "source_enumeration_failed", message: "Cannot enumerate active displays.")
            }
            var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
            guard CGGetActiveDisplayList(count, &displays, &count) == .success else {
                throw CaptureFailure(code: "source_enumeration_failed", message: "Cannot read active display identities.")
            }
            return displays.prefix(Int(count)).enumerated().map { index, identifier in
                let bounds = CGDisplayBounds(identifier)
                return CaptureSource(id: "display:\(identifier)", name: displayName(identifier, index: index), kind: "display", width: Int(bounds.width), height: Int(bounds.height), bounds: CaptureSourceBounds(bounds), ownerPID: nil, zIndex: nil)
            } + devices
        }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let displays = content.displays.enumerated().map { index, display in
            CaptureSource(id: "display:\(display.displayID)", name: displayName(display.displayID, index: index), kind: "display", width: Int(display.frame.width), height: Int(display.frame.height), bounds: CaptureSourceBounds(display.frame), ownerPID: nil, zIndex: nil)
        }
        let descriptions = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        var windowOrder: [CGWindowID: Int] = [:]
        for (index, description) in descriptions.enumerated() {
            if let identifier = (description[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
               windowOrder[identifier] == nil { windowOrder[identifier] = index }
        }
        let windows = content.windows.filter {
            $0.windowLayer == 0 && $0.frame.width > 1 && $0.frame.height > 1 && $0.owningApplication != nil
                && $0.owningApplication?.processID != getpid()
                && (excludingProcessID == nil || $0.owningApplication?.processID != excludingProcessID)
        }.map { window in
            let app = window.owningApplication?.applicationName ?? "Window"
            let title = window.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let owner = window.owningApplication?.processID
            return CaptureSource(id: "window:\(window.windowID)", name: title.isEmpty ? app : "\(app) — \(title)", kind: "window", width: Int(window.frame.width), height: Int(window.frame.height), bounds: CaptureSourceBounds(window.frame), ownerPID: owner.flatMap { $0 > 0 ? $0 : nil }, zIndex: windowOrder[window.windowID])
        }
        return displays + windows.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending } + devices
    }

    @MainActor static func audioApplications(excludingProcessID: pid_t? = nil) async throws -> [CaptureAudioApplication] {
        guard CGPreflightScreenCaptureAccess() else {
            throw CaptureFailure(code: "screen_permission_denied", message: "Allow Screen and System Audio Recording before selecting application audio.")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        var seen = Set<String>()
        return content.applications.filter { $0.processID != getpid() && $0.processID != excludingProcessID && !$0.bundleIdentifier.isEmpty && seen.insert($0.bundleIdentifier).inserted }
            .map { CaptureAudioApplication(id: $0.bundleIdentifier, name: $0.applicationName, processID: $0.processID) }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    @MainActor static func requestPermissions(_ options: CaptureOptions, cancellation: CaptureCancellation) async throws {
        try cancellation.check()
        guard options.screenDeviceID != nil || CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
            throw CaptureFailure(code: "screen_permission_denied", message: "Allow Screen Recording for Reva Studio in System Settings → Privacy & Security, then reopen the app and record again.")
        }
        for (enabled, type) in [(options.microphone, AVMediaType.audio), (options.camera || options.screenDeviceID != nil, AVMediaType.video)] where enabled {
            try await CaptureDevices.requestPermission(type, cancellation: cancellation)
        }
        try cancellation.check()
    }

    @MainActor private static func displayName(_ identifier: CGDirectDisplayID, index: Int) -> String {
        if let screen = NSScreen.screens.first(where: { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == identifier }) {
            return screen.localizedName
        }
        return "Display \(index + 1)"
    }
}

struct CaptureAudioApplication: Encodable {
    let id: String
    let name: String
    let processID: pid_t
}
