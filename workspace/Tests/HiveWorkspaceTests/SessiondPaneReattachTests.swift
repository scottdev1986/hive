import XCTest
@testable import HiveWorkspace
import WorkspaceCore

/// Initial host availability and later transport loss use one attach loop.
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

    func testFailureBeforeFirstLiveAttachRemainsPendingAndRetries() {
        let terminal = makeTerminal()
        defer { terminal.detach() }
        var degraded: [String] = []
        var failures: [String] = []
        terminal.onDegraded = { degraded.append($0) }
        terminal.onFailure = { failures.append($0) }

        terminal.recordReconnectFailureForTesting("host refused")
        for _ in 0..<(terminal.failuresBeforeDegraded + 1) {
            terminal.recordReconnectFailureForTesting("host still starting")
        }

        XCTAssertFalse(terminal.degraded)
        XCTAssertEqual(terminal.lastFailure, "host still starting")
        XCTAssertEqual(degraded, [])
        XCTAssertFalse(terminal.gaveUp)
        XCTAssertEqual(failures, [])
    }

    /// The other half of #90: recovery must actually re-engage. A live attach
    /// lifts the degraded state and says so, through the same entry point
    /// `completeAttach` uses.
    func testLossAfterLiveAttachRetriesAndReportsRecovery() {
        let terminal = makeTerminal()
        var degraded: [String] = []
        var recoveries = 0
        terminal.onDegraded = { degraded.append($0) }
        terminal.onRecovered = { recoveries += 1 }

        terminal.noteLiveAttach()
        for _ in 0..<terminal.failuresBeforeDegraded {
            terminal.recordReconnectFailureForTesting("transport lost")
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
        XCTAssertEqual(degraded, ["transport lost"])
    }

    func testReconnectUsesOneFixedDelay() {
        let terminal = makeTerminal()
        XCTAssertEqual(terminal.reconnectDelay, 1, accuracy: 0.0001)
    }

    func testStartDoesNotWaitForMeasuredGeometry() {
        let terminal = makeTerminal()
        var requestedGeometry: String?
        terminal.requestGrant = {
            requestedGeometry = $0
            throw SessiondPaneTerminalError.grantRefused("test")
        }

        terminal.start()
        let deadline = Date().addingTimeInterval(2)
        while requestedGeometry == nil, Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }

        XCTAssertTrue(terminal.hasStarted)
        XCTAssertTrue(requestedGeometry?.contains("\"columns\":80") == true)
        XCTAssertTrue(requestedGeometry?.contains("\"rows\":24") == true)
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
