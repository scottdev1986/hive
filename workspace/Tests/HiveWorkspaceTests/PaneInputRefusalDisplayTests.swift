import XCTest
@testable import HiveWorkspace
import WorkspaceCore

/// The pane's sticky give-up latch is reserved for terminal renderer failures.
/// Input arbitration is an internal queue and has no status-header path.
final class PaneTerminalStatusTests: XCTestCase {
    private func healthyFeedTick(_ pane: PaneView) {
        pane.update(state: PaneState(
            id: "worker", kind: .agent, title: "aria",
            feedStatus: "working", status: .running))
    }

    /// #90, same split for the renderer: a pane still reconnecting says so
    /// transiently and clears when it recovers. Latching here is what put a
    /// resting "renderer disconnected" on a pane whose host was fine.
    func testRendererRecoveringShowsWithoutLatchingTheGiveUp() throws {
        let pane = PaneView(paneID: "worker", title: "aria") { _ in }
        healthyFeedTick(pane)

        pane.showRendererRecovering("host transport lost")

        XCTAssertNil(
            pane.terminalFailure,
            "a reconnecting renderer latched the sticky give-up; the pane will read dead forever")
        XCTAssertTrue(Self.failureBadge(in: pane)?.isHidden ?? true)
        XCTAssertTrue(
            Self.labels(in: pane).contains { $0.stringValue == "renderer reconnecting…" })

        pane.showRendererRecovering(nil)
        XCTAssertTrue(
            Self.labels(in: pane).contains { $0.stringValue == "working" },
            "the recovering notice outlived the recovery")
    }

    func testRendererRecoveryReturnsToFeed() throws {
        let pane = PaneView(paneID: "worker", title: "aria") { _ in }
        healthyFeedTick(pane)

        pane.showRendererRecovering("host transport lost")
        XCTAssertTrue(
            Self.labels(in: pane).contains { $0.stringValue == "renderer reconnecting…" })

        pane.showRendererRecovering(nil)
        XCTAssertTrue(
            Self.labels(in: pane).contains { $0.stringValue == "working" },
            "renderer recovery invented an input refusal while a claim was pending")
    }

    private static func labels(in view: NSView) -> [NSTextField] {
        view.subviews.flatMap { labels(in: $0) } + view.subviews.compactMap { $0 as? NSTextField }
    }

    private static func failureBadge(in view: NSView) -> NSImageView? {
        for subview in view.subviews {
            if let image = (subview as? NSImageView)?.image,
               image.accessibilityDescription == "Failure" {
                return subview as? NSImageView
            }
            if let found = failureBadge(in: subview) { return found }
        }
        return nil
    }
}
