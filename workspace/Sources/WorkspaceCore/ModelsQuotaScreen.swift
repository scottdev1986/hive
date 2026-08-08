// ModelsQuotaScreen.swift Holds the model-control wire beside explicit quota evidence rows. These rows preserve why a value is known, stale, unconstrained, estimated, reserved, or excluded instead of collapsing unlike states into one percentage meter.

import Foundation

public struct QuotaEvidenceRow: Codable, Equatable, Sendable {
    public let label: String
    public let state: String
    public let value: Double?
    public let provenance: String
    public let observedAt: String?
    public let resetsAt: String?
    public let reason: String?

    public init(
        label: String,
        state: String,
        value: Double?,
        provenance: String,
        observedAt: String?,
        resetsAt: String?,
        reason: String?
    ) {
        self.label = label
        self.state = state
        self.value = value
        self.provenance = provenance
        self.observedAt = observedAt
        self.resetsAt = resetsAt
        self.reason = reason
    }

    /// Unknown capacity has no numeric reading. This guard is shared by the fixture and live render paths so missing data can never become zero.
    public var displayedValue: String {
        guard state != "unknown" else { return "unknown — no numeric reading" }
        guard let value else { return "not a meter" }
        return "\(Int(value.rounded()))%"
    }
}
