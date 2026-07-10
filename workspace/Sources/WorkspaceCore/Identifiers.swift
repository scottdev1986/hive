import Foundation

/// Stable identity of a pane inside one project workspace.
/// String-backed so fixtures and tests read naturally ("orchestrator", "indexer").
public struct PaneID: Hashable, Comparable, Codable, CustomStringConvertible, ExpressibleByStringLiteral {
    public let raw: String
    public init(_ raw: String) { self.raw = raw }
    public init(stringLiteral value: String) { self.raw = value }
    public var description: String { raw }
    public static func < (lhs: PaneID, rhs: PaneID) -> Bool { lhs.raw < rhs.raw }
}

/// Stable identity of a project (tenant) multiplexed by the one Workspace process.
public struct ProjectID: Hashable, Comparable, Codable, CustomStringConvertible, ExpressibleByStringLiteral {
    public let raw: String
    public init(_ raw: String) { self.raw = raw }
    public init(stringLiteral value: String) { self.raw = value }
    public var description: String { raw }
    public static func < (lhs: ProjectID, rhs: ProjectID) -> Bool { lhs.raw < rhs.raw }
}

public enum PaneKind: String, Codable {
    case orchestrator
    case worker
    case shell // placeholder until the SwiftTerm phase; participates in layout only
}
