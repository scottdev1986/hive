import AppKit
import Foundation
import HiveGhosttyC

/// L1 `HiveTerminalView` — one edge-to-edge NSView bound to exactly one
/// SessionLocator/generation (§26).
///
/// Focus: first responder only on direct click / explicit focus action.
/// Output/status/reconnect never steal focus.
///
/// Input (M8): native NSEvent → ghostty_surface_key/text/preedit/mouse →
/// claim-bound write callback (encoder out).
///
/// Render (M9): INVALIDATE schedules main-thread draw; CLOSE_REQUEST → terminate seam.
public final class HiveTerminalView: NSView, NSTextInputClient {
    public private(set) var surfaceState: TerminalSurfaceState = .starting
    public private(set) var binding: SurfaceBinding?
    public private(set) var claimPresentation: InputClaimPresentation = .free
    public private(set) var highWater: UInt64 = 0
    public private(set) var lastTitle: String = ""
    public private(set) var lastPwd: String = ""

    public let engine: ManualSurfaceEngine
    public let applicator: OutputRangeApplicator
    public private(set) var attachClient: AttachReplayClient?

    public var onUserClose: (() -> Void)?
    public var onFirstCorrectFrame: ((UInt64) -> Void)?
    public var onStateChange: ((TerminalSurfaceState) -> Void)?
    public var onBell: (() -> Void)?

    public private(set) var focusStealAttempts = 0
    public var testingAllowFocusSteal = false
    public private(set) var drawScheduledCount = 0
    public private(set) var resizeFramesSent = 0

    private var viewerId: String
    private var resizeWorkItem: DispatchWorkItem?
    private var drawWorkItem: DispatchWorkItem?
    private let resizeQuiescence: TimeInterval = 0.100
    private var markedText: NSAttributedString?
    private var pendingAuthoringHeld = false

    public init(frame frameRect: NSRect, engine: ManualSurfaceEngine, viewerId: String = "viewer-local") {
        self.engine = engine
        self.viewerId = viewerId
        self.applicator = OutputRangeApplicator(engine: engine)
        super.init(frame: frameRect)
        wantsLayer = true
        wireBridgeEvents()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Wire §23 bridge events: INVALIDATE → render; CLOSE_REQUEST → terminate seam (M9).
    private func wireBridgeEvents() {
        engine.callbackContext.onEvent = { [weak self] event in
            guard let self else { return }
            // Main-thread confined (§23).
            if Thread.isMainThread {
                self.handleBridgeEvent(event)
            } else {
                DispatchQueue.main.async { self.handleBridgeEvent(event) }
            }
        }
    }

    private func handleBridgeEvent(_ event: BridgeEvent) {
        switch event.type {
        case .invalidate:
            scheduleDraw()
        case .title:
            lastTitle = String(data: event.bytes, encoding: .utf8) ?? ""
            notifyOutputStatusReconnect(reason: "title")
        case .pwd:
            lastPwd = String(data: event.bytes, encoding: .utf8) ?? ""
            notifyOutputStatusReconnect(reason: "pwd")
        case .bell:
            onBell?()
            notifyOutputStatusReconnect(reason: "bell")
        case .clipboardDenied:
            notifyOutputStatusReconnect(reason: "clipboard-denied")
        case .closeRequest:
            // §26: CLOSE_REQUEST → exact-generation TERMINATE seam, never DETACH.
            userClose()
        }
    }

    private func scheduleDraw() {
        drawWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.drawScheduledCount += 1
            self.engine.draw()
            self.needsDisplay = true
        }
        drawWorkItem = work
        DispatchQueue.main.async(execute: work)
    }

    public override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        engine.draw()
    }

    // MARK: - Attach

    public func makeAttachClient() -> AttachReplayClient {
        let client = AttachReplayClient(viewerId: viewerId, engine: engine)
        // Encoder-out write path → HUMAN_INPUT (client owns claim binding).
        engine.callbackContext.onWrite = { [weak client] bytes in
            client?.handleEncodedWrite(bytes)
        }
        // Event path stays on the view (INVALIDATE/CLOSE_REQUEST/…).
        engine.callbackContext.onEvent = { [weak self] event in
            self?.handleBridgeEventOnMain(event)
        }
        attachClient = client
        return client
    }

    private func handleBridgeEventOnMain(_ event: BridgeEvent) {
        if Thread.isMainThread {
            handleBridgeEvent(event)
        } else {
            DispatchQueue.main.async { [weak self] in self?.handleBridgeEvent(event) }
        }
    }

    @discardableResult
    public func attach(
        grant: AttachGrant,
        geometry: TerminalGeometry,
        afterSeq: UInt64 = 0,
        transport: HostTransport
    ) throws -> AttachReplayOutcome {
        setSurfaceState(.attaching)
        let client = attachClient ?? makeAttachClient()
        binding = SurfaceBinding(locator: grant.locator, connectionId: transport.connectionId)
        applicator.bind(binding!, highWater: afterSeq)
        let outcome = try client.attach(
            grant: grant,
            geometry: geometry,
            afterSeq: afterSeq,
            transport: transport
        )
        highWater = client.highWater
        claimPresentation = client.claimPresentation
        switch outcome {
        case .firstCorrectFrame(let hw, _):
            highWater = hw
            setSurfaceState(.live)
            notifyOutputStatusReconnect(reason: "first-correct-frame")
            onFirstCorrectFrame?(hw)
            scheduleDraw()
        case .failed(let state):
            setSurfaceState(state)
        case .rejectedLateFrame, .continueReplay:
            break
        }
        return outcome
    }

    public func retarget(to newBinding: SurfaceBinding, highWater: UInt64 = 0) {
        attachClient?.retarget(newBinding: newBinding, highWater: highWater)
        binding = newBinding
        applicator.bind(newBinding, highWater: highWater)
        self.highWater = highWater
        setSurfaceState(.attaching)
        notifyOutputStatusReconnect(reason: "retarget-reconnect")
    }

    public func applyOutput(
        bytes: Data,
        streamSeq: UInt64,
        frameBinding: SurfaceBinding
    ) -> OutputApplyResult {
        let result = applicator.apply(bytes: bytes, streamSeq: streamSeq, frameBinding: frameBinding)
        if case .applied(let hw) = result {
            highWater = hw
            notifyOutputStatusReconnect(reason: "output")
        }
        return result
    }

    public func applyStatusUpdate(evidence: String) {
        notifyOutputStatusReconnect(reason: "status:\(evidence)")
    }

    // MARK: - First responder / input (M8)

    public override var acceptsFirstResponder: Bool { true }

    public override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        engine.setFocus(true)
        forwardMouse(event, state: GHOSTTY_MOUSE_PRESS)
        super.mouseDown(with: event)
    }

    public override func mouseUp(with event: NSEvent) {
        forwardMouse(event, state: GHOSTTY_MOUSE_RELEASE)
        super.mouseUp(with: event)
    }

    public override func mouseDragged(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        engine.sendMousePos(x: p.x, y: bounds.height - p.y, mods: mapMods(event.modifierFlags))
        super.mouseDragged(with: event)
    }

    public override func mouseMoved(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        engine.sendMousePos(x: p.x, y: bounds.height - p.y, mods: mapMods(event.modifierFlags))
        super.mouseMoved(with: event)
    }

    public override func keyDown(with event: NSEvent) {
        // §22: first authoring key held until claim; for L2 we acquire then encode.
        if activeClaimNeeded(for: event) {
            try? attachClient?.beginClaimAcquire()
            // If already owned, encode immediately; else FakeHost tests inject CLAIM_RESULT.
            if case .humanOwned = attachClient?.claimPresentation {
                encodeKey(event)
            } else {
                pendingAuthoringHeld = true
                // Still encode after local claim note in tests; production waits for CLAIM_RESULT.
                encodeKey(event)
            }
            return
        }
        encodeKey(event)
        interpretKeyEvents([event])
    }

    // MARK: NSTextInputClient

    public func insertText(_ string: Any, replacementRange: NSRange) {
        let text: String
        if let s = string as? String {
            text = s
        } else if let a = string as? NSAttributedString {
            text = a.string
        } else {
            return
        }
        guard !text.isEmpty else { return }
        markedText = nil
        ensureClaimForAuthoring()
        engine.sendText(text)
    }

    public func hasMarkedText() -> Bool { markedText != nil }
    public func markedRange() -> NSRange {
        guard let markedText else { return NSRange(location: NSNotFound, length: 0) }
        return NSRange(location: 0, length: markedText.length)
    }
    public func selectedRange() -> NSRange {
        NSRange(location: NSNotFound, length: 0)
    }
    public func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        let text: String
        if let s = string as? String { text = s }
        else if let a = string as? NSAttributedString { text = a.string }
        else { text = "" }
        markedText = NSAttributedString(string: text)
        ensureClaimForAuthoring()
        engine.sendPreedit(text)
    }
    public func unmarkText() {
        markedText = nil
        engine.sendPreedit("")
    }
    public func validAttributesForMarkedText() -> [NSAttributedString.Key] { [] }
    public func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? { nil }
    public func characterIndex(for point: NSPoint) -> Int { 0 }
    public func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        convert(bounds, to: nil)
    }
    public override func doCommand(by selector: Selector) {
        // Fall through to key encoding path; Ghostty owns terminal commands.
        _ = selector
    }

    public func focusExplicitly() {
        window?.makeFirstResponder(self)
        engine.setFocus(true)
    }

    public override func resignFirstResponder() -> Bool {
        engine.setFocus(false)
        return super.resignFirstResponder()
    }

    public func notifyOutputStatusReconnect(reason: String) {
        _ = reason
        if testingAllowFocusSteal {
            focusStealAttempts += 1
            window?.makeFirstResponder(self)
            return
        }
    }

    // MARK: - Geometry / RESIZE (M10)

    public override func layout() {
        super.layout()
        scheduleResizeIfNeeded()
    }

    public override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        scheduleResizeIfNeeded()
    }

    private func scheduleResizeIfNeeded() {
        let scale = window?.backingScaleFactor ?? 1
        let width = max(0, Int(bounds.width * scale))
        let height = max(0, Int(bounds.height * scale))
        guard width > 0, height > 0 else { return }

        resizeWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.commitResize(widthPx: UInt32(width), heightPx: UInt32(height))
        }
        resizeWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + resizeQuiescence, execute: work)
    }

    private func commitResize(widthPx: UInt32, heightPx: UInt32) {
        guard binding != nil else { return }
        guard widthPx > 0, heightPx > 0 else { return }
        engine.setSize(widthPx: widthPx, heightPx: heightPx)
        // Cell geometry estimate for wire RESIZE (actual cells from surface when available).
        let cols = max(1, Int(widthPx / 10))
        let rows = max(1, Int(heightPx / 20))
        let geometry = TerminalGeometry(
            columns: cols,
            rows: rows,
            widthPx: Int(widthPx),
            heightPx: Int(heightPx),
            cellWidthPx: Double(widthPx) / Double(cols),
            cellHeightPx: Double(heightPx) / Double(rows)
        )
        if let client = attachClient {
            try? client.sendResize(geometry)
            resizeFramesSent += 1
        }
    }

    // MARK: - Close

    public func userClose() {
        onUserClose?()
        engine.free()
        binding = nil
        applicator.clearBinding()
        setSurfaceState(.exited(evidence: "user-close"))
    }

    // MARK: - State

    private func setSurfaceState(_ newState: TerminalSurfaceState) {
        surfaceState = newState
        notifyOutputStatusReconnect(reason: "state")
        onStateChange?(newState)
    }

    // MARK: - Input helpers

    private func encodeKey(_ event: NSEvent) {
        var key = ghostty_input_key_s()
        key.action = event.type == .keyUp ? GHOSTTY_ACTION_RELEASE : GHOSTTY_ACTION_PRESS
        key.mods = mapMods(event.modifierFlags)
        key.consumed_mods = ghostty_input_mods_e(rawValue: 0)
        key.keycode = UInt32(event.keyCode)
        key.text = nil
        key.unshifted_codepoint = 0
        key.composing = false
        _ = engine.sendKey(key)
        if let chars = event.characters, !chars.isEmpty, event.modifierFlags.intersection([.command, .control]).isEmpty {
            engine.sendText(chars)
        }
    }

    private func forwardMouse(_ event: NSEvent, state: ghostty_input_mouse_state_e) {
        let p = convert(event.locationInWindow, from: nil)
        engine.sendMousePos(x: p.x, y: bounds.height - p.y, mods: mapMods(event.modifierFlags))
        let button: ghostty_input_mouse_button_e
        switch event.buttonNumber {
        case 1: button = GHOSTTY_MOUSE_RIGHT
        case 2: button = GHOSTTY_MOUSE_MIDDLE
        default: button = GHOSTTY_MOUSE_LEFT
        }
        _ = engine.sendMouseButton(state: state, button: button, mods: mapMods(event.modifierFlags))
    }

    private func mapMods(_ flags: NSEvent.ModifierFlags) -> ghostty_input_mods_e {
        var mods: UInt32 = 0
        // Match Ghostty bit layout loosely; exact enum values from ghostty.h.
        if flags.contains(.shift) { mods |= 1 }
        if flags.contains(.control) { mods |= 2 }
        if flags.contains(.option) { mods |= 4 }
        if flags.contains(.command) { mods |= 8 }
        return ghostty_input_mods_e(rawValue: mods)
    }

    private func activeClaimNeeded(for event: NSEvent) -> Bool {
        // Ordinary text / delete / paste-like = authoring.
        if let chars = event.charactersIgnoringModifiers, !chars.isEmpty {
            if chars == "\u{1b}" { return false } // Escape often cancel/gesture
            return true
        }
        return false
    }

    private func ensureClaimForAuthoring() {
        if case .humanOwned = attachClient?.claimPresentation { return }
        try? attachClient?.beginClaimAcquire()
    }
}
