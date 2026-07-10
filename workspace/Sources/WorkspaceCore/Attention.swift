import Foundation

/// Severity for attention ordering. Higher raw value sorts first.
public enum AttentionSeverity: Int, Codable, Comparable {
    case completed = 1
    case disconnected = 2
    case waiting = 3
    case failed = 4

    public static func < (lhs: AttentionSeverity, rhs: AttentionSeverity) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

public struct AttentionItem: Equatable, Codable, Identifiable {
    public let id: String
    public let projectID: ProjectID
    public let paneID: PaneID
    public let severity: AttentionSeverity
    public let title: String
    public let detail: String
    /// Monotonic ordering timestamp supplied by the event source (seconds).
    public let raisedAt: TimeInterval

    public init(id: String, projectID: ProjectID, paneID: PaneID,
                severity: AttentionSeverity, title: String, detail: String,
                raisedAt: TimeInterval) {
        self.id = id
        self.projectID = projectID
        self.paneID = paneID
        self.severity = severity
        self.title = title
        self.detail = detail
        self.raisedAt = raisedAt
    }
}

/// The attention queue: ordered by severity, then age (oldest first), then id.
/// Never ordered by pane position. Items are cleared only by explicit
/// resolution commands (acknowledge / approve / open failure) — activating or
/// focusing an item's pane must not remove it.
public struct AttentionQueue: Equatable {
    private(set) var items: [String: AttentionItem] = [:]

    public init() {}

    public var ordered: [AttentionItem] {
        items.values.sorted { a, b in
            if a.severity != b.severity { return a.severity > b.severity }
            if a.raisedAt != b.raisedAt { return a.raisedAt < b.raisedAt }
            return a.id < b.id
        }
    }

    public var isEmpty: Bool { items.isEmpty }
    public var count: Int { items.count }

    public func item(id: String) -> AttentionItem? { items[id] }

    public mutating func raise(_ item: AttentionItem) {
        items[item.id] = item
    }

    /// Explicit resolution — the only way an item leaves the queue.
    public mutating func resolve(id: String) {
        items.removeValue(forKey: id)
    }

    public mutating func resolveAll(paneID: PaneID, projectID: ProjectID) {
        for (key, value) in items where value.paneID == paneID && value.projectID == projectID {
            items.removeValue(forKey: key)
        }
    }
}
