import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore

@MainActor
final class UsageMeterViewTests: XCTestCase {

    func testMeterLabelsTruncateWithoutDrivingWindowWidth() {
        let meter = UsageMeterView()
        meter.apply(window: MeterWindow(
            label: "A deliberately long vendor window label",
            state: .unknown(reason: "A deliberately long reason")))

        let labels = textFields(in: meter)
        XCTAssertEqual(labels.count, 3)
        for label in labels {
            XCTAssertLessThan(
                label.contentCompressionResistancePriority(for: .horizontal).rawValue, 500)
            XCTAssertEqual(label.toolTip, label.stringValue)
        }
    }

    func testUnmeteredCopyNamesTheActualProvider() {
        let copy = MCCCopy.unmeteredBody("Future Vendor")

        XCTAssertTrue(copy.hasPrefix("Future Vendor does not report plan capacity"))
        XCTAssertFalse(copy.contains("xAI"))
    }

    func testUnmeteredCopyStatesTheWildcardRuleAndNoFakeQuota() {
        let copy = MCCCopy.unmeteredBody("Future Vendor")

        // The new quota policy (§06): unmetered means always spawnable, never
        // a fabricated utilization figure.
        XCTAssertTrue(copy.contains("no fake 100%"))
        XCTAssertTrue(copy.contains("never blocked for usage"))
        XCTAssertEqual(MCCCopy.unmeteredTitle, "No usage meter — always spawnable")
    }

    private func textFields(in view: NSView) -> [NSTextField] {
        ((view as? NSTextField).map { [$0] } ?? [])
            + view.subviews.flatMap(textFields)
    }
}
