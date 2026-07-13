import XCTest
@testable import WorkspaceCore

/// The daemon policy document: decoding clay's wire shape and the fail-closed
/// reading. The one rule everything here defends: ABSENT MEANS UNCONFIGURED,
/// and unconfigured never reads as enabled or as permission to spend.
final class RoutingPolicyDocumentTests: XCTestCase {

    private var fixture: RoutingPolicyDocument {
        let json = """
        {
          "schemaVersion": 1,
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
          "chains": {
            "complex_coding": [
              { "provider": "claude", "model": "claude-opus-4-8",
                "effort": { "mode": "exact", "value": "high" } },
              { "provider": "grok", "model": "grok-composer-2.5-fast",
                "effort": { "mode": "none" } }
            ],
            "default": [
              { "provider": "claude", "model": "claude-opus-4-8",
                "effort": { "mode": "provider-controlled" } }
            ]
          }
        }
        """
        return try! RoutingPolicyDocument.decode(from: Data(json.utf8))
    }

    func testDecodesTheWireShape() {
        let document = fixture
        XCTAssertEqual(document.revision, 7)
        XCTAssertTrue(document.provisional)
        XCTAssertEqual(document.chain(for: .complexCoding).count, 2)
        XCTAssertEqual(document.defaultChain.count, 1)
        XCTAssertEqual(
            document.chain(for: .complexCoding)[1].effort,
            RoutingPolicyDocument.WireEffort.none)
    }

    func testAbsentIsUnconfiguredNeverEnabled() {
        let document = fixture
        XCTAssertEqual(document.providerState(.grok), .unconfigured)
        let unlisted = document.modelState(provider: .grok, model: "grok-3-mini")
        XCTAssertEqual(unlisted.state, .unconfigured)
        XCTAssertEqual(
            document.rowState(provider: .grok, model: "grok-3-mini", available: true),
            .seededOff,
            "unconfigured renders as off-awaiting-consent, never as on")
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

    func testExplicitModelRowAnswersUnderAnUnconfiguredProvider() {
        // Clay's rule, verbatim from modelPolicyState: only an explicit
        // provider DISABLED overrides; unconfigured does not.
        let document = fixture
        let reading = document.modelState(provider: .grok, model: "grok-4.5")
        XCTAssertEqual(reading.state, .enabled)
        XCTAssertEqual(reading.source, .model)
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

    func testChainEntryCliSpellings() {
        XCTAssertEqual(
            RoutingPolicyDocument.WireChainEntry(
                provider: "claude", model: "claude-opus-4-8",
                effort: .exact("high")).cliArgument,
            "claude/claude-opus-4-8@high")
        XCTAssertEqual(
            RoutingPolicyDocument.WireChainEntry(
                provider: "grok", model: "grok-composer-2.5-fast",
                effort: .none).cliArgument,
            "grok/grok-composer-2.5-fast@none")
        XCTAssertEqual(
            RoutingPolicyDocument.WireChainEntry(
                provider: "codex", model: "gpt-5.6-sol",
                effort: .providerControlled).cliArgument,
            "codex/gpt-5.6-sol")
    }
}
