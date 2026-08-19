import Foundation
import XCTest
@testable import HiveWorkspace
import WorkspaceCore

/// The whole point of Close Agent is that it is not a second kill. These pin the
/// wire: the same route `hive kill` posts to, the pane's exact session locator
/// that route demands, and the one field the CLI never sends.
final class AgentKillGatewayTests: XCTestCase {
    func testCloseGoesThroughTheSameKillRouteAndFlagsTheUser() async throws {
        var seen: [String: Any] = [:]
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer user",
            loader: { request in
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.url?.path, "/agents/maya/kill")
                seen = try XCTUnwrap(
                    JSONSerialization.jsonObject(
                        with: try XCTUnwrap(request.httpBody)) as? [String: Any])
                return (Data(#"{"reaped":{"survivors":[]},"preserved":null}"#.utf8),
                        response(request, status: 200))
            })

        let outcome = try await AgentKillGateway(client: client)
            .closeAgent(name: "maya", locator: locator())

        XCTAssertEqual(seen["userClosed"] as? Bool, true)
        let sent = try XCTUnwrap(seen["sessionLocator"] as? [String: Any])
        XCTAssertEqual(sent["generation"] as? Int, 4)
        XCTAssertEqual(
            sent["sessionId"] as? String, "ses_018f1e90-7b5a-7cc0-8000-000000000001")
        XCTAssertEqual(outcome.reaped.survivors, [])
        XCTAssertNil(outcome.preserved)
    }

    func testAPreservedWorktreeComesBackFromTheKillItself() async throws {
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer user",
            loader: { request in
                (Data(#"""
                {"reaped":{"survivors":[]},
                 "preserved":{"branch":"hive/maya-server",
                   "ref":"refs/hive-preserved/hive/maya-server"}}
                """#.utf8), response(request, status: 200))
            })

        let outcome = try await AgentKillGateway(client: client)
            .closeAgent(name: "maya", locator: locator())

        XCTAssertEqual(outcome.preserved?.branch, "hive/maya-server")
        XCTAssertEqual(outcome.preserved?.ref, "refs/hive-preserved/hive/maya-server")
    }

    func testSurvivingProcessesComeBackSoTheUserCanBeTold() async throws {
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer user",
            loader: { request in
                (Data(#"""
                {"reaped":{"survivors":[{"pid":4100,"command":"codex"}]},
                 "preserved":null}
                """#.utf8), response(request, status: 200))
            })

        let outcome = try await AgentKillGateway(client: client)
            .closeAgent(name: "maya", locator: locator())

        XCTAssertEqual(outcome.reaped.survivors.count, 1)
        XCTAssertEqual(outcome.reaped.survivors.first?.pid, 4_100)
    }

    func testARefusalCarriesTheDaemonsOwnReasonRatherThanASilentFailure() async throws {
        let client = WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            authorization: "Bearer user",
            loader: { request in
                (Data(#"""
                {"state":"rejected","reason":"session-locator-mismatch",
                 "error":"Hive refused to kill maya: its session generation changed"}
                """#.utf8), response(request, status: 409))
            })

        do {
            _ = try await AgentKillGateway(client: client)
                .closeAgent(name: "maya", locator: locator())
            XCTFail("a 409 must not read back as a successful close")
        } catch {
            XCTAssertTrue(
                error.localizedDescription.contains("its session generation changed"),
                error.localizedDescription)
            XCTAssertTrue(error.localizedDescription.contains("409"))
        }
    }

    private func locator() -> AgentSessionLocator {
        AgentSessionLocator(
            instanceId: "rig",
            subject: AgentSessionSubject(kind: "agent", agentId: "id-maya"),
            generation: 4,
            sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000001",
            hostKind: "sessiond",
            engineBuildId: "engine")
    }
}

private func response(_ request: URLRequest, status: Int) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!, statusCode: status,
        httpVersion: nil, headerFields: nil)!
}
