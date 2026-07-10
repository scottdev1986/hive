import AppKit
import WorkspaceCore

/// One project's workspace window: owns the pane views (real terminals),
/// applies reducer changes, and is the single dispatch point for the shared
/// command model. Menu items and shortcuts reach it through the responder
/// chain, so the key window owns routing exactly as the blueprint requires.
final class ProjectWindowController: NSWindowController, NSWindowDelegate {

    let state: ProjectState
    private let attentionCenter: AttentionCenter
    private let projectDirectory: String
    private let hivePath: String
    private let container = LayoutContainerView()
    private let animator = LayoutAnimator()
    private var paneViews: [PaneID: PaneView] = [:]
    private var pendingCloses: Set<PaneID> = []

    /// Set by the app delegate to tear the feed down with the window (the
    /// app usually quits on last-window-close, but a floating panel can keep
    /// it alive — the feed must die with the window regardless, so the daemon
    /// gets its external viewers back).
    var onWindowWillClose: (() -> Void)?

    var paneViewCount: Int { paneViews.count }

    init(state: ProjectState, attentionCenter: AttentionCenter,
         projectDirectory: String, hivePath: String) {
        self.state = state
        self.attentionCenter = attentionCenter
        self.projectDirectory = projectDirectory
        self.hivePath = hivePath

        let window = NSWindow(
            contentRect: NSRect(x: 120, y: 80, width: 1280, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = state.displayName
        window.subtitle = "Hive Workspace"
        window.tabbingMode = .disallowed
        window.minSize = NSSize(width: 720, height: 480)

        super.init(window: window)
        window.delegate = self
        attentionCenter.register(state: state)

        let background = NSVisualEffectView()
        background.material = .underWindowBackground
        background.blendingMode = .behindWindow
        background.state = .followsWindowActiveState
        window.contentView = background

        container.translatesAutoresizingMaskIntoConstraints = false
        background.addSubview(container)
        NSLayoutConstraint.activate([
            container.topAnchor.constraint(equalTo: background.topAnchor, constant: 10),
            container.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 10),
            container.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -10),
            container.bottomAnchor.constraint(equalTo: background.bottomAnchor, constant: -10),
        ])
        container.onBoundsChanged = { [weak self] in
            guard let self else { return }
            self.state.layoutBounds = self.container.bounds
            // Window resize commits immediately; the animated path is for
            // tree changes, not live window resizing.
            self.applyLayout(animated: false)
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: Entry points

    /// Creates the master pane and starts the orchestrator terminal.
    func bootstrapOrchestrator() {
        react(to: state.addOrchestrator(title: state.displayName))
    }

    /// Commits the first real window geometry after presentation. Bootstrap
    /// happens before `showWindow`, when the container may still be 0×0; do
    /// not rely on AppKit subsequently reporting a bounds change to launch the
    /// deferred terminal child. A snapped layout here gives SwiftTerm the
    /// visible pane's settled dimensions and deterministically starts it.
    func commitInitialGeometry() {
        window?.layoutIfNeeded()
        state.layoutBounds = container.bounds
        applyLayout(animated: false)
    }

    /// One feed snapshot in, pane set reconciled.
    func applyFeed(_ agents: [AgentSnapshot]) {
        react(to: state.apply(feed: agents))
    }

    /// The feed process exited: agent statuses can no longer be trusted.
    func feedLost() {
        react(to: state.markFeedLost())
    }

    /// The one shared command entry: menu items, keyboard shortcuts, clicks,
    /// double-clicks, and accessibility actions all end here.
    func dispatch(_ command: WorkspaceCommand) {
        react(to: state.apply(command))
    }

    private func react(to changes: [StateChange]) {
        for change in changes {
            switch change {
            case .paneAdded(let paneID):
                addPaneView(for: paneID)
            case .paneRemoved(let paneID):
                pendingCloses.remove(paneID)
                if let view = paneViews.removeValue(forKey: paneID) {
                    view.contentView.terminateChild() // detaches the tmux client, never the session
                    view.removeFromSuperview()
                }
            case .paneClosePending(let paneID):
                scheduleGracefulClose(paneID)
            case .layoutChanged:
                applyLayout(animated: true)
            case .focusChanged(let paneID):
                applyFocus(paneID)
            case .statusChanged(let paneID):
                if let pane = state.panes[paneID] {
                    paneViews[paneID]?.update(state: pane)
                }
            case .attentionChanged:
                attentionCenter.refresh()
            }
        }
    }

    // MARK: Pane management

    private func addPaneView(for paneID: PaneID) {
        guard let pane = state.panes[paneID] else { return }
        let scrollSession = pane.kind == .agent ? pane.tmuxSession : nil
        let allowsMouseReporting = pane.kind != .orchestrator
        let view = PaneView(
            paneID: paneID,
            title: pane.title,
            tmuxSession: scrollSession,
            allowsMouseReporting: allowsMouseReporting) { [weak self] command in
            self?.dispatch(command)
        }
        view.update(state: pane)
        view.contentView.schedule(
            command: terminalCommand(for: pane),
            workingDirectory: projectDirectory)
        paneViews[paneID] = view
        container.addSubview(view)
        // New panes appear at their final slot's center and grow into place;
        // creation must be visible but never steal focus.
        if let target = state.frames(in: container.bounds)[paneID] {
            view.frame = CGRect(x: target.midX, y: target.midY, width: 0, height: 0)
        }
    }

    /// What runs inside a pane's pty:
    /// - master: `hive claude` attaches to the orchestrator's tmux session
    ///   with `-A`, so relaunching the app reattaches instead of duplicating.
    /// - agent: a plain tmux attach client for the daemon-owned session;
    ///   killing it later merely detaches.
    private func terminalCommand(for pane: PaneState) -> String {
        switch pane.kind {
        case .orchestrator:
            return "exec \(shellQuoted(hivePath)) claude"
        case .agent:
            let session = pane.tmuxSession ?? pane.title
            return "exec tmux attach-session -t \(shellQuoted(session))"
        }
    }

    /// A closed agent keeps its pane (final status border) for the grace
    /// window, then the close flows through the same command model as ⇧⌘W.
    private func scheduleGracefulClose(_ paneID: PaneID) {
        guard !pendingCloses.contains(paneID) else { return }
        pendingCloses.insert(paneID)
        DispatchQueue.main.asyncAfter(deadline: .now() + PaneCloseGrace.seconds) { [weak self] in
            guard let self, self.pendingCloses.contains(paneID) else { return }
            self.pendingCloses.remove(paneID)
            // A live snapshot may have revived the agent during the grace.
            guard self.state.panes[paneID]?.closePending == true else { return }
            self.dispatch(.closePane(paneID))
        }
    }

    private func applyLayout(animated: Bool) {
        let frames = state.frames(in: container.bounds)
        let pairs: [(NSView, CGRect)] = frames.compactMap { paneID, frame in
            paneViews[paneID].map { ($0, frame) }
        }
        animator.animate(views: pairs, reduceMotion: !animated || Theme.reduceMotion) { [weak self] in
            // Terminal-cell geometry commits exactly once, at the end.
            self?.paneViews.values.forEach { $0.commitCellGeometry() }
        }
    }

    private func applyFocus(_ paneID: PaneID?) {
        for (id, view) in paneViews {
            view.setFocused(id == paneID)
        }
        if let paneID, let view = paneViews[paneID] {
            // Keystrokes go to the pane's pty — that is the product's
            // message-sending path (typing into the native TUIs).
            view.contentView.focusTerminal()
        }
    }

    /// Detaches every terminal (SIGTERM to attach clients / the orchestrator
    /// CLI). Agents keep running: their processes live in daemon-owned tmux
    /// sessions, and a viewer must never kill them.
    func terminateAllTerminals() {
        for view in paneViews.values {
            view.contentView.terminateChild()
        }
    }

    func windowWillClose(_ notification: Notification) {
        terminateAllTerminals()
        onWindowWillClose?()
    }

    // MARK: Smoke-test introspection

    func currentPaneFrames() -> [PaneID: CGRect] {
        state.frames(in: container.bounds)
    }

    func terminalText(pane: PaneID) -> String {
        paneViews[pane]?.contentView.visibleText ?? ""
    }

    func sendText(_ text: String, pane: PaneID) {
        paneViews[pane]?.contentView.send(text: text)
    }

    func terminalChildRunning(pane: PaneID) -> Bool {
        paneViews[pane]?.contentView.childRunning ?? false
    }

    // MARK: Menu actions (responder chain; same command model)

    @objc func promoteFocusedPane(_ sender: Any?) {
        guard let focused = state.focusedPane else { return }
        dispatch(.promotePane(focused))
    }

    @objc func returnOrchestratorToMaster(_ sender: Any?) {
        dispatch(.returnOrchestratorToMaster)
    }

    @objc func closeFocusedPane(_ sender: Any?) {
        guard let focused = state.focusedPane else { return }
        dispatch(.closePane(focused))
    }

    @objc func acknowledgeFocusedPane(_ sender: Any?) {
        guard let focused = state.focusedPane else { return }
        dispatch(.acknowledgePane(focused))
    }

    @objc func focusOrchestrator(_ sender: Any?) {
        dispatch(.focusOrchestrator)
    }

    @objc func moveFocusLeft(_ sender: Any?) { dispatch(.moveFocus(.left)) }
    @objc func moveFocusRight(_ sender: Any?) { dispatch(.moveFocus(.right)) }
    @objc func moveFocusUp(_ sender: Any?) { dispatch(.moveFocus(.up)) }
    @objc func moveFocusDown(_ sender: Any?) { dispatch(.moveFocus(.down)) }
}

extension ProjectWindowController: NSMenuItemValidation {
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(promoteFocusedPane(_:)):
            return state.focusedPane != nil && state.focusedPane != state.layout.master
        case #selector(returnOrchestratorToMaster(_:)):
            return state.orchestratorPane != nil && state.layout.master != state.orchestratorPane
        case #selector(closeFocusedPane(_:)), #selector(acknowledgeFocusedPane(_:)):
            return state.focusedPane != nil
        case #selector(focusOrchestrator(_:)):
            return state.orchestratorPane != nil
        default:
            return true
        }
    }
}
