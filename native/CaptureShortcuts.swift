import Foundation
import CoreGraphics

struct RecordingFlag: Encodable {
    let type = "flag"
    let time: Double
    let id: String
}

struct RecordingShortcut: Encodable {
    let type = "shortcut"
    let time: Double
    let keys: [String]
    let keyCode: Int
}

/// Records command identities only. No event Unicode/string data is read and
/// ordinary unmodified printable keys are excluded even when capture is enabled.
enum CaptureShortcutKeys {
    private static let printable: [UInt16: String] = [
        0:"A",1:"S",2:"D",3:"F",4:"H",5:"G",6:"Z",7:"X",8:"C",9:"V",11:"B",12:"Q",13:"W",14:"E",15:"R",16:"Y",17:"T",
        18:"1",19:"2",20:"3",21:"4",22:"6",23:"5",24:"=",25:"9",26:"7",27:"-",28:"8",29:"0",30:"]",31:"O",32:"U",33:"[",34:"I",35:"P",
        37:"L",38:"J",39:"'",40:"K",41:";",42:"\\",43:",",44:"/",45:"N",46:"M",47:".",49:"Space",50:"`"
    ]
    private static let special: [UInt16: String] = [
        36:"Return",48:"Tab",51:"Backspace",53:"Escape",76:"Return",96:"F5",97:"F6",98:"F7",99:"F3",100:"F8",101:"F9",103:"F11",105:"F13",106:"F16",107:"F14",109:"F10",111:"F12",113:"F15",114:"Insert",115:"Home",116:"PageUp",117:"Delete",118:"F4",119:"End",120:"F2",121:"PageDown",122:"F1",123:"ArrowLeft",124:"ArrowRight",125:"ArrowDown",126:"ArrowUp"
    ]

    static func keys(code: UInt16, flags: CGEventFlags, autorepeat: Bool) -> [String]? {
        guard !autorepeat else { return nil }
        let modifiers: [(CGEventFlags, String)] = [(.maskControl,"control"),(.maskAlternate,"option"),(.maskShift,"shift"),(.maskCommand,"command")]
        let hasCommand = !flags.intersection([.maskControl,.maskAlternate,.maskCommand]).isEmpty
        guard let key = special[code] ?? (hasCommand ? printable[code] : nil) else { return nil }
        return modifiers.compactMap { flags.contains($0.0) ? $0.1 : nil } + [key]
    }
}

@MainActor final class CaptureShortcutMonitor {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private let receive: @Sendable ([String], Int) -> Void

    init(receive: @escaping @Sendable ([String], Int) -> Void) { self.receive = receive }

    func start() throws {
        guard CGPreflightListenEventAccess() || CGRequestListenEventAccess() else {
            throw CaptureFailure(code: "keyboard_permission_denied", message: "Allow Input Monitoring for REVA Studio to record shortcut labels, or turn off shortcut capture. Ordinary typing text is never recorded.")
        }
        let context = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                         eventsOfInterest: CGEventMask(1) << CGEventType.keyDown.rawValue,
                                         callback: { _, type, event, info in
            guard let info else { return Unmanaged.passUnretained(event) }
            let monitor = Unmanaged<CaptureShortcutMonitor>.fromOpaque(info).takeUnretainedValue()
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                MainActor.assumeIsolated { if let tap = monitor.tap { CGEvent.tapEnable(tap: tap, enable: true) } }
                return Unmanaged.passUnretained(event)
            }
            let code = UInt16(clamping: event.getIntegerValueField(.keyboardEventKeycode))
            if let keys = CaptureShortcutKeys.keys(code: code, flags: event.flags, autorepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0) {
                monitor.receive(keys, Int(code))
            }
            return Unmanaged.passUnretained(event)
        }, userInfo: context) else {
            throw CaptureFailure(code: "keyboard_monitor_unavailable", message: "The shortcut monitor could not start. Check Input Monitoring access or turn off shortcut capture.")
        }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            throw CaptureFailure(code: "keyboard_monitor_unavailable", message: "Cannot create the shortcut monitor's event source.")
        }
        self.tap = tap; self.source = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    func stop() {
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        source = nil; tap = nil
    }
}
