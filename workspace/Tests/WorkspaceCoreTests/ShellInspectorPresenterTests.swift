// ShellInspectorPresenterTests.swift
//
// Dense / empty / absent / unknown matrix for the run inspector. Every claim
// is a projection fact — nothing is scraped from a terminal.

import XCTest
@testable import WorkspaceCore

final class ShellInspectorPresenterTests: XCTestCase {

    private func routeRead(
        category: String,
        revision: Int
    ) throws -> InspectorRouteInspectionRead {
        let inspection = RouteInspection(
            category: category,
            policyRevision: revision,
            scope: category,
            mode: "hive-equal",
            routeDigest: "sha256:\(category)-\(revision)",
            candidates: [],
            refusal: nil,
            balance: [],
            inspectedAt: "2026-07-30T20:00:00.000Z")
        return InspectorRouteInspectionRead(
            category: category,
            result: .projection(try ClientProjection(
                source: ProjectionSource(revision: String(revision)),
                observedAt: inspection.inspectedAt,
                freshness: .current,
                availability: .current,
                evidence: nil,
                value: inspection)))
    }

    func testAbsentSnapshotYieldsHonestSessionAbsence() {
        let projection = ShellInspectorPresenter.present(.init())
        XCTAssertEqual(projection.availability, .unknown)
        XCTAssertTrue(projection.session.facts.contains {
            $0.label == "Snapshot" && $0.value.contains("absent")
        })
        guard case .absent(let eventsReason) = projection.events.events else {
            return XCTFail("events without a Workspace HTTP GET must be absent, not empty")
        }
        XCTAssertTrue(eventsReason.contains("no Workspace HTTP GET"))
        guard case .absent(let reason) = projection.task.channelDelivery else {
            return XCTFail("channel delivery without a client projection must be absent")
        }
        XCTAssertTrue(reason.contains("receiveChannelMessage"))
        XCTAssertTrue(reason.contains("does not expose a message ledger"))
    }

    func testEventsStayAbsentBecauseNoWorkspaceHTTPServesThem() {
        let projection = ShellInspectorPresenter.present(.init(
            snapshotAvailability: .current))
        guard case .absent(let reason) = projection.events.events else {
            return XCTFail("events must stay absent without an HTTP source")
        }
        XCTAssertTrue(reason.contains("StatusStore.listEvents"))
        XCTAssertTrue(reason.contains("no Workspace HTTP GET"))
        XCTAssertFalse(projection.banners.contains { $0.text.contains("event stream") })
    }

    func testQueriedSnapshotFailureIsNotUnaskedUnknown() {
        let projection = ShellInspectorPresenter.present(.init(
            snapshotAvailability: .disconnected,
            snapshotEvidence: .disconnected(transportLostAt: "socket closed")))
        XCTAssertTrue(projection.session.facts.contains {
            $0.label == "Snapshot" && $0.value.contains("disconnected")
        })
        XCTAssertFalse(projection.session.facts.contains {
            $0.label == "Snapshot" && $0.value.contains("absent — no workspace snapshot")
        })
        XCTAssertTrue(projection.banners.contains { $0.text.contains("socket closed") })
    }

    func testHeldFeedStatusIsRenderedVerbatim() {
        let snapshot = WorkspaceStatusSnapshot(
            instanceId: "i",
            seq: "1",
            entities: [
                .init(
                    kind: "agent",
                    id: "agent-held",
                    generation: 2,
                    entityRevision: "1",
                    projection: [
                        "activity": .string("held"),
                        "provider": .string("codex"),
                    ]),
            ],
            createdAt: "2026-07-30T20:00:00.000Z",
            contentSha256: "deadbeef")
        let projection = ShellInspectorPresenter.present(.init(
            snapshot: snapshot,
            snapshotAvailability: .current,
            snapshotObservedAt: "2026-07-30T20:00:00.000Z",
            selectedAgentId: "agent-held"))
        XCTAssertEqual(projection.session.title, "Codex · session generation 2")
        XCTAssertTrue(projection.session.facts.contains {
            $0.label == "Agent feed" && $0.value == "held"
        })
        XCTAssertTrue(projection.session.facts.contains {
            $0.label == "Activity" && $0.value.contains("held")
        })
    }

    func testUnknownFeedWordStaysUnknownAndIsRenderedVerbatim() {
        let snapshot = WorkspaceStatusSnapshot(
            instanceId: "i",
            seq: "1",
            entities: [
                .init(
                    kind: "agent",
                    id: "agent-x",
                    generation: 1,
                    entityRevision: "1",
                    projection: [
                        "activity": .string("vendor-future-state"),
                        "provider": .string("grok"),
                    ]),
            ],
            createdAt: "2026-07-30T20:00:00.000Z",
            contentSha256: "deadbeef")
        let projection = ShellInspectorPresenter.present(.init(
            snapshot: snapshot,
            snapshotAvailability: .current,
            selectedAgentId: "agent-x"))
        XCTAssertTrue(projection.session.facts.contains {
            $0.label == "Agent feed" && $0.value == "vendor-future-state"
        })
        XCTAssertTrue(projection.session.facts.contains {
            $0.label == "Activity"
                && $0.value == "vendor-future-state · daemon value"
        })
    }

    func testSelectedEntityMustBeAnAgentAndMissingFeedStaysAbsent() {
        let snapshot = WorkspaceStatusSnapshot(
            instanceId: "i",
            seq: "1",
            entities: [
                .init(
                    kind: "session", id: "selected", generation: 1,
                    entityRevision: "1",
                    projection: ["activity": .string("working")]),
                .init(
                    kind: "agent", id: "agent-absent", generation: 1,
                    entityRevision: "1",
                    projection: ["provider": .string("codex")]),
                .init(
                    kind: "agent", id: "agent-unknown", generation: 1,
                    entityRevision: "1",
                    projection: [
                        "provider": .string("codex"),
                        "activity": .string("unknown"),
                    ]),
            ],
            createdAt: "2026-07-30T20:00:00.000Z",
            contentSha256: "deadbeef")

        let wrongKind = ShellInspectorPresenter.present(.init(
            snapshot: snapshot,
            snapshotAvailability: .current,
            selectedAgentId: "selected"))
        XCTAssertEqual(wrongKind.session.title, "No agent entity in snapshot")

        let absent = ShellInspectorPresenter.present(.init(
            snapshot: snapshot,
            snapshotAvailability: .current,
            selectedAgentId: "agent-absent"))
        XCTAssertTrue(absent.session.facts.contains {
            $0.label == "Agent feed" && $0.value.contains("absent")
        })

        let unknown = ShellInspectorPresenter.present(.init(
            snapshot: snapshot,
            snapshotAvailability: .current,
            selectedAgentId: "agent-unknown"))
        XCTAssertTrue(unknown.session.facts.contains {
            $0.label == "Agent feed" && $0.value == "unknown"
        })
    }

    func testRouteRefusalWarnsWithoutRemovingInspectionFacts() throws {
        let inspection = RouteInspection(
            category: "standard_coding",
            policyRevision: 9,
            scope: "global",
            mode: "hive-equal",
            routeDigest: "sha256:route",
            candidates: [],
            refusal: .noCandidate(detail: "every candidate was refused"),
            balance: [],
            inspectedAt: "2026-07-30T20:00:00.000Z")
        let read = try ClientProjection(
            source: ProjectionSource(revision: "9"),
            observedAt: inspection.inspectedAt,
            freshness: .current,
            availability: .current,
            evidence: nil,
            value: inspection)
        let projection = ShellInspectorPresenter.present(.init(
            routeInspectionReads: [InspectorRouteInspectionRead(
                category: inspection.category,
                result: .projection(read))]))
        guard case .present(let facts) = projection.task.routeInspections else {
            return XCTFail("the refused inspection projection must remain visible")
        }
        XCTAssertTrue(facts.contains { $0.label == "standard_coding" })
        XCTAssertTrue(projection.banners.contains {
            $0.severity == .warning && $0.text.contains("every candidate was refused")
        })
        XCTAssertEqual(projection.availability, .current)
    }

    func testRefreshRetainsOnlyFailedRouteCategoryAndReplacesItsWarning() throws {
        let prior = ShellInspectorPresenter.present(.init(routeInspectionReads: [
            try routeRead(category: "standard_coding", revision: 1),
            try routeRead(category: "complex_coding", revision: 1),
        ]))
        let firstRefresh = ShellInspectorPresenter.present(.init(routeInspectionReads: [
            try routeRead(category: "standard_coding", revision: 2),
            InspectorRouteInspectionRead(
                category: "complex_coding",
                result: .refused(detail: "first refusal")),
        ]))
        let retained = try XCTUnwrap(ShellInspectorPresenter.retainingObservedValue(
            from: prior,
            on: firstRefresh))
        guard case .present(let firstFacts) = retained.task.routeInspections else {
            return XCTFail("mixed route reads must retain and update category facts")
        }
        XCTAssertTrue(firstFacts.contains {
            $0.label == "standard_coding" && $0.value.contains("policy r2")
        })
        XCTAssertTrue(firstFacts.contains {
            $0.label == "complex_coding" && $0.value.contains("policy r1")
        })
        XCTAssertFalse(firstFacts.contains { $0.value.contains("first refusal") })
        XCTAssertEqual(
            retained.banners.filter { $0.text.contains("first refusal") }.count,
            1)

        let secondRefresh = ShellInspectorPresenter.present(.init(routeInspectionReads: [
            try routeRead(category: "standard_coding", revision: 3),
            InspectorRouteInspectionRead(
                category: "complex_coding",
                result: .refused(detail: "second refusal")),
        ]))
        let replaced = try XCTUnwrap(ShellInspectorPresenter.retainingObservedValue(
            from: retained,
            on: secondRefresh))
        guard case .present(let secondFacts) = replaced.task.routeInspections else {
            return XCTFail("a repeated failure must keep only that category's last facts")
        }
        XCTAssertTrue(secondFacts.contains {
            $0.label == "standard_coding" && $0.value.contains("policy r3")
        })
        XCTAssertTrue(secondFacts.contains {
            $0.label == "complex_coding" && $0.value.contains("policy r1")
        })
        XCTAssertFalse(replaced.banners.contains { $0.text.contains("first refusal") })
        XCTAssertEqual(
            replaced.banners.filter { $0.text.contains("second refusal") }.count,
            1)
    }

    func testEmptyTaskScopeIsDistinctFromAbsentTaskScope() throws {
        let wire = """
        {
          "schemaVersion": 3,
          "nodeId": "node_018f4f5e-0000-7000-8000-000000000104",
          "runId": "run_018f4f5e-0000-7000-8000-000000000001",
          "entityRevision": "2",
          "parentNodeId": {"availability":"present","value":null},
          "ownerNodeId": {"availability":"present","value":null},
          "organizationalRole": {"availability":"present","value":"worker"},
          "assignmentKind": {"availability":"present","value":"author"},
          "taskScope": {"availability":"present","value":[]},
          "lifecycle": {"availability":"present","value":"active"},
          "binding": {"availability":"absent","reason":"unmeasured","detail":"no binding"}
        }
        """
        let node = try JSONDecoder().decode(
            HierarchyNodeProjection.self, from: Data(wire.utf8))
        let projection = ShellInspectorPresenter.present(.init(node: node))
        XCTAssertTrue(projection.task.facts.contains {
            $0.label == "Task scope" && $0.value.contains("empty")
        })

        let absentWire = wire.replacingOccurrences(
            of: #""taskScope": {"availability":"present","value":[]}"#,
            with: #""taskScope": {"availability":"absent","reason":"unmeasured","detail":"task scope not recorded"}"#)
        let absentNode = try JSONDecoder().decode(
            HierarchyNodeProjection.self, from: Data(absentWire.utf8))
        let absent = ShellInspectorPresenter.present(.init(node: absentNode))
        XCTAssertTrue(absent.task.facts.contains {
            $0.label == "Task scope" && $0.value.contains("unmeasured")
        })
    }

    func testStrandedAndRunDecisionsSurfaceWhenPresent() throws {
        let path = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/hierarchy-projection-v2-corpus.json")
        let data = try Data(contentsOf: path)
        struct Payload: Codable, Equatable {
            let run: HierarchyRunProjection
            let node: HierarchyNodeProjection
            let incident: HierarchyIncidentProjection
            let stranded: HierarchyStrandedManifestProjection
        }
        let rows = try JSONDecoder().decode(
            [ClientProjection<Payload>].self, from: data)
        let value = try XCTUnwrap(rows.first { $0.availability == .current }?.value)
        let projection = ShellInspectorPresenter.present(.init(
            node: value.node,
            run: value.run,
            incident: value.incident,
            stranded: value.stranded))
        guard case .present(let decisions) = projection.task.runDecisions else {
            return XCTFail("run decisions from the hierarchy corpus must present")
        }
        XCTAssertFalse(decisions.isEmpty)
        guard case .present(let stranded) = projection.task.stranded else {
            return XCTFail("stranded WorkManifest from the corpus must present")
        }
        XCTAssertTrue(stranded.contains { $0.label == "emma" })
        XCTAssertTrue(stranded.contains {
            $0.label == "Recovery actions"
                && $0.value.contains("no frozen Workspace client wire")
        })
        XCTAssertTrue(projection.task.facts.contains {
            $0.label == "Phase" && $0.value == "P3"
        })
        XCTAssertTrue(projection.task.facts.contains {
            $0.label == "Assignment" && $0.value == "lead-coordination"
        })
    }

    func testExplicitMissingSelectionDoesNotFallBackToAnotherAgent() {
        let snapshot = WorkspaceStatusSnapshot(
            instanceId: "i",
            seq: "1",
            entities: [
                .init(
                    kind: "agent", id: "agent-a", generation: 1,
                    entityRevision: "1", projection: ["provider": .string("codex")]),
            ],
            createdAt: "2026-07-30T20:00:00.000Z",
            contentSha256: "deadbeef")
        let projection = ShellInspectorPresenter.present(.init(
            snapshot: snapshot,
            snapshotAvailability: .current,
            selectedAgentId: "agent-missing"))
        XCTAssertEqual(projection.session.title, "No agent entity in snapshot")
        XCTAssertFalse(projection.session.facts.contains { $0.label == "Agent" })
    }

    func testSessionExtraFieldsAreBounded() {
        var fields: [String: WorkspaceJSONValue] = [
            "activity": .string("working"),
            "provider": .string("codex"),
        ]
        for index in 0..<30 { fields["future-\(index)"] = .string("value-\(index)") }
        let snapshot = WorkspaceStatusSnapshot(
            instanceId: "i",
            seq: "1",
            entities: [
                .init(
                    kind: "agent", id: "agent-a", generation: 1,
                    entityRevision: "1", projection: fields),
            ],
            createdAt: "2026-07-30T20:00:00.000Z",
            contentSha256: "deadbeef")
        let projection = ShellInspectorPresenter.present(.init(
            snapshot: snapshot,
            snapshotAvailability: .current,
            selectedAgentId: "agent-a"))
        XCTAssertEqual(
            projection.session.facts.filter { $0.label.hasPrefix("future-") }.count,
            12)
    }
}
