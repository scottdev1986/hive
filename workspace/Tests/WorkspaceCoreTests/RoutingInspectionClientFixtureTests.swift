// RoutingInspectionClientFixtureTests.swift
//
// Binds the read-only routing inspection decoder to its seven screen states.

import XCTest
@testable import WorkspaceCore

private enum RoutingInspectionFixtureModule: ClientFixtureModule {
    typealias Value = RouteInspection
    static let resourceName = "routing-inspection-corpus"
}

final class RoutingInspectionClientFixtureTests: XCTestCase {
    func testGoldenFixtureMatrixRoundTrips() throws {
        try assertGoldenFixtureMatrix(RoutingInspectionFixtureModule.self)

        let current = try XCTUnwrap(
            RoutingInspectionFixtureModule.load().first {
                $0.availability == .current
            }?.value)
        XCTAssertEqual(current.schemaVersion, 1)
        XCTAssertTrue(
            current.candidates.contains {
                !$0.eligible && $0.liveShare == 0
            },
            "an exclusion must remain visible without rewriting stored weights")
    }

    func testDecoderRejectsUnknownSchemaVersion() throws {
        let fixture = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/routing-inspection-corpus.json")
        var rows = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [[String: Any]])
        var value = try XCTUnwrap(rows[0]["value"] as? [String: Any])
        value["schemaVersion"] = 2
        rows[0]["value"] = value

        XCTAssertThrowsError(try JSONDecoder().decode(
            [ClientProjection<RouteInspection>].self,
            from: JSONSerialization.data(withJSONObject: rows)))
    }
}
