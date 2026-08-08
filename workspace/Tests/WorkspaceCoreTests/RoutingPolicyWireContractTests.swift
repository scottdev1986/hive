import XCTest
@testable import WorkspaceCore

/// Contract between the daemon's emitted policy document and this app's
/// decoder. `Fixtures/routing-policy-wire.json` is a document the daemon may
/// legitimately emit: it carries every effort mode in `EffortTargetSchema`,
/// every candidate effort mode, and both router modes.
///
/// Decoding must degrade NARROWLY — an unknown effort mode costs its own
/// field and an unknown router mode costs its route's editor, never the whole
/// document. Effective routing state and the category catalog are supplied by
/// the daemon-owned Workspace view, not interpreted from this raw document.
final class RoutingPolicyWireContractTests: XCTestCase {

    private func wireFixture() throws -> Data {
        let url = try XCTUnwrap(
            Bundle.module.url(
                forResource: "routing-policy-wire", withExtension: "json",
                subdirectory: "Fixtures"),
            "the wire fixture must ship with the test bundle")
        return try Data(contentsOf: url)
    }

    /// This document is what `hive routing export` returns, and the app must
    /// READ it — not fall back to the placeholder.
    func testDecodesTheDocumentTheDaemonEmitsToday() throws {
        let document = try RoutingPolicyDocument.decode(from: try wireFixture())

        XCTAssertEqual(document.schemaVersion, 3)
        XCTAssertEqual(document.revision, 6)
        XCTAssertEqual(document.providers["claude"], "enabled")
        XCTAssertEqual(document.providers["grok"], "disabled")

        // never-configured and hive-decides are REAL daemon values, and they
        // mean "the user has not chosen" — which is nil, not a fabricated
        // effort the user never asked for.
        XCTAssertNil(
            document.modelEffort(provider: ProviderID("claude"), model: "claude-opus-4-8"),
            "never-configured is an unanswered effort, not a choice")
        XCTAssertNil(
            document.modelEffort(provider: ProviderID("claude"), model: "claude-fable-5"),
            "hive-decides is Hive's call, not a standing user choice")
        XCTAssertEqual(
            document.modelEffort(provider: ProviderID("claude"), model: "claude-sonnet-5"),
            .exact("high"))
        XCTAssertEqual(
            document.modelEffort(provider: ProviderID("grok"), model: "grok-4.5"),
            EffortTarget.none)
        XCTAssertEqual(
            document.modelEffort(provider: ProviderID("codex"), model: "gpt-5.6-sol"),
            .providerControlled)

        // Weighted routes decode whole: mode, every candidate, every weight.
        let complex = try XCTUnwrap(document.route(for: .complexCoding))
        XCTAssertEqual(complex.routerMode, .userWeighted)
        XCTAssertEqual(complex.candidates.count, 2)
        XCTAssertEqual(complex.candidates[0].effort, .exact("high"))
        XCTAssertEqual(complex.candidates[0].weight, 3)
        XCTAssertEqual(complex.candidates[1].model, "gpt-5.6-sol")
        XCTAssertEqual(complex.candidates[1].effort, .hiveDecides)
        XCTAssertEqual(complex.candidates[1].weight, 1)

        let global = try XCTUnwrap(document.global)
        XCTAssertEqual(global.routerMode, .hiveEqual)
        XCTAssertEqual(global.candidates.count, 2)
    }

    func testEveryRouteInTheRawDocumentRemainsReadableByIdentifier() throws {
        let document = try RoutingPolicyDocument.decode(from: try wireFixture())
        XCTAssertTrue(document.categories.keys.contains("standard_coding"))
        XCTAssertNotNil(
            document.global,
            "the global route must survive the wire like any category's")
        for (identifier, route) in document.categories {
            XCTAssertFalse(
                route.candidates.isEmpty,
                "\(identifier) decoded to no route")
        }
    }

    /// FORWARD COMPATIBILITY: a future daemon adds an effort mode and a field
    /// this build has never heard of. The document must still decode — one
    /// unknown value must never disable persistence for everything else.
    func testUnknownEffortModeAndUnknownFieldDoNotNukeTheDocument() throws {
        let json = """
        {
          "schemaVersion": 3,
          "revision": 11,
          "updatedAt": "2026-09-01T00:00:00.000Z",
          "provisional": false,
          "eloRating": { "claude": 1800 },
          "providers": { "claude": "enabled" },
          "models": [
            { "provider": "claude", "model": "claude-opus-4-8", "state": "enabled",
              "effort": { "mode": "thinking-budget", "tokens": 32000 } }
          ],
          "global": null,
          "categories": {}
        }
        """
        let document = try RoutingPolicyDocument.decode(from: Data(json.utf8))

        XCTAssertEqual(document.revision, 11)
        XCTAssertEqual(document.providers["claude"], "enabled")
        XCTAssertEqual(
            document.modelRow(
                provider: ProviderID("claude"), model: "claude-opus-4-8")?.state,
            "enabled",
            "an unknown effort mode must not cost the raw row its state")
        XCTAssertNil(
            document.modelEffort(provider: ProviderID("claude"), model: "claude-opus-4-8"),
            "an effort this build cannot name reads as no choice — never as a guess")
    }

    /// An unknown mode is preserved VERBATIM, so a round-trip through this app
    /// cannot silently rewrite a routing choice it did not understand.
    func testUnknownEffortModeRoundTripsWithoutCorruption() throws {
        let json = """
        { "mode": "thinking-budget" }
        """
        let effort = try JSONDecoder().decode(
            RoutingPolicyDocument.WireEffort.self, from: Data(json.utf8))
        XCTAssertEqual(effort, .unknown("thinking-budget"))

        let reencoded = try JSONEncoder().encode(effort)
        let mode = try XCTUnwrap(
            (try JSONSerialization.jsonObject(with: reencoded) as? [String: Any])?["mode"]
                as? String)
        XCTAssertEqual(mode, "thinking-budget")
    }

    func testUnknownCandidateEffortCostsOnlyItsRouteEditor() throws {
        var json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: try wireFixture()) as? [String: Any])
        var categories = try XCTUnwrap(json["categories"] as? [String: Any])
        var planning = try XCTUnwrap(categories["planning"] as? [String: Any])
        var candidates = try XCTUnwrap(planning["candidates"] as? [[String: Any]])
        candidates[0]["effort"] = ["mode": "thinking-budget"]
        planning["candidates"] = candidates
        categories["planning"] = planning
        json["categories"] = categories

        let document = try RoutingPolicyDocument.decode(
            from: JSONSerialization.data(withJSONObject: json))
        let route = try XCTUnwrap(document.route(for: .planning))
        XCTAssertEqual(route.candidates[0].effort, .unknown("thinking-budget"))
        XCTAssertFalse(route.writable)
        XCTAssertEqual(
            document.route(for: .complexCoding)?.writable,
            true,
            "the unknown candidate must not blank or freeze another route")
    }

    /// The honest half of the contract: what genuinely IS required still
    /// fails. Forward compatibility is not permission to invent a document.
    func testAMissingRequiredFieldStillFails() {
        let json = """
        {
          "schemaVersion": 3,
          "updatedAt": "2026-09-01T00:00:00.000Z",
          "provisional": false,
          "providers": {},
          "models": [],
          "global": null,
          "categories": {}
        }
        """
        XCTAssertThrowsError(
            try RoutingPolicyDocument.decode(from: Data(json.utf8)),
            "revision is the CAS token — a document without it is unusable, not tolerable")
    }

    /// A router mode a newer daemon added is preserved verbatim and costs
    /// that route its editor — never the whole document, and never a rewrite
    /// into a mode the user did not choose.
    func testUnknownRouterModeCostsOnlyItsRoute() throws {
        var json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: try wireFixture()) as? [String: Any])
        var categories = try XCTUnwrap(json["categories"] as? [String: Any])
        var planning = try XCTUnwrap(categories["planning"] as? [String: Any])
        planning["mode"] = "outcome-ranked"
        categories["planning"] = planning
        json["categories"] = categories

        let document = try RoutingPolicyDocument.decode(
            from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(document.revision, 6, "the document still decoded")

        let route = try XCTUnwrap(document.route(for: .planning))
        XCTAssertEqual(route.mode, "outcome-ranked", "the mode is kept verbatim")
        XCTAssertNil(route.routerMode)
        XCTAssertNil(route.asRoutePolicy, "no editor terms for a mode this build cannot name")
        XCTAssertFalse(route.writable)
        XCTAssertEqual(
            document.route(for: .complexCoding)?.writable, true,
            "every other route stays editable")
    }
}
