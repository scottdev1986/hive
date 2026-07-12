import XCTest
@testable import WorkspaceCore

final class AgentActivityTests: XCTestCase {

    func testUnifiedLegendMapsEveryActivityToOneAppearance() {
        XCTAssertEqual(AgentActivity.working.appearance,
                       StatusAppearance(color: .green, symbol: "circle.fill", border: .solid))
        XCTAssertEqual(AgentActivity.idle.appearance,
                       StatusAppearance(color: .yellow, symbol: "pause.circle.fill", border: .solid))
        XCTAssertEqual(AgentActivity.spawning.appearance,
                       StatusAppearance(color: .blue, symbol: "circle.dotted", border: .solid))
        XCTAssertEqual(AgentActivity.needsUser.appearance,
                       StatusAppearance(color: .orange, symbol: "hand.raised.fill", border: .solid))
        XCTAssertEqual(AgentActivity.done.appearance,
                       StatusAppearance(color: .purple, symbol: "checkmark.circle.fill", border: .solid))
        XCTAssertEqual(AgentActivity.failed.appearance,
                       StatusAppearance(color: .red, symbol: "exclamationmark.circle.fill", border: .solid))
        XCTAssertEqual(AgentActivity.disconnected.appearance,
                       StatusAppearance(color: .gray, symbol: "bolt.horizontal.circle.fill", border: .dashed))
        XCTAssertEqual(AgentActivity.unknown.appearance,
                       StatusAppearance(color: .gray, symbol: "questionmark.circle", border: .dashed))
        XCTAssertEqual(AttentionSeverity.waiting.statusColor, .orange)
        XCTAssertEqual(AttentionSeverity.completed.statusColor, .purple)
        XCTAssertEqual(AttentionSeverity.failed.statusColor, .red)
        XCTAssertEqual(AttentionSeverity.disconnected.statusColor, .gray)
    }

    func testUnrecognizedStatusIsUnknownAndNeverHealthy() {
        let raw = "some-future-status"
        XCTAssertEqual(FeedStatusMap.paneStatus(for: raw), .unknown)
        XCTAssertEqual(FeedStatusMap.activity(for: raw), .unknown)
        XCTAssertNotEqual(FeedStatusMap.activity(for: raw).appearance,
                          AgentActivity.working.appearance)
    }

    func testFeedLossKeepsDisconnectedAppearance() {
        let status = PaneStatus.disconnected(reason: "feed lost", lastConfirmed: "working")
        XCTAssertEqual(FeedStatusMap.activity(for: "unknown", paneStatus: status), .disconnected)
        XCTAssertNotEqual(FeedStatusMap.activity(for: "unknown", paneStatus: status), .unknown)
    }

    func testDaemonVocabularyMapsToActivity() {
        XCTAssertEqual(FeedStatusMap.activity(for: "working"), .working)
        XCTAssertEqual(FeedStatusMap.activity(for: "idle"), .idle)
        XCTAssertEqual(FeedStatusMap.activity(for: "spawning"), .spawning)
        XCTAssertEqual(FeedStatusMap.activity(for: "done"), .done)
        XCTAssertEqual(FeedStatusMap.activity(for: "failed"), .failed)
    }

    /// Red is only ever a measured blocked-on-human state: a pending approval
    /// (awaiting-approval) or a genuine human-input block (control-paused,
    /// stuck). Nothing else may produce it.
    func testNeedsUserComesOnlyFromMeasuredBlockedStates() {
        XCTAssertEqual(FeedStatusMap.activity(for: "awaiting-approval"), .needsUser)
        XCTAssertEqual(FeedStatusMap.activity(for: "control-paused"), .needsUser)
        XCTAssertEqual(FeedStatusMap.activity(for: "stuck"), .needsUser)
        // Idle correlates with-but-never-means needing a human.
        XCTAssertNotEqual(FeedStatusMap.activity(for: "idle"), .needsUser)
        XCTAssertNotEqual(FeedStatusMap.activity(for: "done"), .needsUser)
    }

    /// An unrecognized or absent status word must render as unknown — never
    /// impersonate working, idle, or (worst) needs-user.
    func testUnknownWordsDegradeToUnknownNotAState() {
        XCTAssertEqual(FeedStatusMap.activity(for: "unknown"), .unknown)
        XCTAssertEqual(FeedStatusMap.activity(for: "dead"), .disconnected)
        XCTAssertEqual(FeedStatusMap.activity(for: ""), .unknown)
        XCTAssertEqual(FeedStatusMap.activity(for: "some-future-status"), .unknown)
    }

    /// The feed-lost path rewrites feedStatus to "unknown", so a dead feed
    /// turns every agent dot gray rather than freezing a stale colour.
    func testFeedLossTurnsDotUnknown() {
        let state = ProjectState(projectID: ProjectID("p"), displayName: "p")
        state.apply(feed: [AgentSnapshot(name: "alfie", status: "working")], now: 0)
        state.markFeedLost()
        let pane = state.panes[ProjectState.paneID(forAgent: "alfie")]!
        XCTAssertEqual(FeedStatusMap.activity(for: pane.feedStatus), .unknown)
    }

    // MARK: The orchestrator's dot

    private func orchestratorPane(in state: ProjectState) -> PaneState {
        state.panes[ProjectState.orchestratorPaneID]!
    }

    /// The bug this fix exists for: the pane was seeded with the invented word
    /// "running", which is in no daemon vocabulary, so the dot degraded it to
    /// unknown and the root — alive by definition — was gray forever. The seed
    /// must now be an honest "unknown", and no status word may be fabricated.
    func testOrchestratorIsSeededUnknownNotAFabricatedWord() {
        let state = ProjectState(projectID: ProjectID("p"), displayName: "p")
        state.addOrchestrator()
        let pane = orchestratorPane(in: state)
        XCTAssertEqual(pane.feedStatus, "unknown")
        XCTAssertNotEqual(pane.feedStatus, "running")
        // Honest, and honestly gray: nothing has been measured yet.
        XCTAssertEqual(FeedStatusMap.activity(for: pane.feedStatus), .unknown)
    }

    /// A measured open turn: the root is working, and the dot goes green.
    func testOrchestratorWorkingFromFeed() {
        let state = ProjectState(projectID: ProjectID("p"), displayName: "p")
        state.addOrchestrator()
        state.apply(feed: [], orchestrator: OrchestratorSnapshot(status: "working"), now: 0)
        XCTAssertEqual(FeedStatusMap.activity(for: orchestratorPane(in: state).feedStatus), .working)
    }

    /// A measured closed turn: the root is idle (yellow), which is a real state
    /// and NOT the same as unknown (gray). That distinction is the whole point.
    func testOrchestratorIdleFromFeed() {
        let state = ProjectState(projectID: ProjectID("p"), displayName: "p")
        state.addOrchestrator()
        state.apply(feed: [], orchestrator: OrchestratorSnapshot(status: "idle"), now: 0)
        let activity = FeedStatusMap.activity(for: orchestratorPane(in: state).feedStatus)
        XCTAssertEqual(activity, .idle)
        XCTAssertNotEqual(activity, .unknown)
    }

    /// The daemon omits the field when it cannot honestly say (no turn events,
    /// or a self-contradicting record — the stale-hook case). The pane must fall
    /// BACK to unknown rather than keep the last word it heard: a lost signal
    /// must never become a confident stale claim.
    func testOrchestratorRevertsToUnknownWhenTheFieldIsAbsent() {
        let state = ProjectState(projectID: ProjectID("p"), displayName: "p")
        state.addOrchestrator()
        state.apply(feed: [], orchestrator: OrchestratorSnapshot(status: "working"), now: 0)
        XCTAssertEqual(FeedStatusMap.activity(for: orchestratorPane(in: state).feedStatus), .working)

        state.apply(feed: [], orchestrator: nil, now: 1)
        XCTAssertEqual(FeedStatusMap.activity(for: orchestratorPane(in: state).feedStatus), .unknown)
    }

    /// A dead feed invalidates the root's status exactly as it does an agent's.
    /// The pane used to be exempt, which was only ever right while its word was
    /// a constant — a constant cannot go stale. A measured one can.
    func testFeedLossTurnsTheOrchestratorDotUnknownToo() {
        let state = ProjectState(projectID: ProjectID("p"), displayName: "p")
        state.addOrchestrator()
        state.apply(feed: [], orchestrator: OrchestratorSnapshot(status: "working"), now: 0)
        state.markFeedLost()
        XCTAssertEqual(FeedStatusMap.activity(for: orchestratorPane(in: state).feedStatus), .unknown)
    }

    /// Red means a measured human block, and the root can never be in one: it IS
    /// the human's seat. No status the feed can carry for it may reach needsUser.
    func testOrchestratorCanNeverRenderNeedsUser() {
        for word in ["working", "idle", "unknown"] {
            XCTAssertNotEqual(FeedStatusMap.activity(for: word), .needsUser)
        }
    }
}
