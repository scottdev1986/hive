import XCTest
@testable import WorkspaceCore

final class ComposerInputTests: XCTestCase {
    func testEditsStartProtection() {
        XCTAssertEqual(classifyComposerInput(characters: "a"), .editing)
        XCTAssertEqual(classifyComposerInput(characters: "\u{7f}"), .editing)
        XCTAssertEqual(classifyComposerInput(characters: "v", command: true), .editing)
    }

    func testSubmitAndCancelEndProtection() {
        XCTAssertEqual(classifyComposerInput(characters: "\r"), .submitted)
        XCTAssertEqual(classifyComposerInput(characters: "\u{1b}"), .cancelled)
        XCTAssertEqual(classifyComposerInput(characters: "\u{3}", control: true), .cancelled)
        XCTAssertEqual(classifyComposerInput(characters: "u", control: true), .cancelled)
    }

    func testNavigationAndApplicationShortcutsDoNotInventDrafts() {
        XCTAssertEqual(classifyComposerInput(characters: "\u{F700}"), .ignored)
        XCTAssertEqual(classifyComposerInput(characters: "k", command: true), .ignored)
        XCTAssertEqual(classifyComposerInput(characters: ""), .ignored)
    }
}
