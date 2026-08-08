
import Foundation

extension KeyedDecodingContainer {
    func decodeRequiredNullable<T: Decodable>(
        _ type: T.Type,
        forKey key: Key
    ) throws -> T? {
        guard contains(key) else {
            throw DecodingError.keyNotFound(
                key,
                DecodingError.Context(
                    codingPath: codingPath,
                    debugDescription: "required nullable key is missing"))
        }
        return try decodeIfPresent(type, forKey: key)
    }
}

public enum ProjectionAvailability:
    String, Codable, CaseIterable, Equatable, Hashable, Sendable
{
    case current
    case unknown
    case stale
    case disconnected
    case unauthorized
    case conflicting
    case replaced
}

public enum ProjectionFreshness: String, Codable, Equatable, Sendable {
    case current
    case stale
    case unknown
}

public struct ProjectionSource: Codable, Equatable, Sendable {
    public let revision: String?
    public let generation: Int?

    public init(revision: String? = nil, generation: Int? = nil) {
        self.revision = revision
        self.generation = generation
    }

    private enum CodingKeys: String, CodingKey {
        case revision
        case generation
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        revision = try container.decodeRequiredNullable(
            String.self,
            forKey: .revision)
        generation = try container.decodeRequiredNullable(
            Int.self,
            forKey: .generation)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(revision, forKey: .revision)
        try container.encode(generation, forKey: .generation)
    }
}

public enum ProjectionEvidence: Equatable, Sendable {
    case disconnected(transportLostAt: String)
    case unauthorized(refusalCode: String)
    case protocolDrift(reason: String)
    case refused(statusCode: Int)
    case conflicting(competingRevision: String)
    case replaced(supersedingSource: ProjectionSource)

    private enum Kind: String, Codable {
        case disconnected
        case unauthorized
        case protocolDrift
        case refused
        case conflicting
        case replaced
    }

    private enum CodingKeys: String, CodingKey {
        case kind
        case transportLostAt
        case refusalCode
        case reason
        case statusCode
        case competingRevision
        case supersedingSource
    }
}

extension ProjectionEvidence: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Kind.self, forKey: .kind) {
        case .disconnected:
            try Self.reject(
                [.refusalCode, .reason, .statusCode, .competingRevision, .supersedingSource],
                in: container)
            self = .disconnected(
                transportLostAt: try container.decode(
                    String.self,
                    forKey: .transportLostAt))
        case .unauthorized:
            try Self.reject(
                [.transportLostAt, .reason, .statusCode, .competingRevision, .supersedingSource],
                in: container)
            self = .unauthorized(
                refusalCode: try container.decode(
                    String.self,
                    forKey: .refusalCode))
        case .protocolDrift:
            try Self.reject(
                [.transportLostAt, .refusalCode, .statusCode, .competingRevision, .supersedingSource],
                in: container)
            self = .protocolDrift(
                reason: try container.decode(String.self, forKey: .reason))
        case .refused:
            try Self.reject(
                [.transportLostAt, .refusalCode, .reason, .competingRevision, .supersedingSource],
                in: container)
            self = .refused(statusCode: try container.decode(Int.self, forKey: .statusCode))
        case .conflicting:
            try Self.reject(
                [.transportLostAt, .refusalCode, .reason, .statusCode, .supersedingSource],
                in: container)
            self = .conflicting(
                competingRevision: try container.decode(
                    String.self,
                    forKey: .competingRevision))
        case .replaced:
            try Self.reject(
                [.transportLostAt, .refusalCode, .reason, .statusCode, .competingRevision],
                in: container)
            self = .replaced(
                supersedingSource: try container.decode(
                    ProjectionSource.self,
                    forKey: .supersedingSource))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .disconnected(let transportLostAt):
            try container.encode(Kind.disconnected, forKey: .kind)
            try container.encode(transportLostAt, forKey: .transportLostAt)
        case .unauthorized(let refusalCode):
            try container.encode(Kind.unauthorized, forKey: .kind)
            try container.encode(refusalCode, forKey: .refusalCode)
        case .protocolDrift(let reason):
            try container.encode(Kind.protocolDrift, forKey: .kind)
            try container.encode(reason, forKey: .reason)
        case .refused(let statusCode):
            try container.encode(Kind.refused, forKey: .kind)
            try container.encode(statusCode, forKey: .statusCode)
        case .conflicting(let competingRevision):
            try container.encode(Kind.conflicting, forKey: .kind)
            try container.encode(competingRevision, forKey: .competingRevision)
        case .replaced(let supersedingSource):
            try container.encode(Kind.replaced, forKey: .kind)
            try container.encode(supersedingSource, forKey: .supersedingSource)
        }
    }

    private static func reject(
        _ keys: [CodingKeys],
        in container: KeyedDecodingContainer<CodingKeys>
    ) throws {
        guard let key = keys.first(where: container.contains) else { return }
        throw DecodingError.dataCorruptedError(
            forKey: key,
            in: container,
            debugDescription: "projection evidence carries a field from another case")
    }
}

private struct ClientProjectionValidationError: LocalizedError {
    let errorDescription: String?
}

public struct ClientProjection<Value>: Codable, Equatable, Sendable
where Value: Codable & Equatable & Sendable {
    public let schemaVersion: Int
    public let source: ProjectionSource
    public let observedAt: String?
    public let freshness: ProjectionFreshness
    public let availability: ProjectionAvailability
    public let evidence: ProjectionEvidence?
    public let value: Value?

    public init(
        schemaVersion: Int = 1,
        source: ProjectionSource,
        observedAt: String?,
        freshness: ProjectionFreshness,
        availability: ProjectionAvailability,
        evidence: ProjectionEvidence?,
        value: Value?
    ) throws {
        guard schemaVersion == 1 else {
            throw ClientProjectionValidationError(
                errorDescription: "client projection schema version \(schemaVersion) is not implemented by this build")
        }
        try Self.validate(
            availability: availability,
            source: source,
            evidence: evidence)
        self.schemaVersion = schemaVersion
        self.source = source
        self.observedAt = observedAt
        self.freshness = freshness
        self.availability = availability
        self.evidence = evidence
        self.value = value
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case source
        case observedAt
        case freshness
        case availability
        case evidence
        case value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        let source = try container.decode(ProjectionSource.self, forKey: .source)
        let observedAt = try container.decodeRequiredNullable(
            String.self,
            forKey: .observedAt)
        let freshness = try container.decode(
            ProjectionFreshness.self,
            forKey: .freshness)
        let availability = try container.decode(
            ProjectionAvailability.self,
            forKey: .availability)
        let evidence = try container.decodeRequiredNullable(
            ProjectionEvidence.self,
            forKey: .evidence)
        let value = try container.decodeRequiredNullable(
            Value.self,
            forKey: .value)
        try self.init(
            schemaVersion: schemaVersion,
            source: source,
            observedAt: observedAt,
            freshness: freshness,
            availability: availability,
            evidence: evidence,
            value: value)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(source, forKey: .source)
        try container.encode(observedAt, forKey: .observedAt)
        try container.encode(freshness, forKey: .freshness)
        try container.encode(availability, forKey: .availability)
        try container.encode(evidence, forKey: .evidence)
        try container.encode(value, forKey: .value)
    }

    private static func validate(
        availability: ProjectionAvailability,
        source: ProjectionSource,
        evidence: ProjectionEvidence?
    ) throws {
        switch (availability, evidence) {
        case (.current, nil), (.unknown, nil), (.stale, nil):
            return
        case (.unknown, .protocolDrift(let reason)):
            guard !reason.isEmpty else { break }
            return
        case (.unknown, .refused(let statusCode)):
            guard statusCode > 0 else { break }
            return
        case (.disconnected, .disconnected(let transportLostAt)):
            guard !transportLostAt.isEmpty else { break }
            return
        case (.unauthorized, .unauthorized(let refusalCode)):
            guard !refusalCode.isEmpty else { break }
            return
        case (.conflicting, .conflicting(let competingRevision)):
            guard
                let sourceRevision = source.revision,
                !sourceRevision.isEmpty,
                !competingRevision.isEmpty,
                competingRevision != sourceRevision
            else { break }
            return
        case (.replaced, .replaced(let supersedingSource)):
            if let revision = supersedingSource.revision, revision.isEmpty {
                break
            }
            guard
                supersedingSource.revision != nil || supersedingSource.generation != nil,
                supersedingSource != source
            else { break }
            return
        default:
            break
        }
        throw ClientProjectionValidationError(
            errorDescription: "projection evidence does not match its availability")
    }
}

extension ClientProjection {
    /// Changes only the decoded value. Availability, freshness, provenance,
    /// and evidence remain the daemon read's single transport observation.
    public func map<Mapped>(
        _ transform: (Value) -> Mapped
    ) -> ClientProjection<Mapped>
    where Mapped: Codable & Equatable & Sendable {
        try! ClientProjection<Mapped>(
            schemaVersion: schemaVersion,
            source: source,
            observedAt: observedAt,
            freshness: freshness,
            availability: availability,
            evidence: evidence,
            value: value.map(transform))
    }
}
