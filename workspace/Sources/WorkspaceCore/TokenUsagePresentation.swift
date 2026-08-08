import Foundation

/// The daemon's token headline for the Usage page. Swift renders these values
/// beside the raw cumulative counts; it does not regroup subjects or calculate
/// token semantics itself.
public struct TokenHeadline: Codable, Equatable, Sendable {
    public var newInputTokens: Int?
    /// New input that did NOT also write the cache. Needs the cache-write subset, which not every provider reports; detail, never the headline.
    public var freshInputTokens: Int?
    public var cacheReadTokens: Int?
    /// Input written into the cache for later turns to re-read.
    public var cacheWriteTokens: Int?
    public var outputTokens: Int
    /// The headline: new input + output. Every token this session saw for the first time, and nothing it merely re-read. nil when the provider reports no cache reads.
    public var newTokens: Int?
    public var cumulativeInputTokens: Int
    public var cumulativeTotalTokens: Int
}

public struct TokenUsageRow: Codable, Equatable, Sendable {
    public var name: String
    public var provider: String
    public var model: String?
    public var counts: TokenCounts?
    public var headline: TokenHeadline?
    public var unknownReason: String?
}
