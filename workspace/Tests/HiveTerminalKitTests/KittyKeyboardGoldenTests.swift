import AppKit
import XCTest
import HiveGhosttyC
import IOKit.hidsystem
@testable import HiveTerminalKit

/// Gate 8 (M1-B1) Kitty keyboard protocol byte goldens against the same
/// pinned Ghostty engine build, sourced from Ghostty's own key-encoder
/// fixtures (input/key_encode.zig: "kitty: shift+enter emits CSI u" →
/// "\x1b[13;2u") and the pinned legacy table (input/function_keys.zig
/// .enter: shift → "\x1b[27;2;13~", xterm modified-keys style).
///
/// ROOT CAUSE of the earlier "zero writes for special keys" blocker
/// (2026-07-17, boris): key-encoder output is NOT delivered synchronously.
/// Terminal-generated replies (gate 2) reach the write callback
/// synchronously on the process_output caller's thread (vt stream →
/// writePty → manual callback), but KEY encodings travel
/// Surface.keyCallback → encodeKey → queueIo → the surface's termio SPSC
/// mailbox, drained by the surface's IO THREAD (termio.Thread + xev
/// wakeup), which then invokes the C write trampoline later. The trampoline
/// copies immediately and BridgeCallbackContext defers host delivery to main.
/// Reading the write log immediately after
/// ghostty_surface_key returns therefore observes zero writes for any
/// key whose bytes come from the encoder rather than embedded text. The
/// engine was never dropping anything: an async observable was read
/// synchronously. (Diagnostic: immediately after sendKey — [] for Enter/
/// shift+Enter/left-arrow; after a 250ms drain — "\r", "\x1b[27;2;13~",
/// "\x1b[D", all byte-perfect.) Consequence for hosts, documented here
/// deliberately: native production differs, but the Swift `onWrite` host
/// callback is always deferred to main and tests must drain, not snapshot.
final class KittyKeyboardGoldenTests: XCTestCase {
    /// Fails loudly rather than XCTSkip: live-proof gate policy
    /// (cross-vendor review 2026-07-17).
    private func makeSurface() throws -> GhosttyManualSurface {
        do {
            return try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        } catch {
            XCTFail("real manual surface required for gate 8 live proof, got: \(error)")
            throw error
        }
    }

    /// Thread-safe collector also safe to reuse below the Swift callback seam.
    private final class WriteLog {
        private let lock = NSLock()
        private var writes: [Data] = []
        func append(_ data: Data) {
            lock.lock(); writes.append(data); lock.unlock()
        }
        func snapshot() -> [Data] {
            lock.lock(); defer { lock.unlock() }
            return writes
        }
    }

    /// Pumps the main run loop and yields until `count` writes arrived or
    /// the timeout elapsed. Key-encoder bytes are drained by the surface's
    /// io thread asynchronously — a synchronous snapshot is exactly the
    /// measurement error that produced the earlier false "zero writes".
    private func drain(_ log: WriteLog, until count: Int, timeout: TimeInterval = 2) -> [Data] {
        let deadline = Date().addingTimeInterval(timeout)
        while log.snapshot().count < count && Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
            Thread.sleep(forTimeInterval: 0.005)
        }
        return log.snapshot()
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

    /// Legacy (kitty off) golden: shift+Enter must emit the pinned
    /// function_keys table's entry "\x1b[27;2;13~" (xterm modified-keys
    /// style), exactly once, through the REAL NSEvent → keyDown →
    /// interpretKeyEvents/accumulator → ghostty_surface_key path. RED if the
    /// encoder path, keycode translation, mods mapping, or io-thread write
    /// delivery breaks.
    func testLegacyShiftEnterEmitsPinnedTableSequenceExactlyOnce() throws {
        let surface = try makeSurface()
        defer { surface.free() }
        let terminal = HiveTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), engine: surface)

        let log = WriteLog()
        surface.callbackContext.onWrite = { log.append($0) }

        terminal.keyDown(with: makeShiftEnterEvent())

        let writes = drain(log, until: 1)
        XCTAssertEqual(writes.count, 1, "shift+Enter must produce exactly one write, got \(writes)")
        XCTAssertEqual(writes.first, Data("\u{1B}[27;2;13~".utf8),
                       "legacy shift+Enter must match the pinned function_keys table byte-for-byte")
    }

    /// Kitty disambiguate golden: after the terminal stream enables
    /// CSI > 1 u, the same shift+Enter must emit "\x1b[13;2u" — the exact
    /// bytes of Ghostty's own encoder fixture ("kitty: shift+enter emits
    /// CSI u", input/key_encode.zig). Discriminating both ways: if the
    /// mode fails to latch, the legacy sequence appears instead; if the
    /// kitty encoder or mods break, the CSI u parameters differ.
    func testKittyDisambiguateShiftEnterMatchesGhosttysOwnFixture() throws {
        let surface = try makeSurface()
        defer { surface.free() }
        let terminal = HiveTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), engine: surface)

        // Enable kitty keyboard disambiguate mode via the ordered-output
        // path, exactly as a TUI would (CSI > 1 u, kitty keyboard protocol
        // "push flags").
        let enable = Data("\u{1B}[>1u".utf8)
        XCTAssertEqual(surface.processOutput(bytes: enable, streamSeq: 0), .success)

        let log = WriteLog()
        surface.callbackContext.onWrite = { log.append($0) }

        terminal.keyDown(with: makeShiftEnterEvent())

        let writes = drain(log, until: 1)
        XCTAssertEqual(writes.count, 1, "kitty shift+Enter must produce exactly one write, got \(writes)")
        XCTAssertEqual(writes.first, Data("\u{1B}[13;2u".utf8),
                       "kitty-mode shift+Enter must match Ghostty's own key_encode fixture byte-for-byte")
    }


    /// Kitty flags 0b1011 request disambiguation, event types, and all keys.
    /// The same physical key must then distinguish press, repeat, and release
    /// using the protocol's event subfield values 1/2/3.
    func testKittyShiftEnterPressRepeatReleaseMatchesPinnedGhosttyBytes() throws {
        let surface = try makeSurface()
        defer { surface.free() }
        let terminal = HiveTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), engine: surface)
        XCTAssertEqual(surface.processOutput(bytes: Data("\u{1B}[>11u".utf8), streamSeq: 0), .success)

        let log = WriteLog()
        surface.callbackContext.onWrite = { log.append($0) }
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

        let log = WriteLog()
        surface.callbackContext.onWrite = { log.append($0) }
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

        let log = WriteLog()
        surface.callbackContext.onWrite = { log.append($0) }
        terminal.keyDown(with: makeShiftAEvent())

        XCTAssertEqual(drain(log, until: 1), [Data("\u{1B}[97:65;2u".utf8)])
    }
}
