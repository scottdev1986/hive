import XCTest
import CoreGraphics
@testable import WorkspaceCore

final class ProjectStateTests: XCTestCase {

    func testTerminalScrollRequestMapsWheelDirectionAndVelocity() {
        XCTAssertNil(TerminalScrollRequest(deltaY: 0, visibleRows: 40))
        XCTAssertEqual(
            TerminalScrollRequest(deltaY: 0.5, visibleRows: 40),
            TerminalScrollRequest(direction: .up, lineCount: 1))
        XCTAssertEqual(
            TerminalScrollRequest(deltaY: -2, visibleRows: 40),
            TerminalScrollRequest(direction: .down, lineCount: 3))
        XCTAssertEqual(
            TerminalScrollRequest(deltaY: 6, visibleRows: 40),
            TerminalScrollRequest(direction: .up, lineCount: 10))
        XCTAssertEqual(
            TerminalScrollRequest(deltaY: -10, visibleRows: 40),
            TerminalScrollRequest(direction: .down, lineCount: 40))
    }

    func testTerminalScrollSessionUsesLaunchMetadataForOrchestrator() throws {
        let state = ProjectState(projectID: ProjectID("project"), displayName: "Project")
        state.addOrchestrator()
        let pane = try XCTUnwrap(state.panes[ProjectState.orchestratorPaneID])

        XCTAssertEqual(
            terminalScrollSession(for: pane, orchestratorSession: "hive-orchestrator-instance"),
            "hive-orchestrator-instance")
        XCTAssertNil(terminalScrollSession(for: pane, orchestratorSession: nil))
    }

    func testTerminalScrollSessionUsesFeedMetadataForAgent() throws {
        let state = ProjectState(projectID: ProjectID("project"), displayName: "Project")
        state.addOrchestrator()
        state.apply(feed: [agent("worker", session: "hive-worker-instance")])
        let pane = try XCTUnwrap(state.panes[ProjectState.paneID(forAgent: "worker")])

        XCTAssertEqual(
            terminalScrollSession(for: pane, orchestratorSession: "hive-orchestrator-instance"),
            "hive-worker-instance")
    }

    func testTerminalAllowsMouseReportingForBothPaneKinds() throws {
        let state = ProjectState(projectID: ProjectID("project"), displayName: "Project")
        state.addOrchestrator()
        state.apply(feed: [agent("worker", session: "hive-worker-instance")])
        let orchestratorPane = try XCTUnwrap(state.panes[ProjectState.orchestratorPaneID])
        let agentPane = try XCTUnwrap(state.panes[ProjectState.paneID(forAgent: "worker")])

        XCTAssertTrue(terminalAllowsMouseReporting(for: orchestratorPane))
        XCTAssertTrue(terminalAllowsMouseReporting(for: agentPane))
    }

    func testTerminalMouseFilterSuppressesOnlyMalformedNoButtonMotion() {
        func bytes(_ value: String) -> [UInt8] { Array(value.utf8) }

        XCTAssertTrue(isMalformedNoButtonMotion(bytes("\u{1b}[<32;14;21m")))
        XCTAssertTrue(isMalformedNoButtonMotion(bytes("\u{1b}[<36;14;21m")),
                      "modifier bits do not disguise malformed hover")
        for intentional in [
            "\u{1b}[<0;14;21M",  // click press
            "\u{1b}[<0;14;21m",  // click release
            "\u{1b}[<64;14;21M", // wheel up
            "\u{1b}[<65;14;21M", // wheel down
        ] {
            XCTAssertFalse(isMalformedNoButtonMotion(bytes(intentional)))
        }
    }

    private func agent(_ name: String, status: String = "working",
                       tool: String = "claude", model: String = "opus",
                       task: String = "do things", session: String? = nil,
                       contextPct: Double = 12, closedAt: String? = nil) -> AgentSnapshot {
        AgentSnapshot(name: name, tool: tool, model: model, status: status,
                      taskDescription: task, tmuxSession: session ?? "hive-\(name)",
                      contextPct: contextPct, closedAt: closedAt)
    }

    /// A workspace as the window builds it: orchestrator pane first, then a
    /// feed snapshot with three agents.
    private func drivenState() -> ProjectState {
        let state = ProjectState(projectID: "proj", displayName: "hive")
        state.addOrchestrator()
        state.apply(feed: [
            agent("indexer"),
            agent("migrator", status: "awaiting-approval"),
            agent("flaky-e2e", status: "failed"),
        ], now: 1)
        return state
    }

    // The X kills the agent, but the daemon needs a moment: until the kill
    // lands, the feed still lists that agent as live. A pane rebuilt from those
    // snapshots is exactly why the X looked broken.
    func testUserClosedAgentIsNotRebuiltByAFeedThatStillListsItAsLive() {
        let state = drivenState()
        let paneID = ProjectState.paneID(forAgent: "indexer")

        state.markUserClosed(paneID)
        state.apply(.closePane(paneID))
        XCTAssertNil(state.panes[paneID])

        // The kill is in flight; the daemon still reports the agent as working.
        state.apply(feed: [agent("indexer"), agent("migrator"), agent("flaky-e2e")], now: 2)
        XCTAssertNil(state.panes[paneID], "a closed agent's pane must not come back")

        // The agent is dead: the daemon stops reporting it, and the suppression
        // is forgotten so a future agent of the same name gets a pane again.
        state.apply(feed: [agent("migrator"), agent("flaky-e2e")], now: 3)
        state.apply(feed: [agent("indexer"), agent("migrator"), agent("flaky-e2e")], now: 4)
        XCTAssertNotNil(state.panes[paneID], "a new agent by that name gets its pane")
    }

    // A kill that failed leaves the agent alive, and the user has to see that.
    func testClearingTheSuppressionBringsALiveAgentBack() {
        let state = drivenState()
        let paneID = ProjectState.paneID(forAgent: "indexer")

        state.markUserClosed(paneID)
        state.apply(.closePane(paneID))
        state.clearUserClosed(paneID)

        state.apply(feed: [agent("indexer"), agent("migrator"), agent("flaky-e2e")], now: 2)
        XCTAssertNotNil(state.panes[paneID], "an agent that survived its kill is shown again")
    }

    func testOrchestratorIsMasterAndFeedAgentsGetPanes() {
        let state = drivenState()
        XCTAssertEqual(Set(state.panes.keys), Set([
            ProjectState.orchestratorPaneID,
            ProjectState.paneID(forAgent: "indexer"),
            ProjectState.paneID(forAgent: "migrator"),
            ProjectState.paneID(forAgent: "flaky-e2e"),
        ]))
        XCTAssertEqual(state.layout.master, ProjectState.orchestratorPaneID)
        XCTAssertEqual(state.orchestratorPane, ProjectState.orchestratorPaneID)
        XCTAssertEqual(state.panes[ProjectState.paneID(forAgent: "indexer")]?.tmuxSession, "hive-indexer")
    }

    func testAgentHeaderHasEachFieldOnceAndUsesLiveActivity() throws {
        let state = ProjectState(projectID: "proj", displayName: "hive")
        let paneID = ProjectState.paneID(forAgent: "reviewer")
        state.apply(feed: [
            agent("reviewer", status: "working", tool: "codex", model: "gpt-5.4",
                  task: "spawn-time assignment", contextPct: 12),
        ], now: 1)

        XCTAssertEqual(
            try XCTUnwrap(state.panes[paneID]).headerDescription,
            "codex · gpt-5.4 · working · ctx 12%")

        let changes = state.apply(feed: [
            agent("reviewer", status: "idle", tool: "codex", model: "gpt-5.4",
                  task: "spawn-time assignment", contextPct: 12),
        ], now: 2)
        XCTAssertTrue(changes.contains(.statusChanged(paneID)))
        XCTAssertEqual(
            try XCTUnwrap(state.panes[paneID]).headerDescription,
            "codex · gpt-5.4 · idle · ctx 12%")
    }

    func testContextOnlyFeedChangeRerendersHeader() throws {
        let state = ProjectState(projectID: "proj", displayName: "hive")
        let paneID = ProjectState.paneID(forAgent: "reviewer")
        state.apply(feed: [agent("reviewer", contextPct: 12)], now: 1)

        let changes = state.apply(feed: [agent("reviewer", contextPct: 63)], now: 2)

        XCTAssertTrue(changes.contains(.statusChanged(paneID)))
        XCTAssertEqual(try XCTUnwrap(state.panes[paneID]).contextPct, 63)
        XCTAssertTrue(try XCTUnwrap(state.panes[paneID]).headerDescription.hasSuffix("ctx 63%"))
    }

    func testStatusWordsMapToSemanticStatus() {
        let state = ProjectState(projectID: "proj", displayName: "hive")
        state.addOrchestrator()
        state.apply(feed: [
            agent("a", status: "spawning"),
            agent("b", status: "working"),
            agent("c", status: "idle"),
            agent("d", status: "awaiting-approval"),
            agent("e", status: "control-paused"),
            agent("f", status: "stuck"),
            agent("g", status: "done"),
            agent("h", status: "failed"),
            agent("i", status: "brand-new-status"),
        ], now: 1)
        func status(_ name: String) -> PaneStatus? {
            state.panes[ProjectState.paneID(forAgent: name)]?.status
        }
        XCTAssertEqual(status("a"), .running)
        XCTAssertEqual(status("b"), .running)
        XCTAssertEqual(status("c"), .running)
        XCTAssertEqual(status("d"), .waiting(.approval))
        XCTAssertEqual(status("e"), .waiting(.userInput))
        XCTAssertEqual(status("f"), .waiting(.userInput))
        XCTAssertEqual(status("g"), .completed(acknowledged: false))
        XCTAssertEqual(status("h"), .failed(acknowledged: false))
        XCTAssertEqual(status("i"), .unknown, "unknown words remain visibly unknown")
        XCTAssertEqual(state.panes[ProjectState.paneID(forAgent: "i")]?.feedStatus,
                       "brand-new-status", "raw word survives for the header")
    }

    func testDeadAgentWithoutPaneIsNeverInserted() {
        let state = ProjectState(projectID: "proj", displayName: "hive")
        state.addOrchestrator()
        state.apply(feed: [agent("ghost", status: "dead")], now: 1)
        XCTAssertNil(state.panes[ProjectState.paneID(forAgent: "ghost")])
    }

    func testClosedAtMarksClosePendingExactlyOnce() {
        let state = drivenState()
        let paneID = ProjectState.paneID(forAgent: "indexer")
        let first = state.apply(feed: [
            agent("indexer", closedAt: "2026-07-10T00:00:00Z"),
            agent("migrator", status: "awaiting-approval"),
            agent("flaky-e2e", status: "failed"),
        ], now: 2)
        XCTAssertTrue(first.contains(.paneClosePending(paneID)))
        XCTAssertEqual(state.panes[paneID]?.closePending, true, "pane lingers through the grace window")
        let second = state.apply(feed: [
            agent("indexer", closedAt: "2026-07-10T00:00:00Z"),
            agent("migrator", status: "awaiting-approval"),
            agent("flaky-e2e", status: "failed"),
        ], now: 3)
        XCTAssertFalse(second.contains(.paneClosePending(paneID)), "pending close fires once")
    }

    func testAgentVanishingFromSnapshotIsTreatedAsClosed() {
        let state = drivenState()
        let changes = state.apply(feed: [
            agent("migrator", status: "awaiting-approval"),
            agent("flaky-e2e", status: "failed"),
        ], now: 2)
        XCTAssertTrue(changes.contains(.paneClosePending(ProjectState.paneID(forAgent: "indexer"))))
    }

    func testClosedAgentNeverGetsAPane() {
        let state = ProjectState(projectID: "proj", displayName: "hive")
        state.addOrchestrator()
        state.apply(feed: [agent("old", closedAt: "2026-07-01T00:00:00Z")], now: 1)
        XCTAssertNil(state.panes[ProjectState.paneID(forAgent: "old")])
    }

    func testAttentionOrderedBySeverityNotPanePosition() {
        let state = drivenState()
        let ordered = state.attention.ordered
        XCTAssertFalse(ordered.isEmpty)
        XCTAssertEqual(ordered.first?.severity, .failed, "failure outranks everything")
        let severities = ordered.map(\.severity.rawValue)
        XCTAssertEqual(severities, severities.sorted(by: >))
    }

    func testFocusAloneNeverClearsAttention() {
        let state = drivenState()
        let before = state.attention.ordered
        state.apply(.focusPane(ProjectState.paneID(forAgent: "migrator")))
        state.apply(.moveFocus(.left))
        state.apply(.focusOrchestrator)
        XCTAssertEqual(state.attention.ordered, before, "focus commands must not touch the queue")
    }

    func testStatusTransitionResolvesStaleAttention() {
        let state = drivenState()
        let migrator = ProjectState.paneID(forAgent: "migrator")
        XCTAssertTrue(state.attention.ordered.contains { $0.paneID == migrator })
        state.apply(feed: [
            agent("indexer"),
            agent("migrator", status: "working"),
            agent("flaky-e2e", status: "failed"),
        ], now: 2)
        XCTAssertFalse(state.attention.ordered.contains { $0.paneID == migrator },
                       "approval resolved in the TUI clears the amber item on the next snapshot")
        XCTAssertEqual(state.panes[migrator]?.status, .running)
    }

    func testAcknowledgeSurvivesIdenticalSnapshots() {
        let state = drivenState()
        let failed = ProjectState.paneID(forAgent: "flaky-e2e")
        state.apply(.acknowledgePane(failed))
        XCTAssertEqual(state.panes[failed]?.status, .failed(acknowledged: true))
        XCTAssertNil(state.attention.ordered.first { $0.paneID == failed })
        // The daemon keeps reporting "failed"; acknowledgement must not reset.
        state.apply(feed: [
            agent("indexer"),
            agent("migrator", status: "awaiting-approval"),
            agent("flaky-e2e", status: "failed"),
        ], now: 5)
        XCTAssertEqual(state.panes[failed]?.status, .failed(acknowledged: true))
        XCTAssertNil(state.attention.ordered.first { $0.paneID == failed })
    }

    func testPaneCreationNeverStealsFocus() {
        let state = ProjectState(projectID: "proj", displayName: "hive")
        var focusChanges: [PaneID?] = []
        for change in state.addOrchestrator() {
            if case .focusChanged(let pane) = change { focusChanges.append(pane) }
        }
        for change in state.apply(feed: [agent("one"), agent("two")], now: 1) {
            if case .focusChanged(let pane) = change { focusChanges.append(pane) }
        }
        XCTAssertEqual(focusChanges, [ProjectState.orchestratorPaneID],
                       "only the very first pane of an empty workspace takes focus")
    }

    func testPromoteAndReturnOrchestrator() {
        let state = drivenState()
        let migrator = ProjectState.paneID(forAgent: "migrator")
        let originalLayout = state.layout
        state.apply(.promotePane(migrator))
        XCTAssertEqual(state.layout.master, migrator)
        state.apply(.returnOrchestratorToMaster)
        XCTAssertEqual(state.layout.master, ProjectState.orchestratorPaneID)
        XCTAssertEqual(state.layout, originalLayout, "satellite order preserved through the round trip")
    }

    func testClosePaneReturnsFocusToMasterAndClearsItsAttention() {
        let state = drivenState()
        let failed = ProjectState.paneID(forAgent: "flaky-e2e")
        state.apply(.focusPane(failed))
        state.apply(.closePane(failed))
        XCTAssertNil(state.panes[failed])
        XCTAssertEqual(state.focusedPane, state.layout.master)
        XCTAssertNil(state.attention.ordered.first { $0.paneID == failed })
    }

    /// The orchestrator used to be EXEMPT from feed loss, on the grounds that its
    /// terminal is not feed-driven. That was right only while its status was a
    /// hardcoded constant: a constant cannot go stale, so a dead feed invalidated
    /// nothing. Its status is now measured from the root's turn boundaries, so a
    /// dead feed makes it exactly as untrustworthy as any agent's — the root may
    /// have started or finished any number of turns since the last line we read.
    /// It goes disconnected/unknown with the rest. The terminal stays attached;
    /// what we lost is our knowledge of the root, not the root.
    func testMarkFeedLostTurnsEveryPaneGrayIncludingTheOrchestrator() {
        let state = drivenState()
        state.markFeedLost()
        for (paneID, pane) in state.panes {
            if case .disconnected = pane.status {} else {
                XCTFail("\(paneID) should be disconnected after feed loss")
            }
            XCTAssertEqual(pane.feedStatus, "unknown",
                           "\(paneID) must not keep a stale status word")
        }
    }

    func testSwitcherCardIsSanitized() {
        let state = drivenState()
        let card = state.switcherCard
        XCTAssertEqual(card.displayName, "hive")
        XCTAssertEqual(card.paneCount, 4)
        XCTAssertEqual(card.failedCount, 1)
        XCTAssertGreaterThanOrEqual(card.waitingCount, 1)
        // Card carries counts and names only — the type has no terminal content.
    }

    // MARK: Feed line decoding (the NDJSON contract)

    func testFeedLineDecodesContractShape() throws {
        let line = """
        {"v":1,"agents":[{"name":"idx","tool":"codex","model":"gpt-5.4","status":"working","taskDescription":"index","tmuxSession":"hive-idx","contextPct":41.5,"futureField":{"nested":true}}]}
        """
        let decoded = try XCTUnwrap(FeedLine.parse(line))
        XCTAssertEqual(decoded.v, 1)
        let agent = try XCTUnwrap(decoded.agents?.first)
        XCTAssertEqual(agent.name, "idx")
        XCTAssertEqual(agent.tool, "codex")
        XCTAssertEqual(agent.tmuxSession, "hive-idx")
        XCTAssertEqual(agent.contextPct, 41.5)
        XCTAssertNil(agent.closedAt)
        XCTAssertEqual(agent.status, "working")
        XCTAssertEqual(FeedStatusMap.paneStatus(for: agent.status), .running)
    }

    func testMissingAndWrongTypedAgentStatusStayUnknown() throws {
        let missing = try XCTUnwrap(FeedLine.parse(#"{"v":1,"agents":[{"name":"missing"}]}"#))
        let wrongType = try XCTUnwrap(FeedLine.parse(#"{"v":1,"agents":[{"name":"wrong","status":17}]}"#))

        for snapshot in [missing, wrongType] {
            let agent = try XCTUnwrap(snapshot.agents?.first)
            XCTAssertEqual(agent.status, "unknown")
            XCTAssertEqual(FeedStatusMap.paneStatus(for: agent.status), .unknown)
            XCTAssertNotEqual(FeedStatusMap.paneStatus(for: agent.status), .running)
        }
    }

    func testFeedLineDecodesErrorAndToleratesGarbage() throws {
        let error = try XCTUnwrap(FeedLine.parse(#"{"v":1,"error":"daemon unreachable"}"#))
        XCTAssertEqual(error.error, "daemon unreachable")
        XCTAssertNil(FeedLine.parse("not json"))
        XCTAssertNil(FeedLine.parse(""))
    }

    func testFeedLineKeepsAgentsWhenOptionalSiblingFieldsAreMalformed() throws {
        let line = #"{"v":1,"agents":[{"name":"good","status":"working"}],"autonomy":17,"orchestrator":{"status":17}}"#

        let decoded = try XCTUnwrap(FeedLine.parse(line))
        XCTAssertEqual(decoded.agents, [AgentSnapshot(name: "good")])
        XCTAssertNil(decoded.autonomy)
        XCTAssertNil(decoded.orchestrator)
    }

    func testFeedLineRejectsOnlyTheAgentFieldWhenAnyIdentityIsMalformed() throws {
        let line = #"{"v":1,"agents":[{"name":"good"},{"name":17}]}"#

        let decoded = try XCTUnwrap(FeedLine.parse(line))
        XCTAssertNil(decoded.agents, "a partial snapshot could falsely close the omitted agent")
    }
}
