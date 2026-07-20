import AppKit
import Carbon
import Foundation
import IOKit.hidsystem

/// Input (M8, gate 8): native NSEvent → ghostty_surface_key/text/preedit/mouse
/// → claim-bound write callback (encoder out). Split from HiveTerminalView.swift
/// so gate 8 (input/IME/mouse) and gate 7 (rendering/geometry/GPU) can land in
/// parallel without touching the same file (M1-B1, 2026-07-17).
extension HiveTerminalView {
    // MARK: - First responder / input (M8)

    public override var acceptsFirstResponder: Bool { true }

    public override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        if result {
            engine.setFocus(true)
            accessibilityFocusDidChange()
        }
        return result
    }

    public override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        accessibilityFocusDidChange()
        _ = forwardMouse(event, state: .press)
    }

    public override func mouseUp(with event: NSEvent) {
        _ = forwardMouse(event, state: .release)
        previousPressureStage = 0
        engine.sendMousePressure(stage: 0, pressure: 0)
    }

    public override func rightMouseDown(with event: NSEvent) {
        if !forwardMouse(event, state: .press) {
            super.rightMouseDown(with: event)
        }
    }

    public override func rightMouseUp(with event: NSEvent) {
        if !forwardMouse(event, state: .release) {
            super.rightMouseUp(with: event)
        }
    }

    public override func otherMouseDown(with event: NSEvent) {
        _ = forwardMouse(event, state: .press)
    }

    public override func otherMouseUp(with event: NSEvent) {
        _ = forwardMouse(event, state: .release)
    }

    public override func mouseDragged(with event: NSEvent) {
        forwardMousePosition(event)
    }

    public override func mouseMoved(with event: NSEvent) {
        forwardMousePosition(event)
    }

    public override func rightMouseDragged(with event: NSEvent) {
        forwardMousePosition(event)
    }

    public override func otherMouseDragged(with event: NSEvent) {
        forwardMousePosition(event)
    }

    public override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .mouseMoved, .inVisibleRect, .activeAlways],
            owner: self,
            userInfo: nil
        ))
    }

    public override func mouseEntered(with event: NSEvent) {
        super.mouseEntered(with: event)
        forwardMousePosition(event)
    }

    public override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        guard NSEvent.pressedMouseButtons == 0 else { return }
        engine.sendMousePos(x: -1, y: -1, modifiers: mapMods(event.modifierFlags))
    }

    private func forwardMousePosition(_ event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        engine.sendMousePos(x: p.x, y: bounds.height - p.y, modifiers: mapMods(event.modifierFlags))
    }

    /// Pre-B1 snapshot had no scrollWheel override at all — scroll never
    /// reached the terminal. Matches Surface View's scrollWheel exactly:
    /// 2x precision-scroll multiplier, and the packed scroll-mods bitmask
    /// (bit 0 precision, bits 1-3 momentum phase) from Ghostty.Input.
    /// ScrollMods — sourced, not invented (see ManualSurfaceEngine.
    /// sendMouseScroll's doc comment for the exact bit layout).
    public override func scrollWheel(with event: NSEvent) {
        var x = event.scrollingDeltaX
        var y = event.scrollingDeltaY
        let precision = event.hasPreciseScrollingDeltas
        if precision {
            x *= 2
            y *= 2
        }
        let mods = HiveTerminalView.scrollMods(precision: precision, momentumPhase: event.momentumPhase)
        engine.sendMouseScroll(x: x, y: y, mods: mods)
    }

    public override func pressureChange(with event: NSEvent) {
        forwardMousePressure(stage: event.stage, pressure: Double(event.pressure))
        guard previousPressureStage < 2 else { return }
        previousPressureStage = event.stage
    }

    func forwardMousePressure(stage: Int, pressure: Double) {
        engine.sendMousePressure(stage: UInt32(stage), pressure: pressure)
    }

    public override func menu(for event: NSEvent) -> NSMenu? {
        if event.type == .leftMouseDown,
           event.modifierFlags.contains(.control),
           engine.mouseCaptured() {
            return nil
        }
        return super.menu(for: event)
    }

    /// Pure encoding, split out so every momentum phase is deterministic in
    /// tests; a CGEvent-backed test separately proves scrollWheel wiring and
    /// real pinned-engine xterm SGR output. Bit layout from Ghostty.Input.ScrollMods
    /// (macos/Sources/Ghostty/Ghostty.Input.swift): bit 0 precision,
    /// bits 1-3 momentum phase (NSEvent.Phase → Ghostty.Input.Momentum).
    static func scrollMods(precision: Bool, momentumPhase: NSEvent.Phase) -> Int32 {
        let momentum: Int32
        switch momentumPhase {
        case .began: momentum = 1
        case .stationary: momentum = 2
        case .changed: momentum = 3
        case .ended: momentum = 4
        case .cancelled: momentum = 5
        case .mayBegin: momentum = 6
        default: momentum = 0
        }
        var mods: Int32 = 0
        if precision { mods |= 0b0000_0001 }
        mods |= momentum << 1
        return mods
    }

    public override func keyDown(with event: NSEvent) {
        if activeClaimNeeded(for: event) {
            try? attachClient?.beginClaimAcquire()
        }
        handleKeyDown(event) { self.interpretKeyEvents([$0]) }
    }

    /// Deterministic seam for the AppKit `interpretKeyEvents` callback cycle.
    /// Tests supply the same synchronous setMarkedText/insertText calls an input
    /// method makes, without depending on the machine's active keyboard layout.
    func handleKeyDown(
        _ event: NSEvent,
        keyboardLayoutID: () -> String? = HiveTerminalView.currentKeyboardLayoutID,
        interpret: (NSEvent) -> Void
    ) {
        let translatedGhosttyMods = engine.keyTranslationMods(mapMods(event.modifierFlags))
        let translatedFlags = Self.eventModifierFlags(translatedGhosttyMods)

        // Preserve AppKit's hidden dead-key bits and change only the four
        // device-independent modifiers Ghostty is allowed to translate.
        var translationMods = event.modifierFlags
        for flag in [NSEvent.ModifierFlags.shift, .control, .option, .command] {
            if translatedFlags.contains(flag) {
                translationMods.insert(flag)
            } else {
                translationMods.remove(flag)
            }
        }

        // Reusing the original object when flags are unchanged is required by
        // AppKit's Korean input method; constructing an equivalent event breaks it.
        let translationEvent: NSEvent
        if translationMods == event.modifierFlags {
            translationEvent = event
        } else {
            translationEvent = NSEvent.keyEvent(
                with: event.type,
                location: event.locationInWindow,
                modifierFlags: translationMods,
                timestamp: event.timestamp,
                windowNumber: event.windowNumber,
                context: nil,
                characters: event.characters(byApplyingModifiers: translationMods) ?? "",
                charactersIgnoringModifiers: event.charactersIgnoringModifiers ?? "",
                isARepeat: event.isARepeat,
                keyCode: event.keyCode
            ) ?? event
        }

        let action: TerminalKeyAction = event.isARepeat ? .repeat : .press
        keyTextAccumulator = []
        defer { keyTextAccumulator = nil }

        let markedTextBefore = hasMarkedText()
        let keyboardIDBefore = markedTextBefore ? nil : keyboardLayoutID()
        interpret(translationEvent)
        if !markedTextBefore, keyboardIDBefore != keyboardLayoutID() {
            return
        }
        syncPreedit(clearIfNeeded: markedTextBefore)
        let composing = hasMarkedText() || markedTextBefore

        if markedTextBefore, let textList = keyTextAccumulator, !textList.isEmpty {
            for text in textList where !Self.shouldSuppressComposingControlInput(text, composing: composing) {
                _ = committedPreeditTextAction(action, text: text)
            }
            if shouldReplayCommittedPreeditKey(translationEvent) {
                _ = keyAction(
                    action,
                    event: event,
                    translationEvent: translationEvent,
                    composing: false
                )
            }
            return
        }

        if let textList = keyTextAccumulator, !textList.isEmpty {
            for text in textList where !Self.shouldSuppressComposingControlInput(text, composing: composing) {
                _ = keyAction(
                    action,
                    event: event,
                    translationEvent: translationEvent,
                    text: text
                )
            }
        } else {
            guard !Self.shouldSuppressComposingControlInput(event.characters, composing: composing) else { return }
            _ = keyAction(
                action,
                event: event,
                translationEvent: translationEvent,
                text: ghosttyCharacters(for: translationEvent),
                composing: composing
            )
        }
    }

    /// Pre-B1 snapshot had no keyUp override at all — GHOSTTY_ACTION_RELEASE
    /// was dead code inside encodeKey, since encodeKey was only ever called
    /// from keyDown. Real Ghostty's keyUp is simple (no IME choreography,
    /// unlike keyDown): `keyAction(GHOSTTY_ACTION_RELEASE, event: event)`.
    public override func keyUp(with event: NSEvent) {
        encodeKey(event, action: .release)
    }

    /// Pre-B1 snapshot had no flagsChanged override — a bare modifier
    /// press/release (Shift alone, Option alone, ...) with no accompanying
    /// character never reached the terminal at all. Exact port of Surface
    /// View's flagsChanged (SurfaceView_AppKit.swift ~1405-1450): maps the
    /// specific modifier keyCode to its GHOSTTY_MODS_* bit, skips while
    /// composing (an IME grabbing modifier state mid-composition shouldn't
    /// also be encoded as a terminal key event), and determines press vs.
    /// release by checking whether the CORRECT side's NX_DEVICE*KEYMASK bit
    /// is set — e.g. releasing right-shift while left-shift is still held
    /// must report a release (mods.rawValue & mod != 0 alone can't tell
    /// which side is still down).
    public override func flagsChanged(with event: NSEvent) {
        let modifier: TerminalModifiers
        switch event.keyCode {
        case 0x39: modifier = .capsLock
        case 0x38, 0x3C: modifier = .shift
        case 0x3B, 0x3E: modifier = .control
        case 0x3A, 0x3D: modifier = .option
        case 0x37, 0x36: modifier = .command
        default: return
        }

        if hasMarkedText() { return }

        let mods = mapMods(event.modifierFlags)

        var action: TerminalKeyAction = .release
        if mods.contains(modifier) {
            let sidePressed: Bool
            switch event.keyCode {
            case 0x3C: sidePressed = event.modifierFlags.rawValue & UInt(NX_DEVICERSHIFTKEYMASK) != 0
            case 0x3E: sidePressed = event.modifierFlags.rawValue & UInt(NX_DEVICERCTLKEYMASK) != 0
            case 0x3D: sidePressed = event.modifierFlags.rawValue & UInt(NX_DEVICERALTKEYMASK) != 0
            case 0x36: sidePressed = event.modifierFlags.rawValue & UInt(NX_DEVICERCMDKEYMASK) != 0
            default: sidePressed = true
            }
            if sidePressed { action = .press }
        }

        encodeKey(event, action: action)
    }

    // MARK: NSTextInputClient

    /// Intentional divergence from the pinned SurfaceView_AppKit line
    /// "We must have an associated event" (`guard NSApp.currentEvent != nil`).
    /// Hive accepts eventless commits from dictation, Character Viewer, and
    /// Services. `keyTextAccumulator` is the explicit routing boundary:
    /// synchronous keyDown commits fold into that physical key exactly once,
    /// while eventless NSTextInputClient commits use the surface text/preedit
    /// path. Tests deliberately drive `associatedEvent: nil` through the same
    /// implementation (some XCTest runners retain a synthetic current event);
    /// restoring the upstream guard would remove that host capability.
    public func insertText(_ string: Any, replacementRange: NSRange) {
        insertText(string, replacementRange: replacementRange, associatedEvent: NSApp.currentEvent)
    }

    /// Deterministic seam for the pinned upstream associated-event guard.
    /// `associatedEvent` is deliberately not guarded: eventless commits are a
    /// supported host capability, not an XCTest accident.
    func insertText(_ string: Any, replacementRange: NSRange, associatedEvent: NSEvent?) {
        let text: String
        if let s = string as? String {
            text = s
        } else if let a = string as? NSAttributedString {
            text = a.string
        } else {
            return
        }
        let hadMarkedText = hasMarkedText()
        unmarkText()

        if var accumulator = keyTextAccumulator {
            accumulator.append(text)
            keyTextAccumulator = accumulator
            return
        }

        ensureClaimForAuthoring()
        if hadMarkedText, !text.isEmpty {
            _ = committedPreeditTextAction(.press, text: text)
        } else if !text.isEmpty {
            engine.sendText(text)
        }
    }

    public func hasMarkedText() -> Bool { markedText.length > 0 }
    public func markedRange() -> NSRange {
        guard markedText.length > 0 else { return NSRange(location: NSNotFound, length: 0) }
        return NSRange(location: 0, length: markedText.length)
    }
    /// Real selection range from Ghostty's own selection tracking
    /// (ghostty_surface_read_selection), matching Surface View's
    /// selectedRange() exactly — the pre-B1 snapshot returned a hardcoded
    /// NSNotFound placeholder regardless of actual terminal selection.
    public func selectedRange() -> NSRange {
        guard let selection = engine.readSelection() else {
            return NSRange(location: NSNotFound, length: 0)
        }
        return NSRange(location: selection.offset, length: selection.length)
    }
    public func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        if let attributed = string as? NSAttributedString {
            markedText = NSMutableAttributedString(attributedString: attributed)
        } else if let text = string as? String {
            markedText = NSMutableAttributedString(string: text)
        } else {
            return
        }
        ensureClaimForAuthoring()
        if keyTextAccumulator == nil {
            syncPreedit()
        }
    }
    public func unmarkText() {
        guard markedText.length > 0 else { return }
        markedText.mutableString.setString("")
        syncPreedit()
    }
    public func validAttributesForMarkedText() -> [NSAttributedString.Key] { [] }
    public func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? {
        guard range.length > 0, let text = engine.readSelectedText() else { return nil }
        actualRange?.pointee = selectedRange()
        return NSAttributedString(string: text)
    }
    public func characterIndex(for point: NSPoint) -> Int { 0 }
    /// Real IME insertion-point positioning via ghostty_surface_ime_point,
    /// matching Surface View's core firstRect exactly (coordinate
    /// conversion: Ghostty reports top-left-origin points, AppKit is
    /// bottom-left-origin, so y flips within this view's frame before
    /// converting to window coordinates). Pre-B1 snapshot always returned
    /// the whole view's bounds, so every IME candidate window/composition
    /// popover rendered in the same wrong place regardless of cursor
    /// position — "placeholder IME ranges" was as much about this as about
    /// markedRange/selectedRange.
    ///
    /// Not ported: Surface View's QuickLook-vs-IME disambiguation (checks
    /// range against selectedRange(), reads the live selection via
    /// ghostty_surface_read_selection for the QuickLook case). This view
    /// doesn't implement quickLook(with:), so that branch is dead code here.
    public func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        actualRange?.pointee = range
        guard let point = engine.imePoint() else {
            let fallback = NSRect(origin: bounds.origin, size: .zero)
            return toScreen(convert(fallback, to: nil))
        }
        var viewRect = NSRect(
            x: point.x,
            y: bounds.height - point.y,
            width: point.width,
            height: point.height
        )
        if range.length == 0, viewRect.width > 0 {
            // imePoint.width is the whole preedit width, not one cell.
            // Gate 7 reports the cell in backing pixels; divide by the
            // renderer's applied scale to keep NSTextInputClient in points.
            if let size = engine.reportedSize(),
               size.cellWidthPx > 0,
               appliedContentScale.width > 0 {
                let cellWidthPoints = Double(size.cellWidthPx) / appliedContentScale.width
                viewRect.origin.x += cellWidthPoints * Double(range.location + range.length)
            }
            viewRect.size.width = 0
        }
        return toScreen(convert(viewRect, to: nil))
    }

    /// NSTextInputClient's firstRect contract is SCREEN coordinates.
    /// Cross-vendor review (bram, 2026-07-18) caught this returning window
    /// coordinates — in a window with nonzero screen origin every IME
    /// candidate window rendered displaced. Matches the pinned Surface
    /// View exactly: view→window via convert(_:to: nil), then
    /// window.convertToScreen, window rect as the no-window fallback.
    private func toScreen(_ winRect: NSRect) -> NSRect {
        guard let window else { return winRect }
        return window.convertToScreen(winRect)
    }
    public override func doCommand(by selector: Selector) {
        // Fall through to key encoding path; Ghostty owns terminal commands.
        _ = selector
    }

    public func focusExplicitly() {
        window?.makeFirstResponder(self)
        accessibilityFocusDidChange()
    }

    public override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        if result {
            engine.setFocus(false)
            accessibilityFocusDidChange()
        }
        return result
    }

    @IBAction public func copy(_ sender: Any?) {
        _ = engine.performBindingAction("copy_to_clipboard")
    }

    @IBAction public func paste(_ sender: Any?) {
        ensureClaimForAuthoring()
        _ = engine.performBindingAction("paste_from_clipboard")
    }

    @IBAction public override func selectAll(_ sender: Any?) {
        _ = engine.performBindingAction("select_all")
    }

    @discardableResult
    public func search(_ needle: String) -> Bool {
        engine.performBindingAction("search:\(needle)")
    }

    @discardableResult
    public func navigateSearchToNext() -> Bool {
        engine.performBindingAction("navigate_search:next")
    }

    @discardableResult
    public func navigateSearchToPrevious() -> Bool {
        engine.performBindingAction("navigate_search:previous")
    }

    public func endSearch() {
        _ = engine.performBindingAction("end_search")
    }

    // MARK: - Input helpers

    /// Direct key-action seam used by releases, modifier changes, and byte
    /// goldens. `keyDown` uses handleKeyDown so AppKit composition callbacks
    /// are accumulated into this same physical key event.
    func encodeKey(_ event: NSEvent, action explicitAction: TerminalKeyAction? = nil) {
        let action = explicitAction
            ?? (event.type == .keyUp
                ? .release
                : (event.isARepeat ? .repeat : .press))
        let text = event.type == .keyDown ? ghosttyCharacters(for: event) : nil
        _ = keyAction(action, event: event, translationEvent: event, text: text)
    }

    @discardableResult
    private func keyAction(
        _ action: TerminalKeyAction,
        event: NSEvent,
        translationEvent: NSEvent? = nil,
        text: String? = nil,
        composing: Bool = false
    ) -> Bool {
        var key = TerminalKeyEvent(
            action: action,
            modifiers: mapMods(event.modifierFlags),
            consumedModifiers: mapMods(
            (translationEvent?.modifierFlags ?? event.modifierFlags)
                .subtracting([.control, .command])
            ),
            keycode: UInt32(event.keyCode),
            text: nil,
            unshiftedCodepoint: 0,
            composing: composing
        )
        if event.type == .keyDown || event.type == .keyUp,
           let chars = event.characters(byApplyingModifiers: []),
           let codepoint = chars.unicodeScalars.first {
            key.unshiftedCodepoint = codepoint.value
        }

        if let text, !text.isEmpty, let firstByte = text.utf8.first, firstByte >= 0x20 {
            key.text = text
        }
        return engine.sendKey(key)
    }

    @discardableResult
    private func committedPreeditTextAction(
        _ action: TerminalKeyAction,
        text: String
    ) -> Bool {
        engine.sendKey(TerminalKeyEvent(
            action: action,
            modifiers: [],
            consumedModifiers: [],
            keycode: 0,
            text: text,
            unshiftedCodepoint: 0,
            composing: false
        ))
    }

    private func shouldReplayCommittedPreeditKey(_ event: NSEvent) -> Bool {
        switch event.keyCode {
        case 125, 124, 126: return true // down, right, up
        case 123: // plain left is consumed by Korean IMEs
            return !event.modifierFlags.isDisjoint(with: [.shift, .control, .option, .command])
        default: return false
        }
    }

    private func syncPreedit(clearIfNeeded: Bool = true) {
        if markedText.length > 0 {
            engine.sendPreedit(markedText.string)
        } else if clearIfNeeded {
            engine.sendPreedit("")
        }
    }

    static func shouldSuppressComposingControlInput(_ text: String?, composing: Bool) -> Bool {
        guard composing, let text else { return false }
        let scalars = text.unicodeScalars
        guard let scalar = scalars.first,
              scalars.index(after: scalars.startIndex) == scalars.endIndex else {
            return false
        }
        return scalar.value < 0x20
    }

    static func eventModifierFlags(_ mods: TerminalModifiers) -> NSEvent.ModifierFlags {
        var flags: NSEvent.ModifierFlags = []
        if mods.contains(.shift) { flags.insert(.shift) }
        if mods.contains(.control) { flags.insert(.control) }
        if mods.contains(.option) { flags.insert(.option) }
        if mods.contains(.command) { flags.insert(.command) }
        return flags
    }

    static func currentKeyboardLayoutID() -> String? {
        guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
              let pointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else {
            return nil
        }
        return unsafeBitCast(pointer, to: CFString.self) as String
    }

    /// Pinned Ghostty's `NSEvent.ghosttyCharacters`: control-modified
    /// characters are restored before Ghostty's encoder applies Ctrl, and
    /// AppKit's private-use function-key scalars are never injected as text.
    func ghosttyCharacters(for event: NSEvent) -> String? {
        guard let characters = event.characters else { return nil }
        if characters.count == 1,
           let scalar = characters.unicodeScalars.first {
            if scalar.value < 0x20 {
                return event.characters(byApplyingModifiers: event.modifierFlags.subtracting(.control))
            }
            if scalar.value >= 0xF700 && scalar.value <= 0xF8FF {
                return nil
            }
        }
        return characters
    }

    @discardableResult
    func forwardMouse(_ event: NSEvent, state: TerminalMouseButtonState) -> Bool {
        let p = convert(event.locationInWindow, from: nil)
        engine.sendMousePos(x: p.x, y: bounds.height - p.y, modifiers: mapMods(event.modifierFlags))
        return engine.sendMouseButton(
            state: state,
            button: Self.mouseButton(forNSEventButtonNumber: event.buttonNumber),
            modifiers: mapMods(event.modifierFlags)
        )
    }

    /// Exact `Ghostty.Input.MouseButton(fromNSEventButtonNumber:)` table at
    /// the frozen Ghostty pin. NSEvent numbers 3/4 are back/forward and map
    /// to terminal buttons eight/nine, not four/five.
    static func mouseButton(forNSEventButtonNumber buttonNumber: Int) -> TerminalMouseButton {
        switch buttonNumber {
        case 0: return .left
        case 1: return .right
        case 2: return .middle
        case 3: return .eight
        case 4: return .nine
        case 5: return .six
        case 6: return .seven
        case 7: return .four
        case 8: return .five
        case 9: return .ten
        case 10: return .eleven
        default: return .unknown
        }
    }

    /// Exact port of the real Ghostty macOS app's Ghostty.ghosttyMods
    /// (macos/Sources/Ghostty/Ghostty.Input.swift) — symbolic GHOSTTY_MODS_*
    /// constants (not magic numbers), caps lock, and left/right-sided
    /// shift/ctrl/alt/cmd via the NX_DEVICE*KEYMASK device-dependent bits
    /// carried in NSEvent.ModifierFlags.rawValue (NSEvent.modifierFlags's
    /// public API only exposes the device-independent side, which can't
    /// distinguish left/right at all). No num-lock mapping: the real app
    /// doesn't map it either (GHOSTTY_MODS_NUM has no NSEvent equivalent
    /// exposed this way), so matching it exactly means not inventing one.
    func mapMods(_ flags: NSEvent.ModifierFlags) -> TerminalModifiers {
        var mods: TerminalModifiers = []
        if flags.contains(.shift) { mods.insert(.shift) }
        if flags.contains(.control) { mods.insert(.control) }
        if flags.contains(.option) { mods.insert(.option) }
        if flags.contains(.command) { mods.insert(.command) }
        if flags.contains(.capsLock) { mods.insert(.capsLock) }

        let rawFlags = flags.rawValue
        if rawFlags & UInt(NX_DEVICERSHIFTKEYMASK) != 0 { mods.insert(.rightShift) }
        if rawFlags & UInt(NX_DEVICERCTLKEYMASK) != 0 { mods.insert(.rightControl) }
        if rawFlags & UInt(NX_DEVICERALTKEYMASK) != 0 { mods.insert(.rightOption) }
        if rawFlags & UInt(NX_DEVICERCMDKEYMASK) != 0 { mods.insert(.rightCommand) }

        return mods
    }

    func activeClaimNeeded(for event: NSEvent) -> Bool {
        // Ordinary text / delete / paste-like = authoring.
        if let chars = event.charactersIgnoringModifiers, !chars.isEmpty {
            if chars == "\u{1b}" { return false } // Escape often cancel/gesture
            return true
        }
        return false
    }

    func ensureClaimForAuthoring() {
        if case .humanOwned = attachClient?.claimPresentation { return }
        try? attachClient?.beginClaimAcquire()
    }
}
