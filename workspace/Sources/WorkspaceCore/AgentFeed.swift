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

/// What the orchestrator is doing, as measured by the daemon from the root's own
/// turn-boundary events. The root is not a spawned agent and has no AgentRecord,
/// so it travels beside the `agents` array rather than inside it.
///
/// Its ABSENCE is meaningful and must stay meaningful: the daemon omits this
/// whenever it cannot honestly say (no turn events, or a record that contradicts
/// itself because the root's hooks are not reaching it). Absent is unknown —
/// never a default, and never a flattering guess.
public struct OrchestratorSnapshot: Equatable, Decodable {
    public let status: String

    public init(status: String) {
        self.status = status
    }
}

/// One NDJSON line from the feed: either a snapshot (`agents`, optionally
/// carrying the daemon's live writer-autonomy dial and the root's own status)
/// or an error.
public struct FeedLine: Decodable {
    public let v: Int?
    public let agents: [AgentSnapshot]?
    /// "sandboxed" or "dangerous"; nil when the daemon didn't report it
    /// (older feed, or no autonomy control configured).
    public let autonomy: String?
    /// nil when the daemon reported no trustworthy status for the root.
    public let orchestrator: OrchestratorSnapshot?
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
/// - spawning/working/idle → running (alive and healthy)
/// - awaiting-approval → waiting(.approval) (amber, attention)
/// - control-paused/stuck → waiting(.userInput) (amber, attention)
/// - done → completed (green until acknowledged)
/// - failed → failed (red + badge until acknowledged)
/// - dead → disconnected (gray dashed)
/// - anything unknown → unknown (visible uncertainty, never healthy)
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
            return .unknown
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

/// What an agent is actually doing, as measured by the daemon. Its appearance
/// is the single legend consumed by both the header symbol and status border.
/// `needsUser` is only ever a measured condition: the daemon sets
/// awaiting-approval when a pending approval record exists, and
/// control-paused/stuck when the agent is genuinely blocked on a human. It is
/// never inferred from idleness or elapsed time — an agent that finished and
/// an agent stuck waiting on you are different states.
/// An unrecognized or absent status word is `unknown`, never one of the
/// working/idle/needsUser states.
public enum AgentActivity: Equatable {
    case working
    case idle
    case needsUser
    case spawning
    case done
    case failed
    case disconnected
    case unknown
}

public enum StatusColor: Equatable {
    case green, yellow, orange, blue, purple, red, gray
}

public enum StatusBorder: Equatable {
    case solid, dashed
}

public struct StatusAppearance: Equatable {
    public let color: StatusColor
    public let symbol: String
    public let border: StatusBorder

    public init(color: StatusColor, symbol: String, border: StatusBorder) {
        self.color = color
        self.symbol = symbol
        self.border = border
    }
}

extension AgentActivity {
    public var appearance: StatusAppearance {
        switch self {
        case .working: return StatusAppearance(color: .green, symbol: "circle.fill", border: .solid)
        case .idle: return StatusAppearance(color: .yellow, symbol: "pause.circle.fill", border: .solid)
        case .needsUser: return StatusAppearance(color: .orange, symbol: "hand.raised.fill", border: .solid)
        case .spawning: return StatusAppearance(color: .blue, symbol: "circle.dotted", border: .solid)
        case .done: return StatusAppearance(color: .purple, symbol: "checkmark.circle.fill", border: .solid)
        case .failed: return StatusAppearance(color: .red, symbol: "exclamationmark.circle.fill", border: .solid)
        case .disconnected: return StatusAppearance(color: .gray, symbol: "bolt.horizontal.circle.fill", border: .dashed)
        case .unknown: return StatusAppearance(color: .gray, symbol: "questionmark.circle", border: .dashed)
        }
    }
}

extension AttentionSeverity {
    public var statusColor: StatusColor {
        switch self {
        case .waiting: return .orange
        case .completed: return .purple
        case .failed: return .red
        case .disconnected: return .gray
        }
    }
}

extension FeedStatusMap {
    /// Dot colour source: raw daemon status word → measured activity.
    public static func activity(for raw: String) -> AgentActivity {
        switch raw {
        case "working": return .working
        case "idle": return .idle
        case "awaiting-approval", "control-paused", "stuck": return .needsUser
        case "spawning": return .spawning
        case "done": return .done
        case "failed": return .failed
        case "dead": return .disconnected
        // The feed-lost sentinel "unknown" and any word this app does not
        // recognize must say "no signal", not impersonate a real state.
        default: return .unknown
        }
    }

    /// A lost feed is structurally disconnected even though its raw word is
    /// rewritten to "unknown". Preserve that stronger non-color cue.
    public static func activity(for raw: String, paneStatus: PaneStatus) -> AgentActivity {
        if case .disconnected = paneStatus { return .disconnected }
        return activity(for: raw)
    }
}

/// How long a closed agent's pane lingers (showing its final status border)
/// before the UI closes it. Gives "done"/"failed" a visible beat instead of
/// vanishing the terminal mid-glance.
public enum PaneCloseGrace {
    public static let seconds: TimeInterval = 2.0
}
