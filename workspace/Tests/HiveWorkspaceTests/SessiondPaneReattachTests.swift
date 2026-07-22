import XCTest
@testable import HiveWorkspace
import WorkspaceCore

/// A pane retries the exact generation with one fresh grant after each
/// completed failure. Repeated failures become visible but never latch.
final class SessiondPaneReattachTests: XCTestCase {
    private func makeTerminal() -> SessiondPaneTerminal {
        SessiondPaneTerminal(
            agentName: "aria",
            locator: AgentSessionLocator(
                instanceId: "instance",
                subject: AgentSessionSubject(kind: "agent", agentId: "agent-aria"),
                generation: 1,
                sessionId: "ses_0198a8f0-0000-7000-8000-000000000001",
                hostKind: "sessiond",
                engineBuildId: "engine"
            ),
            hivePath: "/usr/bin/true",
            daemonPort: 1,
            instanceHome: "/tmp"
        )
    }

    func testRepeatedFailuresDegradeVisiblyOnce() {
        let terminal = makeTerminal()
        var degraded: [String] = []
        var failures: [String] = []
        terminal.onDegraded = { degraded.append($0) }
        terminal.onFailure = { failures.append($0) }

        for _ in 0..<terminal.failuresBeforeDegraded + 20 {
            terminal.recordReconnectFailureForTesting("host refused")
        }

        XCTAssertTrue(terminal.degraded)
        XCTAssertEqual(terminal.lastFailure, "host refused")
        XCTAssertEqual(degraded, ["host refused"], "degraded once, surfaced once")
        XCTAssertFalse(terminal.gaveUp, "a host refusal is recoverable — it must not latch")
        XCTAssertEqual(failures, [], "the sticky give-up is reserved for unrecoverable losses")
        XCTAssertEqual(terminal.reconnectDelay, 1)
    }

    /// The other half of #90: recovery must actually re-engage. A live attach
    /// lifts the degraded state and says so, through the same entry point
    /// `completeAttach` uses.
    func testGoingLiveClearsTheDegradedStateAndReportsRecovery() {
        let terminal = makeTerminal()
        var degraded: [String] = []
        var recoveries = 0
        terminal.onDegraded = { degraded.append($0) }
        terminal.onRecovered = { recoveries += 1 }

        for _ in 0..<terminal.failuresBeforeDegraded {
            terminal.recordReconnectFailureForTesting("host refused")
        }
        XCTAssertTrue(terminal.degraded, "positive control: the pane really was degraded")

        terminal.noteLiveAttach()

        XCTAssertFalse(terminal.degraded)
        XCTAssertNil(terminal.lastFailure)
        XCTAssertEqual(recoveries, 1, "recovery is reported exactly once")
        // And the budget starts fresh, so a later transient loss gets the full
        // fast retry window rather than degrading immediately.
        terminal.recordReconnectFailureForTesting("later loss")
        XCTAssertFalse(terminal.degraded)
        XCTAssertEqual(degraded, ["host refused"])
    }

    func testReconnectUsesOneFixedDelay() {
        let terminal = makeTerminal()
        XCTAssertEqual(terminal.reconnectDelay, 1, accuracy: 0.0001)
    }

    /// #81: the geometry poll had no bound, so a pane whose surface never
    /// measured a usable grid waited forever with nothing on screen, no badge
    /// and nothing in workspace.log. It must become visible — and keep polling,
    /// because geometry arrives the moment the pane is given room.
    func testGeometryWaitBecomesVisibleAndKeepsPolling() {
        let terminal = makeTerminal()
        terminal.geometryWaitOverride = 0.05
        var reports: [String] = []
        let surfaced = expectation(description: "geometry wait surfaced")
        // Over-fulfilment fails the test, which is the guard against a notice
        // that fires once per 0.05s poll tick instead of once per wait.
        terminal.onDegraded = {
            reports.append($0)
            surfaced.fulfill()
        }
        // No view is installed, so reportedGeometry never becomes usable.
        terminal.startWhenGeometryReady()
        wait(for: [surfaced], timeout: 5)
        // Keep polling past the notice: a bound that stops the poll would strand
        // a pane that is about to be given room.
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        terminal.detach()

        XCTAssertTrue(terminal.waitingForGeometry)
        XCTAssertEqual(reports.count, 1, "reported once, not once per poll tick")
        XCTAssertFalse(terminal.gaveUp, "a pane with no room yet is not a failed pane")
        XCTAssertFalse(terminal.degraded, "the geometry wait is not an attach failure")
    }

    /// Control: before its bound the wait stays quiet, so the row above is
    /// reading a real bound rather than a notice that fires unconditionally.
    func testControlGeometryWaitStaysQuietBeforeItsBound() {
        let terminal = makeTerminal()
        terminal.geometryWaitOverride = 30
        var reports: [String] = []
        terminal.onDegraded = { reports.append($0) }

        terminal.startWhenGeometryReady()
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        terminal.detach()

        XCTAssertFalse(terminal.waitingForGeometry)
        XCTAssertEqual(reports, [], "the wait notice fired before its bound")
    }

    /// A detached pane never retries and never reports a failure — renderer
    /// detach is not an attach failure (§26: detach never claims close).
    func testDetachedPaneDoesNotRetryOrFail() {
        let terminal = makeTerminal()
        var failures: [String] = []
        terminal.onFailure = { failures.append($0) }
        terminal.detach()

        terminal.recordReconnectFailureForTesting("boom")
        XCTAssertFalse(terminal.gaveUp)
        XCTAssertFalse(terminal.degraded)
        XCTAssertEqual(failures, [])
    }

    /// The visible give-up must OUTLIVE the feed. `update(state:)` rewrites the
    /// header and re-hides the failure badge on every feed tick, so a pane
    /// whose renderer had given up read "claude · … · idle" with no badge while
    /// nothing was attached — the failure was on screen for one tick. Anyone
    /// looking at the pane then sees a healthy agent and an empty terminal.
    func testTerminalFailureOutlivesAFeedRefresh() throws {
        let pane = PaneView(paneID: "worker", title: "aria") { _ in }
        pane.showTerminalFailure(
            detail: "renderer disconnected",
            badge: "Terminal renderer disconnected",
            evidence: "grant 0d9070c4 != local 9b78f469")
        let badge = try XCTUnwrap(Self.failureBadge(in: pane))
        // Positive control: the failure really is on screen before the refresh.
        XCTAssertFalse(badge.isHidden)

        pane.update(state: PaneState(
            id: "worker", kind: .agent, title: "aria",
            feedStatus: "idle", status: .running))

        XCTAssertEqual(pane.terminalFailure?.detail, "renderer disconnected")
        XCTAssertFalse(badge.isHidden, "a healthy feed tick must not hide the failure badge")
        XCTAssertTrue(
            Self.labels(in: pane).contains { $0.stringValue == "renderer disconnected" },
            "the feed's header description must not overwrite the renderer failure")
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
