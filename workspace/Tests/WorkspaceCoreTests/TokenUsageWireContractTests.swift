import XCTest
@testable import WorkspaceCore

/// Contract between the daemon's emitted token-usage snapshot and this app's
/// decoder. `Fixtures/token-usage-wire.json` is a document the daemon may
/// legitimately emit: it carries every subject role in `TOKEN_USAGE_ROLES`.
///
/// This file pins the raw evidence nested in the daemon-owned Workspace view.
/// Row grouping and headlines are not reconstructed here; the endpoint sends
/// those as `WorkspaceTokenSessionPresentation`.
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

    /// The whole raw document decodes without manufacturing presentation rows.
    func testDecodesTheSharedFixture() throws {
        let snapshot = try decodeSnapshot(try wireFixture())
        let session = try XCTUnwrap(snapshot.sessions.first)
        XCTAssertEqual(session.fleet.counts?.totalTokens, 1780)
        XCTAssertEqual(
            Set(session.subjects.map(\.name)), ["Orchestrator", "maya", "quinn"])
    }

    /// The null-cache-subset lesson: a Codex/Grok worker reports cache READS but
    /// not cache CREATION. Reads survive; creation is an honest nil; the whole
    /// bucket must not go null just because one subset is missing.
    func testWorkerBucketToleratesNullCacheCreation() throws {
        let snapshot = try decodeSnapshot(try wireFixture())
        let session = try XCTUnwrap(snapshot.sessions.first)
        let counts = try XCTUnwrap(session.workerSessions.counts)
        XCTAssertEqual(counts.totalTokens, 580)
        XCTAssertEqual(counts.cachedInputTokens, 300)
        XCTAssertNil(counts.cacheCreationInputTokens)
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
        let maya = try XCTUnwrap(decoded.subjects.first { $0.name == "maya" })
        XCTAssertEqual(maya.role, "reviewer")
        XCTAssertEqual(decoded.subjects.count, 3)
    }
}
