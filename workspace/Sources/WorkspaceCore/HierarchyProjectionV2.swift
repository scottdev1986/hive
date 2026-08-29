// HierarchyProjectionV2.swift The daemon's hierarchy snapshot projection as immutable client values. HierarchyH0Records mirrors the stored records; this mirrors what the rail actually receives — the same records after the projector has decided which fields it can honestly show. Every field is either a value or a named kind of nothing. Decoding is strict in both directions: an absence that smuggles a value, a present field that smuggles an absence reason, an unknown reason, or a schemaVersion that is not the one this mirror was written for all fail to decode. A wire that drifted must stop rendering, not render something plausible.

import Foundation

public enum HierarchyProjectionSchema {
    public static let version = 3
}

public enum HierarchyAbsenceReason: String, Codable, Equatable, Sendable {
    case unmeasured
    case sourceAbsent = "source-absent"
}

public struct HierarchyNullable<Wrapped>: Codable, Equatable, Sendable
where Wrapped: Codable & Equatable & Sendable {
    public let value: Wrapped?

    public init(_ value: Wrapped?) {
        self.value = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        value = container.decodeNil() ? nil : try container.decode(Wrapped.self)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if let value {
            try container.encode(value)
        } else {
            try container.encodeNil()
        }
    }
}

public enum HierarchyProjectionField<Value>: Codable, Equatable, Sendable
where Value: Codable & Equatable & Sendable {
    case present(Value)
    case absent(reason: HierarchyAbsenceReason, detail: String)

    private enum Availability: String, Codable {
        case present
        case absent
    }

    private enum CodingKeys: String, CodingKey {
        case availability
        case value
        case reason
        case detail
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Availability.self, forKey: .availability) {
        case .present:
            if let key = [CodingKeys.reason, .detail].first(where: container.contains) {
                throw DecodingError.dataCorruptedError(
                    forKey: key,
                    in: container,
                    debugDescription: "a present field cannot carry an absence reason")
            }
            self = .present(try container.decode(Value.self, forKey: .value))
        case .absent:
            if container.contains(.value) {
                throw DecodingError.dataCorruptedError(
                    forKey: .value,
                    in: container,
                    debugDescription: "an absent field cannot carry a value")
            }
            self = .absent(
                reason: try container.decode(HierarchyAbsenceReason.self, forKey: .reason),
                detail: try container.decode(String.self, forKey: .detail))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .present(let value):
            try container.encode(Availability.present, forKey: .availability)
            try container.encode(value, forKey: .value)
        case .absent(let reason, let detail):
            try container.encode(Availability.absent, forKey: .availability)
            try container.encode(reason, forKey: .reason)
            try container.encode(detail, forKey: .detail)
        }
    }
}

public struct HierarchyAbsentOnlyField: Codable, Equatable, Sendable {
    public let detail: String

    private enum CodingKeys: String, CodingKey {
        case availability
        case reason
        case detail
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let availability = try container.decode(String.self, forKey: .availability)
        guard availability == "absent" else {
            throw DecodingError.dataCorruptedError(
                forKey: .availability,
                in: container,
                debugDescription: "an absent-only field is never present")
        }
        let reason = try container.decode(HierarchyAbsenceReason.self, forKey: .reason)
        guard reason == .sourceAbsent else {
            throw DecodingError.dataCorruptedError(
                forKey: .reason,
                in: container,
                debugDescription: "an absent-only field is absent because its source does not exist")
        }
        detail = try container.decode(String.self, forKey: .detail)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("absent", forKey: .availability)
        try container.encode(HierarchyAbsenceReason.sourceAbsent, forKey: .reason)
        try container.encode(detail, forKey: .detail)
    }
}

/// Decodes the projection version and refuses anything but this mirror's.
private func decodeProjectionVersion<Key: CodingKey>(
    from container: KeyedDecodingContainer<Key>,
    forKey key: Key
) throws -> Int {
    let version = try container.decode(Int.self, forKey: key)
    guard version == HierarchyProjectionSchema.version else {
        throw DecodingError.dataCorruptedError(
            forKey: key,
            in: container,
            debugDescription:
                "hierarchy projection schemaVersion \(version) is not \(HierarchyProjectionSchema.version)")
    }
    return version
}

public struct HierarchyRootIdentity: Codable, Equatable, Sendable {
    public let runID: String
    public let instanceId: String
    public let repo: String

    private enum CodingKeys: String, CodingKey {
        case kind
        case runID = "runId"
        case instanceId
        case repo
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        guard kind == "queen-root" else {
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "the hierarchy root is the queen root, never an agent")
        }
        runID = try container.decode(String.self, forKey: .runID)
        instanceId = try container.decode(String.self, forKey: .instanceId)
        repo = try container.decode(String.self, forKey: .repo)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("queen-root", forKey: .kind)
        try container.encode(runID, forKey: .runID)
        try container.encode(instanceId, forKey: .instanceId)
        try container.encode(repo, forKey: .repo)
    }
}

public enum HierarchyTopologySource: String, Codable, Equatable, Sendable {
    case hierarchy
}

public struct HierarchyRunProjection: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let runID: String
    public let entityRevision: String
    public let root: HierarchyProjectionField<HierarchyRootIdentity>
    public let phase: HierarchyProjectionField<HierarchyRun.Phase>
    public let lifecycle: HierarchyProjectionField<HierarchyRun.Lifecycle>
    public let topologyKind: HierarchyProjectionField<HierarchyTopologyDecision.Shape>
    public let topologySource: HierarchyProjectionField<HierarchyTopologySource>

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case runID = "runId"
        case entityRevision
        case root
        case phase
        case lifecycle
        case topologyKind
        case topologySource
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try decodeProjectionVersion(from: container, forKey: .schemaVersion)
        runID = try container.decode(String.self, forKey: .runID)
        entityRevision = try container.decode(String.self, forKey: .entityRevision)
        root = try container.decode(
            HierarchyProjectionField<HierarchyRootIdentity>.self, forKey: .root)
        phase = try container.decode(
            HierarchyProjectionField<HierarchyRun.Phase>.self, forKey: .phase)
        lifecycle = try container.decode(
            HierarchyProjectionField<HierarchyRun.Lifecycle>.self, forKey: .lifecycle)
        topologyKind = try container.decode(
            HierarchyProjectionField<HierarchyTopologyDecision.Shape>.self,
            forKey: .topologyKind)
        topologySource = try container.decode(
            HierarchyProjectionField<HierarchyTopologySource>.self, forKey: .topologySource)
    }
}

public enum HierarchyOrganizationalRole: String, Codable, Equatable, Sendable {
    case leadWorker = "lead-worker"
    case worker
}

public enum HierarchyAssignmentKind: String, Codable, Equatable, Sendable {
    case author
    case reviewer
    case researcher
    case leadCoordination = "lead-coordination"
}

public enum HierarchyNodeLifecycle: String, Codable, Equatable, Sendable {
    case active
    case completed
    case terminated
}

/// A binding reference only. The SessionLocator lives on the binding record and must never reach a node entity; these three fields are the whole shape.
public struct HierarchyAgentBindingRef: Codable, Equatable, Sendable {
    public let nodeId: String
    public let agentId: String
    public let generation: Int
}

public struct HierarchyNodeProjection: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let nodeId: String
    public let runID: String
    public let entityRevision: String
    public let parentNodeId: HierarchyProjectionField<HierarchyNullable<String>>
    public let ownerNodeId: HierarchyProjectionField<HierarchyNullable<String>>
    public let organizationalRole: HierarchyProjectionField<HierarchyOrganizationalRole>
    public let assignmentKind: HierarchyProjectionField<HierarchyAssignmentKind>
    public let taskScope: HierarchyProjectionField<[String]>
    public let lifecycle: HierarchyProjectionField<HierarchyNodeLifecycle>
    public let binding: HierarchyProjectionField<HierarchyAgentBindingRef>

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case nodeId
        case runID = "runId"
        case entityRevision
        case parentNodeId
        case ownerNodeId
        case organizationalRole
        case assignmentKind
        case taskScope
        case lifecycle
        case binding
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try decodeProjectionVersion(from: container, forKey: .schemaVersion)
        nodeId = try container.decode(String.self, forKey: .nodeId)
        runID = try container.decode(String.self, forKey: .runID)
        entityRevision = try container.decode(String.self, forKey: .entityRevision)
        parentNodeId = try container.decode(
            HierarchyProjectionField<HierarchyNullable<String>>.self, forKey: .parentNodeId)
        ownerNodeId = try container.decode(
            HierarchyProjectionField<HierarchyNullable<String>>.self, forKey: .ownerNodeId)
        organizationalRole = try container.decode(
            HierarchyProjectionField<HierarchyOrganizationalRole>.self,
            forKey: .organizationalRole)
        assignmentKind = try container.decode(
            HierarchyProjectionField<HierarchyAssignmentKind>.self, forKey: .assignmentKind)
        taskScope = try container.decode(
            HierarchyProjectionField<[String]>.self, forKey: .taskScope)
        lifecycle = try container.decode(
            HierarchyProjectionField<HierarchyNodeLifecycle>.self, forKey: .lifecycle)
        binding = try container.decode(
            HierarchyProjectionField<HierarchyAgentBindingRef>.self, forKey: .binding)
    }
}

// MARK: - Budget and reviews

public struct HierarchyBudgetProjection: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let runID: String
    public let entityRevision: String
    public let limits: HierarchyProjectionField<HierarchyRunBudget.Limits>

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case runID = "runId"
        case entityRevision
        case limits
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try decodeProjectionVersion(from: container, forKey: .schemaVersion)
        runID = try container.decode(String.self, forKey: .runID)
        entityRevision = try container.decode(String.self, forKey: .entityRevision)
        limits = try container.decode(
            HierarchyProjectionField<HierarchyRunBudget.Limits>.self, forKey: .limits)
    }
}

public enum HierarchyReviewVerdict: String, Codable, Equatable, Sendable {
    case accepted
    case changesRequested = "changes-requested"
}

public enum HierarchyReviewInvalidation: Codable, Equatable, Sendable {
    public enum Reason: String, Codable, Equatable, Sendable {
        case patchChanged = "patch-changed"
        case baseChanged = "base-changed"
        case revisionChanged = "revision-changed"
    }

    case current
    case invalidated(Reason)

    private enum State: String, Codable {
        case current
        case invalidated
    }

    private enum CodingKeys: String, CodingKey {
        case state
        case reason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(State.self, forKey: .state) {
        case .current:
            if container.contains(.reason) {
                throw DecodingError.dataCorruptedError(
                    forKey: .reason,
                    in: container,
                    debugDescription: "a current review carries no invalidation reason")
            }
            self = .current
        case .invalidated:
            self = .invalidated(try container.decode(Reason.self, forKey: .reason))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .current:
            try container.encode(State.current, forKey: .state)
        case .invalidated(let reason):
            try container.encode(State.invalidated, forKey: .state)
            try container.encode(reason, forKey: .reason)
        }
    }
}

public struct HierarchyReviewSummary: Codable, Equatable, Sendable {
    public struct Candidate: Codable, Equatable, Sendable {
        public let commitSha: String
        public let patchDigest: String
        public let baseSha: String
    }

    public let reviewId: String
    public let revision: String
    public let verdict: HierarchyReviewVerdict
    public let invalidation: HierarchyReviewInvalidation
    public let reviewer: HierarchyAgentBindingRef
    public let candidate: Candidate
    public let taskId: String
}

public struct HierarchyReviewProjection: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let runID: String
    public let entityRevision: String
    public let reviews: HierarchyProjectionField<[HierarchyReviewSummary]>

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case runID = "runId"
        case entityRevision
        case reviews
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try decodeProjectionVersion(from: container, forKey: .schemaVersion)
        runID = try container.decode(String.self, forKey: .runID)
        entityRevision = try container.decode(String.self, forKey: .entityRevision)
        reviews = try container.decode(
            HierarchyProjectionField<[HierarchyReviewSummary]>.self, forKey: .reviews)
    }
}

public enum HierarchyRunDecisionOutcome: Codable, Equatable, Sendable {
    case accepted
    case rejected(failureCode: String)

    private enum Status: String, Codable {
        case accepted
        case rejected
    }

    private enum CodingKeys: String, CodingKey {
        case status
        case failureCode
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Status.self, forKey: .status) {
        case .accepted:
            if container.contains(.failureCode) {
                throw DecodingError.dataCorruptedError(
                    forKey: .failureCode,
                    in: container,
                    debugDescription: "an accepted decision carries no failure code")
            }
            self = .accepted
        case .rejected:
            self = .rejected(
                failureCode: try container.decode(String.self, forKey: .failureCode))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .accepted:
            try container.encode(Status.accepted, forKey: .status)
        case .rejected(let failureCode):
            try container.encode(Status.rejected, forKey: .status)
            try container.encode(failureCode, forKey: .failureCode)
        }
    }
}

public struct HierarchyRunDecisionIncident: Codable, Equatable, Sendable {
    public let idempotencyKey: String
    public let intentDigest: String
    public let outcome: HierarchyRunDecisionOutcome
    public let observedRevision: String
}

public struct HierarchyRecoveryIncident: Codable, Equatable, Sendable {
    /// One reason today. A transfer is never implied by a rebinding — only the record says a subtree moved, and only for a measured owner loss.
    public enum Reason: String, Codable, Equatable, Sendable {
        case ownerBindingsUnbound = "owner-bindings-unbound"
    }

    public let transferId: String
    public let reason: Reason
    public let lostOwnerNodeId: String
    public let successorNodeId: String
    public let hierarchyRevision: String
}

public struct HierarchyIncidentProjection: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let runID: String
    public let entityRevision: String
    public let runDecision: HierarchyProjectionField<[HierarchyRunDecisionIncident]>
    public let recovery: HierarchyProjectionField<[HierarchyRecoveryIncident]>
    public let breaker: HierarchyAbsentOnlyField

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case runID = "runId"
        case entityRevision
        case runDecision
        case recovery
        case breaker
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try decodeProjectionVersion(from: container, forKey: .schemaVersion)
        runID = try container.decode(String.self, forKey: .runID)
        entityRevision = try container.decode(String.self, forKey: .entityRevision)
        runDecision = try container.decode(
            HierarchyProjectionField<[HierarchyRunDecisionIncident]>.self,
            forKey: .runDecision)
        recovery = try container.decode(
            HierarchyProjectionField<[HierarchyRecoveryIncident]>.self, forKey: .recovery)
        breaker = try container.decode(HierarchyAbsentOnlyField.self, forKey: .breaker)
    }
}

public struct HierarchyStrandedManifestAttention: Codable, Equatable, Sendable {
    public enum Disposition: String, Codable, Equatable, Sendable {
        case preserve
        case discardRequired = "discard-required"
        case unknown
    }

    public let nodeId: String?
    public let agentId: String?
    public let branch: String
    public let workManifestRevision: HierarchyRevisionRef?
    public let unmergedCommits: Int
    public let dirtyFileCount: Int
    public let disposition: Disposition

    private enum CodingKeys: String, CodingKey {
        case nodeId
        case agentId
        case branch
        case workManifestRevision
        case unmergedCommits
        case dirtyFileCount
        case disposition
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        nodeId = try container.decodeRequiredNullable(String.self, forKey: .nodeId)
        agentId = try container.decodeRequiredNullable(String.self, forKey: .agentId)
        branch = try container.decode(String.self, forKey: .branch)
        workManifestRevision = try container.decodeRequiredNullable(
            HierarchyRevisionRef.self, forKey: .workManifestRevision)
        unmergedCommits = try Self.decodeCount(from: container, forKey: .unmergedCommits)
        dirtyFileCount = try Self.decodeCount(from: container, forKey: .dirtyFileCount)
        disposition = try container.decode(Disposition.self, forKey: .disposition)
    }

    private static func decodeCount(
        from container: KeyedDecodingContainer<CodingKeys>,
        forKey key: CodingKeys
    ) throws -> Int {
        let count = try container.decode(Int.self, forKey: key)
        guard count >= 0 else {
            throw DecodingError.dataCorruptedError(
                forKey: key,
                in: container,
                debugDescription: "a captured count is never negative")
        }
        return count
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(nodeId, forKey: .nodeId)
        try container.encode(agentId, forKey: .agentId)
        try container.encode(branch, forKey: .branch)
        try container.encode(workManifestRevision, forKey: .workManifestRevision)
        try container.encode(unmergedCommits, forKey: .unmergedCommits)
        try container.encode(dirtyFileCount, forKey: .dirtyFileCount)
        try container.encode(disposition, forKey: .disposition)
    }
}

public struct HierarchyStrandedManifestProjection: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    /// Null: the manifest journal is keyed by agent, so stranded work belongs to no single run. Each item names its own node instead.
    public let runID: String?
    public let entityRevision: String
    public let items: HierarchyProjectionField<[HierarchyStrandedManifestAttention]>

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case runID = "runId"
        case entityRevision
        case items
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try decodeProjectionVersion(from: container, forKey: .schemaVersion)
        runID = try container.decodeRequiredNullable(String.self, forKey: .runID)
        entityRevision = try container.decode(String.self, forKey: .entityRevision)
        items = try container.decode(
            HierarchyProjectionField<[HierarchyStrandedManifestAttention]>.self,
            forKey: .items)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(runID, forKey: .runID)
        try container.encode(entityRevision, forKey: .entityRevision)
        try container.encode(items, forKey: .items)
    }
}
