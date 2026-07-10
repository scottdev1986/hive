import Foundation

/// One agent as reported by `hive workspace-feed` (NDJSON, one snapshot per
/// line: `{"v":1,"agents":[...]}`). Decoding is deliberately tolerant: only
/// `name` is required, unknown fields are ignored, and unknown status words
/// degrade to a safe default — the feed contract may grow without breaking
/// the app.
public struct AgentSnapshot: Equatable, Decodable {
    public let name: String
    public let tool: String?
    public let model: String?
    public let status: String
    public let taskDescription: String?
    public let tmuxSession: String?
    public let contextPct: Double?
    /// ISO datetime; present means the agent is closed and must not get a pane.
    public let closedAt: String?

    public init(name: String, tool: String? = nil, model: String? = nil,
                status: String = "working", taskDescription: String? = nil,
                tmuxSession: String? = nil, contextPct: Double? = nil,
                closedAt: String? = nil) {
        self.name = name
        self.tool = tool
        self.model = model
        self.status = status
        self.taskDescription = taskDescription
        self.tmuxSession = tmuxSession
        self.contextPct = contextPct
        self.closedAt = closedAt
    }

    private enum CodingKeys: String, CodingKey {
        case name, tool, model, status, taskDescription, tmuxSession, contextPct, closedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        tool = try? container.decodeIfPresent(String.self, forKey: .tool)
        model = try? container.decodeIfPresent(String.self, forKey: .model)
        status = (try? container.decodeIfPresent(String.self, forKey: .status)) ?? "working"
        taskDescription = try? container.decodeIfPresent(String.self, forKey: .taskDescription)
        tmuxSession = try? container.decodeIfPresent(String.self, forKey: .tmuxSession)
        contextPct = try? container.decodeIfPresent(Double.self, forKey: .contextPct)
        closedAt = try? container.decodeIfPresent(String.self, forKey: .closedAt)
    }
}

/// One NDJSON line from the feed: either a snapshot (`agents`) or an error.
public struct FeedLine: Decodable {
    public let v: Int?
    public let agents: [AgentSnapshot]?
    public let error: String?

    /// Parses one line of feed output; returns nil for blank/undecodable lines
    /// (the feed may interleave diagnostics; the app must never crash on them).
    public static func parse(_ line: String) -> FeedLine? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("{"), let data = trimmed.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(FeedLine.self, from: data)
    }
}

/// Maps daemon status words onto the workspace's semantic pane status.
/// The raw word still travels to the pane header via `PaneState.feedStatus`;
/// this mapping only decides border color and attention semantics:
/// - spawning/working/idle → running (steady blue: alive and healthy)
/// - awaiting-approval → waiting(.approval) (amber, attention)
/// - control-paused/stuck → waiting(.userInput) (amber, attention)
/// - done → completed (green until acknowledged)
/// - failed → failed (red + badge until acknowledged)
/// - dead → disconnected (gray dashed)
/// - anything unknown → running (unknown is never rendered as an alarm)
public enum FeedStatusMap {
    public static func paneStatus(for raw: String, acknowledged: Bool = false) -> PaneStatus {
        switch raw {
        case "spawning", "working", "idle":
            return .running
        case "awaiting-approval":
            return .waiting(.approval)
        case "control-paused", "stuck":
            return .waiting(.userInput)
        case "done":
            return .completed(acknowledged: acknowledged)
        case "failed":
            return .failed(acknowledged: acknowledged)
        case "dead":
            return .disconnected(reason: "agent reported dead", lastConfirmed: "dead")
        default:
            return .running
        }
    }

    /// Attention severity for a status word, or nil when it needs none.
    public static func attentionSeverity(for raw: String) -> AttentionSeverity? {
        switch raw {
        case "awaiting-approval", "control-paused", "stuck": return .waiting
        case "done": return .completed
        case "failed": return .failed
        case "dead": return .disconnected
        default: return nil
        }
    }
}

/// How long a closed agent's pane lingers (showing its final status border)
/// before the UI closes it. Gives "done"/"failed" a visible beat instead of
/// vanishing the terminal mid-glance.
public enum PaneCloseGrace {
    public static let seconds: TimeInterval = 2.0
}
