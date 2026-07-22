import XCTest
@testable import HiveWorkspace
import HiveTerminalKit
import WorkspaceCore

/// #87 display half: the pane has ONE sticky give-up latch and it must stay
/// reserved for failures the viewer cannot recover from. Recoverable host
/// arbitration stays `waitingForClaim`: it must not change the header or show
/// any refusal at all.
final class PaneInputRefusalDisplayTests: XCTestCase {
    private func healthyFeedTick(_ pane: PaneView) {
        pane.update(state: PaneState(
            id: "worker", kind: .agent, title: "aria",
            feedStatus: "working", status: .running))
    }

    func testWaitingForClaimShowsNoRefusalOrGiveUp() throws {
        let pane = PaneView(paneID: "worker", title: "aria") { _ in }
        healthyFeedTick(pane)

        pane.applyInputSubmissionState(.waitingForClaim)

        XCTAssertNil(
            pane.terminalFailure,
            "recoverable claim arbitration latched the sticky give-up")
        XCTAssertTrue(Self.failureBadge(in: pane)?.isHidden ?? true)
        XCTAssertTrue(
            Self.labels(in: pane).contains { $0.stringValue == "working" },
            "recoverable claim arbitration replaced the healthy feed header")
        XCTAssertFalse(
            Self.labels(in: pane).contains { $0.stringValue.contains("refused") })
    }

    /// Control: the same entry point still latches for a refusal the viewer
    /// cannot retry, so the row above is reading a real split rather than a
    /// pane that simply never shows an input failure any more.
    func testControlTerminalRefusalStillLatchesTheGiveUp() throws {
        let pane = PaneView(paneID: "worker", title: "aria") { _ in }
        healthyFeedTick(pane)

        pane.applyInputSubmissionState(
            .refused(code: "MALFORMED_CLAIM_RESULT", evidence: "claim result has no state"))

        XCTAssertEqual(pane.terminalFailure?.detail, "input refused")
        XCTAssertFalse(try XCTUnwrap(Self.failureBadge(in: pane)).isHidden)

        healthyFeedTick(pane)
        XCTAssertTrue(
            Self.labels(in: pane).contains { $0.stringValue == "input refused" },
            "a feed tick erased an unrecoverable input failure")
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

    func testRendererRecoveryReturnsToFeedWhileClaimIsPending() throws {
        let pane = PaneView(paneID: "worker", title: "aria") { _ in }
        healthyFeedTick(pane)

        pane.applyInputSubmissionState(.waitingForClaim)
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
