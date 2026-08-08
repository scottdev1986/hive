// RoutingPolicyClientFixtureTests.swift
//
// Binds the routing policy decoder to its seven render-ready states.

import XCTest
@testable import WorkspaceCore

private enum RoutingPolicyFixtureModule: ClientFixtureModule {
    typealias Value = RoutingPolicyDocument
    static let resourceName = "routing-policy-corpus"
}

final class RoutingPolicyClientFixtureTests: XCTestCase {
    func testGoldenFixtureMatrixRoundTrips() throws {
        try assertGoldenFixtureMatrix(RoutingPolicyFixtureModule.self)

        let current = try XCTUnwrap(
            RoutingPolicyFixtureModule.load().first {
                $0.availability == .current
            }?.value)
        XCTAssertEqual(current.schemaVersion, 3)
        XCTAssertTrue(current.categories.keys.contains("standard_coding"))
        XCTAssertTrue(current.categories.keys.contains("complex_coding"))
    }
}
