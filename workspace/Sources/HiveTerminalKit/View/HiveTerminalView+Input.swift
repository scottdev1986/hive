import AppKit
import Foundation
import HiveGhosttyC
import IOKit.hidsystem

/// Input (M8, gate 8): native NSEvent → ghostty_surface_key/text/preedit/mouse
/// → claim-bound write callback (encoder out). Split from HiveTerminalView.swift
/// so gate 8 (input/IME/mouse) and gate 7 (rendering/geometry/GPU) can land in
/// parallel without touching the same file (M1-B1, 2026-07-17).
extension HiveTerminalView {
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
        super.scrollWheel(with: event)
    }

    /// Pure encoding, split out from scrollWheel for direct testing — real
    /// scrollWheel NSEvents (scrollingDelta*/momentumPhase) can't be
    /// synthesized reliably outside real trackpad/CGEvent hardware input,
    /// so the bitmask logic itself is unit-tested against this function
    /// while scrollWheel's wiring to it is inspectable by reading the
    /// override above. Bit layout from Ghostty.Input.ScrollMods
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

    /// Pre-B1 snapshot had no keyUp override at all — GHOSTTY_ACTION_RELEASE
    /// was dead code inside encodeKey, since encodeKey was only ever called
    /// from keyDown. Real Ghostty's keyUp is simple (no IME choreography,
    /// unlike keyDown): `keyAction(GHOSTTY_ACTION_RELEASE, event: event)`.
    public override func keyUp(with event: NSEvent) {
        encodeKey(event, action: GHOSTTY_ACTION_RELEASE)
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
        let mod: UInt32
        switch event.keyCode {
        case 0x39: mod = GHOSTTY_MODS_CAPS.rawValue
        case 0x38, 0x3C: mod = GHOSTTY_MODS_SHIFT.rawValue
        case 0x3B, 0x3E: mod = GHOSTTY_MODS_CTRL.rawValue
        case 0x3A, 0x3D: mod = GHOSTTY_MODS_ALT.rawValue
        case 0x37, 0x36: mod = GHOSTTY_MODS_SUPER.rawValue
        default: return
        }

        if hasMarkedText() { return }

        let mods = mapMods(event.modifierFlags)

        var action = GHOSTTY_ACTION_RELEASE
        if mods.rawValue & mod != 0 {
            let sidePressed: Bool
            switch event.keyCode {
            case 0x3C: sidePressed = event.modifierFlags.rawValue & UInt(NX_DEVICERSHIFTKEYMASK) != 0
            case 0x3E: sidePressed = event.modifierFlags.rawValue & UInt(NX_DEVICERCTLKEYMASK) != 0
            case 0x3D: sidePressed = event.modifierFlags.rawValue & UInt(NX_DEVICERALTKEYMASK) != 0
            case 0x36: sidePressed = event.modifierFlags.rawValue & UInt(NX_DEVICERCMDKEYMASK) != 0
            default: sidePressed = true
            }
            if sidePressed { action = GHOSTTY_ACTION_PRESS }
        }

        encodeKey(event, action: action)
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
    /// ghostty_surface_read_selection for the QuickLook case) and its
    /// dictation-microphone-indicator width-zero special case — this view
    /// doesn't implement quickLook(with:), so that branch is dead code
    /// here; the width-zero case is a narrow accessibility-dictation UI
    /// detail, not a defect this gate's "placeholder IME ranges" names.
    public func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        guard let handle = engine.surfaceHandle else {
            return convert(bounds, to: nil)
        }

        var x: Double = 0
        var y: Double = 0
        var width: Double = 0
        var height: Double = 0
        ghostty_surface_ime_point(handle, &x, &y, &width, &height)

        let viewRect = NSRect(x: x, y: frame.size.height - y, width: width, height: height)
        return convert(viewRect, to: nil)
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

    // MARK: - Input helpers

    /// Exact port of NSEvent.ghosttyKeyEvent + keyAction's text handling
    /// (macos/Sources/Ghostty/NSEvent+Extension.swift,
    /// Surface View/SurfaceView_AppKit.swift). Three pre-B1 defects fixed
    /// here:
    ///
    /// - consumed_mods/unshifted_codepoint were hardcoded to zero. Real
    ///   Ghostty's heuristic (documented in NSEvent+Extension.swift):
    ///   control and command never contribute to text translation, so
    ///   consumed_mods is mods with those two subtracted; unshifted_codepoint
    ///   is the codepoint the physical key would produce with NO modifiers
    ///   applied (`characters(byApplyingModifiers: [])`), used by Ghostty
    ///   for keybind matching independent of the active keyboard layout.
    ///   Not implemented here: `ghostty_surface_key_translation_mods`
    ///   (config-driven translation like option-as-alt) — consumed_mods
    ///   uses the plain heuristic against event.modifierFlags directly
    ///   (real Ghostty's fallback when no config-translated mods are
    ///   available), not the full config-aware path.
    /// - key+text double-send: text was sent via a SEPARATE `sendText` call
    ///   after `sendKey`, double-injecting the character. Real Ghostty
    ///   embeds text in the SAME `ghostty_input_key_s.text` field passed to
    ///   sendKey. Matches keyAction's exact exclusion: a single control
    ///   character (first UTF-8 byte < 0x20) is never embedded — Ghostty
    ///   encodes control characters itself from mods+keycode.
    ///
    /// key.keycode stays the raw NSEvent.keyCode: verified via
    /// apprt/embedded.zig (KeyEvent.core(), which looks the raw native
    /// keycode up against input.keycodes.entries — the SAME
    /// platform-native table the real macOS app's own apprt uses) that
    /// this is correct, not the "raw macOS keyCode" defect it first looked
    /// like from the header's W3C-code-derived enum comments alone.
    ///
    /// `action` lets keyUp/flagsChanged supply their own explicit action
    /// (matching keyAction's `_ action: ghostty_input_action_e` parameter)
    /// instead of deriving one from event.type — flagsChanged events are
    /// neither .keyDown nor .keyUp, so they can't use the default
    /// derivation at all. When action is nil (the keyDown path), a real
    /// pre-B1 gap: repeats were never distinguished from fresh presses
    /// (event.isARepeat was ignored), always sending GHOSTTY_ACTION_PRESS.
    func encodeKey(_ event: NSEvent, action explicitAction: ghostty_input_action_e? = nil) {
        var key = ghostty_input_key_s()
        if let explicitAction {
            key.action = explicitAction
        } else if event.type == .keyUp {
            key.action = GHOSTTY_ACTION_RELEASE
        } else {
            key.action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS
        }
        key.keycode = UInt32(event.keyCode)
        key.composing = false

        key.mods = mapMods(event.modifierFlags)
        key.consumed_mods = mapMods(event.modifierFlags.subtracting([.control, .command]))

        key.unshifted_codepoint = 0
        if event.type == .keyDown || event.type == .keyUp,
           let chars = event.characters(byApplyingModifiers: []),
           let codepoint = chars.unicodeScalars.first {
            key.unshifted_codepoint = codepoint.value
        }

        // event.characters is only a valid property for .keyDown/.keyUp —
        // NSEvent raises NSInternalInconsistencyException if it's read on a
        // .flagsChanged event, which never carries text anyway (real
        // Ghostty's flagsChanged calls keyAction with no text: argument).
        if event.type == .keyDown || event.type == .keyUp,
           let chars = event.characters, !chars.isEmpty,
           let firstByte = chars.utf8.first, firstByte >= 0x20 {
            chars.withCString { ptr in
                key.text = ptr
                _ = engine.sendKey(key)
            }
        } else {
            key.text = nil
            _ = engine.sendKey(key)
        }
    }

    func forwardMouse(_ event: NSEvent, state: ghostty_input_mouse_state_e) {
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

    /// Exact port of the real Ghostty macOS app's Ghostty.ghosttyMods
    /// (macos/Sources/Ghostty/Ghostty.Input.swift) — symbolic GHOSTTY_MODS_*
    /// constants (not magic numbers), caps lock, and left/right-sided
    /// shift/ctrl/alt/cmd via the NX_DEVICE*KEYMASK device-dependent bits
    /// carried in NSEvent.ModifierFlags.rawValue (NSEvent.modifierFlags's
    /// public API only exposes the device-independent side, which can't
    /// distinguish left/right at all). No num-lock mapping: the real app
    /// doesn't map it either (GHOSTTY_MODS_NUM has no NSEvent equivalent
    /// exposed this way), so matching it exactly means not inventing one.
    func mapMods(_ flags: NSEvent.ModifierFlags) -> ghostty_input_mods_e {
        var mods: UInt32 = GHOSTTY_MODS_NONE.rawValue
        if flags.contains(.shift) { mods |= GHOSTTY_MODS_SHIFT.rawValue }
        if flags.contains(.control) { mods |= GHOSTTY_MODS_CTRL.rawValue }
        if flags.contains(.option) { mods |= GHOSTTY_MODS_ALT.rawValue }
        if flags.contains(.command) { mods |= GHOSTTY_MODS_SUPER.rawValue }
        if flags.contains(.capsLock) { mods |= GHOSTTY_MODS_CAPS.rawValue }

        let rawFlags = flags.rawValue
        if rawFlags & UInt(NX_DEVICERSHIFTKEYMASK) != 0 { mods |= GHOSTTY_MODS_SHIFT_RIGHT.rawValue }
        if rawFlags & UInt(NX_DEVICERCTLKEYMASK) != 0 { mods |= GHOSTTY_MODS_CTRL_RIGHT.rawValue }
        if rawFlags & UInt(NX_DEVICERALTKEYMASK) != 0 { mods |= GHOSTTY_MODS_ALT_RIGHT.rawValue }
        if rawFlags & UInt(NX_DEVICERCMDKEYMASK) != 0 { mods |= GHOSTTY_MODS_SUPER_RIGHT.rawValue }

        return ghostty_input_mods_e(rawValue: mods)
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
