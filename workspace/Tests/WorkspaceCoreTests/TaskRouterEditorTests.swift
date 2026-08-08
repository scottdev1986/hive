// TaskRouterEditorTests.swift
//
// Pins the draft/observed split at the routing compare-and-set boundary.

import XCTest
@testable import WorkspaceCore

final class TaskRouterEditorTests: XCTestCase {
    private func policy() throws -> RoutingPolicyDocument {
        let data = try Data(contentsOf: Bundle.module.url(
            forResource: "routing-policy-corpus", withExtension: "json",
            subdirectory: "Fixtures")!)
        let rows = try JSONDecoder().decode(
            [ClientProjection<RoutingPolicyDocument>].self, from: data)
        return try XCTUnwrap(rows.first { $0.availability == .current }?.value)
    }

    func testEditConcurrentPolicyChangeApplyRejectedPreservesDraftAndShowsCompetingRevision() throws {
        let initial = try policy()
        var editor = TaskRouterEditor(snapshot: TaskRouterSnapshot(policy: initial))
        let edited = RoutingPolicyDocument.WireRoute(
            mode: "user-weighted",
            candidates: [RoutingPolicyDocument.WireRouteCandidate(
                provider: "opencode", model: "openai/gpt-5.6-sol",
                effort: .exact("high"), weight: 60)])
        editor.setRoute(edited, for: .complexCoding)
        let draftBeforeApply = editor.draft

        var competing = initial
        competing.revision += 1
        let result = try MutationResult(
            intentID: "edit-1", operationID: "operation-conflict",
            postStateToken: .revision(String(competing.revision)),
            outcome: .rejected(MutationFailure(
                code: "revision-conflict", message: "policy changed")),
            observedPostState: competing)
        editor.apply(result)

        XCTAssertEqual(editor.draft, draftBeforeApply, "a conflict must not rewrite the draft")
        XCTAssertTrue(editor.hasDraft, "the rejected edit must remain available to retry")
        XCTAssertEqual(editor.competingRevision, competing.revision)
        XCTAssertEqual(editor.lastOperationID, "operation-conflict")
        XCTAssertEqual(editor.postStateToken, .revision(String(competing.revision)))
    }

    /// The fixture's `complex_coding` route with one candidate's weight moved.
    private func complexCoding(
        _ policy: RoutingPolicyDocument,
        weight: Int
    ) throws -> RoutingPolicyDocument.WireRoute {
        var route = try XCTUnwrap(policy.categories["complex_coding"])
        let index = try XCTUnwrap(route.candidates.firstIndex {
            $0.model == "claude-opus-4-8"
        })
        route.candidates[index].weight = weight
        return route
    }

    private func refreshed(
        _ policy: RoutingPolicyDocument,
        complexCodingWeight: Int
    ) throws -> TaskRouterEditor {
        var next = policy
        next.revision += 1
        next.categories["complex_coding"] = try complexCoding(policy, weight: complexCodingWeight)
        return TaskRouterEditor(snapshot: TaskRouterSnapshot(policy: next))
    }

    // MARK: Refresh reconciliation

    /// Both sides changed the same category. The daemon's value is what is
    /// OBSERVED and the user's stays an explicit unsent draft — neither is
    /// silently dropped, and the retry compares against the revision just read
    /// rather than the one the edit started from.
    func testRefreshKeepsBothSidesOfASameCategoryDivergence() throws {
        let initial = try policy()
        var editor = TaskRouterEditor(snapshot: TaskRouterSnapshot(policy: initial))
        editor.setRoute(try complexCoding(initial, weight: 40), for: .complexCoding)
        editor.observe(try refreshed(initial, complexCodingWeight: 55))

        XCTAssertEqual(
            editor.observed.policy.categories["complex_coding"]?.candidates
                .first { $0.model == "claude-opus-4-8" }?.weight,
            55,
            "the daemon's value is what is observed")
        XCTAssertEqual(
            editor.draft.policy.categories["complex_coding"]?.candidates
                .first { $0.model == "claude-opus-4-8" }?.weight,
            40,
            "the user's value stays their draft")
        XCTAssertTrue(editor.hasDraft)
        XCTAssertTrue(editor.mutationsAllowed, "a current read lifts the fence")

        let intent = try XCTUnwrap(editor.mutation(for: .complexCoding, intentID: "retry"))
        XCTAssertEqual(intent.body.expectedRevision, initial.revision + 1)
        XCTAssertEqual(intent.expected, .revision(String(initial.revision + 1)))
        XCTAssertEqual(intent.body.route, try complexCoding(initial, weight: 40))
    }

    /// The same divergence where the user's edit was a CLEAR. An absent draft
    /// category is an edit too, so the daemon reconfiguring it must not quietly
    /// restore what the user removed.
    func testRefreshKeepsAClearedCategoryClearedAgainstADaemonChange() throws {
        let initial = try policy()
        var editor = TaskRouterEditor(snapshot: TaskRouterSnapshot(policy: initial))
        editor.setRoute(nil, for: .complexCoding)
        editor.observe(try refreshed(initial, complexCodingWeight: 55))

        XCTAssertNotNil(
            editor.observed.policy.categories["complex_coding"],
            "the daemon still has the category, and that is what is observed")
        XCTAssertNil(
            editor.draft.policy.categories["complex_coding"],
            "the user's clear is still their draft")
        XCTAssertTrue(editor.hasDraft)

        let intent = try XCTUnwrap(editor.mutation(for: .complexCoding, intentID: "retry-clear"))
        XCTAssertEqual(intent.body.expectedRevision, initial.revision + 1)
        XCTAssertNil(intent.body.route, "the retry still clears")
    }

    /// The daemon caught up with the user. There is nothing left to send, and
    /// the editor says so rather than offering to re-send an identical route.
    func testRefreshResolvesADraftTheDaemonHasCaughtUpWith() throws {
        let initial = try policy()
        var editor = TaskRouterEditor(snapshot: TaskRouterSnapshot(policy: initial))
        editor.setRoute(try complexCoding(initial, weight: 40), for: .complexCoding)
        editor.observe(try refreshed(initial, complexCodingWeight: 40))

        XCTAssertEqual(editor.draft, editor.observed)
        XCTAssertFalse(editor.hasDraft, "an edit the daemon already holds is not unsent work")
        XCTAssertTrue(editor.mutationsAllowed)
    }

    func testStaleReadFencesMutation() throws {
        var editor = TaskRouterEditor(
            snapshot: TaskRouterSnapshot(policy: try policy()),
            availability: .stale)
        editor.setRoute(nil, for: .complexCoding)
        XCTAssertNil(editor.mutation(for: .complexCoding, intentID: "stale-edit"))
    }

    // MARK: Catalog-backed row enumeration

    /// Rows start from the MCC discovery catalog, not policy.models alone —
    /// otherwise a model the vendor still offers is invisible here while
    /// hive_models lists it, and a retired policy row is the only one shown.
    func testRowsPreferLiveCatalogAndBadgePolicyOnlyModels() throws {
        let initial = try policy()
        let editor = TaskRouterEditor(snapshot: TaskRouterSnapshot(policy: initial))
        let catalog = [
            WorkspaceRoutingCatalogEntry(
                provider: "claude", model: "claude-opus-4-8",
                effortOptions: [], addEffortOptions: [], startingEffort: .hiveDecides),
            WorkspaceRoutingCatalogEntry(
                provider: "claude", model: "claude-fable-5",
                effortOptions: [], addEffortOptions: [], startingEffort: .hiveDecides),
            WorkspaceRoutingCatalogEntry(
                provider: "codex", model: "gpt-5.4",
                effortOptions: [], addEffortOptions: [], startingEffort: .hiveDecides),
        ]
        let rows = editor.rows(for: .complexCoding, catalog: catalog)
        let keys = rows.map { "\($0.provider)/\($0.model)" }

        XCTAssertTrue(keys.contains("claude/claude-opus-4-8"))
        XCTAssertTrue(keys.contains("claude/claude-fable-5"))
        XCTAssertTrue(
            keys.contains("codex/gpt-5.4"),
            "a catalogued model with no policy row must still be offered")
        // The fixture's complex_coding member gpt-5.6-sol is not in this catalog
        // — keep it and badge it rather than dropping a configured model.
        XCTAssertTrue(keys.contains("codex/gpt-5.6-sol"))
        let retired = try XCTUnwrap(rows.first {
            $0.provider == "codex" && $0.model == "gpt-5.6-sol"
        })
        XCTAssertTrue(retired.unresolvable)
        XCTAssertTrue(retired.isMember)

        let live = try XCTUnwrap(rows.first {
            $0.provider == "claude" && $0.model == "claude-opus-4-8"
        })
        XCTAssertFalse(live.unresolvable)

        let onlyCatalog = try XCTUnwrap(rows.first {
            $0.provider == "codex" && $0.model == "gpt-5.4"
        })
        XCTAssertFalse(onlyCatalog.unresolvable)
        XCTAssertFalse(onlyCatalog.isMember)
    }

    /// With no catalog (snapshot absent), fall back to policy.models ∪
    /// candidates and do not claim unresolvable — absence of a catalog is
    /// unknown, not "every model is retired".
    func testRowsWithoutCatalogFallBackToPolicyModels() throws {
        let initial = try policy()
        let editor = TaskRouterEditor(snapshot: TaskRouterSnapshot(policy: initial))
        let rows = editor.rows(for: .complexCoding, catalog: [])
        XCTAssertFalse(rows.isEmpty)
        XCTAssertTrue(rows.allSatisfy { !$0.unresolvable })
        XCTAssertTrue(rows.contains {
            $0.provider == "claude" && $0.model == "claude-opus-4-8" && $0.isMember
        })
    }
}
