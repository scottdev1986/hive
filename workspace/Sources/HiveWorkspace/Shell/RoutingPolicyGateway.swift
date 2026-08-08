// RoutingPolicyGateway.swift The routing policy endpoint described once. One read descriptor serves both the screen load and the post-write read-back, and the write lives beside it. Routing predates the generic mutation envelope on the wire, so that difference stays here rather than in the shared transport core.

import Foundation
import WorkspaceCore

struct RoutingPolicyGateway {

    static let read = WorkspaceReadEndpoint<RoutingPolicyDocument>(
        path: "routing/policy",
        source: { ProjectionSource(revision: String($0.revision)) },
        observedAt: { $0.updatedAt })

    let client: WorkspaceDaemonClient

    func fetch() async -> ClientProjection<RoutingPolicyDocument> {
        await client.fetch(Self.read)
    }

    func submit<Body>(
        _ intent: MutationIntent<Body>
    ) async throws -> MutationResult<RoutingPolicyDocument>
    where Body: Codable & Equatable & Sendable {
        let (_, response) = try await client.send(
            path: Self.read.path, method: "POST", body: intent.body)
        guard (200..<300).contains(response.statusCode) || response.statusCode == 409 else {
            throw GatewayError.refused(response.statusCode)
        }
        // The POST has already reached the daemon. Anything that goes wrong from here leaves the write possibly committed, so the read attempt's own classification travels with the error: a lost socket stays a lost socket rather than becoming a refusal the daemon never issued.
        let readBack = await fetch()
        guard let policy = readBack.value else {
            throw GatewayError.postStateUnknown(
                readBack,
                reason: "The routing change was sent and may have been applied, "
                    + "but the policy could not be read back, so what is in "
                    + "force is unknown. Refresh before editing again.")
        }
        guard let operationID = response.value(
            forHTTPHeaderField: "x-hive-operation-id"), !operationID.isEmpty else {
            throw GatewayError.postStateUnknown(
                readBack,
                reason: "The daemon did not name the operation it performed, "
                    + "so this result cannot be trusted. The policy shown is "
                    + "the state read back afterwards.")
        }
        let outcome: MutationOutcome = response.statusCode == 409
            ? .rejected(MutationFailure(
                code: "revision-conflict",
                message: "The routing policy changed at revision \(policy.revision)."))
            : .accepted
        return try MutationResult(
            intentID: intent.intentID,
            operationID: operationID,
            postStateToken: .revision(String(policy.revision)),
            outcome: outcome,
            observedPostState: policy)
    }

    /// The two ways a write fails to produce a trustworthy result, kept apart because they are opposite facts about the daemon. A refusal is an answer — nothing was written and nothing observed changed. An unknown post-state means the write reached the daemon and may have committed, so the read attempt's own projection travels with it and decides how the screen reads: a lost transport is still disconnected, a refused read still unauthorized.
    enum GatewayError: LocalizedError {
        case refused(Int)
        case postStateUnknown(ClientProjection<RoutingPolicyDocument>, reason: String)

        var errorDescription: String? {
            switch self {
            case .refused(let status):
                return "The daemon refused this routing change (HTTP \(status)). "
                    + "Nothing was written."
            case .postStateUnknown(_, let reason):
                return reason
            }
        }
    }
}
