// WorkspaceSnapshotV2ClientFixtureTests.swift
//
// Binds the Workspace snapshot decoder to its seven render-ready states.

import XCTest
@testable import WorkspaceCore

private enum WorkspaceSnapshotV2FixtureModule: ClientFixtureModule {
    typealias Value = WorkspaceStatusSnapshot
    static let resourceName = "workspace-snapshot-v2-corpus"
}

final class WorkspaceSnapshotV2ClientFixtureTests: XCTestCase {
    func testGoldenFixtureMatrixRoundTrips() throws {
        try assertGoldenFixtureMatrix(WorkspaceSnapshotV2FixtureModule.self)

        let current = try XCTUnwrap(
            WorkspaceSnapshotV2FixtureModule.load().first {
                $0.availability == .current
            }?.value)
        XCTAssertEqual(current.schemaVersion, 2)
        XCTAssertFalse(current.entities.isEmpty)
    }

    func testSnapshotDecoderRejectsUnknownSchemaVersion() throws {
        var rows = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: WorkspaceSnapshotV2FixtureModule.loadData()) as? [[String: Any]])
        var value = try XCTUnwrap(rows[0]["value"] as? [String: Any])
        value["schemaVersion"] = 3
        rows[0]["value"] = value
        let data = try JSONSerialization.data(withJSONObject: rows)

        XCTAssertThrowsError(
            try JSONDecoder().decode(
                [ClientProjection<WorkspaceStatusSnapshot>].self,
                from: data))
    }
}
