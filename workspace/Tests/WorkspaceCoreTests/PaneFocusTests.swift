import XCTest
@testable import WorkspaceCore

final class PaneFocusTests: XCTestCase {

    private let alpha = PaneID("alpha")
    private let beta = PaneID("beta")

    func testFirstResponderPaneInKeyWindowIsActive() {
        XCTAssertEqual(
            paneFocusIndicator(pane: alpha, firstResponderPane: alpha, windowIsKey: true),
            .active)
    }

    /// The honesty rule: focus is still real, but no keystrokes are arriving,
    /// so the indicator must not claim otherwise.
    func testFirstResponderPaneInNonKeyWindowIsInactive() {
        XCTAssertEqual(
            paneFocusIndicator(pane: alpha, firstResponderPane: alpha, windowIsKey: false),
            .inactive)
    }

    func testOtherPanesShowNoIndicator() {
        XCTAssertEqual(
            paneFocusIndicator(pane: beta, firstResponderPane: alpha, windowIsKey: true),
            .none)
        XCTAssertEqual(
            paneFocusIndicator(pane: beta, firstResponderPane: alpha, windowIsKey: false),
            .none)
    }

    /// No pane owns the first responder (e.g. the focused pane was just closed):
    /// nothing may claim focus, key window or not.
    func testNoFirstResponderPaneShowsNoIndicator() {
        XCTAssertEqual(
            paneFocusIndicator(pane: alpha, firstResponderPane: nil, windowIsKey: true),
            .none)
        XCTAssertEqual(
            paneFocusIndicator(pane: alpha, firstResponderPane: nil, windowIsKey: false),
            .none)
    }
}
