import AppKit
import HiveGhosttyC
import XCTest
@testable import HiveTerminalKit

/// B2.3/A3 acceptance matrix — DECSET 1005 (UTF-8) and 1015 (urxvt) mouse
/// coordinate formats.
///
/// Both are applicable in the pinned Ghostty (terminal/mouse.zig enumerates
/// them, stream_terminal.zig accepts both, mouse_encode.zig implements them)
/// and neither had a row.
///
/// COORDINATE CHOICE IS LOAD-BEARING. The other mouse rows click at (25, 40),
/// which lands on column 2. At column 2 the 1005 encoding is BYTE-IDENTICAL
/// to plain X10 — the UTF-8 form only diverges once a coordinate exceeds 95,
/// where the +32 biased value passes 127 and must become a multi-byte
/// sequence. A 1005 row recorded at column 2 would therefore pass against a
/// terminal that ignored 1005 entirely. These rows click at column 100 so the
/// formats are actually distinguishable.
final class B23MouseFormatMatrixTests: XCTestCase {
    /// Wide enough that x = 1005 lands past column 95 (cells are 10px here,
    /// the same geometry the existing mouse rows rely on).
    private static let wideFrame = NSRect(x: 0, y: 0, width: 1400, height: 300)
    private static let farRight = NSPoint(x: 1005, y: 40)

    /// The sole reader: enable a format, press at the far-right column,
    /// return the raw report bytes.
    private func pressReport(
        enabling mode: String,
        frame: NSRect = B23MouseFormatMatrixTests.wideFrame,
        at point: NSPoint = B23MouseFormatMatrixTests.farRight
    ) throws -> Data {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting(
            widthPx: UInt32(frame.width),
            heightPx: UInt32(frame.height)
        )
        defer { surface.free() }
        let terminal = HiveTerminalView(frame: frame, engine: surface)

        XCTAssertEqual(
            surface.processOutput(bytes: Data(mode.utf8), streamSeq: 0),
            .success,
            "mode prologue \(mode.debugDescription) was rejected by the real parser"
        )

        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }
        terminal.mouseDown(with: Self.mouseEvent(.leftMouseDown, at: point))

        drainUntil { !writes.isEmpty }
        // Settle past the first report so a row asserting one encoding cannot
        // pass while a second, contradictory write is still in flight.
        drainIdle(0.25)
        return writes.reduce(into: Data(), { $0.append($1) })
    }

    // At this click the terminal reports column 125, row 14. Each format
    // below carries those SAME logical values; only the transport differs.
    // 125 + 32 = 157 (0x9D), 14 + 32 = 46 (0x2E), button 0 + 32 = 32 (0x20).
    private static let x10Report = Data([0x1B, 0x5B, 0x4D, 0x20, 0x9D, 0x2E])
    /// Identical, except the 157 travels as UTF-8 U+009D (0xC2 0x9D).
    private static let utf8Report = Data([0x1B, 0x5B, 0x4D, 0x20, 0xC2, 0x9D, 0x2E])
    /// urxvt: CSI button ; x ; y M, all decimal, button still +32 biased.
    private static let urxvtReport = Data("\u{1B}[32;125;14M".utf8)

    /// Baseline: the default format emits the coordinate as one raw byte,
    /// which above 127 is not valid UTF-8 on its own. This is the value 1005
    /// exists to fix, so it is pinned first.
    func testDefaultFormatEmitsRawHighByteCoordinate() throws {
        let report = try pressReport(enabling: "\u{1B}[?1000h")

        XCTAssertEqual(report, Self.x10Report, "got \(Self.hex(report))")
        XCTAssertNil(
            String(data: report.suffix(from: 3), encoding: .utf8),
            "the default format's payload must NOT be valid UTF-8 here; "
                + "if it is, the coordinate no longer exceeds 127 and the 1005 "
                + "row below has become a tautology"
        )
    }

    /// DECSET 1005 re-encodes the same coordinate as UTF-8.
    func testUTF8FormatEncodesTheSameCoordinateAsMultibyteUTF8() throws {
        let report = try pressReport(enabling: "\u{1B}[?1000h\u{1B}[?1005h")

        XCTAssertEqual(report, Self.utf8Report, "got \(Self.hex(report))")
        XCTAssertNotEqual(
            report, Self.x10Report,
            "1005 produced the default encoding; the mode was ignored"
        )
        XCTAssertNotNil(
            String(data: report.suffix(from: 3), encoding: .utf8),
            "the 1005 payload must be valid UTF-8"
        )
    }

    /// DECSET 1015 reports the same values in urxvt's decimal form.
    func testUrxvtFormatEncodesTheSameCoordinateInDecimal() throws {
        let report = try pressReport(enabling: "\u{1B}[?1000h\u{1B}[?1015h")

        XCTAssertEqual(report, Self.urxvtReport, "got \(Self.hex(report))")
        // urxvt is CSI-parameter shaped, so it must not be confused with SGR,
        // which uses a '<' introducer and an M/m final-byte distinction.
        XCTAssertFalse(
            String(decoding: report, as: UTF8.self).contains("<"),
            "1015 must not emit the SGR introducer"
        )
    }

    /// Cross-format invariant: all three transports must report the SAME
    /// logical cell. A format that mangled the coordinate would still pass
    /// its own golden above; only this row compares them against each other.
    func testAllThreeFormatsReportTheSameLogicalCell() throws {
        let x10 = try pressReport(enabling: "\u{1B}[?1000h")
        let utf8Mode = try pressReport(enabling: "\u{1B}[?1000h\u{1B}[?1005h")
        let urxvt = try pressReport(enabling: "\u{1B}[?1000h\u{1B}[?1015h")

        // Default and UTF-8 carry coord+32; urxvt carries the bare decimal.
        XCTAssertEqual(x10[4], 125 + 32)
        XCTAssertEqual(x10[5], 14 + 32)
        XCTAssertEqual(Array(utf8Mode[4...5]), Array(Data([0xC2, 0x9D])))
        XCTAssertEqual(utf8Mode[6], 14 + 32)
        XCTAssertTrue(String(decoding: urxvt, as: UTF8.self).contains(";125;14"))
    }

    /// Positive control for the COORDINATE CHOICE, not just the assertion.
    /// At column 2 — where every other mouse row in this matrix clicks — the
    /// 1005 and default encodings are byte-identical. This proves the rows
    /// above would be vacuous at the usual coordinate, and is why they click
    /// far right instead.
    func testPositiveControlFormatsAreIndistinguishableAtLowColumn() throws {
        let narrowX10 = try pressReport(
            enabling: "\u{1B}[?1000h",
            frame: NSRect(x: 0, y: 0, width: 400, height: 300),
            at: NSPoint(x: 25, y: 40)
        )
        let narrowUTF8 = try pressReport(
            enabling: "\u{1B}[?1000h\u{1B}[?1005h",
            frame: NSRect(x: 0, y: 0, width: 400, height: 300),
            at: NSPoint(x: 25, y: 40)
        )

        XCTAssertEqual(
            narrowX10, narrowUTF8,
            "at a low column the two formats are expected to coincide; if they "
                + "differ here the divergence threshold moved and the far-right "
                + "coordinate above should be re-derived"
        )
    }

    // MARK: - Helpers

    private static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined(separator: " ")
    }

    private static func mouseEvent(_ type: NSEvent.EventType, at point: NSPoint) -> NSEvent {
        NSEvent.mouseEvent(
            with: type,
            location: point,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            eventNumber: 1,
            clickCount: 1,
            pressure: 1
        )!
    }

    private func drainUntil(_ predicate: () -> Bool, timeout: TimeInterval = 2) {
        let deadline = Date().addingTimeInterval(timeout)
        while !predicate() && Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
    }

    private func drainIdle(_ interval: TimeInterval) {
        let deadline = Date().addingTimeInterval(interval)
        while Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
    }
}
