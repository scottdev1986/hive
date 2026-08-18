import Foundation
import XCTest
@testable import HiveWorkspace
import WorkspaceCore

final class LiveRunControlGatewayTests: XCTestCase {
    func testReadNamesTheExactAgentAndDecodesTheDaemonProjection() async throws {
        let projection = try controlProjection()
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer user",
            loader: { request in
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/live-run-control")
                XCTAssertEqual(
                    URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                        .queryItems?.first(where: { $0.name == "agentId" })?.value,
                    "id-a")
                return (try JSONEncoder().encode(projection), response(request, status: 200))
            })

        let result = await LiveRunControlGateway(client: client).fetch(agentID: "id-a")

        XCTAssertEqual(result.value, projection)
        XCTAssertEqual(result.source.revision, "1")
    }

    func testMutationUsesTheSharedEnvelopeAndDecodesFinalStateOnAcceptance() async throws {
        let projection = try controlProjection()
        let body = try LiveRunControlBody(operation: .stopProvider, projection: projection)
        let intent = MutationIntent(
            intentID: "intent-stop",
            expected: .epoch("1"),
            idempotencyKey: "idempotency-stop",
            body: body)
        let final = try MutationResult(
            intentID: intent.intentID,
            operationID: "lro_operation",
            postStateToken: .epoch("1"),
            outcome: .accepted,
            observedPostState: projection)
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer user",
            loader: { request in
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.url?.path, "/live-run-control")
                let sent = try JSONDecoder().decode(
                    MutationIntent<LiveRunControlBody>.self,
                    from: try XCTUnwrap(request.httpBody))
                XCTAssertEqual(sent, intent)
                return (try JSONEncoder().encode(final), response(request, status: 200))
            })

        let result = try await LiveRunControlGateway(client: client).submit(intent)

        XCTAssertEqual(result, final)
        XCTAssertEqual(result.observedPostState.locator, projection.locator)
    }

    private func controlProjection() throws -> LiveRunControlProjection {
        try JSONDecoder().decode(LiveRunControlProjection.self, from: Data(#"""
        {"schemaVersion":1,"observedAt":"2026-08-15T20:00:00.000Z",
         "agentId":"id-a","agentName":"a","provider":"codex",
         "locator":{"schemaVersion":1,"instanceId":"rig",
           "subject":{"kind":"agent","agentId":"id-a"},"generation":1,
           "sessionId":"ses_018f1e90-7b5a-7cc0-8000-000000000001",
           "hostKind":"sessiond","engineBuildId":"engine"},
         "providerRun":{"state":"running","runId":"018f1e90-7b5a-7cc0-8000-000000000902",
           "provider":"codex","process":{"pid":4100,"startToken":"4100:1",
           "processGroupId":4100,"observedAt":"2026-08-15T20:00:00.000Z"}},
         "shell":{"state":"retained","root":{"pid":4000,"startToken":"4000:1",
           "processGroupId":4000},"foreground":"provider"},
         "processCensus":{"state":"complete","source":"sessiond-process-tree",
           "members":[{"pid":4000,"startToken":"4000:1"},{"pid":4100,"startToken":"4100:1"}],
           "observedAt":"2026-08-15T20:00:00.000Z"},
         "termination":{"state":"not-requested"},
         "controls":{"stopProvider":{"enabled":true,"reason":null},
           "terminateTerminal":{"enabled":true,"reason":null}}}
        """#.utf8))
    }
}

private func response(_ request: URLRequest, status: Int) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!, statusCode: status,
        httpVersion: nil, headerFields: nil)!
}
