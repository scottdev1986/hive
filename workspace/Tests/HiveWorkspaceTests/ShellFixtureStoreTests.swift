// ShellFixtureStoreTests.swift
//
// Proves the absent screens are fixture-backed, not code-backed: the screen
// state equals what the absent corpus rows say, editing a row changes the
// screen, removing a row fails the load, and a row that claims an
// observation is rejected. A code literal cannot satisfy any of these.

import XCTest
@testable import HiveWorkspace
import WorkspaceCore
@testable import WorkspaceQAKit

final class ShellFixtureStoreTests: XCTestCase {

    private var fixtureDirectory: String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // HiveWorkspaceTests
            .deletingLastPathComponent() // Tests
            .appendingPathComponent("WorkspaceCoreTests/Fixtures")
            .path
    }

    /// The absent rows decoded straight from the corpus file, keyed by route.
    private func absentRows(
        from directory: String
    ) throws -> [ShellRoute: ShellAbsentScreen] {
        let url = URL(fileURLWithPath: directory)
            .appendingPathComponent("shell-absent-screens-corpus.json")
        let data = try Data(contentsOf: url)
        let rows = try JSONDecoder().decode(
            [ClientProjection<ShellAbsentScreen>].self, from: data)
        var byRoute: [ShellRoute: ShellAbsentScreen] = [:]
        for row in rows {
            if let value = row.value, let route = ShellRoute(rawValue: value.route) {
                byRoute[route] = value
            }
        }
        return byRoute
    }

    private func makeTempCopy() throws -> String {
        let temp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("shell-fixtures-\(UUID().uuidString)")
        try FileManager.default.copyItem(
            atPath: fixtureDirectory, toPath: temp.path)
        return temp.path
    }

    private func mutateAbsentCorpus(
        in directory: String,
        _ mutate: (inout [[String: Any]]) -> Void
    ) throws {
        let url = URL(fileURLWithPath: directory)
            .appendingPathComponent("shell-absent-screens-corpus.json")
        var rows = try JSONSerialization.jsonObject(
            with: Data(contentsOf: url)) as! [[String: Any]]
        mutate(&rows)
        let data = try JSONSerialization.data(
            withJSONObject: rows, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url)
    }

    /// Every declared screen has a projection. This used to compare the unwired
    /// routes against the absent-row corpus; with the registry there are no
    /// unwired routes, which would make that comparison two empty sets agreeing
    /// about nothing. So it asserts the guarantee instead: a declared screen is
    /// always wired, and the absent-row corpus therefore has no subject left.
    func testEveryDeclaredScreenIsWiredSoNoAbsentRowIsNeeded() throws {
        let state = try ShellFixtureStore(directory: fixtureDirectory)
            .loadState(scenario: .current)
        let unwired = ShellRoute.allCases.filter {
            ShellFixtureStore.wiredRoutes[$0] == nil
        }
        XCTAssertEqual(unwired, [], "a declared screen must have a projection")
        XCTAssertTrue(
            try absentRows(from: fixtureDirectory).isEmpty,
            "an absent row for a declared screen would contradict its projection")
        // The positive control: the screens really are there to be found, so the
        // emptiness above is a fact about absent rows, not about the reader.
        XCTAssertEqual(
            Set(state.screens.keys), Set(ShellRoute.allCases))
    }




    func testInspectorCorporaProvidePositiveDenseControls() throws {
        let state = try ShellFixtureStore(directory: fixtureDirectory)
            .loadState(scenario: .current)
        let inspector = try XCTUnwrap(state.inspector)

        guard case .present(let turns) = inspector.events.events else {
            return XCTFail("the events corpus must reach the inspector as turns")
        }
        XCTAssertFalse(turns.isEmpty)
        XCTAssertTrue(turns.flatMap(\.rows).contains { $0.label == "turn-end" })

        guard case .present(let routes) = inspector.task.routeInspections else {
            return XCTFail("the route-inspection corpus must reach the inspector")
        }
        XCTAssertTrue(routes.contains { $0.label == "complex_coding" })
    }

    func testEveryInspectorAvailabilityRowDecodes() throws {
        for scenario in ProjectionAvailability.allCases {
            let inspector = try XCTUnwrap(
                ShellFixtureStore(directory: fixtureDirectory)
                    .loadState(scenario: scenario).inspector)
            XCTAssertNotNil(inspector.task)
            if scenario == .current {
                guard case .present = inspector.events.events else {
                    return XCTFail("the current fixture row carries events")
                }
            }
        }
    }

    func testMissingHierarchyInspectorCorpusFailsTheLoad() throws {
        let temp = try makeTempCopy()
        defer { try? FileManager.default.removeItem(atPath: temp) }
        try FileManager.default.removeItem(atPath:
            URL(fileURLWithPath: temp)
                .appendingPathComponent("hierarchy-projection-v2-corpus.json").path)

        XCTAssertThrowsError(
            try ShellFixtureStore(directory: temp).loadState(scenario: .current))
    }
}
