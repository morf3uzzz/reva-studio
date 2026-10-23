import Foundation
import AppKit
import ApplicationServices

enum WindowUtilities {
    struct WindowSize: Encodable { let width: Double; let height: Double }
    struct DesktopState: Encodable {
        let value: Bool?
        private enum CodingKeys: String, CodingKey { case value }
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            if let value { try container.encode(value, forKey: .value) }
            else { try container.encodeNil(forKey: .value) }
        }
    }

    static func resize(_ arguments: [String]) throws -> WindowSize {
        var values: [String: String] = [:]
        var index = 0
        while index < arguments.count {
            guard ["--window-id", "--owner-pid", "--width", "--height"].contains(arguments[index]), index + 1 < arguments.count, values[arguments[index]] == nil else { throw CaptureFailure(code: "invalid_arguments", message: "Window resizing received an invalid option.") }
            values[arguments[index]] = arguments[index + 1]; index += 2
        }
        guard let id = UInt32(values["--window-id"] ?? ""), id > 0, let pid = Int32(values["--owner-pid"] ?? ""), pid > 0,
              let width = Double(values["--width"] ?? ""), let height = Double(values["--height"] ?? ""), width.isFinite, height.isFinite, width >= 150, height >= 150, width <= 16384, height <= 16384 else { throw CaptureFailure(code: "invalid_arguments", message: "Choose a window and a finite size between 150 and 16384 points.") }
        guard AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) else { throw CaptureFailure(code: "accessibility_permission_denied", message: "Allow REVA Studio capture helper in System Settings → Privacy & Security → Accessibility, then retry resizing the selected window.") }
        guard let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]], let source = windows.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id }), (source[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              let rawBounds = source[kCGWindowBounds as String] as? NSDictionary, let bounds = CGRect(dictionaryRepresentation: rawBounds) else { throw CaptureFailure(code: "window_identity_unknown", message: "The selected window is no longer available with its original owner.") }
        let app = AXUIElementCreateApplication(pid)
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &raw) == .success, let candidates = raw as? [AXUIElement] else { throw CaptureFailure(code: "window_not_accessible", message: "This application does not expose accessible windows.") }
        func position(_ element: AXUIElement) -> CGPoint? {
            var raw: CFTypeRef?, result = CGPoint.zero
            guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &raw) == .success, let raw, CFGetTypeID(raw) == AXValueGetTypeID(), AXValueGetValue(unsafeBitCast(raw, to: AXValue.self), .cgPoint, &result) else { return nil }
            return result
        }
        func windowSize(_ element: AXUIElement) -> CGSize? {
            var raw: CFTypeRef?, result = CGSize.zero
            guard AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &raw) == .success, let raw, CFGetTypeID(raw) == AXValueGetTypeID(), AXValueGetValue(unsafeBitCast(raw, to: AXValue.self), .cgSize, &result) else { return nil }
            return result
        }
        let matching = candidates.filter { window in
            guard let point = position(window), let size = windowSize(window) else { return false }
            return abs(point.x - bounds.minX) < 1 && abs(point.y - bounds.minY) < 1 && abs(size.width - bounds.width) < 1 && abs(size.height - bounds.height) < 1
        }
        guard matching.count == 1, let window = matching.first else { throw CaptureFailure(code: "window_identity_unknown", message: "The selected window could not be uniquely matched to an accessible window. No window was changed.") }
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(window, kAXSizeAttribute as CFString, &settable) == .success, settable.boolValue else { throw CaptureFailure(code: "window_not_resizable", message: "The selected application does not allow this window to be resized.") }
        var size = CGSize(width: width, height: height)
        guard let wrapped = AXValueCreate(.cgSize, &size), AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, wrapped) == .success else { throw CaptureFailure(code: "window_resize_failed", message: "The selected application rejected the requested window size.") }
        guard let actual = windowSize(window) else { throw CaptureFailure(code: "window_size_unknown", message: "The window was resized, but its resulting size could not be read.") }
        return WindowSize(width: actual.width, height: actual.height)
    }

    static func desktopValue() throws -> Bool? {
        let key = "CreateDesktop" as CFString, app = "com.apple.finder" as CFString
        guard let value = CFPreferencesCopyValue(key, app, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) else { return nil }
        guard CFGetTypeID(value) == CFBooleanGetTypeID() else { throw CaptureFailure(code: "desktop_setting_unknown", message: "Finder's desktop visibility setting is not a boolean. It was left unchanged.") }
        return (value as! NSNumber).boolValue
    }

    @MainActor static func desktop(_ arguments: [String]) async throws -> DesktopState {
        if arguments == ["get"] { return DesktopState(value: try desktopValue()) }
        guard arguments.count == 5, arguments[0] == "set", arguments[1] == "--value", arguments[3] == "--expected", ["true", "false", "absent"].contains(arguments[2]), ["true", "false", "absent"].contains(arguments[4]) else { throw CaptureFailure(code: "invalid_arguments", message: "Desktop visibility requires a value and its expected previous state.") }
        let expected: Bool? = arguments[4] == "absent" ? nil : arguments[4] == "true", desired: Bool? = arguments[2] == "absent" ? nil : arguments[2] == "true"
        guard try desktopValue() == expected else { throw CaptureFailure(code: "desktop_setting_changed", message: "Finder's desktop visibility changed outside REVA Studio. The current setting was preserved.") }
        let key = "CreateDesktop" as CFString, app = "com.apple.finder" as CFString
        CFPreferencesSetValue(key, desired.map { $0 as CFBoolean }, app, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        guard CFPreferencesSynchronize(app, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) else { throw CaptureFailure(code: "desktop_setting_failed", message: "Finder's desktop visibility could not be saved.") }
        guard let finder = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first else { return DesktopState(value: desired) }
        guard let url = finder.bundleURL, finder.terminate() else { throw CaptureFailure(code: "desktop_refresh_failed", message: "The visibility setting was saved, but Finder could not be refreshed. Restore the saved desktop state in REVA Studio.") }
        for _ in 0..<30 { if finder.isTerminated { break }; try await Task.sleep(nanoseconds: 100_000_000) }
        guard finder.isTerminated else { throw CaptureFailure(code: "desktop_refresh_failed", message: "Finder has not finished refreshing the desktop. The saved original visibility remains available for restoration.") }
        let configuration = NSWorkspace.OpenConfiguration(); configuration.activates = false
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: ()) }
            }
        }
        return DesktopState(value: desired)
    }
}
