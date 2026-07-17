import Foundation
import HiveGhosttyC

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
/// returning to C.
///
/// ## Lifetime (M2)
/// The C surface holds an **unowned** raw pointer to this context for the
/// surface's lifetime. `GhosttyManualSurface` **must** retain this context
/// for as long as the C surface is alive (and free the surface before the
/// context can deinit). Using `passUnretained` is intentional: ownership is
/// on the Swift side; C must never free the context. If the wrapper deinits
/// while the C surface still holds the pointer, the next callback is a UAF —
/// tests construct a real surface and assert the owner keeps the context.
public final class BridgeCallbackContext: @unchecked Sendable {
    public var onWrite: ((Data) -> Void)?
    public var onEvent: ((BridgeEvent) -> Void)?

    /// Re-entrancy guard: true while a trampoline is on the stack.
    private(set) var inCallback = false
    private let lock = NSLock()

    public init() {}

    /// Synchronous write body. Copies `length` bytes from `bytes` before
    /// invoking `onWrite`. Must not call back into Ghostty.
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

    /// Synchronous event body from a `hive_ghostty_event_s *` (§23 ABI).
    /// Unpacks type/bytes/length and copies payload before return.
    public func handleEvent(_ event: UnsafePointer<hive_ghostty_event_s>?) {
        enter()
        defer { leave() }
        guard let event else { return }
        let value = event.pointee
        guard let eventType = BridgeEventType(rawValue: Int32(value.type.rawValue)) else { return }
        let copy: Data
        if value.length > 0, let bytes = value.bytes {
            copy = Data(bytes: bytes, count: value.length)
        } else {
            copy = Data()
        }
        onEvent?(BridgeEvent(type: eventType, bytes: copy))
    }

    /// Unowned context pointer for C `void *` (lifetime owned by Swift wrapper).
    public var unownedContextPointer: UnsafeMutableRawPointer {
        Unmanaged.passUnretained(self).toOpaque()
    }

    public static func fromContext(_ pointer: UnsafeMutableRawPointer?) -> BridgeCallbackContext? {
        guard let pointer else { return nil }
        return Unmanaged<BridgeCallbackContext>.fromOpaque(pointer).takeUnretainedValue()
    }

    /// Visible for re-entrancy positive-control tests.
    public var isInCallback: Bool {
        lock.lock()
        defer { lock.unlock() }
        return inCallback
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

// MARK: - C trampolines typed against hive_ghostty_bridge.h (M1/B1)

/// Write trampoline: matches `hive_ghostty_write_fn` exactly.
public let hiveBridgeWriteTrampoline: hive_ghostty_write_fn = { context, bytes, length in
    guard let ctx = BridgeCallbackContext.fromContext(context) else { return }
    ctx.handleWrite(bytes: bytes, length: Int(length))
}

/// Event trampoline: matches `hive_ghostty_event_fn` — **two** params
/// `(void *context, const hive_ghostty_event_s *event)`. Unpacks the struct
/// inside; never takes flattened type/bytes/length (B1).
public let hiveBridgeEventTrampoline: hive_ghostty_event_fn = { context, event in
    guard let ctx = BridgeCallbackContext.fromContext(context) else { return }
    ctx.handleEvent(event)
}
