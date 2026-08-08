// WorkspaceDaemonClientTests.swift
//
// Exercises descriptor decoding and transport-state mapping without a daemon.

import Foundation
import XCTest
@testable import HiveWorkspace
import WorkspaceCore

final class WorkspaceDaemonClientTests: XCTestCase {
    private struct Value: Codable, Equatable, Sendable {
        let revision: Int
        let observedAt: String
    }

    private let endpoint = WorkspaceReadEndpoint<Value>(
        path: "test",
        source: { ProjectionSource(revision: String($0.revision)) },
        observedAt: { $0.observedAt })

    private func routingPolicy() throws -> RoutingPolicyDocument {
        let fixture = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("WorkspaceCoreTests/Fixtures/routing-policy-corpus.json")
        let rows = try JSONDecoder().decode(
            [ClientProjection<RoutingPolicyDocument>].self,
            from: Data(contentsOf: fixture))
        return try XCTUnwrap(rows.first { $0.availability == .current }?.value)
    }

    private func queenProjectionData(
        mutating body: (inout [String: Any]) -> Void
    ) throws -> Data {
        let fixture = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("WorkspaceCoreTests/Fixtures/queen-provider-corpus.json")
        let rows = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [[String: Any]])
        var current = try XCTUnwrap(rows.first { $0["availability"] as? String == "current" })
        var value = try XCTUnwrap(current["value"] as? [String: Any])
        body(&value)
        current["value"] = value
        return try JSONSerialization.data(withJSONObject: current["value"]!)
    }

    func testSuccessfulReadDoesNotReclassifyBackendEvidenceByClientClock() async throws {
        let data = try JSONEncoder().encode(Value(
            revision: 7, observedAt: "2026-07-30T20:00:00Z"))
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer test",
            loader: { request in
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test")
                return (data, HTTPURLResponse(
                    url: request.url!, statusCode: 200,
                    httpVersion: nil, headerFields: nil)!)
            })
        let projection = await client.fetch(endpoint)
        XCTAssertEqual(projection.availability, .current)
        XCTAssertEqual(projection.freshness, .current)
        XCTAssertEqual(projection.value?.revision, 7)
        XCTAssertEqual(projection.observedAt, "2026-07-30T20:00:00Z")
    }

    func testObservedTimestampIsPreservedWithoutClientInterpretation() async throws {
        let data = try JSONEncoder().encode(Value(
            revision: 7, observedAt: "2026-07-30T20:00:00.344Z"))
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer test",
            loader: { request in
                (data, HTTPURLResponse(
                    url: request.url!, statusCode: 200,
                    httpVersion: nil, headerFields: nil)!)
            })
        let projection = await client.fetch(endpoint)
        XCTAssertEqual(projection.availability, .current)
        XCTAssertEqual(projection.freshness, .current)
        XCTAssertEqual(projection.observedAt, "2026-07-30T20:00:00.344Z")
    }

    func testUnauthorizedKeepsTheDaemonRefusalCode() async {
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer refused",
            loader: { request in
                (Data(#"{"code":"routing-policy-read-denied"}"#.utf8), HTTPURLResponse(
                    url: request.url!, statusCode: 403,
                    httpVersion: nil, headerFields: nil)!)
            })
        let projection = await client.fetch(endpoint)
        XCTAssertEqual(projection.availability, .unauthorized)
        XCTAssertEqual(
            projection.evidence,
            .unauthorized(refusalCode: "routing-policy-read-denied"))
    }

    func testTransportFailureNamesTheDisconnectFact() async {
        struct Lost: LocalizedError { var errorDescription: String? { "socket closed" } }
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer test",
            loader: { _ in throw Lost() })
        let projection = await client.fetch(endpoint)
        XCTAssertEqual(projection.availability, .disconnected)
        guard case .disconnected(let fact) = projection.evidence else {
            return XCTFail("disconnect evidence missing")
        }
        XCTAssertTrue(fact.contains("socket closed"))
    }

    func testDetailedReadKeepsDaemonRefusalSeparateFromTransportLoss() async {
        let refused = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer test",
            loader: { request in
                (Data(#"{"code":"route-refused","error":"candidate gate refused"}"#.utf8),
                 HTTPURLResponse(
                    url: request.url!, statusCode: 503,
                    httpVersion: nil, headerFields: nil)!)
            })
        switch await refused.fetchResult(endpoint) {
        case .refused(let status, let code, let detail):
            XCTAssertEqual(status, 503)
            XCTAssertEqual(code, .known("route-refused"))
            XCTAssertEqual(detail, "candidate gate refused")
        default:
            XCTFail("an HTTP answer must be a refusal, not a disconnect")
        }

        struct Lost: LocalizedError { var errorDescription: String? { "socket closed" } }
        let disconnected = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer test",
            loader: { _ in throw Lost() })
        switch await disconnected.fetchResult(endpoint) {
        case .projection(let projection):
            XCTAssertEqual(projection.availability, .disconnected)
        default:
            XCTFail("only the thrown transport error should be disconnected")
        }
    }

    func testDetailedReadKeepsEpochReasonAndMessageVerbatim() async {
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer stale",
            loader: { request in
                (Data(
                    #"{"error":"capability epoch 4 is stale; current epoch is 5","reason":"stale-epoch"}"#
                        .utf8),
                 HTTPURLResponse(
                    url: request.url!, statusCode: 403,
                    httpVersion: nil, headerFields: nil)!)
            })

        switch await client.fetchResult(endpoint) {
        case .refused(let status, let code, let detail):
            XCTAssertEqual(status, 403)
            XCTAssertEqual(code, .known("stale-epoch"))
            XCTAssertEqual(detail, "capability epoch 4 is stale; current epoch is 5")
        default:
            XCTFail("the daemon's epoch refusal must remain an HTTP refusal")
        }
    }

    func testCodelessRefusalIsTypedUnknownAndKeepsNonJSONDetailVerbatim() async {
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer test",
            loader: { request in
                (Data("future gateway refusal".utf8), HTTPURLResponse(
                    url: request.url!, statusCode: 503,
                    httpVersion: nil, headerFields: nil)!)
            })

        switch await client.fetchResult(endpoint) {
        case .refused(let status, let code, let detail):
            XCTAssertEqual(status, 503)
            XCTAssertEqual(code, .unknown)
            XCTAssertEqual(detail, "future gateway refusal")
            XCTAssertNotEqual(code.displayValue, "unauthorized")
        default:
            XCTFail("a codeless HTTP refusal must remain a typed unknown refusal")
        }
    }

    func testInvalidReadPayloadDoesNotBecomeDisconnected() async {
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer test",
            loader: { request in
                (Data(#"{"revision":"not-an-integer"}"#.utf8), HTTPURLResponse(
                    url: request.url!, statusCode: 200,
                    httpVersion: nil, headerFields: nil)!)
            })
        switch await client.fetchResult(endpoint) {
        case .invalid(let detail):
            XCTAssertFalse(detail.isEmpty)
        default:
            XCTFail("a schema failure must remain invalid, not disconnected")
        }
    }

    func testQueenSchemaDriftOnGetIsNotReportedAsTransportLoss() async throws {
        let drifted = try queenProjectionData { $0["schemaVersion"] = 2 }
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer test",
            loader: { request in
                (drifted, HTTPURLResponse(
                    url: request.url!, statusCode: 200,
                    httpVersion: nil, headerFields: nil)!)
            })

        let projection = await QueenProviderGateway(client: client).fetch()

        XCTAssertNotEqual(projection.availability, .disconnected)
        XCTAssertEqual(projection.availability, .unknown)
        guard case .protocolDrift = projection.evidence else {
            return XCTFail("a live but unreadable response must name protocol drift")
        }
    }

    func testQueenSchemaDriftOnPostUsesTheSharedProtocolError() async throws {
        let drifted = try queenProjectionData { $0["schemaVersion"] = 2 }
        let body = try JSONSerialization.data(withJSONObject: [
            "receipt": [
                "operationId": "qpo_01234567-89ab-7cde-8fab-0123456789ab",
                "revision": "7",
            ],
            "projection": try JSONSerialization.jsonObject(with: drifted),
        ])
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer test",
            loader: { request in
                (body, HTTPURLResponse(
                    url: request.url!, statusCode: 200,
                    httpVersion: nil, headerFields: nil)!)
            })

        do {
            _ = try await QueenProviderGateway(client: client).submit(
                SetLiveQueenProviderBody(provider: "codex", expectedRevision: "6"),
                intentID: "drifted-post")
            XCTFail("a drifted response must not become a mutation result")
        } catch let error as WorkspaceDaemonClient.ResponseError {
            XCTAssertNotEqual(error.availability, .disconnected)
            XCTAssertEqual(error.availability, .unknown)
            guard case .protocolDrift = error.evidence else {
                return XCTFail("a live but unreadable response must name protocol drift")
            }
        }
    }

    func testQueenPostProtocolErrorRendersAsProtocolMismatchNotDisconnect() {
        let screen = WorkspaceShellDelegate.screen(
            from: .protocolDrift("queen provider schema version 2"))

        XCTAssertNotEqual(screen.availability, .disconnected)
        XCTAssertEqual(screen.stateHeadline, "Protocol mismatch")
        XCTAssertTrue(screen.stateExplanation.contains("No transport loss is claimed"))
        guard case .protocolDrift = screen.evidence else {
            return XCTFail("the delegate must retain the protocol classification")
        }
    }

    func testQueenReceiptAndConflictRejectNonWireOperationAndRevisionValues() async throws {
        let current = try queenProjectionData { _ in }
        let currentObject = try JSONSerialization.jsonObject(with: current)
        let cases = try [
            (200, JSONSerialization.data(withJSONObject: [
                "receipt": [
                    "operationId": "not-qpo",
                    "revision": "7",
                ],
                "projection": currentObject,
            ])),
            (200, JSONSerialization.data(withJSONObject: [
                "receipt": [
                    "operationId": "qpo_01234567-89ab-6cde-8fab-0123456789ab",
                    "revision": "7",
                ],
                "projection": currentObject,
            ])),
            (200, JSONSerialization.data(withJSONObject: [
                "receipt": [
                    "operationId": "qpo_01234567-89ab-7cde-7fab-0123456789ab",
                    "revision": "7",
                ],
                "projection": currentObject,
            ])),
            (200, JSONSerialization.data(withJSONObject: [
                "receipt": [
                    "operationId": "qpo_01234567-89ab-7cde-8fab-0123456789ab",
                    "revision": "NaN",
                ],
                "projection": currentObject,
            ])),
            (200, JSONSerialization.data(withJSONObject: [
                "receipt": [
                    "operationId": "qpo_01234567-89ab-7cde-8fab-0123456789ab",
                    "revision": "18446744073709551616",
                ],
                "projection": currentObject,
            ])),
            (409, JSONSerialization.data(withJSONObject: [
                "error": "revision conflict",
                "currentRevision": "01",
                "projection": currentObject,
            ])),
        ]

        for (status, response) in cases {
            let client = WorkspaceDaemonClient(
                baseURL: URL(string: "http://127.0.0.1:9999")!,
                authorization: "Bearer test",
                loader: { request in
                    (response, HTTPURLResponse(
                        url: request.url!, statusCode: status,
                        httpVersion: nil, headerFields: nil)!)
                })
            do {
                _ = try await QueenProviderGateway(client: client).submit(
                    SetLiveQueenProviderBody(provider: "codex", expectedRevision: "6"),
                    intentID: "invalid-wire")
                XCTFail("a strict wire violation must not produce a mutation result")
            } catch let error as WorkspaceDaemonClient.ResponseError {
                guard case .protocolDrift = error else {
                    return XCTFail("a rejected wire value must not become a transport loss")
                }
            }
        }
    }

    /// `route` is nullable but REQUIRED on the wire (`RoutePolicySchema
    /// .nullable()` inside a strict object). Swift's synthesized encoder omits
    /// a nil Optional, so clearing a category would send no `route` key at all
    /// and the daemon would refuse the whole mutation with a 400 — the clear
    /// would never happen and the screen would blame the connection.
    func testProbeClearRouteEncodesTheWireRequiredNull() async throws {
        var sent: Data?
        let policy = try routingPolicy()
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer test",
            loader: { request in
                if request.httpMethod == "POST" {
                    sent = request.httpBody
                    return (Data(), HTTPURLResponse(
                        url: request.url!, statusCode: 200, httpVersion: nil,
                        headerFields: ["x-hive-operation-id": "operation-clear"])!)
                }
                return (try JSONEncoder().encode(policy), HTTPURLResponse(
                    url: request.url!, statusCode: 200,
                    httpVersion: nil, headerFields: nil)!)
            })
        _ = try await RoutingPolicyGateway(client: client).submit(MutationIntent(
            intentID: "intent-clear", expected: .revision("6"),
            idempotencyKey: "intent-clear",
            body: RoutingPolicyMutationBody(
                expectedRevision: 6, scope: "complex_coding", route: nil)))

        let body = try XCTUnwrap(sent.flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        })
        XCTAssertTrue(body.keys.contains("route"), "the wire requires the key to be present")
        XCTAssertTrue(body["route"] is NSNull, "a cleared route is an explicit null")
        XCTAssertEqual(body["op"] as? String, "set-route")
        XCTAssertEqual(body["scope"] as? String, "complex_coding")
    }

    /// Losing the socket on the post-write read-back is the opposite fact from
    /// a refusal: the POST already reached the daemon and may have committed.
    /// Reporting it as a refusal would leave the old projection on screen
    /// marked current and mutable while the stored policy had moved.
    func testProbeLostPostWriteReadBackIsNotReportedAsADaemonRefusal() async throws {
        struct Lost: LocalizedError { var errorDescription: String? { "socket closed" } }
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer test",
            loader: { request in
                guard request.httpMethod == "POST" else { throw Lost() }
                return (Data(), HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: nil,
                    headerFields: ["x-hive-operation-id": "operation-committed"])!)
            })
        do {
            _ = try await RoutingPolicyGateway(client: client).submit(MutationIntent(
                intentID: "intent-lost", expected: .revision("6"),
                idempotencyKey: "intent-lost",
                body: RoutingPolicyMutationBody(
                    expectedRevision: 6, scope: "complex_coding", route: nil)))
            XCTFail("a write with no readable post-state must not report success")
        } catch RoutingPolicyGateway.GatewayError.refused(let status) {
            XCTFail("a lost read-back was reported as a daemon refusal (HTTP \(status))")
        } catch RoutingPolicyGateway.GatewayError.postStateUnknown(let projection, let reason) {
            // The read attempt's own classification survives the write path.
            XCTAssertEqual(projection.availability, .disconnected)
            guard case .disconnected(let fact) = projection.evidence else {
                return XCTFail("the transport fact must travel with the error")
            }
            XCTAssertTrue(fact.contains("socket closed"))
            XCTAssertTrue(
                reason.contains("may have been applied"),
                "the ambiguity must be stated, not hidden: \(reason)")
        }
    }

    /// The same path with an authorized-but-refused read keeps THAT
    /// classification too, rather than collapsing every failure into one.
    func testAnUnauthorizedPostWriteReadBackStaysUnauthorized() async throws {
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer test",
            loader: { request in
                if request.httpMethod == "POST" {
                    return (Data(), HTTPURLResponse(
                        url: request.url!, statusCode: 200, httpVersion: nil,
                        headerFields: ["x-hive-operation-id": "operation-committed"])!)
                }
                return (Data(#"{"code":"routing-policy-read-denied"}"#.utf8), HTTPURLResponse(
                    url: request.url!, statusCode: 403,
                    httpVersion: nil, headerFields: nil)!)
            })
        do {
            _ = try await RoutingPolicyGateway(client: client).submit(MutationIntent(
                intentID: "intent-denied", expected: .revision("6"),
                idempotencyKey: "intent-denied",
                body: RoutingPolicyMutationBody(
                    expectedRevision: 6, scope: "complex_coding", route: nil)))
            XCTFail("a write with no readable post-state must not report success")
        } catch RoutingPolicyGateway.GatewayError.postStateUnknown(let projection, _) {
            XCTAssertEqual(projection.availability, .unauthorized)
            XCTAssertEqual(
                projection.evidence, .unauthorized(refusalCode: "routing-policy-read-denied"))
        }
    }

    func testRoutingConflictSurfacesDaemonOperationAndObservedPostState() async throws {
        var competing = try routingPolicy()
        competing.revision += 1
        let postData = try JSONEncoder().encode(competing)
        var requests: [URLRequest] = []
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer test",
            loader: { request in
                requests.append(request)
                if request.httpMethod == "POST" {
                    return (Data(), HTTPURLResponse(
                        url: request.url!, statusCode: 409, httpVersion: nil,
                        headerFields: ["x-hive-operation-id": "operation-409"])!)
                }
                return (postData, HTTPURLResponse(
                    url: request.url!, statusCode: 200,
                    httpVersion: nil, headerFields: nil)!)
            })
        let intent = MutationIntent(
            intentID: "intent-409", expected: .revision("6"),
            idempotencyKey: "intent-409",
            body: RoutingPolicyMutationBody(
                expectedRevision: 6, scope: "complex_coding", route: nil))
        let result = try await RoutingPolicyGateway(client: client).submit(intent)
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "GET"])
        XCTAssertEqual(result.operationID, "operation-409")
        XCTAssertEqual(result.postStateToken, .revision(String(competing.revision)))
        XCTAssertEqual(result.observedPostState, competing)
        guard case .rejected(let failure) = result.outcome else {
            return XCTFail("conflict was not rejected")
        }
        XCTAssertEqual(failure.code, "revision-conflict")
    }
}
