import Foundation

/// Render types for the daemon-owned Model Control view.

/// One meter window's render state. There is deliberately no way to construct a determinate bar out of a missing reading.
public enum MeterState: Equatable, Sendable {
    case measured(usedPercent: Double, resetsAt: Date?, observedAt: Date?, confidence: String)
    /// The last real percent, aged past freshness. Rendered desaturated with its age — never presented as current.
    case stale(usedPercent: Double, observedAt: Date?, resetsAt: Date?)
    case unknown(reason: String)
    case notMetered
}

public struct MeterWindow: Equatable, Sendable {
    public var label: String
    public var state: MeterState

    public init(label: String, state: MeterState) {
        self.label = label
        self.state = state
    }
}

public enum ProviderUsage: Equatable, Sendable {
    case metered([MeterWindow])
    case silent(reason: String)
    /// The vendor publishes no capacity surface. Deliberate, first-class, never a meter and never an error state.
    case unmetered
    case unknown(reason: String)
}

public enum WireDate {
    public static func parseISO(_ string: String?) -> Date? {
        guard let string else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: string) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: string)
    }
}

/// The three-valued effort axis. `known-none` (the vendor STATED there is no effort axis) and `unknown` (we could not read it) are different facts and must never share a rendering.
public enum EffortAxis: Equatable, Sendable {
    case known(levels: [String], defaultLevel: String?)
    case none
    case unknown(reason: String)

}

/// The visually distinct model-row states, under consent-is-enablement. The override rule is non-negotiable: effectiveEnabled = providerEnabled && modelEnabled && available, and when effective and preference differ the UI shows both. The three OFF reasons never collapse: shipped-off-awaiting- consent is inviting, user-off is neutral, provider-off is an override.
public enum ModelRowState: Equatable, Sendable {
    case enabled
    /// Shipped off because billing coverage could not be verified; flipping it on is the user's consent to spend. Deliberate and inviting — never broken-looking, never second-class.
    case seededOff
    case disabledBySelf
    /// The provider master is off. The stored preference is carried so the UI can say "your preference: on (not effective)" — never a green toggle wearing authority it does not have.
    case disabledByProvider(preferenceOn: Bool)
    case unavailable
}
