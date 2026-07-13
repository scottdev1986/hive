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
    private let daemonPort: Int
    private let orchestrator: String
    private let orchestratorSession: String?
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
         projectDirectory: String, hivePath: String, daemonPort: Int,
         orchestrator: String, orchestratorSession: String?) {
        self.state = state
        self.attentionCenter = attentionCenter
        self.projectDirectory = projectDirectory
        self.hivePath = hivePath
        self.daemonPort = daemonPort
        self.orchestrator = orchestrator
        self.orchestratorSession = orchestratorSession

        let window = WorkspaceWindow(
            contentRect: NSRect(x: 120, y: 80, width: 1280, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = state.displayName
        window.subtitle = "Hive Workspace"
        window.tabbingMode = .disallowed
        window.minSize = NSSize(width: 720, height: 480)

        super.init(window: window)
        window.delegate = self
        // AppKit posts no notification when the first responder moves, so the
        // window tells us itself. This is the signal the indicator rides on:
        // clicks, ⌃⌘-arrow focus moves, a closed pane handing focus back, and
        // SwiftTerm grabbing the keyboard on its own mouseDown all pass through
        // makeFirstResponder — and only through makeFirstResponder.
        window.onFirstResponderChange = { [weak self] in
            self?.refreshFocusIndicators()
        }
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
    func applyFeed(_ agents: [AgentSnapshot], orchestrator: OrchestratorSnapshot? = nil) {
        react(to: state.apply(feed: agents, orchestrator: orchestrator))
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
        let scrollSession = terminalScrollSession(
            for: pane,
            orchestratorSession: orchestratorSession)
        let allowsMouseReporting = terminalAllowsMouseReporting(for: pane)
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
    /// - master: the private Workspace boundary starts the selected
    ///   orchestrator and attaches its tmux session.
    /// - agent: a plain tmux attach client for the daemon-owned session;
    ///   killing it later merely detaches.
    private func terminalCommand(for pane: PaneState) -> String {
        switch pane.kind {
        case .orchestrator:
            return "exec \(shellQuoted(hivePath)) workspace-orchestrator --tool \(shellQuoted(orchestrator)) --port \(daemonPort)"
        case .agent:
            let session = pane.tmuxSession ?? pane.title
            let target = shellQuoted("=\(session):")
            return "until tmux has-session -t \(target) 2>/dev/null; do sleep 0.5; done; "
                + "exec tmux attach-session -t \(shellQuoted(session))"
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
        if let paneID, let view = paneViews[paneID] {
            // Keystrokes go to the pane's pty — that is the product's
            // message-sending path (typing into the native TUIs). Making the
            // terminal first responder is what moves the indicator: the ring
            // follows the keyboard, not this call.
            view.contentView.focusTerminal()
        }
        refreshFocusIndicators()
    }

    /// The one place the active-pane indicator is computed, and it is computed
    /// from the window itself: which pane owns the first responder, and whether
    /// the window is key. Never from the last click — a ring that says "you are
    /// typing here" while the keystrokes go elsewhere is worse than no ring.
    ///
    /// Called on every first-responder change (`WorkspaceWindow` below) and
    /// whenever the window takes or loses key.
    private func refreshFocusIndicators() {
        let windowIsKey = window?.isKeyWindow ?? false
        let responderPane = paneOwningFirstResponder()
        for (id, view) in paneViews {
            view.setFocusIndicator(paneFocusIndicator(
                pane: id, firstResponderPane: responderPane, windowIsKey: windowIsKey))
        }
        // Keep the model honest too: SwiftTerm takes first responder on its own
        // mouseDown, so the keyboard can land in a pane the reducer has not been
        // told about. Menu commands ("Close Focused Pane") must act on the pane
        // the user is actually typing into.
        if let responderPane, responderPane != state.focusedPane {
            dispatch(.focusPane(responderPane))
        }
    }

    private func paneOwningFirstResponder() -> PaneID? {
        guard let responder = window?.firstResponder as? NSView else { return nil }
        return paneViews.first { responder.isDescendant(of: $0.value) }?.key
    }

    // A non-key window still has a first responder; the pane keeps its ring, but
    // the ring goes quiet, because nothing is being typed into it.
    func windowDidBecomeKey(_ notification: Notification) {
        refreshFocusIndicators()
    }

    func windowDidResignKey(_ notification: Notification) {
        refreshFocusIndicators()
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

    /// Delivers a wheel event to the running terminal pane through the same
    /// routing method as the AppKit event monitor.
    @discardableResult
    func postScrollWheel(deltaY: CGFloat, pane: PaneID) -> Bool {
        guard let contentView = paneViews[pane]?.contentView else { return false }
        guard let cgEvent = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 1,
            wheel1: Int32(deltaY),
            wheel2: 0,
            wheel3: 0),
              let event = NSEvent(cgEvent: cgEvent)
        else { return false }
        return contentView.submitScroll(
            event,
            locationInTerminal: CGPoint(
                x: contentView.terminal.bounds.midX,
                y: contentView.terminal.bounds.midY))
    }

    func terminalChildRunning(pane: PaneID) -> Bool {
        paneViews[pane]?.contentView.childRunning ?? false
    }

    /// Delivers a real left-click at the pane's center through the window's own
    /// event dispatch — the same path a user's click takes: hit-testing, the
    /// pane's click recognizer, and SwiftTerm taking first responder itself.
    @discardableResult
    func postClick(pane: PaneID) -> Bool {
        guard let view = paneViews[pane], let window else { return false }
        let center = view.convert(
            CGPoint(x: view.bounds.midX, y: view.bounds.midY), to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            guard let event = NSEvent.mouseEvent(
                with: type, location: center, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil,
                eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)
            else { return false }
            window.sendEvent(event)
        }
        return true
    }

    /// What the pane is actually showing — read back from the view, not from the
    /// reducer, so a test cannot pass on intent alone.
    func focusIndicator(pane: PaneID) -> PaneFocusIndicator {
        paneViews[pane]?.currentFocusIndicator ?? .none
    }

    /// Which pane really owns the keyboard right now.
    func firstResponderPane() -> PaneID? {
        paneOwningFirstResponder()
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

/// The project window. Its one addition to NSWindow is honesty about focus:
/// `makeFirstResponder` is the single funnel every focus change in AppKit goes
/// through, so overriding it is how the app learns where the keyboard actually
/// went — including the moves it never asked for.
final class WorkspaceWindow: NSWindow {

    var onFirstResponderChange: (() -> Void)?

    override func makeFirstResponder(_ responder: NSResponder?) -> Bool {
        let changed = super.makeFirstResponder(responder)
        if changed { onFirstResponderChange?() }
        return changed
    }
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
