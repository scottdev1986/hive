// HierarchyH0ClientFixtureTests.swift
//
// Keeps the five frozen hierarchy foundation records together only inside the
// fixture module. It does not invent a daemon hierarchy-snapshot projection.

import Foundation
import XCTest
@testable import WorkspaceCore

private struct HierarchyH0FixturePayload: Codable, Equatable, Sendable {
    let specRevision: HierarchySpecRevision
    let planRevision: HierarchyPlanRevision
    let topologyDecision: HierarchyTopologyDecision
    let runBudget: HierarchyRunBudget
    let run: HierarchyRun
}

private enum HierarchyH0FixtureModule: ClientFixtureModule {
    typealias Value = HierarchyH0FixturePayload
    static let resourceName = "hierarchy-h0-corpus"
}

final class HierarchyH0ClientFixtureTests: XCTestCase {
    func testGoldenFixtureMatrixRoundTrips() throws {
        try assertGoldenFixtureMatrix(HierarchyH0FixtureModule.self)

        let current = try XCTUnwrap(
            HierarchyH0FixtureModule.load().first {
                $0.availability == .current
            }?.value)
        XCTAssertEqual(current.run.runID, current.specRevision.runID)
        let encodedBudget = try JSONEncoder().encode(current.runBudget)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encodedBudget) as? [String: Any])
        let limits = try XCTUnwrap(object["limits"] as? [String: Any])
        XCTAssertEqual(limits.count, 11)
    }

    func testPendingGatesRejectApprovalFields() {
        XCTAssertThrowsError(
            try JSONDecoder().decode(
                HierarchyRun.G1State.self,
                from: Data(#"{"state":"pending","decider":"engineer"}"#.utf8)))
        XCTAssertThrowsError(
            try JSONDecoder().decode(
                HierarchyRun.G2State.self,
                from: Data(#"{"state":"pending","runStageSha":"abc"}"#.utf8)))
    }
}
