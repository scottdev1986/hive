import AppKit
import Foundation
import HiveGhosttyC
import CryptoKit

/// GhosttyResult from hive_ghostty_bridge.h / result.zig.
public enum GhosttyBridgeResult: Int32, Equatable, Sendable {
    case success = 0
    case outOfMemory = -1
    case invalidValue = -2
    case outOfSpace = -3
    case noValue = -4

    public init(cResult: ghostty_result_e) {
        self = GhosttyBridgeResult(rawValue: cResult.rawValue) ?? .invalidValue
    }
}

/// L0 surface engine seam — production uses Ghostty; tests inject fakes.
public protocol ManualSurfaceEngine: AnyObject {
    var callbackContext: BridgeCallbackContext { get }
    var throughSeq: UInt64 { get }
    var surfaceHandle: ghostty_surface_t? { get }
    func processOutput(bytes: Data, streamSeq: UInt64) -> GhosttyBridgeResult
    func restoreCheckpoint(payload: Data, throughSeq: UInt64) -> GhosttyBridgeResult
    func setFocus(_ focused: Bool)
    func setSize(widthPx: UInt32, heightPx: UInt32)
    func draw()
    func refresh()
    func sendKey(_ key: ghostty_input_key_s) -> Bool
    func sendText(_ text: String)
    func sendPreedit(_ text: String)
    func sendMouseButton(
        state: ghostty_input_mouse_state_e,
        button: ghostty_input_mouse_button_e,
        mods: ghostty_input_mods_e
    ) -> Bool
    func sendMousePos(x: Double, y: Double, mods: ghostty_input_mods_e)
    func free()
}

/// In-process fake for L1/L2 logic tests that do not need the real C boundary.
public final class FakeManualSurface: ManualSurfaceEngine {
    public let callbackContext = BridgeCallbackContext()
    public private(set) var throughSeq: UInt64 = 0
    public var surfaceHandle: ghostty_surface_t? { nil }
    public private(set) var appliedRanges: [(streamSeq: UInt64, bytes: Data)] = []
    public private(set) var restored: [(throughSeq: UInt64, payload: Data)] = []
    public private(set) var focusCalls: [Bool] = []
    public private(set) var sizeCalls: [(UInt32, UInt32)] = []
    public private(set) var drawCount = 0
    public private(set) var freed = false
    public private(set) var textSent: [String] = []
    public private(set) var keysSent = 0

    private var committed: [(streamSeq: UInt64, bytes: Data, digest: Data)] = []

    public init() {}

    public func processOutput(bytes: Data, streamSeq: UInt64) -> GhosttyBridgeResult {
        if bytes.isEmpty { return .invalidValue }
        let digest = sha256(bytes)
        let end = streamSeq + UInt64(bytes.count)
        if let existing = committed.first(where: { $0.streamSeq == streamSeq && $0.bytes.count == bytes.count }) {
            return existing.digest == digest ? .success : .invalidValue
        }
        if end <= throughSeq {
            // Fully behind without stored match: engine treats as invalid;
            // applicator may ignore as at-least-once retransmit (M7).
            return .invalidValue
        }
        if streamSeq != throughSeq {
            return .invalidValue
        }
        committed.append((streamSeq, bytes, digest))
        appliedRanges.append((streamSeq, bytes))
        throughSeq = end
        // Simulate invalidate event like the real bridge.
        callbackContext.onEvent?(BridgeEvent(type: .invalidate))
        return .success
    }

    public func restoreCheckpoint(payload: Data, throughSeq: UInt64) -> GhosttyBridgeResult {
        if payload.isEmpty { return .invalidValue }
        restored.append((throughSeq, payload))
        committed.removeAll()
        self.throughSeq = throughSeq
        return .success
    }

    public func setFocus(_ focused: Bool) { focusCalls.append(focused) }
    public func setSize(widthPx: UInt32, heightPx: UInt32) { sizeCalls.append((widthPx, heightPx)) }
    public func draw() { drawCount += 1 }
    public func refresh() {}
    public func sendKey(_ key: ghostty_input_key_s) -> Bool {
        keysSent += 1
        _ = key
        return true
    }
    public func sendText(_ text: String) {
        textSent.append(text)
        // Encoder-out tail: fake write callback with UTF-8 bytes.
        callbackContext.onWrite?(Data(text.utf8))
    }
    public func sendPreedit(_ text: String) { _ = text }
    public func sendMouseButton(
        state: ghostty_input_mouse_state_e,
        button: ghostty_input_mouse_button_e,
        mods: ghostty_input_mods_e
    ) -> Bool {
        _ = (state, button, mods)
        return true
    }
    public func sendMousePos(x: Double, y: Double, mods: ghostty_input_mods_e) {
        _ = (x, y, mods)
    }
    public func free() { freed = true }
}

/// Real L0 wrapper over the six §23 `_v1` symbols + stock surface APIs.
///
/// ## Ownership (M2 / SF1)
/// This type **retains** `callbackContext`, `appOwner`, and `hostView` for the
/// life of the C surface and frees the C surface in `deinit`/`free()` **before**
/// those objects can drop. The C surface holds unowned pointers into
/// `callbackContext` and the host `NSView`; both must outlive every C callback
/// and Metal draw.
public final class GhosttyManualSurface: ManualSurfaceEngine {
    public let callbackContext: BridgeCallbackContext
    public private(set) var throughSeq: UInt64 = 0
    public private(set) var surfaceHandle: ghostty_surface_t?

    /// Strong host view so the C `nsview` pointer never dangles (SF1).
    public let hostView: NSView?
    /// App retained so the surface stays valid (app owns surface lifetime tree).
    /// internal (not private): gate 3 lifecycle tests reach the real
    /// GhosttyAppOwner/GhosttyAppWakeupContext via @testable import.
    let appOwner: GhosttyAppOwner?
    private var ownsSurface: Bool

    public init(
        surface: ghostty_surface_t,
        callbackContext: BridgeCallbackContext,
        hostView: NSView? = nil,
        appOwner: GhosttyAppOwner? = nil,
        ownsSurface: Bool = true
    ) {
        self.surfaceHandle = surface
        self.callbackContext = callbackContext
        self.hostView = hostView
        self.appOwner = appOwner
        self.ownsSurface = ownsSurface
    }

    public func processOutput(bytes: Data, streamSeq: UInt64) -> GhosttyBridgeResult {
        guard let surface = surfaceHandle else { return .invalidValue }
        let result: ghostty_result_e = bytes.withUnsafeBytes { raw in
            let ptr = raw.bindMemory(to: UInt8.self).baseAddress
            return hive_ghostty_surface_process_output_v1(surface, ptr, raw.count, streamSeq)
        }
        let mapped = GhosttyBridgeResult(cResult: result)
        if mapped == .success {
            let end = streamSeq + UInt64(bytes.count)
            if end > throughSeq { throughSeq = end }
        }
        return mapped
    }

    public func restoreCheckpoint(payload: Data, throughSeq: UInt64) -> GhosttyBridgeResult {
        guard let surface = surfaceHandle else { return .invalidValue }
        let result: ghostty_result_e = payload.withUnsafeBytes { raw in
            let ptr = raw.bindMemory(to: UInt8.self).baseAddress
            return hive_ghostty_surface_restore_checkpoint_v1(surface, ptr, raw.count, throughSeq)
        }
        let mapped = GhosttyBridgeResult(cResult: result)
        if mapped == .success {
            self.throughSeq = throughSeq
        }
        return mapped
    }

    public func setFocus(_ focused: Bool) {
        guard let surface = surfaceHandle else { return }
        ghostty_surface_set_focus(surface, focused)
    }

    public func setSize(widthPx: UInt32, heightPx: UInt32) {
        guard let surface = surfaceHandle else { return }
        ghostty_surface_set_size(surface, widthPx, heightPx)
    }

    public func draw() {
        guard let surface = surfaceHandle else { return }
        ghostty_surface_draw(surface)
    }

    public func refresh() {
        guard let surface = surfaceHandle else { return }
        ghostty_surface_refresh(surface)
    }

    public func sendKey(_ key: ghostty_input_key_s) -> Bool {
        guard let surface = surfaceHandle else { return false }
        return ghostty_surface_key(surface, key)
    }

    public func sendText(_ text: String) {
        guard let surface = surfaceHandle else { return }
        text.withCString { cstr in
            ghostty_surface_text(surface, cstr, UInt(text.utf8.count))
        }
    }

    public func sendPreedit(_ text: String) {
        guard let surface = surfaceHandle else { return }
        text.withCString { cstr in
            ghostty_surface_preedit(surface, cstr, UInt(text.utf8.count))
        }
    }

    public func sendMouseButton(
        state: ghostty_input_mouse_state_e,
        button: ghostty_input_mouse_button_e,
        mods: ghostty_input_mods_e
    ) -> Bool {
        guard let surface = surfaceHandle else { return false }
        return ghostty_surface_mouse_button(surface, state, button, mods)
    }

    public func sendMousePos(x: Double, y: Double, mods: ghostty_input_mods_e) {
        guard let surface = surfaceHandle else { return }
        ghostty_surface_mouse_pos(surface, x, y, mods)
    }

    public func free() {
        guard ownsSurface, let surface = surfaceHandle else { return }
        ghostty_surface_free(surface)
        surfaceHandle = nil
        ownsSurface = false
        // callbackContext retained until self deinits — after surface free.
    }

    deinit {
        free()
    }

    /// §23 engine build id (hex C string).
    public static func engineBuildId() -> String {
        guard let cstr = hive_ghostty_engine_build_id_v1() else { return "" }
        return String(cString: cstr)
    }
}

/// Backs `ghostty_runtime_config_s.wakeup_cb`/`userdata` (gate 3, M1-B1).
///
/// ghostty.h: "Callback called to wakeup the event loop. This should
/// trigger a full tick of the app loop" and `ghostty_app_tick`: "should be
/// called whenever the wakeup callback is invoked." The pre-B1 snapshot's
/// wakeup_cb was a no-op, so any Ghostty-internal async work that depends
/// on a later tick to complete silently never did.
///
/// `app`/`freed` are read-modify-written only inside `runOnMain`, and both
/// `scheduleTick` and `freeIfNeeded` route their real work through it, so
/// a tick and a free can never interleave: GCD's main queue is serial, so
/// once either closure starts running on main it runs to completion (a
/// synchronous `ghostty_app_tick`/`ghostty_app_free` call cannot be
/// preempted by another main-queue item) before the other can begin. This
/// is the actual fix — an NSLock held only across `ghostty_app_tick`
/// itself would risk deadlock if Ghostty synchronously re-enters
/// `wakeup_cb` from inside a tick (same thread, non-reentrant lock).
/// `lock` still guards the fields themselves against non-main readers
/// (e.g. `bind`), but is never held across a C call into Ghostty.
///
/// `app` is set only after `ghostty_app_new` succeeds (nothing can call
/// wakeup before then) and the free body is guaranteed to run at most
/// once (first caller wins; `freed` is checked and set atomically under
/// `lock` before either the app pointer is cleared or the C frees run).
///
/// INVARIANT (cross-vendor review 2026-07-17, second pass): the ONLY
/// `ghostty_app_tick` call anywhere in this module is the one inside
/// `scheduleTick`'s `runOnMain` closure below. `GhosttyAppOwner` used to
/// also expose a public `tick()` that called `ghostty_app_tick(app)`
/// directly — off-queue and ungated, reachable even after `free()` had
/// already run. It had zero callers, so it was removed rather than routed
/// through the guard: the safest ungated API is no API. If a tick needs
/// triggering from outside `wakeup_cb`, add a method that calls THIS
/// class's `scheduleTick` (or a variant of it), never a bare
/// `ghostty_app_tick(app)`. `grep -rn ghostty_app_tick` in Sources/ should
/// only ever find the one call site below plus doc comments.
public final class GhosttyAppWakeupContext: @unchecked Sendable {
    private var app: ghostty_app_t?
    private var freed = false
    private let lock = NSLock()

    /// Test seam only (gate 3 positive controls): substitutes a spy for
    /// the real `ghostty_app_tick` call so tests can observe that a tick
    /// actually executed, on which thread, and with which app pointer —
    /// not merely that `scheduleTick` returned without crashing. nil in
    /// production; every non-test caller gets the real C call.
    var tickOverride: ((ghostty_app_t) -> Void)?

    private func runOnMain(_ body: @escaping () -> Void) {
        if Thread.isMainThread {
            body()
        } else {
            DispatchQueue.main.async(execute: body)
        }
    }

    fileprivate func bind(_ app: ghostty_app_t) {
        lock.lock(); self.app = app; lock.unlock()
    }

    fileprivate func scheduleTick() {
        runOnMain { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let app = self.freed ? nil : self.app
            self.lock.unlock()
            guard let app else { return }
            if let override = self.tickOverride {
                override(app)
            } else {
                ghostty_app_tick(app)
            }
        }
    }

    /// Runs `body` (the real `ghostty_app_free`/`ghostty_config_free`
    /// calls) at most once, on the main thread — the same serial queue
    /// `scheduleTick` uses, so a tick that has already started always
    /// finishes before this can run, and a free that has already started
    /// always finishes before a later-arriving tick can read `app`.
    /// Blocks the calling thread until the free (or the no-op) completes,
    /// matching `deinit`'s expectation that `free()` leaves nothing live.
    fileprivate func freeIfNeeded(_ body: @escaping () -> Void) {
        let runOnce = { [self] in
            lock.lock()
            let shouldRun = !freed
            if shouldRun { freed = true; app = nil }
            lock.unlock()
            if shouldRun { body() }
        }
        if Thread.isMainThread {
            runOnce()
        } else {
            DispatchQueue.main.sync(execute: runOnce)
        }
    }

    public var unownedContextPointer: UnsafeMutableRawPointer {
        Unmanaged.passUnretained(self).toOpaque()
    }
}

/// Trampoline matching `ghostty_runtime_wakeup_cb` exactly.
public let ghosttyAppWakeupTrampoline: ghostty_runtime_wakeup_cb = { userdata in
    guard let userdata else { return }
    let ctx = Unmanaged<GhosttyAppWakeupContext>.fromOpaque(userdata).takeUnretainedValue()
    ctx.scheduleTick()
}

/// Owns a Ghostty app + config for manual surface creation (M2).
public final class GhosttyAppOwner {
    public let app: ghostty_app_t
    public let config: ghostty_config_t
    /// internal (not private): gate 3 lifecycle tests drive wakeup_cb directly.
    let wakeupContext: GhosttyAppWakeupContext

    fileprivate init(app: ghostty_app_t, config: ghostty_config_t, wakeupContext: GhosttyAppWakeupContext) {
        self.app = app
        self.config = config
        self.wakeupContext = wakeupContext
        wakeupContext.bind(app)
    }

    deinit {
        free()
    }

    public func free() {
        wakeupContext.freeIfNeeded { [app, config] in
            ghostty_app_free(app)
            ghostty_config_free(config)
        }
    }
}

/// L0 factory: calls `hive_ghostty_surface_new_manual_v1` with the real
/// trampolines wired to a retained `BridgeCallbackContext` (B2).
public enum GhosttyBridgeFactory {
    public enum FactoryError: Error, CustomStringConvertible {
        case initFailed
        case configFailed
        case appFailed
        case surfaceFailed

        public var description: String {
            switch self {
            case .initFailed: return "ghostty_init failed"
            case .configFailed: return "ghostty_config_new failed"
            case .appFailed: return "ghostty_app_new failed"
            case .surfaceFailed: return "hive_ghostty_surface_new_manual_v1 failed"
            }
        }
    }

    /// Builds the runtime config passed to `ghostty_app_new` — pulled out of
    /// `makeManualSurface` so gate 3 tests can assert the REAL factory wires
    /// `wakeup_cb`/`userdata` to the real trampoline/context, not a stub.
    /// Without this seam, only the trampoline function in isolation was
    /// testable and the factory's own wiring could silently regress to a
    /// no-op (e.g. `{ _ in }`) with no test catching it.
    static func makeRuntimeConfig(wakeupContext: GhosttyAppWakeupContext) -> ghostty_runtime_config_s {
        ghostty_runtime_config_s(
            userdata: wakeupContext.unownedContextPointer,
            supports_selection_clipboard: false,
            wakeup_cb: ghosttyAppWakeupTrampoline,
            action_cb: { _, _, _ in false },
            read_clipboard_cb: { _, _, _ in false },
            confirm_read_clipboard_cb: { _, _, _, _ in },
            write_clipboard_cb: { _, _, _, _, _ in },
            close_surface_cb: { _, _ in }
        )
    }

    /// Create a manual-I/O surface bound to the copy-before-return trampolines.
    /// The returned surface owns the callback context and app for lifetime safety.
    ///
    /// Requires an `NSView` host for the macOS Metal surface (Ghostty platform
    /// config). Tests may pass a plain `NSView()`; production embeds the kit view.
    public static func makeManualSurface(
        hostView: NSView,
        widthPx: UInt32 = 800,
        heightPx: UInt32 = 480
    ) throws -> GhosttyManualSurface {
        // ghostty_init is idempotent for process lifetime.
        _ = ghostty_init(0, nil)

        guard let config = ghostty_config_new() else { throw FactoryError.configFailed }
        ghostty_config_finalize(config)

        let wakeupContext = GhosttyAppWakeupContext()
        var runtime = makeRuntimeConfig(wakeupContext: wakeupContext)

        guard let app = ghostty_app_new(&runtime, config) else {
            ghostty_config_free(config)
            throw FactoryError.appFailed
        }
        let owner = GhosttyAppOwner(app: app, config: config, wakeupContext: wakeupContext)

        var surfaceConfig = ghostty_surface_config_new()
        surfaceConfig.platform_tag = GHOSTTY_PLATFORM_MACOS
        surfaceConfig.platform = ghostty_platform_u(
            macos: ghostty_platform_macos_s(
                nsview: Unmanaged.passUnretained(hostView).toOpaque()
            )
        )
        surfaceConfig.scale_factor = Double(hostView.window?.backingScaleFactor ?? 2.0)
        surfaceConfig.font_size = 13

        let callbackContext = BridgeCallbackContext()
        let writeCtx = callbackContext.unownedContextPointer
        let eventCtx = callbackContext.unownedContextPointer

        guard let surface = hive_ghostty_surface_new_manual_v1(
            app,
            &surfaceConfig,
            hiveBridgeWriteTrampoline,
            writeCtx,
            hiveBridgeEventTrampoline,
            eventCtx
        ) else {
            owner.free()
            throw FactoryError.surfaceFailed
        }

        // Size the surface (never 0×0).
        let w = widthPx > 0 ? widthPx : UInt32(max(1, hostView.bounds.width))
        let h = heightPx > 0 ? heightPx : UInt32(max(1, hostView.bounds.height))
        ghostty_surface_set_size(surface, w, h)

        return GhosttyManualSurface(
            surface: surface,
            callbackContext: callbackContext,
            hostView: hostView,
            appOwner: owner,
            ownsSurface: true
        )
    }

    /// Convenience for tests: host view is retained by the returned surface (SF1).
    public static func makeManualSurfaceForTesting(
        widthPx: UInt32 = 800,
        heightPx: UInt32 = 480
    ) throws -> GhosttyManualSurface {
        let host = NSView(frame: NSRect(x: 0, y: 0, width: CGFloat(widthPx), height: CGFloat(heightPx)))
        return try makeManualSurface(hostView: host, widthPx: widthPx, heightPx: heightPx)
    }
}

func sha256(_ data: Data) -> Data {
    Data(SHA256.hash(data: data))
}
