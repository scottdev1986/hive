// MutationEnvelope.swift Carries every Workspace command through one compare-and-set boundary. Command-specific facts remain in the generic body while concurrency, idempotency, outcome, failure, and final observed state stay uniform.

import Foundation

public enum MutationExpectation: Codable, Equatable, Sendable {
    case revision(String)
    case epoch(String)
    case revisionAndEpoch(revision: String, epoch: String)

    private enum Kind: String, Codable {
        case revision
        case epoch
        case revisionAndEpoch = "revision-and-epoch"
    }

    private enum CodingKeys: String, CodingKey {
        case kind
        case revision
        case epoch
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Kind.self, forKey: .kind) {
        case .revision:
            guard !container.contains(.epoch) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .epoch,
                    in: container,
                    debugDescription: "revision expectation cannot carry an epoch")
            }
            self = .revision(try container.decode(String.self, forKey: .revision))
        case .epoch:
            guard !container.contains(.revision) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .revision,
                    in: container,
                    debugDescription: "epoch expectation cannot carry a revision")
            }
            self = .epoch(try container.decode(String.self, forKey: .epoch))
        case .revisionAndEpoch:
            self = .revisionAndEpoch(
                revision: try container.decode(String.self, forKey: .revision),
                epoch: try container.decode(String.self, forKey: .epoch))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .revision(let revision):
            try container.encode(Kind.revision, forKey: .kind)
            try container.encode(revision, forKey: .revision)
        case .epoch(let epoch):
            try container.encode(Kind.epoch, forKey: .kind)
            try container.encode(epoch, forKey: .epoch)
        case .revisionAndEpoch(let revision, let epoch):
            try container.encode(Kind.revisionAndEpoch, forKey: .kind)
            try container.encode(revision, forKey: .revision)
            try container.encode(epoch, forKey: .epoch)
        }
    }
}

public struct MutationIntent<Body>: Codable, Equatable, Sendable
where Body: Codable & Equatable & Sendable {
    public let schemaVersion: Int
    public let intentID: String
    public let expected: MutationExpectation
    public let idempotencyKey: String
    public let body: Body

    public init(
        schemaVersion: Int = 1,
        intentID: String,
        expected: MutationExpectation,
        idempotencyKey: String,
        body: Body
    ) {
        self.schemaVersion = schemaVersion
        self.intentID = intentID
        self.expected = expected
        self.idempotencyKey = idempotencyKey
        self.body = body
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case intentID = "intentId"
        case expected
        case idempotencyKey
        case body
    }
}

public struct MutationFailure: Codable, Equatable, Sendable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

public enum MutationOutcome: Codable, Equatable, Sendable {
    case accepted
    case rejected(MutationFailure)

    private enum Status: String, Codable {
        case accepted
        case rejected
    }

    private enum CodingKeys: String, CodingKey {
        case status
        case failure
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Status.self, forKey: .status) {
        case .accepted:
            guard !container.contains(.failure) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .failure,
                    in: container,
                    debugDescription: "accepted outcome cannot carry a failure")
            }
            self = .accepted
        case .rejected:
            self = .rejected(
                try container.decode(MutationFailure.self, forKey: .failure))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .accepted:
            try container.encode(Status.accepted, forKey: .status)
        case .rejected(let failure):
            try container.encode(Status.rejected, forKey: .status)
            try container.encode(failure, forKey: .failure)
        }
    }
}

/// The observed post-state is required for both outcomes. A rejection therefore returns the state that remained in force instead of leaving the client to infer it from an error or transport status. The operation ID makes retries refer to one server decision, and the post-state token lets the next intent continue without refetching solely to learn its revision or epoch.
public struct MutationResult<PostState>: Codable, Equatable, Sendable
where PostState: Codable & Equatable & Sendable {
    public let schemaVersion: Int
    public let intentID: String
    public let operationID: String
    public let postStateToken: MutationExpectation
    public let outcome: MutationOutcome
    public let observedPostState: PostState

    public init(
        schemaVersion: Int = 1,
        intentID: String,
        operationID: String,
        postStateToken: MutationExpectation,
        outcome: MutationOutcome,
        observedPostState: PostState
    ) throws {
        guard !operationID.isEmpty else {
            throw MutationResultValidationError(
                errorDescription: "mutation result operation ID must not be empty")
        }
        self.schemaVersion = schemaVersion
        self.intentID = intentID
        self.operationID = operationID
        self.postStateToken = postStateToken
        self.outcome = outcome
        self.observedPostState = observedPostState
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case intentID = "intentId"
        case operationID = "operationId"
        case postStateToken
        case outcome
        case observedPostState
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            schemaVersion: try container.decode(
                Int.self,
                forKey: .schemaVersion),
            intentID: try container.decode(
                String.self,
                forKey: .intentID),
            operationID: try container.decode(
                String.self,
                forKey: .operationID),
            postStateToken: try container.decode(
                MutationExpectation.self,
                forKey: .postStateToken),
            outcome: try container.decode(
                MutationOutcome.self,
                forKey: .outcome),
            observedPostState: try container.decode(
                PostState.self,
                forKey: .observedPostState))
    }
}

private struct MutationResultValidationError: LocalizedError {
    let errorDescription: String?
}
