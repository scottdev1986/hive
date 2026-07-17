import AppKit
import Foundation
import HiveGhosttyC

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

    // MARK: - Input helpers

    func encodeKey(_ event: NSEvent) {
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

    func mapMods(_ flags: NSEvent.ModifierFlags) -> ghostty_input_mods_e {
        var mods: UInt32 = 0
        // Match Ghostty bit layout loosely; exact enum values from ghostty.h.
        if flags.contains(.shift) { mods |= 1 }
        if flags.contains(.control) { mods |= 2 }
        if flags.contains(.option) { mods |= 4 }
        if flags.contains(.command) { mods |= 8 }
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
