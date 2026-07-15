import XCTest
@testable import WorkspaceCore

/// THE CONTRACT between the daemon's emitted token-usage snapshot and this app's
/// decoder. `Fixtures/token-usage-wire.json` is a document the daemon may
/// legitimately emit today: it carries every subject role in `TOKEN_USAGE_ROLES`
/// (src/schemas/token-usage.ts), including the profiler. The daemon-side twin of
/// this test (src/schemas/token-usage.wire-contract.test.ts) proves the fixture
/// is schema-valid AND that it still covers every role — so a kind added on the
/// daemon side fails there and lands here before it can reach a user.
///
/// WHY THIS EXISTS: this app once threw on ONE unrecognised wire value, failed
/// the WHOLE document, and fell back to a blank/provisional screen while both
/// suites stayed green — because each side pinned its own fixture. Decoding must
/// degrade NARROWLY (an unknown value costs its own field, never the document),
/// and a profiler must be presented as its own thing, never folded into WORKERS.
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

    /// The regression: the daemon's real snapshot carries a profilingSessions
    /// bucket, and this app must READ it — not throw on the unfamiliar key.
    func testDecodesTheProfilingBucketTheDaemonEmitsToday() throws {
        let snapshot = try decodeSnapshot(try wireFixture())
        let session = try XCTUnwrap(snapshot.sessions.first)

        let profiling = try XCTUnwrap(
            session.profilingSessions, "profilingSessions must decode")
        XCTAssertEqual(profiling.subjectCount, 1)
        let counts = try XCTUnwrap(profiling.counts)
        XCTAssertEqual(counts.totalTokens, 460)
        XCTAssertEqual(counts.outputTokens, 60)
        // The null-cache-subset lesson: a Codex/Grok profiler reports cache READS
        // but not cache CREATION. Reads survive; creation is an honest nil; the
        // whole bucket must not go null just because one subset is missing.
        XCTAssertEqual(counts.cachedInputTokens, 250)
        XCTAssertNil(counts.cacheCreationInputTokens)
        // And the headline still derives — from reads alone.
        XCTAssertEqual(counts.headline.newTokens, (400 - 250) + 60)
    }

    /// A profiler is presented in its OWN row, from profilingSessions, and never
    /// among the worker rows. This is the acceptance the package exists to meet.
    func testProfilerIsPresentedOutsideWorkers() throws {
        let snapshot = try decodeSnapshot(try wireFixture())
        let session = try XCTUnwrap(snapshot.sessions.first)
        let rows = session.usageRows

        let profilingRow = try XCTUnwrap(
            rows.first { $0.name == "Profiling" },
            "a dedicated Profiling row must be rendered from profilingSessions")
        XCTAssertEqual(profilingRow.provider, "codex")
        XCTAssertEqual(profilingRow.counts?.totalTokens, 460)

        // The worker rows are exactly the two workers (one measured, one
        // unknown) — never the profiler, and never the orchestrator.
        let workerRows = rows.filter { $0.name != "Orchestrator" && $0.name != "Profiling" }
        XCTAssertEqual(
            Set(workerRows.map(\.name)), ["maya", "quinn"],
            "the profiler must never fall through into WORKERS")
        let profiler = try XCTUnwrap(session.subjects.first { $0.role == "profiler" })
        XCTAssertFalse(
            workerRows.contains { $0.name == profiler.name },
            "the profiler subject must not appear as a worker row")
    }

    /// FORWARD COMPATIBILITY: a future daemon adds a role this build has never
    /// heard of. It must still DECODE (role is an open string), and the subject
    /// must stay VISIBLE — never crash, never silently vanish, and never be
    /// mistaken for a profiler. This is what an OLD client (this one, from a
    /// future role's view) does with a new kind.
    func testUnknownFutureRoleStaysVisibleAndIsNotAProfiler() throws {
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
        // It is not a profiler: the Profiling row still comes only from the real
        // profiler, whose count is unchanged.
        let profilingRow = try XCTUnwrap(decoded.usageRows.first { $0.name == "Profiling" })
        XCTAssertEqual(profilingRow.counts?.totalTokens, 460)
    }

    /// A daemon predating profiling attribution emits no profilingSessions bucket
    /// and no profiler subject. The document must still decode — one absent field
    /// must never blank the whole Usage screen.
    func testOlderDaemonWithoutProfilingStillDecodes() throws {
        var json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: try wireFixture()) as? [String: Any])
        var sessions = try XCTUnwrap(json["sessions"] as? [[String: Any]])
        var session = sessions[0]
        session.removeValue(forKey: "profilingSessions")
        let subjects = try XCTUnwrap(session["subjects"] as? [[String: Any]])
        session["subjects"] = subjects.filter { ($0["role"] as? String) != "profiler" }
        sessions[0] = session
        json["sessions"] = sessions

        let snapshot = try decodeSnapshot(
            try JSONSerialization.data(withJSONObject: json))
        let decoded = try XCTUnwrap(snapshot.sessions.first)
        XCTAssertNil(decoded.profilingSessions, "absent bucket reads as nil, not a crash")
        XCTAssertFalse(
            decoded.usageRows.contains { $0.name == "Profiling" },
            "no profiler subjects means no profiling row")
        // The rest of the document is intact and readable.
        XCTAssertTrue(decoded.usageRows.contains { $0.name == "Orchestrator" })
        XCTAssertEqual(decoded.fleet.counts?.totalTokens, 2240)
    }
}
