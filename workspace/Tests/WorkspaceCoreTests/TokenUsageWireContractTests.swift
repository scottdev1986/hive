import XCTest
@testable import WorkspaceCore

/// THE CONTRACT between the daemon's emitted token-usage snapshot and this app's
/// decoder. `Fixtures/token-usage-wire.json` is a document the daemon may
/// legitimately emit today: it carries every subject role in `TOKEN_USAGE_ROLES`
/// (src/schemas/token-usage.ts). The daemon-side twin of this test
/// (src/schemas/token-usage.wire-contract.test.ts) proves the fixture is
/// schema-valid AND that it still covers every role — so a kind added on the
/// daemon side fails there and lands here before it can reach a user.
///
/// WHY THIS EXISTS: this app once threw on ONE unrecognised wire value, failed
/// the WHOLE document, and fell back to a blank/provisional screen while both
/// suites stayed green — because each side pinned its own fixture. Decoding must
/// degrade NARROWLY (an unknown value costs its own field, never the document),
/// and a role this build cannot name must stay VISIBLE, never folded into WORKERS.
final class TokenUsageWireContractTests: XCTestCase {

    private func wireFixture() throws -> Data {
        let url = try XCTUnwrap(
            Bundle.module.url(
                forResource: "token-usage-wire", withExtension: "json",
                subdirectory: "Fixtures"),
            "the wire fixture must ship with the test bundle")
        return try Data(contentsOf: url)
    }

    private func decodeSnapshot(_ data: Data) throws -> TokenUsageSnapshot {
        try JSONDecoder().decode(TokenUsageSnapshot.self, from: data)
    }

    /// The whole document decodes: the fleet aggregate reads, the orchestrator
    /// collapses into one row, and the two workers are listed.
    func testDecodesTheSharedFixture() throws {
        let snapshot = try decodeSnapshot(try wireFixture())
        let session = try XCTUnwrap(snapshot.sessions.first)
        XCTAssertEqual(session.fleet.counts?.totalTokens, 1780)
        let rows = session.usageRows
        XCTAssertTrue(rows.contains { $0.name == "Queen" })
        let workerRows = rows.filter { $0.name != "Queen" }
        XCTAssertEqual(
            Set(workerRows.map(\.name)), ["maya", "quinn"],
            "each worker is listed individually beside the collapsed orchestrator")
    }

    /// The null-cache-subset lesson: a Codex/Grok worker reports cache READS but
    /// not cache CREATION. Reads survive; creation is an honest nil; the whole
    /// bucket must not go null just because one subset is missing, and the
    /// headline still derives — from reads alone.
    func testWorkerBucketToleratesNullCacheCreation() throws {
        let snapshot = try decodeSnapshot(try wireFixture())
        let session = try XCTUnwrap(snapshot.sessions.first)
        let counts = try XCTUnwrap(session.workerSessions.counts)
        XCTAssertEqual(counts.totalTokens, 580)
        XCTAssertEqual(counts.cachedInputTokens, 300)
        XCTAssertNil(counts.cacheCreationInputTokens)
        XCTAssertEqual(counts.headline.newTokens, (500 - 300) + 80)
    }

    /// FORWARD COMPATIBILITY: a future daemon adds a role this build has never
    /// heard of. It must still DECODE (role is an open string), and the subject
    /// must stay VISIBLE — never crash, never silently vanish, and never be
    /// counted as a worker. This is what an OLD client does with a new kind.
    func testUnknownFutureRoleStaysVisibleAndOutOfWorkers() throws {
        var json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: try wireFixture()) as? [String: Any])
        var sessions = try XCTUnwrap(json["sessions"] as? [[String: Any]])
        var session = sessions[0]
        var subjects = try XCTUnwrap(session["subjects"] as? [[String: Any]])
        // Re-label the measured worker "maya" as a role this build cannot name.
        subjects = subjects.map { subject in
            guard (subject["name"] as? String) == "maya" else { return subject }
            var updated = subject
            updated["role"] = "reviewer"
            return updated
        }
        session["subjects"] = subjects
        sessions[0] = session
        json["sessions"] = sessions

        let snapshot = try decodeSnapshot(
            try JSONSerialization.data(withJSONObject: json))
        let decoded = try XCTUnwrap(snapshot.sessions.first)
        // Did not crash, did not vanish: the unknown-role subject is still a row.
        XCTAssertTrue(
            decoded.usageRows.contains { $0.name == "maya" },
            "an unrenderable role must stay visible, not disappear")
        // And it is NOT in the worker partition — the drift the two-green-suites
        // lesson exists to stop. It lands in the neutral unclassified bucket
        // instead, while the genuine worker "quinn" stays a worker.
        XCTAssertFalse(
            decoded.workerSubjects.contains { $0.name == "maya" },
            "a role this build cannot name must never be counted as a worker")
        XCTAssertTrue(
            decoded.unclassifiedSubjects.contains { $0.name == "maya" },
            "the unknown role belongs to the neutral, still-visible bucket")
        XCTAssertTrue(
            decoded.workerSubjects.contains { $0.name == "quinn" },
            "a real worker is still partitioned as a worker")
    }
}
