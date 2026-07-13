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

    /// Effort as the wire spells it, mirroring `EffortTargetSchema`:
    /// `{mode: "never-configured"}` / `{mode: "hive-decides"}` /
    /// `{mode: "exact", value}` / `{mode: "none"}` /
    /// `{mode: "provider-controlled"}`.
    public enum WireEffort: Equatable, Sendable {
        /// The user has not answered. NOT a synonym for any effort we would
        /// send — it is the absence of a choice.
        case neverConfigured
        /// Hive picks from the model's advertised levels; not a standing user
        /// preference, so the control shows no selection.
        case hiveDecides
        case exact(String)
        case none
        case providerControlled
        /// A mode a NEWER daemon added. Kept verbatim: an effort this build
        /// cannot name must cost that one row its effort reading — never the
        /// whole document, and never a value the user did not choose.
        case unknown(String)

        /// The user's standing choice, or nil when the wire says there isn't
        /// one this build can name. Nil renders as unchosen; nothing here
        /// invents an effort.
        public var asEffortTarget: EffortTarget? {
            switch self {
            case .exact(let value): return .exact(value)
            case .none: return EffortTarget.none
            case .providerControlled: return .providerControlled
            case .neverConfigured, .hiveDecides, .unknown: return nil
            }
        }

        /// No choice (nil) is `never-configured` on the wire — the daemon's own
        /// spelling for unanswered.
        public init(_ target: EffortTarget?) {
            guard let target else {
                self = .neverConfigured
                return
            }
            switch target {
            case .exact(let value): self = .exact(value)
            case .none: self = .none
            case .providerControlled: self = .providerControlled
            }
        }

        /// The CLI argument spelling (`parseEffortTargetArg`). An unknown mode
        /// is passed through as-is: the daemon refuses what it does not know,
        /// which is the loud failure we want — far better than guessing.
        public var cliArgument: String {
            switch self {
            case .neverConfigured: return "never-configured"
            case .hiveDecides: return "hive-decides"
            case .exact(let value): return "exact:\(value)"
            case .none: return "none"
            case .providerControlled: return "provider-controlled"
            case .unknown(let mode): return mode
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
        ///
        /// NIL when the link's effort has no chain spelling at all — the chain
        /// CLI cannot express never-configured, hive-decides, or a mode this
        /// build has never heard of. The caller must REFUSE the write rather
        /// than pick the nearest spelling: silently rewriting one link's effort
        /// is a routing change the user never made.
        public var cliArgument: String? {
            switch effort {
            case .providerControlled: return "\(provider)/\(model)"
            case .none: return "\(provider)/\(model)@none"
            case .exact(let value): return "\(provider)/\(model)@\(value)"
            case .neverConfigured, .hiveDecides, .unknown: return nil
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

    /// How work distributes among a chain's capable models: "spread" (by
    /// remaining capacity, the default) or "strict" (always in rank order).
    /// Per-category entries are OVERRIDES of the global mode. Prefaulted at
    /// decode, mirroring the daemon's parse-time prefault.
    public struct Selection: Codable, Equatable, Sendable {
        public var global: String
        public var categories: [String: String]

        public init(global: String = "spread", categories: [String: String] = [:]) {
            self.global = global
            self.categories = categories
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
    public var selection: Selection
    /// Whether the daemon actually SENT the selection field. False means the
    /// running daemon predates selection modes: the UI must not offer a
    /// control whose persist would always fail.
    public var selectionOnWire: Bool = false

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, revision, updatedAt, provisional
        case providers, models, chains, selection
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        revision = try container.decode(Int.self, forKey: .revision)
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
        provisional = try container.decode(Bool.self, forKey: .provisional)
        providers = try container.decode([String: String].self, forKey: .providers)
        models = try container.decode([ModelRow].self, forKey: .models)
        chains = try container.decode([String: [WireChainEntry]].self, forKey: .chains)
        // Prefaulted, like the daemon's parse: an older document without the
        // field reads as global spread with no overrides.
        let sent = try container.decodeIfPresent(Selection.self, forKey: .selection)
        selection = sent ?? Selection()
        selectionOnWire = sent != nil
    }

    public static func decode(from data: Data) throws -> RoutingPolicyDocument {
        try JSONDecoder().decode(RoutingPolicyDocument.self, from: data)
    }

    public var globalSpread: SpreadMode {
        SpreadMode(rawValue: selection.global) ?? .spreadByCapacity
    }

    public func spreadOverride(for category: TaskCategory) -> SpreadMode? {
        selection.categories[category.rawValue].flatMap(SpreadMode.init(rawValue:))
    }

    public func effectiveSpread(_ category: TaskCategory) -> SpreadMode {
        spreadOverride(for: category) ?? globalSpread
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

    /// Only an enabled provider confers authority. Every other provider state
    /// overrides its models; an explicit model row remains a preference only.
    /// Under an enabled provider, an explicit model row answers next, and the
    /// provider covers rows with no explicit state.
    public func modelState(
        provider: ProviderID, model: String
    ) -> (state: PolicyState, source: PolicySource) {
        let providerState = providerState(provider)
        if providerState != .enabled { return (.disabled, .provider) }
        if let row = modelRow(provider: provider, model: model),
           let state = row.state {
            return (state == "enabled" ? .enabled : .disabled, .model)
        }
        return (.enabled, .provider)
    }

    public func modelRow(provider: ProviderID, model: String) -> ModelRow? {
        models.first { $0.provider == provider.rawValue && $0.model == model }
    }

    /// The user's standing effort choice for a model, if they made one. An
    /// unanswered (never-configured) or unnameable effort is NOT a choice.
    public func modelEffort(provider: ProviderID, model: String) -> EffortTarget? {
        modelRow(provider: provider, model: model)?.effort?.asEffortTarget
    }

    /// Whether this build can actually WRITE the daemon's selection setting.
    ///
    /// The daemon's selection vocabulary changed with capability-first routing
    /// (never-configured / auto / choice); `SpreadMode` here still speaks the
    /// older spread/strict. Reading a mode we cannot name would render as a
    /// setting the user never chose, and writing ours back would be refused by
    /// the daemon on every click — so the UI disables the control and says why.
    public var selectionWritable: Bool {
        guard selectionOnWire, SpreadMode(rawValue: selection.global) != nil else {
            return false
        }
        return selection.categories.values.allSatisfy { SpreadMode(rawValue: $0) != nil }
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

    /// FORWARD COMPATIBLE, NARROWLY. `mode` is genuinely required, and an
    /// "exact" effort without its level is a broken row — those still throw.
    /// An unrecognised mode does NOT: it decodes as `.unknown`, because one
    /// enum value the daemon learned before this app did must never blank the
    /// Settings screen and turn persistence off.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .mode) {
        case "never-configured":
            self = .neverConfigured
        case "hive-decides":
            self = .hiveDecides
        case "exact":
            self = .exact(try container.decode(String.self, forKey: .value))
        case "none":
            self = .none
        case "provider-controlled":
            self = .providerControlled
        case let other:
            self = .unknown(other)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .neverConfigured:
            try container.encode("never-configured", forKey: .mode)
        case .hiveDecides:
            try container.encode("hive-decides", forKey: .mode)
        case .exact(let value):
            try container.encode("exact", forKey: .mode)
            try container.encode(value, forKey: .value)
        case .none:
            try container.encode("none", forKey: .mode)
        case .providerControlled:
            try container.encode("provider-controlled", forKey: .mode)
        case .unknown(let mode):
            try container.encode(mode, forKey: .mode)
        }
    }
}
