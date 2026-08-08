// ShellScreenProjection.swift The type-erased, render-ready projection one screen of the shell consumes. Screens never see transport or fixture mechanics: the store resolves a typed ClientProjection into this metadata plus the real facts it carried, and the availability panel renders exactly what this value says — including saying "not frozen in this build" when no wire exists yet.

import Foundation

public struct ShellScreenFact: Equatable, Sendable {
    public let label: String
    public let value: String

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }
}

/// Whether the daemon read for this screen is a frozen wire at all. A screen without one is absent by design, and the panel must say so rather than render a guessed layout.
public enum ShellScreenContract: Equatable, Sendable {
    case frozen
    case notFrozen(reason: String)
}

public struct ShellScreenProjection: Equatable, Sendable {
    public let availability: ProjectionAvailability
    public let freshness: ProjectionFreshness
    public let source: ProjectionSource
    public let observedAt: String?
    public let evidence: ProjectionEvidence?
    public let contract: ShellScreenContract
    public let facts: [ShellScreenFact]

    public init(
        availability: ProjectionAvailability,
        freshness: ProjectionFreshness,
        source: ProjectionSource,
        observedAt: String?,
        evidence: ProjectionEvidence?,
        contract: ShellScreenContract,
        facts: [ShellScreenFact]
    ) {
        self.availability = availability
        self.freshness = freshness
        self.source = source
        self.observedAt = observedAt
        self.evidence = evidence
        self.contract = contract
        self.facts = facts
    }

    public static func notFrozen(_ reason: String) -> ShellScreenProjection {
        ShellScreenProjection(
            availability: .unknown,
            freshness: .unknown,
            source: ProjectionSource(),
            observedAt: nil,
            evidence: nil,
            contract: .notFrozen(reason: reason),
            facts: [])
    }
}

extension ClientProjection {
    /// A read that produced no value, rendered as exactly what it was. The projection already carries the honest classification; this only moves it onto the screen, frozen, with the facts the caller measured.
    public func frozenScreen(facts: [ShellScreenFact] = []) -> ShellScreenProjection {
        ShellScreenProjection(
            availability: availability,
            freshness: freshness,
            source: source,
            observedAt: observedAt,
            evidence: evidence,
            contract: .frozen,
            facts: facts)
    }
}

/// One banner row above the content area. States are never color alone: the severity picks the tint AND the panel always carries the words.
public struct ShellBanner: Equatable, Sendable {
    public enum Severity: String, Equatable, Sendable {
        case info
        case warning
        case critical
    }

    public let severity: Severity
    public let text: String

    public init(severity: Severity, text: String) {
        self.severity = severity
        self.text = text
    }
}

extension ShellScreenProjection {
    public var banner: ShellBanner? {
        if case .protocolDrift(let reason) = evidence {
            return ShellBanner(
                severity: .critical,
                text: "The daemon answered with a protocol this build cannot read (\(reason)). No state is shown.")
        }
        if case .refused(let statusCode) = evidence {
            return ShellBanner(
                severity: .warning,
                text: "The daemon refused this read (HTTP \(statusCode)). No state is shown.")
        }
        switch availability {
        case .current, .unknown:
            return nil
        case .stale:
            return ShellBanner(
                severity: .info,
                text: "Projection is stale. Values keep their observed "
                    + "timestamps; mutations require a fresh read first.")
        case .disconnected:
            let lostAt = evidence?.transportLostAt ?? "an unknown time"
            return ShellBanner(
                severity: .warning,
                text: "Daemon disconnected at \(lostAt). Showing the last "
                    + "observed state; nothing here is live.")
        case .unauthorized:
            let code = evidence?.refusalCode ?? "unspecified"
            return ShellBanner(
                severity: .critical,
                text: "The daemon refused this read (\(code)). "
                    + "No state is shown.")
        case .conflicting:
            let competing = evidence?.competingRevision ?? "unknown"
            let shown = source.revision ?? "unknown"
            return ShellBanner(
                severity: .warning,
                text: "A competing revision (\(competing)) exists for this "
                    + "projection. Showing revision \(shown) as observed.")
        case .replaced:
            let successor = evidence?.supersedingDescription ?? "a newer source"
            return ShellBanner(
                severity: .info,
                text: "This view was superseded by \(successor). "
                    + "The shown state is no longer the latest.")
        }
    }

    /// The one-line headline naming the state, and the plain-language explanation of what the screen can and cannot show — the honest empty state: it says what is absent and why.
    public var stateHeadline: String {
        if case .protocolDrift = evidence { return "Protocol mismatch" }
        if case .refused = evidence { return "Refused" }
        switch availability {
        case .current: return "Observed"
        case .unknown: return "Unknown"
        case .stale: return "Stale"
        case .disconnected: return "Disconnected"
        case .unauthorized: return "Unauthorized"
        case .conflicting: return "Conflicting"
        case .replaced: return "Replaced"
        }
    }

    public var stateExplanation: String {
        if case .notFrozen(let reason) = contract {
            return reason
        }
        if case .protocolDrift = evidence {
            return "The daemon answered, but this build cannot safely read that protocol. No transport loss is claimed."
        }
        if case .refused = evidence {
            return "The daemon answered but refused this read. No transport loss is claimed."
        }
        switch availability {
        case .current:
            return "The daemon projection for this screen is current. "
                + "The full screen content ships with its own phase; the "
                + "measured facts below come from the live wire."
        case .unknown:
            return "No observation has reached this build, so there is "
                + "nothing to show. Nothing is inferred."
        case .stale:
            return "The last observed state is shown with its own timestamp. "
                + "It is not refreshed and must not be read as live."
        case .disconnected:
            return "The daemon connection is down. The last observed state "
                + "stays visible and is marked as such."
        case .unauthorized:
            return "The daemon refused to serve this projection. "
                + "No state is rendered in place of an answer."
        case .conflicting:
            return "Two revisions of this projection claim to be current. "
                + "The observed one is shown and the conflict is named."
        case .replaced:
            return "A newer source has replaced this projection. "
                + "The superseded state remains visible until a refresh lands."
        }
    }
}

extension ProjectionEvidence {
    var transportLostAt: String? {
        if case .disconnected(let value) = self { return value }
        return nil
    }

    var refusalCode: String? {
        if case .unauthorized(let value) = self { return value }
        return nil
    }

    var competingRevision: String? {
        if case .conflicting(let value) = self { return value }
        return nil
    }

    var supersedingDescription: String? {
        guard case .replaced(let source) = self else { return nil }
        switch (source.revision, source.generation) {
        case let (revision?, generation?):
            return "revision \(revision) (generation \(generation))"
        case let (revision?, nil):
            return "revision \(revision)"
        case let (nil, generation?):
            return "generation \(generation)"
        case (nil, nil):
            return nil
        }
    }
}
