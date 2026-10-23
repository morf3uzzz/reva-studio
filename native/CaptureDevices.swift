import Foundation
import AVFoundation
import CoreMediaIO

struct CaptureDeviceDescription: Encodable {
    let id: String
    let name: String
    let `default`: Bool
}

struct CaptureDeviceInventory: Encodable {
    let cameras: [CaptureDeviceDescription]
    let microphones: [CaptureDeviceDescription]
    let screenDevices: [CaptureScreenDeviceDescription]
    let screenDeviceIssue: String?
}

struct CaptureScreenDeviceDescription: Encodable {
    let id: String
    let name: String
    let `default` = false
    let width: Int
    let height: Int
}

struct CameraFormatSpec {
    struct Rate { let min: Double; let max: Double }
    let width: Int
    let height: Int
    let rates: [Rate]
}

enum CaptureDevices {
    static func authorization(_ type: AVMediaType) -> String {
        switch AVCaptureDevice.authorizationStatus(for: type) {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not-determined"
        @unknown default: return "unknown"
        }
    }
    @MainActor static func requestPermission(_ type: AVMediaType, cancellation: CaptureCancellation) async throws {
        try cancellation.check()
        let status = AVCaptureDevice.authorizationStatus(for: type)
        var granted = status == .authorized
        if status == .notDetermined { granted = await AVCaptureDevice.requestAccess(for: type) }
        try cancellation.check()
        let name = type == .video ? "camera" : "microphone"
        guard granted else {
            if AVCaptureDevice.authorizationStatus(for: type) == .restricted {
                throw CaptureFailure(code: "\(name)_permission_restricted", message: "Access to the \(name) is restricted by macOS. Check the device's privacy restrictions or administrator policy.")
            }
            throw CaptureFailure(code: "\(name)_permission_denied", message: "Allow \(name) access for Reva Studio in System Settings → Privacy & Security.")
        }
    }
    /// Discovery and format inspection do not call requestAccess or start a session.
    static func devices(_ type: AVMediaType) -> [AVCaptureDevice] {
        let kinds: [AVCaptureDevice.DeviceType] = type == .video
            ? [.builtInWideAngleCamera, .external, .continuityCamera, .deskViewCamera]
            : [.microphone, .external]
        return AVCaptureDevice.DiscoverySession(deviceTypes: kinds, mediaType: type, position: .unspecified).devices
    }

    static func list() -> CaptureDeviceInventory {
        func entries(_ type: AVMediaType) -> [CaptureDeviceDescription] {
            let defaultID = AVCaptureDevice.default(for: type)?.uniqueID
            var seen = Set<String>()
            return devices(type).filter { seen.insert($0.uniqueID).inserted }.map {
                CaptureDeviceDescription(id: $0.uniqueID, name: $0.localizedName, default: $0.uniqueID == defaultID)
            }.sorted { a, b in
                if a.default != b.default { return a.default }
                return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
            }
        }
        do {
            let screens = try screenDevices().map { device -> CaptureScreenDeviceDescription in
                let size = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
                return CaptureScreenDeviceDescription(id: device.uniqueID, name: device.localizedName, width: max(2, Int(size.width)), height: max(2, Int(size.height)))
            }
            return CaptureDeviceInventory(cameras: entries(.video), microphones: entries(.audio), screenDevices: screens, screenDeviceIssue: nil)
        } catch {
            return CaptureDeviceInventory(cameras: entries(.video), microphones: entries(.audio), screenDevices: [], screenDeviceIssue: error.localizedDescription)
        }
    }

    /// A muxed external source is distinct from a webcam/Continuity Camera.
    /// CoreMediaIO's opt-in is process-local; it does not change TCC or trust a device.
    static func screenDevices() throws -> [AVCaptureDevice] {
        var address = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices), mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal), mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
        var allowed: UInt32 = 1
        let status = CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &allowed)
        guard status == noErr else { throw CaptureFailure(code: "device_discovery_failed", message: "Cannot enable connected screen-device discovery (\(status)).") }
        var seen = Set<String>()
        return AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: .muxed, position: .unspecified).devices
            .filter { seen.insert($0.uniqueID).inserted }
            .sorted { $0.localizedName.localizedCaseInsensitiveCompare($1.localizedName) == .orderedAscending }
    }

    static func resolveScreen(id: String) throws -> AVCaptureDevice {
        guard let device = try screenDevices().first(where: { $0.uniqueID == id }) else {
            throw CaptureFailure(code: "device_unavailable", message: "The selected connected screen device is unavailable. Connect it directly by USB, unlock it, and complete the device's Trust prompt, then select it again.")
        }
        return device
    }

    static func configureScreen(_ device: AVCaptureDevice, fps: Int) throws {
        let choices = device.formats.enumerated().compactMap { index, format -> (Int, Int, Double, AVFrameRateRange)? in
            let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            let pixels = Int(size.width) * Int(size.height)
            guard size.width >= 2, size.height >= 2, size.width <= 16384, size.height <= 16384, pixels <= 33_554_432,
                  let rate = format.videoSupportedFrameRateRanges.min(by: { abs(min($0.maxFrameRate, max($0.minFrameRate, Double(fps))) - Double(fps)) < abs(min($1.maxFrameRate, max($1.minFrameRate, Double(fps))) - Double(fps)) }) else { return nil }
            return (index, pixels, min(rate.maxFrameRate, max(rate.minFrameRate, Double(fps))), rate)
        }
        guard let choice = choices.max(by: { $0.1 == $1.1 ? abs($0.2 - Double(fps)) > abs($1.2 - Double(fps)) : $0.1 < $1.1 }) else {
            let size = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
            guard size.width >= 2, size.height >= 2, Int(size.width) * Int(size.height) <= 33_554_432 else {
                throw CaptureFailure(code: "device_format_unavailable", message: "The connected device has no usable screen-video format.")
            }
            return
        }
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        device.activeFormat = device.formats[choice.0]
        let duration = CMTime(seconds: 1 / choice.2, preferredTimescale: 60_000)
        device.activeVideoMinFrameDuration = duration
        device.activeVideoMaxFrameDuration = duration
    }

    static func resolve(_ type: AVMediaType, id: String?) throws -> AVCaptureDevice {
        let device = id.flatMap { requested in devices(type).first { $0.uniqueID == requested } } ?? (id == nil ? AVCaptureDevice.default(for: type) : nil)
        guard let device else {
            let name = type == .video ? "camera" : "microphone"
            throw CaptureFailure(code: "\(name)_unavailable", message: id == nil ? "No default \(name) is connected." : "The selected \(name) is no longer connected. Choose an available device.")
        }
        return device
    }

    static func encodedCameraSize(width: Int, height: Int, maximumHeight: Int) -> (width: Int, height: Int)? {
        guard width >= 2, height >= 2, width <= 16384, height <= 16384,
              width * height <= 16_777_216, maximumHeight >= 2 else { return nil }
        let scale = min(1, Double(maximumHeight) / Double(height))
        return (max(2, Int((Double(width) * scale).rounded(.down)) / 2 * 2), max(2, Int((Double(height) * scale).rounded(.down)) / 2 * 2))
    }

    /// The height ceiling applies to encoded pixels, not device admission. Use
    /// the largest output, nearest supported rate to 30, then cheapest source.
    static func chooseFormat(_ formats: [CameraFormatSpec], maximumHeight: Int) -> (format: Int, range: Int, fps: Double)? {
        var best: (format: Int, range: Int, fps: Double, pixels: Int, sourcePixels: Int)?
        for (index, format) in formats.enumerated() {
            guard let output = encodedCameraSize(width: format.width, height: format.height, maximumHeight: maximumHeight) else { continue }
            for (range, rate) in format.rates.enumerated() {
                guard rate.min.isFinite, rate.max.isFinite, rate.min > 0, rate.max >= rate.min else { continue }
                let fps = max(rate.min, min(30, rate.max)), pixels = output.width * output.height, sourcePixels = format.width * format.height
                if best == nil || pixels > best!.pixels ||
                    (pixels == best!.pixels && abs(fps - 30) < abs(best!.fps - 30)) ||
                    (pixels == best!.pixels && abs(fps - 30) == abs(best!.fps - 30) && sourcePixels < best!.sourcePixels) {
                    best = (index, range, fps, pixels, sourcePixels)
                }
            }
        }
        return best.map { ($0.format, $0.range, $0.fps) }
    }

    /// Call after session inputs/outputs have been added, inside begin/commitConfiguration.
    /// macOS selects activeFormat directly; the inputPriority preset is iOS-only.
    static func configureCamera(_ device: AVCaptureDevice, maximumHeight: Int) throws {
        let formats = device.formats
        let specifications = formats.map { format -> CameraFormatSpec in
            let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            return CameraFormatSpec(width: Int(size.width), height: Int(size.height), rates: format.videoSupportedFrameRateRanges.map { .init(min: $0.minFrameRate, max: $0.maxFrameRate) })
        }
        guard let choice = chooseFormat(specifications, maximumHeight: maximumHeight) else {
            // Some virtual/Continuity sources do not declare configurable frame
            // rates. Preserve their usable current format and device timing.
            let active = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
            guard encodedCameraSize(width: Int(active.width), height: Int(active.height), maximumHeight: maximumHeight) != nil else {
                throw CaptureFailure(code: "camera_format_unavailable", message: "The selected camera has no usable video format within the 16-megapixel capture limit.")
            }
            return
        }
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        let format = formats[choice.format], range = format.videoSupportedFrameRateRanges[choice.range]
        device.activeFormat = format
        let duration = choice.fps == range.maxFrameRate ? range.minFrameDuration : choice.fps == range.minFrameRate ? range.maxFrameDuration : CMTime(value: 1, timescale: 30)
        device.activeVideoMinFrameDuration = duration
        device.activeVideoMaxFrameDuration = duration
    }
}
