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

    func testEveryUnwiredScreenRendersItsCorpusRowVerbatim() throws {
        let state = try ShellFixtureStore(directory: fixtureDirectory)
            .loadState(scenario: .current)
        let rows = try absentRows(from: fixtureDirectory)
        let unwired = ShellRoute.allCases.filter {
            ShellFixtureStore.wiredRoutes[$0] == nil
        }
        XCTAssertEqual(
            Set(unwired), Set(rows.keys),
            "every unwired route needs exactly one absent row")
        for route in unwired {
            let screen = try XCTUnwrap(state.screens[route])
            let row = try XCTUnwrap(rows[route])
            XCTAssertEqual(screen.availability, .unknown, "\(route)")
            XCTAssertEqual(screen.observedAt, nil, "\(route)")
            XCTAssertEqual(
                screen.contract, .notFrozen(reason: row.reason),
                "\(route)'s explanation must come from the fixture row")
            XCTAssertEqual(
                screen.facts,
                [ShellScreenFact(label: "Contract", value: row.contractState)],
                "\(route)'s contract state must come from the fixture row")
        }
    }

    func testEditingAFixtureRowChangesTheScreen() throws {
        let temp = try makeTempCopy()
        defer { try? FileManager.default.removeItem(atPath: temp) }
        try mutateAbsentCorpus(in: temp) { rows in
            for (index, row) in rows.enumerated()
            where (row["value"] as? [String: Any])?["route"] as? String == "tokens" {
                var value = row["value"] as! [String: Any]
                value["reason"] = "MUTATED: the tokens screen must say exactly this"
                rows[index]["value"] = value
            }
        }
        let state = try ShellFixtureStore(directory: temp)
            .loadState(scenario: .current)
        XCTAssertEqual(
            state.screens[.tokens]?.contract,
            .notFrozen(reason: "MUTATED: the tokens screen must say exactly this"))
    }

    func testRemovingAFixtureRowFailsTheLoad() throws {
        let temp = try makeTempCopy()
        defer { try? FileManager.default.removeItem(atPath: temp) }
        try mutateAbsentCorpus(in: temp) { rows in
            rows.removeAll {
                ($0["value"] as? [String: Any])?["route"] as? String
                    == "tokens"
            }
        }
        XCTAssertThrowsError(
            try ShellFixtureStore(directory: temp).loadState(scenario: .current)
        ) { error in
            XCTAssertEqual(
                error as? ShellFixtureStore.StoreError,
                .missingAbsentScreen("tokens"),
                "a missing row must fail loudly, never synthesize an absence")
        }
    }

    func testARowClaimingAnObservationIsRejected() throws {
        let temp = try makeTempCopy()
        defer { try? FileManager.default.removeItem(atPath: temp) }
        try mutateAbsentCorpus(in: temp) { rows in
            for (index, row) in rows.enumerated()
            where (row["value"] as? [String: Any])?["route"] as? String == "tokens" {
                rows[index]["availability"] = "current"
            }
        }
        XCTAssertThrowsError(
            try ShellFixtureStore(directory: temp).loadState(scenario: .current)
        ) { error in
            XCTAssertEqual(
                error as? ShellFixtureStore.StoreError,
                .invalidAbsentRow("shell-absent-screens-corpus"),
                "an absent row that claims to be observed is a lie the store rejects")
        }
    }

    func testInspectorCorporaProvidePositiveDenseControls() throws {
        let state = try ShellFixtureStore(directory: fixtureDirectory)
            .loadState(scenario: .current)
        let inspector = try XCTUnwrap(state.inspector)

        guard case .present(let events) = inspector.events.events else {
            return XCTFail("the event corpus must decode as present")
        }
        XCTAssertTrue(events.contains { $0.kind == "vendor.future-signal" })

        guard case .present(let contracts) = inspector.task.declaredContracts else {
            return XCTFail("the declared-contract corpus must decode as present")
        }
        XCTAssertEqual(contracts.first?.acceptedBy, [
            "node_018f4f5e-0000-7000-8000-000000000104 / zoe / g1",
            "node_018f4f5e-0000-7000-8000-000000000105 / amy / g1",
        ])

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
            if scenario == .unknown {
                guard case .absent = inspector.events.events else {
                    return XCTFail("unknown event input must be absent")
                }
            }
        }
    }

    func testMissingInspectorCorpusFailsTheLoad() throws {
        let temp = try makeTempCopy()
        defer { try? FileManager.default.removeItem(atPath: temp) }
        try FileManager.default.removeItem(atPath:
            URL(fileURLWithPath: temp)
                .appendingPathComponent("inspector-events-corpus.json").path)

        XCTAssertThrowsError(
            try ShellFixtureStore(directory: temp).loadState(scenario: .current))
    }

    func testInspectorEventSchemaDriftFailsTheLoad() throws {
        let temp = try makeTempCopy()
        defer { try? FileManager.default.removeItem(atPath: temp) }
        let url = URL(fileURLWithPath: temp)
            .appendingPathComponent("inspector-events-corpus.json")
        var rows = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
        var value = try XCTUnwrap(rows[0]["value"] as? [String: Any])
        var events = try XCTUnwrap(value["events"] as? [[String: Any]])
        events[0]["schemaVersion"] = 3
        value["events"] = events
        rows[0]["value"] = value
        try JSONSerialization.data(withJSONObject: rows).write(to: url)

        XCTAssertThrowsError(
            try ShellFixtureStore(directory: temp).loadState(scenario: .current))
    }

    func testDeclaredContractMustBindBothParticipants() throws {
        let temp = try makeTempCopy()
        defer { try? FileManager.default.removeItem(atPath: temp) }
        let url = URL(fileURLWithPath: temp)
            .appendingPathComponent("inspector-declared-contracts-corpus.json")
        var rows = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
        var value = try XCTUnwrap(rows[0]["value"] as? [String: Any])
        var contracts = try XCTUnwrap(value["contracts"] as? [[String: Any]])
        var contract = contracts[0]
        var acceptedBy = try XCTUnwrap(contract["acceptedBy"] as? [[String: Any]])
        acceptedBy.removeLast()
        contract["acceptedBy"] = acceptedBy
        contracts[0] = contract
        value["contracts"] = contracts
        rows[0]["value"] = value
        try JSONSerialization.data(withJSONObject: rows).write(to: url)

        XCTAssertThrowsError(
            try ShellFixtureStore(directory: temp).loadState(scenario: .current))
    }
}
