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
/// Bridge callbacks are **non-reentrant**. Their C-facing bodies only copy;
/// host handlers are delivered later on the main queue.
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
    private var writeHandler: ((Data) -> Void)?
    private var eventHandler: ((BridgeEvent) -> Void)?
    private var acceptingCallbacks = true
    private var activeCallbacks = 0
    private let condition = NSCondition()

    public var onWrite: ((Data) -> Void)? {
        get {
            condition.lock()
            defer { condition.unlock() }
            return writeHandler
        }
        set {
            condition.lock()
            writeHandler = acceptingCallbacks ? newValue : nil
            condition.unlock()
        }
    }

    public var onEvent: ((BridgeEvent) -> Void)? {
        get {
            condition.lock()
            defer { condition.unlock() }
            return eventHandler
        }
        set {
            condition.lock()
            eventHandler = acceptingCallbacks ? newValue : nil
            condition.unlock()
        }
    }

    public init() {}

    /// Synchronous write body. Copies `length` bytes from `bytes` before
    /// returning. It never invokes host code or calls back into Ghostty while
    /// the native renderer mutex may be held.
    public func handleWrite(bytes: UnsafePointer<UInt8>?, length: Int) {
        guard enter() else { return }
        let copy: Data
        if length > 0, let bytes {
            copy = Data(bytes: bytes, count: length)
        } else {
            copy = Data()
        }
        leave()
        enqueueWrite(copy)
    }

    /// Synchronous event body from a `hive_ghostty_event_s *` (§23 ABI).
    /// Unpacks type/bytes/length and copies payload before return.
    public func handleEvent(_ event: UnsafePointer<hive_ghostty_event_s>?) {
        guard enter() else { return }
        guard let event else {
            leave()
            return
        }
        let value = event.pointee
        guard let eventType = BridgeEventType(rawValue: Int32(value.type.rawValue)) else {
            leave()
            return
        }
        let copy: Data
        if value.length > 0, let bytes = value.bytes {
            copy = Data(bytes: bytes, count: value.length)
        } else {
            copy = Data()
        }
        leave()
        enqueueEvent(BridgeEvent(type: eventType, bytes: copy))
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
        condition.lock()
        defer { condition.unlock() }
        return activeCallbacks > 0
    }

    /// Close callback admission before the owning surface is freed. Any
    /// already-queued delivery observes the closed state and self-drops.
    func beginTeardown() {
        condition.lock()
        acceptingCallbacks = false
        while activeCallbacks > 0 {
            condition.wait()
        }
        writeHandler = nil
        eventHandler = nil
        condition.unlock()
    }

    /// Fake-engine seam: uses the same deferred delivery discipline without
    /// manufacturing an unsafe C pointer.
    func enqueueEvent(_ event: BridgeEvent) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.condition.lock()
            let handler = self.acceptingCallbacks ? self.eventHandler : nil
            self.condition.unlock()
            handler?(event)
        }
    }

    func enqueueWrite(_ bytes: Data) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.condition.lock()
            let handler = self.acceptingCallbacks ? self.writeHandler : nil
            self.condition.unlock()
            handler?(bytes)
        }
    }

    private func enter() -> Bool {
        condition.lock()
        defer { condition.unlock() }
        guard acceptingCallbacks else { return false }
        precondition(activeCallbacks == 0, "bridge callbacks are non-reentrant")
        activeCallbacks = 1
        return true
    }

    private func leave() {
        condition.lock()
        activeCallbacks = 0
        condition.broadcast()
        condition.unlock()
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
