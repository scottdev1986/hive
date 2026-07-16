import Foundation

public struct LaunchIdentitySnapshot: Equatable, Decodable {
    public let model: String
    public let effort: String?

    public init(model: String, effort: String? = nil) {
        self.model = model
        self.effort = effort
    }
}

public struct ObservedIdentitySnapshot: Equatable, Decodable {
    public let model: String
    public let effort: String?

    public init(model: String, effort: String? = nil) {
        self.model = model
        self.effort = effort
    }
}

/// One agent as reported by `hive workspace-feed` (NDJSON, one snapshot per
/// line: `{"v":1,"agents":[...]}`). Decoding is deliberately tolerant: only
/// exact `id` plus `name` are required, unknown fields are ignored, and an
/// absent or unreadable status stays `unknown` — the feed contract may grow
/// without making an agent look healthy without evidence.
public struct AgentSnapshot: Equatable, Decodable {
    public let id: String
    public let name: String
    public let tool: String?
    public let model: String?
    public let liveModel: String?
    public let liveEffort: String?
    public let executionIdentity: LaunchIdentitySnapshot?
    public let observedIdentity: ObservedIdentitySnapshot?
    public let identityState: String
    public let status: String
    public let taskDescription: String?
    public let tmuxSession: String?
    public let toolSessionID: String?
    public let processIncarnation: Int?
    public let contextPct: Double?
    /// Nil means the wire did not answer. It must fail closed for authoring.
    public let writeRevoked: Bool?
    /// ISO datetime; present means the agent is closed and must not get a pane.
    public let closedAt: String?

    public init(id: String, name: String, tool: String? = nil, model: String? = nil,
                liveModel: String? = nil, liveEffort: String? = nil,
                executionIdentity: LaunchIdentitySnapshot? = nil,
                observedIdentity: ObservedIdentitySnapshot? = nil,
                identityState: String = "unattested",
                status: String = "working", taskDescription: String? = nil,
                tmuxSession: String? = nil, toolSessionID: String? = nil,
                processIncarnation: Int? = nil, contextPct: Double? = nil,
                writeRevoked: Bool? = false,
                closedAt: String? = nil) {
        self.id = id
        self.name = name
        self.tool = tool
        self.model = model
        self.liveModel = liveModel
        self.liveEffort = liveEffort
        self.executionIdentity = executionIdentity
        self.observedIdentity = observedIdentity
        self.identityState = Self.normalizedIdentityState(identityState)
        self.status = status
        self.taskDescription = taskDescription
        self.tmuxSession = tmuxSession
        self.toolSessionID = toolSessionID
        self.processIncarnation = processIncarnation
        self.contextPct = contextPct
        self.writeRevoked = writeRevoked
        self.closedAt = closedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, tool, model, liveModel, liveEffort, executionIdentity
        case observedIdentity, identityState, status, taskDescription, tmuxSession
        case toolSessionID = "toolSessionId"
        case processIncarnation, contextPct, writeRevoked, closedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        tool = try? container.decodeIfPresent(String.self, forKey: .tool)
        model = try? container.decodeIfPresent(String.self, forKey: .model)
        liveModel = try? container.decodeIfPresent(String.self, forKey: .liveModel)
        liveEffort = try? container.decodeIfPresent(String.self, forKey: .liveEffort)
        executionIdentity = try? container.decodeIfPresent(
            LaunchIdentitySnapshot.self, forKey: .executionIdentity)
        observedIdentity = try? container.decodeIfPresent(
            ObservedIdentitySnapshot.self, forKey: .observedIdentity)
        let reportedIdentityState =
            (try? container.decodeIfPresent(String.self, forKey: .identityState)) ?? nil
        identityState = Self.normalizedIdentityState(reportedIdentityState ?? "unattested")
        status = (try? container.decodeIfPresent(String.self, forKey: .status)) ?? "unknown"
        taskDescription = try? container.decodeIfPresent(String.self, forKey: .taskDescription)
        tmuxSession = try? container.decodeIfPresent(String.self, forKey: .tmuxSession)
        toolSessionID = try? container.decodeIfPresent(String.self, forKey: .toolSessionID)
        processIncarnation = try? container.decodeIfPresent(Int.self, forKey: .processIncarnation)
        contextPct = try? container.decodeIfPresent(Double.self, forKey: .contextPct)
        writeRevoked = try? container.decodeIfPresent(Bool.self, forKey: .writeRevoked)
        closedAt = try? container.decodeIfPresent(String.self, forKey: .closedAt)
    }

    public var launchModel: String? { executionIdentity?.model ?? model }
    public var launchEffort: String? { executionIdentity?.effort }
    public var observedModel: String? { observedIdentity?.model ?? liveModel }
    public var observedEffort: String? {
        observedIdentity == nil ? liveEffort : observedIdentity?.effort
    }

    /// The exact tmux child this pane may view. Deliberately does NOT require
    /// `toolSessionID`: that is provider conversation identity, and the Codex
    /// path never binds it, so gating here would leave Codex panes permanently
    /// closed. Identity/authority states render in the header as information;
    /// they never gate the human's keyboard (a pane the user can see but not
    /// type into is a bug, not a safety posture — landing/mutation authority
    /// is enforced daemon-side, not at the keyboard).
    public func attachmentIdentity(
        in workspace: WorkspaceInstanceIdentity
    ) -> PaneAttachmentIdentity? {
        guard !id.isEmpty, !workspace.instanceID.isEmpty,
              !workspace.instanceHome.isEmpty, workspace.daemonPort > 0,
              !workspace.tmuxSocket.isEmpty,
              let processIncarnation, processIncarnation > 0,
              let tmuxSession, !tmuxSession.isEmpty else { return nil }
        return PaneAttachmentIdentity(
            workspace: workspace, agentID: id,
            processIncarnation: processIncarnation,
            tmuxSession: tmuxSession)
    }

    private static func normalizedIdentityState(_ value: String) -> String {
        ["unattested", "matching", "drift", "unknown"].contains(value)
            ? value : "unknown"
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
/// carrying the daemon's live agent-autonomy dial and the root's own status)
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

    private enum CodingKeys: String, CodingKey {
        case v, agents, autonomy, orchestrator, error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        v = (try? container.decodeIfPresent(Int.self, forKey: .v)) ?? nil
        if let decodedAgents = try? container.decodeIfPresent(
            [LossyAgentSnapshot].self, forKey: .agents)
        {
            let validAgents = decodedAgents.compactMap(\.value)
            agents = validAgents.count == decodedAgents.count ? validAgents : nil
        } else {
            agents = nil
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

private struct LossyAgentSnapshot: Decodable {
    let value: AgentSnapshot?

    init(from decoder: Decoder) throws {
        value = try? AgentSnapshot(from: decoder)
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
