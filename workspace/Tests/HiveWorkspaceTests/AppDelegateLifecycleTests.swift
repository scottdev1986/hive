import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore

@MainActor
final class AppDelegateLifecycleTests: XCTestCase {

    func testTrackedMenuIsCancelledWhenTheInstanceCloses() {
        _ = NSApplication.shared
        let owner = AppDelegate(config: LaunchConfig())
        let menu = RecordingMenu(title: "Tracked")
        NotificationCenter.default.post(
            name: NSMenu.didBeginTrackingNotification, object: menu)

        owner.closeOwnedSurfaces()

        XCTAssertEqual(menu.cancellationCount, 1)
    }

    func testProjectCloseEndsEverySheetBeforeClosingOtherWindows() {
        let project = NSObject()
        let settings = NSObject()
        var ended: [ObjectIdentifier] = []
        var closed: [ObjectIdentifier] = []

        AppDelegate.tearDownWindows(
            [project, settings], keeping: project,
            endSheets: { ended.append(ObjectIdentifier($0)) },
            close: { closed.append(ObjectIdentifier($0)) })

        XCTAssertEqual(
            Set(ended), Set([ObjectIdentifier(project), ObjectIdentifier(settings)]))
        XCTAssertEqual(closed, [ObjectIdentifier(settings)])
    }

    func testOnlyAnOwnedAppModalSessionIsAborted() {
        let owned = NSObject()
        let sibling = NSObject()
        var abortCount = 0

        AppDelegate.abortModalIfOwned(owned, ownedWindows: [owned]) {
            abortCount += 1
        }
        AppDelegate.abortModalIfOwned(sibling, ownedWindows: [owned]) {
            abortCount += 1
        }

        XCTAssertEqual(abortCount, 1)
    }

    func testStatusAndFocusOverlaysAreAboveTheOpaquePaneBackground() throws {
        let pane = PaneView(paneID: "worker", title: "worker") { _ in }
        let backgroundIndex = try XCTUnwrap(
            pane.subviews.firstIndex(where: { $0 is NSVisualEffectView }))
        let statusIndex = try XCTUnwrap(
            pane.subviews.firstIndex(where: { $0 is PaneStatusBorderView }))
        let focusIndex = try XCTUnwrap(
            pane.subviews.firstIndex(where: { $0 is PaneFocusRingView }))

        XCTAssertGreaterThan(statusIndex, backgroundIndex)
        XCTAssertGreaterThan(focusIndex, backgroundIndex)
        XCTAssertNil(pane.subviews[statusIndex].hitTest(.zero))
        XCTAssertNil(pane.subviews[focusIndex].hitTest(.zero))
    }

    func testPaneTitleTruncatesWithoutDrivingWindowWidth() throws {
        let pane = PaneView(paneID: "worker", title: "initial-title") { _ in }
        let title = try XCTUnwrap(textFields(in: pane).first {
            $0.stringValue == "initial-title"
        })

        XCTAssertLessThan(
            title.contentCompressionResistancePriority(for: .horizontal).rawValue, 500)
        XCTAssertEqual(title.toolTip, "initial-title")

        pane.update(state: PaneState(
            id: "worker", kind: .agent, title: "updated-title",
            feedStatus: "working", status: .running))
        XCTAssertEqual(title.toolTip, "updated-title")
    }

    private func textFields(in view: NSView) -> [NSTextField] {
        ((view as? NSTextField).map { [$0] } ?? [])
            + view.subviews.flatMap(textFields)
    }

    private final class RecordingMenu: NSMenu {
        var cancellationCount = 0

        override func cancelTrackingWithoutAnimation() {
            cancellationCount += 1
        }
    }
}
