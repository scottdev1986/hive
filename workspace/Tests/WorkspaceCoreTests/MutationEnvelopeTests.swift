// MutationEnvelopeTests.swift
//
// Pins the one generic command shape used by every Workspace mutation.

import Foundation
import XCTest
@testable import WorkspaceCore

final class MutationEnvelopeTests: XCTestCase {
    private struct Body: Codable, Equatable, Sendable {
        let operation: String
    }

    private struct PostState: Codable, Equatable, Sendable {
        let revision: String
        let state: String
    }

    private struct Corpus: Codable, Equatable, Sendable {
        let schemaVersion: Int
        let intents: [MutationIntent<Body>]
        let results: [MutationResult<PostState>]
    }

    private func wireFixture() throws -> Data {
        let url = try XCTUnwrap(
            Bundle.module.url(
                forResource: "mutation-envelope-wire",
                withExtension: "json",
                subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    func testGoldenWireFixtureRoundTrips() throws {
        let corpus = try JSONDecoder().decode(Corpus.self, from: wireFixture())
        XCTAssertEqual(corpus.schemaVersion, 1)
        XCTAssertEqual(corpus.intents.count, 3)
        XCTAssertEqual(corpus.results.count, 2)
        XCTAssertEqual(
            corpus.results.map(\.operationID),
            ["operation-accepted", "operation-rejected"])
        for result in corpus.results {
            XCTAssertEqual(
                result.postStateToken,
                .revision(result.observedPostState.revision))
        }

        let encoded = try JSONEncoder().encode(corpus)
        XCTAssertEqual(
            try JSONDecoder().decode(Corpus.self, from: encoded),
            corpus)
        XCTAssertEqual(
            try canonicalJSON(wireFixture()),
            try canonicalJSON(encoded))
    }

    func testIntentRoundTripsEveryConcurrencyExpectation() throws {
        let expectations: [MutationExpectation] = [
            .revision("7"),
            .epoch("3"),
            .revisionAndEpoch(revision: "7", epoch: "3"),
        ]

        for expected in expectations {
            let intent = MutationIntent(
                intentID: "intent-1",
                expected: expected,
                idempotencyKey: "retry-safe-1",
                body: Body(operation: "example"))
            let encoded = try JSONEncoder().encode(intent)
            XCTAssertEqual(
                try JSONDecoder().decode(MutationIntent<Body>.self, from: encoded),
                intent)

            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: encoded) as? [String: Any])
            XCTAssertEqual(object["intentId"] as? String, "intent-1")
            XCTAssertNil(object["intentID"])
        }
    }

    func testAcceptedAndRejectedResultsAlwaysCarryObservedPostState() throws {
        let postState = PostState(revision: "8", state: "enabled")
        let results = [
            try MutationResult(
                intentID: "intent-accepted",
                operationID: "operation-accepted",
                postStateToken: .revision("8"),
                outcome: .accepted,
                observedPostState: postState),
            try MutationResult(
                intentID: "intent-rejected",
                operationID: "operation-rejected",
                postStateToken: .revision("8"),
                outcome: .rejected(
                    MutationFailure(
                        code: "revision-conflict",
                        message: "expected revision 7; observed 8")),
                observedPostState: postState),
        ]

        for result in results {
            let encoded = try JSONEncoder().encode(result)
            let decoded = try JSONDecoder().decode(
                MutationResult<PostState>.self,
                from: encoded)
            XCTAssertEqual(decoded, result)
            XCTAssertEqual(decoded.observedPostState, postState)
            XCTAssertEqual(decoded.postStateToken, .revision(postState.revision))
            XCTAssertFalse(decoded.operationID.isEmpty)
        }
    }

    func testResultRoundTripsEveryPostStateTokenShape() throws {
        let tokens: [MutationExpectation] = [
            .revision("8"),
            .epoch("4"),
            .revisionAndEpoch(revision: "8", epoch: "4"),
        ]
        for token in tokens {
            let result = try MutationResult(
                intentID: "intent-1",
                operationID: "operation-1",
                postStateToken: token,
                outcome: .accepted,
                observedPostState: PostState(
                    revision: "8",
                    state: "enabled"))
            XCTAssertEqual(
                try JSONDecoder().decode(
                    MutationResult<PostState>.self,
                    from: JSONEncoder().encode(result)),
                result)
        }
    }

    func testResultRequiresServerOperationIDAndPostStateToken() {
        let missingToken = Data(
            #"""
            {
              "schemaVersion": 1,
              "intentId": "intent-1",
              "operationId": "operation-1",
              "outcome": {"status":"accepted"},
              "observedPostState": {"revision":"8","state":"enabled"}
            }
            """#.utf8)
        XCTAssertThrowsError(
            try JSONDecoder().decode(
                MutationResult<PostState>.self,
                from: missingToken))

        let emptyOperationID = Data(
            #"""
            {
              "schemaVersion": 1,
              "intentId": "intent-1",
              "operationId": "",
              "postStateToken": {"kind":"revision","revision":"8"},
              "outcome": {"status":"accepted"},
              "observedPostState": {"revision":"8","state":"enabled"}
            }
            """#.utf8)
        XCTAssertThrowsError(
            try JSONDecoder().decode(
                MutationResult<PostState>.self,
                from: emptyOperationID))
    }

    func testRejectedOutcomeRequiresStructuredFailure() {
        let wire = Data(
            #"{"status":"rejected"}"#.utf8)
        XCTAssertThrowsError(
            try JSONDecoder().decode(MutationOutcome.self, from: wire))
    }

    func testAcceptedOutcomeRejectsFailureFromTheOtherCase() {
        let wire = Data(
            #"{"status":"accepted","failure":{"code":"conflict","message":"stale"}}"#.utf8)
        XCTAssertThrowsError(
            try JSONDecoder().decode(MutationOutcome.self, from: wire))
    }

    func testExpectationRejectsConcurrencyTokenFromTheOtherCase() {
        let wire = Data(
            #"{"kind":"revision","revision":"7","epoch":"3"}"#.utf8)
        XCTAssertThrowsError(
            try JSONDecoder().decode(MutationExpectation.self, from: wire))
    }

    func testIntentCannotDecodeWithoutARevisionOrEpochExpectation() {
        let wire = Data(
            #"""
            {
              "schemaVersion": 1,
              "intentId": "intent-1",
              "expected": {},
              "idempotencyKey": "retry-safe-1",
              "body": {"operation":"example"}
            }
            """#.utf8)
        XCTAssertThrowsError(
            try JSONDecoder().decode(MutationIntent<Body>.self, from: wire))
    }
}
