import Foundation
import HiveGhosttyC

/// §23 bridge event types (hive_ghostty_event_e).
enum BridgeEventType: Int32, Equatable, Sendable {
    case invalidate = 1
    case title = 2
    case pwd = 3
    case bell = 4
    case clipboardDenied = 5
    case closeRequest = 6
}

struct BridgeEvent: Equatable, Sendable {
    var type: BridgeEventType
    var bytes: Data

    init(type: BridgeEventType, bytes: Data = Data()) {
        self.type = type
        self.bytes = bytes
    }
}

public enum RendererHealth: Equatable, Sendable {
    case healthy
    case unhealthy
}

/// MEMORY-SAFETY-SENSITIVE Swift↔C callback boundary (§23).
///
/// C-facing callback bodies only copy and may overlap on native worker
/// threads; host handlers are delivered later on the serial main queue and
/// never re-enter Ghostty.
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
final class BridgeCallbackContext: @unchecked Sendable {
    private var writeHandler: ((Data) -> Void)?
    private var eventHandler: ((BridgeEvent) -> Void)?
    private var rendererHealthHandler: ((RendererHealth) -> Void)?
    private var actionNotificationHandler: ((HiveGhosttyActionNotification) -> Void)?
    private var acceptingCallbacks = true
    private var activeCallbacks = 0
    private let condition = NSCondition()

    /// Gate 3 test seam: production leaves this nil. Runs inside the admitted
    /// copy scope so teardown-vs-callback ordering can be proved without a
    /// timing-dependent oversized allocation.
    var callbackCopyObserver: (() -> Void)?

    var onWrite: ((Data) -> Void)? {
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

    var onEvent: ((BridgeEvent) -> Void)? {
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

    var onRendererHealth: ((RendererHealth) -> Void)? {
        get {
            condition.lock()
            defer { condition.unlock() }
            return rendererHealthHandler
        }
        set {
            condition.lock()
            rendererHealthHandler = acceptingCallbacks ? newValue : nil
            condition.unlock()
        }
    }

    init() {}

    /// Synchronous write body. Copies `length` bytes from `bytes` before
    /// returning. It never invokes host code or calls back into Ghostty while
    /// the native renderer mutex may be held.
    func handleWrite(bytes: UnsafePointer<UInt8>?, length: Int) {
        guard enter() else { return }
        callbackCopyObserver?()
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
    func handleEvent(_ event: UnsafePointer<hive_ghostty_event_s>?) {
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
    var unownedContextPointer: UnsafeMutableRawPointer {
        Unmanaged.passUnretained(self).toOpaque()
    }

    static func fromContext(_ pointer: UnsafeMutableRawPointer?) -> BridgeCallbackContext? {
        guard let pointer else { return nil }
        return Unmanaged<BridgeCallbackContext>.fromOpaque(pointer).takeUnretainedValue()
    }

    /// Visible for re-entrancy positive-control tests.
    var isInCallback: Bool {
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
        rendererHealthHandler = nil
        actionNotificationHandler = nil
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

    /// Surface-scoped action-callback seam. The C enum is copied to this
    /// Swift value before return; host delivery remains deferred to main.
    func enqueueRendererHealth(_ health: RendererHealth) {
        guard enter() else { return }
        leave()
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.condition.lock()
            let handler = self.acceptingCallbacks ? self.rendererHealthHandler : nil
            self.condition.unlock()
            handler?(health)
        }
    }

    /// Gate 9 observe-only action notifications (SELECTION_CHANGED /
    /// SCROLLBAR), same admission + main-deferral discipline as
    /// enqueueRendererHealth. The execution-time acceptingCallbacks recheck
    /// is the no-delivery-after-free guarantee (dylan review 2026-07-18).
    public var onActionNotification: ((HiveGhosttyActionNotification) -> Void)? {
        get {
            condition.lock()
            defer { condition.unlock() }
            return actionNotificationHandler
        }
        set {
            condition.lock()
            actionNotificationHandler = acceptingCallbacks ? newValue : nil
            condition.unlock()
        }
    }

    func enqueueActionNotification(_ note: HiveGhosttyActionNotification) {
        guard enter() else { return }
        leave()
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.condition.lock()
            let handler = self.acceptingCallbacks ? self.actionNotificationHandler : nil
            self.condition.unlock()
            handler?(note)
        }
    }

    private func enter() -> Bool {
        condition.lock()
        defer { condition.unlock() }
        guard acceptingCallbacks else { return false }
        activeCallbacks += 1
        return true
    }

    private func leave() {
        condition.lock()
        precondition(activeCallbacks > 0)
        activeCallbacks -= 1
        if activeCallbacks == 0 { condition.broadcast() }
        condition.unlock()
    }
}

// MARK: - C trampolines typed against hive_ghostty_bridge.h (M1/B1)

/// Write trampoline: matches `hive_ghostty_write_fn` exactly.
let hiveBridgeWriteTrampoline: hive_ghostty_write_fn = { context, bytes, length in
    guard let ctx = BridgeCallbackContext.fromContext(context) else { return }
    ctx.handleWrite(bytes: bytes, length: Int(length))
}

/// Event trampoline: matches `hive_ghostty_event_fn` — **two** params
/// `(void *context, const hive_ghostty_event_s *event)`. Unpacks the struct
/// inside; never takes flattened type/bytes/length (B1).
let hiveBridgeEventTrampoline: hive_ghostty_event_fn = { context, event in
    guard let ctx = BridgeCallbackContext.fromContext(context) else { return }
    ctx.handleEvent(event)
}
