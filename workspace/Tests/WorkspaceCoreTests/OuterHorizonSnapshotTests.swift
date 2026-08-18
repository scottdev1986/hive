// OuterHorizonSnapshotTests.swift
//
// Decodes every outer-horizon scenario and pins the hierarchy distinctions the
// Live Run screen relies on: entity absence, present-empty fields, open entity
// kinds, strict snapshots, dense capacity, and semantic navigation history.

import Foundation
import XCTest
@testable import WorkspaceCore

private struct OuterHorizonFixtureCorpus: Decodable {
    struct Scenario: Decodable {
        let name: String
        let snapshot: OuterHorizonSnapshot
    }

    let schemaVersion: Int
    let scenarios: [Scenario]
}

final class OuterHorizonSnapshotTests: XCTestCase {
    private func node(_ id: String, parent: String?) throws -> HierarchyNodeProjection {
        let parentValue: Any = parent.map { $0 as Any } ?? NSNull()
        let object: [String: Any] = [
            "schemaVersion": HierarchyProjectionSchema.version,
            "nodeId": id,
            "runId": "run",
            "entityRevision": "1",
            "parentNodeId": ["availability": "present", "value": parentValue],
            "ownerNodeId": ["availability": "present", "value": NSNull()],
            "organizationalRole": ["availability": "present", "value": "worker"],
            "assignmentKind": ["availability": "present", "value": "author"],
            "taskScope": ["availability": "present", "value": []],
            "lifecycle": ["availability": "present", "value": "active"],
            "binding": [
                "availability": "absent",
                "reason": "source-absent",
                "detail": "test node has no binding",
            ],
        ]
        return try JSONDecoder().decode(
            HierarchyNodeProjection.self,
            from: JSONSerialization.data(withJSONObject: object))
    }

    private func corpusData() throws -> Data {
        let url = try XCTUnwrap(
            Bundle.module.url(
                forResource: "outer-horizon-corpus",
                withExtension: "json",
                subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    private func corpus() throws -> OuterHorizonFixtureCorpus {
        try JSONDecoder().decode(
            OuterHorizonFixtureCorpus.self,
            from: corpusData())
    }

    private func snapshot(_ name: String) throws -> OuterHorizonSnapshot {
        try XCTUnwrap(corpus().scenarios.first { $0.name == name }?.snapshot)
    }

    private func rawSnapshot(_ name: String) throws -> [String: Any] {
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: corpusData()) as? [String: Any])
        let scenarios = try XCTUnwrap(root["scenarios"] as? [[String: Any]])
        let scenario = try XCTUnwrap(
            scenarios.first { $0["name"] as? String == name })
        return try XCTUnwrap(scenario["snapshot"] as? [String: Any])
    }

    func testAllEightNamedScenariosDecodeAsWorkspaceSnapshotV2() throws {
        let fixture = try corpus()
        XCTAssertEqual(fixture.schemaVersion, 1)
        XCTAssertEqual(
            fixture.scenarios.map(\.name),
            [
                "full-hive-dense-19",
                "empty",
                "direct",
                "flat-present-empty",
                "lead-loss",
                "ownership-transfer",
                "all-absent",
                "unknown-entity-kind",
            ])
        XCTAssertTrue(fixture.scenarios.allSatisfy { scenario in
            scenario.snapshot.schemaVersion == 2
                && !scenario.snapshot.instanceId.isEmpty
                && UInt64(scenario.snapshot.seq) != nil
        })
    }

    func testDenseFixtureCarriesNineteenNodesUnderTheThirtyTwoSessionCap() throws {
        let dense = try snapshot("full-hive-dense-19")
        XCTAssertEqual(dense.nodes.count, 19)
        XCTAssertEqual(Set(dense.nodes.map(\.nodeId)).count, 19)

        var crewByParent: [String: Int] = [:]
        for node in dense.nodes {
            guard case .present(let parent) = node.parentNodeId,
                  let parentId = parent.value else { continue }
            crewByParent[parentId, default: 0] += 1
        }
        XCTAssertLessThanOrEqual(crewByParent.values.max() ?? 0, 3)

        let budget = try XCTUnwrap(dense.budgets.first)
        guard case .present(let limits) = budget.limits else {
            return XCTFail("the dense scenario must carry measured limits")
        }
        XCTAssertEqual(limits.activeSessions.hard, 32)
        XCTAssertEqual(limits.activeSessions.reserved, 19)
        XCTAssertEqual(limits.activeSessions.used, 19)
        XCTAssertEqual(limits.totalSpawns.hard, 32)

        let screen = OuterHorizonScreenState(snapshot: dense)
        XCTAssertEqual(screen.visibleRows.count, 19)
        XCTAssertEqual(
            screen.visibleRows.map(\.node.nodeId),
            dense.nodes.map(\.nodeId),
            "the projector's preorder must survive tree construction")
    }

    func testEntityEmptyFieldAbsentAndPresentEmptyStayDistinct() throws {
        let empty = try snapshot("empty")
        XCTAssertTrue(empty.runs.isEmpty)
        XCTAssertTrue(empty.nodes.isEmpty)
        XCTAssertTrue(empty.incidents.isEmpty)

        let absent = try snapshot("all-absent")
        XCTAssertEqual(absent.runs.count, 1)
        XCTAssertTrue(absent.nodes.isEmpty)
        guard case .absent(let phaseReason, _) = try XCTUnwrap(absent.runs.first).phase,
              case .absent(let decisionReason, _) = try XCTUnwrap(absent.incidents.first).runDecision
        else {
            return XCTFail("the all-absent scenario must retain field absence")
        }
        XCTAssertEqual(phaseReason, .unmeasured)
        XCTAssertEqual(decisionReason, .unmeasured)

        let presentEmpty = try snapshot("flat-present-empty")
        guard case .present(let decisions) = try XCTUnwrap(presentEmpty.incidents.first).runDecision,
              case .present(let recoveries) = try XCTUnwrap(presentEmpty.incidents.first).recovery
        else {
            return XCTFail("the flat scenario must retain observed empty collections")
        }
        XCTAssertTrue(decisions.isEmpty)
        XCTAssertTrue(recoveries.isEmpty)
    }

    func testUnknownOuterEntityKindKeepsItsExactWireSpelling() throws {
        let unknown = try snapshot("unknown-entity-kind")
        // Two kinds this client does not decode: the daemon's task board, which
        // this build predates, and the synthetic future kind. Both keep their
        // exact wire spelling rather than stopping the snapshot.
        XCTAssertEqual(
            unknown.unknownEntities.map(\.kind),
            ["hierarchy-task", "hierarchy-future-state"])
        let task = try XCTUnwrap(unknown.unknownEntities.first)
        XCTAssertEqual(task.id, "run_018f4f5e-0000-7000-8000-000000000001:tasks")
        let entity = try XCTUnwrap(unknown.unknownEntities.last)
        XCTAssertEqual(entity.id, "future-state-fixture")
        XCTAssertEqual(entity.entityRevision, "1")
    }

    func testSnapshotRefusesUnknownVersionAndDigestBreakingEntityMutation() throws {
        var unknownVersion = try rawSnapshot("direct")
        unknownVersion["schemaVersion"] = 3
        XCTAssertThrowsError(try JSONDecoder().decode(
            OuterHorizonSnapshot.self,
            from: JSONSerialization.data(withJSONObject: unknownVersion)))

        var digestMutation = try rawSnapshot("unknown-entity-kind")
        var entities = try XCTUnwrap(digestMutation["entities"] as? [[String: Any]])
        let futureIndex = try XCTUnwrap(
            entities.firstIndex { $0["kind"] as? String == "hierarchy-future-state" })
        var future = entities[futureIndex]
        var projection = try XCTUnwrap(future["projection"] as? [String: Any])
        projection["wireLabel"] = "mutated without updating the envelope digest"
        future["projection"] = projection
        entities[futureIndex] = future
        digestMutation["entities"] = entities
        XCTAssertThrowsError(try JSONDecoder().decode(
            OuterHorizonSnapshot.self,
            from: JSONSerialization.data(withJSONObject: digestMutation)))
    }

    func testSelectionAndExpansionSurviveSnapshotObservationByNodeID() throws {
        let dense = try snapshot("full-hive-dense-19")
        var screen = OuterHorizonScreenState(snapshot: dense)
        let selectedId = try XCTUnwrap(dense.nodes.last?.nodeId)
        let parentId = try XCTUnwrap(
            screen.visibleRows.first { $0.hasChildren }?.node.nodeId)
        XCTAssertTrue(screen.navigation.expandedNodeIds.contains(parentId))

        screen.select(nodeId: selectedId)
        screen.toggleExpansion(nodeId: parentId)
        screen.observe(try snapshot("lead-loss"))
        XCTAssertEqual(screen.navigation.selectedNodeId, selectedId)
        XCTAssertNil(screen.selectedNode)
        XCTAssertFalse(screen.navigation.expandedNodeIds.contains(parentId))

        screen.observe(dense)
        XCTAssertEqual(screen.selectedNode?.nodeId, selectedId)
        XCTAssertFalse(
            screen.navigation.expandedNodeIds.contains(parentId),
            "a refresh must not silently reopen a hierarchy the user collapsed")
    }

    func testCollapsedDescendantsHideWhileOrphansAndCyclesStayDiagnosticRoots() throws {
        let root = try node("root", parent: nil)
        let child = try node("child", parent: "root")
        let dangling = try node("dangling", parent: "missing")
        let cycleA = try node("cycle-a", parent: "cycle-b")
        let cycleB = try node("cycle-b", parent: "cycle-a")

        let rows = OuterHorizonTree.visibleRows(
            nodes: [root, child, dangling, cycleA, cycleB],
            expandedNodeIds: [])

        XCTAssertEqual(rows.map(\.node.nodeId), ["root", "dangling", "cycle-a", "cycle-b"])
        XCTAssertEqual(rows[1].parentDiagnostic, "parent missing is not in this snapshot")
        XCTAssertEqual(rows[2].parentDiagnostic, "parent cycle or disconnected subtree")
        XCTAssertEqual(rows[3].parentDiagnostic, "parent cycle or disconnected subtree")
    }
}
