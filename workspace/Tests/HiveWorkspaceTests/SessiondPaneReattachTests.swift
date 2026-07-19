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
}
