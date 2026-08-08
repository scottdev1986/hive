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

}
