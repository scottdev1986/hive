import AppKit
import Carbon
import Foundation
import IOKit.hidsystem

extension HiveTerminalView {
    static let dropTypes: Set<NSPasteboard.PasteboardType> = [.fileURL]

    public override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        guard let types = sender.draggingPasteboard.types,
              !Set(types).isDisjoint(with: Self.dropTypes)
        else { return [] }
        return .copy
    }

    public override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        acceptFileDrop(from: sender.draggingPasteboard)
    }

    @discardableResult
    func acceptFileDrop(from pasteboard: NSPasteboard) -> Bool {
        guard let content = Self.droppedFileText(from: pasteboard) else { return false }
        DispatchQueue.main.async { [weak self] in
            self?.insertText(
                content,
                replacementRange: NSRange(location: NSNotFound, length: 0),
                associatedEvent: nil
            )
        }
        return true
    }

    static func droppedFileText(from pasteboard: NSPasteboard) -> String? {
        let paths = (pasteboard.pasteboardItems ?? []).compactMap { item -> String? in
            guard let propertyList = item.propertyList(forType: .fileURL),
                  let url = NSURL(
                      pasteboardPropertyList: propertyList,
                      ofType: .fileURL
                  ) as URL?,
                  url.isFileURL
            else { return nil }
            return shellEscape(url.path)
        }
        return paths.isEmpty ? nil : paths.joined(separator: " ")
    }

    private static func shellEscape(_ text: String) -> String {
        var result = text
        for character in "\\ ()[]{}<>\"'`!#$&;|*?\t" {
            result = result.replacingOccurrences(
                of: String(character),
                with: "\\\(character)"
            )
        }
        return result
    }

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
        onUserInput?(
            event.charactersIgnoringModifiers ?? event.characters ?? "",
            event.modifierFlags.contains(.command),
            event.modifierFlags.contains(.control)
        )
        if handleViewerScrollKey(event) { return }
        handleKeyDown(event) { self.interpretKeyEvents([$0]) }
    }

    /// Hive clears every provider keybind, so the root pane needs explicit, viewer-local history navigation. Modifier-only chords preserve ordinary Home/End/Page keys for the provider and never acquire an input claim.
    func handleViewerScrollKey(_ event: NSEvent) -> Bool {
        let authoringModifiers: NSEvent.ModifierFlags = [
            .shift, .control, .option, .command,
        ]
        guard event.modifierFlags.intersection(authoringModifiers) == .shift else {
            return false
        }
        switch Int(event.keyCode) {
        case kVK_PageUp:
            _ = engine.performBindingAction("scroll_page_up")
            return true
        case kVK_PageDown:
            _ = engine.performBindingAction("scroll_page_down")
            return true
        case kVK_Home:
            _ = engine.performBindingAction("scroll_to_top")
            return true
        case kVK_End:
            _ = performScrollToBottom()
            return true
        default:
            return false
        }
    }

    func handleKeyDown(
        _ event: NSEvent,
        keyboardLayoutID: () -> String? = HiveTerminalView.currentKeyboardLayoutID,
        interpret: (NSEvent) -> Void
    ) {
        let translatedGhosttyMods = engine.keyTranslationMods(mapMods(event.modifierFlags))
        let translatedFlags = Self.eventModifierFlags(translatedGhosttyMods)

        // Preserve AppKit's hidden dead-key bits and change only the four device-independent modifiers Ghostty is allowed to translate.
        var translationMods = event.modifierFlags
        for flag in [NSEvent.ModifierFlags.shift, .control, .option, .command] {
            if translatedFlags.contains(flag) {
                translationMods.insert(flag)
            } else {
                translationMods.remove(flag)
            }
        }

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

    public override func keyUp(with event: NSEvent) {
        encodeKey(event, action: .release)
    }

    /// Bare modifier press/release (Shift alone, Option alone, …) with no accompanying character must still reach the terminal. Maps the specific modifier keyCode to its GHOSTTY_MODS_* bit, skips while composing (an IME grabbing modifier state mid-composition must not also encode as a terminal key event), and determines press vs. release by checking the CORRECT side's NX_DEVICE*KEYMASK bit — e.g. releasing right-shift while left-shift is still held must report a release (`mods.rawValue & mod` alone cannot tell which side is still down).
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

    /// Intentional divergence from the pinned SurfaceView_AppKit line "We must have an associated event" (`guard NSApp.currentEvent != nil`). Hive accepts eventless commits from dictation, Character Viewer, and Services. `keyTextAccumulator` is the explicit routing boundary: synchronous keyDown commits fold into that physical key exactly once, while eventless NSTextInputClient commits use the surface text/preedit path. Tests deliberately drive `associatedEvent: nil` through the same implementation (some XCTest runners retain a synthetic current event); restoring the upstream guard would remove that host capability.
    public func insertText(_ string: Any, replacementRange: NSRange) {
        insertText(string, replacementRange: replacementRange, associatedEvent: NSApp.currentEvent)
    }

    /// Deterministic seam for the pinned upstream associated-event guard. `associatedEvent` is deliberately not guarded: eventless commits are a supported host capability, not an XCTest accident.
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
        clearMarkedText()

        if var accumulator = keyTextAccumulator {
            accumulator.append(text)
            keyTextAccumulator = accumulator
            return
        }

        if !text.isEmpty {
            onUserInput?(text, false, false)
        }
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
    /// Selection range from Ghostty's own tracking (`ghostty_surface_read_selection`). Must not return a hardcoded NSNotFound placeholder when a selection exists.
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
        if keyTextAccumulator == nil, markedText.length > 0 {
            onUserInput?(markedText.string, false, false)
        }
        if keyTextAccumulator == nil {
            syncPreedit()
        }
    }
    public func unmarkText() {
        guard clearMarkedText() else { return }
    }
    @discardableResult
    private func clearMarkedText() -> Bool {
        guard markedText.length > 0 else { return false }
        markedText.mutableString.setString("")
        syncPreedit()
        return true
    }
    public func validAttributesForMarkedText() -> [NSAttributedString.Key] { [] }
    public func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? {
        guard range.length > 0, let text = engine.readSelectedText() else { return nil }
        actualRange?.pointee = selectedRange()
        return NSAttributedString(string: text)
    }
    public func characterIndex(for point: NSPoint) -> Int { 0 }
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

    /// NSTextInputClient's firstRect contract is SCREEN coordinates. Do not return window coordinates: in a window with nonzero screen origin every IME candidate window renders displaced. Convert view→window via `convert(_:to: nil)`, then `window.convertToScreen`, with the window rect as the no-window fallback.
    private func toScreen(_ winRect: NSRect) -> NSRect {
        guard let window else { return winRect }
        return window.convertToScreen(winRect)
    }
    public override func doCommand(by selector: Selector) {
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
        if canCopySelection {
            _ = engine.performBindingAction("copy_to_clipboard")
            return
        }
        guard engine.mouseCaptured(),
              let event = NSEvent.keyEvent(
                  with: .keyDown,
                  location: .zero,
                  modifierFlags: [.command],
                  timestamp: 0,
                  windowNumber: 0,
                  context: nil,
                  characters: "c",
                  charactersIgnoringModifiers: "c",
                  isARepeat: false,
                  keyCode: UInt16(kVK_ANSI_C)
              ) else { return }
        _ = encodeKey(event)
    }

    @IBAction public func paste(_ sender: Any?) {
        onUserInput?("v", true, false)
        _ = engine.performBindingAction("paste_from_clipboard")
    }

    @IBAction public override func selectAll(_ sender: Any?) {
        _ = engine.performBindingAction("select_all")
    }

    @discardableResult
    public func search(_ needle: String) -> Bool {
        updateSearchQuery(needle)
        return engine.performBindingAction("search:\(needle)")
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
        dismissSearchUI(restoreTerminalFocus: true)
    }

    @discardableResult
    func encodeKey(
        _ event: NSEvent,
        action explicitAction: TerminalKeyAction? = nil
    ) -> Bool {
        let action = explicitAction
            ?? (event.type == .keyUp
                ? .release
                : (event.isARepeat ? .repeat : .press))
        let text = event.type == .keyDown ? ghosttyCharacters(for: event) : nil
        return keyAction(
            action,
            event: event,
            translationEvent: event,
            text: text
        )
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

    /// Pinned Ghostty's `NSEvent.ghosttyCharacters`: control-modified characters are restored before Ghostty's encoder applies Ctrl, and AppKit's private-use function-key scalars are never injected as text.
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

}
