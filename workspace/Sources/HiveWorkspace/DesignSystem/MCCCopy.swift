import Foundation
import WorkspaceCore

/// Quota and usage copy. Do not rephrase in ways that soften "unknown".
enum MCCCopy {
    static let badgeUsageUnknown = "Usage unknown"
    static let badgeUsageStale = "Stale reading"
    static let badgeNearLimit = "Near limit"
    static let badgeCritical = "Critically low"
    static let badgeNotMetered = "Not metered"

    static func meterUsedPct(_ n: Int) -> String { "\(n)% used" }
    static func meterResetsIn(_ relative: String) -> String { "Resets in \(relative)" }
    static let meterUnknownBody = "Hive has no reading for this window"
    static func meterNotMeteredBody(_ windowLabel: String) -> String {
        "Your plan does not meter a \(windowLabel.lowercased()). " +
        "Hive read this account's limits — there is no such window to report."
    }
    static func meterStaleAge(_ relative: String) -> String { "Last read \(relative) ago" }

    static let unmeteredTitle = "No usage meter — always spawnable"
    static func unmeteredBody(_ vendorName: String) -> String {
        "\(vendorName) does not report plan capacity or billing to Hive, so there is no " +
        "meter to show — and no fake 100%. Launches here are never blocked for usage: " +
        "Hive only learns this provider has run out when the vendor itself answers " +
        "with a rate-limit error."
    }

    static func a11yMeter(_ windowLabel: String, _ n: Int) -> String {
        "\(windowLabel): \(n) percent used"
    }
    static func a11yMeterUnknown(_ windowLabel: String) -> String {
        "\(windowLabel): usage unknown"
    }
}
