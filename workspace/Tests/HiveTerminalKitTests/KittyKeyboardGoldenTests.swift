import AppKit
import Carbon
import XCTest
import HiveGhosttyC
import IOKit.hidsystem
@testable import HiveTerminalKit

/// Gate 8 (M1-B1) Kitty keyboard protocol byte goldens against the pinned
/// Ghostty engine build. Goldens:
///   kitty shift+Enter → "\x1b[13;2u"
///   non-kitty shift+Enter → "\x1b[27;2;13~" (xterm modified-keys style)
///
/// Key-encoder output is NOT delivered synchronously. Terminal-generated
/// replies reach the write callback on the process_output caller's thread,
/// but KEY encodings travel Surface.keyCallback → encodeKey → queueIo → the
/// surface's termio SPSC mailbox, drained by the surface's IO thread, which
/// then invokes the C write trampoline later. BridgeCallbackContext defers
/// host delivery to main. Reading the write log immediately after
/// ghostty_surface_key returns therefore observes zero writes for any key
/// whose bytes come from the encoder rather than embedded text. Tests must
/// drain, not snapshot.
final class KittyKeyboardGoldenTests: XCTestCase {
    /// Fails loudly rather than XCTSkip: live-proof gate policy.
    private func makeSurface() throws -> GhosttyManualSurface {
        do {
            return try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        } catch {
            XCTFail("real manual surface required for gate 8 live proof, got: \(error)")
            throw error
        }
    }

    /// Thread-safe collector also safe to reuse below the Swift callback seam.
    /// Pumps the main run loop and yields until `count` writes arrived or
    /// the timeout elapsed. Key-encoder bytes arrive asynchronously on the
    /// surface io thread — a synchronous snapshot can falsely report zero
    /// writes.
    private func drain(_ log: WriteTranscript, until count: Int, timeout: TimeInterval = 2) -> [Data] {
        let deadline = Date().addingTimeInterval(timeout)
        while log.chunks.count < count && Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
            Thread.sleep(forTimeInterval: 0.005)
        }
        return log.chunks
    }

    private func makeShiftEnterEvent(
        type: NSEvent.EventType = .keyDown,
        isARepeat: Bool = false
    ) -> NSEvent {
        NSEvent.keyEvent(
            with: type,
            location: .zero,
            modifierFlags: [.shift],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "\r",
            charactersIgnoringModifiers: "\r",
            isARepeat: isARepeat,
            keyCode: 36
        )!
    }

    private func makeFlagsChangedEvent(
        keyCode: UInt16,
        modifierFlags: NSEvent.ModifierFlags
    ) -> NSEvent {
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

    private func makeShiftAEvent() -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [.shift],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "A",
            charactersIgnoringModifiers: "a",
            isARepeat: false,
            keyCode: 0
        )!
    }

    private func makeCommandCEvent() -> NSEvent {
        NSEvent.keyEvent(
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
        )!
    }

    /// Non-kitty golden: shift+Enter must emit "\x1b[27;2;13~" (xterm
    /// modified-keys style), exactly once, through the REAL NSEvent → keyDown
    /// → interpretKeyEvents/accumulator → ghostty_surface_key path.
    func testLegacyShiftEnterEmitsPinnedTableSequenceExactlyOnce() throws {
        let surface = try makeSurface()
        defer { surface.free() }
        let terminal = HiveTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), engine: surface)

        let log = WriteTranscript(recording: surface.callbackContext)

        terminal.keyDown(with: makeShiftEnterEvent())

        let writes = drain(log, until: 1)
        XCTAssertEqual(writes.count, 1, "shift+Enter must produce exactly one write, got \(writes)")
        XCTAssertEqual(writes.first, Data("\u{1B}[27;2;13~".utf8),
                       "non-kitty shift+Enter must match the pinned function_keys table byte-for-byte")
    }

    /// Kitty disambiguate golden: after CSI > 1 u, the same shift+Enter must
    /// emit "\x1b[13;2u". If the mode fails to latch, the non-kitty sequence
    /// appears instead; if the kitty encoder or mods break, the CSI u
    /// parameters differ.
    func testKittyDisambiguateShiftEnterMatchesGhosttysOwnFixture() throws {
        let surface = try makeSurface()
        defer { surface.free() }
        let terminal = HiveTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), engine: surface)

        // Enable kitty keyboard disambiguate mode via the ordered-output
        // path, exactly as a TUI would (CSI > 1 u, kitty keyboard protocol
        // "push flags").
        let enable = Data("\u{1B}[>1u".utf8)
        XCTAssertEqual(surface.processOutput(bytes: enable, streamSeq: 0), .success)

        let log = WriteTranscript(recording: surface.callbackContext)

        terminal.keyDown(with: makeShiftEnterEvent())

        let writes = drain(log, until: 1)
        XCTAssertEqual(writes.count, 1, "kitty shift+Enter must produce exactly one write, got \(writes)")
        XCTAssertEqual(writes.first, Data("\u{1B}[13;2u".utf8),
                       "kitty-mode shift+Enter must match Ghostty's own key_encode fixture byte-for-byte")
    }

    func testMouseCapturedCommandCopyReachesTheKittyChild() throws {
        let surface = try makeSurface()
        defer { surface.free() }
        let terminal = HiveTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), engine: surface)
        let modes = Data("\u{1B}[?1000h\u{1B}[>1u".utf8)
        XCTAssertEqual(surface.processOutput(bytes: modes, streamSeq: 0), .success)
        XCTAssertTrue(surface.mouseCaptured())
        XCTAssertFalse(terminal.canCopySelection)

        let log = WriteTranscript(recording: surface.callbackContext)

        XCTAssertTrue(terminal.performKeyEquivalent(with: makeCommandCEvent()))

        XCTAssertEqual(drain(log, until: 1), [Data("\u{1B}[99;9u".utf8)])
    }

    /// Kitty flags 0b1011 request disambiguation, event types, and all keys.
    /// The same physical key must then distinguish press, repeat, and release
    /// using the protocol's event subfield values 1/2/3.
    func testKittyShiftEnterPressRepeatReleaseMatchesPinnedGhosttyBytes() throws {
        let surface = try makeSurface()
        defer { surface.free() }
        let terminal = HiveTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), engine: surface)
        XCTAssertEqual(surface.processOutput(bytes: Data("\u{1B}[>11u".utf8), streamSeq: 0), .success)

        let log = WriteTranscript(recording: surface.callbackContext)
        terminal.keyDown(with: makeShiftEnterEvent())
        terminal.keyDown(with: makeShiftEnterEvent(isARepeat: true))
        terminal.keyUp(with: makeShiftEnterEvent(type: .keyUp))

        XCTAssertEqual(drain(log, until: 3), [
            Data("\u{1B}[13;2u".utf8),
            Data("\u{1B}[13;2:2u".utf8),
            Data("\u{1B}[13;2:3u".utf8),
        ])
    }

    /// The raw NSEvent keyCode is correct only because Ghostty maps the
    /// platform-native physical code internally. Prove both sides of Shift
    /// against the pinned app/encoder instead of trusting the C header shape.
    func testKittyPhysicalLeftAndRightShiftProduceDistinctPinnedCodes() throws {
        let surface = try makeSurface()
        defer { surface.free() }
        let terminal = HiveTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), engine: surface)
        XCTAssertEqual(surface.processOutput(bytes: Data("\u{1B}[>11u".utf8), streamSeq: 0), .success)

        let log = WriteTranscript(recording: surface.callbackContext)
        terminal.flagsChanged(with: makeFlagsChangedEvent(keyCode: 0x38, modifierFlags: [.shift]))
        let rightFlags = NSEvent.ModifierFlags(
            rawValue: NSEvent.ModifierFlags.shift.rawValue | UInt(NX_DEVICERSHIFTKEYMASK)
        )
        terminal.flagsChanged(with: makeFlagsChangedEvent(keyCode: 0x3C, modifierFlags: rightFlags))

        XCTAssertEqual(drain(log, until: 2), [
            Data("\u{1B}[57441;2u".utf8),
            Data("\u{1B}[57447;2u".utf8),
        ])
    }

    /// Kitty flag 0b0100 asks the encoder for alternate physical-key values.
    /// Shift+A must carry both the unshifted `a` codepoint and shifted `A`
    /// codepoint; a zero unshifted_codepoint drops the first field. This must
    /// enter through keyDown: AppKit synchronously calls insertText("A"), and
    /// removing the accumulator produces a raw `A` write plus this Kitty frame.
    func testKittyAlternateKeyGoldenCarriesExactUnshiftedCodepoint() throws {
        let surface = try makeSurface()
        defer { surface.free() }
        let terminal = HiveTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), engine: surface)
        XCTAssertEqual(surface.processOutput(bytes: Data("\u{1B}[>15u".utf8), streamSeq: 0), .success)

        let log = WriteTranscript(recording: surface.callbackContext)
        terminal.keyDown(with: makeShiftAEvent())

        XCTAssertEqual(drain(log, until: 1), [Data("\u{1B}[97:65;2u".utf8)])
    }
}
