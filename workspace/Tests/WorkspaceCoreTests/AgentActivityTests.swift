import XCTest
@testable import WorkspaceCore

final class AgentActivityTests: XCTestCase {
    private func presentation(
        paneKind: String = "running",
        activity: String,
        waitingKind: String? = nil
    ) -> AgentFeedPresentation {
        AgentFeedPresentation(
            panePresence: "visible",
            terminalState: paneKind == "failed" ? "failed" : "live",
            headerDetail: activity,
            paneStatus: FeedPanePresentation(
                kind: paneKind, waitingKind: waitingKind),
            activity: activity)
    }

    func testUnifiedLegendMapsEveryCanonicalActivityToOneAppearance() {
        XCTAssertEqual(AgentActivity.working.appearance,
                       StatusAppearance(color: .green, symbol: "circle.fill", border: .solid))
        XCTAssertEqual(AgentActivity.idle.appearance,
                       StatusAppearance(color: .yellow, symbol: "pause.circle.fill", border: .solid))
        XCTAssertEqual(AgentActivity.spawning.appearance,
                       StatusAppearance(color: .blue, symbol: "circle.dotted", border: .solid))
        XCTAssertEqual(AgentActivity.needsUser.appearance,
                       StatusAppearance(color: .orange, symbol: "hand.raised.fill", border: .solid))
        XCTAssertEqual(AgentActivity.held.appearance,
                       StatusAppearance(color: .teal, symbol: "hourglass.circle.fill", border: .solid))
        XCTAssertEqual(AgentActivity.done.appearance,
                       StatusAppearance(color: .purple, symbol: "checkmark.circle.fill", border: .solid))
        XCTAssertEqual(AgentActivity.failed.appearance,
                       StatusAppearance(color: .red, symbol: "exclamationmark.circle.fill", border: .solid))
        XCTAssertEqual(AgentActivity.disconnected.appearance,
                       StatusAppearance(color: .gray, symbol: "bolt.horizontal.circle.fill", border: .dashed))
        XCTAssertEqual(AgentActivity.unknown.appearance,
                       StatusAppearance(color: .gray, symbol: "questionmark.circle", border: .dashed))
    }

    func testSwiftRendersTheDaemonPresentationVocabulary() {
        let cases: [(String, AgentActivity)] = [
            ("working", .working), ("idle", .idle), ("needs-user", .needsUser),
            ("held", .held), ("spawning", .spawning), ("done", .done),
            ("failed", .failed), ("disconnected", .disconnected),
            ("vendor-future-state", .unknown),
        ]
        for (wire, expected) in cases {
            XCTAssertEqual(presentation(activity: wire).renderedActivity, expected)
        }
        XCTAssertEqual(
            presentation(paneKind: "waiting", activity: "needs-user",
                         waitingKind: "approval").paneStatus.paneStatus(),
            .waiting(.approval))
        XCTAssertEqual(
            presentation(paneKind: "waiting", activity: "needs-user",
                         waitingKind: "userInput").paneStatus.paneStatus(),
            .waiting(.userInput))
        XCTAssertEqual(
            presentation(paneKind: "vendor-future", activity: "unknown")
                .paneStatus.paneStatus(),
            .unknown)
    }

}
