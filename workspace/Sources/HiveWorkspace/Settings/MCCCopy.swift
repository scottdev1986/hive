import Foundation
import WorkspaceCore

/// The Model Control Center copy catalog.
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
    static let warnNoGlobalRoute =
        "You have no Global route. Categories without a route of their own cannot spawn automatically."

    // Badges

    static let badgeUsageUntracked = "Usage limits cannot be tracked for this provider"
    static let badgeUsageUnknown = "Usage unknown"
    static let badgeUsageStale = "Stale reading"
    static let badgeNearLimit = "Near limit"
    static let badgeCritical = "Critically low"
    static let badgePlanLimit = "Plan limit reached"
    static let badgeProviderOff = "Off — Hive will not invoke this CLI"
    static let badgeProviderOffByDefault = "Off by default — enable to allow use"
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
    /// A window the plan does not have — NOT a window Hive failed to read. The
    /// absence is attributed to the PLAN, positively and confidently, because
    /// the probe answered: saying "unknown" here would blame a read that
    /// worked, and saying nothing at all would leave a reader who came looking
    /// for this window unable to tell the two apart.
    static let badgeNotMetered = "Not metered"
    static func meterNotMeteredBody(_ windowLabel: String) -> String {
        "Your plan does not meter a \(windowLabel.lowercased()). " +
        "Hive read this account's limits — there is no such window to report."
    }
    static func meterSilentFeed(_ providerTitle: String) -> String {
        "\(providerTitle) reported no usage data. This surface is experimental and " +
        "sometimes goes quiet — \(providerTitle) itself is still available."
    }
    static func meterStaleAge(_ relative: String) -> String { "Last read \(relative) ago" }

    // Unmetered provider

    static let unmeteredTitle = "No usage meter — always spawnable"
    static func unmeteredBody(_ vendorName: String) -> String {
        "\(vendorName) does not report plan capacity or billing to Hive, so there is no " +
        "meter to show — and no fake 100%. Launches here are never blocked for usage: " +
        "Hive only learns this provider has run out when the vendor itself answers " +
        "with a rate-limit error."
    }

    // Effort

    static let effortNone = "This model has no effort setting."
    static func effortUnknown(_ reason: String) -> String {
        "Effort options unknown — \(reason)"
    }
    static let effortProviderControlled = "Vendor decides (Hive sends no effort flag)"

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

    // Models, routes, warnings

    static func modelOverriddenByProvider(_ providerTitle: String) -> String {
        "Off because \(providerTitle) is off"
    }
    static let modelPreferenceOnOverridden = "Your preference: on (not effective)"
    static let modelDisabledSelf = "Disabled"
    static let routesSubtitle =
        "Each spawn runs on ONE model, picked from the route's candidates. " +
        "Weighted split follows the weights you set; Equal split gives every " +
        "candidate the same share."
    static func modeTitle(_ mode: RouterMode) -> String {
        switch mode {
        case .userWeighted: return "Weighted split"
        case .hiveEqual: return "Equal split"
        }
    }
    static func modeCaption(_ mode: RouterMode) -> String {
        switch mode {
        case .userWeighted:
            return "Hive splits spawns by the weights you set. Weights are ratings, "
                + "not percentages — 3/1/1 and 60/20/20 are the same split."
        case .hiveEqual:
            return "Every candidate gets the same share. Your weights are kept "
                + "and apply again if you switch back."
        }
    }
    static let modeControlLabel = "Split:"
    static let routeUnreadable =
        "This version of Hive cannot read this route — update Hive to see and "
        + "edit it. Your other settings still save normally."
    static let routeEmptyUsesGlobal = "No route of its own — uses your Global route."
    static let routeAllIneffective =
        "Every model in this route is off or unavailable. Spawns routed here "
        + "will fail until one is available."
    static let globalRouteTitle = "Global route"
    static let globalRouteSubtitle = "Used when a category has no route of its own."
    static func expectedShare(_ percent: Int) -> String { "≈\(percent)%" }
    static func expectedShareTooltip(_ percent: Int) -> String {
        "Expected share of this route's spawns: about \(percent)%"
    }
    static func providerShares(_ shares: [(title: String, percent: Int)]) -> String {
        "Per provider: " + shares.map { "\($0.title) ≈\($0.percent)%" }
            .joined(separator: " · ")
    }

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
    static func a11yRouteCandidate(_ model: String, _ sharePercent: Int) -> String {
        "\(model), expected share about \(sharePercent) percent"
    }
    static func a11yWeight(_ model: String) -> String {
        "Weight for \(model)"
    }
}
