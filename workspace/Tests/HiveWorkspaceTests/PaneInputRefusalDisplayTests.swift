import XCTest
@testable import HiveWorkspace
import HiveTerminalKit
import WorkspaceCore

/// #87 display half: the pane has ONE sticky give-up latch and it must stay
/// reserved for failures the viewer cannot recover from. A refusal the next
/// keystroke can reverse — the arbiter is busy with an automation inject, or
/// holds this human's orphaned claim — would otherwise latch the pane into
/// reading "input refused" forever while typing actually works again, which is
/// the frozen-pane the user ruled against just wearing a different cause.
final class PaneInputRefusalDisplayTests: XCTestCase {
    private func healthyFeedTick(_ pane: PaneView) {
        pane.update(state: PaneState(
            id: "worker", kind: .agent, title: "aria",
            feedStatus: "working", status: .running))
    }

    func testRetryableRefusalShowsWithoutLatchingTheGiveUp() throws {
        let pane = PaneView(paneID: "worker", title: "aria") { _ in }
        healthyFeedTick(pane)

        pane.applyInputSubmissionState(
            .retryableRefusal(code: "CLAIM_DENIED", evidence: "InputBusy"))

        XCTAssertNil(
            pane.terminalFailure,
            "a retryable refusal latched the sticky give-up; the pane will read frozen forever")
        XCTAssertTrue(Self.failureBadge(in: pane)?.isHidden ?? true)
        XCTAssertTrue(
            Self.labels(in: pane).contains { $0.stringValue == "input refused — type to retry" },
            "a retryable refusal must still be visible while it holds")

        // It clears itself the moment input flows again, without waiting for a
        // feed tick to overwrite it.
        pane.applyInputSubmissionState(.pending(transactionId: "input-1"))
        XCTAssertTrue(
            Self.labels(in: pane).contains { $0.stringValue == "working" },
            "the retryable refusal outlived the input that cleared it")
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
