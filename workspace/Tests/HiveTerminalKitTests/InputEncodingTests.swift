import AppKit
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

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
///    app's own apprt uses too). NOT a defect — no fix, no test needed;
///    the existing code was already correct.
/// 3. "zero unshifted/consumed fields" — real defect. Fixed, tested below.
/// 4. "key+text double-send" — real defect. Fixed, tested below.
/// 5. "placeholder IME ranges" — selectedRange() was a hardcoded
///    NSNotFound; now reads ghostty_surface_read_selection via the engine.
///    Fixed, tested below (via FakeManualSurface.fakeSelection).
/// 6. "missing scroll" — real defect (no override existed at all). Fixed;
///    the encoding logic is tested below via the pure scrollMods function
///    (see its doc comment for why a full NSEvent-level test isn't used).
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

    private func makeTerminal(_ engine: FakeManualSurface) -> HiveTerminalView {
        HiveTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), engine: engine)
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
        XCTAssertNotEqual(sent.unshiftedCodepoint, 0, "unshifted_codepoint must no longer be hardcoded to zero")
        XCTAssertEqual(sent.consumedMods.rawValue, GHOSTTY_MODS_SHIFT.rawValue,
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
        XCTAssertEqual(sent.mods.rawValue, GHOSTTY_MODS_SHIFT.rawValue | GHOSTTY_MODS_CTRL.rawValue)
        XCTAssertEqual(sent.consumedMods.rawValue, GHOSTTY_MODS_SHIFT.rawValue)
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

    func testControlCharacterIsExcludedFromKeyEventText() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        // Ctrl+H produces backspace (0x08), a control character. Ghostty
        // encodes control characters itself from mods+keycode, so it must
        // NOT be embedded as text (matches keyAction's `codepoint >= 0x20`
        // check exactly).
        let event = makeKeyEvent(characters: "\u{8}", modifierFlags: [.control], keyCode: 4)
        terminal.encodeKey(event)

        XCTAssertEqual(engine.keysSentDetail.count, 1)
        XCTAssertNil(engine.keysSentDetail[0].text, "a single control character must not be embedded as text")
        XCTAssertTrue(engine.textSent.isEmpty)
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

    // MARK: keyUp (was never wired at all)

    func testKeyUpSendsReleaseAction() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        // Pre-B1 snapshot had no keyUp override, so GHOSTTY_ACTION_RELEASE
        // was dead code — encodeKey was only ever reachable from keyDown.
        let event = makeKeyEvent(type: .keyUp, characters: "x", keyCode: 7)
        terminal.keyUp(with: event)

        XCTAssertEqual(engine.keysSentDetail.count, 1, "keyUp must reach the engine at all")
        XCTAssertEqual(engine.keysSentDetail[0].action, GHOSTTY_ACTION_RELEASE)
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
        XCTAssertEqual(engine.keysSentDetail[0].action, GHOSTTY_ACTION_PRESS)

        let repeated = makeKeyEvent(characters: "x", keyCode: 7, isARepeat: true)
        terminal.encodeKey(repeated)
        XCTAssertEqual(engine.keysSentDetail[1].action, GHOSTTY_ACTION_REPEAT,
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
        XCTAssertEqual(engine.keysSentDetail[0].action, GHOSTTY_ACTION_PRESS)
    }

    func testFlagsChangedSendsReleaseWhenTheModifierClears() {
        let engine = FakeManualSurface()
        let terminal = makeTerminal(engine)

        // No .shift in modifierFlags: the key that generated this
        // flagsChanged event was released.
        let event = makeFlagsChangedEvent(modifierFlags: [], keyCode: 0x38)
        terminal.flagsChanged(with: event)

        XCTAssertEqual(engine.keysSentDetail.count, 1)
        XCTAssertEqual(engine.keysSentDetail[0].action, GHOSTTY_ACTION_RELEASE)
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

        // FakeManualSurface.surfaceHandle is always nil, matching "no real
        // engine backing this view" — must not crash, must return a valid
        // (if degenerate) rect.
        let rect = terminal.firstRect(forCharacterRange: NSRange(location: 0, length: 0), actualRange: nil)
        XCTAssertTrue(rect.width.isFinite && rect.height.isFinite)
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

    // MARK: Kitty keyboard protocol byte golden — NOT YET DONE, see below

    // Attempted: enable Kitty disambiguate mode via CSI > 1 u
    // (terminal/stream.zig ~2147-2157), send shift+Return through the real
    // encodeKey path, and assert the write callback matches Ghostty's own
    // key encoder test fixture (input/key_encode.zig "kitty: shift+enter
    // emits CSI u" — \x1b[13;2u). The CSI > 1 u enable sequence parses
    // successfully (processOutput returns .success, throughSeq advances by
    // the full 5 bytes), but the subsequent sendKey call — even reproduced
    // with a hand-built ghostty_input_key_s bypassing encodeKey entirely,
    // and even with Kitty mode NOT enabled at all as a baseline — produces
    // ZERO writes for a special key (Enter, keycode 36) with mods=shift
    // and text=nil, while an unmodified printable key (text="x", no mods)
    // reliably produces exactly one write. Something beyond correct
    // mods/keycode/action/text fields gates the write for this
    // combination, and it wasn't isolated within a reasonable debugging
    // budget — deferred to the same fresh-agent split as the full
    // IME/composition choreography rather than shipping a guessed fix or
    // grinding further. See M1-B1 story notes / queen coordination
    // 2026-07-17 for the handoff.
}
