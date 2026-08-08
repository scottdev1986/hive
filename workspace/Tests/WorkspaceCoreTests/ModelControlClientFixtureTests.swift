// ModelControlClientFixtureTests.swift
//
// Binds the model and quota snapshot decoder to its seven screen states.

import XCTest
@testable import WorkspaceCore

private enum ModelControlFixtureModule: ClientFixtureModule {
    typealias Value = WorkspaceModelControlView
    static let resourceName = "model-control-corpus"
}

final class ModelControlClientFixtureTests: XCTestCase {
    func testGoldenFixtureMatrixRoundTrips() throws {
        try assertGoldenFixtureMatrix(ModelControlFixtureModule.self)

        let current = try XCTUnwrap(
            ModelControlFixtureModule.load().first {
                $0.availability == .current
            }?.value)
        let snapshot = current.snapshot
        XCTAssertFalse(snapshot.providers.isEmpty)
        XCTAssertNotNil(snapshot.quota)
        XCTAssertFalse(current.routing.categories.isEmpty)
        XCTAssertEqual(current.routing.categories.first?.rawValue, "light_research")
        XCTAssertFalse(current.providers.isEmpty)

        guard case .available(let models, let effectiveDefault) =
            snapshot.providers["claude"]
        else {
            return XCTFail("the Claude capability fixture must be available")
        }
        let model = try XCTUnwrap(models.first)
        XCTAssertEqual(model.accountFingerprint, "abc123")
        XCTAssertEqual(model.cliVersion, "2.1.207")
        XCTAssertEqual(model.aliases, [])
        XCTAssertEqual(model.entitled.value, true)
        XCTAssertEqual(effectiveDefault.provider, "claude")

        guard case .pool(let pool) = try XCTUnwrap(snapshot.quota?.first) else {
            return XCTFail("the quota fixture must carry its discovered pool")
        }
        XCTAssertFalse(pool.overridesDiscovered)
        XCTAssertEqual(pool.fiveHour.reservedIsEstimate, true)
    }

    func testUnconfiguredQuotaPreservesEveryFrozenField() throws {
        let wire = Data(
            #"""
            {
              "provider": "codex",
              "model": "*",
              "configured": false,
              "confidence": "missing",
              "reason": "no reading",
              "probeError": null,
              "reserved": 3,
              "fiveHourRecorded": 2,
              "weeklyRecorded": 4,
              "recordedIsLocalEstimate": true
            }
            """#.utf8)
        let entry = try JSONDecoder().decode(QuotaEntry.self, from: wire)
        guard case .unconfigured(let quota) = entry else {
            return XCTFail("configured:false must decode as unconfigured quota")
        }
        XCTAssertEqual(quota.confidence, "missing")
        XCTAssertEqual(quota.reserved, 3)
        XCTAssertEqual(quota.fiveHourRecorded, 2)
        XCTAssertEqual(quota.weeklyRecorded, 4)
        XCTAssertTrue(quota.recordedIsLocalEstimate)
        XCTAssertEqual(
            try canonicalJSON(wire),
            try canonicalJSON(JSONEncoder().encode(entry)))
    }
}
