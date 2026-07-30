import Foundation

/// The daemon's routing policy document — the durable store behind the Model
/// Control Center, mirrored from `src/schemas/routing-policy.ts` exactly:
/// a route is an UNORDERED set of exact (provider, model, effort) candidates
/// with integer relative weights; a bare "default" model id is illegal; and
/// the document lists only EXPLICIT settings.
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

    public struct WireRouteCandidate: Codable, Equatable, Sendable {
        public var provider: String
        public var model: String
        public var effort: WireEffort
        public var weight: Int

        public init(provider: String, model: String, effort: WireEffort, weight: Int) {
            self.provider = provider
            self.model = model
            self.effort = effort
            self.weight = weight
        }

        /// The CLI candidate spelling (`parseRouteCandidateArg`):
        /// `provider/model[@LEVEL|@none|@hive-decides]=WEIGHT`.
        ///
        /// NIL when the candidate has no spelling at all — never-configured is
        /// a model-row state, not a launchable intent, and an effort mode this
        /// build has never heard of must not be respelled. The caller must
        /// REFUSE the write rather than pick the nearest spelling: silently
        /// rewriting one candidate's effort is a routing change the user
        /// never made.
        public var cliArgument: String? {
            let target: String?
            switch effort {
            case .providerControlled: target = "\(provider)/\(model)"
            case .none: target = "\(provider)/\(model)@none"
            case .hiveDecides: target = "\(provider)/\(model)@hive-decides"
            case .exact(let value): target = "\(provider)/\(model)@\(value)"
            case .neverConfigured, .unknown: target = nil
            }
            return target.map { "\($0)=\(weight)" }
        }
    }

    /// A route as the wire spells it. `mode` stays verbatim so a router mode
    /// a newer daemon added costs this route its editor, never the whole
    /// document.
    public struct WireRoute: Codable, Equatable, Sendable {
        public var mode: String
        public var candidates: [WireRouteCandidate]

        public init(mode: String, candidates: [WireRouteCandidate]) {
            self.mode = mode
            self.candidates = candidates
        }

        public init(_ route: RoutePolicy) {
            mode = route.mode.rawValue
            candidates = route.candidates.map { candidate in
                WireRouteCandidate(
                    provider: candidate.provider,
                    model: candidate.model,
                    // nil effort is Hive's pick, not an unanswered question —
                    // a candidate always answers effort on the wire.
                    effort: candidate.effort.map { WireEffort($0) } ?? .hiveDecides,
                    weight: candidate.weight)
            }
        }

        public var routerMode: RouterMode? { RouterMode(rawValue: mode) }

        /// The route in editor terms, or nil when this build cannot name the
        /// mode. Candidate efforts degrade narrowly (unknown → unchosen), and
        /// the write path separately refuses to respell them.
        public var asRoutePolicy: RoutePolicy? {
            guard let routerMode else { return nil }
            return RoutePolicy(
                mode: routerMode,
                candidates: candidates.map {
                    RouteCandidate(
                        provider: $0.provider, model: $0.model,
                        effort: $0.effort.asEffortTarget, weight: $0.weight)
                })
        }

        /// Whether every candidate here has a CLI spelling, i.e. whether this
        /// build may rewrite the route without changing something it cannot
        /// read.
        public var writable: Bool {
            routerMode != nil && candidates.allSatisfy { $0.cliArgument != nil }
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
    /// The route for categories without their own. nil (null on the wire)
    /// means unconfigured: automatic routing refuses rather than inventing a
    /// candidate set.
    public var global: WireRoute?
    public var categories: [String: WireRoute]

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

    /// A category's own route. Absent means the category resolves to
    /// `global`; it never means an empty route.
    public func route(for category: TaskCategory) -> WireRoute? {
        categories[category.rawValue]
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
