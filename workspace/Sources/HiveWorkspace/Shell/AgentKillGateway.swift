import Foundation
import WorkspaceCore

/// Closing an agent from the sidebar goes through POST /agents/<name>/kill —
/// the same route `hive kill` posts to — so the close gets that kill's whole
/// teardown, including the worktree preservation that protects unlanded work.
/// A UI that reimplemented kill's side effects would drift from it and quietly
/// stop protecting what kill protects.
///
/// `userClosed` is the only thing this sends that the CLI does not. It changes
/// nothing about the kill; it is what lets the daemon tell the orchestrator
/// that a closure she did not order has happened.
struct AgentKillGateway {
    let client: WorkspaceDaemonClient

    /// What the daemon did, decoded from the kill's own answer rather than
    /// assumed from a 200: a kill whose processes outlived SIGKILL is a failed
    /// kill, and the user has to be told so.
    struct Outcome: Decodable, Equatable {
        struct Preserved: Decodable, Equatable {
            let branch: String
            let ref: String
        }

        struct Survivor: Decodable, Equatable {
            let pid: Int
            let command: String
        }

        struct Reaped: Decodable, Equatable {
            let survivors: [Survivor]
        }

        let reaped: Reaped
        let preserved: Preserved?
    }

    private struct Request: Encodable {
        let sessionLocator: AgentSessionLocator
        let origin: String
        let userClosed: Bool
    }

    func closeAgent(
        name: String,
        locator: AgentSessionLocator
    ) async throws -> Outcome {
        let (data, response) = try await client.send(
            path: "agents/\(name)/kill",
            method: "POST",
            body: Request(
                sessionLocator: locator,
                origin: "workspace shell sidebar Close Agent",
                userClosed: true))
        guard (200..<300).contains(response.statusCode) else {
            throw GatewayError.refused(
                response.statusCode, RefusalBody(data: data).detail)
        }
        return try client.decode(Outcome.self, from: data)
    }

    enum GatewayError: LocalizedError {
        case refused(Int, String)

        var errorDescription: String? {
            switch self {
            case .refused(let status, let detail):
                return "The daemon refused Close Agent (HTTP \(status)): \(detail)"
            }
        }
    }
}
