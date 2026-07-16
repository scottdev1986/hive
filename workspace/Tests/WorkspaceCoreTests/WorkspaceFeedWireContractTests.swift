import Foundation
import XCTest
@testable import WorkspaceCore

final class WorkspaceFeedWireContractTests: XCTestCase {

    private func wireFixture() throws -> String {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let data = try Data(contentsOf: repoRoot
            .appendingPathComponent("test/fixtures/workspace-feed-snapshot.json"))
        return try XCTUnwrap(String(data: data, encoding: .utf8))
    }

    func testDecodesTheSnapshotTheCLIEmitsToday() throws {
        let decoded = try XCTUnwrap(FeedLine.parse(try wireFixture()))

        XCTAssertEqual(decoded.v, 1)
        let agent = try XCTUnwrap(decoded.agents?.first)
        XCTAssertEqual(agent.id, "agent-indexer")
        XCTAssertEqual(agent.name, "indexer")
        XCTAssertEqual(agent.tool, "codex")
        XCTAssertEqual(agent.model, "gpt-5.4")
        XCTAssertEqual(agent.status, "working")
        XCTAssertEqual(agent.taskDescription, "Index the repository")
        XCTAssertEqual(agent.tmuxSession, "hive-indexer")
        XCTAssertEqual(agent.contextPct, 41.5)
        XCTAssertNil(agent.closedAt)
        XCTAssertEqual(FeedStatusMap.paneStatus(for: agent.status), .running)
        XCTAssertEqual(decoded.autonomy, "dangerous")
        XCTAssertEqual(decoded.orchestrator?.status, "working")
    }

    func testDecodesExactAttachmentAndSeparateLaunchObservedIdentity() throws {
        let line = #"{"v":1,"agents":[{"id":"uuid-1","name":"same-name","tool":"codex","model":"requested-fallback","liveModel":"observed-compat","liveEffort":"low","executionIdentity":{"tool":"codex","model":"gpt-launch","effort":"high"},"observedIdentity":{"model":"gpt-observed","effort":"medium","source":"codex-rollout","observedAt":"2026-07-16T00:00:00.000Z"},"identityState":"drift","status":"working","tmuxSession":"hive-same-instance","toolSessionId":"tool-session-1","processIncarnation":7,"writeRevoked":true}] }"#

        let decoded = try XCTUnwrap(FeedLine.parse(line))
        let agent = try XCTUnwrap(decoded.agents?.first)

        XCTAssertEqual(agent.id, "uuid-1")
        XCTAssertEqual(agent.launchModel, "gpt-launch")
        XCTAssertEqual(agent.launchEffort, "high")
        XCTAssertEqual(agent.observedModel, "gpt-observed")
        XCTAssertEqual(agent.observedEffort, "medium")
        XCTAssertEqual(agent.identityState, "drift")
        XCTAssertEqual(agent.toolSessionID, "tool-session-1")
        XCTAssertEqual(agent.processIncarnation, 7)
        XCTAssertEqual(agent.writeRevoked, true)
    }

    // The shared fixture is a real Codex wire row: no toolSessionId, identity
    // "unknown". Pane viewing must bind from it anyway; only authoring blocks.
    func testCodexRowWithoutToolSessionStillYieldsAPaneAttachment() throws {
        let decoded = try XCTUnwrap(FeedLine.parse(try wireFixture()))
        let agent = try XCTUnwrap(decoded.agents?.first)

        XCTAssertEqual(agent.tool, "codex")
        XCTAssertNil(agent.toolSessionID)
        XCTAssertEqual(agent.identityState, "unknown")
        XCTAssertEqual(agent.status, "working")

        let workspace = WorkspaceInstanceIdentity(
            instanceID: "instance-a", instanceHome: "/tmp/hive-a",
            daemonPort: 4317, tmuxSocket: "hive-a")
        let attachment = try XCTUnwrap(agent.attachmentIdentity(in: workspace))
        XCTAssertEqual(attachment.tmuxSession, "hive-indexer")
        XCTAssertEqual(attachment.processIncarnation, 1)

        XCTAssertEqual(
            agent.authoringBlocker(attachmentAvailable: true), .unknownIdentity)
    }

    func testMissingOrMalformedLoadBearingAgentIDRejectsOnlyTheSnapshot() throws {
        for line in [
            #"{"v":1,"agents":[{"name":"missing"}],"autonomy":"dangerous"}"#,
            #"{"v":1,"agents":[{"id":17,"name":"wrong"}],"autonomy":"dangerous"}"#,
        ] {
            let decoded = try XCTUnwrap(FeedLine.parse(line))
            XCTAssertNil(decoded.agents)
            XCTAssertEqual(decoded.autonomy, "dangerous")
        }
    }
}
