import Foundation
@testable import HiveTerminalKit

/// In-process fake for L1/L2 logic tests that do not need the real C boundary.
final class FakeManualSurface: ManualSurfaceEngine, ManualSurfaceSemanticSnapshotProviding {
    let callbackContext: BridgeCallbackContext
    /// Serializes the feed path, matching `GhosttyManualSurface.feedLock`.
    private let feedLock = NSLock()
    private(set) var throughSeq: UInt64 = 0
    private(set) var appliedRanges: [(streamSeq: UInt64, bytes: Data)] = []
    private(set) var restored: [(throughSeq: UInt64, payload: Data)] = []
    private(set) var focusCalls: [Bool] = []
    private(set) var sizeCalls: [(UInt32, UInt32)] = []
    private(set) var contentScaleCalls: [(Double, Double)] = []
    private(set) var colorSchemeCalls: [TerminalColorScheme] = []
    private(set) var hiveConfigurationApplyCount = 0
    private(set) var hiveConfigurationTheme: HiveTerminalTheme?
    private(set) var hiveConfigurationFont: HiveTerminalFont?
    private(set) var displayIDCalls: [UInt32] = []
    private(set) var occlusionCalls: [Bool] = []
    var fakeReportedSize: ManualSurfaceSize?
    var fakeSemanticSnapshot: ManualSurfaceSemanticSnapshot?
    private(set) var drawCount = 0
    private(set) var refreshCount = 0
    private(set) var freed = false
    private(set) var textSent: [String] = []
    private(set) var preeditsSent: [String] = []
    private(set) var keysSent = 0
    /// The C `text` pointer is only valid synchronously, so it's copied to a
    /// Swift String here at call time (mirrors the real bridge's
    /// copy-before-return discipline for callback pointers).
    struct KeySent {
        let action: TerminalKeyAction
        let modifiers: TerminalModifiers
        let consumedModifiers: TerminalModifiers
        let keycode: UInt32
        let unshiftedCodepoint: UInt32
        let text: String?
        let composing: Bool
    }
    private(set) var keysSentDetail: [KeySent] = []

    private var committed: [(streamSeq: UInt64, bytes: Data, digest: Data)] = []

    init(callbackContext: BridgeCallbackContext = BridgeCallbackContext()) {
        self.callbackContext = callbackContext
    }

    /// Counted: the semantic export is the expensive main-thread read (whole
    /// viewport, per-cell offsets, digest, under the renderer mutex), so "how
    /// many times did this path take it" is a property tests assert on, not an
    /// implementation detail.
    private(set) var semanticSnapshotCount = 0

    func semanticSnapshot() -> ManualSurfaceSemanticSnapshot? {
        semanticSnapshotCount += 1
        return fakeSemanticSnapshot
    }

    /// Mirrors the real engine's contract: the feed runs on the caller's thread
    /// (the pane's terminal I/O thread in production), serialized by `feedLock`
    /// rather than by main-queue confinement. A fake that still hopped to main
    /// would hide exactly the main-thread coupling this split removed.
    public func processOutput(bytes: Data, streamSeq: UInt64) -> HiveTerminalEngineResult {
        let ownedBytes = Data(bytes)
        feedLock.lock()
        defer { feedLock.unlock() }
        return processOutputLocked(bytes: ownedBytes, streamSeq: streamSeq)
    }

    private func processOutputLocked(bytes: Data, streamSeq: UInt64) -> HiveTerminalEngineResult {
        if bytes.isEmpty { return .invalidValue }
        let digest = sha256(bytes)
        let (end, overflow) = streamSeq.addingReportingOverflow(UInt64(bytes.count))
        if overflow { return .invalidValue }
        if let existing = committed.first(where: { $0.streamSeq == streamSeq && $0.bytes.count == bytes.count }) {
            return existing.digest == digest ? .success : .invalidValue
        }
        if end <= throughSeq {
            // Fully behind without stored match: engine treats as invalid;
            // applicator may ignore as at-least-once retransmit.
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

    public func restoreCheckpoint(payload: Data, throughSeq: UInt64) -> HiveTerminalEngineResult {
        let ownedPayload = Data(payload)
        feedLock.lock()
        defer { feedLock.unlock() }
        if ownedPayload.isEmpty { return .invalidValue }
        restored.append((throughSeq, ownedPayload))
        committed.removeAll()
        self.throughSeq = throughSeq
        return .success
    }

    public func setFocus(_ focused: Bool) { focusCalls.append(focused) }
    public func setSize(widthPx: UInt32, heightPx: UInt32) { sizeCalls.append((widthPx, heightPx)) }
    public func setContentScale(x: Double, y: Double) { contentScaleCalls.append((x, y)) }
    public func setColorScheme(_ scheme: TerminalColorScheme) { colorSchemeCalls.append(scheme) }
    @discardableResult
    public func applyHiveConfiguration(theme: HiveTerminalTheme, font: HiveTerminalFont) -> Bool {
        guard hiveConfigurationTheme != theme || hiveConfigurationFont != font else { return false }
        hiveConfigurationTheme = theme
        hiveConfigurationFont = font
        hiveConfigurationApplyCount += 1
        return true
    }
    public func setDisplayID(_ displayID: UInt32) { displayIDCalls.append(displayID) }
    public func setOcclusion(_ visible: Bool) { occlusionCalls.append(visible) }
    public func reportedSize() -> ManualSurfaceSize? { fakeReportedSize }
    public func draw() { drawCount += 1 }
    public func refresh() { refreshCount += 1 }
    var translatedKeyMods: TerminalModifiers?
    func keyTranslationMods(_ mods: TerminalModifiers) -> TerminalModifiers {
        translatedKeyMods ?? mods
    }
    func sendKey(_ key: TerminalKeyEvent) -> Bool {
        keysSent += 1
        keysSentDetail.append(KeySent(
            action: key.action,
            modifiers: key.modifiers,
            consumedModifiers: key.consumedModifiers,
            keycode: key.keycode,
            unshiftedCodepoint: key.unshiftedCodepoint,
            text: key.text,
            composing: key.composing
        ))
        return true
    }
    public func sendText(_ text: String) {
        textSent.append(text)
        // Encoder-out tail: fake write callback with UTF-8 bytes.
        callbackContext.onWrite?(Data(text.utf8))
    }
    public func sendPreedit(_ text: String) { preeditsSent.append(text) }
    public var fakeMouseCaptured = false
    public private(set) var mouseCaptureQueryCount = 0
    public func mouseCaptured() -> Bool {
        mouseCaptureQueryCount += 1
        return fakeMouseCaptured
    }
    private(set) var mouseButtonsSent: [(
        state: TerminalMouseButtonState,
        button: TerminalMouseButton,
        mods: TerminalModifiers
    )] = []
    public func sendMouseButton(
        state: TerminalMouseButtonState,
        button: TerminalMouseButton,
        modifiers: TerminalModifiers
    ) -> Bool {
        mouseButtonsSent.append((state, button, modifiers))
        return true
    }
    private(set) var mousePositionsSent: [(x: Double, y: Double, mods: TerminalModifiers)] = []
    func sendMousePos(x: Double, y: Double, modifiers: TerminalModifiers) {
        mousePositionsSent.append((x, y, modifiers))
    }
    private(set) var mousePressuresSent: [(stage: UInt32, pressure: Double)] = []
    func sendMousePressure(stage: UInt32, pressure: Double) {
        mousePressuresSent.append((stage, pressure))
    }
    var fakeIMEPoint: ManualSurfaceIMEPoint?
    func imePoint() -> ManualSurfaceIMEPoint? { fakeIMEPoint }
    var bindingActionResult = true
    private(set) var bindingActions: [String] = []
    func performBindingAction(_ action: String) -> Bool {
        bindingActions.append(action)
        return bindingActionResult
    }
    public var fakeSelection: (offset: Int, length: Int)?
    public func readSelection() -> (offset: Int, length: Int)? { fakeSelection }
    var fakeScreenText = ""
    var fakeSelectedText: String?
    func readScreenText() -> String { fakeScreenText }
    func readSelectedText() -> String? { fakeSelectedText }
    private(set) var clipboardCompletions: [(text: String, state: UnsafeMutableRawPointer?, confirmed: Bool)] = []
    func completeClipboardRequest(_ text: String, state: UnsafeMutableRawPointer?, confirmed: Bool) {
        clipboardCompletions.append((text, state, confirmed))
    }
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
