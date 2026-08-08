import Foundation

/// Editing types for the daemon-owned routing policy. Swift holds only transient
/// drafts; every authoritative state arrives in a daemon response.

/// One category descriptor from the daemon's routing catalog. The identifier
/// and label are both wire data; Swift has no parallel category vocabulary.
public struct TaskCategory: Codable, Hashable, Sendable {
    public let rawValue: String
    public let label: String

    public init(rawValue: String, label: String) {
        self.rawValue = rawValue
        self.label = label
    }

    private enum CodingKeys: String, CodingKey {
        case rawValue = "id"
        case label
    }
}

public enum EffortTarget: Equatable, Codable, Sendable {
    case exact(String)
    case none
    case providerControlled
}

public enum RouterMode: String, CaseIterable, Codable, Sendable {
    case userWeighted = "user-weighted"
    case hiveEqual = "hive-equal"
}

public struct RouteCandidate: Equatable, Codable, Sendable {
    public var provider: String
    public var model: String
    public var effort: EffortTarget?
    /// A rating, not a percentage: 60/20/20 and 3/1/1 express the same distribution. Integer 1–100; zero is illegal — disablement stays the explicit provider/model enablement control, never a weight.
    public var weight: Int

    public init(provider: String, model: String, effort: EffortTarget?, weight: Int) {
        self.provider = provider
        self.model = model
        self.effort = effort
        self.weight = weight
    }

    public var targetKey: String {
        [provider, model].joined(separator: "\u{0}")
    }
}

public struct RoutePolicy: Equatable, Codable, Sendable {
    public var mode: RouterMode
    public var candidates: [RouteCandidate]

    public init(mode: RouterMode, candidates: [RouteCandidate]) {
        self.mode = mode
        self.candidates = candidates
    }

}

public enum RouteCandidateStatus: Equatable, Sendable {
    case effective
    case providerOff
    case modelDisabled
    case awaitingConsent
    /// The model left the live catalog. Stays in policy, marked, never silently dropped and never launched.
    case unresolvable

}

public enum PolicyWarning: Equatable, Sendable {
    /// "No providers enabled — Hive cannot spawn agents…"
    case noProvidersEnabled
    case noGlobalRoute

}
