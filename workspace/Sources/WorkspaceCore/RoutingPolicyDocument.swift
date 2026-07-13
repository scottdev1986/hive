import Foundation

/// The daemon's routing policy document — the durable store behind the Model
/// Control Center, mirrored from `src/schemas/routing-policy.ts` exactly:
/// chains carry exact (provider, model, effort) targets and nothing else; a
/// bare "default" model id is illegal; and the document lists only EXPLICIT
/// settings.
///
/// FAIL-CLOSED READING, inherited from the schema's one rule: an absent row
/// means NOT CONFIGURED, and not-configured never means allowed. The readers
/// below are the one Swift implementation of that rule — UI code must not
/// re-derive it by hand.
public struct RoutingPolicyDocument: Codable, Equatable, Sendable {

    /// Effort as the wire spells it: `{mode: "exact", value}` /
    /// `{mode: "none"}` / `{mode: "provider-controlled"}`.
    public enum WireEffort: Equatable, Sendable {
        case exact(String)
        case none
        case providerControlled

        public var asEffortTarget: EffortTarget {
            switch self {
            case .exact(let value): return .exact(value)
            case .none: return EffortTarget.none
            case .providerControlled: return .providerControlled
            }
        }

        public init(_ target: EffortTarget) {
            switch target {
            case .exact(let value): self = .exact(value)
            case .none: self = .none
            case .providerControlled: self = .providerControlled
            }
        }

        /// The CLI argument spelling (`parseEffortTargetArg`).
        public var cliArgument: String {
            switch self {
            case .exact(let value): return "exact:\(value)"
            case .none: return "none"
            case .providerControlled: return "provider-controlled"
            }
        }
    }

    public struct WireChainEntry: Codable, Equatable, Sendable {
        public var provider: String
        public var model: String
        public var effort: WireEffort

        public init(provider: String, model: String, effort: WireEffort) {
            self.provider = provider
            self.model = model
            self.effort = effort
        }

        /// The CLI chain-link spelling (`parseChainEntryArg`):
        /// `provider/model`, `provider/model@LEVEL`, or `provider/model@none`.
        public var cliArgument: String {
            switch effort {
            case .providerControlled: return "\(provider)/\(model)"
            case .none: return "\(provider)/\(model)@none"
            case .exact(let value): return "\(provider)/\(model)@\(value)"
            }
        }
    }

    public struct ModelRow: Codable, Equatable, Sendable {
        public var provider: String
        public var model: String
        /// Absent state = the row exists only for its effort; enablement then
        /// still inherits from the provider (or stays unconfigured).
        public var state: String?
        public var effort: WireEffort?

        public init(provider: String, model: String, state: String? = nil, effort: WireEffort? = nil) {
            self.provider = provider
            self.model = model
            self.state = state
            self.effort = effort
        }
    }

    public var schemaVersion: Int
    /// Monotonic; every accepted mutation increments it. Writers present the
    /// revision they read — compare-and-set, so concurrent edits conflict
    /// loudly instead of clobbering.
    public var revision: Int
    public var updatedAt: String
    /// True while the document is still the seeded baseline no human has
    /// edited — the "Provisional Hive suggestions" banner flag.
    public var provisional: Bool
    public var providers: [String: String]
    public var models: [ModelRow]
    public var chains: [String: [WireChainEntry]]

    public static func decode(from data: Data) throws -> RoutingPolicyDocument {
        try JSONDecoder().decode(RoutingPolicyDocument.self, from: data)
    }

    // MARK: Fail-closed reading (mirrors providerPolicyState / modelPolicyState)

    public enum PolicyState: String, Equatable, Sendable {
        case enabled
        case disabled
        /// Absent from the document. NOT a synonym for enabled, and never
        /// "allowed to spend" — the UI renders it as off-awaiting-consent.
        case unconfigured
    }

    public func providerState(_ provider: ProviderID) -> PolicyState {
        switch providers[provider.rawValue] {
        case "enabled": return .enabled
        case "disabled": return .disabled
        default: return .unconfigured
        }
    }

    /// Which row answered, so the UI can show effective-vs-preference without
    /// re-deriving the rule.
    public enum PolicySource: Equatable, Sendable {
        case provider
        case model
        case none
    }

    /// Provider-DISABLED overrides everything under it. An explicit model row
    /// answers next. An enabled provider covers rows with no explicit state.
    /// Absent everywhere is unconfigured.
    public func modelState(
        provider: ProviderID, model: String
    ) -> (state: PolicyState, source: PolicySource) {
        let providerState = providerState(provider)
        if providerState == .disabled { return (.disabled, .provider) }
        if let row = modelRow(provider: provider, model: model),
           let state = row.state {
            return (state == "enabled" ? .enabled : .disabled, .model)
        }
        if providerState == .enabled { return (.enabled, .provider) }
        return (.unconfigured, PolicySource.none)
    }

    public func modelRow(provider: ProviderID, model: String) -> ModelRow? {
        models.first { $0.provider == provider.rawValue && $0.model == model }
    }

    /// The user's standing effort choice for a model, if they made one.
    public func modelEffort(provider: ProviderID, model: String) -> EffortTarget? {
        modelRow(provider: provider, model: model)?.effort?.asEffortTarget
    }

    public func chain(for category: TaskCategory) -> [WireChainEntry] {
        chains[category.rawValue] ?? []
    }

    /// The user-authored global fallback ("default" is a CATEGORY key in the
    /// store; it is never a model id).
    public var defaultChain: [WireChainEntry] {
        chains["default"] ?? []
    }

    // MARK: View-state bridges

    /// The model-row render state under consent-is-enablement:
    /// - explicit enabled → enabled
    /// - provider-disabled → the override chrome (preference = the row's own
    ///   explicit state, when it has one)
    /// - explicit model disabled → user-off
    /// - unconfigured → off-awaiting-consent (the inviting treatment)
    public func rowState(
        provider: ProviderID, model: String, available: Bool
    ) -> ModelRowState {
        guard available else { return .unavailable }
        let reading = modelState(provider: provider, model: model)
        switch (reading.state, reading.source) {
        case (.enabled, _):
            return .enabled
        case (.disabled, .provider):
            let own = modelRow(provider: provider, model: model)?.state
            return .disabledByProvider(preferenceOn: own == "enabled")
        case (.disabled, _):
            return .disabledBySelf
        case (.unconfigured, _):
            return .seededOff
        }
    }
}

extension RoutingPolicyDocument.WireEffort: Codable {
    private enum CodingKeys: String, CodingKey { case mode, value }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .mode) {
        case "exact":
            self = .exact(try container.decode(String.self, forKey: .value))
        case "none":
            self = .none
        case "provider-controlled":
            self = .providerControlled
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .mode, in: container,
                debugDescription: "unknown effort mode \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .exact(let value):
            try container.encode("exact", forKey: .mode)
            try container.encode(value, forKey: .value)
        case .none:
            try container.encode("none", forKey: .mode)
        case .providerControlled:
            try container.encode("provider-controlled", forKey: .mode)
        }
    }
}
