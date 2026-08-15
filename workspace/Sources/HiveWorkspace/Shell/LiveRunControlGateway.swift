import Foundation
import WorkspaceCore

struct LiveRunControlGateway {
    let client: WorkspaceDaemonClient

    func fetch(agentID: String) async -> ClientProjection<LiveRunControlProjection> {
        await client.fetch(WorkspaceReadEndpoint(
            path: "live-run-control",
            queryItems: [URLQueryItem(name: "agentId", value: agentID)],
            source: { ProjectionSource(revision: String($0.locator.generation)) },
            observedAt: { $0.observedAt }))
    }

    func submit(
        _ intent: MutationIntent<LiveRunControlBody>
    ) async throws -> MutationResult<LiveRunControlProjection> {
        let (data, response) = try await client.send(
            path: "live-run-control", method: "POST", body: intent)
        guard (200..<300).contains(response.statusCode) || response.statusCode == 409 else {
            throw GatewayError.refused(response.statusCode, RefusalBody(data: data).detail)
        }
        return try client.decode(
            MutationResult<LiveRunControlProjection>.self, from: data)
    }

    enum GatewayError: LocalizedError {
        case refused(Int, String)

        var errorDescription: String? {
            switch self {
            case .refused(let status, let detail):
                return "The daemon refused Live Run process control "
                    + "(HTTP \(status)): \(detail)"
            }
        }
    }
}
