import Foundation

/// The Model Control Center copy catalog — exact strings from the spec (§13).
/// Do not rephrase in ways that soften "unknown". There is deliberately no
/// "falls back to any enabled model" string anywhere: that behavior does not
/// exist and must not be promised.
enum MCCCopy {

    // Page

    static let pageTitle = "Model Control Center"
    static let pageSubtitle =
        "Choose which tools Hive may use, and which models handle each kind of work. " +
        "Usage numbers are what the provider reported — never estimates dressed as measurements."
    static let providersSection = "Providers"
    static let categoriesSection = "Task Categories"
    static let footerHonesty =
        "Measure or say unknown. Zero means measured zero; blank means Hive cannot tell."
    static let provisionalBanner =
        "Provisional Hive suggestions — edit anytime; no outcome data yet."
    static let warnNoProviders =
        "No providers enabled — Hive cannot spawn agents until at least one provider is turned on."
    static let warnDefaultChainEmpty =
        "Your Default chain is empty. Categories with no chain of their own have nowhere to go."

    // Badges

    static let badgeUsageUntracked = "Usage limits cannot be tracked for this provider"
    static let badgeUsageUnknown = "Usage unknown"
    static let badgeUsageStale = "Stale reading"
    static let badgeNearLimit = "Near limit"
    static let badgeCritical = "Critically low"
    static let badgePlanLimit = "Plan limit reached"
    static let badgeProviderOff = "Off — Hive will not invoke this CLI"
    static let badgeNotAvailable = "Not available"
    static let badgeUnavailableModel = "Unavailable"
    static let badgePaidOverflowOff = "Paid overflow off"
    static let badgeCreditsAvailable = "Credits available"
    static let badgeBillingUnknown = "Billing state unknown"
    static let badgeProvisional = "Provisional"
    static let badgeUnresolvable = "Model no longer offered by this provider"

    // Meters and the silent feed

    static func meterUsedPct(_ n: Int) -> String { "\(n)% used" }
    static let meterWindow5h = "5 hour window"
    static let meterWindow7d = "7 day window"
    static func meterResetsIn(_ relative: String) -> String { "Resets in \(relative)" }
    static let meterUnknownBody = "Hive has no reading for this window"
    static func meterSilentFeed(_ providerTitle: String) -> String {
        "\(providerTitle) reported no usage data. This surface is experimental and " +
        "sometimes goes quiet — \(providerTitle) itself is still available."
    }
    static func meterStaleAge(_ relative: String) -> String { "Last read \(relative) ago" }

    // Unmetered provider (Grok)

    static let unmeteredTitle = "Usage limits cannot be tracked for this provider"
    static let unmeteredBody =
        "xAI does not report plan capacity to Hive. Money rails are monitored so Hive " +
        "does not silently spend on-demand balance; they are not a usage gauge."

    // Effort

    static let effortNone = "This model has no effort setting."
    static func effortUnknown(_ reason: String) -> String {
        "Effort options unknown — \(reason)"
    }
    static let effortProviderControlled = "Vendor default (Hive sends no effort flag)"

    // Consent is enablement: flipping a model on IS the authorisation to
    // spend. The copy must make that impossible to miss without alarm.

    static let seededOffBadge = "Off by default"
    static let seededOffCaption =
        "Shipped off — Hive could not verify billing coverage. Turn it on to allow use; " +
        "enabling authorises any spend it incurs."
    static func maySpend(_ reason: String) -> String {
        "Enabling this may spend real money — \(reason)."
    }
    static func maySpendEnabled(_ reason: String) -> String {
        "May spend real money — \(reason)."
    }
    static func a11ySeededOff(_ model: String) -> String {
        "\(model), off by default, awaiting your consent. Enabling authorises spend."
    }

    // Models, chains, warnings

    static func modelOverriddenByProvider(_ providerTitle: String) -> String {
        "Off because \(providerTitle) is off"
    }
    static let modelPreferenceOnOverridden = "Your preference: on (not effective)"
    static let modelDisabledSelf = "Disabled"
    static let subtitleFallback = "Ordered fallback — one model at a time. Not an ensemble."
    static func chainVendorDefault(_ modelDisplayName: String) -> String {
        "Vendor default — currently \(modelDisplayName)"
    }
    static let chainVendorDefaultNote =
        "Tracks this vendor's current default. It can change without notice."
    static let chainEmptyUsesDefault = "No chain of its own — uses your Default chain."
    static let chainAllIneffective = "Every model in this chain is off or unavailable."
    static let chainExhaustionRefuse =
        "If every model here is unavailable, spawns for this category will fail."
    static let chainExhaustionWiden =
        "If every model here is unavailable, Hive will use your Default chain."
    static let defaultChainTitle = "Default (global fallback)"
    static let defaultChainSubtitle = "Used when a category has no chain of its own."

    // Accessibility

    static func a11yProviderToggle(_ providerTitle: String) -> String {
        "Enable \(providerTitle)"
    }
    static func a11yModelToggle(_ modelDisplayName: String) -> String {
        "Enable \(modelDisplayName)"
    }
    static func a11yModelToggleOverridden(_ model: String, _ providerTitle: String) -> String {
        "\(model), off because \(providerTitle) is off"
    }
    static func a11yMeter(_ windowLabel: String, _ n: Int) -> String {
        "\(windowLabel): \(n) percent used"
    }
    static func a11yMeterUnknown(_ windowLabel: String) -> String {
        "\(windowLabel): usage unknown"
    }
    static func a11yChainRank(_ model: String, _ n: Int, _ total: Int) -> String {
        "\(model), fallback position \(n) of \(total)"
    }

    // Rank labels

    static func rankLabel(_ index: Int) -> String {
        switch index {
        case 0: return "Primary"
        case 1: return "2nd"
        case 2: return "3rd"
        default: return "\(index + 1)th"
        }
    }
}
