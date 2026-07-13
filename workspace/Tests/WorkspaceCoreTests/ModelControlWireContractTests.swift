import Foundation
import XCTest
@testable import WorkspaceCore

final class ModelControlWireContractTests: XCTestCase {

    private func wireFixture() throws -> Data {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try Data(contentsOf: repoRoot
            .appendingPathComponent("test/fixtures/model-control-snapshot.json"))
    }

    func testDecodesTheSnapshotTheCLIEmitsToday() throws {
        let snapshot = try ModelControlSnapshot.decode(from: try wireFixture())

        XCTAssertEqual(snapshot.generatedAt, "2026-07-12T22:00:00.000Z")
        XCTAssertEqual(snapshot.usageSurfaces["grok"], .metered)

        guard case .available(let grokModels, _)? = snapshot.providers["grok"] else {
            return XCTFail("the Grok catalog must be available")
        }
        guard case .known(let supportsEffort, _, _) = grokModels[0].supportsEffort else {
            return XCTFail("Grok's supports-effort false must remain a known fact")
        }
        XCTAssertFalse(supportsEffort)

        guard case .unavailable(let reason)? = snapshot.providers["codex"] else {
            return XCTFail("the fixture's Codex catalog must be unavailable")
        }
        XCTAssertEqual(reason, "codex CLI not signed in")

        let claudeBilling = try XCTUnwrap(snapshot.billing["claude"] ?? nil)
        guard case .known(let creditsEnabled, _, _) = claudeBilling.creditsEnabled else {
            return XCTFail("Claude's disabled billing rail must remain a known fact")
        }
        XCTAssertFalse(creditsEnabled)

        let quota = try XCTUnwrap(snapshot.quota)
        guard case .pool(let claudePool) = quota[0] else {
            return XCTFail("the fixture must contain Claude's measured quota pool")
        }
        XCTAssertEqual(claudePool.fiveHour.used, 63)
        XCTAssertNil(claudePool.weekly.used)
        XCTAssertEqual(snapshot.tokenUsage?.generatedAt, snapshot.generatedAt)
    }
}
