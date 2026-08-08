import Foundation

/// The daemon's routing policy document — the durable store behind the Model Control Center, mirrored from `src/schemas/routing-policy.ts` for transient editing and mutation encoding. Effective enablement, catalog eligibility, warnings, and route status travel separately in `WorkspaceModelControlView`; Swift never derives those decisions from this raw document.
public struct RoutingPolicyDocument: Codable, Equatable, Sendable {

    /// Effort as the wire spells it, mirroring `EffortTargetSchema`: `{mode: "never-configured"}` / `{mode: "hive-decides"}` / `{mode: "exact", value}` / `{mode: "none"}` / `{mode: "provider-controlled"}`.
    public enum WireEffort: Equatable, Sendable {
        case neverConfigured
        case hiveDecides
        case exact(String)
        case none
        case providerControlled
        /// A mode a NEWER daemon added. Kept verbatim: an effort this build cannot name must cost that one row its effort reading — never the whole document, and never a value the user did not choose.
        case unknown(String)

        public var asEffortTarget: EffortTarget? {
            switch self {
            case .exact(let value): return .exact(value)
            case .none: return EffortTarget.none
            case .providerControlled: return .providerControlled
            case .neverConfigured, .hiveDecides, .unknown: return nil
            }
        }

        /// No choice (nil) is `never-configured` on the wire — the daemon's own spelling for unanswered.
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

        /// The CLI argument spelling (`parseEffortTargetArg`). An unknown mode is passed through as-is: the daemon refuses what it does not know, which is the loud failure we want — far better than guessing.
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

    /// The smaller effort union allowed on a launchable route candidate. Unlike a model row, a candidate cannot leave effort unanswered.
    public enum CandidateEffort: Equatable, Sendable {
        case hiveDecides
        case exact(String)
        case none
        case providerControlled
        /// A newer daemon's candidate mode stays visible but cannot be respelled by this client.
        case unknown(String)

        public var asEffortTarget: EffortTarget? {
            switch self {
            case .hiveDecides: return nil
            case .exact(let value): return .exact(value)
            case .none: return EffortTarget.none
            case .providerControlled: return .providerControlled
            case .unknown: return nil
            }
        }

        public var asWireEffort: WireEffort {
            switch self {
            case .hiveDecides: return .hiveDecides
            case .exact(let value): return .exact(value)
            case .none: return .none
            case .providerControlled: return .providerControlled
            case .unknown(let mode): return .unknown(mode)
            }
        }

        public var writable: Bool {
            if case .unknown = self { return false }
            return true
        }

        public init(_ target: EffortTarget?) {
            guard let target else {
                self = .hiveDecides
                return
            }
            switch target {
            case .exact(let value): self = .exact(value)
            case .none: self = .none
            case .providerControlled: self = .providerControlled
            }
        }
    }

    public struct WireRouteCandidate: Codable, Equatable, Sendable {
        public var provider: String
        public var model: String
        public var effort: CandidateEffort
        public var weight: Int

        public init(provider: String, model: String, effort: CandidateEffort, weight: Int) {
            self.provider = provider
            self.model = model
            self.effort = effort
            self.weight = weight
        }

        public var cliArgument: String? {
            let target: String
            switch effort {
            case .providerControlled: target = "\(provider)/\(model)"
            case .none: target = "\(provider)/\(model)@none"
            case .hiveDecides: target = "\(provider)/\(model)@hive-decides"
            case .exact(let value): target = "\(provider)/\(model)@\(value)"
            case .unknown: return nil
            }
            return "\(target)=\(weight)"
        }
    }

    /// A route as the wire spells it. `mode` stays verbatim so a router mode a newer daemon added costs this route its editor, never the whole document.
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
                    effort: CandidateEffort(candidate.effort),
                    weight: candidate.weight)
            }
        }

        public var routerMode: RouterMode? { RouterMode(rawValue: mode) }

        /// The route in editor terms, or nil when this build cannot name the mode. Candidate efforts degrade narrowly (unknown → unchosen), and the write path separately refuses to respell them.
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

        public var writable: Bool {
            routerMode != nil && candidates.allSatisfy(\.effort.writable)
        }
    }

    public struct ModelRow: Codable, Equatable, Sendable {
        public var provider: String
        public var model: String
        public var state: String?
        public var effort: WireEffort

        public init(
            provider: String,
            model: String,
            state: String? = nil,
            effort: WireEffort = .neverConfigured
        ) {
            self.provider = provider
            self.model = model
            self.state = state
            self.effort = effort
        }
    }

    public var schemaVersion: Int
    /// Monotonic; every accepted mutation increments it. Writers present the revision they read — compare-and-set, so concurrent edits conflict loudly instead of clobbering.
    public var revision: Int
    public var updatedAt: String
    public var provisional: Bool
    public var providers: [String: String]
    public var models: [ModelRow]
    /// The route for categories without their own. nil (null on the wire) means unconfigured: automatic routing refuses rather than inventing a candidate set.
    public var global: WireRoute?
    public var categories: [String: WireRoute]

    public static func decode(from data: Data) throws -> RoutingPolicyDocument {
        try JSONDecoder().decode(RoutingPolicyDocument.self, from: data)
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case revision
        case updatedAt
        case provisional
        case providers
        case models
        case global
        case categories
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        guard schemaVersion == 3 else {
            throw DecodingError.dataCorruptedError(
                forKey: .schemaVersion,
                in: container,
                debugDescription: "routing policy schema version \(schemaVersion) is unsupported")
        }
        revision = try container.decode(Int.self, forKey: .revision)
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
        provisional = try container.decode(Bool.self, forKey: .provisional)
        providers = try container.decode(
            [String: String].self,
            forKey: .providers)
        models = try container.decode([ModelRow].self, forKey: .models)
        global = try container.decodeRequiredNullable(
            WireRoute.self,
            forKey: .global)
        categories = try container.decode(
            [String: WireRoute].self,
            forKey: .categories)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(revision, forKey: .revision)
        try container.encode(updatedAt, forKey: .updatedAt)
        try container.encode(provisional, forKey: .provisional)
        try container.encode(providers, forKey: .providers)
        try container.encode(models, forKey: .models)
        try container.encode(global, forKey: .global)
        try container.encode(categories, forKey: .categories)
    }

    public func modelRow(provider: ProviderID, model: String) -> ModelRow? {
        models.first { $0.provider == provider.rawValue && $0.model == model }
    }

    /// The user's standing effort choice for a model, if they made one. An unanswered (never-configured) or unnameable effort is NOT a choice.
    public func modelEffort(provider: ProviderID, model: String) -> EffortTarget? {
        modelRow(provider: provider, model: model)?.effort.asEffortTarget
    }

    /// A category's own route. Absent means the category resolves to `global`; it never means an empty route.
    public func route(for category: TaskCategory) -> WireRoute? {
        categories[category.rawValue]
    }

}

extension RoutingPolicyDocument.CandidateEffort: Codable {
    private enum CodingKeys: String, CodingKey {
        case mode
        case value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let mode = try container.decode(String.self, forKey: .mode)
        switch mode {
        case "hive-decides":
            guard !container.contains(.value) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .value,
                    in: container,
                    debugDescription: "hive-decides effort cannot carry a value")
            }
            self = .hiveDecides
        case "exact":
            self = .exact(try container.decode(String.self, forKey: .value))
        case "none":
            guard !container.contains(.value) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .value,
                    in: container,
                    debugDescription: "none effort cannot carry a value")
            }
            self = .none
        case "provider-controlled":
            guard !container.contains(.value) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .value,
                    in: container,
                    debugDescription: "provider-controlled effort cannot carry a value")
            }
            self = .providerControlled
        default:
            self = .unknown(mode)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
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

extension RoutingPolicyDocument.WireEffort: Codable {
    private enum CodingKeys: String, CodingKey { case mode, value }

    /// FORWARD COMPATIBLE, NARROWLY. `mode` is genuinely required, and an "exact" effort without its level is a broken row — those still throw. An unrecognised mode does NOT: it decodes as `.unknown`, because one enum value the daemon learned before this app did must never blank the Settings screen and turn persistence off.
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
