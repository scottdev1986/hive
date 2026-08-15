// ShellState.swift The shell's reducer-level state: which screen is active, what every screen's projection says, the attention queue, and the outcome of the last command. Views render this value; the dispatcher is the only writer, so a screen can never show a route the state did not select.

import Foundation

/// What one dispatched command did. Commands are never silent: every dispatch lands in exactly one of these, and the last one stays visible in state.
public enum ShellCommandOutcome: Equatable, Sendable {
    case routed(ShellRoute)
    /// A typed intent went through the envelope and came back with a result — accepted or rejected, always with the observed post-state.
    case mutationResolved(MutationResult<ShellMutationPostState>)
    case localPerformed(ShellCommand)
    /// The command's surface is not in this build; the reason is shown, never a stub success and never a greyed-out fake.
    case surfaceUnavailable(ShellCommand, reason: String)
}

public struct ShellState: Equatable {
    public private(set) var activeRoute: ShellRoute
    public private(set) var attentionDrawerVisible: Bool
    public private(set) var inspectorVisible: Bool
    public private(set) var inspectorTab: ShellInspectorTab
    public private(set) var inspector: InspectorProjection?
    public private(set) var attentionQueue: AttentionQueue
    public private(set) var screens: [ShellRoute: ShellScreenProjection]
    /// The routing policy both Model Control screens write, carrying the router screen's draft. One document, one revision, one compare-and-set token — nil until a policy has actually been observed.
    public private(set) var router: TaskRouterEditor?
    public private(set) var modelControl: ModelControlSnapshot?
    public private(set) var modelControlView: WorkspaceModelControlView?
    public private(set) var queenProvider: QueenProviderEditor?
    /// The observed values behind the four Memory screens. Empty until a daemon read produced one.
    public private(set) var memory: MemoryScreensState
    public private(set) var outerHorizon: OuterHorizonScreenState?
    /// A Live Run read refusal is not transport loss. The last hierarchy remains on screen and this warning names the refused replacement.
    public private(set) var outerHorizonWarning: ShellBanner?
    /// The daemon's last refusal of a Model Control write. A refusal changed nothing observed, so it is kept apart from the projection: the screen says the write was refused instead of claiming the daemon is gone.
    public private(set) var policyWriteRefusal: String?
    /// The workspace observation mutations compare against: the Live Run snapshot's source. Nothing else is a sound CAS token for a shell intent.
    public private(set) var workspaceSource: ProjectionSource
    public private(set) var lastOutcome: ShellCommandOutcome?

    public init(
        activeRoute: ShellRoute = .liveRun,
        attentionDrawerVisible: Bool = false,
        inspectorVisible: Bool = false,
        inspectorTab: ShellInspectorTab = .task,
        inspector: InspectorProjection? = nil,
        attentionQueue: AttentionQueue = AttentionQueue(),
        screens: [ShellRoute: ShellScreenProjection] = [:],
        router: TaskRouterEditor? = nil,
        modelControl: ModelControlSnapshot? = nil,
        modelControlView: WorkspaceModelControlView? = nil,
        queenProvider: QueenProviderEditor? = nil,
        memory: MemoryScreensState = MemoryScreensState(),
        outerHorizon: OuterHorizonScreenState? = nil,
        outerHorizonWarning: ShellBanner? = nil,
        policyWriteRefusal: String? = nil,
        workspaceSource: ProjectionSource = ProjectionSource(),
        lastOutcome: ShellCommandOutcome? = nil
    ) {
        self.activeRoute = activeRoute
        self.attentionDrawerVisible = attentionDrawerVisible
        self.inspectorVisible = inspectorVisible
        self.inspectorTab = inspectorTab
        self.inspector = inspector
        self.attentionQueue = attentionQueue
        self.screens = screens
        self.router = router
        self.modelControlView = modelControlView
        self.modelControl = modelControlView?.snapshot ?? modelControl
        self.queenProvider = queenProvider
        self.memory = memory
        self.outerHorizon = outerHorizon
        self.outerHorizonWarning = outerHorizonWarning
        self.policyWriteRefusal = policyWriteRefusal
        self.workspaceSource = workspaceSource
        self.lastOutcome = lastOutcome
    }

    public mutating func navigate(to route: ShellRoute) {
        activeRoute = route
    }

    public mutating func setAttentionDrawer(visible: Bool) {
        attentionDrawerVisible = visible
    }

    public mutating func setInspector(visible: Bool) {
        inspectorVisible = visible
    }

    public mutating func selectInspectorTab(_ tab: ShellInspectorTab) {
        inspectorTab = tab
    }

    public mutating func apply(inspector projection: InspectorProjection?) {
        inspector = projection
    }

    public mutating func refresh(inspector projection: InspectorProjection?) {
        inspector = ShellInspectorPresenter.retainingObservedValue(
            from: inspector,
            on: projection)
    }

    public mutating func apply(screen: ShellScreenProjection, for route: ShellRoute) {
        screens[route] = screen
        if route == .liveRun {
            workspaceSource = screen.source
        }
    }

    public mutating func apply(attention queue: AttentionQueue) {
        attentionQueue = queue
    }

    public mutating func apply(router editor: TaskRouterEditor?) {
        router = editor
    }

    public mutating func apply(modelControl snapshot: ModelControlSnapshot?) {
        modelControl = snapshot
        modelControlView = nil
    }

    public mutating func apply(modelControl view: WorkspaceModelControlView?) {
        modelControlView = view
        modelControl = view?.snapshot
    }

    public mutating func apply(queenProvider editor: QueenProviderEditor?) {
        queenProvider = editor
    }

    public mutating func editMemory(_ edit: (inout MemoryScreensState) -> Void) {
        edit(&memory)
    }

    /// Takes refreshed Memory observations into the values on screen. A read that
    /// produced nothing keeps the last observed value: the screen's own
    /// availability already says the read failed, and dropping the value would
    /// turn a refusal into an empty store.
    public mutating func refresh(memory refreshed: MemoryScreensState) {
        if let overview = refreshed.overview { memory.overview = overview }
        if let recall = refreshed.recall { memory.recall = recall }
        if let maintenance = refreshed.maintenance { memory.maintenance = maintenance }
        if let library = refreshed.library {
            observe(
                libraryPage: library.page,
                from: library.project,
                step: library.trail.last ?? .first)
        }
    }

    /// Takes one observed library page into the walk on screen. A page for
    /// another project replaces the walk rather than extending it, because a
    /// cursor only means anything to the store that minted it.
    public mutating func observe(
        libraryPage page: MemoryLibraryProjection,
        from project: ProjectID,
        step: MemoryLibraryStep
    ) {
        memory.observe(page: page, from: project, step: step)
    }

    /// Installs a new hierarchy observation without replacing selection or expansion history. Passing nil explicitly clears the hierarchy; refusal gateways retain any prior observation before this boundary.
    public mutating func apply(
        outerHorizon snapshot: OuterHorizonSnapshot?,
        warning: ShellBanner?
    ) {
        if let snapshot {
            if outerHorizon == nil {
                outerHorizon = OuterHorizonScreenState(snapshot: snapshot)
            } else {
                outerHorizon?.observe(snapshot)
            }
        } else {
            outerHorizon = nil
        }
        outerHorizonWarning = warning
    }

    /// Accepts one Live Run read against the hierarchy held at this write. This is the final-write fence: overlapping refreshes cannot install a same-instance snapshot whose sequence is no newer than current state.
    public mutating func acceptOuterHorizon(
        screen: ShellScreenProjection,
        snapshot: OuterHorizonSnapshot?,
        warning: ShellBanner?
    ) {
        let retainsHeldValue: Bool
        switch screen.evidence {
        case .refused, .unauthorized, .protocolDrift, .disconnected:
            retainsHeldValue = true
        case .conflicting, .replaced, nil:
            retainsHeldValue = false
        }
        if retainsHeldValue,
           outerHorizon != nil {
            let heldScreen = screens[.liveRun]
            apply(screen: ShellScreenProjection(
                availability: screen.availability,
                freshness: screen.freshness,
                source: heldScreen?.source ?? screen.source,
                observedAt: heldScreen?.observedAt ?? screen.observedAt,
                evidence: screen.evidence,
                contract: screen.contract,
                facts: heldScreen?.facts ?? screen.facts), for: .liveRun)
            outerHorizonWarning = warning
            return
        }

        if let held = outerHorizon?.snapshot,
           let snapshot,
           held.instanceId == snapshot.instanceId,
           let heldSeq = UInt64(held.seq),
           let incomingSeq = UInt64(snapshot.seq),
           incomingSeq <= heldSeq {
            return
        }

        apply(screen: screen, for: .liveRun)
        if let held = outerHorizon?.snapshot,
           let snapshot,
           held.instanceId != snapshot.instanceId {
            outerHorizon = OuterHorizonScreenState(snapshot: snapshot)
            outerHorizonWarning = warning
        } else {
            apply(outerHorizon: snapshot, warning: warning)
        }
    }

    public mutating func editOuterHorizon(
        _ edit: (inout OuterHorizonScreenState) -> Void
    ) {
        guard var horizon = outerHorizon else { return }
        edit(&horizon)
        outerHorizon = horizon
    }

    public mutating func editQueenProvider(_ edit: (inout QueenProviderEditor) -> Void) {
        guard var editor = queenProvider else { return }
        edit(&editor)
        queenProvider = editor
    }

    /// Same contract as the router's refresh: a new observation goes INTO the editor on screen so an unsent selection survives, a read that produced nothing fences rather than dropping it, and a current read clears the warning that asked for it.
    public mutating func refresh(queenProvider refreshed: QueenProviderEditor?) {
        guard let refreshed else {
            editQueenProvider { $0.fence() }
            return
        }
        if queenProvider == nil {
            queenProvider = refreshed
        } else {
            editQueenProvider { $0.observe(refreshed) }
        }
        if refreshed.mutationsAllowed {
            policyWriteRefusal = nil
        }
    }

    public mutating func editRouter(_ edit: (inout TaskRouterEditor) -> Void) {
        guard var editor = router else { return }
        edit(&editor)
        router = editor
    }

    public mutating func record(policyWriteRefusal refusal: String?) {
        policyWriteRefusal = refusal
    }

    /// Takes a refreshed observation into the editor already on screen, keeping any unapplied draft. A refresh that produced no policy leaves the editor in place and fenced rather than dropping the user's edit with it. A current read is exactly what an unknown-outcome warning asked for, so it clears here: the shell must never both permit a write and claim a refresh is still required.
    public mutating func refresh(router refreshed: TaskRouterEditor?) {
        guard let refreshed else {
            editRouter { $0.fence() }
            return
        }
        if router == nil {
            router = refreshed
        } else {
            editRouter { $0.observe(refreshed) }
        }
        if refreshed.mutationsAllowed {
            policyWriteRefusal = nil
        }
    }

    public mutating func record(outcome: ShellCommandOutcome) {
        lastOutcome = outcome
    }

    public var activeScreen: ShellScreenProjection? {
        screens[activeRoute]
    }

    /// The CAS token an intent compares against, derived from the observed workspace source. nil means nothing has been observed — and a mutation with nothing to compare must not be sent at all.
    public var mutationExpectation: MutationExpectation? {
        switch (workspaceSource.revision, workspaceSource.generation) {
        case let (revision?, generation?) where !revision.isEmpty:
            return .revisionAndEpoch(revision: revision, epoch: String(generation))
        case let (revision?, nil) where !revision.isEmpty:
            return .revision(revision)
        case let (nil, generation?):
            return .epoch(String(generation))
        default:
            return nil
        }
    }

    public var commandBanner: ShellBanner? {
        if let policyWriteRefusal {
            return ShellBanner(severity: .warning, text: policyWriteRefusal)
        }
        switch lastOutcome {
        case .mutationResolved(let result):
            switch result.outcome {
            case .accepted:
                return ShellBanner(
                    severity: .info,
                    text: "The daemon accepted "
                        + "\(result.observedPostState.command.title).")
            case .rejected(let failure):
                return ShellBanner(
                    severity: .warning,
                    text: failure.message)
            }
        case .surfaceUnavailable(let command, let reason):
            return ShellBanner(
                severity: .info,
                text: "\(command.title): \(reason)")
        case .routed, .localPerformed, nil:
            return nil
        }
    }
}
