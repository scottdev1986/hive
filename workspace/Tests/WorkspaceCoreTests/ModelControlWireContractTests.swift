import Foundation
import XCTest
@testable import WorkspaceCore

final class ModelControlWireContractTests: XCTestCase {

    private func wireFixture() throws -> Data {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try Data(contentsOf: repoRoot
            .appendingPathComponent("test/fixtures/model-control-snapshot.json"))
    }

    func testDecodesTheSnapshotTheCLIEmitsToday() throws {
        let snapshot = try ModelControlSnapshot.decode(from: try wireFixture())

        XCTAssertEqual(snapshot.generatedAt, "2026-07-12T22:00:00.000Z")
        XCTAssertEqual(snapshot.usageSurfaces["grok"], .metered)

        guard case .available(let grokModels, _)? = snapshot.providers["grok"] else {
            return XCTFail("the Grok catalog must be available")
        }
        guard case .known(let supportsEffort, _, _) = grokModels[0].supportsEffort else {
            return XCTFail("Grok's supports-effort false must remain a known fact")
        }
        XCTAssertFalse(supportsEffort)

        guard case .unavailable(let reason)? = snapshot.providers["codex"] else {
            return XCTFail("the fixture's Codex catalog must be unavailable")
        }
        XCTAssertEqual(reason, "codex CLI not signed in")

        let claudeBilling = try XCTUnwrap(snapshot.billing["claude"] ?? nil)
        guard case .known(let creditsEnabled, _, _) = claudeBilling.creditsEnabled else {
            return XCTFail("Claude's disabled billing rail must remain a known fact")
        }
        XCTAssertFalse(creditsEnabled)

        let quota = try XCTUnwrap(snapshot.quota)
        guard case .pool(let claudePool) = quota[0] else {
            return XCTFail("the fixture must contain Claude's measured quota pool")
        }
        XCTAssertEqual(claudePool.fiveHour.used, 63)
        XCTAssertNil(claudePool.weekly.used)
        XCTAssertEqual(snapshot.tokenUsage?.generatedAt, snapshot.generatedAt)
    }

    func testUnknownFactAndUsageSurfaceDegradeWithoutDroppingTheSnapshot() throws {
        let wire = #"""
        {
          "generatedAt": "2026-07-13T12:00:00.000Z",
          "providers": {
            "grok": {
              "status": "ok",
              "records": [{
                "provider": "grok",
                "canonicalId": "grok-future",
                "launchToken": "grok-future",
                "hidden": {"state":"known","value":false},
                "supportsEffort": {"state":"vendor-added-state","value":false},
                "supportedEffortLevels": {"state":"unknown","reason":"not reported"},
                "defaultEffort": {"state":"unknown","reason":"not reported"},
                "observedAt": "2026-07-13T12:00:00.000Z"
              }],
              "effectiveDefault": {
                "model": {"state":"known","value":"grok-future"},
                "effort": {"state":"unknown","reason":"not reported"}
              }
            }
          },
          "billing": {},
          "usageSurfaces": {"grok":"vendor-added-surface"},
          "quota": []
        }
        """#.data(using: .utf8)!

        let snapshot = try ModelControlSnapshot.decode(from: wire)
        guard case .available(let models, _)? = snapshot.providers["grok"] else {
            return XCTFail("an unknown nested value must not drop the provider")
        }
        XCTAssertEqual(
            models[0].supportsEffort.unknownReason,
            "unsupported discovered fact state vendor-added-state")
        XCTAssertEqual(snapshot.usageSurfaces["grok"], .unknown("vendor-added-surface"))
        guard case .unknown(let reason) = MeterDerivation.usage(
            provider: .grok,
            surface: snapshot.usageSurfaces["grok"],
            quota: snapshot.quota,
            quotaError: snapshot.quotaError)
        else { return XCTFail("an unknown surface must not fabricate a meter") }
        XCTAssertTrue(reason.contains("vendor-added-surface"))
    }

    func testMalformedProviderAndQuotaSubtreesDoNotBlankValidProviders() throws {
        let wire = #"""
        {
          "generatedAt": "2026-07-13T12:00:00.000Z",
          "providers": {
            "claude": {"status":"unavailable","reason":"test outage"},
            "grok": {"status":"ok","records":"not-an-array","effectiveDefault":{}}
          },
          "billing": {},
          "usageSurfaces": {"claude":"metered"},
          "quota": [{"provider":17}]
        }
        """#.data(using: .utf8)!

        let snapshot = try ModelControlSnapshot.decode(from: wire)
        guard case .unavailable(let claudeReason)? = snapshot.providers["claude"] else {
            return XCTFail("the valid provider must survive its malformed sibling")
        }
        XCTAssertEqual(claudeReason, "test outage")
        guard case .unavailable(let grokReason)? = snapshot.providers["grok"] else {
            return XCTFail("the malformed provider must become explicitly unavailable")
        }
        XCTAssertTrue(grokReason.contains("could not read"))
        XCTAssertNil(snapshot.quota)
        XCTAssertTrue(snapshot.quotaError?.contains("could not read") == true)
    }

    func testUnknownTokenReadingStateDegradesToUnknown() throws {
        let reading = try JSONDecoder().decode(
            TokenUsageReading.self,
            from: Data(#"{"state":"vendor-added-state"}"#.utf8))

        guard case .unknown(let reason) = reading else {
            return XCTFail("an unknown token-reading state must remain visible as unknown")
        }
        XCTAssertEqual(reason, "unsupported token usage state vendor-added-state")
    }
}
