import AppKit
import WorkspaceCore

@MainActor
protocol LiveRunTerminalSurface: AnyObject {
    var locator: AgentSessionLocator { get }
    var installedView: NSView? { get }
    func makeView() throws -> NSView
    func start()
    func detach()
}

final class LiveRunSessiondSurface: LiveRunTerminalSurface {
    let locator: AgentSessionLocator
    private let terminal: SessiondPaneTerminal

    init(session: LiveRunSessionSummary, config: LaunchConfig) {
        locator = session.locator!
        terminal = SessiondPaneTerminal(
            agentName: session.name,
            locator: locator,
            hivePath: config.hivePath!,
            daemonPort: config.port!,
            instanceHome: config.instanceHome!)
    }

    var installedView: NSView? { terminal.view }
    func makeView() throws -> NSView { try terminal.makeView() }
    func start() { terminal.start() }
    func detach() { terminal.detach() }
}

final class LiveRunWorkbenchView: NSView {
    typealias TerminalFactory = (LiveRunSessionSummary) -> LiveRunTerminalSurface
    typealias ConfirmControl = (LiveRunControlOperation, LiveRunControlProjection) -> Bool

    struct ControlConfirmation {
        let title: String
        let message: String
        let confirmTitle: String
    }

    private let terminalFactory: TerminalFactory?
    private let confirmControl: ConfirmControl
    private let railHost = NSView()
    private let railStack = NSStackView()
    private let hierarchyHeading = NSTextField(labelWithString: "Run hierarchy")
    private let hierarchyCountLabel = NSTextField(labelWithString: "typed status · one live viewer")
    private let budgetLabel = NSTextField(labelWithString: "Run budget · not projected")
    private let terminalHost = NSView()
    private let terminalPlaceholder = NSTextField(wrappingLabelWithString: "")
    private let errorLabel = NSTextField(wrappingLabelWithString: "")
    private let titleLabel = NSTextField(labelWithString: "No live session selected")
    private let subtitleLabel = NSTextField(labelWithString: "Waiting for workspace-feed v1")
    private let locatorLabel = NSTextField(labelWithString: "Exact generation · unknown")
    private let scopeValue = NSTextField(labelWithString: "Live Run")
    private let focusValue = NSTextField(labelWithString: "none")
    private let generationValue = NSTextField(labelWithString: "unknown")
    private let activityBadgeHost = NSView()
    private let attachmentBadgeHost = NSView()
    private let liveChip = CapsuleBadge(
        text: "AGENT UI", symbol: "text.bubble", style: .info)
    private let providerHost = NSView()
    private let inspectorName = NSTextField(labelWithString: "No selection")
    private let inspectorModel = NSTextField(labelWithString: "model unknown")
    private let taskTitle = NSTextField(wrappingLabelWithString: "No TaskDetail observed")
    private let taskBody = NSTextField(wrappingLabelWithString: "")
    private let eventsBody = NSTextField(wrappingLabelWithString: "")
    private let statusValue = NSTextField(labelWithString: "unknown")
    private let shellValue = NSTextField(wrappingLabelWithString: "unknown")
    private let providerRunValue = NSTextField(wrappingLabelWithString: "absent")
    private let censusValue = NSTextField(wrappingLabelWithString: "absent")
    private let terminationValue = NSTextField(wrappingLabelWithString: "unknown")
    private let stopButton = ActionButton(title: "Stop Provider", style: .warning)
    private let terminateButton = ActionButton(title: "Terminate Terminal", style: .destructive)
    private let taskPane = NSView()
    private let eventsPane = NSView()
    private let sessionPane = NSView()
    private let inspectorBodyStack = NSStackView()
    private var inspectorTabButtons: [ShellInspectorTab: NSButton] = [:]

    private var sessions: [LiveRunSessionSummary] = []
    private var selectedID: String?
    private var terminal: LiveRunTerminalSurface?
    private var visibleLocator: AgentSessionLocator?
    private var controlProjection: LiveRunControlProjection?
    private var routeVisible = false
    private var inspectorTab: ShellInspectorTab = .task
    private var horizon: OuterHorizonScreenState?
    private var horizonScreen: ShellScreenProjection?
    private var onHorizonSelect: ((String) -> Void)?
    private var onHorizonToggle: ((String) -> Void)?
    private var queenProvider: ProviderID?

    var onVisibleSessionChanged: ((LiveRunSessionSummary?) -> Void)?
    var onControlRequested: ((LiveRunControlOperation, LiveRunControlProjection) -> Void)?

    convenience init(config: LaunchConfig) {
        let factory: TerminalFactory? = config.isComplete
            ? { LiveRunSessiondSurface(session: $0, config: config) }
            : nil
        self.init(terminalFactory: factory)
    }

    init(
        terminalFactory: TerminalFactory?,
        confirmControl: @escaping ConfirmControl = LiveRunWorkbenchView.confirm
    ) {
        self.terminalFactory = terminalFactory
        self.confirmControl = confirmControl
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityIdentifier("live-run-workbench")
        buildLayout()
        showUnavailable("Waiting for a strict workspace-feed v1 snapshot.")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    var selectedLocator: AgentSessionLocator? { terminal?.locator }
    var installedTerminalCount: Int { terminal?.installedView == nil ? 0 : 1 }
    var rowCount: Int { sessions.count }
    var stopProviderControlEnabled: Bool { stopButton.isEnabled }
    var terminateTerminalControlEnabled: Bool { terminateButton.isEnabled }
    var stopProviderControlHidden: Bool { stopButton.isHidden }
    var terminateTerminalControlHidden: Bool { terminateButton.isHidden }
    var terminationFactText: String { terminationValue.stringValue }

    func apply(_ projection: LiveRunProjection) {
        let priorSessions = sessions
        let priorSelection = selectedID
        errorLabel.isHidden = true
        sessions = projection.sessions
        if !sessions.contains(where: { $0.id == selectedID }) {
            if let selectedNode = horizon?.selectedNode {
                selectedID = matchingSession(for: selectedNode)?.id
            } else {
                selectedID = sessions.first(where: { $0.isQueen && $0.locator != nil })?.id
                    ?? sessions.first(where: { $0.locator != nil })?.id
                    ?? sessions.first?.id
            }
        }
        if sessions != priorSessions || selectedID != priorSelection {
            rebuildRail()
        }
        renderSelection()
    }

    func applyQueenProvider(_ provider: ProviderID?) {
        guard queenProvider != provider else { return }
        queenProvider = provider
        if sessions.contains(where: \.isQueen) {
            rebuildRail()
            renderSelection()
        }
    }

    func applyHierarchy(
        _ horizon: OuterHorizonScreenState?,
        screen: ShellScreenProjection?,
        onSelect: @escaping (String) -> Void,
        onToggleExpansion: @escaping (String) -> Void
    ) {
        let unchanged = self.horizon == horizon && horizonScreen == screen
        self.horizon = horizon
        horizonScreen = screen
        onHorizonSelect = onSelect
        onHorizonToggle = onToggleExpansion
        if !unchanged {
            rebuildRail()
        }
        renderSelection()
    }

    func showUnavailable(_ reason: String) {
        // An unavailable feed cannot prove that its last locator is still current. Detach the viewer and withdraw its visibility; the session keeps running.
        sessions = []
        selectedID = nil
        rebuildRail()
        detachTerminal()
        publishVisibleSessionIfChanged(nil)
        errorLabel.stringValue = reason
        errorLabel.isHidden = false
        titleLabel.stringValue = "Live Run unavailable"
        subtitleLabel.stringValue = "No session status was inferred"
        locatorLabel.stringValue = "Exact generation · unknown"
        terminalPlaceholder.stringValue = reason
        terminalPlaceholder.isHidden = false
        controlProjection = nil
        updateControlStrip(nil)
        updateCenterBadges(nil)
        updateInspector(nil)
    }

    func applyControlProjection(_ projection: LiveRunControlProjection) {
        guard let session = sessions.first(where: { $0.id == selectedID }),
              session.id == projection.agentID,
              session.provider == projection.provider,
              session.locator == projection.locator
        else {
            return
        }
        controlProjection = projection
        updateControlStrip(session)
        updateInspector(session)
    }

    func showControlUnavailable(_ reason: String) {
        controlProjection = nil
        guard let session = sessions.first(where: { $0.id == selectedID }) else {
            updateControlStrip(nil)
            updateInspector(nil)
            return
        }
        updateControlStrip(session)
        updateInspector(session)
        stopButton.toolTip = reason
        terminateButton.toolTip = reason
    }

    func showControlMessage(_ message: String) {
        errorLabel.stringValue = message
        errorLabel.isHidden = false
    }

    func setRouteVisible(_ visible: Bool) {
        guard routeVisible != visible else { return }
        routeVisible = visible
        if visible {
            renderSelection()
        } else {
            detachTerminal()
            publishVisibleSessionIfChanged(nil)
            updateCenterBadges(sessions.first(where: { $0.id == selectedID }))
        }
    }

    func selectSession(id: String) {
        guard sessions.contains(where: { $0.id == id }) else { return }
        guard selectedID != id else { return }
        selectedID = id
        rebuildRail()
        renderSelection()
    }

    private func buildLayout() {
        Theme.paint(self, Theme.workspaceBackground)

        let rail = makeRail()
        let center = makeCenter()
        let inspector = makeInspector()
        let leftSeparator = NSBox.hdsVerticalDivider()
        let rightSeparator = NSBox.hdsVerticalDivider()
        selectInspectorTab(.task)

        let layout = NSStackView(views: [rail, leftSeparator, center, rightSeparator, inspector])
        layout.translatesAutoresizingMaskIntoConstraints = false
        layout.orientation = .horizontal
        layout.alignment = .top
        layout.distribution = .fill
        layout.spacing = 0
        addSubview(layout)
        NSLayoutConstraint.activate([
            layout.leadingAnchor.constraint(equalTo: leadingAnchor),
            layout.trailingAnchor.constraint(equalTo: trailingAnchor),
            layout.topAnchor.constraint(equalTo: topAnchor),
            layout.bottomAnchor.constraint(equalTo: bottomAnchor),
            rail.widthAnchor.constraint(
                equalToConstant: Theme.Metric.sidebarWidth + Theme.Space.l * 2),
            inspector.widthAnchor.constraint(
                equalToConstant: Theme.Metric.sidebarWidth + Theme.Space.xl * 5),
            center.widthAnchor.constraint(
                greaterThanOrEqualToConstant:
                    Theme.Metric.minContentWidth + Theme.Space.xl),
            rail.heightAnchor.constraint(equalTo: layout.heightAnchor),
            center.heightAnchor.constraint(equalTo: layout.heightAnchor),
            inspector.heightAnchor.constraint(equalTo: layout.heightAnchor),
            leftSeparator.heightAnchor.constraint(equalTo: layout.heightAnchor),
            rightSeparator.heightAnchor.constraint(equalTo: layout.heightAnchor),
        ])
    }

    private func makeRail() -> NSView {
        hierarchyHeading.font = Theme.Font.sectionLabel
        hierarchyHeading.textColor = Theme.secondaryText
        hierarchyCountLabel.font = Theme.Font.caption
        hierarchyCountLabel.textColor = Theme.tertiaryText
        hierarchyCountLabel.compressHorizontally(
            priority: 430, toolTip: hierarchyCountLabel.stringValue)
        budgetLabel.font = Theme.Font.monoCaption
        budgetLabel.textColor = Theme.secondaryText
        budgetLabel.maximumNumberOfLines = 2
        budgetLabel.lineBreakMode = .byWordWrapping
        budgetLabel.compressHorizontally(priority: 430, toolTip: budgetLabel.stringValue)

        railStack.orientation = .vertical
        railStack.alignment = .leading
        railStack.spacing = Theme.Space.xs
        railStack.translatesAutoresizingMaskIntoConstraints = false

        railHost.translatesAutoresizingMaskIntoConstraints = false
        let scroll = NSScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.contentView = LiveRunRailClipView()
        scroll.documentView = railStack
        railStack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor).isActive = true
        railHost.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: railHost.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: railHost.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: railHost.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: railHost.bottomAnchor),
        ])

        let header = NSStackView(views: [hierarchyHeading, hierarchyCountLabel])
        header.orientation = .vertical
        header.alignment = .leading
        header.spacing = 2
        let budget = CardView()
        budget.contentStack.addArrangedSubview(budgetLabel)
        budget.pinToContentWidth(budgetLabel)

        let container = NSStackView(views: [header, railHost, budget])
        container.translatesAutoresizingMaskIntoConstraints = false
        container.orientation = .vertical
        container.alignment = .leading
        container.spacing = Theme.Space.s
        container.edgeInsets = NSEdgeInsets(
            top: Theme.Space.l, left: Theme.Space.m,
            bottom: Theme.Space.l, right: Theme.Space.m)
        Theme.paint(container, Theme.sidebarFill)
        railHost.widthAnchor.constraint(equalTo: container.widthAnchor).isActive = true
        header.widthAnchor.constraint(equalTo: container.widthAnchor).isActive = true
        budget.widthAnchor.constraint(equalTo: container.widthAnchor).isActive = true
        railHost.setContentHuggingPriority(.init(1), for: .vertical)
        railHost.setContentCompressionResistancePriority(.init(1), for: .vertical)
        return container
    }

    private func makeCenter() -> NSView {
        titleLabel.font = Theme.Font.title
        titleLabel.textColor = Theme.primaryText
        titleLabel.compressHorizontally(toolTip: titleLabel.stringValue)
        subtitleLabel.font = Theme.Font.caption
        subtitleLabel.textColor = Theme.secondaryText
        subtitleLabel.compressHorizontally()
        activityBadgeHost.translatesAutoresizingMaskIntoConstraints = false
        let titleRow = NSStackView(views: [titleLabel, activityBadgeHost])
        titleRow.orientation = .horizontal
        titleRow.alignment = .centerY
        titleRow.spacing = Theme.Space.s
        let identity = NSStackView(views: [titleRow, subtitleLabel])
        identity.orientation = .vertical
        identity.alignment = .leading
        identity.spacing = 2

        attachmentBadgeHost.translatesAutoresizingMaskIntoConstraints = false

        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let header = NSStackView(views: [identity, spacer, attachmentBadgeHost])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = Theme.Space.s

        locatorLabel.font = Theme.Font.monoCaption
        locatorLabel.textColor = Theme.secondaryText
        locatorLabel.compressHorizontally(priority: 450)

        errorLabel.font = Theme.Font.caption
        errorLabel.textColor = Theme.warning
        errorLabel.maximumNumberOfLines = 0

        terminalHost.translatesAutoresizingMaskIntoConstraints = false
        terminalHost.wantsLayer = true
        terminalHost.layer?.backgroundColor = Theme.workspaceBackground.cgColor
        terminalHost.setContentHuggingPriority(.init(1), for: .vertical)
        terminalHost.setContentCompressionResistancePriority(.init(1), for: .vertical)
        terminalHost.setAccessibilityIdentifier("live-run-terminal-host")

        terminalPlaceholder.translatesAutoresizingMaskIntoConstraints = false
        terminalPlaceholder.font = Theme.Font.monoBody
        terminalPlaceholder.textColor = Theme.secondaryText
        terminalPlaceholder.alignment = .center
        terminalPlaceholder.maximumNumberOfLines = 0
        terminalPlaceholder.setAccessibilityIdentifier("live-run-terminal-placeholder")
        terminalHost.addSubview(terminalPlaceholder)
        NSLayoutConstraint.activate([
            terminalPlaceholder.centerXAnchor.constraint(equalTo: terminalHost.centerXAnchor),
            terminalPlaceholder.centerYAnchor.constraint(equalTo: terminalHost.centerYAnchor),
            terminalPlaceholder.leadingAnchor.constraint(
                greaterThanOrEqualTo: terminalHost.leadingAnchor, constant: Theme.Space.xl),
            terminalPlaceholder.trailingAnchor.constraint(
                lessThanOrEqualTo: terminalHost.trailingAnchor, constant: -Theme.Space.xl),
            terminalHost.heightAnchor.constraint(greaterThanOrEqualToConstant: 320),
        ])

        let liveRow = NSStackView(views: [liveChip, locatorLabel])
        liveRow.orientation = .horizontal
        liveRow.alignment = .centerY
        liveRow.spacing = Theme.Space.s

        let container = NSStackView(views: [
            makeControlStrip(), header, liveRow, errorLabel, terminalHost,
        ])
        container.translatesAutoresizingMaskIntoConstraints = false
        container.orientation = .vertical
        container.alignment = .leading
        container.spacing = Theme.Space.s
        container.edgeInsets = NSEdgeInsets(
            top: Theme.Space.m, left: Theme.Space.m,
            bottom: Theme.Space.m, right: Theme.Space.m)
        Theme.paint(container, Theme.workspaceBackground)
        container.setContentHuggingPriority(.init(1), for: .vertical)
        for view in container.arrangedSubviews {
            view.widthAnchor.constraint(equalTo: container.widthAnchor).isActive = true
        }
        return container
    }

    private func makeControlStrip() -> NSView {
        for field in [scopeValue, focusValue, generationValue] {
            field.font = Theme.Font.headline
            field.compressHorizontally(priority: 430, toolTip: field.stringValue)
        }
        let strip = FactStripView(
            pairs: [
                FactStripView.pair(label: "Viewed scope", value: scopeValue, delimiter: "·"),
                FactStripView.pair(label: "Keyboard focus", value: focusValue, delimiter: "·"),
                FactStripView.pair(label: "Generation", value: generationValue, delimiter: "·"),
            ],
            identifier: "live-run-control-strip")
        Theme.paint(strip, Theme.sidebarContextFill)
        strip.heightAnchor.constraint(
            greaterThanOrEqualToConstant:
                Theme.Metric.chromeControlHeight + Theme.Space.m).isActive = true
        let separator = NSBox.hdsSeparator()
        let container = NSStackView(views: [strip, separator])
        container.orientation = .vertical
        container.spacing = 0
        container.alignment = .leading
        strip.widthAnchor.constraint(equalTo: container.widthAnchor).isActive = true
        separator.widthAnchor.constraint(equalTo: container.widthAnchor).isActive = true
        return container
    }

    private func makeInspector() -> NSView {
        providerHost.translatesAutoresizingMaskIntoConstraints = false
        providerHost.heightAnchor.constraint(equalToConstant: Theme.Metric.markSize).isActive = true
        providerHost.widthAnchor.constraint(equalToConstant: Theme.Metric.markSize).isActive = true
        inspectorName.font = Theme.Font.title
        inspectorName.textColor = Theme.primaryText
        inspectorName.compressHorizontally()
        inspectorModel.font = Theme.Font.monoCaption
        inspectorModel.textColor = Theme.secondaryText
        inspectorModel.compressHorizontally()
        let identity = NSStackView(views: [providerHost, inspectorName])
        identity.orientation = .horizontal
        identity.alignment = .centerY
        identity.spacing = Theme.Space.s

        let tabs = NSStackView()
        tabs.orientation = .horizontal
        tabs.spacing = Theme.Space.xs
        tabs.distribution = .fillEqually
        for tab in ShellInspectorTab.allCases {
            let button = NSButton(title: tab.title, target: nil, action: nil)
            configureInspectorTab(button, selected: tab == inspectorTab)
            button.setButtonType(.momentaryPushIn)
            button.setAccessibilityIdentifier("live-run-inspector-tab-\(tab.rawValue)")
            button.setAccessibilityLabel("\(tab.title) inspector tab")
            button.setAccessibilityRole(.button)
            button.target = self
            button.action = #selector(inspectorTabClicked(_:))
            button.heightAnchor.constraint(
                greaterThanOrEqualToConstant: Theme.Metric.controlMinHeight).isActive = true
            inspectorTabButtons[tab] = button
            tabs.addArrangedSubview(button)
        }

        fillPane(
            taskPane,
            views: [
                microLabel("TaskDetail"),
                styled(taskTitle, font: Theme.Font.headline),
                styled(taskBody, font: Theme.Font.callout, color: Theme.secondaryText),
            ])
        fillPane(
            eventsPane,
            views: [
                microLabel("Typed history"),
                styled(eventsBody, font: Theme.Font.callout, color: Theme.secondaryText),
            ])

        let sessionStack = NSStackView()
        sessionStack.translatesAutoresizingMaskIntoConstraints = false
        sessionStack.orientation = .vertical
        sessionStack.alignment = .leading
        sessionStack.spacing = Theme.Space.s
        sessionStack.addArrangedSubview(identity)
        sessionStack.addArrangedSubview(inspectorModel)
        sessionStack.addArrangedSubview(NSBox.hdsSeparator())
        for (label, value) in [
            ("Agent status", statusValue),
            ("Shell root", shellValue),
            ("ProviderRun", providerRunValue),
            ("Cwd census", censusValue),
            ("Termination proof", terminationValue),
        ] {
            sessionStack.addArrangedSubview(fact(label, value: value))
        }
        sessionStack.addArrangedSubview(NSBox.hdsSeparator())
        stopButton.target = self
        stopButton.action = #selector(stopProvider)
        stopButton.isEnabled = false
        stopButton.isHidden = true
        stopButton.setAccessibilityIdentifier("live-run-stop-provider")
        terminateButton.target = self
        terminateButton.action = #selector(terminateTerminal)
        terminateButton.isEnabled = false
        terminateButton.isHidden = true
        terminateButton.setAccessibilityIdentifier("live-run-terminate-terminal")
        sessionStack.addArrangedSubview(stopButton)
        sessionStack.addArrangedSubview(terminateButton)
        sessionPane.translatesAutoresizingMaskIntoConstraints = false
        sessionPane.addSubview(sessionStack)
        NSLayoutConstraint.activate([
            sessionStack.leadingAnchor.constraint(equalTo: sessionPane.leadingAnchor),
            sessionStack.trailingAnchor.constraint(equalTo: sessionPane.trailingAnchor),
            sessionStack.topAnchor.constraint(equalTo: sessionPane.topAnchor),
            sessionStack.bottomAnchor.constraint(equalTo: sessionPane.bottomAnchor),
        ])

        let stack = NSStackView()
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.m
        Theme.paint(stack, Theme.cardFill)
        stack.edgeInsets = NSEdgeInsets(
            top: Theme.Space.l, left: Theme.Space.m,
            bottom: Theme.Space.l, right: Theme.Space.m)
        inspectorBodyStack.orientation = .vertical
        inspectorBodyStack.alignment = .leading
        inspectorBodyStack.spacing = Theme.Space.m
        inspectorBodyStack.setContentHuggingPriority(.init(1), for: .vertical)
        inspectorBodyStack.addArrangedSubview(taskPane)
        inspectorBodyStack.addArrangedSubview(eventsPane)
        inspectorBodyStack.addArrangedSubview(sessionPane)
        stack.addArrangedSubview(tabs)
        stack.addArrangedSubview(inspectorBodyStack)
        for view in [tabs, inspectorBodyStack, stopButton, terminateButton] {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        return stack
    }

    private func rebuildRail() {
        for view in railHost.subviews {
            view.removeFromSuperview()
        }
        for view in railStack.arrangedSubviews {
            railStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }

        if let horizon {
            if let run = horizon.snapshot.runs.first {
                if case .present(let shape) = run.topologyShape {
                    hierarchyHeading.stringValue = "Run hierarchy · "
                        + shape.rawValue.replacingOccurrences(of: "-", with: " ")
                } else {
                    hierarchyHeading.stringValue = "Run hierarchy"
                }
                let topologyRevision = UInt64(run.entityRevision) == nil
                    ? run.entityRevision
                    : "r\(run.entityRevision)"
                hierarchyCountLabel.stringValue =
                    "\(sessions.count) live · \(horizon.visibleRows.count) visible / "
                    + "\(horizon.snapshot.nodes.count) admitted · topology \(topologyRevision)"
            } else {
                hierarchyHeading.stringValue = "Run hierarchy"
                hierarchyCountLabel.stringValue =
                    "\(sessions.count) live · \(horizon.visibleRows.count) visible / "
                    + "\(horizon.snapshot.nodes.count) admitted"
            }
            budgetLabel.stringValue = Self.budgetSummary(horizon)
        } else {
            hierarchyHeading.stringValue = "Run hierarchy"
            hierarchyCountLabel.stringValue =
                sessions.isEmpty
                ? "typed status · one live viewer"
                : "\(sessions.count) live · hierarchy not projected"
            budgetLabel.stringValue = "Run budget · not projected"
        }

        let scroll = NSScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.contentView = LiveRunRailClipView()
        scroll.documentView = railStack
        railStack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor).isActive = true
        railHost.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: railHost.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: railHost.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: railHost.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: railHost.bottomAnchor),
        ])

        guard !sessions.isEmpty || horizon?.visibleRows.isEmpty == false else {
            let empty = NSTextField(wrappingLabelWithString:
                horizon == nil
                    ? "No live agents or run hierarchy were projected."
                    : "The run hierarchy has no visible rows.")
            empty.font = Theme.Font.caption
            empty.textColor = Theme.secondaryText
            railStack.addArrangedSubview(empty)
            empty.widthAnchor.constraint(equalTo: railStack.widthAnchor).isActive = true
            return
        }

        var renderedSessionIDs = Set<String>()
        if let queen = sessions.first(where: \.isQueen) {
            let button = LiveRunSessionButton(
                session: queen,
                hierarchyRow: nil,
                selected: queen.id == selectedID,
                depth: 0,
                role: roleLine(for: queen),
                onSelect: { [weak self] in self?.selectSession(id: queen.id) },
                onToggle: nil)
            railStack.addArrangedSubview(button)
            button.widthAnchor.constraint(equalTo: railStack.widthAnchor).isActive = true
            renderedSessionIDs.insert(queen.id)
        }
        if let horizon {
            for node in horizon.snapshot.nodes {
                if let session = matchingSession(for: node) {
                    renderedSessionIDs.insert(session.id)
                }
            }
            for row in horizon.visibleRows {
                let session = matchingSession(for: row.node)
                let button = LiveRunSessionButton(
                    session: session,
                    hierarchyRow: row,
                    selected: session.map { $0.id == selectedID }
                        ?? (horizon.navigation.selectedNodeId == row.node.nodeId),
                    depth: row.depth,
                    role: session.map { roleLine(for: $0) },
                    expanded: horizon.navigation.expandedNodeIds.contains(row.node.nodeId),
                    onSelect: { [weak self] in
                        self?.selectHierarchyNode(row.node.nodeId)
                    },
                    onToggle: row.hasChildren ? { [weak self] in
                        self?.onHorizonToggle?(row.node.nodeId)
                    } : nil)
                railStack.addArrangedSubview(button)
                button.widthAnchor.constraint(equalTo: railStack.widthAnchor).isActive = true
            }
        }
        for session in sessions where !renderedSessionIDs.contains(session.id) {
            let button = LiveRunSessionButton(
                session: session,
                hierarchyRow: nil,
                selected: session.id == selectedID,
                depth: session.isQueen ? 0 : 1,
                role: roleLine(for: session),
                onSelect: { [weak self] in self?.selectSession(id: session.id) },
                onToggle: nil)
            railStack.addArrangedSubview(button)
            button.widthAnchor.constraint(equalTo: railStack.widthAnchor).isActive = true
        }
    }

    private func renderSelection() {
        guard let session = sessions.first(where: { $0.id == selectedID }) else {
            controlProjection = nil
            detachTerminal()
            titleLabel.stringValue = "No live session selected"
            subtitleLabel.stringValue = "Background rows remain typed-only"
            locatorLabel.stringValue = "Exact generation · unknown"
            terminalPlaceholder.stringValue = "Select an agent with an exact session locator."
            terminalPlaceholder.isHidden = false
            updateControlStrip(nil)
            updateCenterBadges(nil)
            updateInspector(nil)
            publishVisibleSessionIfChanged(nil)
            return
        }

        if controlProjection?.agentID != session.id
            || controlProjection?.locator != session.locator
        {
            controlProjection = nil
        }

        titleLabel.stringValue = session.name
        subtitleLabel.stringValue =
            "\(providerLine(for: session)) · \(session.rawStatus)"
        updateControlStrip(session)
        updateCenterBadges(session)
        updateInspector(session)
        guard routeVisible else { return }
        guard let locator = session.locator else {
            detachTerminal()
            locatorLabel.stringValue = "Exact generation · unknown"
            terminalPlaceholder.stringValue = session.locatorFact?.reason
                ?? "No exact terminal locator was projected."
            terminalPlaceholder.isHidden = false
            publishVisibleSessionIfChanged(nil)
            updateCenterBadges(session)
            return
        }
        locatorLabel.stringValue = "\(locator.sessionId) · generation \(locator.generation) exact"
        if terminal?.locator == locator {
            publishVisibleSessionIfChanged(session)
            updateCenterBadges(session)
            return
        }

        detachTerminal()
        guard let terminalFactory else {
            terminalPlaceholder.stringValue = "Terminal transport is absent in this launch."
            terminalPlaceholder.isHidden = false
            publishVisibleSessionIfChanged(nil)
            updateCenterBadges(session)
            return
        }
        let fresh = terminalFactory(session)
        do {
            let view = try fresh.makeView()
            view.translatesAutoresizingMaskIntoConstraints = false
            view.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
            terminalHost.addSubview(view)
            NSLayoutConstraint.activate([
                view.leadingAnchor.constraint(equalTo: terminalHost.leadingAnchor),
                view.trailingAnchor.constraint(equalTo: terminalHost.trailingAnchor),
                view.topAnchor.constraint(equalTo: terminalHost.topAnchor),
                view.bottomAnchor.constraint(equalTo: terminalHost.bottomAnchor),
            ])
            terminal = fresh
            terminalPlaceholder.isHidden = true
            fresh.start()
            publishVisibleSessionIfChanged(session)
            updateCenterBadges(session)
        } catch {
            fresh.detach()
            let message = "Terminal renderer unavailable: \(error.localizedDescription). The terminal is waiting and will appear automatically."
            NSLog("%@", message)
            terminalPlaceholder.stringValue = message
            terminalPlaceholder.isHidden = false
            publishVisibleSessionIfChanged(nil)
            updateCenterBadges(session)
        }
    }

    private func publishVisibleSessionIfChanged(_ session: LiveRunSessionSummary?) {
        let nextLocator = session?.locator
        guard nextLocator != visibleLocator else { return }
        visibleLocator = nextLocator
        onVisibleSessionChanged?(session)
    }

    private func detachTerminal() {
        terminal?.detach()
        terminal?.installedView?.removeFromSuperview()
        terminal = nil
    }

    private func updateInspector(_ session: LiveRunSessionSummary?) {
        for view in providerHost.subviews { view.removeFromSuperview() }
        stopButton.isEnabled = false
        terminateButton.isEnabled = false
        stopButton.isHidden = true
        terminateButton.isHidden = true
        guard let session else {
            inspectorName.stringValue = "No selection"
            inspectorModel.stringValue = "model unknown"
            taskTitle.stringValue = "No TaskDetail observed"
            taskBody.stringValue =
                "The assignment summary comes from durable workflow state. "
                + "Nothing is inferred from the terminal."
            eventsBody.stringValue =
                "Typed SessionHost events were not projected. "
                + "Events are never scraped from the terminal."
            for value in [statusValue, shellValue, providerRunValue,
                          censusValue, terminationValue] {
                value.stringValue = "unknown"
                value.toolTip = "No strict feed snapshot is selected."
            }
            stopButton.toolTip = "Provider control contract absent."
            terminateButton.toolTip = "Terminal termination contract absent."
            return
        }
        let provider = session.isQueen ? (queenProvider ?? session.provider) : session.provider
        let mark = ProviderMarkView(provider: provider)
        providerHost.addSubview(mark)
        NSLayoutConstraint.activate([
            mark.centerXAnchor.constraint(equalTo: providerHost.centerXAnchor),
            mark.centerYAnchor.constraint(equalTo: providerHost.centerYAnchor),
        ])
        inspectorName.stringValue = session.name
        inspectorModel.stringValue = session.model ?? "model unknown"
        statusValue.stringValue = session.rawStatus
        if let task = session.task, !task.isEmpty {
            taskTitle.stringValue = task
            taskBody.stringValue =
                "Acceptance is workflow state, never inferred from terminal output. "
                + "No TaskDetail projection was observed for this selection."
        } else {
            taskTitle.stringValue = "No TaskDetail observed"
            taskBody.stringValue =
                "The assignment summary comes from durable workflow state. "
                + "Nothing is inferred from the terminal."
        }
        eventsBody.stringValue =
            "Typed SessionHost events were not projected for this selection. "
            + "Events are never scraped from the terminal."
        if let projection = controlProjection,
           projection.agentID == session.id,
           projection.locator == session.locator
        {
            renderControlProjection(projection)
            return
        }
        set(shellValue, fact: session.shellRoot)
        set(providerRunValue, fact: session.providerRun)
        set(censusValue, fact: session.processCensus)
        set(terminationValue, fact: session.termination)
        stopButton.toolTip = session.providerRun.reason
        terminateButton.toolTip = session.termination.reason
        stopButton.setAccessibilityHelp(session.providerRun.reason)
        terminateButton.setAccessibilityHelp(session.termination.reason)
    }

    private func renderControlProjection(_ projection: LiveRunControlProjection) {
        for value in [shellValue, providerRunValue, censusValue, terminationValue] {
            value.textColor = Theme.primaryText
            value.toolTip = nil
        }
        switch projection.shell.state {
        case .retained:
            let root = projection.shell.root!
            shellValue.stringValue = "retained · zsh pid \(root.pid) · foreground \(projection.shell.foreground!.rawValue)"
        case .terminated:
            shellValue.stringValue = "terminated"
        case .unknown:
            shellValue.stringValue = "unknown · \(projection.shell.reason!)"
            shellValue.textColor = Theme.warning
        }
        switch projection.providerRun.state {
        case .running:
            let process = projection.providerRun.process!
            providerRunValue.stringValue = "\(projection.providerRun.runID!) · pid \(process.pid) · pgid \(process.processGroupId)"
        case .absent:
            providerRunValue.stringValue = "absent"
        case .unknown:
            providerRunValue.stringValue = "unknown · \(projection.providerRun.reason!)"
            providerRunValue.textColor = Theme.warning
        }
        switch projection.processCensus.state {
        case .complete:
            censusValue.stringValue = "\(projection.processCensus.members.count) verified process-tree members"
        case .terminated:
            censusValue.stringValue = "terminated · no survivors"
        case .unknown:
            censusValue.stringValue = "unknown · \(projection.processCensus.reason!)"
            censusValue.textColor = Theme.warning
        }
        switch projection.termination.state {
        case .notRequested:
            terminationValue.stringValue = "not requested"
        case .terminated:
            terminationValue.stringValue = "terminated · \(projection.termination.completedAt!)"
        case .survivors:
            terminationValue.stringValue = "\(projection.termination.survivors.count) verified survivors"
            terminationValue.textColor = Theme.warning
        case .unknown:
            terminationValue.stringValue = "unknown · \(projection.termination.reason!)"
            terminationValue.textColor = Theme.warning
        }
        apply(
            projection.controls.stopProvider,
            to: stopButton,
            help: "Stops only the verified provider process group and retains zsh.")
        apply(
            projection.controls.terminateTerminal,
            to: terminateButton,
            help: "Terminates the verified terminal process tree.")
    }

    private func apply(
        _ availability: LiveRunControlAvailability,
        to button: NSButton,
        help: String
    ) {
        button.isEnabled = availability.enabled
        button.isHidden = !availability.enabled
        button.toolTip = availability.reason ?? help
        button.setAccessibilityHelp(availability.reason ?? help)
    }

    func controlConfirmation(
        for operation: LiveRunControlOperation,
        projection: LiveRunControlProjection
    ) -> ControlConfirmation {
        Self.confirmation(for: operation, projection: projection)
    }

    private static func confirmation(
        for operation: LiveRunControlOperation,
        projection: LiveRunControlProjection
    ) -> ControlConfirmation {
        let rootPID = projection.shell.root!.pid
        switch operation {
        case .stopProvider:
            return ControlConfirmation(
                title: "Stop \(ProviderBranding.title(for: projection.provider)) provider?",
                message: "Stop ProviderRun \(projection.providerRun.runID!) and return control to the retained zsh pid \(rootPID). The retained zsh pid \(rootPID) stays running.",
                confirmTitle: "Stop Provider")
        case .terminateTerminal:
            return ControlConfirmation(
                title: "Terminate terminal generation \(projection.locator.generation)?",
                message: "Terminate retained zsh pid \(rootPID) and all \(projection.processCensus.members.count) verified process-tree members. This ends the terminal and cannot be undone.",
                confirmTitle: "Terminate Terminal")
        }
    }

    @objc private func stopProvider() {
        request(.stopProvider)
    }

    @objc private func terminateTerminal() {
        request(.terminateTerminal)
    }

    private func request(_ operation: LiveRunControlOperation) {
        guard let projection = controlProjection else { return }
        let availability = switch operation {
        case .stopProvider: projection.controls.stopProvider
        case .terminateTerminal: projection.controls.terminateTerminal
        }
        guard availability.enabled, confirmControl(operation, projection) else { return }
        stopButton.isEnabled = false
        terminateButton.isEnabled = false
        onControlRequested?(operation, projection)
    }

    private static func confirm(
        _ operation: LiveRunControlOperation,
        _ projection: LiveRunControlProjection
    ) -> Bool {
        let copy = confirmation(for: operation, projection: projection)
        let alert = NSAlert()
        alert.alertStyle = operation == .terminateTerminal ? .critical : .warning
        alert.messageText = copy.title
        alert.informativeText = copy.message
        alert.addButton(withTitle: copy.confirmTitle)
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func set(_ label: NSTextField, fact: LiveRunContractFact) {
        label.stringValue = "\(fact.label) · \(fact.reason)"
        label.toolTip = fact.reason
        label.textColor = fact.label == "unknown" ? Theme.warning : Theme.secondaryText
    }

    private func fact(_ title: String, value: NSTextField) -> NSView {
        let label = NSTextField(labelWithString: title)
        label.font = Theme.Font.caption
        label.textColor = Theme.secondaryText
        value.font = Theme.Font.monoCaption
        value.textColor = Theme.primaryText
        value.maximumNumberOfLines = 0
        value.compressHorizontally(priority: 450)
        let stack = NSStackView(views: [label, value])
        stack.orientation = .horizontal
        stack.alignment = .firstBaseline
        stack.spacing = Theme.Space.s
        label.widthAnchor.constraint(equalToConstant: Theme.Space.page * 3).isActive = true
        value.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return stack
    }

    private func microLabel(_ text: String) -> NSTextField {
        let field = NSTextField(labelWithString: text.uppercased())
        field.font = Theme.Font.sectionLabel
        field.textColor = Theme.tertiaryText
        return field
    }

    private func styled(
        _ field: NSTextField,
        font: NSFont,
        color: NSColor = Theme.primaryText
    ) -> NSTextField {
        field.font = font
        field.textColor = color
        field.maximumNumberOfLines = 0
        field.compressHorizontally(priority: 430, toolTip: field.stringValue)
        return field
    }

    private func fillPane(_ pane: NSView, views: [NSView]) {
        pane.translatesAutoresizingMaskIntoConstraints = false
        let stack = NSStackView(views: views)
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.s
        pane.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: pane.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: pane.trailingAnchor),
            stack.topAnchor.constraint(equalTo: pane.topAnchor),
            stack.bottomAnchor.constraint(equalTo: pane.bottomAnchor),
        ])
    }

    private func configureInspectorTab(_ button: NSButton, selected: Bool) {
        button.isBordered = false
        button.font = Theme.Font.chromeControl
        button.contentTintColor = selected ? Theme.primaryText : Theme.secondaryText
        button.wantsLayer = true
        button.layer?.cornerRadius = Theme.Metric.buttonCornerRadius
        button.layer?.backgroundColor = selected ? Theme.insetFill.cgColor : NSColor.clear.cgColor
    }

    private func selectHierarchyNode(_ nodeId: String) {
        onHorizonSelect?(nodeId)
        guard let node = horizon?.snapshot.nodes.first(where: { $0.nodeId == nodeId }) else {
            return
        }
        if let session = matchingSession(for: node) {
            selectSession(id: session.id)
        } else if selectedID != nil {
            selectedID = nil
            rebuildRail()
            renderSelection()
        }
    }

    @objc private func inspectorTabClicked(_ sender: NSButton) {
        guard let tab = inspectorTabButtons.first(where: { $0.value === sender })?.key else {
            return
        }
        selectInspectorTab(tab)
    }

    private func selectInspectorTab(_ tab: ShellInspectorTab) {
        inspectorTab = tab
        for (pane, shown) in [
            (taskPane, tab == .task),
            (eventsPane, tab == .events),
            (sessionPane, tab == .session),
        ] as [(NSView, Bool)] {
            pane.isHidden = !shown
            inspectorBodyStack.setVisibilityPriority(
                shown ? .mustHold : .notVisible, for: pane)
        }
        for (candidate, button) in inspectorTabButtons {
            configureInspectorTab(button, selected: candidate == tab)
            button.setAccessibilityValue(candidate == tab ? "selected" : "unselected")
        }
    }

    private func updateControlStrip(_ session: LiveRunSessionSummary?) {
        scopeValue.stringValue = viewedScope(for: session)
        scopeValue.textColor = Theme.primaryText
        focusValue.stringValue = session?.name ?? "none"
        focusValue.textColor = session == nil ? Theme.secondaryText : Theme.accent
        if let generation = session?.locator?.generation {
            generationValue.stringValue = "\(generation) · exact"
            generationValue.textColor = Theme.positive
        } else {
            generationValue.stringValue = "unknown"
            generationValue.textColor = Theme.secondaryText
        }
    }

    private func updateCenterBadges(_ session: LiveRunSessionSummary?) {
        if let session {
            installBadge(
                in: activityBadgeHost,
                text: session.activity.displayLabel.uppercased(),
                symbol: session.activity.appearance.symbol,
                style: liveRunBadgeStyle(for: session.activity.appearance.color),
                identifier: "live-run-activity-status")
        } else {
            installBadge(
                in: activityBadgeHost,
                text: "NO SELECTION",
                symbol: "questionmark.circle",
                style: .neutral,
                identifier: "live-run-activity-status")
        }

        guard let session, let locator = session.locator else {
            installBadge(
                in: attachmentBadgeHost,
                text: "NO EXACT LOCATOR",
                symbol: "rectangle.slash",
                style: .neutral,
                identifier: "live-run-attachment-status")
            return
        }
        let attached = terminal?.locator == locator && terminal?.installedView != nil
        installBadge(
            in: attachmentBadgeHost,
            text: attached ? "ATTACHED LIVE · G\(locator.generation)" : "READY · G\(locator.generation)",
            symbol: attached ? "dot.radiowaves.left.and.right" : "rectangle.connected.to.line.below",
            style: attached ? .positive : .info,
            identifier: "live-run-attachment-status")
    }

    private func installBadge(
        in host: NSView,
        text: String,
        symbol: String,
        style: CapsuleBadge.Style,
        identifier: String
    ) {
        for view in host.subviews { view.removeFromSuperview() }
        let badge = CapsuleBadge(text: text, symbol: symbol, style: style)
        badge.setAccessibilityIdentifier(identifier)
        host.addSubview(badge)
        NSLayoutConstraint.activate([
            badge.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            badge.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            badge.topAnchor.constraint(equalTo: host.topAnchor),
            badge.bottomAnchor.constraint(equalTo: host.bottomAnchor),
        ])
    }

    private func viewedScope(for session: LiveRunSessionSummary?) -> String {
        guard let session, let horizon else { return "Live Run" }
        guard let node = matchingNode(for: session, in: horizon) else { return "Live Run" }
        if case .present(let parent) = node.parentNodeId, let parentId = parent.value,
           let parentNode = horizon.snapshot.nodes.first(where: { $0.nodeId == parentId })
        {
            if case .present(let binding) = parentNode.binding {
                return "\(binding.agentId)'s crew"
            }
            return "\(parentId)'s crew"
        }
        return session.name
    }

    private func matchingNode(
        for session: LiveRunSessionSummary,
        in horizon: OuterHorizonScreenState
    ) -> HierarchyNodeProjection? {
        matchingRow(for: session, in: horizon)?.node
    }

    private func matchingSession(
        for node: HierarchyNodeProjection
    ) -> LiveRunSessionSummary? {
        guard case .present(let binding) = node.binding else { return nil }
        return sessions.first {
            !$0.isQueen
                && ($0.agentID == binding.agentId
                    || $0.id == binding.agentId
                    || $0.name == binding.agentId)
        }
    }

    private func matchingRow(
        for session: LiveRunSessionSummary,
        in horizon: OuterHorizonScreenState? = nil
    ) -> OuterHorizonTreeRow? {
        let source = horizon ?? self.horizon
        return source?.visibleRows.first { row in
            if session.isQueen {
                if case .present(let binding) = row.node.binding {
                    return binding.agentId == LiveRunSessionSummary.queenName
                        || binding.agentId == LiveRunSessionSummary.queenID
                }
                return false
            }
            if case .present(let binding) = row.node.binding {
                return binding.agentId == session.agentID || binding.agentId == session.id
                    || binding.agentId == session.name
            }
            return false
        }
    }

    private func roleLine(for session: LiveRunSessionSummary) -> String {
        if let horizon, let node = matchingNode(for: session, in: horizon) {
            let role = present(node.organizationalRole) { $0.rawValue }
            let assignment = present(node.assignmentKind) { $0.rawValue }
            if let role, let assignment { return "\(role) · \(assignment)" }
            if let role { return role }
        }
        return "hierarchy role unknown"
    }

    private func providerLine(for session: LiveRunSessionSummary) -> String {
        let providerID = session.isQueen
            ? (queenProvider ?? session.provider)
            : session.provider
        if providerID == ProviderID("unknown") {
            return "provider not projected"
        }
        return ProviderBranding.title(for: providerID)
    }

    private func present<Value>(
        _ field: HierarchyProjectionField<Value>,
        render: (Value) -> String
    ) -> String? where Value: Codable & Equatable & Sendable {
        guard case .present(let value) = field else { return nil }
        return render(value)
    }

    private static func budgetSummary(_ horizon: OuterHorizonScreenState) -> String {
        guard let budget = horizon.snapshot.budgets.first else {
            return "Run budget · not projected"
        }
        switch budget.limits {
        case .absent(let reason, let detail):
            return "Run budget absent · \(reason.rawValue) — \(detail)"
        case .present(let limits):
            return "Run budget · \(limits.activeSessions.used) / \(limits.activeSessions.hard) sessions"
        }
    }
}

private final class LiveRunRailClipView: NSClipView {
    override var isFlipped: Bool { true }
}

private final class LiveRunSessionButton: NSButton {
    private let onSelect: () -> Void
    private let onToggle: (() -> Void)?

    init(
        session: LiveRunSessionSummary?,
        hierarchyRow: OuterHorizonTreeRow?,
        selected: Bool,
        depth: Int = 0,
        role: String? = nil,
        expanded: Bool = false,
        onSelect: @escaping () -> Void,
        onToggle: (() -> Void)?
    ) {
        self.onSelect = onSelect
        self.onToggle = onToggle
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        isBordered = false
        title = ""
        target = self
        action = #selector(selectRow)
        wantsLayer = true
        layer?.cornerRadius = Theme.Metric.buttonCornerRadius
        layer?.backgroundColor = selected
            ? Theme.accentFill.cgColor
            : nil
        layer?.borderWidth = 0

        let titleText: String
        if let session {
            titleText = session.name
        } else if let node = hierarchyRow?.node,
                  case .present(let binding) = node.binding {
            titleText = binding.agentId
        } else {
            titleText = hierarchyRow?.node.nodeId ?? "unknown hierarchy node"
        }
        let name = NSTextField(labelWithString: titleText)
        name.font = Theme.Font.headline
        name.textColor = Theme.primaryText
        name.lineBreakMode = .byTruncatingTail
        // Ten sibling crew rows differ only in the tail of their names, so the
        // rail's fixed width has to be spent on identity first. These sit above
        // the capsule label's own 460: the status pill carries the same value on
        // every row, and a row that truncates away what distinguishes it from
        // its siblings is not a row anyone can choose from.
        name.compressHorizontally(priority: 620, toolTip: titleText)
        let roleText = role ?? Self.roleLine(hierarchyRow?.node)
        let providerText: String
        let modelText: String
        if let session {
            providerText = session.provider == ProviderID("unknown")
                ? "provider not projected"
                : ProviderBranding.title(for: session.provider)
            modelText = session.model ?? "model not projected"
        } else {
            providerText = "provider not projected"
            modelText = "model not projected"
        }
        let roleLabel = rowDetail(roleText)
        let providerLabel = rowDetail(providerText)
        let modelLabel = rowDetail(modelText)
        let copy = NSStackView(views: [name, roleLabel, providerLabel, modelLabel])
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = 1

        let activity = session?.activity
        let disclosure: NSView
        if onToggle != nil {
            let button = NSButton(
                image: NSImage(
                    systemSymbolName: expanded ? "chevron.down" : "chevron.right",
                    accessibilityDescription: expanded ? "Collapse" : "Expand") ?? NSImage(),
                target: nil,
                action: nil)
            button.isBordered = false
            button.contentTintColor = Theme.secondaryText
            button.target = self
            button.action = #selector(toggleRow)
            button.setAccessibilityLabel(expanded ? "Collapse hierarchy node" : "Expand hierarchy node")
            disclosure = button
        } else {
            disclosure = NSView()
        }
        disclosure.translatesAutoresizingMaskIntoConstraints = false
        disclosure.widthAnchor.constraint(
            equalToConstant: Theme.Metric.chainMarkSize).isActive = true

        let chip = CapsuleBadge(
            text: activity?.displayLabel.uppercased() ?? "NO SESSION",
            symbol: activity?.appearance.symbol ?? "questionmark.circle",
            style: activity.map { liveRunBadgeStyle(for: $0.appearance.color) } ?? .neutral)
        let row = NSStackView(views: [disclosure, copy, chip])
        row.translatesAutoresizingMaskIntoConstraints = false
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = Theme.Space.s
        addSubview(row)
        let indent = Theme.Space.s + CGFloat(max(0, depth)) * Theme.Space.m
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: indent),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Theme.Space.s),
            row.topAnchor.constraint(equalTo: topAnchor, constant: Theme.Space.s),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Theme.Space.s),
        ])
        copy.setContentHuggingPriority(.defaultLow, for: .horizontal)
        chip.setContentHuggingPriority(.required, for: .horizontal)
        chip.setContentCompressionResistancePriority(.init(200), for: .horizontal)

        if selected {
            let bar = NSView()
            bar.translatesAutoresizingMaskIntoConstraints = false
            Theme.paint(bar, Theme.accent)
            addSubview(bar)
            NSLayoutConstraint.activate([
                bar.leadingAnchor.constraint(equalTo: leadingAnchor),
                bar.topAnchor.constraint(equalTo: topAnchor),
                bar.bottomAnchor.constraint(equalTo: bottomAnchor),
                bar.widthAnchor.constraint(equalToConstant: Theme.Space.xs / 2),
            ])
        }

        toolTip = session.flatMap { $0.model ?? $0.rawStatus }
            ?? hierarchyRow?.parentDiagnostic
        if let session {
            setAccessibilityIdentifier("live-run-session-\(session.id)")
            setAccessibilityLabel(
                "\(session.name), \(ProviderBranding.title(for: session.provider)), \(session.activity.displayLabel)")
        } else if let node = hierarchyRow?.node {
            setAccessibilityIdentifier("live-run-hierarchy-\(node.nodeId)")
            setAccessibilityLabel("\(titleText), session status unknown")
        }
        heightAnchor.constraint(
            greaterThanOrEqualToConstant: Theme.Metric.controlMinHeight + Theme.Space.s).isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    @objc private func selectRow() {
        onSelect()
    }

    @objc private func toggleRow() {
        onToggle?()
    }

    private static func roleLine(_ node: HierarchyNodeProjection?) -> String {
        guard let node else { return "hierarchy role unknown" }
        let role: String? = if case .present(let value) = node.organizationalRole {
            value.rawValue
        } else {
            nil
        }
        let assignment: String? = if case .present(let value) = node.assignmentKind {
            value.rawValue
        } else {
            nil
        }
        let rendered = [role, assignment].compactMap { $0 }.joined(separator: " · ")
        return rendered.isEmpty ? "hierarchy role unknown" : rendered
    }

    private func rowDetail(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = Theme.Font.caption
        label.textColor = Theme.tertiaryText
        label.lineBreakMode = .byTruncatingTail
        label.compressHorizontally(priority: 560, toolTip: text)
        return label
    }

    private static func lifecycleLine(_ node: HierarchyNodeProjection?) -> String {
        guard let node, case .present(let lifecycle) = node.lifecycle else {
            return "lifecycle unknown"
        }
        return "lifecycle \(lifecycle.rawValue)"
    }
}

private func liveRunBadgeStyle(for color: StatusColor) -> CapsuleBadge.Style {
    switch color {
    case .green: return .positive
    case .yellow, .orange: return .warning
    case .blue, .teal: return .info
    case .red: return .critical
    case .purple, .gray: return .neutral
    }
}
