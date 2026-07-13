import XCTest
@testable import WorkspaceCore

/// THE CONTRACT between the daemon's emitted policy document and this app's
/// decoder. `Fixtures/routing-policy-wire.json` is a document the daemon may
/// legitimately emit today: it carries every effort mode in
/// `EffortTargetSchema` and every selection mode in `SelectionModeSchema`
/// (src/schemas/routing-policy.ts). The daemon-side twin of this test
/// (src/schemas/routing-policy.wire-contract.test.ts) proves the fixture is
/// schema-valid AND that it still covers every enum value — so a mode added
/// on the daemon side fails there and lands here before it can reach a user.
///
/// WHY THIS EXISTS: a strict decoder used to throw on ONE unrecognised effort
/// mode ("never-configured", added by capability-first routing). The throw
/// failed the WHOLE document, the Settings screen fell back to the in-memory
/// provisional store, and every setting silently stopped persisting. Decoding
/// must degrade NARROWLY — an unknown value costs its own field, never the
/// document.
final class RoutingPolicyWireContractTests: XCTestCase {

    private func wireFixture() throws -> Data {
        let url = try XCTUnwrap(
            Bundle.module.url(
                forResource: "routing-policy-wire", withExtension: "json",
                subdirectory: "Fixtures"),
            "the wire fixture must ship with the test bundle")
        return try Data(contentsOf: url)
    }

    /// The regression: this document is what `hive routing export` returns
    /// today, and the app must READ it — not fall back to the placeholder.
    func testDecodesTheDocumentTheDaemonEmitsToday() throws {
        let document = try RoutingPolicyDocument.decode(from: try wireFixture())

        XCTAssertEqual(document.schemaVersion, 2)
        XCTAssertEqual(document.revision, 6)
        XCTAssertEqual(document.providerState(ProviderID("claude")), .enabled)
        XCTAssertEqual(document.providerState(ProviderID("grok")), .disabled)

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

        // A chain link may carry an effort this build cannot name; the link
        // itself must still survive, because dropping it would silently
        // reroute work.
        let complex = document.chain(for: .complexCoding)
        XCTAssertEqual(complex.count, 2)
        XCTAssertEqual(complex[0].effort.asEffortTarget, .exact("high"))
        XCTAssertEqual(complex[1].model, "gpt-5.6-sol")
        XCTAssertNil(complex[1].effort.asEffortTarget)
    }

    /// FORWARD COMPATIBILITY: a future daemon adds an effort mode and a field
    /// this build has never heard of. The document must still decode — one
    /// unknown value must never disable persistence for everything else.
    func testUnknownEffortModeAndUnknownFieldDoNotNukeTheDocument() throws {
        let json = """
        {
          "schemaVersion": 2,
          "revision": 11,
          "updatedAt": "2026-09-01T00:00:00.000Z",
          "provisional": false,
          "eloRating": { "claude": 1800 },
          "providers": { "claude": "enabled" },
          "models": [
            { "provider": "claude", "model": "claude-opus-4-8", "state": "enabled",
              "effort": { "mode": "thinking-budget", "tokens": 32000 } }
          ],
          "chains": {},
          "selection": { "global": "auto", "categories": {} }
        }
        """
        let document = try RoutingPolicyDocument.decode(from: Data(json.utf8))

        XCTAssertEqual(document.revision, 11)
        XCTAssertEqual(document.providerState(ProviderID("claude")), .enabled)
        XCTAssertEqual(
            document.modelState(provider: ProviderID("claude"), model: "claude-opus-4-8").state,
            .enabled,
            "an unknown effort mode must not cost the row its enablement")
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

    /// The honest half of the contract: what genuinely IS required still
    /// fails. Forward compatibility is not permission to invent a document.
    func testAMissingRequiredFieldStillFails() {
        let json = """
        {
          "schemaVersion": 2,
          "updatedAt": "2026-09-01T00:00:00.000Z",
          "provisional": false,
          "providers": {},
          "models": [],
          "chains": {},
          "selection": { "global": "auto", "categories": {} }
        }
        """
        XCTAssertThrowsError(
            try RoutingPolicyDocument.decode(from: Data(json.utf8)),
            "revision is the CAS token — a document without it is unusable, not tolerable")
    }

    /// SELECTION: the daemon's vocabulary (never-configured/auto/choice)
    /// is not one this build can write (it speaks spread/strict). It must not
    /// offer a control whose every persist the daemon would refuse — and it
    /// must not silently show "Spread by capacity" for a mode that is really
    /// "never-configured".
    func testSelectionThisBuildCannotSpeakIsNotEditable() throws {
        let document = try RoutingPolicyDocument.decode(from: try wireFixture())
        XCTAssertTrue(document.selectionOnWire)
        XCTAssertFalse(
            document.selectionWritable,
            "the daemon speaks a selection vocabulary this build cannot write")
    }
}
