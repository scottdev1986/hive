import XCTest
@testable import HiveWorkspace
import WorkspaceCore

/// B2.2 bounded recovery (§26): a sessiond pane whose host keeps refusing must
/// give up after a bounded number of attempts and surface a visible failure —
/// never an infinite silent retry loop.
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

    /// The retry budget authorizes exactly `maxAttachAttempts` retries, then
    /// gives up ONCE with a visible failure and stays given up — no infinite
    /// loop, no repeated failure notifications.
    func testBoundedReattachGivesUpWithVisibleFailure() {
        let terminal = makeTerminal()
        var failures: [String] = []
        terminal.onFailure = { failures.append($0) }

        var authorizedRetries = 0
        // Hard cap so an unbounded (infinite-loop) regression FAILS cleanly here
        // instead of hanging the suite.
        let hardCap = terminal.maxAttachAttempts + 1000
        while terminal.registerFailedAttemptAndShouldRetry("host refused") {
            authorizedRetries += 1
            if authorizedRetries >= hardCap {
                XCTFail("retry budget is unbounded — \(authorizedRetries) retries with no give-up")
                break
            }
        }

        XCTAssertEqual(authorizedRetries, terminal.maxAttachAttempts,
                       "exactly the budgeted number of retries are authorized")
        XCTAssertTrue(terminal.gaveUp)
        XCTAssertEqual(terminal.lastFailure, "host refused")
        XCTAssertEqual(failures, ["host refused"], "one terminal failure, surfaced once")

        // Idempotent: further attempts stay given up and never re-fire.
        XCTAssertFalse(terminal.registerFailedAttemptAndShouldRetry("host refused again"))
        XCTAssertEqual(failures, ["host refused"])
    }

    /// Recovery backoff is EXPONENTIAL (0.5→8s cap) and escalates — the
    /// regression guard for a flattened fixed interval. A fixed delay fails
    /// both the exact values and the escalation assertion.
    func testRetryBackoffIsExponential() {
        let terminal = makeTerminal()
        XCTAssertEqual(terminal.retryDelay(forAttempt: 0), 0.5, accuracy: 0.0001)
        XCTAssertEqual(terminal.retryDelay(forAttempt: 1), 1.0, accuracy: 0.0001)
        XCTAssertEqual(terminal.retryDelay(forAttempt: 2), 2.0, accuracy: 0.0001)
        XCTAssertEqual(terminal.retryDelay(forAttempt: 3), 4.0, accuracy: 0.0001)
        XCTAssertEqual(terminal.retryDelay(forAttempt: 4), 8.0, accuracy: 0.0001)
        XCTAssertEqual(terminal.retryDelay(forAttempt: 5), 8.0, accuracy: 0.0001, "capped at max")
        for attempt in 0..<4 {
            XCTAssertGreaterThan(
                terminal.retryDelay(forAttempt: attempt + 1),
                terminal.retryDelay(forAttempt: attempt),
                "backoff must escalate, not stay flat"
            )
        }
    }

    /// The recovery timer drives to a visible give-up even when the attach
    /// never progresses (no view/geometry) — the regression guard for a stalled
    /// attach chain silently stranding the pane instead of failing visibly.
    func testRecoveryTimerReachesGiveUpWithoutAProgressingAttach() {
        let terminal = makeTerminal()
        terminal.recoveryIntervalOverride = 0.01
        var failures: [String] = []
        let gaveUp = expectation(description: "recovery gave up")
        terminal.onFailure = {
            failures.append($0)
            gaveUp.fulfill()
        }
        // No view is installed, so every timer-driven attach is a no-op; the
        // timer must still count down the budget and give up on its own.
        terminal.startRecoveryForTesting("host gone")
        wait(for: [gaveUp], timeout: 5)
        XCTAssertTrue(terminal.gaveUp)
        XCTAssertEqual(failures, ["host gone"], "gave up once, visibly")
    }

    /// A detached pane never retries and never reports a failure — renderer
    /// detach is not an attach failure (§26: detach never claims close).
    func testDetachedPaneDoesNotRetryOrFail() {
        let terminal = makeTerminal()
        var failures: [String] = []
        terminal.onFailure = { failures.append($0) }
        terminal.detach()

        XCTAssertFalse(terminal.registerFailedAttemptAndShouldRetry("boom"))
        XCTAssertFalse(terminal.gaveUp)
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
