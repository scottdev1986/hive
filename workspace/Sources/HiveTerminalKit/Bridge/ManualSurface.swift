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
///
/// Threading contract: AppKit/Metal and every Ghostty app/surface C entry run
/// on the main thread. UI/input/read methods require a main-thread caller.
/// `processOutput` and `restoreCheckpoint` are the only off-main ingress: each
/// copies its Data before synchronously admitting the C transaction to main.
/// `free` may originate off-main but also serializes on main, after closing
/// callback admission. No host callback is invoked inside a C callback.
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
    /// Gate 8: real cell/text-offset selection range, matching Ghostty's own
    /// selectedRange() (ghostty_surface_read_selection), not a placeholder.
    func readSelection() -> (offset: Int, length: Int)?
    /// Gate 8: matches ghostty_surface_mouse_scroll's packed scroll-mods
    /// bitmask (bit 0 precision, bits 1-3 momentum phase) — see
    /// HiveTerminalView+Input.swift's ScrollMods for the exact encoding,
    /// sourced from Ghostty's own macos/Sources/Ghostty/Ghostty.Input.swift.
    func sendMouseScroll(x: Double, y: Double, mods: Int32)
    func free()
}

/// In-process fake for L1/L2 logic tests that do not need the real C boundary.
public final class FakeManualSurface: ManualSurfaceEngine {
    public let callbackContext: BridgeCallbackContext
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
    /// Gate 8 test detail: the C `text` pointer is only valid synchronously,
    /// so it's copied to a Swift String here at call time (mirrors the real
    /// bridge's copy-before-return discipline for callback pointers).
    public struct KeySent {
        public let action: ghostty_input_action_e
        public let mods: ghostty_input_mods_e
        public let consumedMods: ghostty_input_mods_e
        public let keycode: UInt32
        public let unshiftedCodepoint: UInt32
        public let text: String?
    }
    public private(set) var keysSentDetail: [KeySent] = []

    private var committed: [(streamSeq: UInt64, bytes: Data, digest: Data)] = []

    public init(callbackContext: BridgeCallbackContext = BridgeCallbackContext()) {
        self.callbackContext = callbackContext
    }

    public func processOutput(bytes: Data, streamSeq: UInt64) -> GhosttyBridgeResult {
        let ownedBytes = Data(bytes)
        return performOnMainSync {
            self.processOutputOnMain(bytes: ownedBytes, streamSeq: streamSeq)
        }
    }

    private func processOutputOnMain(bytes: Data, streamSeq: UInt64) -> GhosttyBridgeResult {
        dispatchPrecondition(condition: .onQueue(.main))
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
        callbackContext.enqueueEvent(BridgeEvent(type: .invalidate))
        return .success
    }

    public func restoreCheckpoint(payload: Data, throughSeq: UInt64) -> GhosttyBridgeResult {
        let ownedPayload = Data(payload)
        return performOnMainSync {
            if ownedPayload.isEmpty { return .invalidValue }
            self.restored.append((throughSeq, ownedPayload))
            self.committed.removeAll()
            self.throughSeq = throughSeq
            return .success
        }
    }

    public func setFocus(_ focused: Bool) { focusCalls.append(focused) }
    public func setSize(widthPx: UInt32, heightPx: UInt32) { sizeCalls.append((widthPx, heightPx)) }
    public func draw() { drawCount += 1 }
    public func refresh() {}
    public func sendKey(_ key: ghostty_input_key_s) -> Bool {
        keysSent += 1
        keysSentDetail.append(KeySent(
            action: key.action,
            mods: key.mods,
            consumedMods: key.consumed_mods,
            keycode: key.keycode,
            unshiftedCodepoint: key.unshifted_codepoint,
            text: key.text.map { String(cString: $0) }
        ))
        return true
    }
    public func sendText(_ text: String) {
        textSent.append(text)
        // Encoder-out tail: fake write callback with UTF-8 bytes.
        callbackContext.enqueueWrite(Data(text.utf8))
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
    public var fakeSelection: (offset: Int, length: Int)?
    public func readSelection() -> (offset: Int, length: Int)? { fakeSelection }
    public private(set) var scrollsSent: [(x: Double, y: Double, mods: Int32)] = []
    public func sendMouseScroll(x: Double, y: Double, mods: Int32) {
        scrollsSent.append((x, y, mods))
    }
    public func free() {
        performOnMainSync {
            guard !self.freed else { return }
            self.callbackContext.beginTeardown()
            self.freed = true
        }
    }
}

/// Real L0 wrapper over the six §23 `_v1` symbols + stock surface APIs.
///
/// ## Ownership (M2 / SF1)
/// This type **retains** `callbackContext`, `appOwner`, and `hostView` for the
/// life of the C surface and frees the C surface in `deinit`/`free()` **before**
/// those objects can drop. The C surface holds unowned pointers into
/// `callbackContext` and the host `NSView`; both must outlive every C callback
/// and Metal draw.
enum GhosttyOperationPhase {
    case begin
    case end
}

public final class GhosttyManualSurface: ManualSurfaceEngine {
    public let callbackContext: BridgeCallbackContext
    private var rawThroughSeq: UInt64 = 0
    private var rawSurfaceHandle: ghostty_surface_t?

    public var throughSeq: UInt64 {
        performOnMainSync { self.rawThroughSeq }
    }

    public var surfaceHandle: ghostty_surface_t? {
        dispatchPrecondition(condition: .onQueue(.main))
        return rawSurfaceHandle
    }

    /// Strong host view so the C `nsview` pointer never dangles (SF1).
    public private(set) var hostView: NSView?
    /// App retained so the surface stays valid (app owns surface lifetime tree).
    /// internal (not private): gate 3 lifecycle tests reach the real
    /// GhosttyAppOwner/GhosttyAppWakeupContext via @testable import.
    private(set) var appOwner: GhosttyAppOwner?
    private var ownsSurface: Bool

    /// Gate 3 test seams. Production leaves both nil.
    var operationObserver: ((String, GhosttyOperationPhase) -> Void)?
    var outputCopyObserver: ((Data) -> Void)?

    public init(
        surface: ghostty_surface_t,
        callbackContext: BridgeCallbackContext,
        hostView: NSView? = nil,
        appOwner: GhosttyAppOwner? = nil,
        ownsSurface: Bool = true
    ) {
        precondition(Thread.isMainThread, "Ghostty surface wrappers must be created on the main thread")
        self.rawSurfaceHandle = surface
        self.callbackContext = callbackContext
        self.hostView = hostView
        self.appOwner = appOwner
        self.ownsSurface = ownsSurface
    }

    public func processOutput(bytes: Data, streamSeq: UInt64) -> GhosttyBridgeResult {
        // Data may wrap caller-owned mutable storage. Force an independent
        // copy before a background producer waits for main-queue admission.
        let ownedBytes = Data(bytes)
        outputCopyObserver?(ownedBytes)
        return performSurfaceOperation("processOutput", default: .invalidValue) { surface in
            let result: ghostty_result_e = ownedBytes.withUnsafeBytes { raw in
                let ptr = raw.bindMemory(to: UInt8.self).baseAddress
                return hive_ghostty_surface_process_output_v1(surface, ptr, raw.count, streamSeq)
            }
            let mapped = GhosttyBridgeResult(cResult: result)
            if mapped == .success {
                let end = streamSeq + UInt64(ownedBytes.count)
                if end > self.rawThroughSeq { self.rawThroughSeq = end }
            }
            return mapped
        }
    }

    public func restoreCheckpoint(payload: Data, throughSeq: UInt64) -> GhosttyBridgeResult {
        let ownedPayload = Data(payload)
        return performSurfaceOperation("restoreCheckpoint", default: .invalidValue) { surface in
            let result: ghostty_result_e = ownedPayload.withUnsafeBytes { raw in
                let ptr = raw.bindMemory(to: UInt8.self).baseAddress
                return hive_ghostty_surface_restore_checkpoint_v1(surface, ptr, raw.count, throughSeq)
            }
            let mapped = GhosttyBridgeResult(cResult: result)
            if mapped == .success {
                self.rawThroughSeq = throughSeq
            }
            return mapped
        }
    }

    public func setFocus(_ focused: Bool) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return }
        ghostty_surface_set_focus(surface, focused)
    }

    public func setSize(widthPx: UInt32, heightPx: UInt32) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return }
        ghostty_surface_set_size(surface, widthPx, heightPx)
    }

    public func draw() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return }
        ghostty_surface_draw(surface)
    }

    public func refresh() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return }
        ghostty_surface_refresh(surface)
    }

    public func sendKey(_ key: ghostty_input_key_s) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return false }
        return ghostty_surface_key(surface, key)
    }

    public func sendText(_ text: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return }
        text.withCString { cstr in
            ghostty_surface_text(surface, cstr, UInt(text.utf8.count))
        }
    }

    public func sendPreedit(_ text: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return }
        text.withCString { cstr in
            ghostty_surface_preedit(surface, cstr, UInt(text.utf8.count))
        }
    }

    public func sendMouseButton(
        state: ghostty_input_mouse_state_e,
        button: ghostty_input_mouse_button_e,
        mods: ghostty_input_mods_e
    ) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return false }
        return ghostty_surface_mouse_button(surface, state, button, mods)
    }

    public func sendMousePos(x: Double, y: Double, mods: ghostty_input_mods_e) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return }
        ghostty_surface_mouse_pos(surface, x, y, mods)
    }

    public func readSelection() -> (offset: Int, length: Int)? {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return nil }
        var text = ghostty_text_s()
        guard ghostty_surface_read_selection(surface, &text) else { return nil }
        defer { ghostty_surface_free_text(surface, &text) }
        return (offset: Int(text.offset_start), length: Int(text.offset_len))
    }

    public func sendMouseScroll(x: Double, y: Double, mods: Int32) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return }
        ghostty_surface_mouse_scroll(surface, x, y, ghostty_input_scroll_mods_t(mods))
    }

    public func free() {
        performOnMainSync {
            guard self.ownsSurface, let surface = self.rawSurfaceHandle else { return }
            self.callbackContext.beginTeardown()
            self.rawSurfaceHandle = nil
            self.ownsSurface = false
            self.operationObserver?("surfaceFree", .begin)
            defer { self.operationObserver?("surfaceFree", .end) }
            ghostty_surface_free(surface)
            // Releasing the app owner after surface_free preserves the native
            // lifetime tree. A shared owner remains alive until its last
            // surface releases it.
            self.appOwner = nil
            self.hostView = nil
        }
    }

    deinit {
        free()
    }

    /// §23 engine build id (hex C string).
    public static func engineBuildId() -> String {
        guard let cstr = hive_ghostty_engine_build_id_v1() else { return "" }
        return String(cString: cstr)
    }

    func withUnsafeSurfaceHandle<T>(_ body: (ghostty_surface_t) -> T) -> T? {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return nil }
        return body(surface)
    }

    private func performSurfaceOperation<T>(
        _ operation: String,
        default defaultValue: T,
        _ body: @escaping (ghostty_surface_t) -> T
    ) -> T {
        performOnMainSync {
            guard let surface = self.rawSurfaceHandle else { return defaultValue }
            self.operationObserver?(operation, .begin)
            defer { self.operationObserver?(operation, .end) }
            return body(surface)
        }
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
/// `app`/`freed` are read-modify-written only on the main thread, and both
/// `scheduleTick` and `freeIfNeeded` run their real work there, so a tick
/// and a free can never interleave: GCD's main queue is serial, so once
/// either closure starts running on main it runs to completion (a
/// synchronous `ghostty_app_tick`/`ghostty_app_free` call cannot be
/// preempted by another main-queue item) before the other can begin.
/// `lock` still guards the fields themselves against non-main readers
/// (e.g. `bind`), but is never held across a C call into Ghostty.
///
/// `scheduleTick` ALWAYS defers via `DispatchQueue.main.async`, even when
/// already on the main thread — exactly what the pinned Ghostty macOS
/// app's own `wakeup` does (Ghostty.App.swift). This is load-bearing, not
/// style: `App.Mailbox.push` (App.zig) invokes `wakeup_cb` synchronously
/// on the pushing thread, and every surface message chains through it
/// (apprt/surface.zig), so a main-thread C entry point (e.g.
/// `ghostty_surface_key` hitting a binding) can invoke `wakeup_cb`
/// mid-call. An inline tick here would re-enter `ghostty_app_tick` from
/// inside Ghostty's own stack — including recursively from inside a
/// tick's own mailbox drain. Upstream never has to survive re-entrant
/// ticks because its only embedder always defers; ours must too. Deferring
/// also makes a wakeup arriving during a tick harmless (it just enqueues
/// the next tick after the current one completes).
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

    fileprivate func bind(_ app: ghostty_app_t) {
        lock.lock(); self.app = app; lock.unlock()
    }

    fileprivate func scheduleTick() {
        // Always defer, never tick inline — see the class doc. The pinned
        // app's own wakeup_cb does exactly this unconditionally.
        DispatchQueue.main.async { [weak self] in
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

/// Gate 9 (M1-B1) action policy for manual surfaces: every
/// `ghostty_action_tag_e` at the PINNED header (66 tags) is classified —
/// never a blanket false. B1 handles no action at the apprt level, so
/// every verdict currently resolves to "return false", but `handle` routes
/// through the verdict per-tag via an exhaustive switch and treats an
/// UNKNOWN tag (no verdict) as a loud programmer error (`assertionFailure`
/// in debug), never a silent false — so the false is genuinely typed at
/// the binding, not a blanket. Gate9ActionPolicyTests exercises this
/// behaviorally through the callback (not just the classify table),
/// including a real byte-triggerable action routed to its verdict.
///
/// UPGRADE-TIME GUARANTEE (corrected after cross-vendor review 2026-07-18 —
/// the old ambiguous public-header field actually hashed the bridge header,
/// which does not contain the action enum). The lock now carries distinct
/// upstream and bridge header hashes. The two-part completeness guarantee is:
/// (1) the whole vendored tree and upstream header are pinned, so any change
/// fails the build chain; and (2)
/// Gate9ActionPolicyTests parses the `ghostty_action_tag_e` enum block
/// directly from that pinned header and asserts its member count equals the
/// classified-set size, so a bump that appends a tag turns RED and demands
/// a verdict.
///
/// Verdicts (queen rulings 2026-07-18):
/// - handledByEffects: visible behavior already flows through the manual
///   vt Handler effects → bridge events (TITLE/PWD/BELL); the action-cb
///   arm of the same signal is deliberately a no-op duplicate.
/// - deniedPolicy: security denials. DESKTOP_NOTIFICATION (raw OSC 9/777
///   from untrusted agent bytes is a spam/spoof vector; attention signals
///   belong to Hive's own attributed system), SECURE_INPUT (agent output
///   must not flip system secure-input; revisit for human-attach mode),
///   OPEN_URL (no NSWorkspace.open from terminal content in B1).
/// - deniedGesture: Ghostty window/tab/split/quit/inspector management
///   Hive does not delegate. Their KEYBINDS are stripped from the manual
///   config (`keybind = clear`), so these are unreachable-by-construction
///   from input; the verdict remains as defense in depth.
/// - engineInert: engine housekeeping notifications with no B1 consumer
///   (rendering geometry flows through gate-7's own APIs, not actions).
public enum HiveGhosttyActionPolicy {
    public enum Verdict: Equatable {
        case handledByEffects
        case deniedPolicy
        case deniedGesture
        case engineInert
    }

    static let handledByEffectsTags: [ghostty_action_tag_e] = [
        GHOSTTY_ACTION_SET_TITLE, GHOSTTY_ACTION_PWD, GHOSTTY_ACTION_RING_BELL,
    ]
    static let deniedPolicyTags: [ghostty_action_tag_e] = [
        GHOSTTY_ACTION_DESKTOP_NOTIFICATION, GHOSTTY_ACTION_SECURE_INPUT,
        GHOSTTY_ACTION_OPEN_URL,
    ]
    static let deniedGestureTags: [ghostty_action_tag_e] = [
        GHOSTTY_ACTION_QUIT, GHOSTTY_ACTION_NEW_WINDOW, GHOSTTY_ACTION_NEW_TAB,
        GHOSTTY_ACTION_CLOSE_TAB, GHOSTTY_ACTION_NEW_SPLIT,
        GHOSTTY_ACTION_CLOSE_ALL_WINDOWS, GHOSTTY_ACTION_TOGGLE_MAXIMIZE,
        GHOSTTY_ACTION_TOGGLE_FULLSCREEN, GHOSTTY_ACTION_TOGGLE_TAB_OVERVIEW,
        GHOSTTY_ACTION_TOGGLE_WINDOW_DECORATIONS,
        GHOSTTY_ACTION_TOGGLE_QUICK_TERMINAL,
        GHOSTTY_ACTION_TOGGLE_COMMAND_PALETTE, GHOSTTY_ACTION_TOGGLE_VISIBILITY,
        GHOSTTY_ACTION_TOGGLE_BACKGROUND_OPACITY, GHOSTTY_ACTION_MOVE_TAB,
        GHOSTTY_ACTION_GOTO_TAB, GHOSTTY_ACTION_GOTO_SPLIT,
        GHOSTTY_ACTION_GOTO_WINDOW, GHOSTTY_ACTION_RESIZE_SPLIT,
        GHOSTTY_ACTION_EQUALIZE_SPLITS, GHOSTTY_ACTION_TOGGLE_SPLIT_ZOOM,
        GHOSTTY_ACTION_PRESENT_TERMINAL, GHOSTTY_ACTION_INSPECTOR,
        GHOSTTY_ACTION_SHOW_GTK_INSPECTOR, GHOSTTY_ACTION_RENDER_INSPECTOR,
        GHOSTTY_ACTION_OPEN_CONFIG, GHOSTTY_ACTION_RELOAD_CONFIG,
        GHOSTTY_ACTION_CLOSE_WINDOW, GHOSTTY_ACTION_UNDO, GHOSTTY_ACTION_REDO,
        GHOSTTY_ACTION_CHECK_FOR_UPDATES, GHOSTTY_ACTION_START_SEARCH,
        GHOSTTY_ACTION_END_SEARCH, GHOSTTY_ACTION_FLOAT_WINDOW,
        GHOSTTY_ACTION_PROMPT_TITLE, GHOSTTY_ACTION_SET_TAB_TITLE,
        GHOSTTY_ACTION_COPY_TITLE_TO_CLIPBOARD,
        GHOSTTY_ACTION_SHOW_ON_SCREEN_KEYBOARD, GHOSTTY_ACTION_READONLY,
    ]
    static let engineInertTags: [ghostty_action_tag_e] = [
        GHOSTTY_ACTION_SIZE_LIMIT, GHOSTTY_ACTION_RESET_WINDOW_SIZE,
        GHOSTTY_ACTION_INITIAL_SIZE, GHOSTTY_ACTION_CELL_SIZE,
        GHOSTTY_ACTION_SCROLLBAR, GHOSTTY_ACTION_RENDER,
        GHOSTTY_ACTION_RENDERER_HEALTH, GHOSTTY_ACTION_QUIT_TIMER,
        GHOSTTY_ACTION_KEY_SEQUENCE, GHOSTTY_ACTION_KEY_TABLE,
        GHOSTTY_ACTION_COLOR_CHANGE, GHOSTTY_ACTION_CONFIG_CHANGE,
        GHOSTTY_ACTION_SELECTION_CHANGED, GHOSTTY_ACTION_SHOW_CHILD_EXITED,
        GHOSTTY_ACTION_PROGRESS_REPORT, GHOSTTY_ACTION_COMMAND_FINISHED,
        GHOSTTY_ACTION_SEARCH_TOTAL, GHOSTTY_ACTION_SEARCH_SELECTED,
        GHOSTTY_ACTION_MOUSE_SHAPE, GHOSTTY_ACTION_MOUSE_VISIBILITY,
        GHOSTTY_ACTION_MOUSE_OVER_LINK,
    ]

    public static func classify(_ tag: ghostty_action_tag_e) -> Verdict? {
        if handledByEffectsTags.contains(where: { $0 == tag }) { return .handledByEffects }
        if deniedPolicyTags.contains(where: { $0 == tag }) { return .deniedPolicy }
        if deniedGestureTags.contains(where: { $0 == tag }) { return .deniedGesture }
        if engineInertTags.contains(where: { $0 == tag }) { return .engineInert }
        return nil
    }

    /// Test spy (nil in production): observes every action-callback firing
    /// with its tag AND the verdict `handle` routed it through, so controls
    /// prove the callback behaves per-verdict — not merely that the
    /// classify() table is correct. Same discipline as
    /// GhosttyAppWakeupContext.tickOverride.
    private static let observerLock = NSLock()
    private static var observer: ((ghostty_action_tag_e, Verdict?) -> Void)?
    static func setObserver(_ body: ((ghostty_action_tag_e, Verdict?) -> Void)?) {
        observerLock.lock(); observer = body; observerLock.unlock()
    }

    /// The real callback body. Every action resolves to `false` in B1
    /// (nothing is apprt-handled: title/pwd/bell flow through the vt
    /// Handler effects → bridge events, denials and inert notifications
    /// return false), but the routing is EXHAUSTIVE and per-verdict — an
    /// unknown tag is a loud error in debug, never a silent false — so the
    /// "never a blanket false" property holds at the binding.
    static func handle(_ tag: ghostty_action_tag_e) -> Bool {
        observerLock.lock()
        let spy = observer
        observerLock.unlock()

        let verdict = classify(tag)
        spy?(tag, verdict)

        switch verdict {
        case .handledByEffects:
            // Duplicate of the effects/event path; not re-handled here.
            return false
        case .deniedPolicy, .deniedGesture:
            // Deliberate denial (security / undelegated gesture).
            return false
        case .engineInert:
            // Engine housekeeping notification, no B1 consumer.
            return false
        case nil:
            // A tag with no verdict = the classified set drifted from the
            // pinned enum (Gate9ActionPolicyTests guards against this at
            // build). Fail loud in debug so it can never merge silently;
            // still safe (deny) in release.
            assertionFailure("unclassified ghostty action tag \(tag.rawValue) reached the callback — " +
                             "the gate-9 classification is out of sync with the pinned action enum")
            return false
        }
    }
}

/// Owns a Ghostty app + config for manual surface creation (M2).
public final class GhosttyAppOwner {
    public let app: ghostty_app_t
    public let config: ghostty_config_t
    /// internal (not private): gate 3 lifecycle tests drive wakeup_cb directly.
    let wakeupContext: GhosttyAppWakeupContext
    var operationObserver: ((String) -> Void)?

    fileprivate init(app: ghostty_app_t, config: ghostty_config_t, wakeupContext: GhosttyAppWakeupContext) {
        precondition(Thread.isMainThread, "Ghostty app owners must be created on the main thread")
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
            self.operationObserver?("app")
            ghostty_app_free(app)
            self.operationObserver?("config")
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

    /// Test seam: observes each real C construction entry after main-queue
    /// admission. Production leaves this nil.
    static var creationObserver: ((String) -> Void)?

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
            // Gate 9: typed per-tag policy, not a blanket false — see
            // HiveGhosttyActionPolicy.
            action_cb: { _, _, action in HiveGhosttyActionPolicy.handle(action.tag) },
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
        try performOnMainSync {
            try makeManualSurfaceOnMain(
                hostView: hostView,
                widthPx: widthPx,
                heightPx: heightPx,
                configPolicyPath: manualConfigPolicyPath
            )
        }
    }

    private static func makeManualSurfaceOnMain(
        hostView: NSView,
        widthPx: UInt32,
        heightPx: UInt32,
        configPolicyPath: UnsafePointer<CChar>
    ) throws -> GhosttyManualSurface {
        dispatchPrecondition(condition: .onQueue(.main))

        // ghostty_init is idempotent for process lifetime.
        creationObserver?("init")
        _ = ghostty_init(0, nil)

        creationObserver?("configNew")
        guard let config = ghostty_config_new() else { throw FactoryError.configFailed }
        // Gate 9 (queen ruling 2026-07-18): STRIP every Ghostty keybind from
        // the manual-surface config. Hive owns window/pane/split management;
        // an embedded agent-terminal provides none of Ghostty's ~37
        // window/tab/split/quit/inspector actions, so making their bindings
        // unreachable-by-construction beats denying them at the action
        // callback — an unbound key falls through to normal terminal
        // encoding instead of being swallowed by an action nobody provides.
        // `keybind = clear` empties the root set and all tables
        // (config/Config.zig keybind parser). The pinned C API has no
        // load_string, so the one-line policy is loaded via a temp file.
        ghostty_config_load_file(config, configPolicyPath)
        ghostty_config_finalize(config)

        let wakeupContext = GhosttyAppWakeupContext()
        var runtime = makeRuntimeConfig(wakeupContext: wakeupContext)

        creationObserver?("appNew")
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

        creationObserver?("surfaceNew")
        guard let surface = hive_ghostty_surface_new_manual_v1(
            app,
            &surfaceConfig,
            hiveBridgeWriteTrampoline,
            writeCtx,
            hiveBridgeEventTrampoline,
            eventCtx
        ) else {
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

    /// One-line manual-surface config policy, written once per process.
    /// Contents are the gate-9 ruling, not user preference — never merge
    /// user config files into a manual surface.
    static let manualConfigPolicyPath: UnsafePointer<CChar> = {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("hive-ghostty-manual-config-\(ProcessInfo.processInfo.processIdentifier).conf")
        try? Data("keybind = clear\n".utf8).write(to: url)
        // Intentionally leaked: valid for process lifetime, handed to C.
        return UnsafePointer(strdup(url.path))
    }()

    /// XCTest may have no active CVDisplayLink; only frame pacing is disabled.
    /// The real Metal renderer, IOSurface layer, and terminal core still run.
    private static let headlessTestConfigPolicyPath: UnsafePointer<CChar> = {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("hive-ghostty-test-config-\(ProcessInfo.processInfo.processIdentifier).conf")
        try? Data("keybind = clear\nwindow-vsync = false\n".utf8).write(to: url)
        return UnsafePointer(strdup(url.path))
    }()

    /// Convenience for tests: host view is retained by the returned surface (SF1).
    public static func makeManualSurfaceForTesting(
        widthPx: UInt32 = 800,
        heightPx: UInt32 = 480
    ) throws -> GhosttyManualSurface {
        try performOnMainSync {
            let host = NSView(frame: NSRect(x: 0, y: 0, width: CGFloat(widthPx), height: CGFloat(heightPx)))
            return try makeManualSurfaceOnMain(
                hostView: host,
                widthPx: widthPx,
                heightPx: heightPx,
                configPolicyPath: headlessTestConfigPolicyPath
            )
        }
    }
}

private func performOnMainSync<T>(_ body: @escaping () throws -> T) rethrows -> T {
    if Thread.isMainThread {
        return try body()
    }
    return try DispatchQueue.main.sync(execute: body)
}

func sha256(_ data: Data) -> Data {
    Data(SHA256.hash(data: data))
}
