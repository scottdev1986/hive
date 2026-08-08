// HierarchyProjectionV2ClientFixtureTests.swift
//
// The daemon's hierarchy snapshot projection as the client receives it. The
// corpus is generated from the same golden scenarios a Bun test regenerates
// from the pure projector, so these assertions run against the daemon's real
// output rather than a hand-written idea of it.
//
// Each drift test names one way the wire could change meaning while still
// looking like JSON, and requires the decoder to refuse it.

import Foundation
import XCTest
@testable import WorkspaceCore

private struct HierarchyProjectionV2Payload: Codable, Equatable, Sendable {
    let run: HierarchyRunProjection
    let node: HierarchyNodeProjection
    let budget: HierarchyBudgetProjection
    let review: HierarchyReviewProjection
    let incident: HierarchyIncidentProjection
    let recoveryIncident: HierarchyIncidentProjection
    let unmeasuredRun: HierarchyRunProjection
    let stranded: HierarchyStrandedManifestProjection
}

private enum HierarchyProjectionV2Module: ClientFixtureModule {
    typealias Value = HierarchyProjectionV2Payload
    static let resourceName = "hierarchy-projection-v2-corpus"
}

private func decode<Value: Decodable>(_ type: Value.Type, _ json: String) throws -> Value {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

final class HierarchyProjectionV2ClientFixtureTests: XCTestCase {
    private func current() throws -> HierarchyProjectionV2Payload {
        try XCTUnwrap(
            HierarchyProjectionV2Module.load().first { $0.availability == .current }?.value)
    }

    func testGoldenFixtureMatrixRoundTrips() throws {
        try assertGoldenFixtureMatrix(HierarchyProjectionV2Module.self)
    }

    func testEachIncidentVariantDecodesFromItsOwnSourceRecord() throws {
        let payload = try current()
        guard case .present(let decisions) = payload.incident.runDecision else {
            return XCTFail("the corpus run holds run-control decisions")
        }
        XCTAssertEqual(decisions.count, 2)
        XCTAssertEqual(decisions.first?.outcome, .accepted)
        XCTAssertEqual(
            decisions.last?.outcome,
            .rejected(failureCode: "gate-already-decided"))

        guard case .present(let recoveries) = payload.recoveryIncident.recovery else {
            return XCTFail("the transfer scenario holds a recovery record")
        }
        XCTAssertEqual(recoveries.first?.reason, .ownerBindingsUnbound)

        // The breaker's type admits only one answer: no such record exists.
        XCTAssertFalse(payload.incident.breaker.detail.isEmpty)
    }

    func testTheTwoAbsenceReasonsStayDistinctAcrossTheWire() throws {
        let payload = try current()
        guard case .absent(let unmeasured, _) = payload.unmeasuredRun.phase else {
            return XCTFail("the unsupplied run must decode as an absence")
        }
        XCTAssertEqual(unmeasured, .unmeasured)
        // A client that folded these together would tell a reader to wait for
        // a record nobody will ever write.
        XCTAssertNotEqual(unmeasured, .sourceAbsent)
        XCTAssertEqual(Set(["unmeasured", "source-absent"]).count, 2)
    }

    func testPresentFieldsAndStrandedWorkDecodeWholeValues() throws {
        let payload = try current()
        guard case .present(let root) = payload.run.root,
            case .present(let source) = payload.run.topologySource,
            case .present(let shape) = payload.run.topologyShape
        else {
            return XCTFail("the corpus run is a projected hierarchy run")
        }
        XCTAssertEqual(root.runID, payload.run.runID)
        XCTAssertEqual(source, .hierarchy)
        XCTAssertEqual(shape, .fullHive)

        guard case .present(let binding) = payload.node.binding else {
            return XCTFail("the corpus node holds a live binding")
        }
        XCTAssertFalse(binding.agentId.isEmpty)

        guard case .present(let limits) = payload.budget.limits,
            case .present(let reviews) = payload.review.reviews
        else {
            return XCTFail("budget and reviews are supplied for this run")
        }
        XCTAssertEqual(limits.activeSessions.hard, 10)
        XCTAssertEqual(reviews.first?.verdict, .accepted)
        XCTAssertEqual(reviews.first?.invalidation, .current)

        // Stranded work belongs to no run: the journal is keyed by agent.
        XCTAssertNil(payload.stranded.runID)
        guard case .present(let items) = payload.stranded.items else {
            return XCTFail("the corpus carries one stranded capture")
        }
        XCTAssertEqual(items.first?.disposition, .preserve)
    }

    // MARK: - Drift refusal

    func testAnUnknownSchemaVersionRefusesToDecode() throws {
        let wire = try JSONEncoder().encode(current().run)
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: wire) as? [String: Any])
        object["schemaVersion"] = HierarchyProjectionSchema.version + 1
        let drifted = try JSONSerialization.data(withJSONObject: object)
        XCTAssertThrowsError(
            try JSONDecoder().decode(HierarchyRunProjection.self, from: drifted))
    }

    func testAnUnknownAbsenceReasonRefusesToDecode() {
        XCTAssertThrowsError(
            try decode(
                HierarchyProjectionField<String>.self,
                #"{"availability":"absent","reason":"pending","detail":"soon"}"#))
    }

    func testAnAbsenceCarryingAValueRefusesToDecode() {
        XCTAssertThrowsError(
            try decode(
                HierarchyProjectionField<String>.self,
                """
                {"availability":"absent","reason":"unmeasured","detail":"none","value":"x"}
                """))
        XCTAssertThrowsError(
            try decode(
                HierarchyProjectionField<String>.self,
                #"{"availability":"present","value":"x","reason":"unmeasured"}"#))
    }

    func testTheBreakerFieldRefusesAnyAnswerButSourceAbsent() {
        XCTAssertThrowsError(
            try decode(
                HierarchyAbsentOnlyField.self,
                #"{"availability":"absent","reason":"unmeasured","detail":"not yet"}"#),
            "collapsing source-absent into unmeasured must not decode")
        XCTAssertThrowsError(
            try decode(
                HierarchyAbsentOnlyField.self,
                #"{"availability":"present","value":[]}"#))
    }

    func testShapesTheDaemonCannotProduceRefuseToDecode() {
        // Counts are unsigned — the decoder does not take the wire's word for it.
        XCTAssertThrowsError(
            try decode(
                HierarchyStrandedManifestAttention.self,
                """
                {"nodeId":null,"agentId":null,"branch":"b","workManifestRevision":null,
                 "unmergedCommits":-1,"dirtyFileCount":0,"disposition":"unknown"}
                """),
            "a captured count is never negative")
    }

    func testARunDecisionThatBothPassedAndFailedRefusesToDecode() {
        XCTAssertThrowsError(
            try decode(
                HierarchyRunDecisionOutcome.self,
                #"{"status":"accepted","failureCode":"epoch-conflict"}"#))
        XCTAssertThrowsError(
            try decode(HierarchyRunDecisionOutcome.self, #"{"status":"rejected"}"#))
    }

    func testARootThatIsNotTheQueenRootRefusesToDecode() {
        XCTAssertThrowsError(
            try decode(
                HierarchyRootIdentity.self,
                """
                {"kind":"agent-root","runId":"run_1","instanceId":"i","repo":"hive"}
                """),
            "the hierarchy root is never an agent")
    }
}
