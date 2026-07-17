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
    private let appOwner: GhosttyAppOwner?
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

/// Owns a Ghostty app + config for manual surface creation (M2).
public final class GhosttyAppOwner {
    public let app: ghostty_app_t
    public let config: ghostty_config_t
    private var freed = false

    fileprivate init(app: ghostty_app_t, config: ghostty_config_t) {
        self.app = app
        self.config = config
    }

    deinit {
        free()
    }

    public func free() {
        guard !freed else { return }
        freed = true
        ghostty_app_free(app)
        ghostty_config_free(config)
    }

    public func tick() {
        ghostty_app_tick(app)
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

        var runtime = ghostty_runtime_config_s(
            userdata: nil,
            supports_selection_clipboard: false,
            wakeup_cb: { _ in },
            action_cb: { _, _, _ in false },
            read_clipboard_cb: { _, _, _ in false },
            confirm_read_clipboard_cb: { _, _, _, _ in },
            write_clipboard_cb: { _, _, _, _, _ in },
            close_surface_cb: { _, _ in }
        )

        guard let app = ghostty_app_new(&runtime, config) else {
            ghostty_config_free(config)
            throw FactoryError.appFailed
        }
        let owner = GhosttyAppOwner(app: app, config: config)

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
