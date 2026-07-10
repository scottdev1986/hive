import AppKit
import WorkspaceCore

/// One project's workspace window: owns the pane views, applies reducer
/// changes, and is the single dispatch point for the shared command model.
/// Menu items and shortcuts reach it through the responder chain, so the key
/// window owns routing exactly as the blueprint requires.
final class ProjectWindowController: NSWindowController, NSWindowDelegate {

    let state: ProjectState
    private let attentionCenter: AttentionCenter
    private let container = LayoutContainerView()
    private let animator = LayoutAnimator()
    private var paneViews: [PaneID: PaneView] = [:]

    var paneViewCount: Int { paneViews.count }

    init(state: ProjectState, attentionCenter: AttentionCenter, cascadeIndex: Int) {
        self.state = state
        self.attentionCenter = attentionCenter

        let window = NSWindow(
            contentRect: NSRect(x: 120 + cascadeIndex * 60, y: 80 + cascadeIndex * 40,
                                width: 1280, height: 800),
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

    // MARK: Event and command entry points

    func ingest(_ envelope: AgentEventEnvelope) {
        react(to: state.apply(envelope))
    }

    /// The one shared command entry: menu items, keyboard shortcuts, clicks,
    /// double-clicks, links, and accessibility actions all end here.
    func dispatch(_ command: WorkspaceCommand) {
        react(to: state.apply(command))
    }

    private func react(to changes: [StateChange]) {
        for change in changes {
            switch change {
            case .paneAdded(let paneID):
                addPaneView(for: paneID)
            case .paneRemoved(let paneID):
                paneViews.removeValue(forKey: paneID)?.removeFromSuperview()
            case .layoutChanged:
                applyLayout(animated: true)
            case .focusChanged(let paneID):
                applyFocus(paneID)
            case .statusChanged(let paneID):
                if let pane = state.panes[paneID] {
                    paneViews[paneID]?.update(state: pane)
                }
            case .transcriptChanged(let paneID, let transcriptChange):
                if let pane = state.panes[paneID] {
                    paneViews[paneID]?.contentView.apply(transcriptChange, items: pane.transcript.items)
                }
            case .attentionChanged:
                attentionCenter.refresh()
            case .composerSubmitted:
                break // the mock source has no live agent to deliver to
            }
        }
    }

    // MARK: Pane management

    private func addPaneView(for paneID: PaneID) {
        guard let pane = state.panes[paneID] else { return }
        let view = PaneView(paneID: paneID, title: pane.title) { [weak self] command in
            self?.dispatch(command)
        }
        view.update(state: pane)
        view.contentView.rebuild(items: pane.transcript.items)
        paneViews[paneID] = view
        container.addSubview(view)
        // New panes appear at their final slot's center and grow into place;
        // creation must be visible but never steal focus.
        if let target = state.frames(in: container.bounds)[paneID] {
            view.frame = CGRect(x: target.midX, y: target.midY, width: 0, height: 0)
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
            view.contentView.focusComposer()
        }
    }

    // MARK: Smoke-test introspection

    func currentPaneFrames() -> [PaneID: CGRect] {
        state.frames(in: container.bounds)
    }

    func transcriptTextLength(pane: PaneID) -> Int {
        paneViews[pane]?.contentView.transcriptTextLength ?? 0
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

    @objc func approvePendingRequest(_ sender: Any?) {
        resolvePendingApproval(approved: true)
    }

    @objc func denyPendingRequest(_ sender: Any?) {
        resolvePendingApproval(approved: false)
    }

    private func resolvePendingApproval(approved: Bool) {
        guard let focused = state.focusedPane,
              let pane = state.panes[focused],
              let pending = pane.transcript.items.lazy.compactMap({ item -> String? in
                  if case .approval(let approval) = item, approval.state == .pending { return approval.id }
                  return nil
              }).first else { return }
        dispatch(.resolveApproval(approvalID: pending, approved: approved))
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
        case #selector(approvePendingRequest(_:)), #selector(denyPendingRequest(_:)):
            guard let focused = state.focusedPane, let pane = state.panes[focused] else { return false }
            return pane.transcript.items.contains { item in
                if case .approval(let approval) = item { return approval.state == .pending }
                return false
            }
        default:
            return true
        }
    }
}
