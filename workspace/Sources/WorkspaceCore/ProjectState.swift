import Foundation
import CoreGraphics

/// Everything one workspace window shows for one pane. The pane content is a
/// real terminal (the AppKit layer owns that); this is the metadata around it:
/// identity, the daemon-reported status, and the tmux session the terminal
/// attaches to.
public struct PaneState: Equatable {
    public let id: PaneID
    public let kind: PaneKind
    public var title: String
    public var tool: String?
    public var model: String?
    /// Raw daemon status word ("working", "awaiting-approval", …) for headers.
    /// `status` below is the semantic mapping that drives color and attention.
    public var feedStatus: String
    public var status: PaneStatus
    public var taskDescription: String?
    public var tmuxSession: String?
    public var contextPct: Double?
    public var agentID: String?
    public var sessionLocator: AgentSessionLocator?
    public var terminalHostState: String?
    /// True once the feed reported `closedAt` (or dropped the agent): the pane
    /// is in its grace window and the UI will close it shortly.
    public var closePending: Bool

    public init(id: PaneID, kind: PaneKind, title: String, tool: String? = nil,
                model: String? = nil, feedStatus: String, status: PaneStatus,
                taskDescription: String? = nil, tmuxSession: String? = nil,
                contextPct: Double? = nil, agentID: String? = nil,
                sessionLocator: AgentSessionLocator? = nil,
                terminalHostState: String? = nil,
                closePending: Bool = false) {
        self.id = id
        self.kind = kind
        self.title = title
        self.tool = tool
        self.model = model
        self.feedStatus = feedStatus
        self.status = status
        self.taskDescription = taskDescription
        self.tmuxSession = tmuxSession
        self.contextPct = contextPct
        self.agentID = agentID
        self.sessionLocator = sessionLocator
        self.terminalHostState = terminalHostState
        self.closePending = closePending
    }

    /// Live header detail. The title label renders the agent name separately,
    /// so this contains each remaining field exactly once. `feedStatus` is the
    /// current activity from hook events; `taskDescription` is the immutable
    /// assignment and deliberately does not masquerade as live activity.
    public var headerDescription: String {
        var parts: [String] = []
        if let tool { parts.append(tool) }
        if let model { parts.append(model) }
        parts.append(feedStatus)
        if let contextPct {
            parts.append("ctx \(Int(contextPct.rounded()))%")
        }
        return parts.joined(separator: " · ")
    }

    /// Human status line for accessibility values and fallback attention text.
    public var statusDescription: String { headerDescription }
}

/// State changes the UI layer reacts to. One reducer emits these for every
/// input surface, which is what keeps mouse/keyboard/menu/accessibility in
/// agreement.
public enum StateChange: Equatable {
    case paneAdded(PaneID)
    case paneRemoved(PaneID)
    /// The feed closed this agent; the UI shows the final status border for
    /// `PaneCloseGrace.seconds`, then dispatches `.closePane`.
    case paneClosePending(PaneID)
    case layoutChanged
    case focusChanged(PaneID?)
    case statusChanged(PaneID)
    case attentionChanged
}

/// The reducer for one project workspace: owns the layout tree, pane states,
/// focus, and this project's attention items. Pure Swift — the AppKit layer
/// observes `StateChange`s and renders. Pane metadata is reconciled from
/// `hive workspace-feed` snapshots; pane content is a live terminal the UI
/// layer owns.
public final class ProjectState {
    public let projectID: ProjectID
    public let displayName: String
    public private(set) var layout: LayoutTree
    public private(set) var panes: [PaneID: PaneState] = [:]
    public private(set) var focusedPane: PaneID?
    public private(set) var orchestratorPane: PaneID?
    public private(set) var attention = AttentionQueue()

    /// Geometry used for deterministic insertion decisions. The window keeps
    /// this current; tests set it directly.
    public var layoutBounds: CGRect

    /// Acknowledged is UI-local state: the feed keeps reporting "done"/"failed"
    /// after the user has seen it, so the flag must survive re-application of
    /// identical snapshots and reset only when the status word changes.
    private var acknowledged: Set<PaneID> = []
    /// Agents the user closed, whose kill the daemon has not finished yet. The
    /// feed goes on listing a live agent until it is actually dead, so without
    /// this the snapshot that lands a second after the X rebuilds the pane the
    /// user just closed.
    private var userClosed: Set<PaneID> = []
    /// Close removal is scheduled only after a full feed confirms teardown.
    /// A user's close request is visible as `closing` while the provider still
    /// exists, but cannot remove its own visibility authority prematurely.
    private var closeRemovalScheduled: Set<PaneID> = []
    /// A terminated root terminal is direct process evidence. Once observed,
    /// a delayed feed snapshot must not paint the dead root healthy again.
    /// A new ProjectState is created for every Workspace relaunch, so this
    /// latch naturally resets when a new root process is started.
    private var orchestratorChildExited = false
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

    /// Stable pane identity for a feed agent. Namespaced so an agent that
    /// happens to be named "orchestrator" can never collide with the local
    /// orchestrator pane.
    public static func paneID(forAgent name: String) -> PaneID {
        PaneID("agent:\(name)")
    }

    public static let orchestratorPaneID = PaneID("orchestrator")
    public static let orchestratorVisibilityID = "root"
    public static let orchestratorRecipient = "queen"

    // MARK: Orchestrator pane (local, not feed-driven)

    /// The master pane is the selected orchestrator terminal, created by the
    /// window at open — the feed's `agents` array only describes worker agents.
    ///
    /// It is seeded "unknown" and NOT a status word of its own. It used to be
    /// seeded "running", a word that exists in no daemon vocabulary, which the
    /// dot's (correct) unknown-word rule degraded to gray — so the root, which is
    /// alive by definition whenever this app is running, showed a permanently
    /// gray "unknown" dot. The lesson is not "pick a better constant": ANY
    /// constant here is a fabrication. The real status arrives on the feed's
    /// `orchestrator` field and is applied below; until the first snapshot lands,
    /// "unknown" is the honest word, and gray is the honest colour.
    @discardableResult
    public func addOrchestrator(title: String = "Queen") -> [StateChange] {
        let paneID = ProjectState.orchestratorPaneID
        guard panes[paneID] == nil else { return [] }
        panes[paneID] = PaneState(
            id: paneID, kind: .orchestrator, title: title,
            feedStatus: "unknown", status: .running)
        layout.insert(paneID, in: layoutBounds)
        orchestratorPane = paneID
        var changes: [StateChange] = [.paneAdded(paneID), .layoutChanged]
        if focusedPane == nil {
            focusedPane = paneID
            changes.append(.focusChanged(paneID))
        }
        return changes
    }

    /// The Workspace's root child exited while its window was still open.
    /// This is stronger evidence than the last turn boundary: the provider is
    /// no longer attached, regardless of whether its last measured turn was
    /// idle or working. Keep the raw word explicit for the header and the
    /// semantic status disconnected for the shared visual legend.
    @discardableResult
    public func markOrchestratorExited(exitCode: Int32?) -> [StateChange] {
        let paneID = ProjectState.orchestratorPaneID
        guard var pane = panes[paneID] else { return [] }
        orchestratorChildExited = true
        let word = exitCode.map { "exited (code \($0))" } ?? "exited"
        guard pane.feedStatus != word || !isDisconnected(pane.status) else { return [] }
        pane.status = .disconnected(
            reason: word,
            lastConfirmed: pane.feedStatus)
        pane.feedStatus = word
        panes[paneID] = pane
        return [.statusChanged(paneID)]
    }

    // MARK: Feed reconciliation

    /// Reconciles one feed snapshot against the pane set:
    /// - unknown live agent → pane inserted (least-disruptive split)
    /// - known agent → metadata/status refreshed, attention transitions applied
    /// - `closedAt` present, or agent vanished from the snapshot → the pane is
    ///   marked close-pending exactly once; the UI closes it after the grace.
    /// - agents already closed (or "dead") that never had a pane are ignored.
    /// - the root's status (a separate field, since the root has no AgentRecord)
    ///   updates the orchestrator pane; nil means the daemon could not honestly
    ///   say, so the pane goes back to "unknown" rather than keeping a stale word.
    @discardableResult
    public func apply(feed agents: [AgentSnapshot],
                      orchestrator: OrchestratorSnapshot? = nil,
                      now: TimeInterval = Date().timeIntervalSince1970) -> [StateChange] {
        var changes: [StateChange] = []
        var seen: Set<PaneID> = []

        changes.append(contentsOf: applyOrchestrator(orchestrator))

        for agent in agents {
            let paneID = ProjectState.paneID(forAgent: agent.name)
            seen.insert(paneID)

            if agent.closedAt != nil {
                changes.append(contentsOf: markClosePending(paneID))
                userClosed.remove(paneID)
                continue
            }
            // The user closed this agent's pane; the agent itself keeps
            // running (#64: a pane close never kills), so the feed still lists
            // it as live. Building its pane again here is what made the X look
            // broken — the pane came back a second after it went away.
            if userClosed.contains(paneID) { continue }
            if var pane = panes[paneID] {
                changes.append(contentsOf: update(pane: &pane, from: agent, now: now))
                panes[paneID] = pane
            } else if agent.status != "dead" {
                // A dead agent's tmux session is gone; attaching would fail,
                // so a pane is only ever created for attachable agents.
                changes.append(contentsOf: insertPane(for: agent, now: now))
            }
        }

        // An agent that vanished without closedAt is treated as closed: the
        // snapshot is the full set of live agents.
        for (paneID, pane) in panes
        where pane.kind != .orchestrator && !seen.contains(paneID) {
            changes.append(contentsOf: markClosePending(paneID))
        }
        // An agent the daemon no longer reports is really gone: stop suppressing
        // it, so the set never grows without bound and a name that comes back
        // later (a new agent) gets its pane.
        userClosed.formIntersection(seen)
        return changes
    }

    /// The user closed this pane (the pane X, ⇧⌘W, or the accessibility
    /// action). Closing a pane never touches the agent (#64): it keeps running
    /// headless, so the feed keeps listing it live — and its pane must not be
    /// rebuilt from those snapshots while it does. The suppression clears when
    /// the daemon stops reporting the agent, so a later agent reusing the name
    /// gets a pane again.
    @discardableResult
    public func markUserClosed(_ paneID: PaneID) -> [StateChange] {
        userClosed.insert(paneID)
        return markClosePending(paneID, scheduleRemoval: false)
    }

    /** Full Workspace-owned terminal inventory. Every publication advances the
     revision, including unchanged heartbeat re-attestations after reconnect. */
    public func visibilityInventory(
        geometries: [PaneID: WorkspaceTerminalGeometry] = [:]
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
            if pane.kind == .orchestrator {
                switch pane.terminalHostState {
                case "running": visibilityState = .live
                case "exited": visibilityState = .exited
                case "failed": visibilityState = .failed
                default: visibilityState = .pending
                }
            } else if pane.closePending {
                visibilityState = .closing
            } else if pane.feedStatus == "spawning" {
                visibilityState = .pending
            } else if pane.feedStatus == "dead" {
                visibilityState = .exited
            } else if case .failed = pane.status {
                visibilityState = .failed
            } else if case .disconnected = pane.status {
                visibilityState = .reconnecting
            } else {
                visibilityState = .live
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

    /// The root's status word from one snapshot. A nil snapshot is the daemon
    /// saying it does not know (no turn events, or a self-contradicting record
    /// that means the root's hooks are not reaching it) — so the pane reverts to
    /// "unknown" and its dot goes gray. Reverting matters: holding the last known
    /// word would turn a lost signal into a confident stale claim, which is the
    /// exact failure this whole change exists to remove. It does not clear an
    /// already measured terminal locator; missing turn state is not host exit.
    private func applyOrchestrator(_ snapshot: OrchestratorSnapshot?) -> [StateChange] {
        let paneID = ProjectState.orchestratorPaneID
        guard var pane = panes[paneID] else { return [] }
        guard !orchestratorChildExited else { return [] }
        let word = snapshot?.status ?? "unknown"
        let previous = pane
        pane.feedStatus = word
        pane.status = FeedStatusMap.paneStatus(for: word)
        if let host = snapshot?.host {
            pane.sessionLocator = host == "sessiond" ? snapshot?.sessionLocator : nil
            pane.terminalHostState = host == "sessiond" ? snapshot?.hostState : nil
            if host == "sessiond", snapshot?.hostState == "failed" {
                pane.feedStatus = "failed"
                pane.status = .failed(acknowledged: false)
            }
        }
        guard pane != previous else { return [] }
        panes[paneID] = pane
        return [.statusChanged(paneID)]
    }

    private func isDisconnected(_ status: PaneStatus) -> Bool {
        if case .disconnected = status { return true }
        return false
    }

    /// The feed process died: statuses can no longer be trusted, so every pane
    /// turns gray dashed (disconnected). Terminals stay attached — only the
    /// metadata stream is gone.
    ///
    /// The orchestrator is included. It used to be exempt, which was right only
    /// while its status was a hardcoded constant: a constant cannot go stale, so
    /// there was nothing to invalidate. Now that its word is measured, a dead
    /// feed makes it exactly as untrustworthy as any agent's — the root may have
    /// started or finished ten turns since the last line we read — so it must go
    /// unknown with the rest. Its terminal is still live and still attached; what
    /// we have lost is not the root, only our knowledge of it, and those are
    /// different things to say.
    @discardableResult
    public func markFeedLost(reason: String = "workspace feed exited") -> [StateChange] {
        var changes: [StateChange] = []
        for (paneID, var pane) in panes {
            if case .disconnected = pane.status { continue }
            pane.status = .disconnected(reason: reason, lastConfirmed: pane.feedStatus)
            pane.feedStatus = "unknown"
            panes[paneID] = pane
            changes.append(.statusChanged(paneID))
        }
        return changes
    }

    private func insertPane(for agent: AgentSnapshot, now: TimeInterval) -> [StateChange] {
        let paneID = ProjectState.paneID(forAgent: agent.name)
        let pane = PaneState(
            id: paneID, kind: .agent, title: agent.name,
            tool: agent.tool, model: agent.model,
            feedStatus: agent.status,
            status: FeedStatusMap.paneStatus(for: agent.status),
            taskDescription: agent.taskDescription,
            tmuxSession: agent.tmuxSession,
            contextPct: agent.contextPct,
            agentID: agent.id,
            sessionLocator: agent.sessionLocator)
        var changes: [StateChange] = []
        panes[paneID] = pane
        layout.insert(paneID, in: layoutBounds)
        changes.append(.paneAdded(paneID))
        changes.append(.layoutChanged)
        // Creation never steals focus; the very first pane is the exception
        // because an empty workspace has nothing focused.
        if focusedPane == nil {
            focusedPane = paneID
            changes.append(.focusChanged(paneID))
        }
        changes.append(contentsOf: raiseAttention(for: pane, now: now))
        return changes
    }

    private func update(pane: inout PaneState, from agent: AgentSnapshot,
                        now: TimeInterval) -> [StateChange] {
        var changes: [StateChange] = []
        let statusWordChanged = pane.feedStatus != agent.status
        let headerChanged = statusWordChanged
            || pane.tool != agent.tool
            || pane.model != agent.model
            || pane.taskDescription != agent.taskDescription
            || pane.tmuxSession != agent.tmuxSession
            || pane.contextPct != agent.contextPct
            || pane.closePending

        pane.tool = agent.tool
        pane.model = agent.model
        pane.taskDescription = agent.taskDescription
        pane.tmuxSession = agent.tmuxSession
        pane.contextPct = agent.contextPct
        pane.agentID = agent.id
        pane.sessionLocator = agent.sessionLocator
        if pane.closePending {
            closeRemovalScheduled.remove(pane.id)
        }
        pane.closePending = false // a live snapshot revives a pending close

        if statusWordChanged {
            acknowledged.remove(pane.id)
            pane.feedStatus = agent.status
            pane.status = FeedStatusMap.paneStatus(for: agent.status)
            // Old attention is stale the moment the daemon reports a new
            // status; re-raise for the new one if it warrants attention.
            attention.resolveAll(paneID: pane.id, projectID: projectID)
            changes.append(contentsOf: raiseAttention(for: pane, now: now))
            changes.append(.attentionChanged)
        }
        if headerChanged {
            changes.append(.statusChanged(pane.id))
        }
        return changes
    }

    private func raiseAttention(for pane: PaneState, now: TimeInterval) -> [StateChange] {
        guard let severity = FeedStatusMap.attentionSeverity(for: pane.feedStatus) else {
            return []
        }
        attention.raise(AttentionItem(
            id: "status-\(pane.id.raw)", projectID: projectID, paneID: pane.id,
            severity: severity, title: "\(pane.title) \(pane.feedStatus)",
            detail: pane.taskDescription ?? pane.statusDescription, raisedAt: now))
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

    // MARK: Sanitized switcher card

    /// Sanitized card data for the project switcher: no terminal content.
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

    // MARK: Command dispatch (the one shared command model)

    @discardableResult
    public func apply(_ command: WorkspaceCommand) -> [StateChange] {
        switch command {
        case .focusPane(let paneID):
            guard panes[paneID] != nil, focusedPane != paneID else { return [] }
            focusedPane = paneID
            // Focus never acknowledges or clears attention.
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
