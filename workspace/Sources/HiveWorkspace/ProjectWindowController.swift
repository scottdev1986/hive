import AppKit
import HiveTerminalKit
import WorkspaceCore

final class ProjectWindowController: NSWindowController, NSWindowDelegate {

    let state: ProjectState
    private let attentionCenter: AttentionCenter
    private let hivePath: String
    private let daemonPort: Int
    private let instanceHome: String
    private let container = LayoutContainerView()
    private let animator = LayoutAnimator()
    private var paneViews: [PaneID: PaneView] = [:]
    private var pendingCloses: Set<PaneID> = []
    private var pendingAdmissions: [PaneID] = []
    private var admissionDrainScheduled = false
    private var admittedThisTurn = 0
    private var feedFailureWindow: NSWindow?
    private var isClosing = false

    /// Set by the app delegate to tear the feed down with the window (the app usually quits on last-window-close, but a floating panel can keep it alive, and the status reader must not outlive its project surface).
    var onWindowWillClose: (() -> Void)?
    var onStateChange: (() -> Void)?

    var paneViewCount: Int { paneViews.count }

    init(state: ProjectState, attentionCenter: AttentionCenter,
         hivePath: String, daemonPort: Int, instanceHome: String) {
        self.state = state
        self.attentionCenter = attentionCenter
        self.hivePath = hivePath
        self.daemonPort = daemonPort
        self.instanceHome = instanceHome

        let window = WorkspaceWindow(
            contentRect: NSRect(x: 120, y: 80, width: 1280, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Hive Workspace - \(state.displayName)"
        window.tabbingMode = .disallowed
        window.minSize = NSSize(width: 720, height: 480)

        super.init(window: window)
        window.delegate = self
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
            self.applyLayout(animated: false)
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func prepareInitialLayout() {
        react(to: state.addOrchestrator(title: state.displayName))
    }

    /// Commits the first real window geometry after presentation. Bootstrap happens before `showWindow`, when the container may still be 0×0; do not rely on AppKit subsequently reporting a bounds change to launch the terminal surface. A snapped layout here gives it settled dimensions.
    func commitInitialGeometry() {
        window?.contentView?.layoutSubtreeIfNeeded()
        window?.layoutIfNeeded()
        container.layoutSubtreeIfNeeded()
        state.layoutBounds = container.bounds
        applyLayout(animated: false)
    }

    func applyFeed(_ agents: [AgentSnapshot], orchestrator: OrchestratorSnapshot? = nil) {
        react(to: state.apply(feed: agents, orchestrator: orchestrator))
    }

    func feedLost() {
        react(to: state.markFeedLost())
    }

    func dispatch(_ command: WorkspaceCommand) {
        // Never kill an agent when closing its pane: terminal lifecycle is decoupled from agent lifecycle, so the view goes away and the agent runs on headless. The userClosed suppression keeps the feed from rebuilding the pane while that agent is still listed live — ending an agent is the daemon's job, reached through hive_kill or `hive kill`, never through a pane or window close.
        if case .closePane(let paneID) = command,
           let pane = state.panes[paneID], pane.kind == .agent {
            _ = state.markUserClosed(paneID)
        }
        react(to: state.apply(command))
    }

    /// The pane goes away because the agent is already gone (the feed said so), so this close must NOT kill anything — it is the reducer's bookkeeping, not the user's command.
    private func removeClosedPane(_ paneID: PaneID) {
        react(to: state.apply(.closePane(paneID)))
    }

    func reportFeedFailure(reason: String) {
        feedFailureWindow?.close()
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Workspace feed contract failed"
        alert.informativeText = reason
        alert.addButton(withTitle: "OK")
        feedFailureWindow = alert.window
        alert.window.makeKeyAndOrderFront(nil)
    }

    private func react(to changes: [StateChange]) {
        guard !changes.isEmpty else { return }
        admittedThisTurn = 0
        for change in changes {
            switch change {
            case .paneAdded(let paneID):
                admitPane(paneID)
            case .paneRemoved(let paneID):
                pendingCloses.remove(paneID)
                if let view = paneViews.removeValue(forKey: paneID) {
                    view.sessiondTerminal?.detach() // renderer detach, never close
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
                    installSessiondTerminalIfNeeded(for: paneID)
                }
            case .attentionChanged:
                attentionCenter.refresh()
            }
        }
        onStateChange?()
    }

    /// One feed snapshot can announce every agent at once — a fan-out spawn reports thirty-two in a single line. Building all of them here would run thirty-two `PaneView` constructions and thirty-two Ghostty surface creations back to back inside ONE main-queue turn, and every click, keystroke and pane redraw queues behind that turn. Measured with the real UI on real sessiond sessions (prototypes/workspace-fanout): thirty-two agents arriving in one snapshot stalled the main queue for ~400 ms, about two seconds after the snapshot landed. Spreading the identical work across turns is what removes it — the same total work, just never all in one turn. Panes are admitted in arrival order, so the workspace fills in the order the daemon reported the agents rather than in an order the run loop happened to produce. The first slice of a snapshot is built INLINE, so a workspace that gains one or two agents — every ordinary case, and every case the pane contract tests assert — still has its views the moment `applyFeed` returns. Only the surplus of an unusually wide snapshot is deferred, because that case exceeds one turn's budget.
    private func admitPane(_ paneID: PaneID) {
        guard pendingAdmissions.isEmpty, admittedThisTurn < Self.paneAdmissionsPerTurn else {
            pendingAdmissions.append(paneID)
            scheduleAdmissionDrain()
            return
        }
        admittedThisTurn += 1
        addPaneView(for: paneID)
    }

    private func scheduleAdmissionDrain() {
        guard !admissionDrainScheduled, !pendingAdmissions.isEmpty else { return }
        admissionDrainScheduled = true
        DispatchQueue.main.async { [weak self] in
            self?.drainAdmissions()
        }
    }

    private func drainAdmissions() {
        admissionDrainScheduled = false
        admittedThisTurn = 0
        guard !pendingAdmissions.isEmpty else { return }
        for _ in 0 ..< Self.paneAdmissionsPerTurn where !pendingAdmissions.isEmpty {
            addPaneView(for: pendingAdmissions.removeFirst())
        }
        applyLayout(animated: true)
        onStateChange?()
        scheduleAdmissionDrain()
    }

    private static let paneAdmissionsPerTurn = 4

    private func addPaneView(for paneID: PaneID) {
        guard state.panes[paneID] != nil else { return }
        guard let pane = state.panes[paneID] else { return }
        let view = PaneView(
            paneID: paneID,
            title: pane.title) { [weak self] command in
            self?.dispatch(command)
        }
        view.update(state: pane)
        paneViews[paneID] = view
        installSessiondTerminalIfNeeded(for: paneID)
        container.addSubview(view)
        // New panes appear at their final slot's center and grow into place; creation must be visible but never steal focus.
        if let target = state.frames(in: container.bounds)[paneID] {
            view.frame = CGRect(x: target.midX, y: target.midY, width: 0, height: 0)
        }
    }

    private func installSessiondTerminalIfNeeded(for paneID: PaneID) {
        guard let pane = state.panes[paneID],
              let view = paneViews[paneID],
              let locator = pane.sessionLocator,
              locator.hostKind == "sessiond" else { return }
        let recipient = pane.kind == .orchestrator
            ? ProjectState.orchestratorRecipient : pane.title
        view.installSessiondTerminal(
            SessiondPaneTerminal(
                agentName: recipient,
                locator: locator,
                hivePath: hivePath,
                daemonPort: daemonPort,
                instanceHome: instanceHome))
    }

    private func scheduleGracefulClose(_ paneID: PaneID) {
        guard !pendingCloses.contains(paneID) else { return }
        pendingCloses.insert(paneID)
        DispatchQueue.main.asyncAfter(deadline: .now() + PaneCloseGrace.seconds) { [weak self] in
            guard let self, self.pendingCloses.contains(paneID) else { return }
            self.pendingCloses.remove(paneID)
            guard self.state.panes[paneID]?.closePending == true else { return }
            self.removeClosedPane(paneID)
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
            view.focusTerminal()
        }
        refreshFocusIndicators()
    }

    /// The one place the active-pane indicator is computed, and it is computed from the window itself: which pane owns the first responder, and whether the window is key. Never from the last click — a ring that says "you are typing here" while the keystrokes go elsewhere is worse than no ring. Called on every first-responder change (`WorkspaceWindow` below) and whenever the window takes or loses key.
    private func refreshFocusIndicators() {
        let windowIsKey = window?.isKeyWindow ?? false
        let responderPane = paneOwningFirstResponder()
        for (id, view) in paneViews {
            view.setFocusIndicator(paneFocusIndicator(
                pane: id, firstResponderPane: responderPane, windowIsKey: windowIsKey))
        }
        if let responderPane, responderPane != state.focusedPane {
            dispatch(.focusPane(responderPane))
        }
    }

    private func paneOwningFirstResponder() -> PaneID? {
        guard let responder = window?.firstResponder as? NSView else { return nil }
        return paneViews.first { responder.isDescendant(of: $0.value) }?.key
    }

    func windowDidBecomeKey(_ notification: Notification) {
        refreshFocusIndicators()
    }

    func windowDidResignKey(_ notification: Notification) {
        refreshFocusIndicators()
    }

    func terminateAllTerminals() {
        for view in paneViews.values {
            view.sessiondTerminal?.detach()
        }
    }

    func windowWillClose(_ notification: Notification) {
        isClosing = true
        pendingAdmissions.removeAll()
        terminateAllTerminals()
        onWindowWillClose?()
    }

    func currentPaneFrames() -> [PaneID: CGRect] {
        state.frames(in: container.bounds)
    }

    func terminalText(pane: PaneID) -> String {
        paneViews[pane]?.sessiondTerminal?.view?.accessibilityValue() as? String ?? ""
    }

    func sendText(_ text: String, pane: PaneID) {
        paneViews[pane]?.sessiondTerminal?.view?.insertText(
            text,
            replacementRange: NSRange(location: NSNotFound, length: 0))
    }

    @discardableResult
    func postScrollWheel(deltaY: CGFloat, pane: PaneID) -> Bool {
        guard let terminalView = paneViews[pane]?.sessiondTerminal?.view else { return false }
        guard let cgEvent = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 1,
            wheel1: Int32(deltaY),
            wheel2: 0,
            wheel3: 0),
              let event = NSEvent(cgEvent: cgEvent)
        else { return false }
        terminalView.scrollWheel(with: event)
        return true
    }

    func terminalChildRunning(pane: PaneID) -> Bool {
        false
    }

    func sessiondTerminalView(pane: PaneID) -> HiveTerminalView? {
        paneViews[pane]?.sessiondTerminal?.view
    }

    func sessiondTerminalHasStarted(pane: PaneID) -> Bool {
        paneViews[pane]?.sessiondTerminal?.hasStarted ?? false
    }

    func visibilityGeometries() -> [PaneID: TerminalGeometry] {
        Dictionary(uniqueKeysWithValues: paneViews.compactMap { paneID, paneView in
            guard let geometry = paneView.sessiondTerminal?.view?.reportedGeometry else {
                return nil
            }
            return (paneID, geometry)
        })
    }

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

    /// What the pane is actually showing — read back from the view, not from the reducer, so a test cannot pass on intent alone.
    func focusIndicator(pane: PaneID) -> PaneFocusIndicator {
        paneViews[pane]?.currentFocusIndicator ?? .none
    }

    func firstResponderPane() -> PaneID? {
        paneOwningFirstResponder()
    }

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

/// The project window. Its one addition to NSWindow is honesty about focus: `makeFirstResponder` is the single funnel every focus change in AppKit goes through, so overriding it is how the app learns where the keyboard actually went — including the moves it never asked for.
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
