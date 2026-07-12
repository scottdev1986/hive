import Foundation

/// User policy for the Model Control Center: what is enabled, at what effort,
/// and which ordered chain serves each task category.
///
/// The durable store for this policy is the daemon's SQLite (`hive.db`,
/// governing doc §2.3) — a LATER PR. Until it exists, `ProvisionalPolicyStore`
/// below seeds an in-memory policy from the live catalog. Policy here is
/// *preference* data, so defaulting it is honest; capacity numbers are never
/// defaulted anywhere.

// MARK: - Task categories

/// The settled category vocabulary (governing doc §2.4). `long_context` is
/// deliberately NOT here — it is a requirement modifier, not a category.
public enum TaskCategory: String, CaseIterable, Codable, Sendable {
    case lightResearch = "light_research"
    case heavyResearch = "heavy_research"
    case simpleCoding = "simple_coding"
    case complexCoding = "complex_coding"
    case codeReview = "code_review"
    case planning = "planning"
    case debugging = "debugging"
    case summarization = "summarization"

    public var label: String {
        switch self {
        case .lightResearch: return "Light research"
        case .heavyResearch: return "Heavy research / synthesis"
        case .simpleCoding: return "Simple coding"
        case .complexCoding: return "Complex coding"
        case .codeReview: return "Code review"
        case .planning: return "Planning"
        case .debugging: return "Debugging"
        case .summarization: return "Summarization"
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

// MARK: - Chain entries

/// One link in an ordered fallback chain. `exact` is what almost every edit
/// produces. `vendorDefault` is the labeled, opt-in "track this vendor's
/// current default" mode — volatile, re-resolved at spawn, never cached as an
/// identity. There is no bare "default" string that could pass for a model id
/// (governing doc §2.6).
public struct ChainEntry: Equatable, Codable, Sendable {
    public enum Target: Equatable, Codable, Sendable {
        case exact(provider: String, model: String, variant: String?)
        case vendorDefault(provider: String)
    }

    public var target: Target
    /// Effort is per chain LINK, not only per model: the same model may run
    /// `high` in complex coding and `medium` in summarization (§8.2).
    public var effort: EffortTarget

    public init(target: Target, effort: EffortTarget) {
        self.target = target
        self.effort = effort
    }

    public var provider: String {
        switch target {
        case .exact(let provider, _, _), .vendorDefault(let provider): return provider
        }
    }
}

/// What a category does when its deliberate chain exists but every link gated
/// out. Default is REFUSE; widening to the global chain is per-category opt-in.
/// An *empty* chain is a different thing — it quietly uses the Default chain.
public enum ExhaustionBehavior: String, Codable, Sendable {
    case refuse
    case useGlobalFallback = "use_global_fallback"
}

public struct CategoryPolicy: Equatable, Codable, Sendable {
    public var chain: [ChainEntry]
    public var exhaustionBehavior: ExhaustionBehavior

    public init(chain: [ChainEntry] = [], exhaustionBehavior: ExhaustionBehavior = .refuse) {
        self.chain = chain
        self.exhaustionBehavior = exhaustionBehavior
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
    /// every model row beneath it is overridden (§7.4).
    public var enabled: Bool
    /// Keyed by display id (canonical id + variant). A model with no entry
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
    public var categories: [String: CategoryPolicy]
    /// The global fallback chain. Never deletable; the one chain that must
    /// not be empty.
    public var defaultChain: [ChainEntry]
    /// True until the user edits — drives the provisional banner (§8.5).
    public var provisional: Bool

    public init(
        providers: [String: ProviderPolicy] = [:],
        categories: [String: CategoryPolicy] = [:],
        defaultChain: [ChainEntry] = [],
        provisional: Bool = true
    ) {
        self.providers = providers
        self.categories = categories
        self.defaultChain = defaultChain
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

    public func categoryPolicy(_ category: TaskCategory) -> CategoryPolicy {
        categories[category.rawValue] ?? CategoryPolicy()
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

    public mutating func setCategoryChain(_ category: TaskCategory, chain: [ChainEntry]) {
        var policy = categories[category.rawValue] ?? CategoryPolicy()
        policy.chain = chain
        categories[category.rawValue] = policy
        provisional = false
    }

    public mutating func setExhaustionBehavior(_ category: TaskCategory, _ behavior: ExhaustionBehavior) {
        var policy = categories[category.rawValue] ?? CategoryPolicy()
        policy.exhaustionBehavior = behavior
        categories[category.rawValue] = policy
        provisional = false
    }

    /// Move a chain link. Primary is index 0; order is the policy.
    public static func move(_ chain: [ChainEntry], from source: Int, to destination: Int) -> [ChainEntry] {
        guard chain.indices.contains(source), destination >= 0, destination < chain.count,
              source != destination else { return chain }
        var next = chain
        let entry = next.remove(at: source)
        next.insert(entry, at: destination)
        return next
    }
}

// MARK: - Chain effectiveness

/// Whether a chain link can actually run right now, and if not, why — so a
/// struck row can say what is true instead of just looking sad.
public enum ChainLinkStatus: Equatable, Sendable {
    case effective
    case providerOff
    case modelDisabled
    /// The model left the live catalog. Stays in policy, marked, never
    /// silently dropped and never launched.
    case unresolvable

    public static func derive(
        entry: ChainEntry,
        policy: ModelControlPolicy,
        snapshot: ModelControlSnapshot
    ) -> ChainLinkStatus {
        let provider = ProviderID(entry.provider)
        if !policy.providerEnabled(provider) { return .providerOff }
        switch entry.target {
        case .vendorDefault:
            // Tracks the vendor's moving default; resolvable while the
            // provider's catalog is readable.
            if case .available = snapshot.providers[entry.provider] { return .effective }
            return .unresolvable
        case .exact(_, let model, let variant):
            guard case .available(let models, _) = snapshot.providers[entry.provider] else {
                return .unresolvable
            }
            guard let record = models.first(where: {
                $0.canonicalId == model && $0.variant == variant
            }) else {
                return .unresolvable
            }
            let displayId = record.displayId
            if !policy.modelPolicy(provider: provider, modelId: displayId).isEnabled {
                return .modelDisabled
            }
            return .effective
        }
    }
}

// MARK: - Global warnings

public enum PolicyWarning: Equatable, Sendable {
    /// "No providers enabled — Hive cannot spawn agents…"
    case noProvidersEnabled
    /// "Your Default chain is empty. Categories with no chain of their own
    /// have nowhere to go."
    case defaultChainEmpty

    public static func derive(
        policy: ModelControlPolicy, snapshot: ModelControlSnapshot
    ) -> [PolicyWarning] {
        var warnings: [PolicyWarning] = []
        let ids = snapshot.providerIDs
        if !ids.isEmpty, ids.allSatisfy({ !policy.providerEnabled($0) }) {
            warnings.append(.noProvidersEnabled)
        }
        if policy.defaultChain.isEmpty {
            warnings.append(.defaultChainEmpty)
        }
        return warnings
    }
}

// MARK: - Provisional store (PLACEHOLDER)

/// PLACEHOLDER POLICY SOURCE — NOT the durable store.
///
/// The daemon-side SQLite policy store (governing doc §2.3, PR4) does not
/// exist yet; when it lands, enablement and its seeded-off reason come from
/// the daemon's contract and this seam is replaced with a read. Until then
/// this seeds an in-memory policy from the LIVE discovery catalog and the
/// same billing facts the daemon will use:
///
/// - Providers whose billing is VERIFIED COVERED (credits known off — a plan
///   wall, not a bill) seed their models enabled.
/// - Providers whose billing Hive could not read at all seed their models
///   `seededOff`: fully visible, deliberately off, awaiting the user's
///   consent. "Ready to use" must never mean "already spending money on
///   something the user never touched".
/// - Categories start empty (they use the Default chain); the Default chain
///   gets a labeled vendor-default link per provider that is both available
///   and not seeded off.
///
/// It never invents a measurement, and nothing persists across launches.
public enum ProvisionalPolicyStore {
    public static func seed(from snapshot: ModelControlSnapshot) -> ModelControlPolicy {
        var providers: [String: ProviderPolicy] = [:]
        var defaultChain: [ChainEntry] = []
        for id in snapshot.providerIDs {
            let billing = snapshot.billing[id.rawValue] ?? nil
            // Billing unreadable end-to-end → every model ships off until the
            // user consents. A readable surface with an unknown overflow
            // switch stays enabled but carries the may-spend caveat instead.
            let enablement: ModelEnablement = billing == nil ? .seededOff : .enabled
            providers[id.rawValue] = ProviderPolicy(
                enabled: true, absentModelEnablement: enablement)
            if case .available = snapshot.providers[id.rawValue], enablement == .enabled {
                defaultChain.append(ChainEntry(
                    target: .vendorDefault(provider: id.rawValue),
                    effort: .providerControlled))
            }
        }
        return ModelControlPolicy(
            providers: providers,
            categories: [:],
            defaultChain: defaultChain,
            provisional: true)
    }
}
