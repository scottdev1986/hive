import Foundation

/// The structured event envelope the transcript consumes.
///
/// This deliberately mirrors the destination AgentHost journal shape:
/// a monotonic per-session sequence plus semantic payload. Fields the real
/// providers frequently omit (model, timestamps) are optional here so the
/// transcript proves it renders gracefully with them missing — "unknown is
/// never rendered as yes".
public struct AgentEventEnvelope: Equatable {
    public let projectID: ProjectID
    public let paneID: PaneID
    /// Monotonic per-(project, pane) sequence, as the AgentHost WAL will provide.
    public let sequence: Int
    /// Provider-reported wall clock; often missing in observed streams.
    public let timestamp: TimeInterval?
    public let payload: AgentEvent

    public init(projectID: ProjectID, paneID: PaneID, sequence: Int,
                timestamp: TimeInterval?, payload: AgentEvent) {
        self.projectID = projectID
        self.paneID = paneID
        self.sequence = sequence
        self.timestamp = timestamp
        self.payload = payload
    }
}

public enum MessageRole: String, Codable, Equatable {
    case user
    case assistant
    case system
}

public struct DiffHunk: Equatable {
    public enum LineKind: Equatable { case context, addition, deletion }
    public struct Line: Equatable {
        public let kind: LineKind
        public let text: String
        public init(kind: LineKind, text: String) {
            self.kind = kind
            self.text = text
        }
    }
    public let header: String
    public let lines: [Line]
    public init(header: String, lines: [Line]) {
        self.header = header
        self.lines = lines
    }
}

public struct DiffPayload: Equatable {
    public let filePath: String
    public let hunks: [DiffHunk]
    public init(filePath: String, hunks: [DiffHunk]) {
        self.filePath = filePath
        self.hunks = hunks
    }
}

/// Semantic provider events, provider-neutral. Modeled on the surfaces the
/// cross-vendor review drove: Claude stream-json message/tool deltas and
/// permission prompts, Codex app-server thread/turn/approval methods.
public enum AgentEvent: Equatable {
    /// Session became live. `model` is the provider-reported effective model
    /// and is intentionally optional: real streams omit it in places.
    case sessionStarted(title: String, kind: PaneKind, model: String?)

    /// Streaming assistant/user message. Deltas share `messageID`; the
    /// transcript grows one item in place rather than appending fragments.
    case messageDelta(messageID: String, role: MessageRole, text: String, model: String?)
    case messageCompleted(messageID: String)

    case toolCallStarted(callID: String, name: String, input: String)
    /// Chunked tool output; may total megabytes. `isANSI` marks content that
    /// carries escape sequences and must render styled, not raw.
    case toolOutput(callID: String, chunk: String, isANSI: Bool)
    case toolCallCompleted(callID: String, exitCode: Int?)

    case approvalRequested(approvalID: String, title: String, detail: String, diff: DiffPayload?)
    case approvalResolved(approvalID: String, approved: Bool)

    case diffProduced(DiffPayload)

    case statusChanged(PaneStatus)
    case agentCompleted(summary: String)
    case agentFailed(error: String)
    case disconnected(reason: String)
    case reconnected
}
