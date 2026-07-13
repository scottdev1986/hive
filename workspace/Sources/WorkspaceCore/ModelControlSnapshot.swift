import Foundation

/// The wire contract for `hive model-control-snapshot` — one JSON document the
/// Workspace reads over the same CLI-subprocess transport as the feed.
///
/// Honesty rules baked into these types (docs/routing/model-control-center.md
/// §2–3):
///
/// - Every discovered fact is three-valued at the source: known(value),
///   or unknown(reason). A consumer must branch to read a value, so an
///   undiscovered fact can never be mistaken for a measured one.
/// - Quota numbers are percent-or-null. `null` decodes as `nil` and means
///   UNKNOWN — never 0 and never 100.
/// - `providers` is a dictionary keyed by provider id, so a vendor Hive learns
///   about after this screen ships decodes and renders with no UI change
///   (the fourth-provider test). The *policy* contract stays a closed enum on
///   the daemon side; the render layer must never make a new vendor invisible.

// MARK: - Provider identity

/// A provider id as the wire reports it. Well-known ids get branded marks and
/// titles; an unknown id still renders (SF Symbol fallback + its own name),
/// because a vendor the render layer forgot must appear, not vanish.
public struct ProviderID: RawRepresentable, Hashable, Codable, Sendable, Comparable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }

    public static let claude = ProviderID("claude")
    public static let codex = ProviderID("codex")
    public static let grok = ProviderID("grok")

    /// Stable display order: the known vendors in their canonical order,
    /// then anything newly discovered, alphabetically.
    public static func < (lhs: ProviderID, rhs: ProviderID) -> Bool {
        let canonical: [ProviderID] = [.claude, .codex, .grok]
        let li = canonical.firstIndex(of: lhs) ?? canonical.count
        let ri = canonical.firstIndex(of: rhs) ?? canonical.count
        if li != ri { return li < ri }
        return lhs.rawValue < rhs.rawValue
    }
}

// MARK: - Discovered facts

/// A fact read from a vendor surface, or the measured reason it could not be.
/// Mirrors `Discovered<T>` in src/schemas/capability.ts.
public enum DiscoveredFact<Value: Codable & Equatable & Sendable>: Equatable, Sendable {
    case known(Value, surface: String, observedAt: String)
    case unknown(reason: String, surface: String, observedAt: String)

    public var value: Value? {
        if case .known(let value, _, _) = self { return value }
        return nil
    }

    public var unknownReason: String? {
        if case .unknown(let reason, _, _) = self { return reason }
        return nil
    }

    public var observedAt: String {
        switch self {
        case .known(_, _, let at), .unknown(_, _, let at): return at
        }
    }
}

extension DiscoveredFact: Codable {
    private enum CodingKeys: String, CodingKey {
        case state, value, reason, surface, observedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let state = (try? container.decode(String.self, forKey: .state)) ?? "missing"
        let surface = (try? container.decodeIfPresent(String.self, forKey: .surface)) ?? ""
        let observedAt =
            (try? container.decodeIfPresent(String.self, forKey: .observedAt)) ?? ""
        switch state {
        case "known":
            if let value = try? container.decode(Value.self, forKey: .value) {
                self = .known(value, surface: surface, observedAt: observedAt)
            } else {
                self = .unknown(
                    reason: "could not read known value",
                    surface: surface, observedAt: observedAt)
            }
        case "unknown":
            let reason = try? container.decodeIfPresent(String.self, forKey: .reason)
            self = .unknown(reason: reason ?? "unspecified", surface: surface, observedAt: observedAt)
        default:
            self = .unknown(
                reason: "unsupported discovered fact state \(state)",
                surface: surface, observedAt: observedAt)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .known(let value, let surface, let observedAt):
            try container.encode("known", forKey: .state)
            try container.encode(value, forKey: .value)
            try container.encode(surface, forKey: .surface)
            try container.encode(observedAt, forKey: .observedAt)
        case .unknown(let reason, let surface, let observedAt):
            try container.encode("unknown", forKey: .state)
            try container.encode(reason, forKey: .reason)
            try container.encode(surface, forKey: .surface)
            try container.encode(observedAt, forKey: .observedAt)
        }
    }
}

// MARK: - Capability catalog

/// One model as the vendor's own catalog describes it.
/// Mirrors the fields of `CapabilityRecord` this screen consumes.
public struct DiscoveredModel: Codable, Equatable, Sendable {
    public var provider: String
    public var canonicalId: String
    public var variant: String?
    public var launchToken: String
    public var displayName: String?
    public var hidden: DiscoveredFact<Bool>
    /// The vendor's `supportsEffort` boolean and its level list stay two
    /// separate facts. Merging them is how "vendor said no effort axis" and
    /// "we could not read the effort axis" collapse into one lie (§2.4).
    public var supportsEffort: DiscoveredFact<Bool>
    public var supportedEffortLevels: DiscoveredFact<[String]>
    public var defaultEffort: DiscoveredFact<String>
    public var observedAt: String

    private enum CodingKeys: String, CodingKey {
        case provider, canonicalId, variant, launchToken, displayName
        case hidden, supportsEffort, supportedEffortLevels, defaultEffort, observedAt
    }

    public init(
        provider: String, canonicalId: String, variant: String? = nil,
        launchToken: String, displayName: String? = nil,
        hidden: DiscoveredFact<Bool>,
        supportsEffort: DiscoveredFact<Bool>,
        supportedEffortLevels: DiscoveredFact<[String]>,
        defaultEffort: DiscoveredFact<String>,
        observedAt: String
    ) {
        self.provider = provider
        self.canonicalId = canonicalId
        self.variant = variant
        self.launchToken = launchToken
        self.displayName = displayName
        self.hidden = hidden
        self.supportsEffort = supportsEffort
        self.supportedEffortLevels = supportedEffortLevels
        self.defaultEffort = defaultEffort
        self.observedAt = observedAt
    }

    /// Canonical id plus the context-window variant, for display.
    public var displayId: String {
        variant.map { "\(canonicalId)[\($0)]" } ?? canonicalId
    }

    /// The name a human reads: the vendor's own display name where it names a
    /// MODEL, else a mechanical prettification of the vendor's canonical id
    /// ("claude-opus-4-8" → "Opus 4.8"). Never a name from anyone's memory.
    ///
    /// A vendor menu label like "Default (recommended)" is an alias's label,
    /// not a model identity — the UI displays models, never "default", so
    /// such labels fall through to the id (the user's rule: "we are specific
    /// on the models that we choose").
    public var humanName: String {
        if let displayName {
            let lowered = displayName.lowercased()
            if !lowered.contains("default") && !lowered.contains("recommended") {
                return displayName
            }
        }
        var id = canonicalId
        if id.lowercased().hasPrefix("\(provider.lowercased())-") {
            id = String(id.dropFirst(provider.count + 1))
        }
        var words: [String] = []
        for token in id.split(separator: "-") {
            let isNumeric = token.allSatisfy { $0.isNumber || $0 == "." }
            if isNumeric, let last = words.last,
               last.allSatisfy({ $0.isNumber || $0 == "." }) {
                words[words.count - 1] = "\(last).\(token)"
            } else if isNumeric {
                words.append(String(token))
            } else {
                words.append(token.prefix(1).uppercased() + token.dropFirst())
            }
        }
        return words.isEmpty ? canonicalId : words.joined(separator: " ")
    }
}

/// What an unflagged launch on this account runs — both fields genuinely
/// unknown on real machines, so both are discovered facts.
public struct EffectiveDefault: Codable, Equatable, Sendable {
    public var model: DiscoveredFact<String>
    public var effort: DiscoveredFact<String>

    public init(model: DiscoveredFact<String>, effort: DiscoveredFact<String>) {
        self.model = model
        self.effort = effort
    }
}

/// One provider's discovery result: its live catalog, or the measured reason
/// there is none.
public enum ProviderCatalog: Equatable, Sendable {
    case available(models: [DiscoveredModel], effectiveDefault: EffectiveDefault)
    case unavailable(reason: String)
}

extension ProviderCatalog: Codable {
    private enum CodingKeys: String, CodingKey {
        case status, records, effectiveDefault, reason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let status = try container.decode(String.self, forKey: .status)
        if status == "ok" {
            self = .available(
                models: try container.decode([DiscoveredModel].self, forKey: .records),
                effectiveDefault: try container.decode(EffectiveDefault.self, forKey: .effectiveDefault))
        } else {
            self = .unavailable(
                reason: try container.decodeIfPresent(String.self, forKey: .reason)
                    ?? "provider unavailable")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .available(let models, let effectiveDefault):
            try container.encode("ok", forKey: .status)
            try container.encode(models, forKey: .records)
            try container.encode(effectiveDefault, forKey: .effectiveDefault)
        case .unavailable(let reason):
            try container.encode("unavailable", forKey: .status)
            try container.encode(reason, forKey: .reason)
        }
    }
}

// MARK: - Billing

/// The money guard, not a gauge. `creditsEnabled` answers "could a spawn cost
/// real money"; it says nothing about how full any plan window is (§3.4).
public struct BillingSnapshot: Codable, Equatable, Sendable {
    public var creditsEnabled: DiscoveredFact<Bool>
    public var disabledReason: String?
    public var generalUtilization: DiscoveredFact<Double>
    public var modelUtilization: [String: Double]
    public var overflowUncertainty: String?

    public init(
        creditsEnabled: DiscoveredFact<Bool>,
        disabledReason: String? = nil,
        generalUtilization: DiscoveredFact<Double>,
        modelUtilization: [String: Double] = [:],
        overflowUncertainty: String? = nil
    ) {
        self.creditsEnabled = creditsEnabled
        self.disabledReason = disabledReason
        self.generalUtilization = generalUtilization
        self.modelUtilization = modelUtilization
        self.overflowUncertainty = overflowUncertainty
    }
}

// MARK: - Quota

/// One window of one quota pool. Every number is a measurement or nil;
/// nil is UNKNOWN, never zero (src/schemas/quota.ts `QuotaWindowStatus`).
public struct QuotaWindow: Codable, Equatable, Sendable {
    /// What the provider said about this window's EXISTENCE, as opposed to its
    /// reading: "available", "not-metered", or "unknown" (src/schemas/quota.ts).
    ///
    /// Optional because a daemon older than ac0979f does not send it, and an
    /// absent field is unknown — never "available". When it is missing the
    /// derivation falls back to inferring absence from a missing duration.
    public var availability: String?
    public var unit: String
    public var allowance: Double?
    public var used: Double?
    /// Optional for the same reason every other number here is: a window the
    /// plan does not meter has nothing reserved against it, and `0` would be a
    /// measurement of a window that does not exist. The daemon sends null.
    ///
    /// This MUST stay optional. QuotaEntry.init(from:) lets a QuotaPool decode
    /// error propagate, so a single non-decodable window fails the WHOLE
    /// snapshot — `quota` goes nil and the UI reports "the Hive daemon could
    /// not be reached", blanking every provider's meters and blaming the daemon
    /// for a schema mismatch.
    public var reserved: Double?
    public var remaining: Double?
    public var remainingPct: Double?
    public var resetsAt: String?
    public var confidence: String
    public var source: String
    public var observedAt: String?
    public var windowMinutes: Double?

    public init(
        availability: String? = nil,
        unit: String, allowance: Double? = nil, used: Double? = nil,
        reserved: Double? = nil, remaining: Double? = nil, remainingPct: Double? = nil,
        resetsAt: String? = nil, confidence: String, source: String,
        observedAt: String? = nil, windowMinutes: Double? = nil
    ) {
        self.availability = availability
        self.unit = unit
        self.allowance = allowance
        self.used = used
        self.reserved = reserved
        self.remaining = remaining
        self.remainingPct = remainingPct
        self.resetsAt = resetsAt
        self.confidence = confidence
        self.source = source
        self.observedAt = observedAt
        self.windowMinutes = windowMinutes
    }
}

/// A configured or discovered quota pool with its two windows.
public struct QuotaPool: Codable, Equatable, Sendable {
    public var provider: String
    public var account: String
    public var pool: String
    public var origin: String
    public var models: [String]
    public var label: String?
    public var routable: Bool
    public var confidence: String
    public var freshness: String
    public var source: String
    public var fiveHour: QuotaWindow
    public var weekly: QuotaWindow

    public init(
        provider: String, account: String = "default", pool: String,
        origin: String, models: [String] = ["*"], label: String? = nil,
        routable: Bool = true, confidence: String, freshness: String,
        source: String, fiveHour: QuotaWindow, weekly: QuotaWindow
    ) {
        self.provider = provider
        self.account = account
        self.pool = pool
        self.origin = origin
        self.models = models
        self.label = label
        self.routable = routable
        self.confidence = confidence
        self.freshness = freshness
        self.source = source
        self.fiveHour = fiveHour
        self.weekly = weekly
    }
}

/// A provider whose real limits Hive could not read. `fiveHourRecorded` is
/// Hive's own local ledger spend — never account usage, never a meter.
public struct QuotaUnconfigured: Codable, Equatable, Sendable {
    public var provider: String
    public var model: String
    public var reason: String
    public var probeError: String?

    public init(provider: String, model: String, reason: String, probeError: String? = nil) {
        self.provider = provider
        self.model = model
        self.reason = reason
        self.probeError = probeError
    }
}

/// `QuotaStatus = QuotaPoolStatus | QuotaUnconfiguredStatus`, discriminated by
/// the `configured: false` marker on the unconfigured shape.
public enum QuotaEntry: Equatable, Sendable {
    case pool(QuotaPool)
    case unconfigured(QuotaUnconfigured)

    public var provider: String {
        switch self {
        case .pool(let pool): return pool.provider
        case .unconfigured(let entry): return entry.provider
        }
    }
}

extension QuotaEntry: Codable {
    private enum CodingKeys: String, CodingKey { case configured }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let configured = try container.decodeIfPresent(Bool.self, forKey: .configured),
           configured == false {
            self = .unconfigured(try QuotaUnconfigured(from: decoder))
        } else {
            self = .pool(try QuotaPool(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .pool(let pool):
            try pool.encode(to: encoder)
        case .unconfigured(let entry):
            try entry.encode(to: encoder)
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(false, forKey: .configured)
        }
    }
}

// MARK: - The snapshot

/// Whether Hive has any capacity-reading source for a provider at all.
/// `none` is a structural fact about a vendor, not a failed read: a metered
/// provider with no reading is SILENT, which is a different state with
/// different copy.
public enum UsageSurface: Codable, Equatable, Sendable {
    case metered
    case none
    case unknown(String)

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        switch value {
        case "metered": self = .metered
        case "none": self = .none
        default: self = .unknown(value)
        }
    }

    public func encode(to encoder: Encoder) throws {
        let value: String
        switch self {
        case .metered: value = "metered"
        case .none: value = "none"
        case .unknown(let rawValue): value = rawValue
        }
        var container = encoder.singleValueContainer()
        try container.encode(value)
    }
}

// MARK: - Session token accounting

public struct TokenCounts: Codable, Equatable, Sendable {
    public var inputTokens: Int
    public var cachedInputTokens: Int?
    public var cacheCreationInputTokens: Int?
    public var outputTokens: Int
    public var reasoningTokens: Int?
    public var totalTokens: Int
}

public enum TokenUsageReading: Equatable, Sendable {
    case measured(counts: TokenCounts, source: String, observedAt: String)
    case unknown(reason: String)
}

extension TokenUsageReading: Codable {
    private enum CodingKeys: String, CodingKey {
        case state, counts, source, observedAt, reason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let state = (try? container.decode(String.self, forKey: .state)) ?? "missing"
        switch state {
        case "measured":
            do {
                self = .measured(
                    counts: try container.decode(TokenCounts.self, forKey: .counts),
                    source: try container.decode(String.self, forKey: .source),
                    observedAt: try container.decode(String.self, forKey: .observedAt))
            } catch {
                self = .unknown(reason: "could not read measured token usage")
            }
        case "unknown":
            self = .unknown(
                reason: (try? container.decode(String.self, forKey: .reason)) ?? "unspecified")
        default:
            self = .unknown(reason: "unsupported token usage state \(state)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .measured(let counts, let source, let observedAt):
            try container.encode("measured", forKey: .state)
            try container.encode(counts, forKey: .counts)
            try container.encode(source, forKey: .source)
            try container.encode(observedAt, forKey: .observedAt)
        case .unknown(let reason):
            try container.encode("unknown", forKey: .state)
            try container.encode(reason, forKey: .reason)
        }
    }
}

public struct TokenUsageSubject: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var role: String
    /// Open provider id: OpenCode and later CLIs require no wire/UI migration.
    public var provider: String
    public var model: String?
    public var startedAt: String
    public var endedAt: String?
    public var reading: TokenUsageReading
}

public struct TokenUsageBreakdown: Codable, Equatable, Sendable {
    /// nil is no reading; a measured zero is a non-nil all-zero value.
    public var counts: TokenCounts?
    public var subjectCount: Int
}

public struct TokenUsageSession: Codable, Equatable, Sendable {
    public var id: String
    public var repoRoot: String
    public var startedAt: String
    public var endedAt: String?
    public var complete: Bool
    public var unknownSubjects: [String]
    public var fleet: TokenUsageBreakdown
    public var hiveControl: TokenUsageBreakdown
    public var workerSessions: TokenUsageBreakdown
    public var subjects: [TokenUsageSubject]
}

public struct TokenUsageSnapshot: Codable, Equatable, Sendable {
    public var generatedAt: String
    public var currentSessionId: String?
    public var sessions: [TokenUsageSession]
    public var attribution: String
}

public struct ModelControlSnapshot: Codable, Equatable, Sendable {
    public var generatedAt: String
    public var providers: [String: ProviderCatalog]
    public var billing: [String: BillingSnapshot?]
    public var usageSurfaces: [String: UsageSurface]
    /// nil means the daemon could not be asked — quota is UNKNOWN, not empty.
    public var quota: [QuotaEntry]?
    public var quotaError: String?
    /// Optional for compatibility with daemons that predate token tracking.
    public var tokenUsage: TokenUsageSnapshot?
    public var tokenUsageError: String?

    public init(
        generatedAt: String,
        providers: [String: ProviderCatalog],
        billing: [String: BillingSnapshot?] = [:],
        usageSurfaces: [String: UsageSurface] = [:],
        quota: [QuotaEntry]? = nil,
        quotaError: String? = nil,
        tokenUsage: TokenUsageSnapshot? = nil,
        tokenUsageError: String? = nil
    ) {
        self.generatedAt = generatedAt
        self.providers = providers
        self.billing = billing
        self.usageSurfaces = usageSurfaces
        self.quota = quota
        self.quotaError = quotaError
        self.tokenUsage = tokenUsage
        self.tokenUsageError = tokenUsageError
    }

    private enum CodingKeys: String, CodingKey {
        case generatedAt, providers, billing, usageSurfaces
        case quota, quotaError, tokenUsage, tokenUsageError
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try container.decode(String.self, forKey: .generatedAt)

        let providerContainer = try container.nestedContainer(
            keyedBy: ModelControlCodingKey.self, forKey: .providers)
        providers = [:]
        for key in providerContainer.allKeys {
            do {
                providers[key.stringValue] = try providerContainer.decode(
                    ProviderCatalog.self, forKey: key)
            } catch {
                providers[key.stringValue] = .unavailable(
                    reason: "This app could not read this provider snapshot: "
                        + error.localizedDescription)
            }
        }

        billing = [:]
        if let billingContainer = try? container.nestedContainer(
            keyedBy: ModelControlCodingKey.self, forKey: .billing)
        {
            for key in billingContainer.allKeys {
                if (try? billingContainer.decodeNil(forKey: key)) == true {
                    billing.updateValue(nil, forKey: key.stringValue)
                } else if let value = try? billingContainer.decode(
                    BillingSnapshot.self, forKey: key)
                {
                    billing[key.stringValue] = value
                } else {
                    billing.updateValue(nil, forKey: key.stringValue)
                }
            }
        }

        usageSurfaces = [:]
        if let usageContainer = try? container.nestedContainer(
            keyedBy: ModelControlCodingKey.self, forKey: .usageSurfaces)
        {
            for key in usageContainer.allKeys {
                usageSurfaces[key.stringValue] =
                    (try? usageContainer.decode(UsageSurface.self, forKey: key))
                    ?? .unknown("unreadable value")
            }
        }

        quotaError = (try? container.decodeIfPresent(String.self, forKey: .quotaError)) ?? nil
        do {
            quota = try container.decodeIfPresent([QuotaEntry].self, forKey: .quota)
        } catch {
            quota = nil
            quotaError = "This app could not read quota data: \(error.localizedDescription)"
        }

        tokenUsageError =
            (try? container.decodeIfPresent(String.self, forKey: .tokenUsageError)) ?? nil
        do {
            tokenUsage = try container.decodeIfPresent(
                TokenUsageSnapshot.self, forKey: .tokenUsage)
        } catch {
            tokenUsage = nil
            tokenUsageError =
                "This app could not read token usage data: \(error.localizedDescription)"
        }
    }

    public static func decode(from data: Data) throws -> ModelControlSnapshot {
        try JSONDecoder().decode(ModelControlSnapshot.self, from: data)
    }

    /// Every provider the snapshot mentions anywhere, in display order.
    /// Built from the data's own keys — never a hardcoded three-card list.
    public var providerIDs: [ProviderID] {
        var ids = Set(providers.keys)
        ids.formUnion(billing.keys)
        ids.formUnion(usageSurfaces.keys)
        return ids.map { ProviderID($0) }.sorted()
    }
}

private struct ModelControlCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil

    init?(stringValue: String) {
        self.stringValue = stringValue
    }

    init?(intValue: Int) {
        return nil
    }
}
