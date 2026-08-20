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

    /// Recovery must actually re-engage. A live attach lifts the degraded
    /// state and says so, through the same entry point `completeAttach` uses.
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

    func testStartDoesNotAttachUntilGeometryIsUsable() {
        let terminal = makeTerminal()
        var requested = false
        terminal.requestGrant = { _ in
            requested = true
            throw SessiondPaneTerminalError.grantRefused("test")
        }

        terminal.start()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))

        XCTAssertTrue(terminal.hasStarted)
        XCTAssertFalse(requested, "attach must wait for usable geometry")
        terminal.detach()
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
}
