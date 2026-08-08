import Foundation

public enum LiveRunFeedError: Error, Equatable, LocalizedError {
    case unsupportedSchemaVersion(Int?)
    case feedReported(String)
    case missingSnapshot

    public var errorDescription: String? {
        switch self {
        case .unsupportedSchemaVersion(let version):
            return "Live Run refused workspace-feed schemaVersion \(version.map(String.init) ?? "missing"); expected 1."
        case .feedReported(let reason):
            return "Live Run feed error: \(reason)"
        case .missingSnapshot:
            return "Live Run received no agent snapshot."
        }
    }
}

public enum LiveRunContractFact: Equatable, Sendable {
    case absent(reason: String)
    case unknown(reason: String)

    public var label: String {
        switch self {
        case .absent: return "absent"
        case .unknown: return "unknown"
        }
    }

    public var reason: String {
        switch self {
        case .absent(let reason), .unknown(let reason): return reason
        }
    }
}

public struct LiveRunSessionSummary: Equatable {
    public let id: String
    public let agentID: String?
    public let name: String
    public let provider: ProviderID
    public let model: String?
    public let rawStatus: String
    public let activity: AgentActivity
    public let task: String?
    public let locator: AgentSessionLocator?
    public let locatorFact: LiveRunContractFact?
    public let providerRun: LiveRunContractFact
    public let inputOwner: LiveRunContractFact
    public let shellRoot: LiveRunContractFact
    public let processCensus: LiveRunContractFact
    public let termination: LiveRunContractFact

    public init(agent: AgentSnapshot) {
        id = agent.id ?? "name:\(agent.name)"
        agentID = agent.id
        name = agent.name
        provider = ProviderID(agent.tool ?? "unknown")
        model = agent.model
        rawStatus = agent.status
        activity = agent.presentation.renderedActivity
        task = agent.taskDescription

        if let agentID = agent.id,
           !agentID.isEmpty,
           let candidate = agent.sessionLocator,
           candidate.schemaVersion == 1,
           !candidate.instanceId.isEmpty,
           candidate.subject.kind == "agent",
           candidate.subject.agentId == agentID,
           candidate.hostKind == "sessiond",
           candidate.engineBuildId?.isEmpty == false,
           candidate.generation > 0,
           !candidate.sessionId.isEmpty {
            locator = candidate
            locatorFact = nil
        } else {
            locator = nil
            locatorFact = .unknown(reason: Self.locatorReason(agent))
        }

        providerRun = .absent(
            reason: "workspace-feed does not project exact ProviderRun identity")
        inputOwner = .unknown(
            reason: "workspace-feed does not project the terminal input owner")
        shellRoot = .unknown(
            reason: "workspace-feed does not project retained-shell ancestry")
        processCensus = .absent(
            reason: "workspace-feed has no independent cwd-inode process census")
        termination = .unknown(
            reason: "workspace-feed termination evidence absent · process-tree-escapees-unaccounted")
    }

    private static func locatorReason(_ agent: AgentSnapshot) -> String {
        guard let agentID = agent.id, !agentID.isEmpty else {
            return "workspace-feed has no stable agent id for this terminal"
        }
        guard let locator = agent.sessionLocator else {
            return "workspace-feed has no exact terminal locator for this agent"
        }
        if locator.schemaVersion != 1 {
            return "terminal locator schemaVersion \(locator.schemaVersion) is unsupported"
        }
        if locator.hostKind != "sessiond" {
            return "terminal host kind \(locator.hostKind) is unsupported"
        }
        if locator.instanceId.isEmpty {
            return "terminal locator has no instance identity"
        }
        if locator.subject.kind != "agent" || locator.subject.agentId != agentID {
            return "terminal locator subject does not match this agent"
        }
        if locator.engineBuildId?.isEmpty != false {
            return "terminal locator has no engine build identity"
        }
        if locator.generation <= 0 || locator.sessionId.isEmpty {
            return "terminal locator is incomplete"
        }
        return "terminal locator is not attachable"
    }
}

public struct LiveRunProjection: Equatable {
    public let schemaVersion: Int
    public let sessions: [LiveRunSessionSummary]

    public init(feedLine: FeedLine) throws {
        guard feedLine.v == 1 else {
            throw LiveRunFeedError.unsupportedSchemaVersion(feedLine.v)
        }
        if let error = feedLine.error {
            throw LiveRunFeedError.feedReported(error)
        }
        guard let agents = feedLine.agents else {
            throw LiveRunFeedError.missingSnapshot
        }
        schemaVersion = 1
        sessions = agents
            .filter { $0.closedAt == nil }
            .map(LiveRunSessionSummary.init(agent:))
    }
}
