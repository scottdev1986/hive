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

/// How sure Hive is about a provisional chain entry. Nothing claims
/// `measured` until outcome telemetry exists (governing doc §2.8).
public enum ChainConfidence: String, Equatable, Codable, Sendable {
    case documented
    case assumed
}

/// One link in an ordered fallback chain. THE ATOM IS A (MODEL, EFFORT)
/// PAIR: fable-5@high and fable-5@low are two different routing choices, and
/// the same model may sit at different efforts in different categories.
///
/// Every entry names an EXACT model. There is no vendor-default entry type
/// and no bare "default" token: a default that quietly wins is exactly what
/// this feature removes. The user is the router; the chain shows precisely
/// which model runs, at which effort.
public struct ChainEntry: Equatable, Codable, Sendable {
    public var provider: String
    /// The canonical model id — the daemon store's grain (no variant; a
    /// context-window entitlement is not a different routing target).
    public var model: String
    /// Effort is per chain LINK, not per model (§8.2).
    public var effort: EffortTarget
    /// Why this entry sits where it does — shown in the task view so the
    /// user can make informed overrides instead of guessing. Provisional
    /// seeds always say "assumed"; nothing wears authority it lacks.
    public var note: String?
    public var confidence: ChainConfidence?

    public init(
        provider: String, model: String,
        effort: EffortTarget,
        note: String? = nil, confidence: ChainConfidence? = nil
    ) {
        self.provider = provider
        self.model = model
        self.effort = effort
        self.note = note
        self.confidence = confidence
    }

    /// The identity the no-duplicates rule compares.
    public var targetKey: String {
        [provider, model].joined(separator: "\u{0}")
    }
}

/// What a category does when its deliberate chain exists but every link gated
/// out. Default is REFUSE; widening to the global chain is per-category opt-in.
/// An *empty* chain is a different thing — it quietly uses the Default chain.
public enum ExhaustionBehavior: String, Codable, Sendable {
    case refuse
    case useGlobalFallback = "use_global_fallback"
}

/// How work is distributed among a chain's capable models (user decision
/// 2026-07-13): a strict walk burns the top model's pool to zero while the
/// others idle, so the DEFAULT spreads — among the models that pass the
/// gates, the one with the most remaining quota headroom runs the task,
/// weighted by rank so the preferred model still wins when pools are even.
/// Strict order remains available where consistency matters more than load.
public enum SpreadMode: String, Codable, Sendable {
    // Raw values are the daemon's wire spellings (selection.global /
    // selection.categories values; `hive routing set-selection`).
    case spreadByCapacity = "spread"
    case strictOrder = "strict"
}

public struct CategoryPolicy: Equatable, Codable, Sendable {
    public var chain: [ChainEntry]
    public var exhaustionBehavior: ExhaustionBehavior
    /// Per-category override of the global spread mode; nil = use global.
    public var spreadOverride: SpreadMode?

    public init(
        chain: [ChainEntry] = [],
        exhaustionBehavior: ExhaustionBehavior = .refuse,
        spreadOverride: SpreadMode? = nil
    ) {
        self.chain = chain
        self.exhaustionBehavior = exhaustionBehavior
        self.spreadOverride = spreadOverride
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
    public var categories: [String: CategoryPolicy]
    /// The global fallback chain. Never deletable; the one chain that must
    /// not be empty.
    public var defaultChain: [ChainEntry]
    /// True until the user edits — drives the provisional banner (§8.5).
    public var provisional: Bool
    /// How work distributes among a chain's capable models, app-wide;
    /// categories may override. Spread is the default — the point is to
    /// drain pools evenly, not to hammer the preferred model.
    public var globalSpread: SpreadMode

    public init(
        providers: [String: ProviderPolicy] = [:],
        categories: [String: CategoryPolicy] = [:],
        defaultChain: [ChainEntry] = [],
        provisional: Bool = true,
        globalSpread: SpreadMode = .spreadByCapacity
    ) {
        self.providers = providers
        self.categories = categories
        self.defaultChain = defaultChain
        self.provisional = provisional
        self.globalSpread = globalSpread
    }

    public func effectiveSpread(_ category: TaskCategory) -> SpreadMode {
        categoryPolicy(category).spreadOverride ?? globalSpread
    }

    public mutating func setGlobalSpread(_ mode: SpreadMode) {
        globalSpread = mode
        provisional = false
    }

    /// nil clears the override — the category falls back to the global mode.
    public mutating func setCategorySpread(_ category: TaskCategory, _ mode: SpreadMode?) {
        var policy = categories[category.rawValue] ?? CategoryPolicy()
        policy.spreadOverride = mode
        categories[category.rawValue] = policy
        provisional = false
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
    /// Shipped off awaiting the user's consent (unconfigured / seeded-off).
    /// Distinct from a deliberate user off — the row invites, not scolds.
    case awaitingConsent
    /// The model left the live catalog. Stays in policy, marked, never
    /// silently dropped and never launched.
    case unresolvable

    /// The one derivation both policy backends share: a link's status is its
    /// model's row state plus whether the live catalog still resolves it.
    public static func derive(
        rowState: ModelRowState, resolvedInCatalog: Bool
    ) -> ChainLinkStatus {
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
        entry: ChainEntry,
        policy: ModelControlPolicy,
        snapshot: ModelControlSnapshot
    ) -> ChainLinkStatus {
        let provider = ProviderID(entry.provider)
        if !policy.providerEnabled(provider) { return .providerOff }
        guard case .available(let models, _) = snapshot.providers[entry.provider] else {
            return .unresolvable
        }
        guard let record = models.first(where: {
            $0.canonicalId == entry.model
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

    /// The citation every seeded entry carries. Provisional means provisional:
    /// no entry claims outcome evidence that does not exist.
    static let assumedNote = "Assumed order — no Hive outcome data yet."

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
        let policy = ModelControlPolicy(
            providers: providers,
            categories: seedCategories(from: snapshot, providers: providers),
            defaultChain: seedChain(
                from: snapshot, providers: providers,
                effortIntent: "medium",
                why: "Mid effort, diversified across vendors."),
            provisional: true)
        return policy
    }

    /// The provisional routing table (governing doc §2.8): every category gets
    /// an ordered chain of (model @ effort) atoms resolved from the LIVE
    /// catalog — never ids frozen in the binary — with a note saying why.
    /// Only consented (billing-verified) providers are seeded; an unconsented
    /// vendor's models must never be pre-wired into spending positions.
    private static func seedCategories(
        from snapshot: ModelControlSnapshot,
        providers: [String: ProviderPolicy]
    ) -> [String: CategoryPolicy] {
        // (effort intent, why this order) per category — the §2.8 intents.
        let plans: [(TaskCategory, String, String)] = [
            (.complexCoding, "high", "Strongest available at high effort for hard code."),
            (.debugging, "high", "Coding-capable models at high effort; kept separate from complex coding for future evidence."),
            (.codeReview, "high", "Prefers a different vendor than the usual producer, at high effort."),
            (.planning, "high", "Strong reasoning first."),
            (.heavyResearch, "high", "Strong reasoning / synthesis at high effort."),
            (.simpleCoding, "medium", "Vendor defaults at medium effort for routine changes."),
            (.lightResearch, "low", "Cheap and fast first; spreads work off the coding pools."),
            (.summarization, "low", "Cheapest competent choice first."),
        ]
        var categories: [String: CategoryPolicy] = [:]
        for (category, effortIntent, why) in plans {
            var chain = seedChain(
                from: snapshot, providers: providers,
                effortIntent: effortIntent, why: why)
            // Code review prefers vendor independence: rotate so the first
            // link is not the same vendor every other category leads with.
            if category == .codeReview, chain.count > 1 {
                chain.append(chain.removeFirst())
            }
            categories[category.rawValue] = CategoryPolicy(
                chain: chain, exhaustionBehavior: .refuse)
        }
        return categories
    }

    /// One entry per consented, available provider: its effective-default
    /// model at the intended effort — but only an effort the vendor actually
    /// advertises; otherwise the entry stays provider-controlled. Nothing here
    /// invents a level.
    private static func seedChain(
        from snapshot: ModelControlSnapshot,
        providers: [String: ProviderPolicy],
        effortIntent: String,
        why: String
    ) -> [ChainEntry] {
        var chain: [ChainEntry] = []
        for id in snapshot.providerIDs {
            guard providers[id.rawValue]?.absentModelEnablement == .enabled,
                  case .available(let models, let effectiveDefault)? =
                    snapshot.providers[id.rawValue] else { continue }
            let flagship = effectiveDefault.model.value
                .flatMap { defaultId in models.first { $0.canonicalId == defaultId } }
                ?? models.first { $0.hidden.value != true }
            guard let flagship else { continue }
            let effort: EffortTarget
            var effortNote = ""
            switch EffortAxis.derive(from: flagship) {
            case .known(let levels, _) where levels.contains(effortIntent):
                effort = .exact(effortIntent)
            case .none:
                effort = .none
                effortNote = " This model has no effort setting."
            default:
                effort = .providerControlled
                effortNote = " Effort left to the vendor — \(effortIntent) is not advertised."
            }
            chain.append(ChainEntry(
                provider: id.rawValue,
                model: flagship.canonicalId,
                effort: effort,
                note: "\(assumedNote) \(why)\(effortNote)",
                confidence: .assumed))
        }
        return chain
    }
}
