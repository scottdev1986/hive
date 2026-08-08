import Foundation
import CoreGraphics
import HiveTerminalKit

public struct PaneState: Equatable {
    public let id: PaneID
    public let kind: PaneKind
    public var title: String
    public var tool: String?
    public var model: String?
    public var feedStatus: String
    public var headerDetail: String
    public var status: PaneStatus
    public var activity: AgentActivity
    public var attentionPresentation: FeedAttentionPresentation?
    public var taskDescription: String?
    public var contextPct: Double?
    public var agentID: String?
    public var sessionLocator: AgentSessionLocator?
    public var terminalVisibilityState: WorkspaceTerminalVisibilityState?
    public var closePending: Bool

    public init(id: PaneID, kind: PaneKind, title: String, tool: String? = nil,
                model: String? = nil, feedStatus: String, status: PaneStatus,
                headerDetail: String,
                taskDescription: String? = nil,
                contextPct: Double? = nil, agentID: String? = nil,
                sessionLocator: AgentSessionLocator? = nil,
                terminalVisibilityState: WorkspaceTerminalVisibilityState? = nil,
                activity: AgentActivity = .unknown,
                attentionPresentation: FeedAttentionPresentation? = nil,
                closePending: Bool = false) {
        self.id = id
        self.kind = kind
        self.title = title
        self.tool = tool
        self.model = model
        self.feedStatus = feedStatus
        self.headerDetail = headerDetail
        self.status = status
        self.activity = activity
        self.attentionPresentation = attentionPresentation
        self.taskDescription = taskDescription
        self.contextPct = contextPct
        self.agentID = agentID
        self.sessionLocator = sessionLocator
        self.terminalVisibilityState = terminalVisibilityState
        self.closePending = closePending
    }

    /// Live header detail. The title label renders the agent name separately, so this contains each remaining field exactly once. `headerDetail` is backend presentation; `taskDescription` is the immutable assignment and deliberately does not masquerade as live activity.
    public var headerDescription: String {
        var parts: [String] = []
        if let tool { parts.append(tool) }
        if let model { parts.append(model) }
        parts.append(headerDetail)
        if let contextPct {
            parts.append("ctx \(Int(contextPct.rounded()))%")
        }
        return parts.joined(separator: " · ")
    }

    public var statusDescription: String { headerDescription }
}

public enum StateChange: Equatable {
    case paneAdded(PaneID)
    case paneRemoved(PaneID)
    case paneClosePending(PaneID)
    case layoutChanged
    case focusChanged(PaneID?)
    case statusChanged(PaneID)
    case attentionChanged
}

public final class ProjectState {
    public let projectID: ProjectID
    public let displayName: String
    public private(set) var layout: LayoutTree
    public private(set) var panes: [PaneID: PaneState] = [:]
    public private(set) var focusedPane: PaneID?
    public private(set) var orchestratorPane: PaneID?
    public private(set) var attention = AttentionQueue()

    public var layoutBounds: CGRect

    /// Acknowledged is UI-local state: the feed keeps reporting completed/failed after the user has seen it, so the flag survives identical backend presentations and resets only when that presentation changes.
    private var acknowledged: Set<PaneID> = []
    /// Agents the user closed, whose kill the daemon has not finished yet. The feed goes on listing a live agent until it is actually dead, so without this the snapshot that lands a second after the X rebuilds the pane the user just closed.
    private var userClosed: Set<PaneID> = []
    /// Close removal is scheduled only after a full feed confirms teardown. A user's close request is visible as `closing` while the provider still exists, but cannot remove its own visibility authority prematurely.
    private var closeRemovalScheduled: Set<PaneID> = []
    private var nextVisibilityRevision: UInt64 = 1

    public init(projectID: ProjectID, displayName: String,
                layoutBounds: CGRect = CGRect(x: 0, y: 0, width: 1440, height: 900),
                metrics: LayoutMetrics = LayoutMetrics()) {
        self.projectID = projectID
        self.displayName = displayName
        self.layoutBounds = layoutBounds
        self.layout = LayoutTree(metrics: metrics)
    }

    public func frames(in bounds: CGRect) -> [PaneID: CGRect] {
        layout.frames(in: bounds)
    }

    /// Stable pane identity for a feed agent. Namespaced so an agent that happens to be named "orchestrator" can never collide with the local orchestrator pane.
    public static func paneID(forAgent name: String) -> PaneID {
        PaneID("agent:\(name)")
    }

    public static let orchestratorPaneID = PaneID("orchestrator")
    public static let orchestratorVisibilityID = "root"
    public static let orchestratorRecipient = "queen"

    /// The master pane is the selected orchestrator terminal, created by the window at open — the feed's `agents` array only describes worker agents. It is seeded "unknown", which is not a status word of its own. Do not seed a concrete word here: ANY constant is a fabrication, and one outside the daemon's vocabulary is degraded to gray by the dot's unknown-word rule — permanently marking the root, alive by definition whenever this app runs, as a gray "unknown". The real status arrives on the feed's `orchestrator` field and is applied below; until the first snapshot lands, "unknown" is the honest word, and gray is the honest colour.
    @discardableResult
    public func addOrchestrator(title: String = "Queen") -> [StateChange] {
        let paneID = ProjectState.orchestratorPaneID
        guard panes[paneID] == nil else { return [] }
        panes[paneID] = PaneState(
            id: paneID, kind: .orchestrator, title: title,
            feedStatus: "unknown", status: .unknown, headerDetail: "unknown")
        layout.insert(paneID, in: layoutBounds)
        orchestratorPane = paneID
        var changes: [StateChange] = [.paneAdded(paneID), .layoutChanged]
        if focusedPane == nil {
            focusedPane = paneID
            changes.append(.focusChanged(paneID))
        }
        return changes
    }

    /// Reconciles one feed snapshot against the pane set: - unknown live agent → pane inserted (least-disruptive split) - known agent → metadata/status refreshed, attention transitions applied - `closedAt` present, or agent vanished from the snapshot → the pane is marked close-pending exactly once; the UI closes it after the grace. - agents already closed (or "dead") that never had a pane are ignored. - the root's status (a separate field, since the root has no AgentRecord) updates the orchestrator pane; nil means the daemon could not honestly say, so the pane goes back to "unknown" rather than keeping a stale word.
    @discardableResult
    public func apply(feed agents: [AgentSnapshot],
                      orchestrator: OrchestratorSnapshot? = nil) -> [StateChange] {
        var changes: [StateChange] = []
        var seen: Set<PaneID> = []

        changes.append(contentsOf: applyOrchestrator(orchestrator))

        for agent in agents {
            let paneID = ProjectState.paneID(forAgent: agent.name)
            seen.insert(paneID)

            if agent.closedAt != nil || !agent.presentation.shouldDisplayPane {
                changes.append(contentsOf: markClosePending(paneID))
                userClosed.remove(paneID)
                continue
            }
            // The user closed this agent's pane; a pane close never kills the agent, so the feed still lists it as live. Do not rebuild its pane here: it would reappear a second after the user dismissed it.
            if userClosed.contains(paneID) { continue }
            if var pane = panes[paneID] {
                changes.append(contentsOf: update(pane: &pane, from: agent))
                panes[paneID] = pane
            } else {
                changes.append(contentsOf: insertPane(for: agent))
            }
        }

        for (paneID, pane) in panes
        where pane.kind != .orchestrator && !seen.contains(paneID) {
            changes.append(contentsOf: markClosePending(paneID))
        }
        // An agent the daemon no longer reports is really gone: stop suppressing it, so the set never grows without bound and a name that comes back later (a new agent) gets its pane.
        userClosed.formIntersection(seen)
        return changes
    }

    /// The user closed this pane (the pane X, ⇧⌘W, or the accessibility action). Closing a pane never touches the agent: it keeps running headless, so the feed keeps listing it live — and its pane must not be rebuilt from those snapshots while it does. The suppression clears when the daemon stops reporting the agent, so a later agent reusing the name gets a pane again.
    @discardableResult
    public func markUserClosed(_ paneID: PaneID) -> [StateChange] {
        userClosed.insert(paneID)
        return markClosePending(paneID, scheduleRemoval: false)
    }

    public func visibilityInventory(
        geometries: [PaneID: TerminalGeometry] = [:]
    ) -> WorkspaceVisibilityInventory {
        let terminals = panes.values.compactMap { pane -> WorkspaceVisibleTerminal? in
            guard let locator = pane.sessionLocator,
                  locator.hostKind == "sessiond",
                  locator.engineBuildId != nil else { return nil }
            let agentID: String
            let agentName: String
            switch pane.kind {
            case .agent:
                guard let paneAgentID = pane.agentID,
                      locator.subject.kind == "agent",
                      locator.subject.agentId == paneAgentID else { return nil }
                agentID = paneAgentID
                agentName = pane.title
            case .orchestrator:
                guard locator.subject.kind == "root",
                      locator.subject.agentId == nil else { return nil }
                agentID = ProjectState.orchestratorVisibilityID
                agentName = ProjectState.orchestratorRecipient
            }
            let visibilityState: WorkspaceTerminalVisibilityState
            if pane.closePending {
                visibilityState = .closing
            } else if let presented = pane.terminalVisibilityState {
                visibilityState = presented
            } else {
                return nil
            }
            return WorkspaceVisibleTerminal(
                agentId: agentID,
                agentName: agentName,
                locator: locator,
                state: visibilityState,
                geometry: geometries[pane.id])
        }.sorted { left, right in
            left.agentId == right.agentId
                ? left.locator.generation < right.locator.generation
                : left.agentId < right.agentId
        }
        let inventory = WorkspaceVisibilityInventory(
            inventoryRevision: String(nextVisibilityRevision),
            terminals: terminals)
        nextVisibilityRevision += 1
        return inventory
    }

    /// The root's status word from one snapshot. A nil snapshot is the daemon saying it does not know (no turn events, or a self-contradicting record that means the root's hooks are not reaching it) — so the pane reverts to "unknown" and its dot goes gray. Reverting matters: holding the last known word would turn a lost signal into a confident stale claim, which is the exact failure this whole change exists to remove. It does not clear an already measured terminal locator; missing turn state is not host exit.
    private func applyOrchestrator(_ snapshot: OrchestratorSnapshot?) -> [StateChange] {
        let paneID = ProjectState.orchestratorPaneID
        guard var pane = panes[paneID] else { return [] }
        let previous = pane
        pane.feedStatus = snapshot?.status ?? "unknown"
        pane.headerDetail = snapshot?.presentation.headerDetail ?? "unknown"
        pane.status = snapshot?.presentation.paneStatus.paneStatus() ?? .unknown
        pane.activity = snapshot?.presentation.renderedActivity ?? .unknown
        pane.terminalVisibilityState = snapshot?.presentation.renderedTerminalState
        if let host = snapshot?.host {
            pane.sessionLocator = host == "sessiond" ? snapshot?.sessionLocator : nil
        }
        guard pane != previous else { return [] }
        panes[paneID] = pane
        return [.statusChanged(paneID)]
    }

    private func isDisconnected(_ status: PaneStatus) -> Bool {
        if case .disconnected = status { return true }
        return false
    }

    /// The feed process died: statuses can no longer be trusted, so every pane turns gray dashed (disconnected). Terminals stay attached — only the metadata stream is gone. The orchestrator is included, and must not be exempted: its status word is measured, so a dead feed makes it exactly as untrustworthy as any agent's — the root may have started or finished ten turns since the last line we read. Its terminal is still live and still attached; what we have lost is not the root, only our knowledge of it, and those are different things to say.
    @discardableResult
    public func markFeedLost(reason: String = "workspace feed exited") -> [StateChange] {
        var changes: [StateChange] = []
        for (paneID, var pane) in panes {
            if case .disconnected = pane.status { continue }
            pane.status = .disconnected(reason: reason, lastConfirmed: pane.feedStatus)
            pane.activity = .disconnected
            pane.terminalVisibilityState = .reconnecting
            pane.feedStatus = "unknown"
            pane.headerDetail = reason
            panes[paneID] = pane
            changes.append(.statusChanged(paneID))
        }
        return changes
    }

    private func insertPane(for agent: AgentSnapshot) -> [StateChange] {
        let paneID = ProjectState.paneID(forAgent: agent.name)
        let pane = PaneState(
            id: paneID, kind: .agent, title: agent.name,
            tool: agent.tool, model: agent.model,
            feedStatus: agent.status,
            status: agent.presentation.paneStatus.paneStatus(),
            headerDetail: agent.presentation.headerDetail,
            taskDescription: agent.taskDescription,
            contextPct: agent.contextPct,
            agentID: agent.id,
            sessionLocator: agent.sessionLocator,
            terminalVisibilityState: agent.presentation.renderedTerminalState,
            activity: agent.presentation.renderedActivity,
            attentionPresentation: agent.presentation.attention)
        var changes: [StateChange] = []
        panes[paneID] = pane
        layout.insert(paneID, in: layoutBounds)
        changes.append(.paneAdded(paneID))
        changes.append(.layoutChanged)
        // Creation never steals focus; the very first pane is the exception because an empty workspace has nothing focused.
        if focusedPane == nil {
            focusedPane = paneID
            changes.append(.focusChanged(paneID))
        }
        changes.append(contentsOf: raiseAttention(for: pane))
        return changes
    }

    private func update(pane: inout PaneState, from agent: AgentSnapshot) -> [StateChange] {
        var changes: [StateChange] = []
        let statusWordChanged = pane.feedStatus != agent.status
        let headerDetailChanged = pane.headerDetail != agent.presentation.headerDetail
        let presentationChanged = pane.activity != agent.presentation.renderedActivity
            || pane.attentionPresentation != agent.presentation.attention
            || pane.status != agent.presentation.paneStatus.paneStatus(
                acknowledged: acknowledged.contains(pane.id))
        let headerChanged = statusWordChanged || headerDetailChanged
            || presentationChanged
            || pane.tool != agent.tool
            || pane.model != agent.model
            || pane.taskDescription != agent.taskDescription
            || pane.contextPct != agent.contextPct
            || pane.sessionLocator != agent.sessionLocator
            || pane.terminalVisibilityState != agent.presentation.renderedTerminalState
            || pane.closePending

        pane.tool = agent.tool
        pane.model = agent.model
        pane.taskDescription = agent.taskDescription
        pane.contextPct = agent.contextPct
        pane.agentID = agent.id
        pane.sessionLocator = agent.sessionLocator
        pane.terminalVisibilityState = agent.presentation.renderedTerminalState
        pane.feedStatus = agent.status
        pane.headerDetail = agent.presentation.headerDetail
        if pane.closePending {
            closeRemovalScheduled.remove(pane.id)
        }
        pane.closePending = false // a live snapshot revives a pending close

        if presentationChanged {
            acknowledged.remove(pane.id)
            pane.status = agent.presentation.paneStatus.paneStatus(
                acknowledged: acknowledged.contains(pane.id))
            pane.activity = agent.presentation.renderedActivity
            pane.attentionPresentation = agent.presentation.attention
            // Old attention is stale the moment the daemon reports a new status; re-raise for the new one if it warrants attention.
            attention.resolveAll(paneID: pane.id, projectID: projectID)
            changes.append(contentsOf: raiseAttention(for: pane))
            changes.append(.attentionChanged)
        }
        if headerChanged {
            changes.append(.statusChanged(pane.id))
        }
        return changes
    }

    private func raiseAttention(for pane: PaneState) -> [StateChange] {
        guard let presented = pane.attentionPresentation,
              let severity = presented.renderedSeverity else {
            return []
        }
        attention.raise(AttentionItem(
            id: presented.id, projectID: projectID, paneID: pane.id,
            severity: severity, title: presented.title,
            detail: presented.detail, raisedAt: presented.raisedAt))
        return [.attentionChanged]
    }

    private func markClosePending(
        _ paneID: PaneID,
        scheduleRemoval: Bool = true
    ) -> [StateChange] {
        guard var pane = panes[paneID] else { return [] }
        var changes: [StateChange] = []
        if !pane.closePending {
            pane.closePending = true
            panes[paneID] = pane
            changes.append(.statusChanged(paneID))
        }
        if scheduleRemoval, closeRemovalScheduled.insert(paneID).inserted {
            changes.append(.paneClosePending(paneID))
        }
        return changes
    }

    public struct SwitcherCard: Equatable {
        public let projectID: ProjectID
        public let displayName: String
        public let orchestratorModel: String?
        public let paneCount: Int
        public let runningCount: Int
        public let waitingCount: Int
        public let failedCount: Int
    }

    public var switcherCard: SwitcherCard {
        let statuses = panes.values.map(\.status)
        return SwitcherCard(
            projectID: projectID,
            displayName: displayName,
            orchestratorModel: orchestratorPane.flatMap { panes[$0]?.model },
            paneCount: panes.count,
            runningCount: statuses.filter { $0 == .running }.count,
            waitingCount: statuses.filter { $0.isWaiting }.count,
            failedCount: statuses.filter { if case .failed(false) = $0 { return true } else { return false } }.count
        )
    }

    @discardableResult
    public func apply(_ command: WorkspaceCommand) -> [StateChange] {
        switch command {
        case .focusPane(let paneID):
            guard panes[paneID] != nil, focusedPane != paneID else { return [] }
            focusedPane = paneID
            return [.focusChanged(paneID)]

        case .moveFocus(let direction):
            guard let source = focusedPane else { return [] }
            let solved = layout.frames(in: layoutBounds)
            guard let target = SpatialNavigator.pane(from: source, in: solved, direction: direction),
                  target != source else { return [] }
            focusedPane = target
            return [.focusChanged(target)]

        case .focusOrchestrator:
            guard let orchestrator = orchestratorPane, focusedPane != orchestrator else { return [] }
            focusedPane = orchestrator
            return [.focusChanged(orchestrator)]

        case .promotePane(let paneID):
            guard panes[paneID] != nil, layout.master != paneID else { return [] }
            layout.promote(paneID)
            return [.layoutChanged]

        case .returnOrchestratorToMaster:
            guard let orchestrator = orchestratorPane, layout.master != orchestrator else { return [] }
            layout.promote(orchestrator)
            return [.layoutChanged]

        case .closePane(let paneID):
            guard panes[paneID] != nil else { return [] }
            layout.close(paneID, preferredMaster: orchestratorPane)
            panes.removeValue(forKey: paneID)
            acknowledged.remove(paneID)
            closeRemovalScheduled.remove(paneID)
            attention.resolveAll(paneID: paneID, projectID: projectID)
            var changes: [StateChange] = [.paneRemoved(paneID), .layoutChanged, .attentionChanged]
            if orchestratorPane == paneID { orchestratorPane = nil }
            if focusedPane == paneID {
                focusedPane = layout.master
                changes.append(.focusChanged(focusedPane))
            }
            return changes

        case .acknowledgePane(let paneID):
            guard var pane = panes[paneID] else { return [] }
            switch pane.status {
            case .completed(false):
                pane.status = .completed(acknowledged: true)
            case .failed(false):
                pane.status = .failed(acknowledged: true)
            default:
                return []
            }
            acknowledged.insert(paneID)
            panes[paneID] = pane
            attention.resolveAll(paneID: paneID, projectID: projectID)
            return [.statusChanged(paneID), .attentionChanged]
        }
    }
}
