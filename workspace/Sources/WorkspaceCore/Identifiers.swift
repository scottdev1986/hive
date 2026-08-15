import Foundation

public struct PaneID: Hashable, Comparable, Codable, CustomStringConvertible, ExpressibleByStringLiteral {
    public let raw: String
    public init(_ raw: String) { self.raw = raw }
    public init(stringLiteral value: String) { self.raw = value }
    public var description: String { raw }
    public static func < (lhs: PaneID, rhs: PaneID) -> Bool { lhs.raw < rhs.raw }
}

public struct ProjectID: Hashable, Comparable, Codable, Sendable, CustomStringConvertible, ExpressibleByStringLiteral {
    public let raw: String
    public init(_ raw: String) { self.raw = raw }
    public init(stringLiteral value: String) { self.raw = value }
    public var description: String { raw }
    public static func < (lhs: ProjectID, rhs: ProjectID) -> Bool { lhs.raw < rhs.raw }
}

public enum PaneKind: String, Codable {
    case orchestrator
    case agent
}
