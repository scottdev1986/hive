import XCTest
import CoreGraphics
import HiveTerminalKit
@testable import WorkspaceCore

final class ProjectStateTests: XCTestCase {

    private func agent(_ name: String, status: String = "working",
                       tool: String = "claude", model: String = "opus",
                       task: String = "do things",
                       contextPct: Double = 12, closedAt: String? = nil) -> AgentSnapshot {
        let pane: FeedPanePresentation
        let activity: String
        let severity: String?
        switch status {
        case "spawning":
            pane = FeedPanePresentation(kind: "running")
            activity = "spawning"
            severity = nil
        case "working", "idle":
            pane = FeedPanePresentation(kind: "running")
            activity = status
            severity = nil
        case "awaiting-approval":
            pane = FeedPanePresentation(kind: "waiting", waitingKind: "approval")
            activity = "needs-user"
            severity = "waiting"
        case "control-paused", "stuck":
            pane = FeedPanePresentation(kind: "waiting", waitingKind: "userInput")
            activity = "needs-user"
            severity = "waiting"
        case "done":
            pane = FeedPanePresentation(kind: "completed")
            activity = "done"
            severity = "completed"
        case "failed":
            pane = FeedPanePresentation(kind: "failed")
            activity = "failed"
            severity = "failed"
        case "dead":
            pane = FeedPanePresentation(
                kind: "disconnected", reason: "process reported dead",
                lastConfirmed: "dead")
            activity = "disconnected"
            severity = "disconnected"
        default:
            pane = FeedPanePresentation(kind: "unknown")
            activity = "unknown"
            severity = nil
        }
        let attention = severity.map {
            FeedAttentionPresentation(
                id: "fixture-\(name)-\(status)", severity: $0,
                title: "\(name) \(status)", detail: task, raisedAt: 1)
        }
        let panePresence = closedAt != nil || status == "dead" ? "closed" : "visible"
        let terminalState: String
        switch status {
        case "spawning": terminalState = "pending"
        case "dead": terminalState = "exited"
        case "failed": terminalState = "failed"
        default: terminalState = "live"
        }
        return AgentSnapshot(
            name: name, tool: tool, model: model, status: status,
            taskDescription: task, contextPct: contextPct, closedAt: closedAt,
            presentation: AgentFeedPresentation(
                panePresence: panePresence,
                terminalState: terminalState,
                headerDetail: status,
                paneStatus: pane, activity: activity, attention: attention))
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
        ])
        return state
    }

    // Closing a pane never kills its agent, so the feed keeps listing that
    // agent as live for as long as it runs. A pane rebuilt from those
    // snapshots makes the close control look broken.
    func testUserClosedAgentIsNotRebuiltByAFeedThatStillListsItAsLive() {
        let state = drivenState()
        let paneID = ProjectState.paneID(forAgent: "indexer")

        let requested = state.markUserClosed(paneID)
        XCTAssertEqual(requested, [.statusChanged(paneID)])
        XCTAssertEqual(state.panes[paneID]?.closePending, true)

        // The agent runs on headless; the daemon still reports it as working.
        state.apply(feed: [agent("indexer"), agent("migrator"), agent("flaky-e2e")])
        XCTAssertEqual(state.panes[paneID]?.closePending, true,
                       "the user-closed pane is not rebuilt while the agent lives")

        // The agent later ends (exit, hive_kill): the daemon stops reporting
        // it, and the suppression is forgotten so a future agent of the same
        // name gets a pane again.
        let confirmed = state.apply(feed: [agent("migrator"), agent("flaky-e2e")])
        XCTAssertTrue(confirmed.contains(.paneClosePending(paneID)))
        state.apply(.closePane(paneID))
        state.apply(feed: [agent("indexer"), agent("migrator"), agent("flaky-e2e")])
        XCTAssertNotNil(state.panes[paneID], "a new agent by that name gets its pane")
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
    }

    func testAgentHeaderHasEachFieldOnceAndUsesLiveActivity() throws {
        let state = ProjectState(projectID: "proj", displayName: "hive")
        let paneID = ProjectState.paneID(forAgent: "reviewer")
        state.apply(feed: [
            agent("reviewer", status: "working", tool: "codex", model: "gpt-5.4",
                  task: "spawn-time assignment", contextPct: 12),
        ])

        XCTAssertEqual(
            try XCTUnwrap(state.panes[paneID]).headerDescription,
            "codex · gpt-5.4 · working · ctx 12%")

        let changes = state.apply(feed: [
            agent("reviewer", status: "idle", tool: "codex", model: "gpt-5.4",
                  task: "spawn-time assignment", contextPct: 12),
        ])
        XCTAssertTrue(changes.contains(.statusChanged(paneID)))
        XCTAssertEqual(
            try XCTUnwrap(state.panes[paneID]).headerDescription,
            "codex · gpt-5.4 · idle · ctx 12%")
    }

    func testContextOnlyFeedChangeRerendersHeader() throws {
        let state = ProjectState(projectID: "proj", displayName: "hive")
        let paneID = ProjectState.paneID(forAgent: "reviewer")
        state.apply(feed: [agent("reviewer", contextPct: 12)])

        let changes = state.apply(feed: [agent("reviewer", contextPct: 63)])

        XCTAssertTrue(changes.contains(.statusChanged(paneID)))
        XCTAssertEqual(try XCTUnwrap(state.panes[paneID]).contextPct, 63)
        XCTAssertTrue(try XCTUnwrap(state.panes[paneID]).headerDescription.hasSuffix("ctx 63%"))
    }

    func testLocatorOnlyChangeReattachesThePane() {
        let state = ProjectState(projectID: "proj", displayName: "hive")
        let paneID = ProjectState.paneID(forAgent: "reviewer")
        func snapshot(generation: Int) -> AgentSnapshot {
            AgentSnapshot(
                id: "agent-reviewer",
                name: "reviewer",
                tool: "codex",
                model: "gpt",
                status: "working",
                taskDescription: "review",
                contextPct: 12,
                sessionLocator: AgentSessionLocator(
                    instanceId: "instance",
                    subject: AgentSessionSubject(
                        kind: "agent", agentId: "agent-reviewer"),
                    generation: generation,
                    sessionId: "ses_\(generation)",
                    hostKind: "sessiond",
                    engineBuildId: "engine"))
        }
        state.apply(feed: [snapshot(generation: 1)])

        let changes = state.apply(feed: [snapshot(generation: 2)])

        XCTAssertTrue(changes.contains(.statusChanged(paneID)))
        XCTAssertEqual(state.panes[paneID]?.sessionLocator?.generation, 2)
    }

    func testDaemonPresentationMapsToSemanticStatus() {
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
        ])
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
        state.apply(feed: [agent("ghost", status: "dead")])
        XCTAssertNil(state.panes[ProjectState.paneID(forAgent: "ghost")])
    }

    func testClosedAtMarksClosePendingExactlyOnce() {
        let state = drivenState()
        let paneID = ProjectState.paneID(forAgent: "indexer")
        let first = state.apply(feed: [
            agent("indexer", closedAt: "2026-07-10T00:00:00Z"),
            agent("migrator", status: "awaiting-approval"),
            agent("flaky-e2e", status: "failed"),
        ])
        XCTAssertTrue(first.contains(.paneClosePending(paneID)))
        XCTAssertEqual(state.panes[paneID]?.closePending, true, "pane lingers through the grace window")
        let second = state.apply(feed: [
            agent("indexer", closedAt: "2026-07-10T00:00:00Z"),
            agent("migrator", status: "awaiting-approval"),
            agent("flaky-e2e", status: "failed"),
        ])
        XCTAssertFalse(second.contains(.paneClosePending(paneID)), "pending close fires once")
    }

    func testAgentVanishingFromSnapshotIsTreatedAsClosed() {
        let state = drivenState()
        let changes = state.apply(feed: [
            agent("migrator", status: "awaiting-approval"),
            agent("flaky-e2e", status: "failed"),
        ])
        XCTAssertTrue(changes.contains(.paneClosePending(ProjectState.paneID(forAgent: "indexer"))))
    }

    func testClosedAgentNeverGetsAPane() {
        let state = ProjectState(projectID: "proj", displayName: "hive")
        state.addOrchestrator()
        state.apply(feed: [agent("old", closedAt: "2026-07-01T00:00:00Z")])
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
        ])
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
        ])
        XCTAssertEqual(state.panes[failed]?.status, .failed(acknowledged: true))
        XCTAssertNil(state.attention.ordered.first { $0.paneID == failed })

        let failedPresentation = agent("flaky-e2e", status: "failed").presentation
        state.apply(feed: [
            agent("indexer"),
            agent("migrator", status: "awaiting-approval"),
            AgentSnapshot(
                name: "flaky-e2e", status: "vendor-future-word",
                taskDescription: "do things", contextPct: 12,
                presentation: failedPresentation),
        ])
        XCTAssertEqual(
            state.panes[failed]?.status,
            .failed(acknowledged: true),
            "a raw status-word change cannot override identical backend presentation")
        XCTAssertNil(state.attention.ordered.first { $0.paneID == failed })
    }

    func testPaneCreationNeverStealsFocus() {
        let state = ProjectState(projectID: "proj", displayName: "hive")
        var focusChanges: [PaneID?] = []
        for change in state.addOrchestrator() {
            if case .focusChanged(let pane) = change { focusChanges.append(pane) }
        }
        for change in state.apply(feed: [agent("one"), agent("two")]) {
            if case .focusChanged(let pane) = change { focusChanges.append(pane) }
        }
        XCTAssertEqual(focusChanges, [ProjectState.orchestratorPaneID],
                       "only the very first pane of an empty workspace takes focus")
    }

    func testVisibilityInventoryPublishesExactSessiondPaneLifecycle() throws {
        let state = ProjectState(projectID: "proj", displayName: "hive")
        let locator = AgentSessionLocator(
            instanceId: "instance",
            subject: AgentSessionSubject(kind: "agent", agentId: "agent-visible"),
            generation: 3,
            sessionId: "ses_visible",
            hostKind: "sessiond",
            engineBuildId: "engine")
        func snapshot(status: String, closedAt: String? = nil) -> AgentSnapshot {
            AgentSnapshot(
                id: "agent-visible",
                name: "visible",
                status: status,
                closedAt: closedAt,
                sessionLocator: locator,
                presentation: agent(
                    "visible", status: status, closedAt: closedAt).presentation)
        }

        state.apply(feed: [snapshot(status: "spawning")])
        XCTAssertEqual(state.visibilityInventory(), WorkspaceVisibilityInventory(
            inventoryRevision: "1",
            terminals: [WorkspaceVisibleTerminal(
                agentId: "agent-visible",
                agentName: "visible",
                locator: locator,
                state: .pending)]))
        let measured = TerminalGeometry(
            columns: 117, rows: 41, widthPx: 1170, heightPx: 820,
            cellWidthPx: 10, cellHeightPx: 20)
        XCTAssertEqual(
            state.visibilityInventory(geometries: [
                ProjectState.paneID(forAgent: "visible"): measured,
            ]).terminals.first?.geometry,
            measured)

        state.apply(feed: [snapshot(status: "working")])
        XCTAssertEqual(state.visibilityInventory().terminals.first?.state, .live)
        state.markFeedLost()
        XCTAssertEqual(state.visibilityInventory().terminals.first?.state, .reconnecting)
        state.markUserClosed(ProjectState.paneID(forAgent: "visible"))
        XCTAssertEqual(state.visibilityInventory().terminals.first?.state, .closing)
        state.apply(feed: [snapshot(
            status: "done",
            closedAt: "2026-07-18T12:00:00.000Z")])
        let closing = state.visibilityInventory()
        XCTAssertEqual(closing.inventoryRevision, "6")
        XCTAssertEqual(closing.terminals.first?.state, .closing)
    }

    func testRootLocatorPublishesVisibilityBeforeTurnStatusAndTracksGeneration() throws {
        let state = ProjectState(projectID: "proj", displayName: "hive")
        state.addOrchestrator()
        func locator(generation: Int) -> AgentSessionLocator {
            AgentSessionLocator(
                instanceId: "instance",
                subject: AgentSessionSubject(kind: "root"),
                generation: generation,
                sessionId: "ses_0198a8f0-0000-7000-8000-00000000000\(generation)",
                hostKind: "sessiond",
                engineBuildId: "engine")
        }
        func rootPresentation(activity: String, terminalState: String) -> AgentFeedPresentation {
            AgentFeedPresentation(
                panePresence: "visible",
                terminalState: terminalState,
                headerDetail: activity,
                paneStatus: FeedPanePresentation(
                    kind: activity == "unknown" ? "unknown" : "running"),
                activity: activity)
        }

        let first = locator(generation: 1)
        XCTAssertEqual(state.apply(
            feed: [],
            orchestrator: OrchestratorSnapshot(
                name: "queen",
                status: nil,
                host: "sessiond",
                hostState: "awaiting-visibility",
                sessionLocator: first,
                presentation: rootPresentation(
                    activity: "unknown", terminalState: "pending"))),
            [.statusChanged(ProjectState.orchestratorPaneID)])
        XCTAssertEqual(state.visibilityInventory(), WorkspaceVisibilityInventory(
            inventoryRevision: "1",
            terminals: [WorkspaceVisibleTerminal(
                agentId: ProjectState.orchestratorVisibilityID,
                agentName: ProjectState.orchestratorRecipient,
                locator: first,
                state: .pending)]))

        state.apply(feed: [], orchestrator: OrchestratorSnapshot(
            name: "queen", status: "idle", host: "sessiond", hostState: "running",
            sessionLocator: first,
            presentation: rootPresentation(activity: "idle", terminalState: "live")))
        XCTAssertEqual(state.visibilityInventory().terminals.first?.state, .live)

        let second = locator(generation: 2)
        state.apply(feed: [], orchestrator: OrchestratorSnapshot(
            name: "queen", status: "idle", host: "sessiond", hostState: "running",
            sessionLocator: second,
            presentation: rootPresentation(activity: "idle", terminalState: "live")))
        XCTAssertEqual(
            state.panes[ProjectState.orchestratorPaneID]?.sessionLocator,
            second,
            "a supervisor relaunch must replace the exact root generation")
        state.apply(feed: [], orchestrator: nil)
        XCTAssertEqual(state.panes[ProjectState.orchestratorPaneID]?.sessionLocator, second,
                       "unknown turn state is not evidence that the terminal vanished")
    }

    func testFailedRootHostIsFailureNotReconnect() {
        let state = ProjectState(projectID: "proj", displayName: "hive")
        state.addOrchestrator()
        let locator = AgentSessionLocator(
            instanceId: "instance",
            subject: AgentSessionSubject(kind: "root"),
            generation: 1,
            sessionId: "ses_failed",
            hostKind: "sessiond",
            engineBuildId: "engine")

        state.apply(feed: [], orchestrator: OrchestratorSnapshot(
            name: "queen",
            status: nil,
            host: "sessiond",
            hostState: "failed",
            hostDiagnostic: "native host registration failed",
            sessionLocator: locator,
            presentation: AgentFeedPresentation(
                panePresence: "visible",
                terminalState: "failed",
                headerDetail: "failed",
                paneStatus: FeedPanePresentation(kind: "failed"),
                activity: "failed")))

        let pane = state.panes[ProjectState.orchestratorPaneID]
        XCTAssertEqual(pane?.feedStatus, "unknown")
        XCTAssertEqual(pane?.status, .failed(acknowledged: false))
        XCTAssertEqual(pane?.terminalVisibilityState, .failed)
        XCTAssertEqual(state.visibilityInventory().terminals.first?.state, .failed)
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

    /// Feed loss turns every pane disconnected/unknown, including the
    /// orchestrator. Its status is measured from the root's turn boundaries, so
    /// a dead feed makes it as untrustworthy as any agent's — the root may have
    /// started or finished turns since the last line we read. The terminal stays
    /// attached; what we lost is our knowledge of the root, not the root.
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

    func testMissingAndWrongTypedAgentStatusStayUnknown() throws {
        let missing = try XCTUnwrap(FeedLine.parse(#"{"v":1,"agents":[{"name":"missing"}]}"#))
        let wrongType = try XCTUnwrap(FeedLine.parse(#"{"v":1,"agents":[{"name":"wrong","status":17}]}"#))

        for snapshot in [missing, wrongType] {
            let agent = try XCTUnwrap(snapshot.agents?.first)
            XCTAssertEqual(agent.status, "unknown")
            XCTAssertEqual(agent.presentation, .unknown)
        }
    }

    func testLiteralUnknownAgentStatusDecodesAndRendersVerbatim() throws {
        let line = #"{"v":1,"agents":[{"name":"reviewer","tool":"codex","model":"gpt","status":"unknown","contextPct":0}]}"#
        let snapshot = try XCTUnwrap(FeedLine.parse(line))
        let decoded = try XCTUnwrap(snapshot.agents?.first)
        XCTAssertEqual(decoded.status, "unknown")
        XCTAssertEqual(decoded.presentation.renderedActivity, .unknown)

        let state = ProjectState(projectID: "proj", displayName: "hive")
        state.apply(feed: [decoded])
        let pane = try XCTUnwrap(state.panes[ProjectState.paneID(forAgent: "reviewer")])
        XCTAssertEqual(pane.headerDescription, "codex · gpt · unknown · ctx 0%")
    }

    func testFeedLineDecodesErrorAndToleratesGarbage() throws {
        let error = try XCTUnwrap(FeedLine.parse(#"{"v":1,"error":"daemon unreachable"}"#))
        XCTAssertEqual(error.error, "daemon unreachable")
        XCTAssertNil(FeedLine.parse("not json"))
        XCTAssertNil(FeedLine.parse(""))
    }

    func testFeedLineKeepsAgentsWhenOptionalSiblingFieldsAreMalformed() throws {
        let line = #"{"v":1,"agents":[{"name":"good","status":"working"}],"autonomyState":17,"orchestrator":{"status":17}}"#

        let decoded = try XCTUnwrap(FeedLine.parse(line))
        XCTAssertEqual(decoded.agents, [AgentSnapshot(name: "good", status: "working")])
        guard case .malformed = decoded.autonomy else {
            return XCTFail("a malformed autonomy sibling must stay distinguishable")
        }
        XCTAssertNil(decoded.orchestrator)
    }

    func testFeedLineDecodesRootLocatorWithNullTurnStatus() throws {
        let line = #"{"v":1,"agents":[],"orchestrator":{"name":"queen","status":null,"host":"sessiond","hostState":"awaiting-visibility","sessionLocator":{"schemaVersion":1,"instanceId":"instance","subject":{"kind":"root"},"generation":1,"sessionId":"ses_0198a8f0-0000-7000-8000-000000000001","hostKind":"sessiond","engineBuildId":"engine"}}}"#

        let snapshot = try XCTUnwrap(FeedLine.parse(line)?.orchestrator)
        XCTAssertNil(snapshot.status)
        XCTAssertEqual(snapshot.host, "sessiond")
        XCTAssertEqual(snapshot.hostState, "awaiting-visibility")
        XCTAssertEqual(snapshot.sessionLocator?.subject, AgentSessionSubject(kind: "root"))
    }

    func testUnknownAutonomyDoesNotEnableKnownControls() throws {
        let line = #"{"v":1,"agents":[],"autonomyState":{"kind":"unsupported","value":"future-mode"}}"#

        let decoded = try XCTUnwrap(FeedLine.parse(line))

        XCTAssertEqual(decoded.autonomy, .unsupported(value: "future-mode"))
        XCTAssertNil(decoded.autonomy.confirmedValue)
    }

    func testAutonomyFaultStatesRemainDistinct() throws {
        let lines = [
            (#"{"v":1,"agents":[],"autonomyState":{"kind":"absent"}}"#,
             FeedAutonomyState.absent),
            (#"{"v":1,"agents":[],"autonomyState":{"kind":"refused","statusCode":403,"reason":"forbidden"}}"#,
             FeedAutonomyState.refused(statusCode: 403, reason: "forbidden")),
            (#"{"v":1,"agents":[],"autonomyState":{"kind":"malformed","reason":"missing autonomy"}}"#,
             FeedAutonomyState.malformed(reason: "missing autonomy")),
            (#"{"v":1,"agents":[],"autonomyState":{"kind":"unreachable","reason":"connection refused"}}"#,
             FeedAutonomyState.unreachable(reason: "connection refused")),
        ]

        for (line, expected) in lines {
            let decoded = try XCTUnwrap(FeedLine.parse(line))
            XCTAssertEqual(decoded.autonomy, expected)
            XCTAssertNil(decoded.autonomy.confirmedValue)
        }
    }

    func testConfirmedAutonomyIsTheOnlyStateWithAControlValue() throws {
        let line = #"{"v":1,"agents":[],"autonomyState":{"kind":"current","value":"sandboxed"}}"#
        let decoded = try XCTUnwrap(FeedLine.parse(line))

        XCTAssertEqual(decoded.autonomy, .current(value: "sandboxed"))
        XCTAssertEqual(decoded.autonomy.confirmedValue, "sandboxed")
    }

    func testFeedLineRejectsOnlyTheAgentFieldWhenAnyIdentityIsMalformed() throws {
        let line = #"{"v":1,"agents":[{"name":"good"},{"name":17}]}"#

        let decoded = try XCTUnwrap(FeedLine.parse(line))
        XCTAssertNil(decoded.agents, "a partial snapshot could falsely close the omitted agent")
    }

    func testMalformedPresentSessionLocatorSurfacesAsFeedContractError() throws {
        let line = #"{"v":1,"agents":[{"name":"worker","sessionLocator":{"schemaVersion":1,"instanceId":"instance","subject":{"kind":"agent","agentId":"agent-worker"},"generation":"wrong","sessionId":"ses_bad","hostKind":"sessiond","engineBuildId":"engine"}}]}"#

        let decoded = try XCTUnwrap(FeedLine.parse(line))

        XCTAssertNil(decoded.agents)
        XCTAssertTrue(try XCTUnwrap(decoded.error).contains("sessionLocator"))
    }

}
