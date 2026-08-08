import Foundation
import HiveGhosttyC

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

/// MEMORY-SAFETY-SENSITIVE Swift↔C callback boundary. Pointers are valid only
/// for the call, so bytes are copied before input is forwarded or UI events are
/// deferred. The Swift surface owns this context for the C surface's lifetime.
final class BridgeCallbackContext: @unchecked Sendable {
    private var writeHandler: ((Data) -> Void)?
    private var eventHandler: ((BridgeEvent) -> Void)?
    private var rendererHealthHandler: ((RendererHealth) -> Void)?
    private var actionNotificationHandler: ((HiveTerminalActionNotification) -> Void)?
    private var acceptingCallbacks = true
    private var activeCallbacks = 0
    private let condition = NSCondition()
    private var invalidateDeliveryPending = false
    private(set) var invalidateDeliveryCount = 0

    /// Test seam: production leaves this nil. Runs inside the admitted copy scope so teardown-vs-callback ordering can be proved without a timing-dependent oversized allocation.
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

    /// Copies and forwards encoder output on Ghostty's I/O thread, matching a
    /// normal terminal's direct I/O path. The handler may enqueue bytes only;
    /// it must not call back into Ghostty.
    func handleWrite(bytes: UnsafePointer<UInt8>?, length: Int) {
        guard enter() else { return }
        callbackCopyObserver?()
        let copy: Data
        if length > 0, let bytes {
            copy = Data(bytes: bytes, count: length)
        } else {
            copy = Data()
        }
        condition.lock()
        let handler = acceptingCallbacks ? writeHandler : nil
        condition.unlock()
        leave()
        handler?(copy)
    }

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

    var unownedContextPointer: UnsafeMutableRawPointer {
        Unmanaged.passUnretained(self).toOpaque()
    }

    static func fromContext(_ pointer: UnsafeMutableRawPointer?) -> BridgeCallbackContext? {
        guard let pointer else { return nil }
        return Unmanaged<BridgeCallbackContext>.fromOpaque(pointer).takeUnretainedValue()
    }

    var isInCallback: Bool {
        condition.lock()
        defer { condition.unlock() }
        return activeCallbacks > 0
    }

    /// Close callback admission before the owning surface is freed. Any already-queued delivery observes the closed state and self-drops.
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

    /// Fake-engine seam: uses the same deferred delivery discipline without manufacturing an unsafe C pointer. INVALIDATE is the one high-frequency event here: it arrives once per parsed chunk, from whichever thread is parsing. Posting each one puts a block on the main queue that the next keystroke queues behind, so redundant ones collapse into the delivery already pending — INVALIDATE carries no payload and its host handler is idempotent (schedule a draw, mark the accessibility cache dirty), so one delivery covers any number of them. Every other event type is rare and carries payload, so it posts normally and keeps its exact multiplicity. Measured with 32 live panes each flooding a real zsh through a real PTY (`prototypes/terminal`, 3 runs per arm): 2.45M INVALIDATEs became 70k main-queue deliveries. On its own that moved main-queue scheduling latency — what a keystroke waits behind — from p50 9.5 / p99 13.0 ms to p50 9.4 / p99 12.5 ms; together with the on-demand accessibility export in `HiveTerminalView+Accessibility.schedule(_:)`, p50 7.4 / p99 10.1 ms. The pending flag clears BEFORE the handler runs, so an INVALIDATE that arrives while the handler is executing still queues a fresh delivery.
    func enqueueEvent(_ event: BridgeEvent) {
        if event.type == .invalidate {
            condition.lock()
            let alreadyPending = invalidateDeliveryPending
            invalidateDeliveryPending = true
            condition.unlock()
            if alreadyPending { return }
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.condition.lock()
            if event.type == .invalidate {
                self.invalidateDeliveryPending = false
                self.invalidateDeliveryCount += 1
            }
            let handler = self.acceptingCallbacks ? self.eventHandler : nil
            self.condition.unlock()
            handler?(event)
        }
    }

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

    public var onActionNotification: ((HiveTerminalActionNotification) -> Void)? {
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

    func enqueueActionNotification(_ note: HiveTerminalActionNotification) {
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

let hiveBridgeWriteTrampoline: hive_ghostty_write_fn = { context, bytes, length in
    guard let ctx = BridgeCallbackContext.fromContext(context) else { return }
    ctx.handleWrite(bytes: bytes, length: Int(length))
}

/// Event trampoline: matches `hive_ghostty_event_fn` — **two** params `(void *context, const hive_ghostty_event_s *event)`. Unpacks the struct inside; never takes flattened type/bytes/length.
let hiveBridgeEventTrampoline: hive_ghostty_event_fn = { context, event in
    guard let ctx = BridgeCallbackContext.fromContext(context) else { return }
    ctx.handleEvent(event)
}
