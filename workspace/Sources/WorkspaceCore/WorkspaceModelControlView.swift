import Foundation

/// The daemon-owned read model returned by `GET /model-control/snapshot`.
/// Swift decodes these decisions; it does not reproduce them from raw facts.
public struct WorkspaceModelControlView: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let observedAt: String
    public let snapshot: ModelControlSnapshot
    public let routing: WorkspaceRoutingPresentation
    public let providers: [String: WorkspaceProviderPresentation]
    private let tokenSessions: [WorkspaceJSONValue]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        guard schemaVersion == 1 else {
            throw DecodingError.dataCorruptedError(
                forKey: .schemaVersion,
                in: container,
                debugDescription: "workspace model-control schema version \(schemaVersion) is unsupported")
        }
        observedAt = try container.decode(String.self, forKey: .observedAt)
        snapshot = try container.decode(ModelControlSnapshot.self, forKey: .snapshot)
        routing = try container.decode(
            WorkspaceRoutingPresentation.self, forKey: .routing)
        providers = try container.decode(
            [String: WorkspaceProviderPresentation].self, forKey: .providers)
        tokenSessions = try container.decode([WorkspaceJSONValue].self, forKey: .tokenSessions)
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, observedAt, snapshot, routing, providers, tokenSessions
    }

    public func provider(_ id: ProviderID) -> WorkspaceProviderPresentation? {
        providers[id.rawValue]
    }

    public var providerIDs: [ProviderID] {
        providers.keys.map { ProviderID($0) }.sorted()
    }
}

public struct WorkspaceRoutingPresentation: Codable, Equatable, Sendable {
    public let policy: RoutingPolicyDocument
    public let categories: [TaskCategory]
    public let modes: [WorkspaceRoutingModePresentation]
    public let defaultMode: String
    public let weightRange: WorkspaceRoutingWeightRange
    public let catalog: [WorkspaceRoutingCatalogEntry]
    public let providers: [String: WorkspaceRoutingProviderState]
    public let models: [WorkspaceRoutingModelState]
    public let candidates: [WorkspaceRoutingCandidateState]
    public let warnings: [String]

    public func providerState(_ provider: ProviderID) -> String? {
        providers[provider.rawValue]?.state
    }

    public func modelState(
        provider: ProviderID, model: String
    ) -> WorkspaceRoutingModelState? {
        models.first { $0.provider == provider.rawValue && $0.model == model }
    }

    public func candidateState(
        scope: String, provider: String, model: String
    ) -> RouteCandidateStatus? {
        candidate(scope: scope, provider: provider, model: model)?.rendered
    }

    public func candidate(
        scope: String, provider: String, model: String
    ) -> WorkspaceRoutingCandidateState? {
        candidates.first {
            $0.scope == scope && $0.provider == provider && $0.model == model
        }
    }

    public func mode(_ id: String) -> WorkspaceRoutingModePresentation? {
        modes.first { $0.id == id }
    }

    public var renderedWarnings: [PolicyWarning] {
        warnings.compactMap {
            switch $0 {
            case "no-providers-enabled": return .noProvidersEnabled
            case "no-global-route": return .noGlobalRoute
            default: return nil
            }
        }
    }

}

public struct WorkspaceRoutingModePresentation: Codable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let caption: String
    public let weightEditable: Bool
}

public struct WorkspaceRoutingWeightRange: Codable, Equatable, Sendable {
    public let minimum: Int
    public let maximum: Int
    public let defaultValue: Int
}

public struct WorkspaceRoutingCatalogEntry: Codable, Equatable, Sendable {
    public let provider: String
    public let model: String
    public let effortOptions: [WorkspaceRoutingEffortOption]
    public let addEffortOptions: [WorkspaceRoutingEffortOption]
    public let startingEffort: RoutingPolicyDocument.CandidateEffort

    public init(
        provider: String,
        model: String,
        effortOptions: [WorkspaceRoutingEffortOption],
        addEffortOptions: [WorkspaceRoutingEffortOption],
        startingEffort: RoutingPolicyDocument.CandidateEffort
    ) {
        self.provider = provider
        self.model = model
        self.effortOptions = effortOptions
        self.addEffortOptions = addEffortOptions
        self.startingEffort = startingEffort
    }
}

public struct WorkspaceRoutingEffortOption: Codable, Equatable, Sendable {
    public let argument: String
    public let label: String
    public let effort: RoutingPolicyDocument.CandidateEffort
}

public struct WorkspaceRoutingProviderState: Codable, Equatable, Sendable {
    public let state: String
}

public struct WorkspaceRoutingModelState: Codable, Equatable, Sendable {
    public let provider: String
    public let model: String
    public let state: String
    public let source: String
    public let rowState: String
    public let preferenceOn: Bool

    public var rendered: ModelRowState {
        switch rowState {
        case "enabled": return .enabled
        case "seeded-off": return .seededOff
        case "disabled-by-self": return .disabledBySelf
        case "disabled-by-provider":
            return .disabledByProvider(preferenceOn: preferenceOn)
        default: return .unavailable
        }
    }
}

public struct WorkspaceRoutingCandidateState: Codable, Equatable, Sendable {
    public let scope: String
    public let provider: String
    public let model: String
    public let status: String
    /// The daemon's configured share of this scope's spawns, 0–1. Optional only so older frozen projections still decode; the view never computes a substitute.
    public let configuredShare: Double?

    public var rendered: RouteCandidateStatus {
        switch status {
        case "effective": return .effective
        case "provider-off": return .providerOff
        case "model-disabled": return .modelDisabled
        case "awaiting-consent": return .awaitingConsent
        default: return .unresolvable
        }
    }
}

public struct WorkspaceProviderPresentation: Codable, Equatable, Sendable {
    public let catalogState: String
    public let catalogReason: String?
    public let planLabel: String?
    public let billingChip: String
    public let spendCaveat: String?
    public let usage: WorkspaceProviderUsage
    public let models: [WorkspaceModelPresentation]

    private enum CodingKeys: String, CodingKey {
        case catalogState, catalogReason, planLabel, billingChip, spendCaveat, usage, models
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        catalogState = try container.decode(String.self, forKey: .catalogState)
        catalogReason = try container.decodeRequiredNullable(
            String.self, forKey: .catalogReason)
        planLabel = try container.decodeRequiredNullable(
            String.self, forKey: .planLabel)
        billingChip = try container.decode(String.self, forKey: .billingChip)
        spendCaveat = try container.decodeRequiredNullable(
            String.self, forKey: .spendCaveat)
        usage = try container.decode(WorkspaceProviderUsage.self, forKey: .usage)
        models = try container.decode(
            [WorkspaceModelPresentation].self, forKey: .models)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(catalogState, forKey: .catalogState)
        if let catalogReason {
            try container.encode(catalogReason, forKey: .catalogReason)
        } else {
            try container.encodeNil(forKey: .catalogReason)
        }
        if let planLabel {
            try container.encode(planLabel, forKey: .planLabel)
        } else {
            try container.encodeNil(forKey: .planLabel)
        }
        try container.encode(billingChip, forKey: .billingChip)
        if let spendCaveat {
            try container.encode(spendCaveat, forKey: .spendCaveat)
        } else {
            try container.encodeNil(forKey: .spendCaveat)
        }
        try container.encode(usage, forKey: .usage)
        try container.encode(models, forKey: .models)
    }

    public func model(canonicalID: String) -> WorkspaceModelPresentation? {
        models.first {
            $0.canonicalId == canonicalID
        }
    }
}

public struct WorkspaceModelPresentation: Codable, Equatable, Sendable {
    public let canonicalId: String
    public let variant: String?
    public let displayId: String
    public let name: String
    public let effortAxis: WorkspaceEffortAxis
    public let poolExhausted: Bool

    private enum CodingKeys: String, CodingKey {
        case canonicalId, variant, displayId, name, effortAxis, poolExhausted
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        canonicalId = try container.decode(String.self, forKey: .canonicalId)
        variant = try container.decodeRequiredNullable(String.self, forKey: .variant)
        displayId = try container.decode(String.self, forKey: .displayId)
        name = try container.decode(String.self, forKey: .name)
        effortAxis = try container.decode(WorkspaceEffortAxis.self, forKey: .effortAxis)
        poolExhausted = try container.decode(Bool.self, forKey: .poolExhausted)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(canonicalId, forKey: .canonicalId)
        if let variant {
            try container.encode(variant, forKey: .variant)
        } else {
            try container.encodeNil(forKey: .variant)
        }
        try container.encode(displayId, forKey: .displayId)
        try container.encode(name, forKey: .name)
        try container.encode(effortAxis, forKey: .effortAxis)
        try container.encode(poolExhausted, forKey: .poolExhausted)
    }
}

public enum WorkspaceProviderUsage: Codable, Equatable, Sendable {
    case metered([WorkspaceMeterWindow])
    case silent(String)
    case unmetered
    case unknown(String)

    private enum CodingKeys: String, CodingKey { case state, windows, reason }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .state) {
        case "metered":
            self = .metered(try container.decode(
                [WorkspaceMeterWindow].self, forKey: .windows))
        case "silent":
            self = .silent(try container.decode(String.self, forKey: .reason))
        case "unmetered": self = .unmetered
        case "unknown":
            self = .unknown(try container.decode(String.self, forKey: .reason))
        default:
            self = .unknown("unsupported provider usage state")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .metered(let windows):
            try container.encode("metered", forKey: .state)
            try container.encode(windows, forKey: .windows)
        case .silent(let reason):
            try container.encode("silent", forKey: .state)
            try container.encode(reason, forKey: .reason)
        case .unmetered:
            try container.encode("unmetered", forKey: .state)
        case .unknown(let reason):
            try container.encode("unknown", forKey: .state)
            try container.encode(reason, forKey: .reason)
        }
    }

    public var rendered: ProviderUsage {
        switch self {
        case .metered(let windows):
            return .metered(windows.map { MeterWindow(label: $0.label, state: $0.meter.rendered) })
        case .silent(let reason): return .silent(reason: reason)
        case .unmetered: return .unmetered
        case .unknown(let reason): return .unknown(reason: reason)
        }
    }
}

public struct WorkspaceMeterWindow: Codable, Equatable, Sendable {
    public let label: String
    public let meter: WorkspaceMeterState
}

public enum WorkspaceMeterState: Codable, Equatable, Sendable {
    case measured(Double, String?, String?, String)
    case stale(Double, String?, String?)
    case unknown(String)
    case notMetered

    private enum CodingKeys: String, CodingKey {
        case state, usedPercent, resetsAt, observedAt, confidence, reason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .state) {
        case "measured":
            self = .measured(
                try container.decode(Double.self, forKey: .usedPercent),
                try container.decodeRequiredNullable(String.self, forKey: .resetsAt),
                try container.decodeRequiredNullable(String.self, forKey: .observedAt),
                try container.decode(String.self, forKey: .confidence))
        case "stale":
            self = .stale(
                try container.decode(Double.self, forKey: .usedPercent),
                try container.decodeRequiredNullable(String.self, forKey: .observedAt),
                try container.decodeRequiredNullable(String.self, forKey: .resetsAt))
        case "not-metered": self = .notMetered
        case "unknown":
            self = .unknown(try container.decode(String.self, forKey: .reason))
        default:
            self = .unknown("unsupported meter state")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .measured(let used, let resets, let observed, let confidence):
            try container.encode("measured", forKey: .state)
            try container.encode(used, forKey: .usedPercent)
            try container.encode(resets, forKey: .resetsAt)
            try container.encode(observed, forKey: .observedAt)
            try container.encode(confidence, forKey: .confidence)
        case .stale(let used, let observed, let resets):
            try container.encode("stale", forKey: .state)
            try container.encode(used, forKey: .usedPercent)
            try container.encode(resets, forKey: .resetsAt)
            try container.encode(observed, forKey: .observedAt)
        case .unknown(let reason):
            try container.encode("unknown", forKey: .state)
            try container.encode(reason, forKey: .reason)
        case .notMetered:
            try container.encode("not-metered", forKey: .state)
        }
    }

    public var rendered: MeterState {
        switch self {
        case .measured(let used, let resets, let observed, let confidence):
            return .measured(
                usedPercent: used,
                resetsAt: WireDate.parseISO(resets),
                observedAt: WireDate.parseISO(observed),
                confidence: confidence)
        case .stale(let used, let observed, let resets):
            return .stale(
                usedPercent: used,
                observedAt: WireDate.parseISO(observed),
                resetsAt: WireDate.parseISO(resets))
        case .unknown(let reason): return .unknown(reason: reason)
        case .notMetered: return .notMetered
        }
    }
}

public enum WorkspaceEffortAxis: Codable, Equatable, Sendable {
    case known([String], String?)
    case none
    case unknown(String)

    private enum CodingKeys: String, CodingKey { case state, levels, defaultLevel, reason }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .state) {
        case "known":
            self = .known(
                try container.decode([String].self, forKey: .levels),
                try container.decodeRequiredNullable(String.self, forKey: .defaultLevel))
        case "none": self = .none
        case "unknown":
            self = .unknown(try container.decode(String.self, forKey: .reason))
        default: self = .unknown("unsupported effort-axis state")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .known(let levels, let defaultLevel):
            try container.encode("known", forKey: .state)
            try container.encode(levels, forKey: .levels)
            try container.encode(defaultLevel, forKey: .defaultLevel)
        case .none:
            try container.encode("none", forKey: .state)
        case .unknown(let reason):
            try container.encode("unknown", forKey: .state)
            try container.encode(reason, forKey: .reason)
        }
    }

    public var rendered: EffortAxis {
        switch self {
        case .known(let levels, let defaultLevel):
            return .known(levels: levels, defaultLevel: defaultLevel)
        case .none: return .none
        case .unknown(let reason): return .unknown(reason: reason)
        }
    }
}
