import Foundation

/// User policy for the Model Control Center: what is enabled, at what effort,
/// and which weighted route serves each task category.
///
/// The daemon owns the durable routing document. `ProvisionalPolicyStore`
/// remains the compatibility fallback for a daemon that cannot export that
/// document: it seeds preference data from the live catalog in memory, but
/// never invents capacity readings.

// MARK: - Task categories

/// The settled category vocabulary. `long_context` is deliberately NOT here —
/// it is a requirement modifier, not a category.
public enum TaskCategory: String, CaseIterable, Codable, Sendable {
    case lightResearch = "light_research"
    case heavyResearch = "heavy_research"
    case simpleCoding = "simple_coding"
    case standardCoding = "standard_coding"
    case complexCoding = "complex_coding"
    case codeReview = "code_review"
    case planning = "planning"
    case debugging = "debugging"
    case summarization = "summarization"
    case unclassified = "default"

    public var label: String {
        switch self {
        case .lightResearch: return "Light research"
        case .heavyResearch: return "Heavy research / synthesis"
        case .simpleCoding: return "Simple coding"
        case .standardCoding: return "Standard coding"
        case .complexCoding: return "Complex coding"
        case .codeReview: return "Code review"
        case .planning: return "Planning"
        case .debugging: return "Debugging"
        case .summarization: return "Summarization"
        case .unclassified: return "Everything else"
        }
    }
}

// MARK: - Effort target

/// What the user asked Hive to send for effort. `providerControlled` means
/// "omit the flag" — it does NOT claim to know the vendor's default.
public enum EffortTarget: Equatable, Codable, Sendable {
    case exact(String)
    /// The model stated it has no effort axis; there is nothing to set.
    case none
    case providerControlled
}

// MARK: - Routes

/// How a route picks one candidate per spawn. `userWeighted` selects by the
/// stored integer weights; `hiveEqual` gives every candidate an effective
/// weight of 1 while the stored weights stay intact, so switching modes loses
/// no preference information.
public enum RouterMode: String, CaseIterable, Codable, Sendable {
    case userWeighted = "user-weighted"
    case hiveEqual = "hive-equal"
}

/// One member of an UNORDERED candidate set. THE ATOM IS A (MODEL, EFFORT)
/// PAIR: fable-5@high and fable-5@low are two different routing choices, and
/// the same model may sit at different efforts in different categories.
///
/// Every candidate names an EXACT model. There is no vendor-default candidate
/// type and no bare "default" token: a default that quietly wins is exactly
/// what this feature removes. The user is the router; the route shows
/// precisely which models can run, at which effort, in what proportion.
public struct RouteCandidate: Equatable, Codable, Sendable {
    public var provider: String
    /// The canonical model id — the daemon store's grain (no variant; a
    /// context-window entitlement is not a different routing target).
    public var model: String
    /// Effort is per candidate, not per model. NIL = Hive picks from the
    /// model's advertised levels (`hive-decides` on the wire) — it renders as
    /// unchosen because it is not a standing user choice.
    public var effort: EffortTarget?
    /// A rating, not a percentage: 60/20/20 and 3/1/1 express the same
    /// distribution. Integer 1–100; zero is illegal — disablement stays the
    /// explicit provider/model enablement control, never a weight.
    public var weight: Int

    public init(provider: String, model: String, effort: EffortTarget?, weight: Int = 1) {
        self.provider = provider
        self.model = model
        self.effort = effort
        self.weight = weight
    }

    /// The identity the no-duplicates rule compares.
    public var targetKey: String {
        [provider, model].joined(separator: "\u{0}")
    }
}

/// An unordered weighted candidate set. Order carries no meaning; there is no
/// fallback ladder anywhere.
public struct RoutePolicy: Equatable, Codable, Sendable {
    public var mode: RouterMode
    public var candidates: [RouteCandidate]

    public init(mode: RouterMode, candidates: [RouteCandidate]) {
        self.mode = mode
        self.candidates = candidates
    }

    /// The fraction of routed spawns this candidate is expected to receive:
    /// weight/sum(weights) under `userWeighted`, 1/n under `hiveEqual`.
    public func expectedShare(of candidate: RouteCandidate) -> Double {
        guard !candidates.isEmpty else { return 0 }
        switch mode {
        case .hiveEqual:
            return 1 / Double(candidates.count)
        case .userWeighted:
            let total = candidates.reduce(0) { $0 + $1.weight }
            guard total > 0 else { return 0 }
            return Double(candidate.weight) / Double(total)
        }
    }

    /// Expected share summed per provider, for the aggregate preview.
    public var providerShares: [String: Double] {
        var shares: [String: Double] = [:]
        for candidate in candidates {
            shares[candidate.provider, default: 0] += expectedShare(of: candidate)
        }
        return shares
    }
}

// MARK: - Policy

/// Why a model is on or off. CONSENT IS ENABLEMENT: flipping a model on in
/// the UI is the user's authorisation to spend money on it — there is no
/// later approval prompt. The three off-states are three different facts and
/// are never collapsed:
/// - `seededOff` — Hive shipped it off because billing coverage could not be
///   verified; it awaits the user's consent. Inviting, actionable.
/// - `disabledByUser` — the user turned it off. Neutral.
/// - (provider-off is not stored here — it is an override computed in
///   `ModelRowState`, so the model's own setting is shown, not rewritten.)
public enum ModelEnablement: String, Equatable, Codable, Sendable {
    case enabled
    case seededOff = "seeded_off"
    case disabledByUser = "disabled_by_user"
}

public struct ModelPolicy: Equatable, Codable, Sendable {
    public var enablement: ModelEnablement
    public var effort: EffortTarget

    public init(
        enablement: ModelEnablement = .enabled,
        effort: EffortTarget = .providerControlled
    ) {
        self.enablement = enablement
        self.effort = effort
    }

    public var isEnabled: Bool { enablement == .enabled }
}

public struct ProviderPolicy: Equatable, Codable, Sendable {
    /// The master toggle. Off = Hive will not invoke this CLI at all, and
    /// every model row beneath it is overridden.
    public var enabled: Bool
    /// Keyed by canonical model id (the policy store's grain). A model with no entry
    /// inherits `absentModelEnablement` — newly discovered models are
    /// reachable, and under an unverified-billing vendor they arrive
    /// seeded-off rather than silently consented.
    public var models: [String: ModelPolicy]
    /// What a model with no explicit policy entry gets. `.enabled` for a
    /// vendor whose billing is verified covered; `.seededOff` otherwise.
    public var absentModelEnablement: ModelEnablement

    public init(
        enabled: Bool = true,
        models: [String: ModelPolicy] = [:],
        absentModelEnablement: ModelEnablement = .enabled
    ) {
        self.enabled = enabled
        self.models = models
        self.absentModelEnablement = absentModelEnablement
    }
}

public struct ModelControlPolicy: Equatable, Codable, Sendable {
    public var providers: [String: ProviderPolicy]
    /// A category's own route, keyed by the wire category name. A category
    /// with no route of its own resolves to `global`; a category route that
    /// refuses every candidate does NOT fall through to global.
    public var categories: [String: RoutePolicy]
    /// The route for categories without their own. nil = unconfigured, and
    /// automatic routing refuses rather than inventing a candidate set.
    public var global: RoutePolicy?
    /// True until the user edits — drives the provisional banner.
    public var provisional: Bool

    public init(
        providers: [String: ProviderPolicy] = [:],
        categories: [String: RoutePolicy] = [:],
        global: RoutePolicy? = nil,
        provisional: Bool = true
    ) {
        self.providers = providers
        self.categories = categories
        self.global = global
        self.provisional = provisional
    }

    // MARK: Reads

    public func providerEnabled(_ provider: ProviderID) -> Bool {
        providers[provider.rawValue]?.enabled ?? true
    }

    public func modelPolicy(provider: ProviderID, modelId: String) -> ModelPolicy {
        let providerPolicy = providers[provider.rawValue]
        return providerPolicy?.models[modelId] ?? ModelPolicy(
            enablement: providerPolicy?.absentModelEnablement ?? .enabled)
    }

    /// The non-negotiable override rule:
    /// effectiveEnabled = providerEnabled && modelSelfEnabled && available.
    public func rowState(
        provider: ProviderID, modelId: String, available: Bool
    ) -> ModelRowState {
        ModelRowState.derive(
            providerEnabled: providerEnabled(provider),
            enablement: modelPolicy(provider: provider, modelId: modelId).enablement,
            modelAvailable: available)
    }

    public func route(_ category: TaskCategory) -> RoutePolicy? {
        categories[category.rawValue]
    }

    // MARK: Mutations (all mark the policy user-edited)

    public mutating func setProviderEnabled(_ provider: ProviderID, _ enabled: Bool) {
        var policy = providers[provider.rawValue] ?? ProviderPolicy()
        policy.enabled = enabled
        providers[provider.rawValue] = policy
        provisional = false
    }

    /// A user flip is consent (on) or a deliberate user off — never a return
    /// to `seededOff`, which only the seeding process writes.
    public mutating func setModelEnabled(provider: ProviderID, modelId: String, _ enabled: Bool) {
        var providerPolicy = providers[provider.rawValue] ?? ProviderPolicy()
        var policy = providerPolicy.models[modelId] ?? ModelPolicy(
            enablement: providerPolicy.absentModelEnablement)
        policy.enablement = enabled ? .enabled : .disabledByUser
        providerPolicy.models[modelId] = policy
        providers[provider.rawValue] = providerPolicy
        provisional = false
    }

    public mutating func setModelEffort(provider: ProviderID, modelId: String, _ effort: EffortTarget) {
        var providerPolicy = providers[provider.rawValue] ?? ProviderPolicy()
        var policy = providerPolicy.models[modelId] ?? ModelPolicy(
            enablement: providerPolicy.absentModelEnablement)
        policy.effort = effort
        providerPolicy.models[modelId] = policy
        providers[provider.rawValue] = providerPolicy
        provisional = false
    }

    /// nil category = the global route. nil route clears the scope back to
    /// unconfigured.
    public mutating func setRoute(_ category: TaskCategory?, _ route: RoutePolicy?) {
        if let category {
            categories[category.rawValue] = route
        } else {
            global = route
        }
        provisional = false
    }
}

// MARK: - Candidate effectiveness

/// Whether a route candidate can actually run right now, and if not, why — so
/// a struck row can say what is true instead of just looking sad.
public enum RouteCandidateStatus: Equatable, Sendable {
    case effective
    case providerOff
    case modelDisabled
    /// Shipped off awaiting the user's consent (unconfigured / seeded-off).
    /// Distinct from a deliberate user off — the row invites, not scolds.
    case awaitingConsent
    /// The model left the live catalog. Stays in policy, marked, never
    /// silently dropped and never launched.
    case unresolvable

    /// The one derivation both policy backends share: a candidate's status is
    /// its model's row state plus whether the live catalog still resolves it.
    public static func derive(
        rowState: ModelRowState, resolvedInCatalog: Bool
    ) -> RouteCandidateStatus {
        guard resolvedInCatalog else { return .unresolvable }
        switch rowState {
        case .enabled: return .effective
        case .disabledByProvider: return .providerOff
        case .disabledBySelf: return .modelDisabled
        case .seededOff: return .awaitingConsent
        case .unavailable: return .unresolvable
        }
    }

    public static func derive(
        candidate: RouteCandidate,
        policy: ModelControlPolicy,
        snapshot: ModelControlSnapshot
    ) -> RouteCandidateStatus {
        let provider = ProviderID(candidate.provider)
        if !policy.providerEnabled(provider) { return .providerOff }
        guard case .available(let models, _) = snapshot.providers[candidate.provider] else {
            return .unresolvable
        }
        guard let record = models.first(where: {
            $0.canonicalId == candidate.model
        }) else {
            return .unresolvable
        }
        if !policy.modelPolicy(provider: provider, modelId: record.canonicalId).isEnabled {
            return .modelDisabled
        }
        return .effective
    }
}

// MARK: - Global warnings

public enum PolicyWarning: Equatable, Sendable {
    /// "No providers enabled — Hive cannot spawn agents…"
    case noProvidersEnabled
    /// "You have no Global route. Categories without a route of their own
    /// have nowhere to go."
    case noGlobalRoute

    public static func derive(
        policy: ModelControlPolicy, snapshot: ModelControlSnapshot
    ) -> [PolicyWarning] {
        var warnings: [PolicyWarning] = []
        let ids = snapshot.providerIDs
        if !ids.isEmpty, ids.allSatisfy({ !policy.providerEnabled($0) }) {
            warnings.append(.noProvidersEnabled)
        }
        if policy.global == nil {
            warnings.append(.noGlobalRoute)
        }
        return warnings
    }
}

// MARK: - Provisional store (PLACEHOLDER)

/// PLACEHOLDER POLICY SOURCE — NOT the durable store; used only when the
/// running daemon cannot export the policy document. Seeds an in-memory
/// policy from the LIVE discovery catalog and the same billing facts the
/// daemon uses:
///
/// - Providers whose billing is VERIFIED COVERED (credits known off — a plan
///   wall, not a bill) seed their models enabled.
/// - Providers whose billing Hive could not read at all seed their models
///   `seededOff`: fully visible, deliberately off, awaiting the user's
///   consent. "Ready to use" must never mean "already spending money on
///   something the user never touched".
/// - Categories start with no route (they resolve to global); the global
///   route seeds one equal-weight candidate per consented provider — its
///   effective-default model, effort left to the vendor. Equal weight is the
///   only non-invented rating; no outcome data backs anything else.
///
/// It never invents a measurement, and nothing persists across launches.
public enum ProvisionalPolicyStore {

    public static func seed(from snapshot: ModelControlSnapshot) -> ModelControlPolicy {
        var providers: [String: ProviderPolicy] = [:]
        for id in snapshot.providerIDs {
            let billing = snapshot.billing[id.rawValue] ?? nil
            // Billing unreadable end-to-end → every model ships off until the
            // user consents. A readable surface with an unknown overflow
            // switch stays enabled but carries the may-spend caveat instead.
            let enablement: ModelEnablement = billing == nil ? .seededOff : .enabled
            providers[id.rawValue] = ProviderPolicy(
                enabled: true, absentModelEnablement: enablement)
        }
        return ModelControlPolicy(
            providers: providers,
            global: seedGlobalRoute(from: snapshot, providers: providers),
            provisional: true)
    }

    /// One equal-weight candidate per consented, available provider: its
    /// effective-default model with effort left to the vendor — nothing here
    /// invents a level, and an unconsented vendor's models must never be
    /// pre-wired into spending positions.
    private static func seedGlobalRoute(
        from snapshot: ModelControlSnapshot,
        providers: [String: ProviderPolicy]
    ) -> RoutePolicy? {
        var candidates: [RouteCandidate] = []
        for id in snapshot.providerIDs {
            guard providers[id.rawValue]?.absentModelEnablement == .enabled,
                  case .available(let models, let effectiveDefault)? =
                    snapshot.providers[id.rawValue] else { continue }
            let flagship = effectiveDefault.model.value
                .flatMap { defaultId in models.first { $0.canonicalId == defaultId } }
                ?? models.first { $0.hidden.value != true }
            guard let flagship else { continue }
            candidates.append(RouteCandidate(
                provider: id.rawValue,
                model: flagship.canonicalId,
                effort: .providerControlled,
                weight: 1))
        }
        return candidates.isEmpty
            ? nil
            : RoutePolicy(mode: .hiveEqual, candidates: candidates)
    }
}
