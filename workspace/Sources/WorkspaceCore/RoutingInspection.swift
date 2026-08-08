
import Foundation

public struct RouteInspection: Codable, Equatable, Sendable {
    public struct Candidate: Codable, Equatable, Sendable {
        public let candidate: RoutingPolicyDocument.WireRouteCandidate
        public let effectiveWeight: Double
        public let configuredShare: Double
        public let liveShare: Double
        public let eligible: Bool
        public let effectiveEffort: String?
        public let refusal: CandidateRefusal?

        private enum CodingKeys: String, CodingKey {
            case candidate
            case effectiveWeight
            case configuredShare
            case liveShare
            case eligible
            case effectiveEffort
            case refusal
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            candidate = try container.decode(
                RoutingPolicyDocument.WireRouteCandidate.self,
                forKey: .candidate)
            effectiveWeight = try container.decode(
                Double.self,
                forKey: .effectiveWeight)
            configuredShare = try container.decode(
                Double.self,
                forKey: .configuredShare)
            liveShare = try container.decode(Double.self, forKey: .liveShare)
            eligible = try container.decode(Bool.self, forKey: .eligible)
            effectiveEffort = try container.decodeRequiredNullable(
                String.self,
                forKey: .effectiveEffort)
            refusal = try container.decodeRequiredNullable(
                CandidateRefusal.self,
                forKey: .refusal)
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(candidate, forKey: .candidate)
            try container.encode(effectiveWeight, forKey: .effectiveWeight)
            try container.encode(configuredShare, forKey: .configuredShare)
            try container.encode(liveShare, forKey: .liveShare)
            try container.encode(eligible, forKey: .eligible)
            if let effectiveEffort {
                try container.encode(effectiveEffort, forKey: .effectiveEffort)
            } else {
                try container.encodeNil(forKey: .effectiveEffort)
            }
            if let refusal {
                try container.encode(refusal, forKey: .refusal)
            } else {
                try container.encodeNil(forKey: .refusal)
            }
        }
    }

    public struct CandidateRefusal: Codable, Equatable, Sendable {
        public let gate: String
        public let detail: String
        public let retryAt: String?

        private enum CodingKeys: String, CodingKey {
            case gate
            case detail
            case retryAt
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            gate = try container.decode(String.self, forKey: .gate)
            detail = try container.decode(String.self, forKey: .detail)
            retryAt = try container.decodeRequiredNullable(
                String.self,
                forKey: .retryAt)
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(gate, forKey: .gate)
            try container.encode(detail, forKey: .detail)
            if let retryAt {
                try container.encode(retryAt, forKey: .retryAt)
            } else {
                try container.encodeNil(forKey: .retryAt)
            }
        }
    }

    public enum Refusal: Codable, Equatable, Sendable {
        case neverConfigured(detail: String)
        case noCandidate(detail: String)

        private enum Kind: String, Codable {
            case neverConfigured = "never-configured"
            case noCandidate = "no-candidate"
        }

        private enum CodingKeys: String, CodingKey {
            case kind
            case detail
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let detail = try container.decode(String.self, forKey: .detail)
            switch try container.decode(Kind.self, forKey: .kind) {
            case .neverConfigured:
                self = .neverConfigured(detail: detail)
            case .noCandidate:
                self = .noCandidate(detail: detail)
            }
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .neverConfigured(let detail):
                try container.encode(Kind.neverConfigured, forKey: .kind)
                try container.encode(detail, forKey: .detail)
            case .noCandidate(let detail):
                try container.encode(Kind.noCandidate, forKey: .kind)
                try container.encode(detail, forKey: .detail)
            }
        }
    }

    public struct BalanceEntry: Codable, Equatable, Sendable {
        public let provider: String
        public let model: String
        public let current: Double

    }

    public let schemaVersion: Int
    public let category: String
    public let policyRevision: Int
    public let scope: String?
    public let mode: String?
    public let routeDigest: String?
    public let candidates: [Candidate]
    public let refusal: Refusal?
    public let balance: [BalanceEntry]
    public let inspectedAt: String

    public init(
        schemaVersion: Int = 1,
        category: String,
        policyRevision: Int,
        scope: String?,
        mode: String?,
        routeDigest: String?,
        candidates: [Candidate],
        refusal: Refusal?,
        balance: [BalanceEntry],
        inspectedAt: String
    ) {
        self.schemaVersion = schemaVersion
        self.category = category
        self.policyRevision = policyRevision
        self.scope = scope
        self.mode = mode
        self.routeDigest = routeDigest
        self.candidates = candidates
        self.refusal = refusal
        self.balance = balance
        self.inspectedAt = inspectedAt
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case category
        case policyRevision
        case scope
        case mode
        case routeDigest
        case candidates
        case refusal
        case balance
        case inspectedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        guard schemaVersion == 1 else {
            throw DecodingError.dataCorruptedError(
                forKey: .schemaVersion,
                in: container,
                debugDescription: "unsupported route inspection schemaVersion \(schemaVersion)")
        }
        category = try container.decode(String.self, forKey: .category)
        policyRevision = try container.decode(Int.self, forKey: .policyRevision)
        scope = try container.decodeRequiredNullable(
            String.self,
            forKey: .scope)
        mode = try container.decodeRequiredNullable(
            String.self,
            forKey: .mode)
        routeDigest = try container.decodeRequiredNullable(
            String.self,
            forKey: .routeDigest)
        candidates = try container.decode([Candidate].self, forKey: .candidates)
        refusal = try container.decodeRequiredNullable(
            Refusal.self,
            forKey: .refusal)
        balance = try container.decode([BalanceEntry].self, forKey: .balance)
        inspectedAt = try container.decode(String.self, forKey: .inspectedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(category, forKey: .category)
        try container.encode(policyRevision, forKey: .policyRevision)
        if let scope {
            try container.encode(scope, forKey: .scope)
        } else {
            try container.encodeNil(forKey: .scope)
        }
        if let mode {
            try container.encode(mode, forKey: .mode)
        } else {
            try container.encodeNil(forKey: .mode)
        }
        if let routeDigest {
            try container.encode(routeDigest, forKey: .routeDigest)
        } else {
            try container.encodeNil(forKey: .routeDigest)
        }
        try container.encode(candidates, forKey: .candidates)
        if let refusal {
            try container.encode(refusal, forKey: .refusal)
        } else {
            try container.encodeNil(forKey: .refusal)
        }
        try container.encode(balance, forKey: .balance)
        try container.encode(inspectedAt, forKey: .inspectedAt)
    }
}
