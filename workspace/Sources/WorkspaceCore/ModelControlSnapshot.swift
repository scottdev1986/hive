import Foundation

/// The wire contract for `hive model-control-snapshot` — one JSON document the Workspace reads from the daemon's `GET /model-control/snapshot`, which serves the same builder the CLI command uses. Honesty rules baked into these types: - Every discovered fact is three-valued at the source: known(value), or unknown(reason). A consumer must branch to read a value, so an undiscovered fact can never be mistaken for a measured one. - Quota numbers are percent-or-null. `null` decodes as `nil` and means UNKNOWN — never 0 and never 100. - `providers` is a dictionary keyed by provider id, so a vendor Hive learns about after this screen ships decodes and renders with no UI change (the fourth-provider test). The *policy* contract stays a closed enum on the daemon side; the render layer must never make a new vendor invisible.

public struct ProviderID: RawRepresentable, Hashable, Codable, Sendable, Comparable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }

    public static let claude = ProviderID("claude")
    public static let codex = ProviderID("codex")
    public static let grok = ProviderID("grok")
    public static let kimi = ProviderID("kimi")
    public static let opencode = ProviderID("opencode")

    public static func < (lhs: ProviderID, rhs: ProviderID) -> Bool {
        let canonical: [ProviderID] = [.claude, .codex, .grok, .kimi, .opencode]
        let li = canonical.firstIndex(of: lhs) ?? canonical.count
        let ri = canonical.firstIndex(of: rhs) ?? canonical.count
        if li != ri { return li < ri }
        return lhs.rawValue < rhs.rawValue
    }
}

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

public struct DiscoveredModel: Codable, Equatable, Sendable {
    public var provider: String
    public var accountFingerprint: String
    public var cliVersion: String
    public var canonicalId: String
    public var variant: String?
    public var launchToken: String
    public var aliases: [String]
    public var displayName: String?
    public var entitled: DiscoveredFact<Bool>
    public var hidden: DiscoveredFact<Bool>
    public var supportsEffort: DiscoveredFact<Bool>
    public var supportedEffortLevels: DiscoveredFact<[String]>
    public var defaultEffort: DiscoveredFact<String>
    public var observedAt: String

    private enum CodingKeys: String, CodingKey {
        case provider, accountFingerprint, cliVersion, canonicalId, variant
        case launchToken, aliases, displayName, entitled, hidden
        case supportsEffort, supportedEffortLevels, defaultEffort, observedAt
    }

    public init(
        provider: String,
        accountFingerprint: String,
        cliVersion: String,
        canonicalId: String,
        variant: String? = nil,
        launchToken: String,
        aliases: [String],
        displayName: String? = nil,
        entitled: DiscoveredFact<Bool>,
        hidden: DiscoveredFact<Bool>,
        supportsEffort: DiscoveredFact<Bool>,
        supportedEffortLevels: DiscoveredFact<[String]>,
        defaultEffort: DiscoveredFact<String>,
        observedAt: String
    ) {
        self.provider = provider
        self.accountFingerprint = accountFingerprint
        self.cliVersion = cliVersion
        self.canonicalId = canonicalId
        self.variant = variant
        self.launchToken = launchToken
        self.aliases = aliases
        self.displayName = displayName
        self.entitled = entitled
        self.hidden = hidden
        self.supportsEffort = supportsEffort
        self.supportedEffortLevels = supportedEffortLevels
        self.defaultEffort = defaultEffort
        self.observedAt = observedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = try container.decode(String.self, forKey: .provider)
        accountFingerprint = try container.decode(
            String.self,
            forKey: .accountFingerprint)
        cliVersion = try container.decode(String.self, forKey: .cliVersion)
        canonicalId = try container.decode(String.self, forKey: .canonicalId)
        variant = try container.decodeRequiredNullable(
            String.self,
            forKey: .variant)
        launchToken = try container.decode(String.self, forKey: .launchToken)
        aliases = try container.decode([String].self, forKey: .aliases)
        displayName = try container.decodeRequiredNullable(
            String.self,
            forKey: .displayName)
        entitled = try container.decode(
            DiscoveredFact<Bool>.self,
            forKey: .entitled)
        hidden = try container.decode(
            DiscoveredFact<Bool>.self,
            forKey: .hidden)
        supportsEffort = try container.decode(
            DiscoveredFact<Bool>.self,
            forKey: .supportsEffort)
        supportedEffortLevels = try container.decode(
            DiscoveredFact<[String]>.self,
            forKey: .supportedEffortLevels)
        defaultEffort = try container.decode(
            DiscoveredFact<String>.self,
            forKey: .defaultEffort)
        observedAt = try container.decode(String.self, forKey: .observedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(provider, forKey: .provider)
        try container.encode(accountFingerprint, forKey: .accountFingerprint)
        try container.encode(cliVersion, forKey: .cliVersion)
        try container.encode(canonicalId, forKey: .canonicalId)
        try container.encode(variant, forKey: .variant)
        try container.encode(launchToken, forKey: .launchToken)
        try container.encode(aliases, forKey: .aliases)
        try container.encode(displayName, forKey: .displayName)
        try container.encode(entitled, forKey: .entitled)
        try container.encode(hidden, forKey: .hidden)
        try container.encode(supportsEffort, forKey: .supportsEffort)
        try container.encode(
            supportedEffortLevels,
            forKey: .supportedEffortLevels)
        try container.encode(defaultEffort, forKey: .defaultEffort)
        try container.encode(observedAt, forKey: .observedAt)
    }

}

public struct EffectiveDefault: Codable, Equatable, Sendable {
    public var provider: String
    public var model: DiscoveredFact<String>
    public var effort: DiscoveredFact<String>

    public init(
        provider: String,
        model: DiscoveredFact<String>,
        effort: DiscoveredFact<String>
    ) {
        self.provider = provider
        self.model = model
        self.effort = effort
    }
}

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

public struct BillingSnapshot: Codable, Equatable, Sendable {
    public var creditsEnabled: DiscoveredFact<Bool>
    public var generalUtilization: DiscoveredFact<Double>
    public var modelUtilization: [String: Double]
    public var overflowUncertainty: String?

    public init(
        creditsEnabled: DiscoveredFact<Bool>,
        generalUtilization: DiscoveredFact<Double>,
        modelUtilization: [String: Double] = [:],
        overflowUncertainty: String? = nil
    ) {
        self.creditsEnabled = creditsEnabled
        self.generalUtilization = generalUtilization
        self.modelUtilization = modelUtilization
        self.overflowUncertainty = overflowUncertainty
    }

    private enum CodingKeys: String, CodingKey {
        case creditsEnabled
        case generalUtilization
        case modelUtilization
        case overflowUncertainty
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        creditsEnabled = try container.decode(
            DiscoveredFact<Bool>.self,
            forKey: .creditsEnabled)
        generalUtilization = try container.decode(
            DiscoveredFact<Double>.self,
            forKey: .generalUtilization)
        modelUtilization = try container.decode(
            [String: Double].self,
            forKey: .modelUtilization)
        overflowUncertainty = try container.decodeIfPresent(
            String.self,
            forKey: .overflowUncertainty)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(creditsEnabled, forKey: .creditsEnabled)
        try container.encode(generalUtilization, forKey: .generalUtilization)
        try container.encode(modelUtilization, forKey: .modelUtilization)
        try container.encode(overflowUncertainty, forKey: .overflowUncertainty)
    }
}

/// One window of one quota pool. Every number is a measurement or nil; nil is UNKNOWN, never zero (src/schemas/quota.ts `QuotaWindowStatus`).
public struct QuotaWindow: Codable, Equatable, Sendable {
    /// What the provider said about this window's EXISTENCE, as opposed to its reading: "available", "not-metered", or "unknown" (src/schemas/quota.ts). Optional because a daemon older than ac0979f does not send it, and an absent field is unknown — never "available". When it is missing the derivation falls back to inferring absence from a missing duration.
    public var availability: String?
    public var unit: String
    public var allowance: Double?
    public var used: Double?
    public var reserved: Double?
    public var reservedIsEstimate: Bool?
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
        reserved: Double? = nil, reservedIsEstimate: Bool? = nil,
        remaining: Double? = nil, remainingPct: Double? = nil,
        resetsAt: String? = nil, confidence: String, source: String,
        observedAt: String? = nil, windowMinutes: Double? = nil
    ) {
        self.availability = availability
        self.unit = unit
        self.allowance = allowance
        self.used = used
        self.reserved = reserved
        self.reservedIsEstimate = reservedIsEstimate
        self.remaining = remaining
        self.remainingPct = remainingPct
        self.resetsAt = resetsAt
        self.confidence = confidence
        self.source = source
        self.observedAt = observedAt
        self.windowMinutes = windowMinutes
    }

    private enum CodingKeys: String, CodingKey {
        case availability
        case unit
        case allowance
        case used
        case reserved
        case reservedIsEstimate
        case remaining
        case remainingPct
        case resetsAt
        case confidence
        case source
        case observedAt
        case windowMinutes
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        availability = try container.decodeIfPresent(
            String.self,
            forKey: .availability)
        unit = try container.decode(String.self, forKey: .unit)
        allowance = try container.decodeRequiredNullable(
            Double.self,
            forKey: .allowance)
        used = try container.decodeRequiredNullable(Double.self, forKey: .used)
        reserved = try container.decodeRequiredNullable(
            Double.self,
            forKey: .reserved)
        reservedIsEstimate = try container.decodeRequiredNullable(
            Bool.self,
            forKey: .reservedIsEstimate)
        remaining = try container.decodeRequiredNullable(
            Double.self,
            forKey: .remaining)
        remainingPct = try container.decodeRequiredNullable(
            Double.self,
            forKey: .remainingPct)
        resetsAt = try container.decodeRequiredNullable(
            String.self,
            forKey: .resetsAt)
        confidence = try container.decode(String.self, forKey: .confidence)
        source = try container.decode(String.self, forKey: .source)
        observedAt = try container.decodeRequiredNullable(
            String.self,
            forKey: .observedAt)
        windowMinutes = try container.decodeRequiredNullable(
            Double.self,
            forKey: .windowMinutes)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(availability, forKey: .availability)
        try container.encode(unit, forKey: .unit)
        try container.encode(allowance, forKey: .allowance)
        try container.encode(used, forKey: .used)
        try container.encode(reserved, forKey: .reserved)
        try container.encode(reservedIsEstimate, forKey: .reservedIsEstimate)
        try container.encode(remaining, forKey: .remaining)
        try container.encode(remainingPct, forKey: .remainingPct)
        try container.encode(resetsAt, forKey: .resetsAt)
        try container.encode(confidence, forKey: .confidence)
        try container.encode(source, forKey: .source)
        try container.encode(observedAt, forKey: .observedAt)
        try container.encode(windowMinutes, forKey: .windowMinutes)
    }
}

public struct QuotaPool: Codable, Equatable, Sendable {
    public var provider: String
    public var account: String
    public var pool: String
    public var origin: String
    public var overridesDiscovered: Bool
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
        origin: String, overridesDiscovered: Bool = false,
        models: [String] = ["*"], label: String? = nil,
        routable: Bool = true, confidence: String, freshness: String,
        source: String, fiveHour: QuotaWindow, weekly: QuotaWindow
    ) {
        self.provider = provider
        self.account = account
        self.pool = pool
        self.origin = origin
        self.overridesDiscovered = overridesDiscovered
        self.models = models
        self.label = label
        self.routable = routable
        self.confidence = confidence
        self.freshness = freshness
        self.source = source
        self.fiveHour = fiveHour
        self.weekly = weekly
    }

    private enum CodingKeys: String, CodingKey {
        case provider
        case account
        case pool
        case origin
        case overridesDiscovered
        case models
        case label
        case routable
        case confidence
        case freshness
        case source
        case fiveHour
        case weekly
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = try container.decode(String.self, forKey: .provider)
        account = try container.decode(String.self, forKey: .account)
        pool = try container.decode(String.self, forKey: .pool)
        origin = try container.decode(String.self, forKey: .origin)
        overridesDiscovered = try container.decode(
            Bool.self,
            forKey: .overridesDiscovered)
        models = try container.decode([String].self, forKey: .models)
        label = try container.decodeRequiredNullable(
            String.self,
            forKey: .label)
        routable = try container.decode(Bool.self, forKey: .routable)
        confidence = try container.decode(String.self, forKey: .confidence)
        freshness = try container.decode(String.self, forKey: .freshness)
        source = try container.decode(String.self, forKey: .source)
        fiveHour = try container.decode(QuotaWindow.self, forKey: .fiveHour)
        weekly = try container.decode(QuotaWindow.self, forKey: .weekly)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(provider, forKey: .provider)
        try container.encode(account, forKey: .account)
        try container.encode(pool, forKey: .pool)
        try container.encode(origin, forKey: .origin)
        try container.encode(
            overridesDiscovered,
            forKey: .overridesDiscovered)
        try container.encode(models, forKey: .models)
        try container.encode(label, forKey: .label)
        try container.encode(routable, forKey: .routable)
        try container.encode(confidence, forKey: .confidence)
        try container.encode(freshness, forKey: .freshness)
        try container.encode(source, forKey: .source)
        try container.encode(fiveHour, forKey: .fiveHour)
        try container.encode(weekly, forKey: .weekly)
    }
}

/// A provider whose real limits Hive could not read. `fiveHourRecorded` is Hive's own local ledger spend — never account usage, never a meter.
public struct QuotaUnconfigured: Codable, Equatable, Sendable {
    public var provider: String
    public var model: String
    public var confidence: String
    public var reason: String
    public var probeError: String?
    public var reserved: Double
    public var fiveHourRecorded: Double
    public var weeklyRecorded: Double
    public var recordedIsLocalEstimate: Bool

    public init(
        provider: String,
        model: String,
        confidence: String,
        reason: String,
        probeError: String?,
        reserved: Double,
        fiveHourRecorded: Double,
        weeklyRecorded: Double,
        recordedIsLocalEstimate: Bool
    ) {
        self.provider = provider
        self.model = model
        self.confidence = confidence
        self.reason = reason
        self.probeError = probeError
        self.reserved = reserved
        self.fiveHourRecorded = fiveHourRecorded
        self.weeklyRecorded = weeklyRecorded
        self.recordedIsLocalEstimate = recordedIsLocalEstimate
    }

    private enum CodingKeys: String, CodingKey {
        case provider
        case model
        case confidence
        case reason
        case probeError
        case reserved
        case fiveHourRecorded
        case weeklyRecorded
        case recordedIsLocalEstimate
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = try container.decode(String.self, forKey: .provider)
        model = try container.decode(String.self, forKey: .model)
        confidence = try container.decode(String.self, forKey: .confidence)
        reason = try container.decode(String.self, forKey: .reason)
        probeError = try container.decodeRequiredNullable(
            String.self,
            forKey: .probeError)
        reserved = try container.decode(Double.self, forKey: .reserved)
        fiveHourRecorded = try container.decode(
            Double.self,
            forKey: .fiveHourRecorded)
        weeklyRecorded = try container.decode(
            Double.self,
            forKey: .weeklyRecorded)
        recordedIsLocalEstimate = try container.decode(
            Bool.self,
            forKey: .recordedIsLocalEstimate)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(provider, forKey: .provider)
        try container.encode(model, forKey: .model)
        try container.encode(confidence, forKey: .confidence)
        try container.encode(reason, forKey: .reason)
        try container.encode(probeError, forKey: .probeError)
        try container.encode(reserved, forKey: .reserved)
        try container.encode(fiveHourRecorded, forKey: .fiveHourRecorded)
        try container.encode(weeklyRecorded, forKey: .weeklyRecorded)
        try container.encode(
            recordedIsLocalEstimate,
            forKey: .recordedIsLocalEstimate)
    }
}

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

public struct TokenCounts: Codable, Equatable, Sendable {
    public var inputTokens: Int
    public var cachedInputTokens: Int?
    public var cacheCreationInputTokens: Int?
    public var outputTokens: Int
    public var reasoningTokens: Int?
    public var totalTokens: Int

    public init(
        inputTokens: Int,
        cachedInputTokens: Int?,
        cacheCreationInputTokens: Int?,
        outputTokens: Int,
        reasoningTokens: Int?,
        totalTokens: Int
    ) {
        self.inputTokens = inputTokens
        self.cachedInputTokens = cachedInputTokens
        self.cacheCreationInputTokens = cacheCreationInputTokens
        self.outputTokens = outputTokens
        self.reasoningTokens = reasoningTokens
        self.totalTokens = totalTokens
    }

    private enum CodingKeys: String, CodingKey {
        case inputTokens
        case cachedInputTokens
        case cacheCreationInputTokens
        case outputTokens
        case reasoningTokens
        case totalTokens
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        inputTokens = try container.decode(Int.self, forKey: .inputTokens)
        cachedInputTokens = try container.decodeRequiredNullable(
            Int.self,
            forKey: .cachedInputTokens)
        cacheCreationInputTokens = try container.decodeRequiredNullable(
            Int.self,
            forKey: .cacheCreationInputTokens)
        outputTokens = try container.decode(Int.self, forKey: .outputTokens)
        reasoningTokens = try container.decodeRequiredNullable(
            Int.self,
            forKey: .reasoningTokens)
        totalTokens = try container.decode(Int.self, forKey: .totalTokens)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(inputTokens, forKey: .inputTokens)
        try container.encode(cachedInputTokens, forKey: .cachedInputTokens)
        try container.encode(
            cacheCreationInputTokens,
            forKey: .cacheCreationInputTokens)
        try container.encode(outputTokens, forKey: .outputTokens)
        try container.encode(reasoningTokens, forKey: .reasoningTokens)
        try container.encode(totalTokens, forKey: .totalTokens)
    }
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
    public var provider: String
    public var model: String?
    public var startedAt: String
    public var endedAt: String?
    public var reading: TokenUsageReading

    public init(
        id: String,
        name: String,
        role: String,
        provider: String,
        model: String?,
        startedAt: String,
        endedAt: String?,
        reading: TokenUsageReading
    ) {
        self.id = id
        self.name = name
        self.role = role
        self.provider = provider
        self.model = model
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.reading = reading
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case name
        case role
        case provider
        case model
        case startedAt
        case endedAt
        case reading
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        role = try container.decode(String.self, forKey: .role)
        provider = try container.decode(String.self, forKey: .provider)
        model = try container.decodeRequiredNullable(String.self, forKey: .model)
        startedAt = try container.decode(String.self, forKey: .startedAt)
        endedAt = try container.decodeRequiredNullable(
            String.self,
            forKey: .endedAt)
        reading = try container.decode(
            TokenUsageReading.self,
            forKey: .reading)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(role, forKey: .role)
        try container.encode(provider, forKey: .provider)
        try container.encode(model, forKey: .model)
        try container.encode(startedAt, forKey: .startedAt)
        try container.encode(endedAt, forKey: .endedAt)
        try container.encode(reading, forKey: .reading)
    }
}

public struct TokenUsageBreakdown: Codable, Equatable, Sendable {
    public var counts: TokenCounts?
    public var subjectCount: Int

    public init(counts: TokenCounts?, subjectCount: Int) {
        self.counts = counts
        self.subjectCount = subjectCount
    }

    private enum CodingKeys: String, CodingKey {
        case counts
        case subjectCount
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        counts = try container.decodeRequiredNullable(
            TokenCounts.self,
            forKey: .counts)
        subjectCount = try container.decode(Int.self, forKey: .subjectCount)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(counts, forKey: .counts)
        try container.encode(subjectCount, forKey: .subjectCount)
    }
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

    public init(
        id: String,
        repoRoot: String,
        startedAt: String,
        endedAt: String?,
        complete: Bool,
        unknownSubjects: [String],
        fleet: TokenUsageBreakdown,
        hiveControl: TokenUsageBreakdown,
        workerSessions: TokenUsageBreakdown,
        subjects: [TokenUsageSubject]
    ) {
        self.id = id
        self.repoRoot = repoRoot
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.complete = complete
        self.unknownSubjects = unknownSubjects
        self.fleet = fleet
        self.hiveControl = hiveControl
        self.workerSessions = workerSessions
        self.subjects = subjects
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case repoRoot
        case startedAt
        case endedAt
        case complete
        case unknownSubjects
        case fleet
        case hiveControl
        case workerSessions
        case subjects
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        repoRoot = try container.decode(String.self, forKey: .repoRoot)
        startedAt = try container.decode(String.self, forKey: .startedAt)
        endedAt = try container.decodeRequiredNullable(
            String.self,
            forKey: .endedAt)
        complete = try container.decode(Bool.self, forKey: .complete)
        unknownSubjects = try container.decode(
            [String].self,
            forKey: .unknownSubjects)
        fleet = try container.decode(
            TokenUsageBreakdown.self,
            forKey: .fleet)
        hiveControl = try container.decode(
            TokenUsageBreakdown.self,
            forKey: .hiveControl)
        workerSessions = try container.decode(
            TokenUsageBreakdown.self,
            forKey: .workerSessions)
        subjects = try container.decode(
            [TokenUsageSubject].self,
            forKey: .subjects)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(repoRoot, forKey: .repoRoot)
        try container.encode(startedAt, forKey: .startedAt)
        try container.encode(endedAt, forKey: .endedAt)
        try container.encode(complete, forKey: .complete)
        try container.encode(unknownSubjects, forKey: .unknownSubjects)
        try container.encode(fleet, forKey: .fleet)
        try container.encode(hiveControl, forKey: .hiveControl)
        try container.encode(workerSessions, forKey: .workerSessions)
        try container.encode(subjects, forKey: .subjects)
    }
}

public struct TokenUsageSnapshot: Codable, Equatable, Sendable {
    public var generatedAt: String
    public var currentSessionId: String?
    public var sessions: [TokenUsageSession]
    public var attribution: String

    private enum CodingKeys: String, CodingKey {
        case generatedAt
        case currentSessionId
        case sessions
        case attribution
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try container.decode(String.self, forKey: .generatedAt)
        currentSessionId = try container.decodeRequiredNullable(
            String.self,
            forKey: .currentSessionId)
        sessions = try container.decode(
            [TokenUsageSession].self,
            forKey: .sessions)
        attribution = try container.decode(String.self, forKey: .attribution)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(generatedAt, forKey: .generatedAt)
        try container.encode(currentSessionId, forKey: .currentSessionId)
        try container.encode(sessions, forKey: .sessions)
        try container.encode(attribution, forKey: .attribution)
    }
}

public struct ModelControlSnapshot: Codable, Equatable, Sendable {
    public var generatedAt: String
    public var providers: [String: ProviderCatalog]
    public var billing: [String: BillingSnapshot?]
    public var usageSurfaces: [String: UsageSurface]
    public var quota: [QuotaEntry]?
    public var quotaError: String?
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
            keyedBy: ModelControlCodingKey.self,
            forKey: .billing)
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
            keyedBy: ModelControlCodingKey.self,
            forKey: .usageSurfaces)
        {
            for key in usageContainer.allKeys {
                usageSurfaces[key.stringValue] =
                    (try? usageContainer.decode(UsageSurface.self, forKey: key))
                    ?? .unknown("unreadable value")
            }
        }

        quotaError =
            (try? container.decodeIfPresent(String.self, forKey: .quotaError)) ?? nil
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

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(generatedAt, forKey: .generatedAt)
        try container.encode(providers, forKey: .providers)
        try container.encode(billing, forKey: .billing)
        try container.encode(usageSurfaces, forKey: .usageSurfaces)
        try container.encode(quota, forKey: .quota)
        try container.encode(quotaError, forKey: .quotaError)
        try container.encode(tokenUsage, forKey: .tokenUsage)
        try container.encode(tokenUsageError, forKey: .tokenUsageError)
    }

    public static func decode(from data: Data) throws -> ModelControlSnapshot {
        try JSONDecoder().decode(ModelControlSnapshot.self, from: data)
    }

    /// Every provider the snapshot mentions anywhere, in display order. Built from the data's own keys — never a hardcoded three-card list.
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
