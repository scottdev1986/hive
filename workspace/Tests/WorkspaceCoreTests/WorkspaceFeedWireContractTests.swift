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
        XCTAssertEqual(agent.contextPct, 41.5)
        let dimensions = try XCTUnwrap(agent.statusDimensions)
        XCTAssertEqual(dimensions.revision, "6")
        XCTAssertEqual(agent.presentation.headerDetail, "runtime=ready · turn=working · input=empty · mail=none · health=healthy · attention=none")
        XCTAssertNil(agent.closedAt)
        XCTAssertEqual(agent.presentation.paneStatus.paneStatus(), .running)
        XCTAssertEqual(agent.presentation.renderedActivity, .working)
        XCTAssertEqual(decoded.autonomy, .current(value: "dangerous"))
        XCTAssertEqual(decoded.orchestrator?.status, "working")
        XCTAssertEqual(
            decoded.orchestrator?.presentation.renderedActivity, .working)
    }
}
