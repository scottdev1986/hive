import CryptoKit
import Foundation

public enum WorkspaceJSONValue: Codable, Equatable {
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
}

public enum WorkspaceStatusReducerError: Error, Equatable {
    case invalidUnsignedInteger
    case invalidSnapshotSchema
    case snapshotDigestMismatch
    case snapshotHighWaterRegressed
}

private func workspaceCanonicalJSON<T: Encodable>(_ value: T) throws -> String {
    let encoded = try JSONEncoder().encode(value)
    let object = try JSONSerialization.jsonObject(with: encoded)
    let canonical = try JSONSerialization.data(
        withJSONObject: object,
        options: [.sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed])
    return String(decoding: canonical, as: UTF8.self)
}

private func workspaceEntityKey(kind: String, id: String, generation: Int?) -> String {
    "\(kind):\(id):\(generation.map(String.init) ?? "-")"
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
        return WorkspaceStatusProjection(
            highWaterSeq: snapshot.seq,
            entities: Dictionary(uniqueKeysWithValues: snapshot.entities.map { entity in
                let key = workspaceEntityKey(
                    kind: entity.kind,
                    id: entity.id,
                    generation: entity.generation)
                return (key, .object(entity.projection.merging([
                    "entityRevision": .string(entity.entityRevision),
                ]) { _, envelope in envelope }))
            }))
    }
}

public enum WorkspaceStatusFreshness: String, Codable, Equatable {
    case fresh
    case stale
    case unknown
}

public enum WorkspaceStatusAttention: String, Codable, Equatable {
    case none
    case info
    case action
    case approval
    case failure
}

public enum WorkspaceStatusAttentionReducer {
    public static func unresolved(
        in events: [WorkspaceStatusEvent]
    ) -> WorkspaceStatusAttention? {
        let resolved = Set(events.compactMap { event -> String? in
            guard event.kind == "status.attention-resolved",
                  case .string(let eventId)? = event.data["causeEventId"] else { return nil }
            return eventId
        })
        let severity: [WorkspaceStatusAttention: Int] = [
            .none: 0, .info: 1, .action: 2, .approval: 3, .failure: 4,
        ]
        return events.compactMap { event -> WorkspaceStatusAttention? in
            guard event.kind == "status.attention", !resolved.contains(event.eventId),
                  event.data["resolved"] != .boolean(true),
                  case .string(let raw)? = event.data["value"] else { return nil }
            return WorkspaceStatusAttention(rawValue: raw)
        }.filter { $0 != .none }.max {
            severity[$0, default: 0] < severity[$1, default: 0]
        }
    }
}

public struct WorkspaceStatusReportView: Equatable {
    public let phase: String
    public let summary: String
    public let progress: Int?
    public let freshness: WorkspaceStatusFreshness

    public init(phase: String, summary: String, progress: Int?, freshness: WorkspaceStatusFreshness) {
        self.phase = phase
        self.summary = summary
        self.progress = progress
        self.freshness = freshness
    }
}

public struct WorkspaceStatusLifecycleView: Equatable {
    public let value: String
    public let freshness: WorkspaceStatusFreshness

    public init(value: String, freshness: WorkspaceStatusFreshness) {
        self.value = value
        self.freshness = freshness
    }
}

public struct WorkspaceVisibleStatus: Equatable {
    public let primaryLabel: String
    public let progress: Int?
    public let attention: WorkspaceStatusAttention
    public let sourceStack: [String]
    public let conflicts: [String]
}

public enum WorkspaceVisibleStatusComposer {
    public static func compose(
        report: WorkspaceStatusReportView?,
        providerLifecycle: WorkspaceStatusLifecycleView?,
        terminalHealth: String?,
        unresolvedTypedAttention: WorkspaceStatusAttention?,
        sourceStack: [String],
        conflicts: [String]
    ) -> WorkspaceVisibleStatus {
        let label: String
        let progress: Int?
        if let report, report.freshness == .fresh {
            label = "\(report.phase): \(report.summary)"
            progress = report.progress
        } else if let lifecycle = providerLifecycle {
            let marker = lifecycle.freshness == .fresh ? "" : " (\(lifecycle.freshness.rawValue))"
            label = lifecycle.value + marker
            progress = nil
        } else {
            label = terminalHealth ?? "unknown"
            progress = nil
        }
        return WorkspaceVisibleStatus(
            primaryLabel: label,
            progress: progress,
            attention: unresolvedTypedAttention ?? .none,
            sourceStack: sourceStack,
            conflicts: conflicts)
    }
}
