// QueenProviderScreen.swift The Queen Provider control surface: which vendor runs the live Queen. This mirrors `src/schemas/queen-provider.ts` and deliberately stops where it stops. Replacing the live Queen is a multi-step operation inside the daemon, and none of those steps are here: one revisioned projection, one compare-and-set, one opaque change state. A field naming an internal step would freeze that mechanism into the wire — the mechanism is expected to be replaced, the wire is not. The projection reports OBSERVATION, never intention. `liveProvider` is the provider of the root's running foreground process as the daemon last saw it. A queen that was requested but never came up reads as no provider with the change still pending, because that is what is true.

import Foundation

/// What the root is doing. Current daemons preserve the queen TUI's exact turn
/// state; unknown values remain round-trippable for wire compatibility.
public enum QueenRootHealth: Equatable, Sendable {
    case spawning
    case connecting
    case ready
    case queued
    case submitting
    case working
    case idle
    case awaitingApproval
    case awaitingAnswer
    case cancelling
    case done
    case failed
    case disconnected
    case exited
    /// A state a newer daemon reports. Kept verbatim so one unknown value costs this row its health reading and never the whole screen.
    case unknown(String)

    public var label: String {
        switch self {
        case .spawning: return "Spawning"
        case .connecting: return "Connecting"
        case .ready: return "Ready"
        case .queued: return "Queued"
        case .submitting: return "Sending"
        case .working: return "Working"
        case .idle: return "Idle"
        case .awaitingApproval: return "Approval needed"
        case .awaitingAnswer: return "Answer needed"
        case .cancelling: return "Stopping"
        case .done: return "Done"
        case .failed: return "Failed"
        case .disconnected: return "Disconnected"
        case .exited: return "Exited"
        case .unknown(let value): return value
        }
    }
}

extension QueenRootHealth: Codable {
    public init(from decoder: Decoder) throws {
        switch try decoder.singleValueContainer().decode(String.self) {
        case "spawning": self = .spawning
        case "connecting": self = .connecting
        case "ready": self = .ready
        case "queued": self = .queued
        case "submitting": self = .submitting
        case "working": self = .working
        case "idle": self = .idle
        case "awaiting_approval": self = .awaitingApproval
        case "awaiting_answer": self = .awaitingAnswer
        case "cancelling": self = .cancelling
        case "done": self = .done
        case "failed": self = .failed
        case "disconnected": self = .disconnected
        case "exited": self = .exited
        case let other: self = .unknown(other)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        let value: String
        switch self {
        case .awaitingApproval: value = "awaiting_approval"
        case .awaitingAnswer: value = "awaiting_answer"
        case .submitting: value = "submitting"
        case .cancelling: value = "cancelling"
        case .spawning: value = "spawning"
        case .connecting: value = "connecting"
        case .ready: value = "ready"
        case .queued: value = "queued"
        case .working: value = "working"
        case .idle: value = "idle"
        case .done: value = "done"
        case .failed: value = "failed"
        case .disconnected: value = "disconnected"
        case .exited: value = "exited"
        case .unknown(let raw): value = raw
        }
        try container.encode(value)
    }
}

/// The one change state a client ever sees. There is no fourth: the daemon's succession internals do not cross this boundary.
public enum QueenProviderChangeState: Equatable, Sendable {
    case idle
    /// A compare-and-set was accepted and the daemon has not yet OBSERVED the requested provider running as the root.
    case pending
    /// The last accepted change did not produce the requested queen. Sticky
    /// while the preserved prior is what is running, or while nothing is.
    case failed
    case unknown(String)

    public var label: String {
        switch self {
        case .idle: return "idle"
        case .pending: return "pending"
        case .failed: return "failed"
        case .unknown(let value): return value
        }
    }
}

extension QueenProviderChangeState: Codable {
    public init(from decoder: Decoder) throws {
        switch try decoder.singleValueContainer().decode(String.self) {
        case "idle": self = .idle
        case "pending": self = .pending
        case "failed": self = .failed
        case let other: self = .unknown(other)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(label)
    }
}

public struct QueenProviderChange: Codable, Equatable, Sendable {
    public var state: QueenProviderChangeState
    /// Bumped by every ACCEPTED change, never by observation. The compare-and-set token, and a decimal uint64 STRING on the wire — wide enough that no Int is promised to hold it.
    public var revision: String
    public var failure: String?

    public init(state: QueenProviderChangeState, revision: String, failure: String?) {
        self.state = state
        self.revision = revision
        self.failure = failure
    }

    private enum CodingKeys: String, CodingKey {
        case state
        case revision
        case failure
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = try container.decode(QueenProviderChangeState.self, forKey: .state)
        revision = try container.decode(String.self, forKey: .revision)
        failure = try container.decodeRequiredNullable(String.self, forKey: .failure)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(state, forKey: .state)
        try container.encode(revision, forKey: .revision)
        if let failure {
            try container.encode(failure, forKey: .failure)
        } else {
            try container.encodeNil(forKey: .failure)
        }
    }
}

/// The one root. Its identity never changes when its vendor does.
public struct QueenRootIdentity: Codable, Equatable, Sendable {
    public var name: String
    public var instanceId: String

}

/// Whether this vendor's CLI can launch a queen on this machine right now. Observed by probing the executable, never assumed from configuration.
public struct QueenVendorCapability: Codable, Equatable, Sendable {
    public var available: Bool

}

public struct QueenProviderProjection: Codable, Equatable, Sendable {
    public var schemaVersion: Int
    public var root: QueenRootIdentity
    /// The provider of the observed running root, or nil when no root foreground process is currently observed. Never a launch argument.
    public var liveProvider: ProviderID?
    public var health: QueenRootHealth?
    public var contradicted: Bool
    /// Every vendor, always. An absent key would read as "unknown vendor" rather than "unavailable vendor", and this surface exists to offer the choice.
    public var vendors: [String: QueenVendorCapability]
    public var change: QueenProviderChange
    public var observedAt: String

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case root
        case liveProvider
        case health
        case contradicted
        case vendors
        case change
        case observedAt
    }

    /// `schemaVersion` is a compatibility gate, not a reading: a document from a version this build does not implement must refuse to decode rather than be interpreted under the wrong rules. The state enums go the other way on purpose — see QueenRootHealth.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        guard schemaVersion == 1 else {
            throw DecodingError.dataCorruptedError(
                forKey: .schemaVersion,
                in: container,
                debugDescription:
                    "queen provider schema version \(schemaVersion) is not implemented "
                    + "by this build")
        }
        root = try container.decode(QueenRootIdentity.self, forKey: .root)
        liveProvider = try container.decodeRequiredNullable(
            ProviderID.self, forKey: .liveProvider)
        health = try container.decodeRequiredNullable(
            QueenRootHealth.self, forKey: .health)
        contradicted = try container.decode(Bool.self, forKey: .contradicted)
        vendors = try container.decode(
            [String: QueenVendorCapability].self, forKey: .vendors)
        change = try container.decode(QueenProviderChange.self, forKey: .change)
        observedAt = try container.decode(String.self, forKey: .observedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(root, forKey: .root)
        if let liveProvider {
            try container.encode(liveProvider, forKey: .liveProvider)
        } else {
            try container.encodeNil(forKey: .liveProvider)
        }
        if let health {
            try container.encode(health, forKey: .health)
        } else {
            try container.encodeNil(forKey: .health)
        }
        try container.encode(contradicted, forKey: .contradicted)
        try container.encode(vendors, forKey: .vendors)
        try container.encode(change, forKey: .change)
        try container.encode(observedAt, forKey: .observedAt)
    }

    public var vendorIDs: [ProviderID] {
        vendors.keys.map { ProviderID($0) }.sorted()
    }

    /// What the screen says the root is doing. Contradiction wins: a record that disagrees with itself is reported as such rather than summarised.
    public var healthDescription: String {
        if contradicted {
            return "the root's own event record contradicts itself"
        }
        return health?.label ?? "unknown — no trustworthy signal yet"
    }
}

extension QueenProviderProjection {
    public var facts: [ShellScreenFact] {
        var facts = [
            ShellScreenFact(label: "Root", value: "\(root.name) · \(root.instanceId)"),
            ShellScreenFact(
                label: "Live provider",
                value: liveProvider?.rawValue
                    ?? "none observed — no root foreground process"),
            ShellScreenFact(label: "Health", value: healthDescription),
            ShellScreenFact(
                label: "Change",
                value: "\(change.state.label) · revision \(change.revision)"),
        ]
        if let failure = change.failure {
            facts.append(ShellScreenFact(label: "Last failure", value: failure))
        }
        for vendor in vendorIDs {
            let available = vendors[vendor.rawValue]?.available == true
            facts.append(ShellScreenFact(
                label: vendor.rawValue,
                value: available
                    ? "can launch a queen on this machine"
                    : "cannot launch a queen here right now"))
        }
        return facts
    }
}

/// The compare-and-set body. `expectedRevision` is the revision that was read; a stale one fails whole and nothing is terminated, launched, or recorded.
public struct SetLiveQueenProviderBody: Codable, Equatable, Sendable {
    public let provider: String
    public let expectedRevision: String

    public init(provider: String, expectedRevision: String) {
        self.provider = provider
        self.expectedRevision = expectedRevision
    }
}

/// Holds the observed projection beside the vendor the user picked but has not sent. A rejected swap keeps that choice: the daemon moving on is not a reason to silently discard what someone selected.
public struct QueenProviderEditor: Equatable, Sendable {
    public private(set) var observed: QueenProviderProjection
    public private(set) var draft: ProviderID?
    public private(set) var competingRevision: String?
    public private(set) var mutationsAllowed: Bool

    public init(
        projection: QueenProviderProjection,
        availability: ProjectionAvailability = .current
    ) {
        observed = projection
        mutationsAllowed = availability == .current
    }

    public var hasDraft: Bool {
        guard let draft else { return false }
        return draft != observed.liveProvider
    }

    public mutating func select(_ provider: ProviderID?) {
        draft = provider
        competingRevision = nil
    }

    public mutating func fence() {
        mutationsAllowed = false
    }

    /// Takes a fresh observation while keeping an unsent selection, so the poll that resolves a pending change cannot cost the user their choice.
    public mutating func observe(_ refreshed: QueenProviderEditor) {
        observed = refreshed.observed
        competingRevision = nil
        mutationsAllowed = refreshed.mutationsAllowed
    }

    public func body() -> SetLiveQueenProviderBody? {
        guard mutationsAllowed, hasDraft, let draft else { return nil }
        return SetLiveQueenProviderBody(
            provider: draft.rawValue,
            expectedRevision: observed.change.revision)
    }

    /// An accepted swap adopts the daemon's projection and the selection has become the request in flight. A rejection updates only the observation and names the revision that outran the caller; the selection stands.
    public mutating func apply(_ result: MutationResult<QueenProviderProjection>) {
        switch result.outcome {
        case .accepted:
            observed = result.observedPostState
            competingRevision = nil
        case .rejected:
            observed = result.observedPostState
            competingRevision = result.observedPostState.change.revision
        }
    }
}
