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
    /// Workspace visibility id for the root. The queen has no AgentRecord, so the feed carries her beside `agents`.
    public static let queenID = "root"
    public static let queenName = "queen"

    public let id: String
    public let agentID: String?
    public let name: String
    public let provider: ProviderID?
    public let model: String?
    public let rawStatus: String
    public let activity: AgentActivity
    public let task: String?
    public let locator: AgentSessionLocator?
    public let locatorFact: LiveRunContractFact?
    public let providerRun: LiveRunContractFact
    public let shellRoot: LiveRunContractFact
    public let processCensus: LiveRunContractFact
    public let termination: LiveRunContractFact
    public var isQueen: Bool { id == Self.queenID }

    public init(agent: AgentSnapshot) {
        id = agent.id ?? "name:\(agent.name)"
        agentID = agent.id
        name = agent.name
        provider = agent.tool.map { ProviderID($0) }
        model = agent.model
        rawStatus = agent.status
        activity = agent.presentation.renderedActivity
        task = agent.taskDescription

        if let candidate = agent.sessionLocator,
           Self.isAttachable(candidate, agentID: agent.id) {
            locator = candidate
            locatorFact = nil
        } else {
            locator = nil
            locatorFact = .unknown(reason: Self.locatorReason(agent))
        }

        providerRun = .absent(
            reason: "workspace-feed does not project exact ProviderRun identity")
        shellRoot = .unknown(
            reason: "workspace-feed does not project retained-shell ancestry")
        processCensus = .absent(
            reason: "workspace-feed has no independent cwd-inode process census")
        termination = .unknown(
            reason: "workspace-feed termination evidence absent · process-tree-escapees-unaccounted")
    }

    public init(orchestrator: OrchestratorSnapshot) {
        id = Self.queenID
        agentID = Self.queenID
        name = Self.queenName
        provider = ProviderID("unknown")
        model = nil
        rawStatus = orchestrator.status ?? "unknown"
        let presented = orchestrator.presentation.renderedActivity
        activity = presented == .unknown
            ? AgentFeedPresentation(
                panePresence: "visible",
                terminalState: "live",
                headerDetail: rawStatus,
                paneStatus: FeedPanePresentation(kind: "running"),
                activity: rawStatus).renderedActivity
            : presented
        task = "Own the run, escalation, and current-owner policy"
        if let candidate = orchestrator.sessionLocator,
           Self.isAttachable(candidate, agentID: Self.queenID) {
            locator = candidate
            locatorFact = nil
        } else {
            locator = nil
            locatorFact = .unknown(reason: Self.queenLocatorReason(orchestrator))
        }
        providerRun = .absent(
            reason: "workspace-feed does not project exact ProviderRun identity")
        shellRoot = .unknown(
            reason: "workspace-feed does not project retained-shell ancestry")
        processCensus = .absent(
            reason: "workspace-feed has no independent cwd-inode process census")
        termination = .unknown(
            reason: "workspace-feed termination evidence absent · process-tree-escapees-unaccounted")
    }

    private static func isAttachable(
        _ locator: AgentSessionLocator,
        agentID: String?
    ) -> Bool {
        guard locator.schemaVersion == 1,
              !locator.instanceId.isEmpty,
              locator.hostKind == "sessiond",
              locator.engineBuildId?.isEmpty == false,
              locator.generation > 0,
              !locator.sessionId.isEmpty
        else { return false }
        if locator.subject.kind == "root" {
            return agentID == queenID
        }
        return locator.subject.kind == "agent"
            && locator.subject.agentId == agentID
            && agentID?.isEmpty == false
    }

    private static func queenLocatorReason(_ orchestrator: OrchestratorSnapshot) -> String {
        guard let locator = orchestrator.sessionLocator else {
            if orchestrator.host == "sessiond" {
                return "workspace-feed has no exact terminal locator for queen"
            }
            return "queen host \(orchestrator.host ?? "unknown") is not an attachable sessiond terminal"
        }
        if locator.subject.kind != "root" {
            return "queen locator subject is \(locator.subject.kind), not root"
        }
        if locator.hostKind != "sessiond" {
            return "queen terminal host kind \(locator.hostKind) is unsupported"
        }
        if locator.instanceId.isEmpty {
            return "queen terminal locator has no instance identity"
        }
        if locator.engineBuildId?.isEmpty != false {
            return "queen terminal locator has no engine build identity"
        }
        if locator.generation <= 0 || locator.sessionId.isEmpty {
            return "queen terminal locator is incomplete"
        }
        return "queen terminal locator is not attachable"
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
        if locator.subject.kind == "root" {
            return "root locator cannot attach a worker agent"
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
        let workers = agents
            .filter { $0.closedAt == nil }
            .map(LiveRunSessionSummary.init(agent:))
        if let orchestrator = feedLine.orchestrator {
            sessions = [LiveRunSessionSummary(orchestrator: orchestrator)] + workers
        } else {
            sessions = workers
        }
    }
}

public struct LiveRunProcessIdentity: Codable, Equatable, Sendable {
    public let pid: Int
    public let startToken: String
}

public struct LiveRunShellRoot: Codable, Equatable, Sendable {
    public let pid: Int
    public let startToken: String
    public let processGroupId: Int
}

public struct LiveRunProviderProcessIdentity: Codable, Equatable, Sendable {
    public let pid: Int
    public let startToken: String
    public let processGroupId: Int
    public let observedAt: String
}

public struct LiveRunProviderRunFact: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable {
        case running
        case absent
        case unknown
    }

    public let state: State
    public let runID: String?
    public let provider: ProviderID?
    public let process: LiveRunProviderProcessIdentity?
    public let reason: String?

    private enum CodingKeys: String, CodingKey {
        case state
        case runID = "runId"
        case provider
        case process
        case reason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = try container.decode(State.self, forKey: .state)
        runID = try container.decodeIfPresent(String.self, forKey: .runID)
        provider = try container.decodeIfPresent(ProviderID.self, forKey: .provider)
        process = try container.decodeIfPresent(
            LiveRunProviderProcessIdentity.self, forKey: .process)
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
        let valid = switch state {
        case .running:
            runID?.isEmpty == false && provider != nil && process != nil && reason == nil
        case .absent:
            runID == nil && provider == nil && process == nil && reason == nil
        case .unknown:
            runID == nil && provider == nil && process == nil && reason?.isEmpty == false
        }
        guard valid else {
            throw DecodingError.dataCorruptedError(
                forKey: .state, in: container,
                debugDescription: "invalid ProviderRun fact for state \(state.rawValue)")
        }
    }
}

public struct LiveRunShellFact: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable {
        case retained
        case terminated
        case unknown
    }

    public enum Foreground: String, Codable, Sendable {
        case provider
        case shell
        case other
    }

    public let state: State
    public let root: LiveRunShellRoot?
    public let foreground: Foreground?
    public let reason: String?

    private enum CodingKeys: String, CodingKey {
        case state, root, foreground, reason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = try container.decode(State.self, forKey: .state)
        root = try container.decodeIfPresent(LiveRunShellRoot.self, forKey: .root)
        foreground = try container.decodeIfPresent(Foreground.self, forKey: .foreground)
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
        let valid = switch state {
        case .retained:
            root != nil && foreground != nil && reason == nil
        case .terminated:
            root == nil && foreground == nil && reason == nil
        case .unknown:
            root == nil && foreground == nil && reason?.isEmpty == false
        }
        guard valid else {
            throw DecodingError.dataCorruptedError(
                forKey: .state, in: container,
                debugDescription: "invalid shell fact for state \(state.rawValue)")
        }
    }
}

public struct LiveRunProcessCensusFact: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable {
        case complete
        case terminated
        case unknown
    }

    public let state: State
    public let source: String?
    public let members: [LiveRunProcessIdentity]
    public let observedAt: String?
    public let reason: String?

    private enum CodingKeys: String, CodingKey {
        case state, source, members, observedAt, reason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = try container.decode(State.self, forKey: .state)
        source = try container.decodeIfPresent(String.self, forKey: .source)
        members = try container.decodeIfPresent(
            [LiveRunProcessIdentity].self, forKey: .members) ?? []
        observedAt = try container.decodeIfPresent(String.self, forKey: .observedAt)
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
        let valid = switch state {
        case .complete:
            source == "sessiond-process-tree" && observedAt?.isEmpty == false
                && reason == nil
        case .terminated:
            source == nil && members.isEmpty && observedAt == nil && reason == nil
        case .unknown:
            source == nil && members.isEmpty && observedAt == nil
                && reason?.isEmpty == false
        }
        guard valid else {
            throw DecodingError.dataCorruptedError(
                forKey: .state, in: container,
                debugDescription: "invalid process census for state \(state.rawValue)")
        }
    }
}

public struct LiveRunTerminationSurvivor: Codable, Equatable, Sendable {
    public let pid: Int
    public let startToken: String
    public let reason: String
}

public struct LiveRunTerminationFact: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable {
        case notRequested = "not-requested"
        case terminated
        case survivors
        case unknown
    }

    public let state: State
    public let completedAt: String?
    public let survivors: [LiveRunTerminationSurvivor]
    public let reason: String?

    private enum CodingKeys: String, CodingKey {
        case state, completedAt, survivors, reason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = try container.decode(State.self, forKey: .state)
        completedAt = try container.decodeIfPresent(String.self, forKey: .completedAt)
        survivors = try container.decodeIfPresent(
            [LiveRunTerminationSurvivor].self, forKey: .survivors) ?? []
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
        let valid = switch state {
        case .notRequested:
            completedAt == nil && survivors.isEmpty && reason == nil
        case .terminated:
            completedAt?.isEmpty == false && survivors.isEmpty && reason == nil
        case .survivors:
            completedAt?.isEmpty == false && !survivors.isEmpty && reason == nil
        case .unknown:
            completedAt == nil && survivors.isEmpty && reason?.isEmpty == false
        }
        guard valid else {
            throw DecodingError.dataCorruptedError(
                forKey: .state, in: container,
                debugDescription: "invalid termination fact for state \(state.rawValue)")
        }
    }
}

public struct LiveRunControlAvailability: Codable, Equatable, Sendable {
    public let enabled: Bool
    public let reason: String?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try container.decode(Bool.self, forKey: .enabled)
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
        guard enabled ? reason == nil : reason?.isEmpty == false else {
            throw DecodingError.dataCorruptedError(
                forKey: .reason, in: container,
                debugDescription: "enabled controls have no refusal reason; disabled controls require one")
        }
    }

    private enum CodingKeys: String, CodingKey {
        case enabled, reason
    }
}

public struct LiveRunControlSet: Codable, Equatable, Sendable {
    public let stopProvider: LiveRunControlAvailability
    public let terminateTerminal: LiveRunControlAvailability
}

public struct LiveRunControlProjection: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let observedAt: String
    public let agentID: String
    public let agentName: String
    public let provider: ProviderID
    public let locator: AgentSessionLocator
    public let providerRun: LiveRunProviderRunFact
    public let shell: LiveRunShellFact
    public let processCensus: LiveRunProcessCensusFact
    public let termination: LiveRunTerminationFact
    public let controls: LiveRunControlSet

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, observedAt
        case agentID = "agentId"
        case agentName, provider, locator, providerRun, shell
        case processCensus, termination, controls
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        observedAt = try container.decode(String.self, forKey: .observedAt)
        agentID = try container.decode(String.self, forKey: .agentID)
        agentName = try container.decode(String.self, forKey: .agentName)
        provider = try container.decode(ProviderID.self, forKey: .provider)
        locator = try container.decode(AgentSessionLocator.self, forKey: .locator)
        providerRun = try container.decode(LiveRunProviderRunFact.self, forKey: .providerRun)
        shell = try container.decode(LiveRunShellFact.self, forKey: .shell)
        processCensus = try container.decode(
            LiveRunProcessCensusFact.self, forKey: .processCensus)
        termination = try container.decode(LiveRunTerminationFact.self, forKey: .termination)
        controls = try container.decode(LiveRunControlSet.self, forKey: .controls)
        guard schemaVersion == 1,
              !observedAt.isEmpty,
              !agentID.isEmpty,
              locator.subject.kind == "agent",
              locator.subject.agentId == agentID,
              locator.generation > 0,
              locator.hostKind == "sessiond",
              locator.engineBuildId?.isEmpty == false
        else {
            throw DecodingError.dataCorruptedError(
                forKey: .locator, in: container,
                debugDescription: "Live Run control projection has no exact agent locator")
        }
    }
}

public enum LiveRunControlOperation: String, Codable, Equatable, Sendable {
    case stopProvider = "stop-provider"
    case terminateTerminal = "terminate-terminal"
}

public struct LiveRunControlBody: Codable, Equatable, Sendable {
    public let operation: LiveRunControlOperation
    public let agentID: String
    public let locator: AgentSessionLocator
    public let expectedShellRoot: LiveRunShellRoot
    public let expectedProviderRunID: String?

    private enum CodingKeys: String, CodingKey {
        case operation
        case agentID = "agentId"
        case locator, expectedShellRoot
        case expectedProviderRunID = "expectedProviderRunId"
    }

    public init(
        operation: LiveRunControlOperation,
        projection: LiveRunControlProjection
    ) throws {
        guard let root = projection.shell.root else {
            throw LiveRunControlBodyError.unverifiedShell
        }
        let providerRunID: String?
        switch operation {
        case .stopProvider:
            guard let runID = projection.providerRun.runID else {
                throw LiveRunControlBodyError.unverifiedProviderRun
            }
            providerRunID = runID
        case .terminateTerminal:
            providerRunID = nil
        }
        self.operation = operation
        agentID = projection.agentID
        locator = projection.locator
        expectedShellRoot = root
        expectedProviderRunID = providerRunID
    }
}

public enum LiveRunControlBodyError: Error, Equatable {
    case unverifiedShell
    case unverifiedProviderRun
}
