import AppKit
import Foundation
import GhosttyKit

public struct ManualSurfaceSize: Equatable, Sendable {
    public let columns: UInt16
    public let rows: UInt16
    public let widthPx: UInt32
    public let heightPx: UInt32
    public let cellWidthPx: UInt32
    public let cellHeightPx: UInt32

    public init(
        columns: UInt16,
        rows: UInt16,
        widthPx: UInt32,
        heightPx: UInt32,
        cellWidthPx: UInt32,
        cellHeightPx: UInt32
    ) {
        self.columns = columns
        self.rows = rows
        self.widthPx = widthPx
        self.heightPx = heightPx
        self.cellWidthPx = cellWidthPx
        self.cellHeightPx = cellHeightPx
    }
}

enum TerminalKeyAction: Equatable, Sendable {
    case release
    case press
    case `repeat`
}

struct TerminalModifiers: OptionSet, Equatable, Sendable {
    let rawValue: UInt32

    static let shift = TerminalModifiers(rawValue: 1 << 0)
    static let control = TerminalModifiers(rawValue: 1 << 1)
    static let option = TerminalModifiers(rawValue: 1 << 2)
    static let command = TerminalModifiers(rawValue: 1 << 3)
    static let capsLock = TerminalModifiers(rawValue: 1 << 4)
    static let rightShift = TerminalModifiers(rawValue: 1 << 6)
    static let rightControl = TerminalModifiers(rawValue: 1 << 7)
    static let rightOption = TerminalModifiers(rawValue: 1 << 8)
    static let rightCommand = TerminalModifiers(rawValue: 1 << 9)
}

struct TerminalKeyEvent: Equatable, Sendable {
    var action: TerminalKeyAction
    var modifiers: TerminalModifiers
    var consumedModifiers: TerminalModifiers
    var keycode: UInt32
    var text: String?
    var unshiftedCodepoint: UInt32
    var composing: Bool
}

enum TerminalMouseButtonState: Equatable, Sendable {
    case release
    case press
}

enum TerminalMouseButton: Equatable, Sendable {
    case unknown
    case left
    case right
    case middle
    case four
    case five
    case six
    case seven
    case eight
    case nine
    case ten
    case eleven
}

struct ManualSurfaceIMEPoint: Equatable, Sendable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double
}

enum TerminalColorScheme: Equatable, Sendable {
    case light
    case dark

    init(appearance: NSAppearance) {
        self = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? .dark : .light
    }
}

protocol ManualSurfaceEngine: AnyObject {
    var callbackContext: BridgeCallbackContext { get }
    func setFocus(_ focused: Bool)
    func setSize(widthPx: UInt32, heightPx: UInt32)
    func setContentScale(x: Double, y: Double)
    func setColorScheme(_ scheme: TerminalColorScheme)
    @discardableResult
    func applyHiveConfiguration(theme: HiveTerminalTheme, font: HiveTerminalFont) -> Bool
    func setDisplayID(_ displayID: UInt32)
    func setOcclusion(_ visible: Bool)
    func reportedSize() -> ManualSurfaceSize?
    func draw()
    func refresh()
    func keyTranslationMods(_ mods: TerminalModifiers) -> TerminalModifiers
    func sendKey(_ key: TerminalKeyEvent) -> Bool
    func sendText(_ text: String)
    func sendPreedit(_ text: String)
    func mouseCaptured() -> Bool
    func sendMouseButton(
        state: TerminalMouseButtonState,
        button: TerminalMouseButton,
        modifiers: TerminalModifiers
    ) -> Bool
    func sendMousePos(x: Double, y: Double, modifiers: TerminalModifiers)
    func sendMousePressure(stage: UInt32, pressure: Double)
    func imePoint() -> ManualSurfaceIMEPoint?
    func performBindingAction(_ action: String) -> Bool
    func readSelection() -> (offset: Int, length: Int)?
    func readScreenText() -> String
    func readSelectedText() -> String?
    func completeClipboardRequest(_ text: String, state: UnsafeMutableRawPointer?, confirmed: Bool)
    func sendMouseScroll(x: Double, y: Double, mods: Int32)
    func free()
}

extension ManualSurfaceEngine {
    @discardableResult
    func applyHiveConfiguration() -> Bool {
        applyHiveConfiguration(theme: .hiveDark, font: .embedded)
    }

    @discardableResult
    func applyHiveConfiguration(theme: HiveTerminalTheme) -> Bool {
        applyHiveConfiguration(theme: theme, font: .embedded)
    }
}

enum GhosttyOperationPhase {
    case begin
    case end
}

final class GhosttyManualSurface: ManualSurfaceEngine {
    let callbackContext: BridgeCallbackContext
    private var rawSurfaceHandle: ghostty_surface_t?
    private let clipboardContext: GhosttyClipboardContext
    private var hiveConfigurationKey: String?
    private let hiveConfigurationHeadless: Bool

    var surfaceHandle: ghostty_surface_t? {
        dispatchPrecondition(condition: .onQueue(.main))
        return rawSurfaceHandle
    }

    public var onActionNotification: ((HiveTerminalActionNotification) -> Void)? {
        get { callbackContext.onActionNotification }
        set { callbackContext.onActionNotification = newValue }
    }

    /// Strong host view so the C `nsview` pointer never dangles.
    private(set) var hostView: NSView?
    private(set) var appOwner: GhosttyAppOwner?
    private var ownsSurface: Bool

    var operationObserver: ((String, GhosttyOperationPhase) -> Void)?
    var outputCopyObserver: ((Data) -> Void)?

    init(
        surface: ghostty_surface_t,
        callbackContext: BridgeCallbackContext,
        clipboardContext: GhosttyClipboardContext,
        hostView: NSView? = nil,
        appOwner: GhosttyAppOwner? = nil,
        ownsSurface: Bool = true,
        hiveConfigurationHeadless: Bool = false
    ) {
        precondition(Thread.isMainThread, "Ghostty surface wrappers must be created on the main thread")
        self.rawSurfaceHandle = surface
        self.callbackContext = callbackContext
        self.clipboardContext = clipboardContext
        self.hostView = hostView
        self.appOwner = appOwner
        self.ownsSurface = ownsSurface
        self.hiveConfigurationHeadless = hiveConfigurationHeadless
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

    public func setContentScale(x: Double, y: Double) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return }
        ghostty_surface_set_content_scale(surface, x, y)
    }

    public func setColorScheme(_ scheme: TerminalColorScheme) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return }
        ghostty_surface_set_color_scheme(
            surface,
            scheme == .dark ? GHOSTTY_COLOR_SCHEME_DARK : GHOSTTY_COLOR_SCHEME_LIGHT
        )
    }

    @discardableResult
    public func applyHiveConfiguration(theme: HiveTerminalTheme, font: HiveTerminalFont) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        let key = "\(theme.identifier)|\(font.rawValue)|\(hiveConfigurationHeadless)"
        guard hiveConfigurationKey != key,
              let surface = rawSurfaceHandle,
              let config = try? GhosttyBridgeFactory.makeConfiguration(
                theme: theme,
                font: font,
                headless: hiveConfigurationHeadless
              )
        else { return false }
        defer { ghostty_config_free(config) }
        operationObserver?("surfaceUpdateConfig", .begin)
        ghostty_surface_update_config(surface, config)
        hiveConfigurationKey = key
        operationObserver?("surfaceUpdateConfig", .end)
        NSLog(
            "ghostty_surface_update_config live C1 %@ theme=%@ font=%@",
            HiveTerminalConfiguration.liveLogFingerprint(theme: theme),
            theme.identifier,
            font.rawValue
        )
        return true
    }

    public func setDisplayID(_ displayID: UInt32) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return }
        ghostty_surface_set_display_id(surface, displayID)
    }

    public func setOcclusion(_ visible: Bool) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return }
        ghostty_surface_set_occlusion(surface, visible)
    }

    func foregroundPID() -> UInt64 {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return 0 }
        return ghostty_surface_foreground_pid(surface)
    }

    public func reportedSize() -> ManualSurfaceSize? {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return nil }
        let size = ghostty_surface_size(surface)
        return ManualSurfaceSize(
            columns: size.columns,
            rows: size.rows,
            widthPx: size.width_px,
            heightPx: size.height_px,
            cellWidthPx: size.cell_width_px,
            cellHeightPx: size.cell_height_px
        )
    }

    /// Deliberately does NOT take `feedLock`, unlike every other surface entry point here. Ghostty separates the two halves of rendering and only the first half touches terminal state: - `renderer.updateFrame` (renderer thread) takes `renderer_state.mutex` via `state.lockDemand()`, reads `state.terminal`, and builds the cell buffer. That is the only reader of terminal state. - `renderer.drawFrame`, which is all this calls, takes the renderer's own `draw_mutex` and rasterizes the ALREADY-built cells. It never reads `state.terminal`. `Surface.draw` says so outright: "Renderers are required to support `drawFrame` being called from the main thread." So a draw here and a feed on the terminal I/O thread contend on nothing, and serializing them would only park the main thread behind a VT parse for no benefit — which is exactly the cost this whole change exists to remove.
    public func draw() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return }
        operationObserver?("draw", .begin)
        defer { operationObserver?("draw", .end) }
        ghostty_surface_draw(surface)
    }

    public func refresh() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return }
        ghostty_surface_refresh(surface)
    }

    func keyTranslationMods(_ mods: TerminalModifiers) -> TerminalModifiers {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return mods }
        let native = ghostty_surface_key_translation_mods(
            surface,
            ghostty_input_mods_e(rawValue: mods.rawValue)
        )
        return TerminalModifiers(rawValue: native.rawValue)
    }

    func sendKey(_ key: TerminalKeyEvent) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return false }
        var native = ghostty_input_key_s()
        switch key.action {
        case .release: native.action = GHOSTTY_ACTION_RELEASE
        case .press: native.action = GHOSTTY_ACTION_PRESS
        case .repeat: native.action = GHOSTTY_ACTION_REPEAT
        }
        native.mods = ghostty_input_mods_e(rawValue: key.modifiers.rawValue)
        native.consumed_mods = ghostty_input_mods_e(rawValue: key.consumedModifiers.rawValue)
        native.keycode = key.keycode
        native.unshifted_codepoint = key.unshiftedCodepoint
        native.composing = key.composing
        if let text = key.text {
            return text.withCString { pointer in
                native.text = pointer
                return ghostty_surface_key(surface, native)
            }
        }
        return ghostty_surface_key(surface, native)
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
        if text.isEmpty {
            ghostty_surface_preedit(surface, nil, 0)
            return
        }
        text.withCString { cstr in
            ghostty_surface_preedit(surface, cstr, UInt(text.utf8.count))
        }
    }

    public func mouseCaptured() -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return false }
        return ghostty_surface_mouse_captured(surface)
    }

    public func sendMouseButton(
        state: TerminalMouseButtonState,
        button: TerminalMouseButton,
        modifiers: TerminalModifiers
    ) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return false }
        let nativeState: ghostty_input_mouse_state_e = state == .press
            ? GHOSTTY_MOUSE_PRESS
            : GHOSTTY_MOUSE_RELEASE
        let nativeButton: ghostty_input_mouse_button_e
        switch button {
        case .unknown: nativeButton = GHOSTTY_MOUSE_UNKNOWN
        case .left: nativeButton = GHOSTTY_MOUSE_LEFT
        case .right: nativeButton = GHOSTTY_MOUSE_RIGHT
        case .middle: nativeButton = GHOSTTY_MOUSE_MIDDLE
        case .four: nativeButton = GHOSTTY_MOUSE_FOUR
        case .five: nativeButton = GHOSTTY_MOUSE_FIVE
        case .six: nativeButton = GHOSTTY_MOUSE_SIX
        case .seven: nativeButton = GHOSTTY_MOUSE_SEVEN
        case .eight: nativeButton = GHOSTTY_MOUSE_EIGHT
        case .nine: nativeButton = GHOSTTY_MOUSE_NINE
        case .ten: nativeButton = GHOSTTY_MOUSE_TEN
        case .eleven: nativeButton = GHOSTTY_MOUSE_ELEVEN
        }
        let nativeModifiers = ghostty_input_mods_e(rawValue: modifiers.rawValue)
        return ghostty_surface_mouse_button(surface, nativeState, nativeButton, nativeModifiers)
    }

    func sendMousePos(x: Double, y: Double, modifiers: TerminalModifiers) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return }
        ghostty_surface_mouse_pos(
            surface,
            x,
            y,
            ghostty_input_mods_e(rawValue: modifiers.rawValue)
        )
    }

    func imePoint() -> ManualSurfaceIMEPoint? {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return nil }
        var x: Double = 0
        var y: Double = 0
        var width: Double = 0
        var height: Double = 0
        ghostty_surface_ime_point(surface, &x, &y, &width, &height)
        return ManualSurfaceIMEPoint(x: x, y: y, width: width, height: height)
    }

    public func sendMousePressure(stage: UInt32, pressure: Double) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return }
        ghostty_surface_mouse_pressure(surface, stage, pressure)
    }

    public func performBindingAction(_ action: String) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return false }
        return action.withCString { ptr in
            ghostty_surface_binding_action(surface, ptr, UInt(action.utf8.count))
        }
    }

    public func readSelection() -> (offset: Int, length: Int)? {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return nil }
        var text = ghostty_text_s()
        guard ghostty_surface_read_selection(surface, &text) else { return nil }
        defer { ghostty_surface_free_text(surface, &text) }
        return (offset: Int(text.offset_start), length: Int(text.offset_len))
    }

    func readScreenText() -> String {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return "" }
        var text = ghostty_text_s()
        let selection = ghostty_selection_s(
            top_left: ghostty_point_s(
                tag: GHOSTTY_POINT_SCREEN,
                coord: GHOSTTY_POINT_COORD_TOP_LEFT,
                x: 0,
                y: 0
            ),
            bottom_right: ghostty_point_s(
                tag: GHOSTTY_POINT_SCREEN,
                coord: GHOSTTY_POINT_COORD_BOTTOM_RIGHT,
                x: 0,
                y: 0
            ),
            rectangle: false
        )
        guard ghostty_surface_read_text(surface, selection, &text) else { return "" }
        defer { ghostty_surface_free_text(surface, &text) }
        guard let pointer = text.text else { return "" }
        return String(data: Data(bytes: pointer, count: Int(text.text_len)), encoding: .utf8) ?? ""
    }

    func readSelectedText() -> String? {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return nil }
        var text = ghostty_text_s()
        guard ghostty_surface_read_selection(surface, &text) else { return nil }
        defer { ghostty_surface_free_text(surface, &text) }
        guard let pointer = text.text else { return "" }
        return String(data: Data(bytes: pointer, count: Int(text.text_len)), encoding: .utf8)
    }

    func completeClipboardRequest(
        _ text: String,
        state: UnsafeMutableRawPointer?,
        confirmed: Bool
    ) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return }
        text.withCString { chars in
            ghostty_surface_complete_clipboard_request(surface, chars, state, confirmed)
        }
    }

    public func sendMouseScroll(x: Double, y: Double, mods: Int32) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return }
        ghostty_surface_mouse_scroll(surface, x, y, ghostty_input_scroll_mods_t(mods))
    }

    public func free() {
        performOnMainSync {
            guard self.ownsSurface, let surface = self.rawSurfaceHandle else { return }
            self.clipboardContext.beginTeardown()
            self.callbackContext.beginTeardown()
            GhosttySurfaceCallbackRegistry.shared.unregister(surface)
            self.rawSurfaceHandle = nil
            self.ownsSurface = false
            self.operationObserver?("surfaceFree", .begin)
            defer { self.operationObserver?("surfaceFree", .end) }
            ghostty_surface_free(surface)
            self.appOwner = nil
            self.hostView = nil
        }
    }

    deinit {
        free()
    }

    func withUnsafeSurfaceHandle<T>(_ body: (ghostty_surface_t) -> T) -> T? {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = rawSurfaceHandle else { return nil }
        return body(surface)
    }
}

/// Backs `ghostty_runtime_config_s.wakeup_cb`/`userdata`. ghostty.h: "Callback called to wakeup the event loop. This should trigger a full tick of the app loop" and `ghostty_app_tick`: "should be called whenever the wakeup callback is invoked." Do not leave `wakeup_cb` as a no-op: any Ghostty-internal async work that depends on a later tick to complete silently never does. `app`/`freed` are read-modify-written only on the main thread, and both `scheduleTick` and `freeIfNeeded` run their real work there, so a tick and a free can never interleave: GCD's main queue is serial, so once either closure starts running on main it runs to completion (a synchronous `ghostty_app_tick`/`ghostty_app_free` call cannot be preempted by another main-queue item) before the other can begin. `lock` still guards the fields themselves against non-main readers (e.g. `bind`), but is never held across a C call into Ghostty. `scheduleTick` ALWAYS defers via `DispatchQueue.main.async`, even when already on the main thread — exactly what the pinned Ghostty macOS app's own `wakeup` does (Ghostty.App.swift). This is load-bearing, not style: `App.Mailbox.push` (App.zig) invokes `wakeup_cb` synchronously on the pushing thread, and every surface message chains through it (apprt/surface.zig), so a main-thread C entry point (e.g. `ghostty_surface_key` hitting a binding) can invoke `wakeup_cb` mid-call. An inline tick here would re-enter `ghostty_app_tick` from inside Ghostty's own stack — including recursively from inside a tick's own mailbox drain. Upstream never has to survive re-entrant ticks because its only embedder always defers; ours must too. Deferring also makes a wakeup arriving during a tick harmless (it just enqueues the next tick after the current one completes). `app` is set only after `ghostty_app_new` succeeds (nothing can call wakeup before then) and the free body is guaranteed to run at most once (first caller wins; `freed` is checked and set atomically under `lock` before either the app pointer is cleared or the C frees run). INVARIANT: the ONLY `ghostty_app_tick` call anywhere in this module is the one inside `scheduleTick`'s main-queue closure below. Do not expose a public `tick()` that calls `ghostty_app_tick(app)` directly — that is off-queue and ungated, reachable even after `free()`. If a tick needs triggering from outside `wakeup_cb`, add a method that calls THIS class's `scheduleTick` (or a variant of it), never a bare `ghostty_app_tick(app)`. `grep -rn ghostty_app_tick` in Sources/ should only ever find the one call site below plus doc comments.
final class GhosttyAppWakeupContext: @unchecked Sendable {
    private var app: ghostty_app_t?
    private var freed = false
    private let lock = NSLock()

    var tickOverride: ((ghostty_app_t) -> Void)?

    fileprivate func bind(_ app: ghostty_app_t) {
        lock.lock(); self.app = app; lock.unlock()
    }

    fileprivate func scheduleTick() {
        // Always defer, never tick inline — see the class doc. The pinned app's own wakeup_cb does exactly this unconditionally.
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

    var unownedContextPointer: UnsafeMutableRawPointer {
        Unmanaged.passUnretained(self).toOpaque()
    }
}

let ghosttyAppWakeupTrampoline: ghostty_runtime_wakeup_cb = { userdata in
    guard let userdata else { return }
    let ctx = Unmanaged<GhosttyAppWakeupContext>.fromOpaque(userdata).takeUnretainedValue()
    ctx.scheduleTick()
}

/// Action policy for manual surfaces: every `ghostty_action_tag_e` at the PINNED header is classified — never a blanket false. This embedder handles no action at the apprt level, so every verdict currently resolves to "return false", but `handle` routes through the verdict per-tag via an exhaustive switch and treats an UNKNOWN tag (no verdict) as a loud programmer error (`assertionFailure` in debug), never a silent false — so the false is genuinely typed at the binding, not a blanket. Gate9ActionPolicyTests exercises this behaviorally through the callback (not just the classify table), including a real byte-triggerable action routed to its verdict. UPGRADE-TIME GUARANTEE: the lock carries distinct upstream and bridge header hashes (the bridge header does not contain the action enum). The two-part completeness guarantee is: (1) the whole vendored tree and upstream header are pinned, so any change fails the build chain; and (2) Gate9ActionPolicyTests parses the `ghostty_action_tag_e` enum block directly from that pinned header and asserts its member count equals the classified-set size, so a bump that appends a tag turns RED and demands a verdict. Verdicts: - handledByEffects: visible behavior already flows through the manual vt Handler effects → bridge events (TITLE/PWD/BELL); the action-cb arm of the same signal is deliberately a no-op duplicate. - deniedPolicy: security denials. DESKTOP_NOTIFICATION (raw OSC 9/777 from untrusted agent bytes is a spam/spoof vector; attention signals belong to Hive's own attributed system), SECURE_INPUT (agent output must not flip system secure-input; revisit for user-attach mode), OPEN_URL (no NSWorkspace.open from terminal content). - deniedGesture: Ghostty window/tab/split/quit/inspector management Hive does not delegate. Their KEYBINDS are stripped from the manual config (`keybind = clear`), so these are unreachable-by-construction from input; the verdict remains as defense in depth. - engineInert: engine housekeeping notifications with no consumer here (rendering geometry flows through dedicated size/geometry APIs, not actions).
enum HiveGhosttyActionPolicy {
    enum Verdict: Equatable {
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

    static func classify(_ tag: ghostty_action_tag_e) -> Verdict? {
        if handledByEffectsTags.contains(where: { $0 == tag }) { return .handledByEffects }
        if deniedPolicyTags.contains(where: { $0 == tag }) { return .deniedPolicy }
        if deniedGestureTags.contains(where: { $0 == tag }) { return .deniedGesture }
        if engineInertTags.contains(where: { $0 == tag }) { return .engineInert }
        return nil
    }

    private static let observerLock = NSLock()
    private static var observer: ((ghostty_action_tag_e, Verdict?) -> Void)?
    static func setObserver(_ body: ((ghostty_action_tag_e, Verdict?) -> Void)?) {
        observerLock.lock(); observer = body; observerLock.unlock()
    }

    /// The real callback body. Every action resolves to `false` (nothing is apprt-handled: title/pwd/bell flow through the vt Handler effects → bridge events, denials and inert notifications return false), but the routing is EXHAUSTIVE and per-verdict — an unknown tag is a loud error in debug, never a silent false — so the "never a blanket false" property holds at the binding. Observe-only side channel: SELECTION_CHANGED, SCROLLBAR, SEARCH_TOTAL, and SEARCH_SELECTED are additionally forwarded — payload value-copied, async on main, per-surface — via `GhosttyManualSurface.onActionNotification`. The return value to the engine is unchanged (still false), so the security disposition of all four tags is unaffected.
    static func handle(_ action: ghostty_action_s, target: ghostty_target_s) -> Bool {
        let tag = action.tag
        observerLock.lock()
        let spy = observer
        observerLock.unlock()

        let verdict = classify(tag)
        spy?(tag, verdict)

        switch tag {
        case GHOSTTY_ACTION_SELECTION_CHANGED:
            notifySurface(target, .selectionChanged)
        case GHOSTTY_ACTION_SCROLLBAR:
            // Value copy of the C payload before the callback returns.
            let sb = action.action.scrollbar
            notifySurface(target, .scrollbar(total: sb.total, offset: sb.offset, len: sb.len))
        case GHOSTTY_ACTION_SEARCH_TOTAL:
            let total = action.action.search_total.total
            notifySurface(target, .searchTotal(total >= 0 ? Int(total) : nil))
        case GHOSTTY_ACTION_SEARCH_SELECTED:
            let selected = action.action.search_selected.selected
            notifySurface(target, .searchSelected(selected >= 0 ? Int(selected) : nil))
        default:
            break
        }

        switch verdict {
        case .handledByEffects:
            return false
        case .deniedPolicy, .deniedGesture:
            return false
        case .engineInert:
            return false
        case nil:
            // A tag with no verdict = the classified set drifted from the pinned enum (Gate9ActionPolicyTests guards against this at build). Fail loud in debug so it can never merge silently; still safe (deny) in release.
            assertionFailure("unclassified ghostty action tag \(tag.rawValue) reached the callback — " +
                             "the gate-9 classification is out of sync with the pinned action enum")
            return false
        }
    }

    static func notifySurface(_ target: ghostty_target_s, _ note: HiveTerminalActionNotification) {
        guard target.tag == GHOSTTY_TARGET_SURFACE, let handle = target.target.surface else { return }
        GhosttySurfaceCallbackRegistry.shared.enqueueActionNotification(note, for: handle)
    }
}

/// Announcement-worthy engine actions bridged per-surface. Observe-only — the action callback still returns false to the engine for every carried tag, so nothing privileged is enabled by listening. Payloads map 1:1 to the pinned action structs; `selectionChanged` carries no payload. Search's `-1` sentinel is projected to nil before enqueue. Accessibility consumers must source selection range/text from the atomic semantic snapshot — a separate `readSelection()` read can tear against the snapshot's text/cursor/viewport; treat the notification strictly as an async-main invalidation signal. `readSelection()` remains valid for non-tree consumers.
public enum HiveTerminalActionNotification: Equatable, Sendable {
    case selectionChanged
    case scrollbar(total: UInt64, offset: UInt64, len: UInt64)
    case searchTotal(Int?)
    case searchSelected(Int?)
}

/// Observability for the four non-action runtime callbacks (`close_surface_cb`, `read_clipboard_cb`, `confirm_read_clipboard_cb`, `write_clipboard_cb`). Production behavior is unchanged — deny/no-op — the probes only count invocations so tests can prove a callback that is claimed unreachable genuinely never fired (with a direct-invocation positive control proving the probe itself observes).
enum HiveGhosttyRuntimeCallbackProbe: CaseIterable {
    case closeSurface, readClipboard, confirmReadClipboard, writeClipboard
}

enum HiveGhosttyRuntimeCallbackProbes {
    private static let lock = NSLock()
    private static var counts: [HiveGhosttyRuntimeCallbackProbe: Int] = [:]

    static func record(_ probe: HiveGhosttyRuntimeCallbackProbe) {
        lock.lock(); counts[probe, default: 0] += 1; lock.unlock()
    }

    static func count(_ probe: HiveGhosttyRuntimeCallbackProbe) -> Int {
        lock.lock(); defer { lock.unlock() }
        return counts[probe] ?? 0
    }

}

/// `ghostty_runtime_action_cb` has no userdata parameter. Keep the surface to callback-context association here so renderer-health actions can be copied without calling any Ghostty API from inside the callback. The registry lock is never held across a C call, main-queue hop, or context lock.
private final class GhosttySurfaceCallbackRegistry: @unchecked Sendable {
    static let shared = GhosttySurfaceCallbackRegistry()

    private final class WeakContext {
        weak var value: BridgeCallbackContext?
        init(_ value: BridgeCallbackContext) { self.value = value }
    }

    private let lock = NSLock()
    private var contexts: [UInt: WeakContext] = [:]

    func register(_ surface: ghostty_surface_t, context: BridgeCallbackContext) {
        lock.lock()
        contexts[UInt(bitPattern: surface)] = WeakContext(context)
        lock.unlock()
    }

    func unregister(_ surface: ghostty_surface_t) {
        lock.lock()
        contexts.removeValue(forKey: UInt(bitPattern: surface))
        lock.unlock()
    }

    func enqueueRendererHealth(_ health: RendererHealth, for surface: ghostty_surface_t?) {
        guard let surface else { return }
        lock.lock()
        let context = contexts[UInt(bitPattern: surface)]?.value
        lock.unlock()
        context?.enqueueRendererHealth(health)
    }

    func enqueueActionNotification(_ note: HiveTerminalActionNotification, for surface: ghostty_surface_t?) {
        guard let surface else { return }
        lock.lock()
        let context = contexts[UInt(bitPattern: surface)]?.value
        lock.unlock()
        context?.enqueueActionNotification(note)
    }
}

final class GhosttyAppOwner {
    let app: ghostty_app_t
    let config: ghostty_config_t
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

    func free() {
        wakeupContext.freeIfNeeded { [app, config] in
            self.operationObserver?("app")
            ghostty_app_free(app)
            self.operationObserver?("config")
            ghostty_config_free(config)
        }
    }
}

enum GhosttyBridgeFactory {
    enum FactoryError: Error, LocalizedError, CustomStringConvertible {
        case initFailed
        case configFailed
        case invalidConfig(UInt32)
        case appFailed
        case surfaceFailed

        var description: String {
            switch self {
            case .initFailed: return "ghostty_init failed"
            case .configFailed: return "ghostty_config_new failed"
            case .invalidConfig(let count): return "Hive Ghostty config has \(count) diagnostics"
            case .appFailed: return "ghostty_app_new failed"
            case .surfaceFailed: return "ghostty_surface_new failed"
            }
        }

        var errorDescription: String? { description }
    }

    static var creationObserver: ((String) -> Void)?
    private(set) static var initializationCount = 0
    private static var globalInitialized = false

    /// Builds the runtime config passed to `ghostty_app_new` — pulled out of `makeManualSurface` so tests can assert the REAL factory wires `wakeup_cb`/`userdata` to the real trampoline/context, not a stub. Without this seam, only the trampoline function in isolation is testable and the factory's own wiring could silently regress to a no-op (e.g. `{ _ in }`) with no test catching it.
    static func makeRuntimeConfig(wakeupContext: GhosttyAppWakeupContext) -> ghostty_runtime_config_s {
        ghostty_runtime_config_s(
            userdata: wakeupContext.unownedContextPointer,
            supports_selection_clipboard: false,
            wakeup_cb: ghosttyAppWakeupTrampoline,
            action_cb: { _, target, action in
                let handled = HiveGhosttyActionPolicy.handle(action, target: target)
                if action.tag == GHOSTTY_ACTION_RENDERER_HEALTH,
                   target.tag == GHOSTTY_TARGET_SURFACE {
                    let health: RendererHealth = action.action.renderer_health == GHOSTTY_RENDERER_HEALTH_HEALTHY
                        ? .healthy
                        : .unhealthy
                    GhosttySurfaceCallbackRegistry.shared.enqueueRendererHealth(
                        health,
                        for: target.target.surface
                    )
                }
                return handled
            },
            read_clipboard_cb: { userdata, location, state in
                HiveGhosttyRuntimeCallbackProbes.record(.readClipboard)
                return GhosttyClipboardContext.fromUserdata(userdata)?.beginRead(
                    location: location,
                    state: state
                ) ?? false
            },
            confirm_read_clipboard_cb: { userdata, string, state, request in
                HiveGhosttyRuntimeCallbackProbes.record(.confirmReadClipboard)
                GhosttyClipboardContext.fromUserdata(userdata)?.confirmRead(
                    string: string,
                    state: state,
                    request: request
                )
            },
            write_clipboard_cb: { userdata, location, content, count, confirm in
                HiveGhosttyRuntimeCallbackProbes.record(.writeClipboard)
                GhosttyClipboardContext.fromUserdata(userdata)?.write(
                    location: location,
                    content: content,
                    count: count,
                    confirm: confirm
                )
            },
            close_surface_cb: { _, _ in
                HiveGhosttyRuntimeCallbackProbes.record(.closeSurface)
            }
        )
    }

    /// Stock Ghostty surface: Ghostty opens the PTY and execs `launch.command`.
    static func makeOwnedSurface(
        hostView: NSView,
        launch: TerminalLaunch,
        widthPx: UInt32 = 800,
        heightPx: UInt32 = 480
    ) throws -> GhosttyManualSurface {
        try performOnMainSync {
            try makeOwnedSurfaceOnMain(
                hostView: hostView,
                launch: launch,
                widthPx: widthPx,
                heightPx: heightPx
            )
        }
    }

    static func makeOwnedSurfaceOnMain(
        hostView: NSView,
        launch: TerminalLaunch,
        widthPx: UInt32,
        heightPx: UInt32,
        clipboardContext: GhosttyClipboardContext = GhosttyClipboardContext(),
        hiveConfigurationHeadless: Bool = false
    ) throws -> GhosttyManualSurface {
        dispatchPrecondition(condition: .onQueue(.main))

        try ensureGlobalInitializedOnMain()

        creationObserver?("configNew")
        let config = try makeConfiguration(
            headless: hiveConfigurationHeadless
        )

        let wakeupContext = GhosttyAppWakeupContext()
        var runtime = makeRuntimeConfig(wakeupContext: wakeupContext)

        creationObserver?("appNew")
        guard let app = ghostty_app_new(&runtime, config) else {
            ghostty_config_free(config)
            throw FactoryError.appFailed
        }
        let owner = GhosttyAppOwner(app: app, config: config, wakeupContext: wakeupContext)
        let callbackContext = BridgeCallbackContext()

        creationObserver?("surfaceNew")
        guard let surface = createOwnedSurface(
            app: app,
            hostView: hostView,
            launch: launch,
            userdata: clipboardContext.unownedContextPointer
        ) else {
            throw FactoryError.surfaceFailed
        }
        GhosttySurfaceCallbackRegistry.shared.register(surface, context: callbackContext)

        let w = widthPx > 0 ? widthPx : UInt32(max(1, hostView.bounds.width))
        let h = heightPx > 0 ? heightPx : UInt32(max(1, hostView.bounds.height))
        ghostty_surface_set_size(surface, w, h)

        let manualSurface = GhosttyManualSurface(
            surface: surface,
            callbackContext: callbackContext,
            clipboardContext: clipboardContext,
            hostView: hostView,
            appOwner: owner,
            ownsSurface: true,
            hiveConfigurationHeadless: hiveConfigurationHeadless
        )
        clipboardContext.bind(surface: manualSurface)
        return manualSurface
    }

    private static func createOwnedSurface(
        app: ghostty_app_t,
        hostView: NSView,
        launch: TerminalLaunch,
        userdata: UnsafeMutableRawPointer
    ) -> ghostty_surface_t? {
        launch.workingDirectory.withCString { cwd in
            launch.command.withCString { command in
                withCStringList(Array(launch.environment.keys)) { keyPointers in
                    withCStringList(Array(launch.environment.values)) { valuePointers in
                        var envVars: [ghostty_env_var_s] = []
                        envVars.reserveCapacity(keyPointers.count)
                        for index in keyPointers.indices {
                            envVars.append(
                                ghostty_env_var_s(key: keyPointers[index], value: valuePointers[index])
                            )
                        }
                        return envVars.withUnsafeMutableBufferPointer { buffer in
                            var surfaceConfig = ghostty_surface_config_new()
                            surfaceConfig.userdata = userdata
                            surfaceConfig.platform_tag = GHOSTTY_PLATFORM_MACOS
                            surfaceConfig.platform = ghostty_platform_u(
                                macos: ghostty_platform_macos_s(
                                    nsview: Unmanaged.passUnretained(hostView).toOpaque()
                                )
                            )
                            surfaceConfig.scale_factor = Double(
                                hostView.window?.backingScaleFactor ?? 1.0
                            )
                            surfaceConfig.working_directory = cwd
                            surfaceConfig.command = command
                            surfaceConfig.wait_after_command = true
                            if !buffer.isEmpty {
                                surfaceConfig.env_vars = buffer.baseAddress
                                surfaceConfig.env_var_count = buffer.count
                            }
                            return ghostty_surface_new(app, &surfaceConfig)
                        }
                    }
                }
            }
        }
    }

    private static func withCStringList<T>(
        _ strings: [String],
        _ body: ([UnsafePointer<CChar>]) -> T
    ) -> T {
        guard let first = strings.first else { return body([]) }
        return first.withCString { pointer in
            withCStringList(Array(strings.dropFirst())) { rest in
                body([pointer] + rest)
            }
        }
    }

    private static func ensureGlobalInitializedOnMain() throws {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !globalInitialized else { return }
        creationObserver?("init")
        guard ghostty_init(0, nil) == 0 else { throw FactoryError.initFailed }
        globalInitialized = true
        initializationCount += 1
    }

    static func makeConfiguration(
        theme: HiveTerminalTheme = .hiveDark,
        font: HiveTerminalFont = .embedded,
        headless: Bool = false
    ) throws -> ghostty_config_t {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let config = ghostty_config_new() else { throw FactoryError.configFailed }
        for url in HiveTerminalConfiguration.configurationFiles(
            theme: theme, font: font, headless: headless
        ) {
            url.path.withCString { ghostty_config_load_file(config, $0) }
        }
        ghostty_config_finalize(config)
        let diagnosticCount = ghostty_config_diagnostics_count(config)
        guard diagnosticCount == 0 else {
            ghostty_config_free(config)
            throw FactoryError.invalidConfig(diagnosticCount)
        }
        return config
    }
}

func performOnMainSync<T>(_ body: @escaping () throws -> T) rethrows -> T {
    if Thread.isMainThread {
        return try body()
    }
    return try DispatchQueue.main.sync(execute: body)
}
