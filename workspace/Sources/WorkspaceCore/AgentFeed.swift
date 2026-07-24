import Foundation

public struct AgentSessionSubject: Equatable, Codable {
    public let kind: String
    public let agentId: String?

    public init(kind: String, agentId: String? = nil) {
        self.kind = kind
        self.agentId = agentId
    }
}

public struct AgentSessionLocator: Equatable, Codable {
    public let schemaVersion: Int
    public let instanceId: String
    public let subject: AgentSessionSubject
    public let generation: Int
    public let sessionId: String
    public let hostKind: String
    public let engineBuildId: String?

    public init(schemaVersion: Int = 1, instanceId: String,
                subject: AgentSessionSubject, generation: Int,
                sessionId: String, hostKind: String,
                engineBuildId: String?) {
        self.schemaVersion = schemaVersion
        self.instanceId = instanceId
        self.subject = subject
        self.generation = generation
        self.sessionId = sessionId
        self.hostKind = hostKind
        self.engineBuildId = engineBuildId
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, instanceId, subject, generation, sessionId, hostKind
        case engineBuildId
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(instanceId, forKey: .instanceId)
        try container.encode(subject, forKey: .subject)
        try container.encode(generation, forKey: .generation)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(hostKind, forKey: .hostKind)
        if let engineBuildId {
            try container.encode(engineBuildId, forKey: .engineBuildId)
        } else {
            try container.encodeNil(forKey: .engineBuildId)
        }
    }
}

/// One agent as reported by `hive workspace-feed` (NDJSON, one snapshot per
/// line: `{"v":1,"agents":[...]}`). Decoding is deliberately tolerant: only
/// `name` is required, unknown fields are ignored, and an absent or unreadable
/// status stays `unknown` — the feed contract may grow without making an agent
/// look healthy without evidence.
public struct AgentSnapshot: Equatable, Decodable {
    public let id: String?
    public let name: String
    public let tool: String?
    public let model: String?
    public let status: String
    public let taskDescription: String?
    public let contextPct: Double?
    /// ISO datetime; present means the agent is closed and must not get a pane.
    public let closedAt: String?
    public let sessionLocator: AgentSessionLocator?

    public init(id: String? = nil, name: String, tool: String? = nil, model: String? = nil,
                status: String = "working", taskDescription: String? = nil,
                contextPct: Double? = nil,
                closedAt: String? = nil, sessionLocator: AgentSessionLocator? = nil) {
        self.id = id
        self.name = name
        self.tool = tool
        self.model = model
        self.status = status
        self.taskDescription = taskDescription
        self.contextPct = contextPct
        self.closedAt = closedAt
        self.sessionLocator = sessionLocator
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, tool, model, status, taskDescription, contextPct
        case closedAt, sessionLocator
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try? container.decodeIfPresent(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        tool = try? container.decodeIfPresent(String.self, forKey: .tool)
        model = try? container.decodeIfPresent(String.self, forKey: .model)
        status = (try? container.decodeIfPresent(String.self, forKey: .status)) ?? "unknown"
        taskDescription = try? container.decodeIfPresent(String.self, forKey: .taskDescription)
        contextPct = try? container.decodeIfPresent(Double.self, forKey: .contextPct)
        closedAt = try? container.decodeIfPresent(String.self, forKey: .closedAt)
        sessionLocator = try container.decodeIfPresent(
            AgentSessionLocator.self, forKey: .sessionLocator)
    }
}

public enum WorkspaceTerminalVisibilityState: String, Equatable, Codable {
    case pending, attaching, live, reconnecting, closing, exited, failed
}

public struct WorkspaceTerminalGeometry: Equatable, Encodable {
    public let columns: Int
    public let rows: Int
    public let widthPx: Int
    public let heightPx: Int
    public let cellWidthPx: Double
    public let cellHeightPx: Double

    public init(columns: Int, rows: Int, widthPx: Int, heightPx: Int,
                cellWidthPx: Double, cellHeightPx: Double) {
        self.columns = columns
        self.rows = rows
        self.widthPx = widthPx
        self.heightPx = heightPx
        self.cellWidthPx = cellWidthPx
        self.cellHeightPx = cellHeightPx
    }
}

public struct WorkspaceVisibleTerminal: Equatable, Encodable {
    public let agentId: String
    public let agentName: String
    public let locator: AgentSessionLocator
    public let state: WorkspaceTerminalVisibilityState
    public let geometry: WorkspaceTerminalGeometry?

    public init(agentId: String, agentName: String, locator: AgentSessionLocator,
                state: WorkspaceTerminalVisibilityState,
                geometry: WorkspaceTerminalGeometry? = nil) {
        self.agentId = agentId
        self.agentName = agentName
        self.locator = locator
        self.state = state
        self.geometry = geometry
    }
}

public struct WorkspaceVisibilityInventory: Equatable, Encodable {
    public let schemaVersion = 1
    public let inventoryRevision: String
    public let terminals: [WorkspaceVisibleTerminal]

    public init(inventoryRevision: String, terminals: [WorkspaceVisibleTerminal]) {
        self.inventoryRevision = inventoryRevision
        self.terminals = terminals
    }
}

/// What the orchestrator is doing, as measured by the daemon from the root's own
/// turn-boundary events. The root is not a spawned agent and has no AgentRecord,
/// so it travels beside the `agents` array rather than inside it.
///
/// A nil `status` is meaningful and must stay meaningful: no turn events, or a
/// contradictory record, is unknown rather than a fabricated idle word. The
/// object may still carry an independently measured sessiond host locator.
public struct OrchestratorSnapshot: Equatable, Decodable {
    public let status: String?
    public let host: String?
    public let hostState: String?
    public let hostDiagnostic: String?
    public let sessionLocator: AgentSessionLocator?

    public init(status: String?, host: String? = nil, hostState: String? = nil,
                hostDiagnostic: String? = nil,
                sessionLocator: AgentSessionLocator? = nil) {
        self.status = status
        self.host = host
        self.hostState = hostState
        self.hostDiagnostic = hostDiagnostic
        self.sessionLocator = sessionLocator
    }
}

/// One NDJSON line from the feed: either a snapshot (`agents`, optionally
/// carrying the daemon's live agent-autonomy dial and the root's own status)
/// or an error.
public struct FeedLine: Decodable {
    public let v: Int?
    public let agents: [AgentSnapshot]?
    /// "sandboxed" or "dangerous"; nil when the daemon didn't report it
    /// (older feed, or no autonomy control configured).
    public let autonomy: String?
    /// nil only when neither trustworthy turn status nor root host exists.
    public let orchestrator: OrchestratorSnapshot?
    public let error: String?

    private enum CodingKeys: String, CodingKey {
        case v, agents, autonomy, orchestrator, error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        v = (try? container.decodeIfPresent(Int.self, forKey: .v)) ?? nil
        do {
            agents = try container.decodeIfPresent([AgentSnapshot].self, forKey: .agents)
        } catch {
            agents = nil
            self.error = "workspace-feed agent schema error: \(error)"
            autonomy = nil
            orchestrator = nil
            return
        }
        let reportedAutonomy =
            (try? container.decodeIfPresent(String.self, forKey: .autonomy)) ?? nil
        autonomy = reportedAutonomy.flatMap {
            ["sandboxed", "dangerous"].contains($0) ? $0 : nil
        }
        orchestrator = (try? container.decodeIfPresent(
            OrchestratorSnapshot.self, forKey: .orchestrator)) ?? nil
        error = (try? container.decodeIfPresent(String.self, forKey: .error)) ?? nil
    }

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
/// - dead/exited → disconnected (gray dashed)
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
        case "dead", "exited":
            return .disconnected(reason: "process reported \(raw)", lastConfirmed: raw)
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
        case "dead", "exited": return .disconnected
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
        case "dead", "exited": return .disconnected
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
