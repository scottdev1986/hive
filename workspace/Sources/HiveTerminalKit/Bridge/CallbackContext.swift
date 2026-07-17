import Foundation

/// §23 bridge event types (hive_ghostty_event_e).
public enum BridgeEventType: Int32, Equatable, Sendable {
    case invalidate = 1
    case title = 2
    case pwd = 3
    case bell = 4
    case clipboardDenied = 5
    case closeRequest = 6
}

public struct BridgeEvent: Equatable, Sendable {
    public var type: BridgeEventType
    public var bytes: Data

    public init(type: BridgeEventType, bytes: Data = Data()) {
        self.type = type
        self.bytes = bytes
    }
}

/// MEMORY-SAFETY-SENSITIVE Swift↔C callback boundary (§23).
///
/// Bridge callbacks are **non-reentrant** and **main-thread-confined**.
/// Pointers/`bytes` fields are valid **only for the duration of the call**.
/// This context **always copies** write and event bytes synchronously before
/// returning to C — retaining a C pointer past return is undefined and is
/// proven unsafe by `CallbackDisciplineTests`.
public final class BridgeCallbackContext: @unchecked Sendable {
    public var onWrite: ((Data) -> Void)?
    public var onEvent: ((BridgeEvent) -> Void)?

    /// Re-entrancy guard: true while a trampoline is on the stack.
    private var inCallback = false
    private let lock = NSLock()

    public init() {}

    /// Synchronous write trampoline body. Copies `length` bytes from `bytes`
    /// before invoking `onWrite`. Must not call back into Ghostty.
    public func handleWrite(bytes: UnsafePointer<UInt8>?, length: Int) {
        enter()
        defer { leave() }
        let copy: Data
        if length > 0, let bytes {
            copy = Data(bytes: bytes, count: length)
        } else {
            copy = Data()
        }
        onWrite?(copy)
    }

    /// Synchronous event trampoline body. Copies event payload bytes before
    /// invoking `onEvent`. Must not call back into Ghostty.
    public func handleEvent(type: Int32, bytes: UnsafePointer<UInt8>?, length: Int) {
        enter()
        defer { leave() }
        guard let eventType = BridgeEventType(rawValue: type) else { return }
        let copy: Data
        if length > 0, let bytes {
            copy = Data(bytes: bytes, count: length)
        } else {
            copy = Data()
        }
        onEvent?(BridgeEvent(type: eventType, bytes: copy))
    }

    /// Unsafe reference retained for C `void *context` (unowned).
    public var unownedContextPointer: UnsafeMutableRawPointer {
        Unmanaged.passUnretained(self).toOpaque()
    }

    public static func fromContext(_ pointer: UnsafeMutableRawPointer?) -> BridgeCallbackContext? {
        guard let pointer else { return nil }
        return Unmanaged<BridgeCallbackContext>.fromOpaque(pointer).takeUnretainedValue()
    }

    private func enter() {
        lock.lock()
        precondition(!inCallback, "bridge callbacks are non-reentrant")
        inCallback = true
        lock.unlock()
    }

    private func leave() {
        lock.lock()
        inCallback = false
        lock.unlock()
    }
}

// MARK: - C trampolines (stable ABI entry points for the bridge)

/// C-compatible write callback: copies before return (§23).
public func hiveBridgeWriteTrampoline(
    context: UnsafeMutableRawPointer?,
    bytes: UnsafePointer<UInt8>?,
    length: Int
) {
    guard let ctx = BridgeCallbackContext.fromContext(context) else { return }
    ctx.handleWrite(bytes: bytes, length: length)
}

/// C-compatible event callback: copies before return (§23).
public func hiveBridgeEventTrampoline(
    context: UnsafeMutableRawPointer?,
    type: Int32,
    bytes: UnsafePointer<UInt8>?,
    length: Int
) {
    guard let ctx = BridgeCallbackContext.fromContext(context) else { return }
    ctx.handleEvent(type: type, bytes: bytes, length: length)
}
