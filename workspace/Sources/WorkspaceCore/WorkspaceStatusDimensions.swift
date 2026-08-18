import Foundation

public protocol WorkspaceStatusWireValue: Decodable, Equatable {
    static var knownWireValues: [String: Self] { get }
    static func makeUnknown(_ value: String) -> Self
    var unknownWireValue: String? { get }
    var wireValue: String { get }
}

public extension WorkspaceStatusWireValue {
    init(wireValue: String) {
        self = Self.knownWireValues[wireValue] ?? Self.makeUnknown(wireValue)
    }

    init(from decoder: Decoder) throws {
        self.init(wireValue: try decoder.singleValueContainer().decode(String.self))
    }

    var wireValue: String {
        if let unknownWireValue { return unknownWireValue }
        guard let value = Self.knownWireValues.first(where: { $0.value == self })?.key else {
            preconditionFailure("status value has no wire representation")
        }
        return value
    }
}

public enum WorkspaceRuntimeState: WorkspaceStatusWireValue {
    case starting, connecting, ready, degraded, disconnected, exited
    case unknown(String)

    public static let knownWireValues: [String: Self] = [
        "starting": .starting, "connecting": .connecting, "ready": .ready,
        "degraded": .degraded, "disconnected": .disconnected, "exited": .exited,
    ]
    public static func makeUnknown(_ value: String) -> Self { .unknown(value) }
    public var unknownWireValue: String? {
        if case .unknown(let value) = self { value } else { nil }
    }
}

public enum WorkspaceTurnState: WorkspaceStatusWireValue {
    case ready, working, idle, queued, submitting, awaitingApproval
    case awaitingAnswer, cancelling, paused, stuck, done, failed
    case unknown(String)

    public static let knownWireValues: [String: Self] = [
        "ready": .ready, "working": .working, "idle": .idle, "queued": .queued,
        "submitting": .submitting, "awaiting_approval": .awaitingApproval,
        "awaiting_answer": .awaitingAnswer, "cancelling": .cancelling,
        "paused": .paused, "stuck": .stuck, "done": .done, "failed": .failed,
    ]
    public static func makeUnknown(_ value: String) -> Self { .unknown(value) }
    public var unknownWireValue: String? {
        if case .unknown(let value) = self { value } else { nil }
    }
}

public enum WorkspaceInputState: WorkspaceStatusWireValue {
    case empty, editing, composing, queued, deliveryUnknown
    case unknown(String)

    public static let knownWireValues: [String: Self] = [
        "empty": .empty, "editing": .editing,
        "composing": .composing, "queued": .queued, "delivery_unknown": .deliveryUnknown,
    ]
    public static func makeUnknown(_ value: String) -> Self { .unknown(value) }
    public var unknownWireValue: String? {
        if case .unknown(let value) = self { value } else { nil }
    }
}

public enum WorkspaceMailState: WorkspaceStatusWireValue {
    case none, waiting, waking, claimed, retrying, deadLettered
    case unknown(String)

    public static let knownWireValues: [String: Self] = [
        "none": .none, "waiting": .waiting, "waking": .waking,
        "claimed": .claimed, "retrying": .retrying, "dead_lettered": .deadLettered,
    ]
    public static func makeUnknown(_ value: String) -> Self { .unknown(value) }
    public var unknownWireValue: String? {
        if case .unknown(let value) = self { value } else { nil }
    }
}

public enum WorkspaceHealthState: WorkspaceStatusWireValue {
    case healthy, delayed, stale, disconnected
    case unknown(String)

    public static let knownWireValues: [String: Self] = [
        "healthy": .healthy, "delayed": .delayed, "stale": .stale,
        "disconnected": .disconnected,
    ]
    public static func makeUnknown(_ value: String) -> Self { .unknown(value) }
    public var unknownWireValue: String? {
        if case .unknown(let value) = self { value } else { nil }
    }
}

public enum WorkspaceStatusFreshness: WorkspaceStatusWireValue {
    case fresh, stale
    case unknown(String)

    public static let knownWireValues: [String: Self] = ["fresh": .fresh, "stale": .stale]
    public static func makeUnknown(_ value: String) -> Self { .unknown(value) }
    public var unknownWireValue: String? {
        if case .unknown(let value) = self { value } else { nil }
    }
}

public enum WorkspaceStatusConfidence: WorkspaceStatusWireValue {
    case authoritative, high, low
    case unknown(String)

    public static let knownWireValues: [String: Self] = [
        "authoritative": .authoritative, "high": .high, "low": .low,
    ]
    public static func makeUnknown(_ value: String) -> Self { .unknown(value) }
    public var unknownWireValue: String? {
        if case .unknown(let value) = self { value } else { nil }
    }
}

public enum WorkspaceStatusAttention: WorkspaceStatusWireValue, Hashable {
    case none, info, action, approval, failure
    case unknown(String)

    public static let knownWireValues: [String: Self] = [
        "none": .none, "info": .info, "action": .action,
        "approval": .approval, "failure": .failure,
    ]
    public static func makeUnknown(_ value: String) -> Self { .unknown(value) }
    public var unknownWireValue: String? {
        if case .unknown(let value) = self { value } else { nil }
    }
}

public struct WorkspaceStatusSource: Decodable, Equatable {
    public let kind: String
    public let id: String
}

public struct WorkspaceStatusField<Value: WorkspaceStatusWireValue>: Decodable, Equatable {
    public let value: Value
    public let source: WorkspaceStatusSource
    public let observedAt: String
    public let freshness: WorkspaceStatusFreshness
    public let confidence: WorkspaceStatusConfidence
}

public enum WorkspaceStatusAbsence: Decodable, Equatable {
    case vendorDoesNotReport(citation: String)
    case disconnected(since: String)
    case staleSince(observedAt: String)
    case unmeasured
    case unknown(String)

    private enum CodingKeys: String, CodingKey {
        case kind, citation, since, observedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "vendor-does-not-report":
            self = .vendorDoesNotReport(
                citation: try container.decode(String.self, forKey: .citation))
        case "disconnected":
            self = .disconnected(since: try container.decode(String.self, forKey: .since))
        case "stale-since":
            self = .staleSince(
                observedAt: try container.decode(String.self, forKey: .observedAt))
        case "unmeasured": self = .unmeasured
        default: self = .unknown(kind)
        }
    }

    public var wireValue: String {
        switch self {
        case .vendorDoesNotReport: "vendor-does-not-report"
        case .disconnected: "disconnected"
        case .staleSince: "stale-since"
        case .unmeasured: "unmeasured"
        case .unknown(let value): value
        }
    }
}

public enum WorkspaceStatusDimension<Value: WorkspaceStatusWireValue>: Decodable, Equatable {
    case observed(WorkspaceStatusField<Value>)
    case absent(WorkspaceStatusAbsence)

    private enum CodingKeys: String, CodingKey {
        case kind, field, reason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "observed":
            self = .observed(try container.decode(
                WorkspaceStatusField<Value>.self, forKey: .field))
        case "absent":
            self = .absent(try container.decode(WorkspaceStatusAbsence.self, forKey: .reason))
        case let kind:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "unsupported status dimension kind \(kind)")
        }
    }

}

public struct WorkspaceStatusDimensions: Decodable, Equatable {
    public let schemaVersion: Int
    public let revision: String
    public let runtime: WorkspaceStatusDimension<WorkspaceRuntimeState>
    public let turn: WorkspaceStatusDimension<WorkspaceTurnState>
    public let input: WorkspaceStatusDimension<WorkspaceInputState>
    public let mail: WorkspaceStatusDimension<WorkspaceMailState>
    public let health: WorkspaceStatusDimension<WorkspaceHealthState>
    public let attention: WorkspaceStatusDimension<WorkspaceStatusAttention>

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, revision, runtime, turn, input, mail, health, attention
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        guard schemaVersion == 1 else {
            throw DecodingError.dataCorruptedError(
                forKey: .schemaVersion,
                in: container,
                debugDescription: "unsupported status dimensions schemaVersion \(schemaVersion)")
        }
        revision = try container.decode(String.self, forKey: .revision)
        runtime = try container.decode(
            WorkspaceStatusDimension<WorkspaceRuntimeState>.self, forKey: .runtime)
        turn = try container.decode(
            WorkspaceStatusDimension<WorkspaceTurnState>.self, forKey: .turn)
        input = try container.decode(
            WorkspaceStatusDimension<WorkspaceInputState>.self, forKey: .input)
        mail = try container.decode(
            WorkspaceStatusDimension<WorkspaceMailState>.self, forKey: .mail)
        health = try container.decode(
            WorkspaceStatusDimension<WorkspaceHealthState>.self, forKey: .health)
        attention = try container.decode(
            WorkspaceStatusDimension<WorkspaceStatusAttention>.self, forKey: .attention)
    }

}
