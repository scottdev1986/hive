// QueenProviderScreenTests.swift
//
// The Swift half of the queen-provider wire contract, and the draft/observed
// split at its compare-and-set boundary.

import XCTest
@testable import WorkspaceCore

final class QueenProviderScreenTests: XCTestCase {

    private func corpus() throws -> [ClientProjection<QueenProviderProjection>] {
        let data = try Data(contentsOf: Bundle.module.url(
            forResource: "queen-provider-corpus", withExtension: "json",
            subdirectory: "Fixtures")!)
        return try JSONDecoder().decode(
            [ClientProjection<QueenProviderProjection>].self, from: data)
    }

    private func projection(
        _ availability: ProjectionAvailability = .current
    ) throws -> QueenProviderProjection {
        try XCTUnwrap(corpus().first { $0.availability == availability }?.value)
    }

    // MARK: Wire

    func testEveryCorpusRowDecodesAndTheAbsentOnesCarryNoProjection() throws {
        let rows = try corpus()
        XCTAssertEqual(rows.count, ProjectionAvailability.allCases.count)
        for row in rows {
            switch row.availability {
            case .unknown, .unauthorized:
                XCTAssertNil(row.value, "\(row.availability) observed nothing to render")
            default:
                XCTAssertNotNil(row.value, "\(row.availability) keeps its last observation")
            }
        }
    }

    /// A revision past 2^53 is exactly where an Int-based decode stops being
    /// correct without stopping being green.
    func testARevisionWiderThanADoubleSurvivesAsWritten() throws {
        let current = try projection()
        XCTAssertEqual(current.change.revision, "18446744073709551615")
        // The same value through a Double comes back as something else, which
        // is why the revision is carried as a string end to end.
        let throughDouble = Double(current.change.revision)!
        XCTAssertNotEqual(String(format: "%.0f", throughDouble), current.change.revision)
    }

    /// `schemaVersion` is a compatibility gate: a document written under rules
    /// this build does not implement must refuse, not be guessed at.
    func testAnUnimplementedSchemaVersionRefusesToDecode() throws {
        let current = try projection()
        var raw = try JSONSerialization.jsonObject(
            with: try JSONEncoder().encode(current)) as! [String: Any]
        raw["schemaVersion"] = 2
        let data = try JSONSerialization.data(withJSONObject: raw)
        XCTAssertThrowsError(
            try JSONDecoder().decode(QueenProviderProjection.self, from: data),
            "a version this build cannot implement must fail closed")
    }

    /// The opposite rule, and deliberately so: a state a newer daemon learned
    /// must cost that row its reading, never the screen. Collapsing it into a
    /// known value would assert something false.
    func testAnUnnameableStateDecodesVerbatimAndIsNeverReadAsIdle() throws {
        let current = try projection()
        var raw = try JSONSerialization.jsonObject(
            with: try JSONEncoder().encode(current)) as! [String: Any]
        raw["health"] = "quiescing"
        var change = raw["change"] as! [String: Any]
        change["state"] = "handing-over"
        raw["change"] = change
        let decoded = try JSONDecoder().decode(
            QueenProviderProjection.self,
            from: try JSONSerialization.data(withJSONObject: raw))

        XCTAssertEqual(decoded.health, .unknown("quiescing"))
        XCTAssertEqual(decoded.change.state, .unknown("handing-over"))
        XCTAssertNotEqual(decoded.change.state, .idle, "an unknown change is not an idle one")
        XCTAssertEqual(decoded.healthDescription, "quiescing", "rendered verbatim")
    }

    func testProviderNativeQuestionAndDoneStatesUseQueenTUILabels() throws {
        let current = try projection()
        var raw = try JSONSerialization.jsonObject(
            with: try JSONEncoder().encode(current)) as! [String: Any]
        raw["health"] = "awaiting_answer"
        var decoded = try JSONDecoder().decode(
            QueenProviderProjection.self,
            from: try JSONSerialization.data(withJSONObject: raw))
        XCTAssertEqual(decoded.health, .awaitingAnswer)
        XCTAssertEqual(decoded.healthDescription, "Answer needed")

        raw["health"] = "done"
        decoded = try JSONDecoder().decode(
            QueenProviderProjection.self,
            from: try JSONSerialization.data(withJSONObject: raw))
        XCTAssertEqual(decoded.health, .done)
        XCTAssertEqual(decoded.healthDescription, "Done")
    }

    func testAContradictedRecordReportsTheContradictionRatherThanAHealth() throws {
        let stale = try projection(.stale)
        XCTAssertTrue(stale.contradicted)
        XCTAssertNil(stale.health)
        XCTAssertEqual(
            stale.healthDescription, "the root's own event record contradicts itself")
    }

    func testAnUnobservedRootReportsNoProviderRatherThanADefault() throws {
        let conflicting = try projection(.conflicting)
        XCTAssertNil(conflicting.liveProvider)
        XCTAssertEqual(conflicting.health, .exited)
    }

    func testEveryRowOffersEveryVendorSoNoKeyReadsAsAnUnknownVendor() throws {
        for row in try corpus() {
            guard let value = row.value else { continue }
            XCTAssertEqual(
                value.vendorIDs.map(\.rawValue).sorted(),
                ["claude", "codex", "grok", "kimi", "opencode"])
        }
    }

    // MARK: Editor

    func testASelectionIsOnlyADraftWhileItDiffersFromWhatIsRunning() throws {
        var editor = QueenProviderEditor(projection: try projection())
        XCTAssertFalse(editor.hasDraft)
        editor.select(ProviderID("codex"))
        XCTAssertTrue(editor.hasDraft)
        // Picking the live provider back is how a user abandons the change.
        editor.select(ProviderID("claude"))
        XCTAssertFalse(editor.hasDraft)
        XCTAssertNil(editor.body(), "there is nothing to send")
    }

    func testTheBodyComparesAgainstTheObservedRevision() throws {
        var editor = QueenProviderEditor(projection: try projection())
        editor.select(ProviderID("grok"))
        let body = try XCTUnwrap(editor.body())
        XCTAssertEqual(body.provider, "grok")
        // The observed revision reaches the compare-and-set unaltered, wide
        // enough that any numeric round trip on the way would show up here.
        XCTAssertEqual(body.expectedRevision, "18446744073709551615")
    }

    func testARefusedSwapKeepsTheSelectionAndNamesTheCompetingRevision() throws {
        var editor = QueenProviderEditor(projection: try projection())
        editor.select(ProviderID("codex"))

        var competing = try projection()
        competing.change = QueenProviderChange(
            state: .idle, revision: "9", failure: nil)
        competing.liveProvider = ProviderID("grok")
        editor.apply(try MutationResult(
            intentID: "swap-1", operationID: "conflict.swap-1",
            postStateToken: .revision("9"),
            outcome: .rejected(MutationFailure(
                code: "revision-conflict", message: "another change reached the Queen first")),
            observedPostState: competing))

        XCTAssertEqual(editor.draft, ProviderID("codex"), "the user's choice survives")
        XCTAssertTrue(editor.hasDraft)
        XCTAssertEqual(editor.competingRevision, "9")
        XCTAssertEqual(editor.observed.liveProvider, ProviderID("grok"), "the daemon is observed")
        XCTAssertEqual(editor.body()?.expectedRevision, "9", "the retry compares against the new one")
    }

    func testANonCurrentReadOffersNoSwap() throws {
        var editor = QueenProviderEditor(
            projection: try projection(.stale), availability: .stale)
        editor.select(ProviderID("codex"))
        XCTAssertNil(editor.body(), "a stale read has no revision worth comparing")
    }

    func testAFenceStopsSwapsWithoutDiscardingTheSelection() throws {
        var editor = QueenProviderEditor(projection: try projection())
        editor.select(ProviderID("codex"))
        editor.fence()
        XCTAssertEqual(editor.draft, ProviderID("codex"))
        XCTAssertNil(editor.body())
    }

    func testARefreshKeepsAnUnsentSelectionAndLiftsTheFence() throws {
        var editor = QueenProviderEditor(projection: try projection())
        editor.select(ProviderID("codex"))
        editor.fence()

        var moved = try projection()
        moved.change = QueenProviderChange(state: .pending, revision: "8", failure: nil)
        editor.observe(QueenProviderEditor(projection: moved, availability: .current))

        XCTAssertEqual(editor.draft, ProviderID("codex"), "the poll must not cost the choice")
        XCTAssertTrue(editor.mutationsAllowed)
        XCTAssertEqual(editor.observed.change.revision, "8")
        XCTAssertEqual(editor.body()?.expectedRevision, "8")
    }

    func testALiveObservationReplacesAFailedLatch() throws {
        var failed = try projection()
        failed.change = QueenProviderChange(
            state: .failed, revision: "1",
            failure: "ORCHESTRATOR_LAUNCH_FAILED: Hive bundled terminfo not found")
        var editor = QueenProviderEditor(projection: failed)
        var live = try projection()
        live.liveProvider = ProviderID("claude")
        live.change = QueenProviderChange(state: .idle, revision: "1", failure: nil)
        editor.observe(QueenProviderEditor(projection: live))
        XCTAssertEqual(editor.observed.change.state, .idle)
        XCTAssertNil(editor.observed.change.failure)
        XCTAssertEqual(editor.observed.liveProvider, ProviderID("claude"))
    }
}
