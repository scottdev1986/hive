import AppKit
import Carbon
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

private final class Gate8DoubleScaleWindow: NSWindow {
    override var backingScaleFactor: CGFloat { 2 }
}

/// Gate 8 (M1-B1) positive control: input encoding matches Ghostty's own
/// macOS app (macos/Sources/Ghostty/{Ghostty.Input,NSEvent+Extension}.swift,
/// Surface View/SurfaceView_AppKit.swift), sourced not guessed. Six flagged
/// snapshot defects, verified individually:
///
/// 1. "loose modifier mapping" — real defect (magic numbers, no caps, no
///    left/right). Fixed, tested below.
/// 2. "raw macOS keyCode" — traced through apprt/embedded.zig's
///    KeyEvent.core(), which looks the raw native keycode up against
///    input.keycodes.entries (the platform-native table the real macOS
///    app's own apprt uses too). The raw value is the correct physical-key
///    input at this API boundary; KittyKeyboardGoldenTests proves both
///    left/right Shift codes against the pinned engine bytes.
/// 3. "zero unshifted/consumed fields" — real defect. Fixed, tested below.
/// 4. "key+text double-send" — real defect. Fixed, tested below.
/// 5. "placeholder IME ranges" — selectedRange() was a hardcoded
///    NSNotFound; now reads ghostty_surface_read_selection via the engine.
///    Fixed, tested below (via FakeManualSurface.fakeSelection).
/// 6. "missing scroll" — real defect (no override existed at all). Fixed
///    with pure momentum/precision controls, CGEvent wiring, and a real
///    pinned-engine xterm SGR byte golden.
final class InputEncodingTests: XCTestCase {
    private func makeKeyEvent(
        type: NSEvent.EventType = .keyDown,
        characters: String,
        charactersIgnoringModifiers: String? = nil,
        modifierFlags: NSEvent.ModifierFlags = [],
        keyCode: UInt16 = 0,
        isARepeat: Bool = false
    ) -> NSEvent {
        NSEvent.keyEvent(
            with: type,
            location: .zero,
            modifierFlags: modifierFlags,
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: characters,
            charactersIgnoringModifiers: charactersIgnoringModifiers ?? characters,
            isARepeat: isARepeat,
            keyCode: keyCode
        )!
    }

    private func makeFlagsChangedEvent(modifierFlags: NSEvent.ModifierFlags, keyCode: UInt16) -> NSEvent {
        NSEvent.keyEvent(
            with: .flagsChanged,
            location: .zero,
            modifierFlags: modifierFlags,
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "",
            charactersIgnoringModifiers: "",
            isARepeat: false,
            keyCode: keyCode
        )!
    }

    private func makeMouseEvent(
        type: NSEvent.EventType,
        location: NSPoint,
        modifierFlags: NSEvent.ModifierFlags = []
    ) -> NSEvent {
        NSEvent.mouseEvent(
            with: type,
            location: location,
            modifierFlags: modifierFlags,
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            eventNumber: 1,
            clickCount: 1,
            pressure: 1
        )!
    }

    private func makeCGMouseEvent(type: CGEventType, button: CGMouseButton) -> NSEvent {
        let cgEvent = CGEvent(
            mouseEventSource: nil,
            mouseType: type,
            mouseCursorPosition: .zero,
            mouseButton: button
        )!
        return NSEvent(cgEvent: cgEvent)!
    }

    private func makeTerminal(_ engine: FakeManualSurface) -> HiveTerminalView {
        HiveTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), engine: engine)
    }

    private func drainMainRunLoop(until predicate: () -> Bool, timeout: TimeInterval = 2) {
        let deadline = Date().addingTimeInterval(timeout)
        while !predicate() && Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
    }

    // MARK: 1. Modifier mapping

    func testModifierMappingUsesSymbolicGhosttyConstants() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        let mods = terminal.mapMods([.shift, .control, .option, .command])
        XCTAssertEqual(
            mods.rawValue,
            GHOSTTY_MODS_SHIFT.rawValue | GHOSTTY_MODS_CTRL.rawValue | GHOSTTY_MODS_ALT.rawValue | GHOSTTY_MODS_SUPER.rawValue
        )
    }

    func testModifierMappingIncludesCapsLock() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        let mods = terminal.mapMods([.capsLock])
        XCTAssertEqual(mods.rawValue & GHOSTTY_MODS_CAPS.rawValue, GHOSTTY_MODS_CAPS.rawValue,
                       "caps lock must be reported — pre-B1 snapshot never mapped it")
    }

    func testModifierMappingDetectsRightSideShiftViaDeviceMask() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        // NSEvent.ModifierFlags's public API can't distinguish sides; the
        // real signal is the device-dependent bits in .rawValue (NX_DEVICE*
        // KEYMASK), which is what a genuine right-shift key press sets.
        let rightShift = NSEvent.ModifierFlags(rawValue: NSEvent.ModifierFlags.shift.rawValue | UInt(NX_DEVICERSHIFTKEYMASK))
        let mods = terminal.mapMods(rightShift)
        XCTAssertEqual(mods.rawValue & GHOSTTY_MODS_SHIFT_RIGHT.rawValue, GHOSTTY_MODS_SHIFT_RIGHT.rawValue,
                       "right shift must be distinguishable — pre-B1 snapshot could not report sided modifiers at all")
        XCTAssertEqual(mods.rawValue & GHOSTTY_MODS_SHIFT.rawValue, GHOSTTY_MODS_SHIFT.rawValue,
                       "the plain (unsided) shift bit must still be set too, matching real Ghostty's ghosttyMods")
    }

    func testModifierMappingPreservesEveryPinnedRightSideBit() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)
        let flags = NSEvent.ModifierFlags(rawValue:
            NSEvent.ModifierFlags.shift.rawValue |
            NSEvent.ModifierFlags.control.rawValue |
            NSEvent.ModifierFlags.option.rawValue |
            NSEvent.ModifierFlags.command.rawValue |
            UInt(NX_DEVICERSHIFTKEYMASK) |
            UInt(NX_DEVICERCTLKEYMASK) |
            UInt(NX_DEVICERALTKEYMASK) |
            UInt(NX_DEVICERCMDKEYMASK)
        )

        let mods = terminal.mapMods(flags)

        XCTAssertEqual(mods.rawValue, GHOSTTY_MODS_SHIFT.rawValue |
            GHOSTTY_MODS_CTRL.rawValue |
            GHOSTTY_MODS_ALT.rawValue |
            GHOSTTY_MODS_SUPER.rawValue |
            GHOSTTY_MODS_SHIFT_RIGHT.rawValue |
            GHOSTTY_MODS_CTRL_RIGHT.rawValue |
            GHOSTTY_MODS_ALT_RIGHT.rawValue |
            GHOSTTY_MODS_SUPER_RIGHT.rawValue)
    }

    // MARK: 3. unshifted_codepoint / consumed_mods

    func testKeyEventCarriesRealUnshiftedCodepointAndConsumedMods() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        // Shift+A: characters="A", but the physical key's unshifted
        // codepoint is 'a' (0x61) — this is what the pre-B1 snapshot always
        // hardcoded to zero.
        let event = makeKeyEvent(characters: "A", charactersIgnoringModifiers: "a", modifierFlags: [.shift], keyCode: 0)
        terminal.encodeKey(event)

        XCTAssertEqual(engine.keysSentDetail.count, 1)
        let sent = engine.keysSentDetail[0]
        XCTAssertEqual(sent.unshiftedCodepoint, 0x61, "the unmodified physical A key must report lowercase 'a'")
        XCTAssertEqual(sent.consumedModifiers.rawValue, GHOSTTY_MODS_SHIFT.rawValue,
                       "consumed_mods must reflect mods minus control/command, not a hardcoded zero")
    }

    func testConsumedModsExcludesControlAndCommand() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        let event = makeKeyEvent(characters: "\u{1}", modifierFlags: [.control, .shift], keyCode: 0)
        terminal.encodeKey(event)

        let sent = engine.keysSentDetail[0]
        // mods carries the real shift+control; consumed_mods drops control
        // (and command) per Ghostty's own heuristic: those never contribute
        // to text translation.
        XCTAssertEqual(sent.modifiers.rawValue, GHOSTTY_MODS_SHIFT.rawValue | GHOSTTY_MODS_CTRL.rawValue)
        XCTAssertEqual(sent.consumedModifiers.rawValue, GHOSTTY_MODS_SHIFT.rawValue)
    }

    func testConfigTranslatedModifiersDriveConsumedModsWithoutChangingPhysicalMods() {
        let engine = FakeManualSurface()
        engine.translatedKeyMods = []
        let terminal = makeTerminal(engine)
        let event = makeKeyEvent(characters: "å", charactersIgnoringModifiers: "a", modifierFlags: [.option])
        var translatedFlags: NSEvent.ModifierFlags?

        terminal.handleKeyDown(event) { translatedEvent in
            translatedFlags = translatedEvent.modifierFlags
            terminal.insertText("a", replacementRange: NSRange(location: NSNotFound, length: 0))
        }

        XCTAssertNotNil(translatedFlags, "the interpretation callback must execute")
        XCTAssertFalse(translatedFlags?.contains(.option) ?? true)
        XCTAssertEqual(engine.keysSentDetail.count, 1)
        XCTAssertEqual(engine.keysSentDetail[0].modifiers.rawValue, GHOSTTY_MODS_ALT.rawValue)
        XCTAssertEqual(engine.keysSentDetail[0].consumedModifiers.rawValue, GHOSTTY_MODS_NONE.rawValue)
        XCTAssertEqual(engine.keysSentDetail[0].text, "a")
    }

    func testModifierTranslationPreservesDeviceDependentEventBitsForDeadKeys() {
        let engine = FakeManualSurface()
        engine.translatedKeyMods = []
        let terminal = makeTerminal(engine)
        let flags = NSEvent.ModifierFlags(rawValue:
            NSEvent.ModifierFlags.option.rawValue | UInt(NX_DEVICERALTKEYMASK)
        )
        let event = makeKeyEvent(characters: "´", modifierFlags: flags, keyCode: 39)
        var translatedFlags: NSEvent.ModifierFlags?

        terminal.handleKeyDown(event) { translatedEvent in
            translatedFlags = translatedEvent.modifierFlags
        }

        XCTAssertNotNil(translatedFlags, "the interpretation callback must execute")
        XCTAssertFalse(translatedFlags?.contains(.option) ?? true)
        XCTAssertNotEqual(
            (translatedFlags?.rawValue ?? 0) & UInt(NX_DEVICERALTKEYMASK),
            0,
            "translation may remove Option but must preserve AppKit's hidden/device-dependent bits"
        )
    }

    func testUnchangedTranslationModifiersReuseTheOriginalNSEventForKoreanIME() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)
        let event = makeKeyEvent(characters: "ㅎ", keyCode: 4)
        var interpretedEvent: NSEvent?

        terminal.handleKeyDown(event) { translatedEvent in
            interpretedEvent = translatedEvent
            terminal.insertText("ㅎ", replacementRange: NSRange(location: NSNotFound, length: 0))
        }

        XCTAssertNotNil(interpretedEvent, "the interpretation callback must execute")
        XCTAssertTrue(interpretedEvent === event)
        XCTAssertEqual(engine.keysSentDetail.first?.text, "ㅎ")
    }

    func testInputSourceSwitchKeyIsNotInjectedIntoTheTerminal() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)
        let event = makeKeyEvent(characters: " ", keyCode: 49)
        var ids = ["com.example.us", "com.example.cjk"].makeIterator()

        terminal.handleKeyDown(event, keyboardLayoutID: { ids.next() }) { _ in }

        XCTAssertTrue(engine.keysSentDetail.isEmpty)
    }

    // MARK: 4. Key+text single-send

    func testPrintableCharacterIsEmbeddedInKeyEventNotSentSeparately() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        let event = makeKeyEvent(characters: "x", keyCode: 7)
        terminal.encodeKey(event)

        XCTAssertEqual(engine.keysSentDetail.count, 1, "exactly one sendKey call")
        XCTAssertEqual(engine.keysSentDetail[0].text, "x", "text must travel inside the key event")
        XCTAssertTrue(engine.textSent.isEmpty,
                      "must not ALSO call sendText — that's the pre-B1 double-send defect " +
                      "(the same character reaching the terminal twice through two paths)")
    }

    func testKeyDownAndTextInputInterpretationInjectPrintableTextExactlyOnce() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        let event = makeKeyEvent(characters: "x", keyCode: 7)
        terminal.handleKeyDown(event) { _ in
            // AppKit calls insertText synchronously while interpretKeyEvents
            // is handling this same physical key.
            terminal.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
        }

        XCTAssertEqual(engine.keysSentDetail.count, 1, "the physical key must be encoded once")
        XCTAssertEqual(engine.keysSentDetail.first?.text, "x")
        XCTAssertTrue(
            engine.textSent.isEmpty,
            "interpretKeyEvents must accumulate its insertText callback into the key event, " +
                "not send the same printable text through ghostty_surface_text as well"
        )
    }

    func testEventlessTextInputIsAnIntentionalDivergenceAndSendsExactlyOnce() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        terminal.insertText(
            "文",
            replacementRange: NSRange(location: NSNotFound, length: 0),
            associatedEvent: nil
        )

        XCTAssertEqual(engine.textSent, ["文"])
        XCTAssertTrue(engine.keysSentDetail.isEmpty, "an eventless commit has no physical key to encode")
    }

    func testControlCharacterUsesGhosttysUncontrolledCharacterText() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        // Ctrl+H arrives from AppKit as backspace (0x08). Pinned Ghostty's
        // ghosttyCharacters removes Control and restores "h" before handing
        // the event to its own Ctrl encoder.
        let event = makeKeyEvent(characters: "\u{8}", modifierFlags: [.control], keyCode: 4)
        terminal.encodeKey(event)

        XCTAssertEqual(engine.keysSentDetail.count, 1)
        XCTAssertEqual(engine.keysSentDetail[0].text, "h")
        XCTAssertTrue(engine.textSent.isEmpty)
    }

    func testAppKitFunctionKeyPrivateUseScalarIsNotInjectedAsText() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)
        let event = makeKeyEvent(characters: "\u{F700}", keyCode: 126)

        terminal.encodeKey(event)

        XCTAssertEqual(engine.keysSentDetail.count, 1)
        XCTAssertNil(engine.keysSentDetail[0].text)
    }

    // MARK: 5. Real selection (was a placeholder)

    func testSelectedRangeReflectsRealEngineSelectionNotAPlaceholder() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        XCTAssertEqual(terminal.selectedRange(), NSRange(location: NSNotFound, length: 0),
                       "no selection yet — must still report NSNotFound, not a fabricated range")

        engine.fakeSelection = (offset: 12, length: 5)
        XCTAssertEqual(terminal.selectedRange(), NSRange(location: 12, length: 5),
                       "must reflect the engine's real selection once one exists")
    }

    func testAttributedSubstringReturnsTheEngineSelectionAndActualRange() {
        let engine = FakeManualSurface()
        engine.fakeSelection = (offset: 8, length: 5)
        engine.fakeSelectedText = "hello"
        let terminal = makeTerminal(engine)
        var actual = NSRange(location: NSNotFound, length: 0)

        let result = terminal.attributedSubstring(
            forProposedRange: NSRange(location: 0, length: 5),
            actualRange: &actual
        )

        XCTAssertEqual(result?.string, "hello")
        XCTAssertEqual(actual, NSRange(location: 8, length: 5))
    }

    func testCopyPasteSelectionAndSearchUsePinnedBindingActions() {
        let engine = FakeManualSurface()
        engine.fakeSelection = (offset: 0, length: 4)
        engine.fakeSelectedText = "copy"
        let terminal = makeTerminal(engine)

        terminal.copy(nil)
        terminal.paste(nil)
        terminal.selectAll(nil)
        XCTAssertTrue(terminal.search("needle"))
        XCTAssertTrue(terminal.navigateSearchToNext())
        XCTAssertTrue(terminal.navigateSearchToPrevious())
        terminal.endSearch()

        XCTAssertEqual(engine.bindingActions, [
            "copy_to_clipboard",
            "paste_from_clipboard",
            "select_all",
            "search:needle",
            "navigate_search:next",
            "navigate_search:previous",
            "end_search",
        ])
    }

    func testShiftNavigationKeysScrollLocallyAndUnmodifiedKeysStayWithProvider() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)
        let bindings: [(Int, String)] = [
            (kVK_PageUp, "scroll_page_up"),
            (kVK_PageDown, "scroll_page_down"),
            (kVK_Home, "scroll_to_top"),
            (kVK_End, "scroll_to_bottom"),
        ]

        for (keyCode, _) in bindings {
            terminal.keyDown(with: makeKeyEvent(
                characters: "",
                modifierFlags: [.shift],
                keyCode: UInt16(keyCode)))
        }

        XCTAssertEqual(engine.bindingActions, bindings.map(\.1))
        XCTAssertTrue(engine.keysSentDetail.isEmpty,
                      "viewer history keys must neither claim nor reach the provider")
        XCTAssertFalse(terminal.handleViewerScrollKey(makeKeyEvent(
            characters: "", keyCode: UInt16(kVK_PageUp))))
        XCTAssertFalse(terminal.handleViewerScrollKey(makeKeyEvent(
            characters: "", modifierFlags: [.shift, .control],
            keyCode: UInt16(kVK_End))))
        XCTAssertEqual(engine.bindingActions, bindings.map(\.1),
                       "only the exact Shift chord is viewer-local")
    }

    func testFirstResponderHandoffMirrorsFocusIntoTheSurface() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)
        let replacement = NSTextField(frame: NSRect(x: 0, y: 0, width: 100, height: 24))
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 500, height: 400))
        content.addSubview(terminal)
        content.addSubview(replacement)
        let window = NSWindow(
            contentRect: content.bounds,
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView = content

        XCTAssertTrue(window.makeFirstResponder(terminal))
        XCTAssertEqual(engine.focusCalls, [true])
        XCTAssertTrue(window.makeFirstResponder(replacement))
        XCTAssertEqual(engine.focusCalls, [true, false])
    }

    func testRealGhosttySurfaceAcceptsSearchAndNavigationBindingActions() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        defer { surface.free() }
        let terminal = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 300),
            engine: surface
        )
        let output = Data("alpha needle omega".utf8)
        XCTAssertEqual(surface.processOutput(bytes: output, streamSeq: 0), .success)

        XCTAssertTrue(terminal.search("needle"))
        XCTAssertTrue(terminal.navigateSearchToNext())
        XCTAssertTrue(terminal.navigateSearchToPrevious())
        terminal.endSearch()
    }

    // MARK: Full NSTextInputClient composition lifecycle

    func testEmptyMarkedTextIsNotReportedAsAnActiveComposition() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        terminal.setMarkedText(
            "",
            selectedRange: NSRange(location: 0, length: 0),
            replacementRange: NSRange(location: NSNotFound, length: 0)
        )

        XCTAssertFalse(terminal.hasMarkedText())
        XCTAssertEqual(terminal.markedRange(), NSRange(location: NSNotFound, length: 0))
    }

    func testCommittedCompositionUsesPinnedAccumulatorChoreographyForCJKEmojiAndRTLText() {
        let cases = [
            (preedits: ["日", "日本"], commit: "日本語"),
            (preedits: ["👩"], commit: "👩‍💻"),
            (preedits: ["ש"], commit: "שָלוֹם"),
        ]
        for input in cases {
            let engine = FakeManualSurface()
            let terminal = makeTerminal(engine)
            for preedit in input.preedits {
                terminal.setMarkedText(
                    preedit,
                    selectedRange: NSRange(location: preedit.utf16.count, length: 0),
                    replacementRange: NSRange(location: NSNotFound, length: 0)
                )
            }

            terminal.keyDown(with: makeKeyEvent(characters: input.commit, keyCode: 0))

            XCTAssertEqual(engine.keysSentDetail.count, 1, "composition commit must be one key event for \(input.commit)")
            XCTAssertEqual(engine.keysSentDetail.first?.keycode, 0)
            XCTAssertEqual(engine.keysSentDetail.first?.text, input.commit)
            XCTAssertFalse(engine.keysSentDetail.first?.composing ?? true)
            XCTAssertTrue(engine.textSent.isEmpty, "composition commit must not also use raw text for \(input.commit)")
            XCTAssertEqual(engine.preeditsSent.prefix(input.preedits.count), input.preedits[...])
            XCTAssertEqual(Array(engine.preeditsSent.suffix(2)), ["", ""], "insertText and keyDown must clear preedit exactly as the pinned app")
            XCTAssertFalse(terminal.hasMarkedText())
        }
    }

    func testDeadKeyPreeditAndCommitFollowPinnedGhosttyChoreography() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)
        let deadKey = makeKeyEvent(characters: "", charactersIgnoringModifiers: "e", modifierFlags: [.option], keyCode: 14)

        terminal.handleKeyDown(deadKey) { _ in
            terminal.setMarkedText(
                "´",
                selectedRange: NSRange(location: 1, length: 0),
                replacementRange: NSRange(location: NSNotFound, length: 0)
            )
        }

        XCTAssertTrue(terminal.hasMarkedText())
        XCTAssertEqual(engine.preeditsSent.last, "´")
        XCTAssertEqual(engine.keysSentDetail.last?.composing, true)

        let commitKey = makeKeyEvent(characters: "e", keyCode: 14)
        terminal.handleKeyDown(commitKey) { _ in
            terminal.insertText("é", replacementRange: NSRange(location: NSNotFound, length: 0))
        }

        XCTAssertFalse(terminal.hasMarkedText())
        XCTAssertEqual(engine.preeditsSent.last, "")
        XCTAssertEqual(engine.keysSentDetail.last?.keycode, 0)
        XCTAssertEqual(engine.keysSentDetail.last?.text, "é")
        XCTAssertFalse(engine.keysSentDetail.last?.composing ?? true)
    }

    func testRealGhosttySurfaceCommitsCJKDeadKeyEmojiZWJAndRTLBytesExactlyOnce() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        defer { surface.free() }
        let terminal = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 300),
            engine: surface
        )
        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }
        let cases = [
            (preedits: ["日", "日本"], commit: "日本語"),
            (preedits: ["´"], commit: "é"),
            (preedits: ["👩"], commit: "👩‍💻"),
            (preedits: ["ש"], commit: "שָלוֹם"),
        ]

        for input in cases {
            for preedit in input.preedits {
                terminal.setMarkedText(
                    preedit,
                    selectedRange: NSRange(location: preedit.utf16.count, length: 0),
                    replacementRange: NSRange(location: NSNotFound, length: 0)
                )
            }
            if input.commit == "日本語" {
                RunLoop.main.run(until: Date().addingTimeInterval(0.05))
                XCTAssertTrue(writes.isEmpty, "multi-stage CJK preedit must emit no PTY bytes before commit")
            }
            terminal.keyDown(with: makeKeyEvent(characters: input.commit, keyCode: 0))
        }

        drainMainRunLoop(until: { writes.count == cases.count })
        XCTAssertEqual(writes, cases.map { Data($0.commit.utf8) })
    }

    // MARK: 6. Scroll (previously missing entirely)

    func testScrollModsEncodesPrecisionBit() {
        let mods = HiveTerminalView.scrollMods(precision: true, momentumPhase: [])
        XCTAssertEqual(mods & 0b0000_0001, 1, "bit 0 must be set for a high-precision (trackpad) scroll")
    }

    func testScrollModsEncodesMomentumPhaseInBits1Through3() {
        XCTAssertEqual(HiveTerminalView.scrollMods(precision: false, momentumPhase: .began), 1 << 1)
        XCTAssertEqual(HiveTerminalView.scrollMods(precision: false, momentumPhase: .ended), 4 << 1)
        XCTAssertEqual(HiveTerminalView.scrollMods(precision: false, momentumPhase: []), 0,
                       "no momentum, no precision: mods must be zero, matching Ghostty.Input.Momentum.none")
    }

    func testScrollWheelForwardsToEngine() throws {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        guard
            let cgEvent = CGEvent(
                scrollWheelEvent2Source: nil,
                units: .pixel,
                wheelCount: 2,
                wheel1: -3,
                wheel2: 0,
                wheel3: 0
            ),
            let event = NSEvent(cgEvent: cgEvent)
        else {
            // Fails loudly rather than XCTSkip: skipped-green on a
            // live-proof gate is false-green (cross-vendor review
            // 2026-07-17, same policy as the other gate suites).
            return XCTFail("could not synthesize a CGEvent-backed scroll event — gate 8 live proof requires it")
        }

        terminal.scrollWheel(with: event)

        XCTAssertEqual(engine.scrollsSent.count, 1,
                       "pre-B1 snapshot had no scrollWheel override at all — scroll never reached the terminal")
        // Direction sign matches the input; exact magnitude depends on the
        // precision multiplier already covered by testScrollModsEncodes*.
        XCTAssertNotEqual(engine.scrollsSent[0].y, 0, "a real scroll delta must reach the engine")
    }

    func testEveryPinnedNSEventMouseButtonMapsToGhosttysExactButton() {
        let expected: [(Int, TerminalMouseButton)] = [
            (0, .left),
            (1, .right),
            (2, .middle),
            (3, .eight),
            (4, .nine),
            (5, .six),
            (6, .seven),
            (7, .four),
            (8, .five),
            (9, .ten),
            (10, .eleven),
        ]

        for (buttonNumber, button) in expected {
            XCTAssertEqual(
                HiveTerminalView.mouseButton(forNSEventButtonNumber: buttonNumber),
                button,
                "NSEvent button \(buttonNumber) drifted from Ghostty.Input.MouseButton"
            )
        }
        XCTAssertEqual(HiveTerminalView.mouseButton(forNSEventButtonNumber: 11), .unknown)
    }

    func testRightAndOtherMouseOverridesReachTheExactButtons() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        terminal.rightMouseDown(with: makeCGMouseEvent(type: .rightMouseDown, button: .right))
        terminal.rightMouseUp(with: makeCGMouseEvent(type: .rightMouseUp, button: .right))
        terminal.otherMouseDown(with: makeCGMouseEvent(type: .otherMouseDown, button: .center))
        terminal.otherMouseUp(with: makeCGMouseEvent(type: .otherMouseUp, button: .center))

        XCTAssertEqual(engine.mouseButtonsSent.map(\.button), [
            .right,
            .right,
            .middle,
            .middle,
        ])
        XCTAssertEqual(engine.mouseButtonsSent.map(\.state), [
            .press,
            .release,
            .press,
            .release,
        ])
    }

    func testMouseCoordinatesStayInUnscaledViewPointsAndFlipYAxis() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)
        let event = makeMouseEvent(type: .leftMouseDown, location: NSPoint(x: 25, y: 40))

        terminal.mouseDown(with: event)

        XCTAssertEqual(engine.mousePositionsSent.count, 1)
        XCTAssertEqual(engine.mousePositionsSent[0].x, 25, accuracy: 0.001)
        XCTAssertEqual(engine.mousePositionsSent[0].y, 260, accuracy: 0.001)
        XCTAssertEqual(engine.mouseButtonsSent.first?.button, .left)
    }

    func testMouseCoordinatesDoNotMultiplyByBackingScale() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)
        let window = Gate8DoubleScaleWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
            styleMask: [.borderless],
            backing: .buffered,
            defer: true
        )
        defer { window.orderOut(nil) }
        window.contentView = terminal
        let event = makeMouseEvent(type: .mouseMoved, location: NSPoint(x: 25, y: 40))

        terminal.mouseMoved(with: event)

        XCTAssertEqual(window.backingScaleFactor, 2)
        XCTAssertEqual(engine.mousePositionsSent[0].x, 25, accuracy: 0.001)
        XCTAssertEqual(engine.mousePositionsSent[0].y, 260, accuracy: 0.001)
    }

    func testMouseButtonCoordinatesDoNotMultiplyByBackingScale() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)
        let window = Gate8DoubleScaleWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
            styleMask: [.borderless],
            backing: .buffered,
            defer: true
        )
        defer { window.orderOut(nil) }
        window.contentView = terminal
        let event = makeMouseEvent(type: .leftMouseDown, location: NSPoint(x: 25, y: 40))

        terminal.mouseDown(with: event)

        XCTAssertEqual(window.backingScaleFactor, 2)
        XCTAssertEqual(engine.mousePositionsSent.count, 1)
        XCTAssertEqual(engine.mousePositionsSent[0].x, 25, accuracy: 0.001)
        XCTAssertEqual(engine.mousePositionsSent[0].y, 260, accuracy: 0.001)
        XCTAssertEqual(engine.mouseButtonsSent.first?.button, .left)
    }

    func testPressureAndMouseUpResetReachTheSurfaceContract() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        terminal.forwardMousePressure(stage: 2, pressure: 0.75)
        terminal.mouseUp(with: makeMouseEvent(type: .leftMouseUp, location: .zero))

        XCTAssertEqual(engine.mousePressuresSent.count, 2)
        XCTAssertEqual(engine.mousePressuresSent[0].stage, 2)
        XCTAssertEqual(engine.mousePressuresSent[0].pressure, 0.75, accuracy: 0.001)
        XCTAssertEqual(engine.mousePressuresSent[1].stage, 0)
        XCTAssertEqual(engine.mousePressuresSent[1].pressure, 0, accuracy: 0.001)
    }

    func testControlClickQueriesMouseCaptureBeforeShowingAContextMenu() {
        let engine = FakeManualSurface()
        engine.fakeMouseCaptured = true
        let terminal = makeTerminal(engine)
        let event = makeMouseEvent(
            type: .leftMouseDown,
            location: .zero,
            modifierFlags: [.control]
        )

        XCTAssertNil(terminal.menu(for: event))
        XCTAssertEqual(engine.mouseCaptureQueryCount, 1)
    }

    func testMouseExitSendsPinnedOutsideSentinelWhenNoButtonIsPressed() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)
        let event = NSEvent.enterExitEvent(
            with: .mouseExited,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            eventNumber: 1,
            trackingNumber: 1,
            userData: nil
        )!
        terminal.mouseExited(with: event)

        XCTAssertEqual(engine.mousePositionsSent.count, 1)
        XCTAssertEqual(engine.mousePositionsSent[0].x, -1)
        XCTAssertEqual(engine.mousePositionsSent[0].y, -1)
    }

    func testRealGhosttySurfaceEncodesSGRMousePressAndRelease() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        defer { surface.free() }
        let terminal = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 300),
            engine: surface
        )
        let enable = Data("\u{1B}[?1003h\u{1B}[?1006h".utf8)
        XCTAssertEqual(surface.processOutput(bytes: enable, streamSeq: 0), .success)
        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }
        let down = makeMouseEvent(type: .leftMouseDown, location: NSPoint(x: 25, y: 40))
        let up = makeMouseEvent(type: .leftMouseUp, location: NSPoint(x: 25, y: 40))

        terminal.mouseDown(with: down)
        terminal.mouseUp(with: up)

        // DECSET 1003 reports every motion. mouseDown intentionally forwards
        // the current position before the button, so SGR 1006 emits the
        // no-button motion code (3 + 32) before the press and release.
        drainMainRunLoop(until: { writes.count >= 3 })
        XCTAssertEqual(writes, [
            Data("\u{1B}[<35;2;14M".utf8),
            Data("\u{1B}[<0;2;14M".utf8),
            Data("\u{1B}[<0;2;14m".utf8),
        ])
    }

    func testRealGhosttySurfaceEncodesSGRScrollAtTheLastPointPosition() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        defer { surface.free() }
        let terminal = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 300),
            engine: surface
        )
        let enable = Data("\u{1B}[?1003h\u{1B}[?1006h".utf8)
        XCTAssertEqual(surface.processOutput(bytes: enable, streamSeq: 0), .success)
        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }
        terminal.mouseDown(with: makeMouseEvent(type: .leftMouseDown, location: NSPoint(x: 25, y: 40)))
        drainMainRunLoop(until: { writes.count >= 2 })
        XCTAssertEqual(writes, [
            Data("\u{1B}[<35;2;14M".utf8),
            Data("\u{1B}[<0;2;14M".utf8),
        ])
        // The CG scroll event carries deltas, not a view position. Clear the
        // setup motion/press only after proving mouseDown established the
        // point that the following wheel reports must reuse.
        writes.removeAll()
        guard let cgEvent = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .line,
            wheelCount: 1,
            wheel1: -3,
            wheel2: 0,
            wheel3: 0
        ), let event = NSEvent(cgEvent: cgEvent) else {
            return XCTFail("could not synthesize real CGEvent-backed scroll input")
        }

        terminal.scrollWheel(with: event)

        drainMainRunLoop(until: { writes.count == 9 })
        XCTAssertEqual(
            writes,
            Array(repeating: Data("\u{1B}[<65;2;14M".utf8), count: 9)
        )
    }

    // MARK: keyUp (was never wired at all)

    func testKeyUpSendsReleaseAction() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        // Pre-B1 snapshot had no keyUp override, so GHOSTTY_ACTION_RELEASE
        // was dead code — encodeKey was only ever reachable from keyDown.
        let event = makeKeyEvent(type: .keyUp, characters: "x", keyCode: 7)
        terminal.keyUp(with: event)

        XCTAssertEqual(engine.keysSentDetail.count, 1, "keyUp must reach the engine at all")
        XCTAssertEqual(engine.keysSentDetail[0].action, .release)
        XCTAssertNil(engine.keysSentDetail[0].text,
                     "a release must never carry text — real keyAction only embeds its explicit " +
                     "text: parameter, which keyUp never passes (fidelity audit 2026-07-17)")
    }

    // MARK: isARepeat (pre-B1 always sent PRESS)

    func testRepeatedKeyDownSendsRepeatActionNotPress() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        let fresh = makeKeyEvent(characters: "x", keyCode: 7, isARepeat: false)
        terminal.encodeKey(fresh)
        XCTAssertEqual(engine.keysSentDetail[0].action, .press)

        let repeated = makeKeyEvent(characters: "x", keyCode: 7, isARepeat: true)
        terminal.encodeKey(repeated)
        XCTAssertEqual(engine.keysSentDetail[1].action, .repeat,
                       "a held/repeating key must report GHOSTTY_ACTION_REPEAT, not PRESS again")
    }

    // MARK: flagsChanged (bare modifier press/release never reached the terminal)

    func testFlagsChangedSendsPressWhenTheCorrectSideModifierBecomesActive() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        // keyCode 0x38 = left shift. Real device-mask bit for LEFT shift
        // isn't NX_DEVICERSHIFTKEYMASK (that's the right-side mask) — for
        // the left side, real Ghostty's `default: sidePressed = true`
        // branch applies, matching flagsChanged's switch above.
        let event = makeFlagsChangedEvent(modifierFlags: [.shift], keyCode: 0x38)
        terminal.flagsChanged(with: event)

        XCTAssertEqual(engine.keysSentDetail.count, 1,
                       "pre-B1 snapshot had no flagsChanged override — a bare modifier press/release never reached the terminal")
        XCTAssertEqual(engine.keysSentDetail[0].action, .press)
    }

    func testFlagsChangedSendsReleaseWhenTheModifierClears() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        // No .shift in modifierFlags: the key that generated this
        // flagsChanged event was released.
        let event = makeFlagsChangedEvent(modifierFlags: [], keyCode: 0x38)
        terminal.flagsChanged(with: event)

        XCTAssertEqual(engine.keysSentDetail.count, 1)
        XCTAssertEqual(engine.keysSentDetail[0].action, .release)
    }

    func testFlagsChangedIgnoresUnmappedKeyCodes() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        // A keyCode outside the switch's cases (mapped modifiers only) —
        // real Ghostty's flagsChanged returns early, sends nothing.
        let event = makeFlagsChangedEvent(modifierFlags: [], keyCode: 0xFF)
        terminal.flagsChanged(with: event)

        XCTAssertTrue(engine.keysSentDetail.isEmpty)
    }

    // MARK: firstRect (was a hardcoded view-bounds placeholder)

    func testFirstRectFallsBackToViewBoundsWithoutARealSurface() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        var actual = NSRange(location: NSNotFound, length: 0)
        let requested = NSRange(location: 3, length: 0)
        let rect = terminal.firstRect(forCharacterRange: requested, actualRange: &actual)

        XCTAssertEqual(rect, NSRect(x: 0, y: 0, width: 0, height: 0))
        XCTAssertEqual(actual, requested)
    }

    func testFirstRectConvertsTheMainConfinedIMEPointInViewPointUnits() {
        let engine = FakeManualSurface()
        engine.fakeIMEPoint = ManualSurfaceIMEPoint(x: 20, y: 40, width: 8, height: 16)
        let terminal = makeTerminal(engine)

        let rect = terminal.firstRect(
            forCharacterRange: NSRange(location: 2, length: 1),
            actualRange: nil
        )

        XCTAssertEqual(rect.origin.x, 20, accuracy: 0.001)
        XCTAssertEqual(rect.origin.y, 260, accuracy: 0.001)
        XCTAssertEqual(rect.width, 8, accuracy: 0.001)
        XCTAssertEqual(rect.height, 16, accuracy: 0.001)
    }

    func testFirstRectUsesZeroWidthAndRangeOffsetForDictationInsertion() {
        let engine = FakeManualSurface()
        engine.fakeIMEPoint = ManualSurfaceIMEPoint(x: 20, y: 40, width: 24, height: 16)
        engine.fakeReportedSize = ManualSurfaceSize(
            columns: 80,
            rows: 24,
            widthPx: 800,
            heightPx: 600,
            cellWidthPx: 16,
            cellHeightPx: 32
        )
        let terminal = makeTerminal(engine)
        let window = Gate8DoubleScaleWindow(
            contentRect: terminal.bounds,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        defer { window.orderOut(nil) }
        window.contentView = terminal
        terminal.viewDidChangeBackingProperties()

        let baseline = terminal.firstRect(
            forCharacterRange: NSRange(location: 0, length: 0),
            actualRange: nil
        )

        let rect = terminal.firstRect(
            forCharacterRange: NSRange(location: 2, length: 0),
            actualRange: nil
        )

        XCTAssertEqual(terminal.appliedContentScale.width, 2, accuracy: 0.001)
        let cellWidthPoints = Double(engine.fakeReportedSize!.cellWidthPx) / terminal.appliedContentScale.width
        XCTAssertEqual(cellWidthPoints, 8, accuracy: 0.001)
        XCTAssertNotEqual(engine.fakeIMEPoint!.width, cellWidthPoints,
                          "the preedit rect must span multiple cells or the old bug is numerically invisible")
        XCTAssertEqual(rect.origin.x - baseline.origin.x, cellWidthPoints * 2, accuracy: 0.001)
        XCTAssertEqual(rect.width, 0, accuracy: 0.001)
    }

    func testFirstRectRetainsPreeditOriginWhenCellGeometryIsUnavailable() {
        let engine = FakeManualSurface()
        engine.fakeIMEPoint = ManualSurfaceIMEPoint(x: 20, y: 40, width: 24, height: 16)
        let terminal = makeTerminal(engine)
        let window = NSWindow(
            contentRect: NSRect(x: 100, y: 100, width: 500, height: 400),
            styleMask: [.borderless],
            backing: .buffered,
            defer: true
        )
        defer { window.orderOut(nil) }
        window.contentView?.addSubview(terminal)

        XCTAssertNil(engine.fakeReportedSize, "nil size must exercise the explicit no-geometry fallback")
        let baseline = terminal.firstRect(
            forCharacterRange: NSRange(location: 0, length: 0),
            actualRange: nil
        )
        let rect = terminal.firstRect(
            forCharacterRange: NSRange(location: 2, length: 0),
            actualRange: nil
        )

        XCTAssertEqual(rect.origin.x, baseline.origin.x, accuracy: 0.001)
        XCTAssertEqual(rect.width, 0, accuracy: 0.001)
        XCTAssertTrue([rect.minX, rect.minY, rect.width, rect.height].allSatisfy(\.isFinite))

        window.setFrameOrigin(NSPoint(x: 400, y: 350))
        let moved = terminal.firstRect(
            forCharacterRange: NSRange(location: 2, length: 0),
            actualRange: nil
        )
        XCTAssertEqual(moved.origin.x - rect.origin.x, 300, accuracy: 0.5)
        XCTAssertEqual(moved.origin.y - rect.origin.y, 250, accuracy: 0.5)
    }

    func testFirstRectQueriesRealSurfaceIMEPointNotJustViewBounds() throws {
        let surface: GhosttyManualSurface
        do {
            surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        } catch {
            // Fails loudly rather than XCTSkip: skipped-green on a
            // live-proof gate is false-green (cross-vendor review
            // 2026-07-17, same policy as the other gate suites).
            XCTFail("real manual surface required for gate 8 live proof, got: \(error)")
            throw error
        }
        defer { surface.free() }
        let terminal = HiveTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), engine: surface)

        // Pre-B1 snapshot always returned convert(bounds, to: nil) — the
        // entire view, width/height 400x300 — regardless of cursor
        // position. A real ghostty_surface_ime_point call returns a
        // cell-sized (or default) rect, not the whole view.
        let rect = terminal.firstRect(forCharacterRange: NSRange(location: 0, length: 0), actualRange: nil)
        XCTAssertTrue(rect.width.isFinite && rect.height.isFinite && !rect.width.isNaN && !rect.height.isNaN)
        XCTAssertFalse(rect.width == 400 && rect.height == 300,
                       "must not just be the old hardcoded whole-view-bounds placeholder")
    }

    /// NSTextInputClient's firstRect contract is SCREEN coordinates, not
    /// window coordinates — the pinned Surface View converts view→window
    /// and then window.convertToScreen. Cross-vendor review (bram,
    /// 2026-07-18) caught the port stopping at window coords, displacing
    /// the IME candidate window in any window with a nonzero screen
    /// origin, and the prior control being blind to it (unattached view:
    /// window == screen trivially). This control observes the screen
    /// conversion directly: the SAME view in the SAME window must report
    /// a rect that SHIFTS by exactly the window's origin delta when the
    /// window moves — window-coordinate output shifts by nothing and
    /// goes RED.
    func testFirstRectShiftsWithWindowScreenOriginProvingScreenCoords() throws {
        let surface: GhosttyManualSurface
        do {
            surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        } catch {
            XCTFail("real manual surface required for gate 8 live proof, got: \(error)")
            throw error
        }
        defer { surface.free() }
        let terminal = HiveTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), engine: surface)

        let window = NSWindow(
            contentRect: NSRect(x: 100, y: 100, width: 500, height: 400),
            styleMask: [.borderless],
            backing: .buffered,
            defer: true
        )
        defer { window.orderOut(nil) }
        window.contentView?.addSubview(terminal)

        let range = NSRange(location: 0, length: 0)
        let before = terminal.firstRect(forCharacterRange: range, actualRange: nil)
        window.setFrameOrigin(NSPoint(x: 400, y: 350))
        let after = terminal.firstRect(forCharacterRange: range, actualRange: nil)

        XCTAssertEqual(after.origin.x - before.origin.x, 300, accuracy: 0.5,
                       "moving the window +300pt in screen x must shift the IME rect by exactly that " +
                       "— a window-coordinate rect would not move at all")
        XCTAssertEqual(after.origin.y - before.origin.y, 250, accuracy: 0.5,
                       "moving the window +250pt in screen y must shift the IME rect by exactly that " +
                       "— a window-coordinate rect would not move at all")
    }

}
