import CryptoKit
import Foundation
import XCTest
@testable import WorkspaceCore

final class WorkspaceStatusReducerTests: XCTestCase {
    private struct Corpus: Decodable {
        struct CanonicalizationFixture: Decodable {
            let name: String
            let entities: [WorkspaceStatusSnapshot.Entity]
            let canonical: String
            let sha256: String
        }
        struct Scenario: Decodable {
            let name: String
            let events: [WorkspaceStatusEvent]
            let prefixes: [WorkspaceStatusProjection]
        }
        let canonicalization: [CanonicalizationFixture]
        let scenarios: [Scenario]
    }

    func testCanonicalSnapshotDigestsUseUTF16CodeUnitKeyOrder() throws {
        let corpus = try JSONDecoder().decode(
            Corpus.self,
            from: fixture("reducer-parity-corpus"))
        for fixture in corpus.canonicalization {
            let canonical = try workspaceCanonicalJSON(fixture.entities)
            XCTAssertEqual(canonical, fixture.canonical, fixture.name)
            let digest = SHA256.hash(data: Data(canonical.utf8))
                .map { String(format: "%02x", $0) }.joined()
            XCTAssertEqual(digest, fixture.sha256, fixture.name)
        }
    }

    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(
            forResource: name,
            withExtension: "json",
            subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    func testMatchesEveryPrefixInSharedBunSwiftCorpus() throws {
        let corpus = try JSONDecoder().decode(
            Corpus.self,
            from: fixture("reducer-parity-corpus"))
        for scenario in corpus.scenarios {
            var state = WorkspaceStatusProjection()
            for (index, event) in scenario.events.enumerated() {
                state = try WorkspaceStatusReducer.reduce(state, event: event)
                XCTAssertEqual(state, scenario.prefixes[index], "\(scenario.name) prefix \(index + 1)")
            }
        }
    }

    func testSnapshotVerificationAndResumeHighWater() throws {
        let entities = [WorkspaceStatusSnapshot.Entity(
            kind: "agent",
            id: "agent-fixture",
            generation: nil,
            entityRevision: "2",
            projection: ["kind": .string("status.turn")])]
        let canonical = try workspaceCanonicalJSON(entities)
        let digest = SHA256.hash(data: Data(canonical.utf8))
            .map { String(format: "%02x", $0) }.joined()
        let snapshot = WorkspaceStatusSnapshot(
            instanceId: "instance-fixture",
            seq: "2",
            entities: entities,
            createdAt: "2026-07-16T12:00:00.000Z",
            contentSha256: digest)
        let reconciled = try WorkspaceStatusReducer.reconcile(
            WorkspaceStatusProjection(
                highWaterSeq: "1",
                paused: true,
                recovery: "SNAPSHOT_REQUIRED"),
            snapshot: snapshot)
        XCTAssertEqual(reconciled.highWaterSeq, "2")
        XCTAssertFalse(reconciled.paused)
        XCTAssertNil(reconciled.recovery)
        XCTAssertThrowsError(try WorkspaceStatusReducer.reconcile(
            reconciled,
            snapshot: WorkspaceStatusSnapshot(
                instanceId: snapshot.instanceId,
                seq: snapshot.seq,
                entities: snapshot.entities,
                createdAt: snapshot.createdAt,
                contentSha256: String(repeating: "0", count: 64))))
    }

    func testVisibleCompositionUsesOnlyFreshReportProgressAndTypedAttention() {
        let fresh = WorkspaceVisibleStatusComposer.compose(
            report: WorkspaceStatusReportView(
                phase: "testing",
                summary: "Running parity",
                progress: 80,
                freshness: .fresh),
            providerLifecycle: WorkspaceStatusLifecycleView(value: "working", freshness: .fresh),
            terminalHealth: "healthy",
            unresolvedTypedAttention: .approval,
            sourceStack: ["agent-report", "provider-hook", "sessiond"],
            conflicts: [])
        XCTAssertEqual(fresh.primaryLabel, "testing: Running parity")
        XCTAssertEqual(fresh.progress, 80)
        XCTAssertEqual(fresh.attention, .approval)

        let stale = WorkspaceVisibleStatusComposer.compose(
            report: WorkspaceStatusReportView(
                phase: "testing",
                summary: "Old report",
                progress: 80,
                freshness: .stale),
            providerLifecycle: WorkspaceStatusLifecycleView(value: "working", freshness: .stale),
            terminalHealth: "healthy",
            unresolvedTypedAttention: nil,
            sourceStack: ["agent-report", "provider-hook", "sessiond"],
            conflicts: ["report/provider"])
        XCTAssertEqual(stale.primaryLabel, "working (stale)")
        XCTAssertNil(stale.progress)
        XCTAssertEqual(stale.attention, .none)
        XCTAssertEqual(stale.sourceStack, ["agent-report", "provider-hook", "sessiond"])
    }

    func testAttentionComesOnlyFromUnresolvedTypedEvents() {
        func event(
            _ id: String,
            kind: String,
            data: [String: WorkspaceJSONValue]
        ) -> WorkspaceStatusEvent {
            WorkspaceStatusEvent(
                eventId: id,
                seq: "1",
                entity: .init(kind: "agent", id: "agent-fixture", generation: nil),
                entityRevision: "1",
                occurredAt: "2026-07-16T12:00:00.000Z",
                kind: kind,
                source: .init(
                    kind: "provider-hook",
                    id: "hook-fixture",
                    observedAt: "2026-07-16T12:00:00.000Z",
                    confidence: "high"),
                data: data)
        }
        let raised = event("attention-1", kind: "status.attention", data: [
            "value": .string("approval"), "resolved": .boolean(false),
        ])
        let terminalHint = event("hint-1", kind: "terminal.hint", data: [
            "attention": .string("failure"),
        ])
        XCTAssertEqual(
            WorkspaceStatusAttentionReducer.unresolved(in: [terminalHint, raised]),
            .approval)
        let resolved = event("resolved-1", kind: "status.attention-resolved", data: [
            "causeEventId": .string(raised.eventId),
        ])
        XCTAssertNil(WorkspaceStatusAttentionReducer.unresolved(
            in: [terminalHint, raised, resolved]))
    }
}
