import AppKit
import HiveGhosttyC
import XCTest
@testable import HiveTerminalKit

/// B2.3/A3 acceptance matrix — bracketed paste boundary rows.
///
/// Acceptance clause (planning/story-m1-b2-hive-terminal-view.md, "Input and
/// resize semantics"): with DEC private mode 2004 set, exactly one
/// `ESC [ 200 ~` / `ESC [ 201 ~` pair surrounds only the paste body; with it
/// reset, Ghostty's safe-paste rules apply.
///
/// `Gate8ClipboardTests.swift:43` already pins the SET direction. The reset
/// direction had no test, so "bracketed paste works" was only ever half
/// observed: a build that bracketed unconditionally would have passed.
final class B23PasteBoundaryMatrixTests: XCTestCase {
    /// Multiline: unsafe to paste unbracketed, because a newline submits.
    private static let multilineBody = "clip\nboard"
    /// Single line: safe to paste in either mode.
    private static let singleLineBody = "clipboard"

    /// The sole reader for every row and control.
    private func pasteWrites(
        afterMode mode: String,
        body: String = B23PasteBoundaryMatrixTests.multilineBody
    ) throws -> String {
        let clipboard = GhosttyClipboardContext(
            read: { location in
                location == GHOSTTY_CLIPBOARD_STANDARD ? body : nil
            },
            write: { _, _ in }
        )
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForClipboardTesting(
            terminalReplies: .disabled,
            clipboardContext: clipboard
        )
        defer { surface.free() }
        let terminal = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 300),
            engine: surface
        )

        if !mode.isEmpty {
            XCTAssertEqual(
                surface.processOutput(bytes: Data(mode.utf8), streamSeq: 0),
                .success,
                "paste mode prologue was not accepted by the real parser"
            )
        }

        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }
        terminal.paste(nil)

        drainMainRunLoop(until: {
            writes.reduce(into: Data(), { $0.append($1) }).count >= body.utf8.count
        })
        // The closing ESC[201~ trails the body, so a reader that stopped as
        // soon as the body arrived could report "no end marker" for a build
        // that does emit one. Settle before reading the transcript.
        drainMainRunLoop(until: { false }, timeout: 0.25)
        return String(decoding: writes.reduce(into: Data(), { $0.append($1) }), as: UTF8.self)
    }

    /// SET: exactly one pair, wrapping only the body.
    func testBracketedPasteSetWrapsOnlyTheBodyInExactlyOnePair() throws {
        let actual = try pasteWrites(afterMode: "\u{1B}[?2004h")

        XCTAssertEqual(actual, "\u{1B}[200~\(Self.multilineBody)\u{1B}[201~")
        XCTAssertEqual(
            actual.components(separatedBy: "\u{1B}[200~").count - 1, 1,
            "exactly one paste start marker"
        )
        XCTAssertEqual(
            actual.components(separatedBy: "\u{1B}[201~").count - 1, 1,
            "exactly one paste end marker"
        )
    }

    /// RESET, safe body: the markers must be gone but the text still lands.
    /// This is the direction that had no coverage — an unconditionally
    /// bracketing build fails here and only here.
    func testBracketedPasteResetEmitsSafeBodyWithoutMarkers() throws {
        let actual = try pasteWrites(
            afterMode: "\u{1B}[?2004h\u{1B}[?2004l",
            body: Self.singleLineBody
        )

        XCTAssertFalse(
            actual.contains("\u{1B}[200~"),
            "DECRST 2004 must stop bracketing, got \(actual.debugDescription)"
        )
        XCTAssertFalse(
            actual.contains("\u{1B}[201~"),
            "DECRST 2004 must stop bracketing, got \(actual.debugDescription)"
        )
        XCTAssertEqual(
            actual, Self.singleLineBody,
            "a safe single-line paste must reach the encoder verbatim once unbracketed"
        )
    }

    /// RESET, unsafe body: the acceptance clause says "with it reset,
    /// Ghostty's safe-paste rules apply." A multiline paste cannot be sent
    /// unbracketed, because an embedded newline would submit the line to the
    /// shell without the user seeing it. Ghostty withholds it.
    ///
    /// Recorded as its own row rather than folded into the row above: the two
    /// differ only by the paste BODY, and conflating them would let a build
    /// that always withholds — or one that always sends — look correct.
    func testBracketedPasteResetWithholdsUnsafeMultilineBody() throws {
        let actual = try pasteWrites(
            afterMode: "\u{1B}[?2004h\u{1B}[?2004l",
            body: Self.multilineBody
        )

        XCTAssertEqual(
            actual, "",
            "an unbracketed multiline paste must not reach the terminal unconfirmed, "
                + "got \(actual.debugDescription)"
        )
        // The same body IS sent when bracketed, so the withholding above is
        // attributable to safe-paste and not to a dead clipboard reader.
        let bracketed = try pasteWrites(
            afterMode: "\u{1B}[?2004h",
            body: Self.multilineBody
        )
        XCTAssertTrue(
            bracketed.contains(Self.multilineBody),
            "the same multiline body must still paste when bracketed"
        )
    }

    /// Positive control through the same reader: the default (never-set) state
    /// must also be unbracketed. Paired with the SET row this proves the reader
    /// distinguishes the two states rather than reporting one of them always.
    func testPositiveControlDefaultStateIsUnbracketedThroughSameReader() throws {
        let never = try pasteWrites(afterMode: "")
        let set = try pasteWrites(afterMode: "\u{1B}[?2004h")

        XCTAssertFalse(never.contains("\u{1B}[200~"), "default state must not bracket")
        XCTAssertTrue(set.contains("\u{1B}[200~"), "set state must bracket")
        XCTAssertNotEqual(
            never, set,
            "the reader returned the same transcript for set and unset 2004; "
                + "it is blind to the mode and every row in this file is unattributable"
        )
    }

    private func drainMainRunLoop(until predicate: () -> Bool, timeout: TimeInterval = 2) {
        let deadline = Date().addingTimeInterval(timeout)
        while !predicate() && Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
    }
}
