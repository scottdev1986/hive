import AppKit
import HiveGhosttyC
import XCTest
@testable import HiveTerminalKit

/// B2.3/A3 acceptance matrix — Kitty keyboard mode stack.
///
/// Acceptance clause (planning/story-m1-b2-hive-terminal-view.md): key
/// handling preserves ... Kitty progressive modes; and primary/alternate
/// screens retain independent Kitty keyboard stacks.
///
/// `KittyKeyboardGoldenTests` pins the PUSH direction (`CSI > n u`) only. A
/// terminal that latched Kitty mode permanently and ignored every pop passed
/// that suite completely. These rows exercise pop (`CSI < u`) and stack
/// nesting.
///
/// No byte value here is invented. Both goldens are the ones the existing
/// suite already pins against Ghostty's own fixtures:
///   legacy shift+Enter -> "\u{1B}[27;2;13~"  (input/function_keys.zig)
///   kitty  shift+Enter -> "\u{1B}[13;2u"     (input/key_encode.zig)
/// A pop is therefore proven by the encoding REVERTING to the legacy golden,
/// which is a round trip rather than a re-recording of current behavior.
///
/// Key-encoder bytes are delivered asynchronously by the surface io thread,
/// so every read here drains rather than snapshots — a synchronous read is
/// the documented measurement error that once produced a false "zero writes
/// for special keys" blocker.
final class B23KittyStackMatrixTests: XCTestCase {
    private static let legacyShiftEnter = Data("\u{1B}[27;2;13~".utf8)
    private static let kittyShiftEnter = Data("\u{1B}[13;2u".utf8)

    /// The sole reader: apply a mode program, then encode one shift+Enter.
    private func shiftEnterBytes(afterModeProgram program: [String]) throws -> Data? {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        defer { surface.free() }
        let terminal = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 300),
            engine: surface
        )

        var seq: UInt64 = 0
        for step in program {
            let bytes = Data(step.utf8)
            XCTAssertEqual(
                surface.processOutput(bytes: bytes, streamSeq: seq),
                .success,
                "mode program step \(step.debugDescription) was rejected by the real parser"
            )
            seq += UInt64(bytes.count)
        }

        let log = WriteLog()
        surface.callbackContext.onWrite = { log.append($0) }
        terminal.keyDown(with: Self.makeShiftEnterEvent())

        let writes = drain(log, until: 1)
        // Settle past the first write so a row asserting a single encoding
        // cannot pass while a second, contradictory write is still in flight.
        drainIdle(0.25)
        XCTAssertEqual(
            log.snapshot().count, 1,
            "shift+Enter must produce exactly one write, got \(log.snapshot())"
        )
        return writes.first
    }

    /// Baseline: with no mode program the legacy golden is emitted. This is
    /// the value a pop must restore, so it is established first.
    func testBaselineShiftEnterIsLegacyGolden() throws {
        XCTAssertEqual(try shiftEnterBytes(afterModeProgram: []), Self.legacyShiftEnter)
    }

    /// Push then pop must return to the legacy encoding. A terminal that
    /// ignores `CSI < u` fails here and nowhere else in the suite.
    func testPopRestoresLegacyEncoding() throws {
        let pushed = try shiftEnterBytes(afterModeProgram: ["\u{1B}[>1u"])
        XCTAssertEqual(pushed, Self.kittyShiftEnter, "push did not take effect")

        let popped = try shiftEnterBytes(afterModeProgram: ["\u{1B}[>1u", "\u{1B}[<u"])
        XCTAssertEqual(
            popped, Self.legacyShiftEnter,
            "CSI < u must pop the kitty flags and restore the legacy encoding"
        )
    }

    /// The stack must nest: two pushes need two pops. One pop leaving the
    /// terminal in legacy mode would mean the stack is really a boolean.
    func testStackNestsSoTwoPushesNeedTwoPops() throws {
        let afterOnePop = try shiftEnterBytes(
            afterModeProgram: ["\u{1B}[>1u", "\u{1B}[>1u", "\u{1B}[<u"]
        )
        XCTAssertEqual(
            afterOnePop, Self.kittyShiftEnter,
            "a single pop after two pushes must leave kitty mode active; "
                + "a boolean pretending to be a stack fails here"
        )

        let afterTwoPops = try shiftEnterBytes(
            afterModeProgram: ["\u{1B}[>1u", "\u{1B}[>1u", "\u{1B}[<u", "\u{1B}[<u"]
        )
        XCTAssertEqual(
            afterTwoPops, Self.legacyShiftEnter,
            "the second pop must return to legacy"
        )
    }

    /// Positive control through the same reader: the two goldens must differ.
    /// If they were ever equal, every push/pop row above would pass
    /// vacuously no matter what the terminal did.
    func testPositiveControlPushAndLegacyEncodingsDiffer() throws {
        let legacy = try shiftEnterBytes(afterModeProgram: [])
        let kitty = try shiftEnterBytes(afterModeProgram: ["\u{1B}[>1u"])

        XCTAssertNotNil(legacy)
        XCTAssertNotNil(kitty)
        XCTAssertNotEqual(
            legacy, kitty,
            "push and legacy encodings are identical, so the pop rows above "
                + "cannot distinguish a working stack from a broken one"
        )
    }

    /// Query (`CSI ? u`) must report the flags currently on top of the stack.
    /// Asserted as a round trip against the push depth rather than against a
    /// pinned string: the reported value must TRACK what was pushed, so a
    /// terminal that always answers a constant fails.
    func testQueryReportsFlagsThatTrackThePushedStack() throws {
        let baseline = try queryReply(afterModeProgram: [])
        let pushedOne = try queryReply(afterModeProgram: ["\u{1B}[>1u"])
        let popped = try queryReply(afterModeProgram: ["\u{1B}[>1u", "\u{1B}[<u"])

        XCTAssertFalse(baseline.isEmpty, "CSI ? u must produce a reply")
        XCTAssertNotEqual(
            baseline, pushedOne,
            "the query reply must change after a push; a constant answer "
                + "cannot distinguish an active stack from an ignored one"
        )
        XCTAssertEqual(
            popped, baseline,
            "after a matching pop the query must report the baseline flags again"
        )
    }

    /// Applies a mode program, then issues `CSI ? u` and returns the reply.
    private func queryReply(afterModeProgram program: [String]) throws -> String {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        defer { surface.free() }

        var seq: UInt64 = 0
        for step in program {
            let bytes = Data(step.utf8)
            XCTAssertEqual(surface.processOutput(bytes: bytes, streamSeq: seq), .success)
            seq += UInt64(bytes.count)
        }

        let log = WriteLog()
        surface.callbackContext.onWrite = { log.append($0) }
        let query = Data("\u{1B}[?u".utf8)
        XCTAssertEqual(surface.processOutput(bytes: query, streamSeq: seq), .success)

        _ = drain(log, until: 1)
        drainIdle(0.25)
        let joined = log.snapshot().reduce(into: Data(), { $0.append($1) })
        return String(decoding: joined, as: UTF8.self)
    }

    // MARK: - Helpers

    private static func makeShiftEnterEvent() -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [.shift],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "\r",
            charactersIgnoringModifiers: "\r",
            isARepeat: false,
            keyCode: 36
        )!
    }

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

    private func drain(_ log: WriteLog, until count: Int, timeout: TimeInterval = 2) -> [Data] {
        let deadline = Date().addingTimeInterval(timeout)
        while log.snapshot().count < count && Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
        return log.snapshot()
    }

    private func drainIdle(_ interval: TimeInterval) {
        let deadline = Date().addingTimeInterval(interval)
        while Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
    }
}
