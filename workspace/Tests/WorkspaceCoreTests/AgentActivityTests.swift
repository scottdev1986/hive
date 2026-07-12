import XCTest
@testable import WorkspaceCore

final class AgentActivityTests: XCTestCase {

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
        XCTAssertEqual(FeedStatusMap.activity(for: "dead"), .unknown)
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
}
