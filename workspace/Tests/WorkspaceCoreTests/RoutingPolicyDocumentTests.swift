import XCTest
@testable import WorkspaceCore

/// The daemon policy document: decoding the wire shape and the fail-closed
/// reading. The one rule everything here defends: ABSENT MEANS UNCONFIGURED,
/// and unconfigured never reads as enabled or as permission to spend.
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
            { "provider": "claude", "model": "claude-haiku-4-5", "state": "disabled" },
            { "provider": "codex", "model": "gpt-5.6-sol", "state": "enabled" },
            { "provider": "grok", "model": "grok-4.5", "state": "enabled" },
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
            RoutingPolicyDocument.WireEffort.none)
        XCTAssertEqual(document.global?.routerMode, .hiveEqual)
        XCTAssertNil(
            document.route(for: .planning),
            "a category with no route of its own resolves to global, not to an empty route")
    }

    func testAbsentProviderDisablesAnUnconfiguredModel() {
        let document = fixture
        XCTAssertEqual(document.providerState(.grok), .unconfigured)
        let unlisted = document.modelState(provider: .grok, model: "grok-3-mini")
        XCTAssertEqual(unlisted.state, .disabled)
        XCTAssertEqual(unlisted.source, .provider)
        XCTAssertEqual(
            document.rowState(provider: .grok, model: "grok-3-mini", available: true),
            .disabledByProvider(preferenceOn: false),
            "an absent provider confers no authority on its models")
    }

    func testProviderDisabledDominatesAnEnabledModelRow() {
        let document = fixture
        let reading = document.modelState(provider: .codex, model: "gpt-5.6-sol")
        XCTAssertEqual(reading.state, .disabled)
        XCTAssertEqual(reading.source, .provider)
        XCTAssertEqual(
            document.rowState(provider: .codex, model: "gpt-5.6-sol", available: true),
            .disabledByProvider(preferenceOn: true),
            "the stored preference is shown, non-authoritative")
    }

    func testExplicitModelRowIsOnlyAPreferenceUnderAnUnconfiguredProvider() {
        let document = fixture
        let reading = document.modelState(provider: .grok, model: "grok-4.5")
        XCTAssertEqual(reading.state, .disabled)
        XCTAssertEqual(reading.source, .provider)
        XCTAssertEqual(
            document.rowState(provider: .grok, model: "grok-4.5", available: true),
            .disabledByProvider(preferenceOn: true),
            "the enabled child preference survives but is not authoritative")
    }

    func testEffortOnlyRowDoesNotBlessEnablement() {
        let document = fixture
        // claude-fable-5 has an effort row but no state; the enabled provider
        // answers for enablement — choosing an effort never consents a model.
        let reading = document.modelState(provider: .claude, model: "claude-fable-5")
        XCTAssertEqual(reading.state, .enabled)
        XCTAssertEqual(reading.source, .provider)
        XCTAssertEqual(
            document.modelEffort(provider: .claude, model: "claude-fable-5"),
            .exact("high"))
    }

    func testSelfDisabledUnderEnabledProviderIsUserOff() {
        let document = fixture
        XCTAssertEqual(
            document.rowState(provider: .claude, model: "claude-haiku-4-5", available: true),
            .disabledBySelf)
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
        // No spelling at all: never-configured is a model-row state, and an
        // unknown mode must not be respelled. NIL forces the caller to refuse.
        XCTAssertNil(
            RoutingPolicyDocument.WireRouteCandidate(
                provider: "claude", model: "claude-fable-5",
                effort: .neverConfigured, weight: 1).cliArgument)
        XCTAssertNil(
            RoutingPolicyDocument.WireRouteCandidate(
                provider: "claude", model: "claude-fable-5",
                effort: .unknown("thinking-budget"), weight: 1).cliArgument)
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
