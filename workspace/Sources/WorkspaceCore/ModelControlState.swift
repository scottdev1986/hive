import Foundation

/// Derived, renderable state for the Model Control Center. Pure functions from
/// (snapshot, policy) → view state, so every honesty rule here is testable
/// without AppKit:
///
/// - a window with no reading derives `.unknown`, never a 0% meter (§2.2)
/// - a provider with no capacity surface derives `.unmetered`, never meters (§2.3)
/// - effort derives three distinct values (§2.4)
/// - provider-off dominates every model row beneath it (§7.4)

// MARK: - Meters

/// One meter window's render state. There is deliberately no way to construct
/// a determinate bar out of a missing reading.
public enum MeterState: Equatable, Sendable {
    /// A real percent the provider reported. 0 here means MEASURED zero.
    case measured(usedPercent: Double, resetsAt: Date?, observedAt: Date?, confidence: String)
    /// The last real percent, aged past freshness. Rendered desaturated with
    /// its age — never presented as current.
    case stale(usedPercent: Double, observedAt: Date?, resetsAt: Date?)
    /// No reading. NOT zero. Rendered with no determinate track.
    case unknown(reason: String)
}

public struct MeterWindow: Equatable, Sendable {
    public var label: String
    public var state: MeterState

    public init(label: String, state: MeterState) {
        self.label = label
        self.state = state
    }
}

/// A provider card's usage block. `.unmetered` and `.silent` are different
/// states with different copy: one vendor has nothing to report by design,
/// the other normally reports and did not (§7.4).
public enum ProviderUsage: Equatable, Sendable {
    case metered([MeterWindow])
    /// Normally-metered vendor, no reading anywhere (e.g. Claude's
    /// experimental feed gone quiet). The provider stays enabled and spawnable.
    case silent(reason: String)
    /// The vendor publishes no capacity surface at all (Grok). Deliberate,
    /// first-class, never a meter and never an error state.
    case unmetered
    /// Hive could not ask (daemon down). Distinct from a vendor going quiet.
    case unknown(reason: String)
}

/// Near-limit severity, computed from *remaining* fraction per live config
/// thresholds — never a hardcoded "80% used" (§3.3).
public enum MeterSeverity: Equatable, Sendable {
    case healthy
    case nearLimit
    case critical

    public init(remainingPct: Double, warningRemainingPct: Double, criticalRemainingPct: Double) {
        if remainingPct <= criticalRemainingPct {
            self = .critical
        } else if remainingPct <= warningRemainingPct {
            self = .nearLimit
        } else {
            self = .healthy
        }
    }
}

public enum MeterDerivation {
    /// Derive one window's render state from a quota window reading.
    /// `used == nil` is unknown — the bar must not exist, not sit at 0.
    public static func meterState(
        for window: QuotaWindow,
        parseDate: (String?) -> Date? = MeterDerivation.parseISO
    ) -> MeterState {
        guard window.unit == "percent" else {
            // Manual unit pools are operator planning tools; this screen
            // renders discovered percent meters only (§2.1).
            return .unknown(reason: "manual-unit pool — not a discovered percent meter")
        }
        let resetsAt = parseDate(window.resetsAt)
        let observedAt = parseDate(window.observedAt)
        if let used = window.used {
            if window.confidence == "stale" {
                return .stale(usedPercent: used, observedAt: observedAt, resetsAt: resetsAt)
            }
            return .measured(
                usedPercent: used, resetsAt: resetsAt,
                observedAt: observedAt, confidence: window.confidence)
        }
        // remainingPct without used still supports an honest fill (1 - remaining).
        if let remainingPct = window.remainingPct, window.allowance != nil {
            let used = max(0, min(100, 100 - remainingPct * 100))
            if window.confidence == "stale" {
                return .stale(usedPercent: used, observedAt: observedAt, resetsAt: resetsAt)
            }
            return .measured(
                usedPercent: used, resetsAt: resetsAt,
                observedAt: observedAt, confidence: window.confidence)
        }
        return .unknown(reason: "no reading for this window")
    }

    /// Derive a provider card's usage block.
    ///
    /// - A provider whose `usageSurfaces` entry is `.none` is UNMETERED —
    ///   deliberately, structurally — and never gets meters even if a stray
    ///   number exists somewhere (§2.3: money rails are not gauges).
    /// - A metered provider with discovered percent pools maps each window.
    /// - A metered provider with no reading at all is SILENT with the measured
    ///   reason.
    /// - `quota == nil` (daemon unreachable) is UNKNOWN.
    public static func usage(
        provider: ProviderID,
        surface: UsageSurface?,
        quota: [QuotaEntry]?,
        quotaError: String?,
        parseDate: (String?) -> Date? = MeterDerivation.parseISO
    ) -> ProviderUsage {
        if surface == UsageSurface.none {
            return .unmetered
        }
        guard let quota else {
            return .unknown(reason: quotaError ?? "the Hive daemon could not be reached")
        }
        let pools = quota.compactMap { entry -> QuotaPool? in
            if case .pool(let pool) = entry, pool.provider == provider.rawValue,
               pool.origin == "discovered" {
                return pool
            }
            return nil
        }
        // The card meters the ACCOUNT pool (models == ["*"]). Model-scoped
        // pools (a per-model ceiling) surface as row badges, not card meters.
        if let pool = pools.first(where: { $0.models == ["*"] }) ?? pools.first {
            return .metered([
                MeterWindow(label: "5 hour window", state: meterState(for: pool.fiveHour, parseDate: parseDate)),
                MeterWindow(label: "7 day window", state: meterState(for: pool.weekly, parseDate: parseDate)),
            ])
        }
        let unconfigured = quota.compactMap { entry -> QuotaUnconfigured? in
            if case .unconfigured(let status) = entry, status.provider == provider.rawValue {
                return status
            }
            return nil
        }
        if let status = unconfigured.first {
            return .silent(reason: status.probeError ?? status.reason)
        }
        return .silent(reason: "\(provider.rawValue) reported no usage data")
    }

    /// The plan tier the provider reported for its account pool ("max",
    /// "prolite"), when quota discovery carried one. Display-only.
    public static func planLabel(provider: ProviderID, quota: [QuotaEntry]?) -> String? {
        guard let quota else { return nil }
        for entry in quota {
            if case .pool(let pool) = entry, pool.provider == provider.rawValue,
               pool.origin == "discovered", pool.models == ["*"], let label = pool.label {
                return label
            }
        }
        return nil
    }

    /// Whether a MEASURED model-scoped pool says this model's own ceiling is
    /// exhausted (§7.4 `pool-exhausted`). Unknown is not exhausted: a window
    /// with no reading never trips this.
    public static func modelPoolExhausted(
        provider: ProviderID, canonicalId: String, quota: [QuotaEntry]?
    ) -> Bool {
        guard let quota else { return false }
        for entry in quota {
            guard case .pool(let pool) = entry, pool.provider == provider.rawValue,
                  pool.origin == "discovered", pool.models.contains(canonicalId),
                  pool.models != ["*"] else { continue }
            for window in [pool.fiveHour, pool.weekly] {
                guard window.unit == "percent", let used = window.used,
                      window.confidence != "stale" else { continue }
                if used >= (window.allowance ?? 100) { return true }
            }
        }
        return false
    }

    public static func parseISO(_ string: String?) -> Date? {
        guard let string else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: string) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: string)
    }
}

// MARK: - Effort

/// The three-valued effort axis (§2.4). `known-none` (the vendor STATED there
/// is no effort axis) and `unknown` (we could not read it) are different facts
/// and must never share a rendering.
public enum EffortAxis: Equatable, Sendable {
    /// The vendor listed effort levels. Picker with exactly these strings,
    /// in vendor order.
    case known(levels: [String], defaultLevel: String?)
    /// The vendor stated `supportsEffort: false`. No picker; "This model has
    /// no effort setting."
    case none
    /// Surface silent / field absent / malformed. No picker; "Effort options
    /// unknown" plus the measured reason.
    case unknown(reason: String)

    public static func derive(from model: DiscoveredModel) -> EffortAxis {
        if case .known(false, _, _) = model.supportsEffort {
            return .none
        }
        if case .known(let levels, _, _) = model.supportedEffortLevels {
            if levels.isEmpty {
                // The vendor advertised an effort axis but listed no levels —
                // an inconsistency we surface, never paper over with a guess.
                return .unknown(reason: "vendor listed no effort levels")
            }
            return .known(levels: levels, defaultLevel: model.defaultEffort.value)
        }
        let reason = model.supportedEffortLevels.unknownReason
            ?? model.supportsEffort.unknownReason
            ?? "unspecified"
        return .unknown(reason: reason)
    }
}

// MARK: - Model rows

/// The visually distinct model-row states (§7.4, consent-is-enablement).
/// The override rule is non-negotiable: effectiveEnabled = providerEnabled &&
/// modelEnabled && available, and when effective and preference differ the UI
/// shows both. The three OFF reasons never collapse: shipped-off-awaiting-
/// consent is inviting, user-off is neutral, provider-off is an override.
public enum ModelRowState: Equatable, Sendable {
    case enabled
    /// Shipped off because billing coverage could not be verified; flipping
    /// it on is the user's consent to spend. Deliberate and inviting — never
    /// broken-looking, never second-class.
    case seededOff
    case disabledBySelf
    /// The provider master is off. The stored preference is carried so the UI
    /// can say "your preference: on (not effective)" — never a green toggle
    /// wearing authority it does not have.
    case disabledByProvider(preferenceOn: Bool)
    /// Not in the live catalog / vendor-hidden. Toggle disabled.
    case unavailable

    public var isEffectivelyEnabled: Bool {
        self == .enabled
    }

    public static func derive(
        providerEnabled: Bool,
        enablement: ModelEnablement,
        modelAvailable: Bool
    ) -> ModelRowState {
        if !modelAvailable { return .unavailable }
        if !providerEnabled {
            return .disabledByProvider(preferenceOn: enablement == .enabled)
        }
        switch enablement {
        case .enabled: return .enabled
        case .seededOff: return .seededOff
        case .disabledByUser: return .disabledBySelf
        }
    }
}

/// The calm, persistent may-spend affordance (consent-is-enablement). Since
/// flipping a model on IS the authorisation to spend, a row whose billing
/// cannot be verified as covered must say so inline — honestly, without a
/// scare dialog and without a confirmation step.
///
/// Returns nil when spend is verified impossible (credits known OFF: a plan
/// limit is a wall, not a bill — no nag). Otherwise returns the measured
/// reason the coverage could not be verified.
public enum SpendCaveat {
    public static func derive(from billing: BillingSnapshot?) -> String? {
        guard let billing else {
            return "Hive cannot read this vendor's billing"
        }
        switch billing.creditsEnabled {
        case .known(let enabled, _, _):
            return enabled ? "usage credits are enabled on this account" : nil
        case .unknown:
            return billing.overflowUncertainty
                ?? "the vendor's paid-overflow switch is unreadable"
        }
    }
}

// MARK: - Billing chips

/// The billing strip's chip (§3.4). Paid-overflow-off is CALM — the wallet is
/// safe and a plan limit is a wall, not a bill. Unknown says unknown.
public enum BillingChip: Equatable, Sendable {
    case paidOverflowOff
    case creditsAvailable
    case unknown

    public static func derive(from billing: BillingSnapshot?) -> BillingChip {
        guard let billing else { return .unknown }
        switch billing.creditsEnabled {
        case .known(let enabled, _, _): return enabled ? .creditsAvailable : .paidOverflowOff
        case .unknown: return .unknown
        }
    }
}
