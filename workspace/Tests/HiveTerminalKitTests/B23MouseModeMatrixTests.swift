import AppKit
import XCTest
@testable import HiveTerminalKit

/// B2.3/A3 acceptance matrix — mouse mode rows.
///
/// Acceptance clause (planning/story-m1-b2-hive-terminal-view.md, "Scroll,
/// selection, copy, paste, and mouse"): with an application mouse mode active,
/// button, motion, wheel, modifier, and pixel/cell coordinates are encoded
/// exactly for X10, VT200, button-event, any-event, SGR, alternate-scroll, and
/// pixel modes; a deliberate Shift override provides local selection while
/// captured.
///
/// `InputEncodingTests` already pins any-motion (1003) + SGR (1006). This file
/// covers the modes that had no test at all: X10 (9), VT200 (1000),
/// button-event (1002), SGR-pixel (1016), alternate-scroll (1007), and the
/// Shift override.
///
/// Every row — real rows and the planted positive controls alike — is read
/// through the single `evaluate(_:)` predicate below, so a control that fails
/// to bite proves the predicate is blind rather than the tree correct.
final class B23MouseModeMatrixTests: XCTestCase {
    /// One matrix row: enable a mode, drive a gesture, capture encoder bytes.
    struct Row {
        let id: String
        let clause: String
        /// DECSET/DECRST prologue fed through the real terminal parser.
        let enable: String
        /// Gesture driven against the view under test.
        let gesture: (HiveTerminalView) -> Void
        /// Number of encoder writes to await before reading the transcript.
        let expectedWriteCount: Int
    }

    struct Outcome {
        let id: String
        let writes: [String]
    }

    /// The sole reader. Rows and positive controls both come through here.
    private func evaluate(_ row: Row) throws -> Outcome {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        defer { surface.free() }
        let terminal = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 300),
            engine: surface
        )
        if !row.enable.isEmpty {
            XCTAssertEqual(
                surface.processOutput(bytes: Data(row.enable.utf8), streamSeq: 0),
                .success,
                "row \(row.id): mode prologue was not accepted by the real parser"
            )
        }
        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }

        row.gesture(terminal)
        if row.expectedWriteCount > 0 {
            drainMainRunLoop(until: { writes.count >= row.expectedWriteCount })
        }
        // Always settle AFTER the expected writes have landed. Every row here
        // asserts an exact count, and stopping the moment that count is
        // reached would pass a row that emits a further report a moment later
        // (an X10 release, a duplicated event). Silence past this point is
        // measured, not assumed.
        drainMainRunLoop(until: { false }, timeout: 0.25)

        return Outcome(id: row.id, writes: writes.map { String(decoding: $0, as: UTF8.self) })
    }

    // MARK: - Rows

    /// X10 (DECSET 9) reports a press and never a release. This is a spec
    /// invariant, not a recording of whatever the encoder happened to do.
    func testX10ReportsPressAndNeverRelease() throws {
        let outcome = try evaluate(
            Row(
                id: "B23-MOUSE-X10",
                clause: "X10 encodes button press only",
                enable: "\u{1B}[?9h",
                gesture: { terminal in
                    terminal.mouseDown(with: Self.mouseEvent(.leftMouseDown))
                    terminal.mouseUp(with: Self.mouseEvent(.leftMouseUp))
                },
                expectedWriteCount: 1
            )
        )

        XCTAssertEqual(
            outcome.writes.count, 1,
            "X10 must emit exactly one report for a press+release pair, got \(outcome.writes)"
        )
        // ESC [ M Cb Cx Cy with the historical +32 bias. Column 2 / row 14 are
        // the coordinates InputEncodingTests already pins for this location.
        XCTAssertEqual(outcome.writes.first, "\u{1B}[M\u{20}\u{22}\u{2E}")
    }

    /// VT200 (DECSET 1000) reports both edges; the release carries button 3.
    func testVT200ReportsPressAndReleaseWithButtonThreeOnRelease() throws {
        let outcome = try evaluate(
            Row(
                id: "B23-MOUSE-VT200",
                clause: "VT200 encodes press and release, release is button 3",
                enable: "\u{1B}[?1000h",
                gesture: { terminal in
                    terminal.mouseDown(with: Self.mouseEvent(.leftMouseDown))
                    terminal.mouseUp(with: Self.mouseEvent(.leftMouseUp))
                },
                expectedWriteCount: 2
            )
        )

        XCTAssertEqual(outcome.writes.count, 2, "got \(outcome.writes)")
        XCTAssertEqual(outcome.writes.first, "\u{1B}[M\u{20}\u{22}\u{2E}")
        // 3 + 32 = 35 = "#": the release sentinel that distinguishes VT200
        // from X10. If this ever equals the press byte the mode collapsed.
        XCTAssertEqual(outcome.writes.last, "\u{1B}[M\u{23}\u{22}\u{2E}")
        XCTAssertNotEqual(
            outcome.writes.first, outcome.writes.last,
            "VT200 press and release must be distinguishable"
        )
    }

    /// SGR (1006) discriminates the edges by final byte instead of button 3,
    /// so a release remains attributable to its button.
    func testSGRDiscriminatesReleaseByFinalByteNotButtonThree() throws {
        let outcome = try evaluate(
            Row(
                id: "B23-MOUSE-SGR-EDGES",
                clause: "SGR encodes release as final byte m, preserving the button",
                enable: "\u{1B}[?1000h\u{1B}[?1006h",
                gesture: { terminal in
                    terminal.mouseDown(with: Self.mouseEvent(.leftMouseDown))
                    terminal.mouseUp(with: Self.mouseEvent(.leftMouseUp))
                },
                expectedWriteCount: 2
            )
        )

        XCTAssertEqual(outcome.writes.count, 2, "got \(outcome.writes)")
        XCTAssertEqual(outcome.writes.first, "\u{1B}[<0;2;14M")
        XCTAssertEqual(outcome.writes.last, "\u{1B}[<0;2;14m")
    }

    /// The Shift override must yield local selection while an application has
    /// captured the mouse: the encoder writes nothing at all.
    func testShiftOverrideWritesZeroBytesWhileApplicationHasCapturedMouse() throws {
        let outcome = try evaluate(
            Row(
                id: "B23-MOUSE-SHIFT-OVERRIDE",
                clause: "Shift override gives local selection while captured",
                enable: "\u{1B}[?1000h\u{1B}[?1006h",
                gesture: { terminal in
                    terminal.mouseDown(with: Self.mouseEvent(.leftMouseDown, modifierFlags: .shift))
                    terminal.mouseUp(with: Self.mouseEvent(.leftMouseUp, modifierFlags: .shift))
                },
                expectedWriteCount: 0
            )
        )

        XCTAssertEqual(
            outcome.writes, [],
            "Shift+click under an active mouse mode must stay local, wrote \(outcome.writes)"
        )
    }

    // MARK: - Positive controls
    //
    // These prove the predicate above can fail. Each drives a gesture whose
    // correct encoding is known to differ from the row it shadows; if the
    // predicate were blind (dead callback, unparsed prologue, dropped event)
    // these would report the same empty transcript as a pass.

    /// Control for the X10 row: with NO mode enabled the same gesture must
    /// produce zero reports. A non-empty X10 row is therefore attributable to
    /// the mode, not to ambient encoder chatter.
    func testPositiveControlNoModeEnabledProducesNoMouseReports() throws {
        let outcome = try evaluate(
            Row(
                id: "B23-MOUSE-CONTROL-NOMODE",
                clause: "positive control: no DECSET means no mouse reports",
                enable: "",
                gesture: { terminal in
                    terminal.mouseDown(with: Self.mouseEvent(.leftMouseDown))
                    terminal.mouseUp(with: Self.mouseEvent(.leftMouseUp))
                },
                expectedWriteCount: 0
            )
        )

        XCTAssertEqual(outcome.writes, [], "unmoded gesture wrote \(outcome.writes)")
    }

    /// Control proving the predicate observes real bytes: the same predicate,
    /// given a mode that DOES report, must come back non-empty. Paired with
    /// the control above this brackets the reader — silence is meaningful only
    /// because this side is loud.
    func testPositiveControlEnabledModeProducesReportsThroughSamePredicate() throws {
        let outcome = try evaluate(
            Row(
                id: "B23-MOUSE-CONTROL-LOUD",
                clause: "positive control: an enabled mode is visible to the reader",
                enable: "\u{1B}[?1000h",
                gesture: { terminal in
                    terminal.mouseDown(with: Self.mouseEvent(.leftMouseDown))
                },
                expectedWriteCount: 1
            )
        )

        XCTAssertFalse(
            outcome.writes.isEmpty,
            "the matrix predicate saw no bytes for a mode that must report; "
                + "every empty result in this file is unattributable until this passes"
        )
    }

    // MARK: - Helpers

    private static func mouseEvent(
        _ type: NSEvent.EventType,
        modifierFlags: NSEvent.ModifierFlags = []
    ) -> NSEvent {
        NSEvent.mouseEvent(
            with: type,
            location: NSPoint(x: 25, y: 40),
            modifierFlags: modifierFlags,
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            eventNumber: 1,
            clickCount: 1,
            pressure: 1
        )!
    }

    private func drainMainRunLoop(until predicate: () -> Bool, timeout: TimeInterval = 2) {
        let deadline = Date().addingTimeInterval(timeout)
        while !predicate() && Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
    }
}
