import XCTest
@testable import WorkspaceCore

/// The daemon policy document's wire shape and editor-safe spellings. Effective
/// provider/model state is deliberately absent here: Workspace receives that
/// interpretation in `WorkspaceModelControlView`.
final class RoutingPolicyDocumentTests: XCTestCase {

    private var fixture: RoutingPolicyDocument {
        let json = """
        {
          "schemaVersion": 3,
          "revision": 7,
          "updatedAt": "2026-07-13T00:30:00.000Z",
          "provisional": true,
          "providers": { "claude": "enabled", "codex": "disabled" },
          "models": [
            { "provider": "claude", "model": "claude-haiku-4-5", "state": "disabled",
              "effort": { "mode": "never-configured" } },
            { "provider": "codex", "model": "gpt-5.6-sol", "state": "enabled",
              "effort": { "mode": "never-configured" } },
            { "provider": "grok", "model": "grok-4.5", "state": "enabled",
              "effort": { "mode": "never-configured" } },
            { "provider": "claude", "model": "claude-fable-5",
              "effort": { "mode": "exact", "value": "high" } }
          ],
          "global": {
            "mode": "hive-equal",
            "candidates": [
              { "provider": "claude", "model": "claude-opus-4-8",
                "effort": { "mode": "provider-controlled" }, "weight": 1 }
            ]
          },
          "categories": {
            "complex_coding": {
              "mode": "user-weighted",
              "candidates": [
                { "provider": "claude", "model": "claude-opus-4-8",
                  "effort": { "mode": "exact", "value": "high" }, "weight": 3 },
                { "provider": "grok", "model": "grok-composer-2.5-fast",
                  "effort": { "mode": "none" }, "weight": 1 }
              ]
            }
          }
        }
        """
        return try! RoutingPolicyDocument.decode(from: Data(json.utf8))
    }

    func testDecodesTheWireShape() {
        let document = fixture
        XCTAssertEqual(document.revision, 7)
        XCTAssertTrue(document.provisional)
        let complex = document.route(for: .complexCoding)
        XCTAssertEqual(complex?.routerMode, .userWeighted)
        XCTAssertEqual(complex?.candidates.count, 2)
        XCTAssertEqual(complex?.candidates[0].weight, 3)
        XCTAssertEqual(
            complex?.candidates[1].effort,
            RoutingPolicyDocument.CandidateEffort.none)
        XCTAssertEqual(document.global?.routerMode, .hiveEqual)
        XCTAssertNil(
            document.route(for: .planning),
            "a category with no route of its own resolves to global, not to an empty route")
    }

    func testEffortOnlyRowDecodesWithoutInventingEnablement() {
        let document = fixture
        XCTAssertNil(
            document.modelRow(provider: .claude, model: "claude-fable-5")?.state)
        XCTAssertEqual(
            document.modelEffort(provider: .claude, model: "claude-fable-5"),
            .exact("high"))
    }

    func testEffortWireSpellingsRoundTripAndMatchTheCli() throws {
        let efforts: [RoutingPolicyDocument.WireEffort] =
            [.exact("xhigh"), .none, .providerControlled]
        for effort in efforts {
            let data = try JSONEncoder().encode(effort)
            XCTAssertEqual(
                try JSONDecoder().decode(
                    RoutingPolicyDocument.WireEffort.self, from: data),
                effort)
        }
        XCTAssertEqual(
            RoutingPolicyDocument.WireEffort.exact("high").cliArgument, "exact:high")
        XCTAssertEqual(
            RoutingPolicyDocument.WireEffort.none.cliArgument, "none")
        XCTAssertEqual(
            RoutingPolicyDocument.WireEffort.providerControlled.cliArgument,
            "provider-controlled")
    }

    func testRouteCandidateCliSpellings() {
        XCTAssertEqual(
            RoutingPolicyDocument.WireRouteCandidate(
                provider: "claude", model: "claude-opus-4-8",
                effort: .exact("high"), weight: 3).cliArgument,
            "claude/claude-opus-4-8@high=3")
        XCTAssertEqual(
            RoutingPolicyDocument.WireRouteCandidate(
                provider: "grok", model: "grok-composer-2.5-fast",
                effort: .none, weight: 1).cliArgument,
            "grok/grok-composer-2.5-fast@none=1")
        XCTAssertEqual(
            RoutingPolicyDocument.WireRouteCandidate(
                provider: "codex", model: "gpt-5.6-sol",
                effort: .providerControlled, weight: 2).cliArgument,
            "codex/gpt-5.6-sol=2")
        XCTAssertEqual(
            RoutingPolicyDocument.WireRouteCandidate(
                provider: "claude", model: "claude-fable-5",
                effort: .hiveDecides, weight: 1).cliArgument,
            "claude/claude-fable-5@hive-decides=1")
    }

    func testUnknownCandidateEffortMakesOnlyItsRouteNonWritable() throws {
        let wire = Data(#"{"mode":"thinking-budget"}"#.utf8)
        let effort = try JSONDecoder().decode(
            RoutingPolicyDocument.CandidateEffort.self,
            from: wire)
        XCTAssertEqual(effort, .unknown("thinking-budget"))

        let candidate = RoutingPolicyDocument.WireRouteCandidate(
            provider: "future",
            model: "future-model",
            effort: effort,
            weight: 1)
        let route = RoutingPolicyDocument.WireRoute(
            mode: "hive-equal",
            candidates: [candidate])
        XCTAssertFalse(route.writable)
        XCTAssertNil(candidate.cliArgument)
        XCTAssertEqual(
            try JSONDecoder().decode(
                RoutingPolicyDocument.CandidateEffort.self,
                from: JSONEncoder().encode(effort)),
            effort)
    }

    func testExactCandidateEffortStillRequiresItsValue() {
        let wire = Data(#"{"mode":"exact"}"#.utf8)
        XCTAssertThrowsError(
            try JSONDecoder().decode(
                RoutingPolicyDocument.CandidateEffort.self,
                from: wire))
    }

    func testWireRouteBridgesToEditorTermsAndBack() throws {
        let wire = try XCTUnwrap(fixture.route(for: .complexCoding))
        let route = try XCTUnwrap(wire.asRoutePolicy)
        XCTAssertEqual(route.mode, .userWeighted)
        XCTAssertEqual(route.candidates.map(\.weight), [3, 1])
        XCTAssertEqual(route.candidates[0].effort, .exact("high"))
        XCTAssertEqual(route.candidates[1].effort, EffortTarget.none)

        let rebuilt = RoutingPolicyDocument.WireRoute(route)
        XCTAssertEqual(rebuilt, wire)

        // A nil editor effort is Hive's pick — a candidate always answers
        // effort on the wire, and never with never-configured.
        let hiveDecides = RoutingPolicyDocument.WireRoute(RoutePolicy(
            mode: .hiveEqual,
            candidates: [RouteCandidate(
                provider: "claude", model: "claude-fable-5", effort: nil, weight: 1)]))
        XCTAssertEqual(hiveDecides.candidates[0].effort, .hiveDecides)
    }
}
