// MemoryProjections.swift Mirrors the daemon-owned values used by the four Memory screens. Store state is an enum so an absent store cannot collapse into an empty one, and required nullable fields use explicit decoders so a missing fact is never accepted as a known null.

import Foundation

public enum MemoryProjectionSchemaVersion: Int, Codable, Equatable, Sendable {
    case v1 = 1
}

public enum MemoryStoreState: String, Codable, Equatable, Sendable {
    case absent
    case empty
    case ok
}

public enum MemoryPayloadFreshness: String, Codable, Equatable, Sendable {
    case live
    case cached
}

public enum MemoryScope: String, Codable, CaseIterable, Equatable, Sendable {
    case repo
    case global
}

public enum MemoryProjectScope: String, Codable, Equatable, Sendable {
    case project
}

public enum MemoryArticleKind: String, Codable, Equatable, Sendable {
    case article
    case pitfall
}

public enum MemoryArticleSource: String, Codable, Equatable, Sendable {
    case `init`
    case agent
    case orchestrator
    case user
    case legacy
}

public enum MemoryArticleStatus: String, Codable, CaseIterable, Equatable, Sendable {
    case verified
    case unverified
    case stale
    case conflicted
}

public enum MemoryFactStatus: String, Codable, Equatable, Sendable {
    case current
}

public enum MemoryDigestStatus: String, Codable, Equatable, Sendable {
    case compiled
}

public enum MemoryRawReferenceStatus: String, Codable, Equatable, Sendable {
    case immutable
}

public enum MemoryEmbeddingProvider: String, Codable, Equatable, Sendable {
    case local
    case api
}

public enum MemoryJobState: String, Codable, Equatable, Sendable {
    case running
    case succeeded
    case failed
}

public enum MemoryRecallPurpose: String, Codable, Equatable, Sendable {
    case explicitRecall = "explicit-recall"
    case spawnPreview = "spawn-preview"
    case wakePreview = "wake-preview"
}

public enum MemoryRecallResultClass: String, Codable, Equatable, Sendable {
    case pitfall
    case article
}

public enum MemoryRecallTrigger: String, Codable, Equatable, Sendable {
    case recall
    case note
    case document
}

public enum MemoryRecallTreatment: String, Codable, Equatable, Sendable {
    case literalQuery = "literal-query"
}

public enum MemoryRecallMutation: String, Codable, Equatable, Sendable {
    case none
}

public enum MemoryJobKind: String, Codable, CaseIterable, Equatable, Sendable {
    case reindex
    case retentionSweep = "retention-sweep"
    case consolidationDryRun = "consolidation-dry-run"
    case consolidationApply = "consolidation-apply"

    public var title: String {
        switch self {
        case .reindex: return "Reindex"
        case .retentionSweep: return "Run retention sweep"
        case .consolidationDryRun: return "Preview consolidation"
        case .consolidationApply: return "Apply consolidation"
        }
    }
}

public struct MemoryProjectionMetadata: Codable, Equatable, Sendable {
    public let schemaVersion: MemoryProjectionSchemaVersion
    public let observedAt: String
    public let sourceRevision: String
    public let freshness: MemoryPayloadFreshness

    public init(
        schemaVersion: MemoryProjectionSchemaVersion,
        observedAt: String,
        sourceRevision: String,
        freshness: MemoryPayloadFreshness
    ) {
        self.schemaVersion = schemaVersion
        self.observedAt = observedAt
        self.sourceRevision = sourceRevision
        self.freshness = freshness
    }
}

/// The four provenance fields every memory projection carries on the wire;
/// conforming projections get `metadata` lifted into the standalone value the
/// screens consume.
public protocol MemoryProjectionMetadataSource {
    var schemaVersion: MemoryProjectionSchemaVersion { get }
    var observedAt: String { get }
    var sourceRevision: String { get }
    var freshness: MemoryPayloadFreshness { get }
}

public extension MemoryProjectionMetadataSource {
    var metadata: MemoryProjectionMetadata {
        MemoryProjectionMetadata(
            schemaVersion: schemaVersion, observedAt: observedAt,
            sourceRevision: sourceRevision, freshness: freshness)
    }
}

public struct MemoryConfigProjection: Codable, Equatable, Sendable {
    public let revision: String
    public let eventsHotDays: Int
    public let staleAfterDays: Int
    public let sweepIntervalHours: Double
    public let wakeBudgetTokens: Int
    public let embeddingProvider: MemoryEmbeddingProvider
    public let embeddingModel: String
}

public struct MemoryIndexHealth: Codable, Equatable, Sendable {
    public struct FTS: Codable, Equatable, Sendable {
        public let state: MemoryStoreState
        public let articles: Int
    }

    public struct Vectors: Codable, Equatable, Sendable {
        public let state: MemoryStoreState
        public let articles: Int
        public let facts: Int
        public let provider: MemoryEmbeddingProvider
        public let model: String
        public let runtime: String
    }

    public let fts: FTS
    public let vectors: Vectors
}

public struct MemoryJobProgress: Codable, Equatable, Sendable {
    public let step: String
    public let done: Int
    public let total: Int?

    private enum CodingKeys: String, CodingKey { case step, done, total }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        step = try values.decode(String.self, forKey: .step)
        done = try values.decode(Int.self, forKey: .done)
        total = try values.decodeRequiredNullable(Int.self, forKey: .total)
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(step, forKey: .step)
        try values.encode(done, forKey: .done)
        if let total { try values.encode(total, forKey: .total) }
        else { try values.encodeNil(forKey: .total) }
    }
}

public enum MemoryJobFact: Codable, Equatable, Sendable {
    case integer(Int)
    case number(Double)
    case string(String)

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let integer = try? value.decode(Int.self) {
            self = .integer(integer)
        } else if let number = try? value.decode(Double.self) {
            self = .number(number)
        } else {
            self = .string(try value.decode(String.self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .integer(let integer): try value.encode(integer)
        case .number(let number): try value.encode(number)
        case .string(let string): try value.encode(string)
        }
    }

    public var display: String {
        switch self {
        case .integer(let integer): return String(integer)
        case .number(let number): return String(number)
        case .string(let string): return string
        }
    }
}

public struct MemoryJobReceipt: Codable, Equatable, Sendable {
    public let id: String
    public let kind: MemoryJobKind
    public let state: MemoryJobState
    public let requestedBy: String
    public let startedAt: String
    public let finishedAt: String?
    public let progress: MemoryJobProgress
    public let summary: String
    public let error: String?
    public let readback: [String: MemoryJobFact]?

    private enum CodingKeys: String, CodingKey {
        case id, kind, state, requestedBy, startedAt, finishedAt
        case progress, summary, error, readback
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        kind = try values.decode(MemoryJobKind.self, forKey: .kind)
        state = try values.decode(MemoryJobState.self, forKey: .state)
        requestedBy = try values.decode(String.self, forKey: .requestedBy)
        startedAt = try values.decode(String.self, forKey: .startedAt)
        finishedAt = try values.decodeRequiredNullable(String.self, forKey: .finishedAt)
        progress = try values.decode(MemoryJobProgress.self, forKey: .progress)
        summary = try values.decode(String.self, forKey: .summary)
        error = try values.decodeRequiredNullable(String.self, forKey: .error)
        readback = try values.decodeRequiredNullable(
            [String: MemoryJobFact].self, forKey: .readback)
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(kind, forKey: .kind)
        try values.encode(state, forKey: .state)
        try values.encode(requestedBy, forKey: .requestedBy)
        try values.encode(startedAt, forKey: .startedAt)
        if let finishedAt { try values.encode(finishedAt, forKey: .finishedAt) }
        else { try values.encodeNil(forKey: .finishedAt) }
        try values.encode(progress, forKey: .progress)
        try values.encode(summary, forKey: .summary)
        if let error { try values.encode(error, forKey: .error) }
        else { try values.encodeNil(forKey: .error) }
        if let readback { try values.encode(readback, forKey: .readback) }
        else { try values.encodeNil(forKey: .readback) }
    }
}

public struct MemoryOverviewProjection: Codable, Equatable, Sendable, MemoryProjectionMetadataSource {
    public struct Scope: Codable, Equatable, Sendable {
        public let scope: MemoryScope
        public let state: MemoryStoreState
        public let articles: Int
        public let pitfalls: Int
        public let unverifiedPitfalls: Int
        public let rawObservations: Int
    }

    public struct Wiki: Codable, Equatable, Sendable {
        public let state: MemoryStoreState
        public let articles: Int
        public let pitfalls: Int
        public let unverifiedPitfalls: Int
        public let scopes: [Scope]
    }

    public struct Episodic: Codable, Equatable, Sendable {
        public let state: MemoryStoreState
        public let events: Int
        public let facts: Int
        public let digests: Int
    }

    public struct Gap: Codable, Equatable, Sendable {
        public let code: String
        public let detail: String
    }

    public let schemaVersion: MemoryProjectionSchemaVersion
    public let observedAt: String
    public let sourceRevision: String
    public let freshness: MemoryPayloadFreshness
    public let wiki: Wiki
    public let episodic: Episodic
    public let indexes: MemoryIndexHealth
    public let config: MemoryConfigProjection
    public let lastJobs: [MemoryJobReceipt]
    public let gaps: [Gap]
}

public struct MemoryLibraryArticle: Codable, Equatable, Sendable {
    public let kind: MemoryArticleKind
    public let key: String
    public let scope: MemoryScope
    public let id: String
    public let title: String
    public let topic: String
    public let updated: String
    public let revision: String
    public let source: MemoryArticleSource
    public let status: MemoryArticleStatus
    public let verified: String?
    public let supersedes: [String]
    public let rawRefs: [String]
    public let evidence: String

    private enum CodingKeys: String, CodingKey {
        case kind, key, scope, id, title, topic, updated, revision, source
        case status, verified, supersedes, rawRefs, evidence
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decode(MemoryArticleKind.self, forKey: .kind)
        key = try values.decode(String.self, forKey: .key)
        scope = try values.decode(MemoryScope.self, forKey: .scope)
        id = try values.decode(String.self, forKey: .id)
        title = try values.decode(String.self, forKey: .title)
        topic = try values.decode(String.self, forKey: .topic)
        updated = try values.decode(String.self, forKey: .updated)
        revision = try values.decode(String.self, forKey: .revision)
        source = try values.decode(MemoryArticleSource.self, forKey: .source)
        status = try values.decode(MemoryArticleStatus.self, forKey: .status)
        verified = try values.decodeRequiredNullable(String.self, forKey: .verified)
        supersedes = try values.decode([String].self, forKey: .supersedes)
        rawRefs = try values.decode([String].self, forKey: .rawRefs)
        evidence = try values.decode(String.self, forKey: .evidence)
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(kind, forKey: .kind)
        try values.encode(key, forKey: .key)
        try values.encode(scope, forKey: .scope)
        try values.encode(id, forKey: .id)
        try values.encode(title, forKey: .title)
        try values.encode(topic, forKey: .topic)
        try values.encode(updated, forKey: .updated)
        try values.encode(revision, forKey: .revision)
        try values.encode(source, forKey: .source)
        try values.encode(status, forKey: .status)
        if let verified { try values.encode(verified, forKey: .verified) }
        else { try values.encodeNil(forKey: .verified) }
        try values.encode(supersedes, forKey: .supersedes)
        try values.encode(rawRefs, forKey: .rawRefs)
        try values.encode(evidence, forKey: .evidence)
    }
}

public struct MemoryLibraryFact: Codable, Equatable, Sendable {
    public let kind: String
    public let key: String
    public let scope: MemoryProjectScope
    public let id: String
    public let title: String
    public let topic: String
    public let updated: String
    public let revision: String
    public let source: String
    public let status: MemoryFactStatus
    public let confidence: Double?
    public let validAt: String
    public let invalidAt: String?

    private enum CodingKeys: String, CodingKey {
        case kind, key, scope, id, title, topic, updated, revision, source
        case status, confidence, validAt, invalidAt
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decode(String.self, forKey: .kind)
        key = try values.decode(String.self, forKey: .key)
        scope = try values.decode(MemoryProjectScope.self, forKey: .scope)
        id = try values.decode(String.self, forKey: .id)
        title = try values.decode(String.self, forKey: .title)
        topic = try values.decode(String.self, forKey: .topic)
        updated = try values.decode(String.self, forKey: .updated)
        revision = try values.decode(String.self, forKey: .revision)
        source = try values.decode(String.self, forKey: .source)
        status = try values.decode(MemoryFactStatus.self, forKey: .status)
        confidence = try values.decodeRequiredNullable(Double.self, forKey: .confidence)
        validAt = try values.decode(String.self, forKey: .validAt)
        invalidAt = try values.decodeRequiredNullable(String.self, forKey: .invalidAt)
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(kind, forKey: .kind)
        try values.encode(key, forKey: .key)
        try values.encode(scope, forKey: .scope)
        try values.encode(id, forKey: .id)
        try values.encode(title, forKey: .title)
        try values.encode(topic, forKey: .topic)
        try values.encode(updated, forKey: .updated)
        try values.encode(revision, forKey: .revision)
        try values.encode(source, forKey: .source)
        try values.encode(status, forKey: .status)
        if let confidence { try values.encode(confidence, forKey: .confidence) }
        else { try values.encodeNil(forKey: .confidence) }
        try values.encode(validAt, forKey: .validAt)
        if let invalidAt { try values.encode(invalidAt, forKey: .invalidAt) }
        else { try values.encodeNil(forKey: .invalidAt) }
    }
}

public struct MemoryLibraryDigest: Codable, Equatable, Sendable {
    public let kind: String
    public let key: String
    public let scope: MemoryProjectScope
    public let id: String
    public let title: String
    public let topic: String
    public let updated: String
    public let revision: String
    public let source: String
    public let status: MemoryDigestStatus
    public let agent: String
    public let sessionId: String?

    private enum CodingKeys: String, CodingKey {
        case kind, key, scope, id, title, topic, updated, revision, source
        case status, agent, sessionId
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decode(String.self, forKey: .kind)
        key = try values.decode(String.self, forKey: .key)
        scope = try values.decode(MemoryProjectScope.self, forKey: .scope)
        id = try values.decode(String.self, forKey: .id)
        title = try values.decode(String.self, forKey: .title)
        topic = try values.decode(String.self, forKey: .topic)
        updated = try values.decode(String.self, forKey: .updated)
        revision = try values.decode(String.self, forKey: .revision)
        source = try values.decode(String.self, forKey: .source)
        status = try values.decode(MemoryDigestStatus.self, forKey: .status)
        agent = try values.decode(String.self, forKey: .agent)
        sessionId = try values.decodeRequiredNullable(String.self, forKey: .sessionId)
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(kind, forKey: .kind)
        try values.encode(key, forKey: .key)
        try values.encode(scope, forKey: .scope)
        try values.encode(id, forKey: .id)
        try values.encode(title, forKey: .title)
        try values.encode(topic, forKey: .topic)
        try values.encode(updated, forKey: .updated)
        try values.encode(revision, forKey: .revision)
        try values.encode(source, forKey: .source)
        try values.encode(status, forKey: .status)
        try values.encode(agent, forKey: .agent)
        if let sessionId { try values.encode(sessionId, forKey: .sessionId) }
        else { try values.encodeNil(forKey: .sessionId) }
    }
}

public struct MemoryLibraryRawReference: Codable, Equatable, Sendable {
    public let kind: String
    public let key: String
    public let scope: MemoryScope
    public let id: String
    public let title: String
    public let topic: String
    public let updated: String
    public let revision: String
    public let source: String
    public let status: MemoryRawReferenceStatus
    public let path: String
    public let bytes: Int
}

public enum MemoryLibraryItem: Codable, Equatable, Sendable {
    case article(MemoryLibraryArticle)
    case pitfall(MemoryLibraryArticle)
    case fact(MemoryLibraryFact)
    case digest(MemoryLibraryDigest)
    case rawReference(MemoryLibraryRawReference)

    /// The wire's discriminator, and the one list of row kinds this client has:
    /// the decoder and the library screen's kind filter read the same cases.
    public enum Kind: String, Codable, CaseIterable, Equatable, Sendable {
        case article, pitfall, fact, digest
        case rawReference = "raw-ref"
    }

    private enum CodingKeys: String, CodingKey { case kind }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(Kind.self, forKey: .kind) {
        case .article: self = .article(try MemoryLibraryArticle(from: decoder))
        case .pitfall: self = .pitfall(try MemoryLibraryArticle(from: decoder))
        case .fact: self = .fact(try MemoryLibraryFact(from: decoder))
        case .digest: self = .digest(try MemoryLibraryDigest(from: decoder))
        case .rawReference:
            self = .rawReference(try MemoryLibraryRawReference(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .article(let row), .pitfall(let row): try row.encode(to: encoder)
        case .fact(let row): try row.encode(to: encoder)
        case .digest(let row): try row.encode(to: encoder)
        case .rawReference(let row): try row.encode(to: encoder)
        }
    }

    public var display: (kind: String, id: String, value: String) {
        switch self {
        case .article(let row), .pitfall(let row):
            return (
                row.kind.rawValue,
                row.id,
                "\(row.scope.rawValue) · \(row.status.rawValue) · \(row.title) "
                    + "· source \(row.source.rawValue) "
                    + "· evidence \(row.evidence)")
        case .fact(let row):
            let confidence = row.confidence.map { String($0) } ?? "unknown"
            return (
                row.kind,
                row.id,
                "\(row.scope.rawValue) · \(row.status.rawValue) · \(row.title) "
                    + "· confidence \(confidence) "
                    + "· valid \(row.validAt)")
        case .digest(let row):
            return (
                row.kind,
                row.id,
                "\(row.scope.rawValue) · \(row.status.rawValue) · \(row.title) "
                    + "· agent \(row.agent) "
                    + "· session \(row.sessionId ?? "unknown")")
        case .rawReference(let row):
            return (
                row.kind,
                row.id,
                "\(row.scope.rawValue) · \(row.status.rawValue) · \(row.title) "
                    + "· \(row.path) · \(row.bytes) bytes")
        }
    }
}

public struct MemoryLibraryProjection: Codable, Equatable, Sendable, MemoryProjectionMetadataSource {
    public let schemaVersion: MemoryProjectionSchemaVersion
    public let observedAt: String
    public let sourceRevision: String
    public let freshness: MemoryPayloadFreshness
    public let state: MemoryStoreState
    public let items: [MemoryLibraryItem]
    public let nextCursor: String?
    public let total: Int

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, observedAt, sourceRevision, freshness
        case state, items, nextCursor, total
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try values.decode(
            MemoryProjectionSchemaVersion.self, forKey: .schemaVersion)
        observedAt = try values.decode(String.self, forKey: .observedAt)
        sourceRevision = try values.decode(String.self, forKey: .sourceRevision)
        freshness = try values.decode(MemoryPayloadFreshness.self, forKey: .freshness)
        state = try values.decode(MemoryStoreState.self, forKey: .state)
        items = try values.decode([MemoryLibraryItem].self, forKey: .items)
        nextCursor = try values.decodeRequiredNullable(String.self, forKey: .nextCursor)
        total = try values.decode(Int.self, forKey: .total)
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(schemaVersion, forKey: .schemaVersion)
        try values.encode(observedAt, forKey: .observedAt)
        try values.encode(sourceRevision, forKey: .sourceRevision)
        try values.encode(freshness, forKey: .freshness)
        try values.encode(state, forKey: .state)
        try values.encode(items, forKey: .items)
        if let nextCursor { try values.encode(nextCursor, forKey: .nextCursor) }
        else { try values.encodeNil(forKey: .nextCursor) }
        try values.encode(total, forKey: .total)
    }
}

public struct MemoryRecallPreview: Codable, Equatable, Sendable, MemoryProjectionMetadataSource {
    public struct Partition: Codable, Equatable, Sendable {
        public let `class`: MemoryRecallResultClass
        public let reservedTokens: Int
        public let usedTokens: Int
        public let kept: Int
        public let omitted: Int
    }

    public struct Row: Codable, Equatable, Sendable {
        public let rank: Int
        public let `class`: MemoryRecallResultClass
        public let scope: String
        public let topic: String
        public let id: String
        public let date: String
        public let title: String
        public let snippet: String
        public let status: String
        public let flag: String?
    }

    public struct TriggerPhrase: Codable, Equatable, Sendable {
        public let detected: MemoryRecallTrigger
        public let treatedAs: MemoryRecallTreatment
    }

    public let schemaVersion: MemoryProjectionSchemaVersion
    public let observedAt: String
    public let sourceRevision: String
    public let freshness: MemoryPayloadFreshness
    public let purpose: MemoryRecallPurpose
    public let query: String
    public let state: MemoryStoreState
    public let semantic: String
    public let warning: String?
    public let note: String
    public let budget: Int
    public let tokens: Int
    public let truncated: Bool
    public let omitted: Int
    public let omittedPitfalls: Int
    public let omittedArticles: Int
    public let partitions: [Partition]
    public let rows: [Row]
    public let triggerPhrase: TriggerPhrase?
    public let mutation: MemoryRecallMutation
    public let highWaterAdvanced: Bool

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, observedAt, sourceRevision, freshness
        case purpose, query, state, semantic, warning, note, budget, tokens
        case truncated, omitted, omittedPitfalls, omittedArticles, partitions
        case rows, triggerPhrase, mutation, highWaterAdvanced
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try values.decode(
            MemoryProjectionSchemaVersion.self, forKey: .schemaVersion)
        observedAt = try values.decode(String.self, forKey: .observedAt)
        sourceRevision = try values.decode(String.self, forKey: .sourceRevision)
        freshness = try values.decode(MemoryPayloadFreshness.self, forKey: .freshness)
        purpose = try values.decode(MemoryRecallPurpose.self, forKey: .purpose)
        query = try values.decode(String.self, forKey: .query)
        state = try values.decode(MemoryStoreState.self, forKey: .state)
        semantic = try values.decode(String.self, forKey: .semantic)
        warning = try values.decodeRequiredNullable(String.self, forKey: .warning)
        note = try values.decode(String.self, forKey: .note)
        budget = try values.decode(Int.self, forKey: .budget)
        tokens = try values.decode(Int.self, forKey: .tokens)
        truncated = try values.decode(Bool.self, forKey: .truncated)
        omitted = try values.decode(Int.self, forKey: .omitted)
        omittedPitfalls = try values.decode(Int.self, forKey: .omittedPitfalls)
        omittedArticles = try values.decode(Int.self, forKey: .omittedArticles)
        partitions = try values.decode([Partition].self, forKey: .partitions)
        rows = try values.decode([Row].self, forKey: .rows)
        triggerPhrase = try values.decodeRequiredNullable(
            TriggerPhrase.self, forKey: .triggerPhrase)
        mutation = try values.decode(MemoryRecallMutation.self, forKey: .mutation)
        highWaterAdvanced = try values.decode(Bool.self, forKey: .highWaterAdvanced)
        guard !highWaterAdvanced else {
            throw DecodingError.dataCorruptedError(
                forKey: .highWaterAdvanced,
                in: values,
                debugDescription: "recall preview must not advance the wake high-water")
        }
    }
}

public struct MemoryMaintenanceProjection: Codable, Equatable, Sendable, MemoryProjectionMetadataSource {
    public struct Consolidation: Codable, Equatable, Sendable {
        public let state: MemoryStoreState
        public let candidates: Int
    }

    public struct Jobs: Codable, Equatable, Sendable {
        public let state: MemoryStoreState
        public let recent: [MemoryJobReceipt]
    }

    public let schemaVersion: MemoryProjectionSchemaVersion
    public let observedAt: String
    public let sourceRevision: String
    public let freshness: MemoryPayloadFreshness
    public let config: MemoryConfigProjection
    public let indexes: MemoryIndexHealth
    public let consolidation: Consolidation
    public let jobs: Jobs
}

public struct MemoryRecallRequest: Codable, Equatable, Sendable {
    public let query: String
    public let purpose: MemoryRecallPurpose

    public init(query: String, purpose: MemoryRecallPurpose = .explicitRecall) {
        self.query = query
        self.purpose = purpose
    }
}

public struct MemoryJobRequest: Codable, Equatable, Sendable {
    public let kind: MemoryJobKind

    public init(kind: MemoryJobKind) { self.kind = kind }
}
