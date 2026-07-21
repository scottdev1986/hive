import XCTest
@testable import HiveWorkspace
import WorkspaceCore

/// B2.2 bounded recovery (§26) as amended by #90: a sessiond pane whose host
/// keeps refusing must surface a visible failure after a bounded number of fast
/// attempts — never an infinite SILENT retry loop — but it must keep retrying
/// at the capped backoff, because a resting "renderer disconnected" pane for a
/// condition the host can recover from is the defect, not the safety net.
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

    /// #90: exhausting the fast budget degrades the pane VISIBLY and once, and
    /// recovery keeps going. The old contract stopped here, which is exactly
    /// the dead pane the user ruled against.
    func testBudgetExhaustionDegradesVisiblyAndKeepsRetrying() {
        let terminal = makeTerminal()
        var degraded: [String] = []
        var failures: [String] = []
        terminal.onDegraded = { degraded.append($0) }
        terminal.onFailure = { failures.append($0) }

        // Well past the budget: every one of these must still be authorized.
        let attempts = terminal.maxAttachAttempts + 20
        for attempt in 1...attempts {
            XCTAssertTrue(
                terminal.registerFailedAttemptAndShouldRetry("host refused"),
                "retry \(attempt) was refused; a recoverable loss must never stop retrying")
        }

        XCTAssertTrue(terminal.degraded)
        XCTAssertEqual(terminal.lastFailure, "host refused")
        XCTAssertEqual(degraded, ["host refused"], "degraded once, surfaced once")
        XCTAssertFalse(terminal.gaveUp, "a host refusal is recoverable — it must not latch")
        XCTAssertEqual(failures, [], "the sticky give-up is reserved for unrecoverable losses")
        // Not an unbounded hot loop: the backoff is capped, so a pane that
        // never recovers costs one attempt per maxRetryDelay, visibly.
        XCTAssertEqual(terminal.retryDelay(forAttempt: attempts), terminal.maxRetryDelay)
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

        for _ in 0...terminal.maxAttachAttempts {
            _ = terminal.registerFailedAttemptAndShouldRetry("host refused")
        }
        XCTAssertTrue(terminal.degraded, "positive control: the pane really was degraded")

        terminal.noteLiveAttach()

        XCTAssertFalse(terminal.degraded)
        XCTAssertNil(terminal.lastFailure)
        XCTAssertEqual(recoveries, 1, "recovery is reported exactly once")
        // And the budget starts fresh, so a later transient loss gets the full
        // fast retry window rather than degrading immediately.
        XCTAssertTrue(terminal.registerFailedAttemptAndShouldRetry("later loss"))
        XCTAssertFalse(terminal.degraded)
        XCTAssertEqual(degraded, ["host refused"])
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

    /// The recovery timer reaches a VISIBLE degraded state even when the attach
    /// never progresses (no view/geometry) — the regression guard for a stalled
    /// attach chain silently stranding the pane instead of surfacing.
    func testRecoveryTimerReachesDegradedWithoutAProgressingAttach() {
        let terminal = makeTerminal()
        terminal.recoveryIntervalOverride = 0.01
        var reports: [String] = []
        let surfaced = expectation(description: "recovery degraded")
        terminal.onDegraded = {
            reports.append($0)
            surfaced.fulfill()
        }
        // No view is installed, so every timer-driven attach is a no-op; the
        // timer must still count down the budget and surface on its own.
        terminal.startRecoveryForTesting("host gone")
        wait(for: [surfaced], timeout: 5)
        XCTAssertTrue(terminal.degraded)
        XCTAssertFalse(terminal.gaveUp)
        XCTAssertEqual(reports, ["host gone"], "degraded once, visibly")
        // #91: a stalled chain must be distinguishable from one that was really
        // refused. No grant request ever left, so no refusal was recorded.
        XCTAssertEqual(terminal.totalAttachRefusals, 0)
        XCTAssertNil(terminal.lastAttachRefusal)
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
