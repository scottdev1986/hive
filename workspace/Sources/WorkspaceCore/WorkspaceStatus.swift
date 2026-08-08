import CryptoKit
import CoreFoundation
import Foundation

public enum WorkspaceJSONValue: Codable, Equatable, Sendable {
    case null
    case boolean(Bool)
    case integer(Int64)
    case number(Double)
    case string(String)
    case array([WorkspaceJSONValue])
    case object([String: WorkspaceJSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .boolean(value) }
        else if let value = try? container.decode(Int64.self) { self = .integer(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([WorkspaceJSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: WorkspaceJSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .boolean(let value): try container.encode(value)
        case .integer(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

public struct WorkspaceStatusEvent: Codable, Equatable {
    public struct Entity: Codable, Equatable {
        public let kind: String
        public let id: String
        public let generation: Int?

        public init(kind: String, id: String, generation: Int? = nil) {
            self.kind = kind
            self.id = id
            self.generation = generation
        }
    }

    public struct Source: Codable, Equatable {
        public let kind: String
        public let id: String
        public let observedAt: String
        public let confidence: String

        public init(kind: String, id: String, observedAt: String, confidence: String) {
            self.kind = kind
            self.id = id
            self.observedAt = observedAt
            self.confidence = confidence
        }
    }

    public let schemaVersion: Int
    public let eventId: String
    public let seq: String
    public let entity: Entity
    public let entityRevision: String
    public let occurredAt: String
    public let kind: String
    public let source: Source
    public let data: [String: WorkspaceJSONValue]

    public init(
        schemaVersion: Int = 2,
        eventId: String,
        seq: String,
        entity: Entity,
        entityRevision: String,
        occurredAt: String,
        kind: String,
        source: Source,
        data: [String: WorkspaceJSONValue]
    ) {
        self.schemaVersion = schemaVersion
        self.eventId = eventId
        self.seq = seq
        self.entity = entity
        self.entityRevision = entityRevision
        self.occurredAt = occurredAt
        self.kind = kind
        self.source = source
        self.data = data
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case eventId
        case seq
        case entity
        case entityRevision
        case occurredAt
        case kind
        case source
        case data
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        guard schemaVersion == 2 else {
            throw DecodingError.dataCorruptedError(
                forKey: .schemaVersion,
                in: container,
                debugDescription:
                    "unsupported workspace status event schemaVersion \(schemaVersion)")
        }
        eventId = try container.decode(String.self, forKey: .eventId)
        seq = try container.decode(String.self, forKey: .seq)
        entity = try container.decode(Entity.self, forKey: .entity)
        entityRevision = try container.decode(String.self, forKey: .entityRevision)
        occurredAt = try container.decode(String.self, forKey: .occurredAt)
        kind = try container.decode(String.self, forKey: .kind)
        source = try container.decode(Source.self, forKey: .source)
        data = try container.decode(
            [String: WorkspaceJSONValue].self,
            forKey: .data)
    }
}

public struct WorkspaceStatusProjection: Codable, Equatable {
    public var highWaterSeq: String
    public var paused: Bool
    public var recovery: String?
    public var corruption: String?
    public var entities: [String: WorkspaceJSONValue]
    public var seen: [String: String]

    public init(
        highWaterSeq: String = "0",
        paused: Bool = false,
        recovery: String? = nil,
        corruption: String? = nil,
        entities: [String: WorkspaceJSONValue] = [:],
        seen: [String: String] = [:]
    ) {
        self.highWaterSeq = highWaterSeq
        self.paused = paused
        self.recovery = recovery
        self.corruption = corruption
        self.entities = entities
        self.seen = seen
    }
}

public struct WorkspaceStatusSnapshot: Codable, Equatable {
    public struct Entity: Codable, Equatable {
        public let kind: String
        public let id: String
        public let generation: Int?
        public let entityRevision: String
        public let projection: [String: WorkspaceJSONValue]

        public init(
            kind: String,
            id: String,
            generation: Int? = nil,
            entityRevision: String,
            projection: [String: WorkspaceJSONValue]
        ) {
            self.kind = kind
            self.id = id
            self.generation = generation
            self.entityRevision = entityRevision
            self.projection = projection
        }
    }

    public let schemaVersion: Int
    public let instanceId: String
    public let seq: String
    public let entities: [Entity]
    public let createdAt: String
    public let contentSha256: String

    public init(
        schemaVersion: Int = 2,
        instanceId: String,
        seq: String,
        entities: [Entity],
        createdAt: String,
        contentSha256: String
    ) {
        self.schemaVersion = schemaVersion
        self.instanceId = instanceId
        self.seq = seq
        self.entities = entities
        self.createdAt = createdAt
        self.contentSha256 = contentSha256
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case instanceId
        case seq
        case entities
        case createdAt
        case contentSha256
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        guard schemaVersion == 2 else {
            throw DecodingError.dataCorruptedError(
                forKey: .schemaVersion,
                in: container,
                debugDescription:
                    "unsupported workspace status snapshot schemaVersion \(schemaVersion)")
        }
        instanceId = try container.decode(String.self, forKey: .instanceId)
        seq = try container.decode(String.self, forKey: .seq)
        entities = try container.decode([Entity].self, forKey: .entities)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        contentSha256 = try container.decode(String.self, forKey: .contentSha256)
    }
}

public enum WorkspaceStatusReducerError: LocalizedError, Equatable {
    case invalidUnsignedInteger
    case invalidSnapshotSchema
    case snapshotDigestMismatch
    case snapshotHighWaterRegressed
    case duplicateEntityIdentities([String])

    public var errorDescription: String? {
        switch self {
        case .invalidUnsignedInteger:
            return "workspace status sequence is not an unsigned integer"
        case .invalidSnapshotSchema:
            return "workspace snapshot schema is not supported"
        case .snapshotDigestMismatch:
            return "workspace snapshot digest does not match its entities"
        case .snapshotHighWaterRegressed:
            return "workspace snapshot sequence regressed"
        case .duplicateEntityIdentities(let keys):
            return "workspace snapshot contains duplicate entity identities: "
                + keys.joined(separator: ", ")
        }
    }
}

private func workspaceJSONScalar(_ value: Any) throws -> String {
    let data = try JSONSerialization.data(
        withJSONObject: value,
        options: [.withoutEscapingSlashes, .fragmentsAllowed])
    return String(decoding: data, as: UTF8.self)
}

private func workspaceCanonicalValue(_ value: Any) throws -> String {
    if value is NSNull { return "null" }
    if let number = value as? NSNumber {
        if CFGetTypeID(number) == CFBooleanGetTypeID() {
            return number.boolValue ? "true" : "false"
        }
        return try workspaceJSONScalar(number)
    }
    if let string = value as? String { return try workspaceJSONScalar(string) }
    if let array = value as? [Any] {
        return "[" + (try array.map(workspaceCanonicalValue)).joined(separator: ",") + "]"
    }
    if let object = value as? [String: Any] {
        let keys = object.keys.sorted {
            $0.utf16.lexicographicallyPrecedes($1.utf16)
        }
        let fields = try keys.map { key in
            try workspaceJSONScalar(key) + ":" + workspaceCanonicalValue(object[key]!)
        }
        return "{" + fields.joined(separator: ",") + "}"
    }
    throw EncodingError.invalidValue(
        value,
        EncodingError.Context(codingPath: [], debugDescription: "unsupported JSON value"))
}

func workspaceCanonicalJSON<T: Encodable>(_ value: T) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let encoded = try encoder.encode(value)
    let object = try JSONSerialization.jsonObject(with: encoded, options: .fragmentsAllowed)
    return try workspaceCanonicalValue(object)
}

private func workspaceEntityKey(kind: String, id: String, generation: Int?) -> String {
    kind == "agent"
        ? "agent:\(id)"
        : "\(kind):\(id):\(generation.map(String.init) ?? "-")"
}

public enum WorkspaceStatusReducer {
    public static func reduce(
        _ state: WorkspaceStatusProjection,
        event: WorkspaceStatusEvent
    ) throws -> WorkspaceStatusProjection {
        if state.paused || state.corruption != nil { return state }
        let encoded = try workspaceCanonicalJSON(event)
        if let prior = state.seen[event.eventId] {
            if prior == encoded { return state }
            var corrupted = state
            corrupted.corruption = "conflicting duplicate \(event.eventId)"
            return corrupted
        }
        guard let sequence = UInt64(event.seq), let highWater = UInt64(state.highWaterSeq),
              highWater < UInt64.max, sequence == highWater + 1 else {
            var paused = state
            paused.paused = true
            paused.recovery = "SNAPSHOT_REQUIRED"
            return paused
        }

        var result = state
        result.highWaterSeq = event.seq
        result.seen[event.eventId] = encoded
        let key = workspaceEntityKey(
            kind: event.entity.kind,
            id: event.entity.id,
            generation: event.entity.generation)
        let existingRevision: UInt64? = {
            guard case .object(let value)? = result.entities[key],
                  case .string(let revision)? = value["entityRevision"] else { return nil }
            return UInt64(revision)
        }()
        guard let revision = UInt64(event.entityRevision) else {
            throw WorkspaceStatusReducerError.invalidUnsignedInteger
        }
        if existingRevision == nil || revision >= existingRevision! {
            result.entities[key] = .object([
                "entityRevision": .string(event.entityRevision),
                "eventId": .string(event.eventId),
                "kind": .string(event.kind),
                "occurredAt": .string(event.occurredAt),
                "source": .object([
                    "kind": .string(event.source.kind),
                    "id": .string(event.source.id),
                    "observedAt": .string(event.source.observedAt),
                    "confidence": .string(event.source.confidence),
                ]),
                "data": .object(event.data),
            ])
        }
        return result
    }

    public static func reconcile(
        _ state: WorkspaceStatusProjection,
        snapshot: WorkspaceStatusSnapshot
    ) throws -> WorkspaceStatusProjection {
        guard snapshot.schemaVersion == 2 else {
            throw WorkspaceStatusReducerError.invalidSnapshotSchema
        }
        guard let snapshotSeq = UInt64(snapshot.seq), let currentSeq = UInt64(state.highWaterSeq),
              snapshotSeq >= currentSeq else {
            throw WorkspaceStatusReducerError.snapshotHighWaterRegressed
        }
        let canonical = try workspaceCanonicalJSON(snapshot.entities)
        let digest = SHA256.hash(data: Data(canonical.utf8))
            .map { String(format: "%02x", $0) }.joined()
        guard digest == snapshot.contentSha256 else {
            throw WorkspaceStatusReducerError.snapshotDigestMismatch
        }
        let keyedEntities: [(String, WorkspaceJSONValue)] = snapshot.entities.map { entity in
            let key = workspaceEntityKey(
                kind: entity.kind,
                id: entity.id,
                generation: entity.generation)
            return (key, .object(entity.projection.merging([
                "entityRevision": .string(entity.entityRevision),
            ]) { _, envelope in envelope }))
        }
        var seenEntityKeys = Set<String>()
        let duplicateEntityKeys = Set(keyedEntities.compactMap { key, _ in
            seenEntityKeys.insert(key).inserted ? nil : key
        }).sorted()
        guard duplicateEntityKeys.isEmpty else {
            throw WorkspaceStatusReducerError.duplicateEntityIdentities(
                duplicateEntityKeys)
        }
        return WorkspaceStatusProjection(
            highWaterSeq: snapshot.seq,
            entities: Dictionary(uniqueKeysWithValues: keyedEntities))
    }
}
