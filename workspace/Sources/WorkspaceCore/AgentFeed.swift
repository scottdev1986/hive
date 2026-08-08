import Foundation
import HiveTerminalKit

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

public struct FeedPanePresentation: Equatable, Decodable {
    public let kind: String
    public let waitingKind: String?
    public let reason: String?
    public let lastConfirmed: String?

    public init(
        kind: String,
        waitingKind: String? = nil,
        reason: String? = nil,
        lastConfirmed: String? = nil
    ) {
        self.kind = kind
        self.waitingKind = waitingKind
        self.reason = reason
        self.lastConfirmed = lastConfirmed
    }

    public func paneStatus(acknowledged: Bool = false) -> PaneStatus {
        switch kind {
        case "running": return .running
        case "waiting":
            return .waiting(waitingKind == "approval" ? .approval : .userInput)
        case "completed": return .completed(acknowledged: acknowledged)
        case "failed": return .failed(acknowledged: acknowledged)
        case "disconnected":
            return .disconnected(
                reason: reason ?? "daemon reported disconnected",
                lastConfirmed: lastConfirmed ?? "unknown")
        default: return .unknown
        }
    }
}

public struct FeedAttentionPresentation: Equatable, Decodable {
    public let id: String
    public let severity: String
    public let title: String
    public let detail: String
    public let raisedAt: TimeInterval

    public var renderedSeverity: AttentionSeverity? {
        switch severity {
        case "waiting": return .waiting
        case "completed": return .completed
        case "failed": return .failed
        case "disconnected": return .disconnected
        default: return nil
        }
    }
}

public struct AgentFeedPresentation: Equatable, Decodable {
    public let panePresence: String
    public let terminalState: String
    public let headerDetail: String
    public let paneStatus: FeedPanePresentation
    public let activity: String
    public let attention: FeedAttentionPresentation?

    public init(
        panePresence: String,
        terminalState: String,
        headerDetail: String,
        paneStatus: FeedPanePresentation,
        activity: String,
        attention: FeedAttentionPresentation? = nil
    ) {
        self.panePresence = panePresence
        self.terminalState = terminalState
        self.headerDetail = headerDetail
        self.paneStatus = paneStatus
        self.activity = activity
        self.attention = attention
    }

    public var renderedActivity: AgentActivity {
        switch activity {
        case "working": return .working
        case "idle": return .idle
        case "needs-user": return .needsUser
        case "held": return .held
        case "spawning": return .spawning
        case "done": return .done
        case "failed": return .failed
        case "disconnected": return .disconnected
        default: return .unknown
        }
    }

    public var renderedTerminalState: WorkspaceTerminalVisibilityState? {
        WorkspaceTerminalVisibilityState(rawValue: terminalState)
    }

    public var shouldDisplayPane: Bool {
        panePresence == "visible"
    }

    public static let unknown = AgentFeedPresentation(
        // Membership in the daemon's live `agents` array is enough to retain a
        // pane, but carries no status or terminal-lifecycle claim.
        panePresence: "visible",
        terminalState: "unknown",
        headerDetail: "unknown",
        paneStatus: FeedPanePresentation(kind: "unknown"),
        activity: "unknown")
}

/// One agent as reported by `hive workspace-feed` (NDJSON, one snapshot per line: `{"v":1,"agents":[...]}`). Decoding is deliberately tolerant: only `name` is required, unknown fields are ignored, and an absent or unreadable status stays `unknown` — the feed contract may grow without making an agent look healthy without evidence.
public struct AgentSnapshot: Equatable, Decodable {
    public let id: String?
    public let name: String
    public let tool: String?
    public let model: String?
    public let status: String
    public let taskDescription: String?
    public let contextPct: Double?
    public let statusDimensions: WorkspaceStatusDimensions?
    public let presentation: AgentFeedPresentation
    /// ISO datetime; present means the agent is closed and must not get a pane.
    public let closedAt: String?
    public let sessionLocator: AgentSessionLocator?

    public init(id: String? = nil, name: String, tool: String? = nil, model: String? = nil,
                status: String = "working", taskDescription: String? = nil,
                contextPct: Double? = nil,
                closedAt: String? = nil, sessionLocator: AgentSessionLocator? = nil,
                statusDimensions: WorkspaceStatusDimensions? = nil,
                presentation: AgentFeedPresentation = .unknown) {
        self.id = id
        self.name = name
        self.tool = tool
        self.model = model
        self.status = status
        self.taskDescription = taskDescription
        self.contextPct = contextPct
        self.statusDimensions = statusDimensions
        self.presentation = presentation
        self.closedAt = closedAt
        self.sessionLocator = sessionLocator
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, tool, model, status, taskDescription, contextPct
        case closedAt, sessionLocator, statusDimensions
        case presentation
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
        statusDimensions = try container.decodeIfPresent(
            WorkspaceStatusDimensions.self, forKey: .statusDimensions)
        presentation = (try? container.decodeIfPresent(
            AgentFeedPresentation.self, forKey: .presentation)) ?? .unknown
        closedAt = try? container.decodeIfPresent(String.self, forKey: .closedAt)
        sessionLocator = try container.decodeIfPresent(
            AgentSessionLocator.self, forKey: .sessionLocator)
    }
}

public enum WorkspaceTerminalVisibilityState: String, Equatable, Codable {
    case pending, attaching, live, reconnecting, closing, exited, failed
}

public struct WorkspaceVisibleTerminal: Equatable, Encodable {
    public let agentId: String
    public let agentName: String
    public let locator: AgentSessionLocator
    public let state: WorkspaceTerminalVisibilityState
    public let geometry: TerminalGeometry?

    public init(agentId: String, agentName: String, locator: AgentSessionLocator,
                state: WorkspaceTerminalVisibilityState,
                geometry: TerminalGeometry? = nil) {
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

/// What the orchestrator is doing, as measured by the daemon from the root's own turn-boundary events. The root is not a spawned agent and has no AgentRecord, so it travels beside the `agents` array rather than inside it. A nil `status` is meaningful and must stay meaningful: no turn events, or a contradictory record, is unknown rather than a fabricated idle word. The object may still carry an independently measured sessiond host locator.
public struct OrchestratorSnapshot: Equatable, Decodable {
    public let status: String?
    public let host: String?
    public let hostState: String?
    public let hostDiagnostic: String?
    public let sessionLocator: AgentSessionLocator?
    public let presentation: AgentFeedPresentation

    public init(status: String?, host: String? = nil, hostState: String? = nil,
                hostDiagnostic: String? = nil,
                sessionLocator: AgentSessionLocator? = nil,
                presentation: AgentFeedPresentation = .unknown) {
        self.status = status
        self.host = host
        self.hostState = hostState
        self.hostDiagnostic = hostDiagnostic
        self.sessionLocator = sessionLocator
        self.presentation = presentation
    }

    private enum CodingKeys: String, CodingKey {
        case status, host, hostState, hostDiagnostic, sessionLocator, presentation
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decodeIfPresent(String.self, forKey: .status)
        host = try container.decodeIfPresent(String.self, forKey: .host)
        hostState = try container.decodeIfPresent(String.self, forKey: .hostState)
        hostDiagnostic = try container.decodeIfPresent(
            String.self, forKey: .hostDiagnostic)
        sessionLocator = try container.decodeIfPresent(
            AgentSessionLocator.self, forKey: .sessionLocator)
        presentation = (try? container.decodeIfPresent(
            AgentFeedPresentation.self, forKey: .presentation)) ?? .unknown
    }
}

public struct FeedLine: Decodable {
    public let v: Int?
    public let agents: [AgentSnapshot]?
    public let autonomy: String?
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

    /// Parses one line of feed output; returns nil for blank/undecodable lines (the feed may interleave diagnostics; the app must never crash on them).
    public static func parse(_ line: String) -> FeedLine? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("{"), let data = trimmed.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(FeedLine.self, from: data)
    }
}

/// What an agent is actually doing, as measured by the daemon. Its appearance is the single legend consumed by both the header symbol and status border. `needsUser` is only ever a measured condition: the daemon sets awaiting-approval when a pending approval record exists, and control-paused/stuck when the agent is genuinely blocked on a user. It is never inferred from idleness or elapsed time — an agent that finished and an agent stuck waiting on you are different states. `held` is the quota drain handler pausing an agent whose provider window is spent; it resumes on its own once the window resets, so it is neither `idle` (no work pending) nor `needsUser` (nothing for a user to do). The hold reason and reset time live in Models & Quota, not here. An unrecognized or absent status word is `unknown`, never one of the working/idle/needsUser/held states.
public enum AgentActivity: Equatable {
    case working
    case idle
    case needsUser
    case held
    case spawning
    case done
    case failed
    case disconnected
    case unknown
}

public enum StatusColor: Equatable {
    case green, yellow, orange, blue, purple, red, gray, teal
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
        case .held: return StatusAppearance(color: .teal, symbol: "hourglass.circle.fill", border: .solid)
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

/// How long a closed agent's pane lingers (showing its final status border) before the UI closes it. Gives "done"/"failed" a visible beat instead of vanishing the terminal mid-glance.
public enum PaneCloseGrace {
    public static let seconds: TimeInterval = 2.0
}
