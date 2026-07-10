import XCTest
@testable import WorkspaceCore

final class ANSIParserTests: XCTestCase {

    func testPlainTextPassesThrough() {
        let spans = ANSIParser.parse("hello world")
        XCTAssertEqual(spans.count, 1)
        XCTAssertEqual(spans[0].text, "hello world")
        XCTAssertNil(spans[0].foreground)
    }

    func testBasicColorAndReset() {
        let spans = ANSIParser.parse("\u{1B}[31mred\u{1B}[0m plain")
        XCTAssertEqual(spans.count, 2)
        XCTAssertEqual(spans[0].text, "red")
        XCTAssertEqual(spans[0].foreground, .standard(1))
        XCTAssertEqual(spans[1].text, " plain")
        XCTAssertNil(spans[1].foreground)
    }

    func testBoldItalicUnderlineCombine() {
        let spans = ANSIParser.parse("\u{1B}[1;3;4;32mstyled\u{1B}[0m")
        XCTAssertEqual(spans.count, 1)
        XCTAssertTrue(spans[0].bold)
        XCTAssertTrue(spans[0].italic)
        XCTAssertTrue(spans[0].underline)
        XCTAssertEqual(spans[0].foreground, .standard(2))
    }

    func test256AndTruecolor() {
        let spans = ANSIParser.parse("\u{1B}[38;5;208morange\u{1B}[0m\u{1B}[38;2;120;200;90mgreen\u{1B}[0m")
        XCTAssertEqual(spans.map(\.text), ["orange", "green"])
        XCTAssertEqual(spans[0].foreground, .palette256(208))
        XCTAssertEqual(spans[1].foreground, .rgb(120, 200, 90))
    }

    func testBrightAndBackground() {
        let spans = ANSIParser.parse("\u{1B}[97;41mwhite on red\u{1B}[0m")
        XCTAssertEqual(spans[0].foreground, .bright(7))
        XCTAssertEqual(spans[0].background, .standard(1))
    }

    func testNonSGRSequencesAreDroppedCleanly() {
        // Cursor movement, erase, OSC title set — none may leak into text.
        let input = "\u{1B}[2J\u{1B}[H\u{1B}]0;window title\u{07}visible\u{1B}[K text"
        XCTAssertEqual(ANSIParser.plainText(input), "visible text")
    }

    func testMalformedTrailingEscapeDoesNotCrash() {
        XCTAssertEqual(ANSIParser.plainText("ok\u{1B}"), "ok")
        XCTAssertEqual(ANSIParser.plainText("ok\u{1B}[31"), "ok")
    }

    func testFixtureANSILogRoundTrips() {
        let log = "\u{1B}[1m\u{1B}[34m==>\u{1B}[0m Linting\n\u{1B}[33mwarning:\u{1B}[0m long line\n"
        let plain = ANSIParser.plainText(log)
        XCTAssertEqual(plain, "==> Linting\nwarning: long line\n")
    }
}
