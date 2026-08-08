// QueenProviderGateway.swift The queen-provider endpoint described once: the read, and the compare-and-set that swaps the vendor running the live Queen. Unlike the routing wire, both answers carry the projection inline — an accepted swap and a refused one each return the state in force — so this gateway never needs a second read to learn what happened.

import Foundation
import WorkspaceCore

struct QueenProviderGateway {

    static let read = WorkspaceReadEndpoint<QueenProviderProjection>(
        path: "queen-provider",
        source: { ProjectionSource(revision: $0.change.revision) },
        observedAt: { $0.observedAt })

    let client: WorkspaceDaemonClient

    func fetch() async -> ClientProjection<QueenProviderProjection> {
        await client.fetch(Self.read)
    }

    /// Sends one swap. A 409 is an ANSWER, not a failure: the daemon refused the compare-and-set and nothing was terminated, launched, or recorded. Either way the body carries the projection that is in force.
    func submit(
        _ body: SetLiveQueenProviderBody,
        intentID: String
    ) async throws -> MutationResult<QueenProviderProjection> {
        let (data, response) = try await client.send(
            path: Self.read.path, method: "POST", body: body)
        switch response.statusCode {
        case 200..<300:
            let accepted = try client.decode(AcceptedSwap.self, from: data)
            return try MutationResult(
                intentID: intentID,
                operationID: accepted.receipt.operationId,
                postStateToken: .revision(accepted.receipt.revision),
                outcome: .accepted,
                observedPostState: accepted.projection)
        case 409:
            let conflict = try client.decode(RefusedSwap.self, from: data)
            return try MutationResult(
                intentID: intentID,
                operationID: "conflict.\(intentID)",
                postStateToken: .revision(conflict.currentRevision),
                outcome: .rejected(MutationFailure(
                    code: "revision-conflict",
                    message: "Another change reached the Queen first "
                        + "(revision \(conflict.currentRevision)). "
                        + "Nothing was launched or terminated.")),
                observedPostState: conflict.projection)
        default:
            throw GatewayError.refused(response.statusCode)
        }
    }

    private struct AcceptedSwap: Decodable, Equatable, Sendable {
        struct Receipt: Decodable, Equatable, Sendable {
            let operationId: String
            let revision: String

            private enum CodingKeys: String, CodingKey { case operationId, revision }

            init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                operationId = try container.decode(String.self, forKey: .operationId)
                try QueenProviderWire.validateOperationID(
                    operationId, in: container, forKey: .operationId)
                revision = try QueenProviderWire.decodeRevision(from: container, forKey: .revision)
            }
        }

        let receipt: Receipt
        let projection: QueenProviderProjection
    }

    private struct RefusedSwap: Decodable, Equatable, Sendable {
        let error: String
        let currentRevision: String
        let projection: QueenProviderProjection

        private enum CodingKeys: String, CodingKey { case error, currentRevision, projection }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            error = try container.decode(String.self, forKey: .error)
            currentRevision = try QueenProviderWire.decodeRevision(
                from: container, forKey: .currentRevision)
            projection = try container.decode(QueenProviderProjection.self, forKey: .projection)
        }
    }

    enum GatewayError: LocalizedError {
        case refused(Int)

        var errorDescription: String? {
            switch self {
            case .refused(let status):
                return "The daemon refused this Queen provider change "
                    + "(HTTP \(status)). Nothing was launched or terminated."
            }
        }
    }
}

private enum QueenProviderWire {
    static func validateOperationID<Key>(
        _ value: String,
        in container: KeyedDecodingContainer<Key>,
        forKey key: Key
    ) throws where Key: CodingKey {
        let pattern = "^qpo_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        guard value.range(of: pattern, options: .regularExpression) != nil else {
            throw DecodingError.dataCorruptedError(
                forKey: key, in: container,
                debugDescription: "operationId is not a qpo UUIDv7")
        }
    }

    static func decodeRevision<Key>(
        from container: KeyedDecodingContainer<Key>, forKey key: Key
    ) throws -> String where Key: CodingKey {
        let value = try container.decode(String.self, forKey: key)
        guard value.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
              (value == "0" || value.first != "0"),
              UInt64(value) != nil
        else {
            throw DecodingError.dataCorruptedError(
                forKey: key, in: container,
                debugDescription: "revision is not an unsigned decimal uint64")
        }
        return value
    }
}
