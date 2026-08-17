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
    private let hierarchyCountLabel = NSTextField(labelWithString: "typed status · one live viewer")
    private let budgetLabel = NSTextField(labelWithString: "Run budget · waiting for sessions")
    private let terminalHost = NSView()
    private let terminalPlaceholder = NSTextField(wrappingLabelWithString: "")
    private let errorLabel = NSTextField(wrappingLabelWithString: "")
    private let titleLabel = NSTextField(labelWithString: "No live session selected")
    private let subtitleLabel = NSTextField(labelWithString: "Waiting for workspace-feed v1")
    private let locatorLabel = NSTextField(labelWithString: "Exact generation · unknown")
    private let scopeValue = NSTextField(labelWithString: "Live Run")
    private let focusValue = NSTextField(labelWithString: "none")
    private let inputOwnerValue = NSTextField(labelWithString: "unknown")
    private let generationValue = NSTextField(labelWithString: "unknown")
    private let snapshotButton = NSButton(title: "Snapshot", target: nil, action: nil)
    private let releaseInputButton = NSButton(title: "Release Input", target: nil, action: nil)
    private let attachButton = NSButton(title: "Attached live", target: nil, action: nil)
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
    private let inputValue = NSTextField(wrappingLabelWithString: "unknown")
    private let censusValue = NSTextField(wrappingLabelWithString: "absent")
    private let terminationValue = NSTextField(wrappingLabelWithString: "unknown")
    private let stopButton = NSButton(title: "Stop Provider", target: nil, action: nil)
    private let terminateButton = NSButton(title: "Terminate Terminal", target: nil, action: nil)
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
            selectedID = sessions.first(where: { $0.isQueen && $0.locator != nil })?.id
                ?? sessions.first(where: { $0.locator != nil })?.id
                ?? sessions.first?.id
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
            updateInspector(nil)
            return
        }
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
        Theme.paint(self, Theme.Chrome.bg)

        let rail = makeRail()
        let center = makeCenter()
        let inspector = makeInspector()
        let leftSeparator = NSBox.hdsSeparator()
        let rightSeparator = NSBox.hdsSeparator()
        leftSeparator.widthAnchor.constraint(equalToConstant: 1).isActive = true
        rightSeparator.widthAnchor.constraint(equalToConstant: 1).isActive = true
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
            rail.widthAnchor.constraint(equalToConstant: 248),
            inspector.widthAnchor.constraint(equalToConstant: 268),
            center.widthAnchor.constraint(greaterThanOrEqualToConstant: 360),
            rail.heightAnchor.constraint(equalTo: layout.heightAnchor),
            center.heightAnchor.constraint(equalTo: layout.heightAnchor),
            inspector.heightAnchor.constraint(equalTo: layout.heightAnchor),
            leftSeparator.heightAnchor.constraint(equalTo: layout.heightAnchor),
            rightSeparator.heightAnchor.constraint(equalTo: layout.heightAnchor),
        ])
    }

    private func makeRail() -> NSView {
        let heading = sectionLabel("Run hierarchy")
        heading.textColor = Theme.Chrome.muted
        hierarchyCountLabel.font = Theme.Font.caption
        hierarchyCountLabel.textColor = Theme.Chrome.faint
        hierarchyCountLabel.compressHorizontally(
            priority: 430, toolTip: hierarchyCountLabel.stringValue)
        budgetLabel.font = Theme.Font.monoCaption
        budgetLabel.textColor = Theme.Chrome.muted
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

        let header = NSStackView(views: [heading, hierarchyCountLabel])
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
        Theme.paint(container, Theme.Chrome.panel)
        railHost.widthAnchor.constraint(equalTo: container.widthAnchor).isActive = true
        header.widthAnchor.constraint(equalTo: container.widthAnchor).isActive = true
        budget.widthAnchor.constraint(equalTo: container.widthAnchor).isActive = true
        railHost.setContentHuggingPriority(.init(1), for: .vertical)
        railHost.setContentCompressionResistancePriority(.init(1), for: .vertical)
        return container
    }

    private func makeCenter() -> NSView {
        titleLabel.font = Theme.Font.title
        titleLabel.textColor = Theme.Chrome.text
        titleLabel.compressHorizontally(toolTip: titleLabel.stringValue)
        subtitleLabel.font = Theme.Font.caption
        subtitleLabel.textColor = Theme.Chrome.muted
        subtitleLabel.compressHorizontally()
        let identity = NSStackView(views: [titleLabel, subtitleLabel])
        identity.orientation = .vertical
        identity.alignment = .leading
        identity.spacing = 2

        configureAction(snapshotButton, identifier: "live-run-snapshot")
        snapshotButton.toolTip = "Bounded semantic snapshot is not offered on this surface yet."
        snapshotButton.isEnabled = false
        configureAction(releaseInputButton, identifier: "live-run-release-input")
        releaseInputButton.toolTip = "workspace-feed does not project the terminal input owner"
        releaseInputButton.isEnabled = false
        configureAction(attachButton, identifier: "live-run-attach", primary: true)
        let actions = NSStackView(views: [snapshotButton, releaseInputButton, attachButton])
        actions.orientation = .horizontal
        actions.spacing = Theme.Space.s
        actions.alignment = .centerY

        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let header = NSStackView(views: [identity, spacer, actions])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = Theme.Space.s

        locatorLabel.font = Theme.Font.monoCaption
        locatorLabel.textColor = Theme.Chrome.muted
        locatorLabel.compressHorizontally(priority: 450)

        errorLabel.font = Theme.Font.caption
        errorLabel.textColor = .systemOrange
        errorLabel.maximumNumberOfLines = 0

        terminalHost.translatesAutoresizingMaskIntoConstraints = false
        terminalHost.wantsLayer = true
        terminalHost.layer?.backgroundColor = NSColor.black.cgColor
        terminalHost.layer?.cornerRadius = Theme.Metric.insetCornerRadius
        terminalHost.layer?.masksToBounds = true
        terminalHost.setContentHuggingPriority(.init(1), for: .vertical)
        terminalHost.setContentCompressionResistancePriority(.init(1), for: .vertical)
        terminalHost.setAccessibilityIdentifier("live-run-terminal-host")

        terminalPlaceholder.translatesAutoresizingMaskIntoConstraints = false
        terminalPlaceholder.font = Theme.Font.monoBody
        terminalPlaceholder.textColor = .secondaryLabelColor
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
        container.setContentHuggingPriority(.init(1), for: .vertical)
        for view in container.arrangedSubviews {
            view.widthAnchor.constraint(equalTo: container.widthAnchor).isActive = true
        }
        return container
    }

    private func makeControlStrip() -> NSView {
        let cells = [
            controlCell(caption: "Viewed scope", value: scopeValue),
            controlCell(caption: "Keyboard focus", value: focusValue),
            controlCell(caption: "Input owner", value: inputOwnerValue),
            controlCell(caption: "Generation", value: generationValue),
        ]
        var stripViews: [NSView] = []
        for (index, cell) in cells.enumerated() {
            if index > 0 {
                let divider = NSBox.hdsSeparator()
                divider.widthAnchor.constraint(equalToConstant: 1).isActive = true
                stripViews.append(divider)
            }
            stripViews.append(cell)
        }
        let strip = NSStackView(views: stripViews)
        strip.orientation = .horizontal
        strip.distribution = .fill
        strip.spacing = 0
        strip.alignment = .centerY
        strip.wantsLayer = true
        strip.layer?.backgroundColor = Theme.Chrome.panel2.cgColor
        strip.layer?.borderColor = Theme.Chrome.line.cgColor
        strip.layer?.borderWidth = 1
        strip.layer?.cornerRadius = Theme.Metric.insetCornerRadius
        strip.setAccessibilityIdentifier("live-run-control-strip")
        for cell in cells {
            cell.widthAnchor.constraint(greaterThanOrEqualTo: strip.widthAnchor, multiplier: 0.22)
                .isActive = true
        }
        return strip
    }

    private func controlCell(caption: String, value: NSTextField) -> NSView {
        let label = NSTextField(labelWithString: caption)
        label.font = Theme.Font.sectionLabel
        label.textColor = Theme.Chrome.faint
        value.font = Theme.Font.headline
        value.textColor = Theme.Chrome.text
        value.compressHorizontally(priority: 430, toolTip: value.stringValue)
        let stack = NSStackView(views: [label, value])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 2
        stack.edgeInsets = NSEdgeInsets(
            top: Theme.Space.s, left: Theme.Space.m,
            bottom: Theme.Space.s, right: Theme.Space.m)
        return stack
    }

    private func makeInspector() -> NSView {
        providerHost.translatesAutoresizingMaskIntoConstraints = false
        providerHost.heightAnchor.constraint(equalToConstant: Theme.Metric.markSize).isActive = true
        providerHost.widthAnchor.constraint(equalToConstant: Theme.Metric.markSize).isActive = true
        inspectorName.font = Theme.Font.title
        inspectorName.textColor = Theme.Chrome.text
        inspectorName.compressHorizontally()
        inspectorModel.font = Theme.Font.monoCaption
        inspectorModel.textColor = Theme.Chrome.muted
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
            Theme.styleMockupButton(button, primary: tab == inspectorTab)
            button.setButtonType(.momentaryPushIn)
            button.setAccessibilityIdentifier("live-run-inspector-tab-\(tab.rawValue)")
            button.setAccessibilityLabel("\(tab.title) inspector tab")
            button.setAccessibilityRole(.button)
            button.target = self
            button.action = #selector(inspectorTabClicked(_:))
            inspectorTabButtons[tab] = button
            tabs.addArrangedSubview(button)
        }

        fillPane(
            taskPane,
            views: [
                microLabel("TaskDetail"),
                styled(taskTitle, font: Theme.Font.headline),
                styled(taskBody, font: Theme.Font.callout, color: .secondaryLabelColor),
            ])
        fillPane(
            eventsPane,
            views: [
                microLabel("Typed history"),
                styled(eventsBody, font: Theme.Font.callout, color: .secondaryLabelColor),
            ])

        let sessionStack = NSStackView()
        sessionStack.translatesAutoresizingMaskIntoConstraints = false
        sessionStack.orientation = .vertical
        sessionStack.alignment = .leading
        sessionStack.spacing = Theme.Space.m
        sessionStack.addArrangedSubview(identity)
        sessionStack.addArrangedSubview(inspectorModel)
        sessionStack.addArrangedSubview(NSBox.hdsSeparator())
        for (label, value) in [
            ("Agent status", statusValue),
            ("Shell root", shellValue),
            ("ProviderRun", providerRunValue),
            ("Input owner", inputValue),
            ("Cwd census", censusValue),
            ("Termination proof", terminationValue),
        ] {
            sessionStack.addArrangedSubview(fact(label, value: value))
        }
        sessionStack.addArrangedSubview(NSBox.hdsSeparator())
        Theme.styleMockupButton(stopButton)
        stopButton.target = self
        stopButton.action = #selector(stopProvider)
        stopButton.isEnabled = false
        stopButton.isHidden = true
        stopButton.setAccessibilityIdentifier("live-run-stop-provider")
        Theme.styleMockupButton(terminateButton, primary: false)
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
        Theme.paint(stack, Theme.Chrome.panel)
        stack.edgeInsets = NSEdgeInsets(
            top: Theme.Space.l, left: Theme.Space.m,
            bottom: Theme.Space.l, right: Theme.Space.m)
        Theme.paint(stack, Theme.Chrome.panel)
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
            hierarchyCountLabel.stringValue =
                "\(sessions.count) live · \(horizon.visibleRows.count) visible / \(horizon.snapshot.nodes.count) admitted"
            budgetLabel.stringValue = Self.budgetSummary(horizon)
        } else {
            hierarchyCountLabel.stringValue =
                sessions.isEmpty
                ? "typed status · one live viewer"
                : "\(sessions.count) visible / \(sessions.count) admitted"
            budgetLabel.stringValue = sessions.isEmpty
                ? "Run budget · waiting for sessions"
                : "Run budget · \(sessions.count) / \(sessions.count) sessions"
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

        guard !sessions.isEmpty else {
            let empty = NSTextField(wrappingLabelWithString: "No live agents were projected.")
            empty.font = Theme.Font.caption
            empty.textColor = .secondaryLabelColor
            railStack.addArrangedSubview(empty)
            empty.widthAnchor.constraint(equalTo: railStack.widthAnchor).isActive = true
            return
        }
        for session in sessions {
            let button = LiveRunSessionButton(
                session: session,
                selected: session.id == selectedID,
                depth: matchingRow(for: session)?.depth ?? (session.isQueen ? 0 : 1),
                role: roleLine(for: session),
                onSelect: { [weak self] in self?.selectSession(id: session.id) })
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
            updateInspector(nil)
            publishVisibleSessionIfChanged(nil)
            return
        }

        if controlProjection?.agentID != session.id
            || controlProjection?.locator != session.locator
        {
            controlProjection = nil
        }

        titleLabel.stringValue = session.isQueen ? "queen" : session.name
        subtitleLabel.stringValue =
            "\(agentUiLine(for: session)) · \(session.task ?? session.rawStatus)"
        updateControlStrip(session)
        updateInspector(session)
        guard routeVisible else { return }
        guard let locator = session.locator else {
            detachTerminal()
            locatorLabel.stringValue = "Exact generation · unknown"
            terminalPlaceholder.stringValue = session.locatorFact?.reason
                ?? "No exact terminal locator was projected."
            terminalPlaceholder.isHidden = false
            publishVisibleSessionIfChanged(nil)
            return
        }
        locatorLabel.stringValue = "\(locator.sessionId) · generation \(locator.generation) exact"
        if terminal?.locator == locator {
            publishVisibleSessionIfChanged(session)
            return
        }

        detachTerminal()
        guard let terminalFactory else {
            terminalPlaceholder.stringValue = "Terminal transport is absent in this launch."
            terminalPlaceholder.isHidden = false
            publishVisibleSessionIfChanged(nil)
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
        } catch {
            fresh.detach()
            let message = "Terminal renderer unavailable: \(error.localizedDescription). The terminal is waiting and will appear automatically."
            NSLog("%@", message)
            terminalPlaceholder.stringValue = message
            terminalPlaceholder.isHidden = false
            publishVisibleSessionIfChanged(nil)
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
            for value in [statusValue, shellValue, providerRunValue, inputValue,
                          censusValue, terminationValue] {
                value.stringValue = "unknown"
                value.toolTip = "No strict feed snapshot is selected."
            }
            stopButton.toolTip = "Provider control contract absent."
            terminateButton.toolTip = "Terminal termination contract absent."
            return
        }
        let mark = ProviderMarkView(provider: session.provider)
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
        set(inputValue, fact: session.inputOwner)
        set(censusValue, fact: session.processCensus)
        set(terminationValue, fact: session.termination)
        stopButton.toolTip = session.providerRun.reason
        terminateButton.toolTip = session.termination.reason
        stopButton.setAccessibilityHelp(session.providerRun.reason)
        terminateButton.setAccessibilityHelp(session.termination.reason)
    }

    private func renderControlProjection(_ projection: LiveRunControlProjection) {
        switch projection.shell.state {
        case .retained:
            let root = projection.shell.root!
            shellValue.stringValue = "retained · zsh pid \(root.pid) · foreground \(projection.shell.foreground!.rawValue)"
        case .terminated:
            shellValue.stringValue = "terminated"
        case .unknown:
            shellValue.stringValue = "unknown · \(projection.shell.reason!)"
        }
        switch projection.providerRun.state {
        case .running:
            let process = projection.providerRun.process!
            providerRunValue.stringValue = "\(projection.providerRun.runID!) · pid \(process.pid) · pgid \(process.processGroupId)"
        case .absent:
            providerRunValue.stringValue = "absent"
        case .unknown:
            providerRunValue.stringValue = "unknown · \(projection.providerRun.reason!)"
        }
        switch projection.inputOwner.state {
        case .free:
            inputValue.stringValue = "free"
        case .owned:
            inputValue.stringValue = "\(projection.inputOwner.kind!.rawValue) · \(projection.inputOwner.writer!)"
        case .unknown:
            inputValue.stringValue = "unknown · \(projection.inputOwner.reason!)"
        }
        switch projection.processCensus.state {
        case .complete:
            censusValue.stringValue = "\(projection.processCensus.members.count) verified process-tree members"
        case .terminated:
            censusValue.stringValue = "terminated · no survivors"
        case .unknown:
            censusValue.stringValue = "unknown · \(projection.processCensus.reason!)"
        }
        switch projection.termination.state {
        case .notRequested:
            terminationValue.stringValue = "not requested"
        case .terminated:
            terminationValue.stringValue = "terminated · \(projection.termination.completedAt!)"
        case .survivors:
            terminationValue.stringValue = "\(projection.termination.survivors.count) verified survivors"
        case .unknown:
            terminationValue.stringValue = "unknown · \(projection.termination.reason!)"
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
        label.textColor = fact.label == "unknown" ? .systemOrange : .secondaryLabelColor
    }

    private func fact(_ title: String, value: NSTextField) -> NSView {
        let label = NSTextField(labelWithString: title)
        label.font = Theme.Font.caption
        label.textColor = Theme.Chrome.muted
        value.font = Theme.Font.monoCaption
        value.textColor = Theme.Chrome.text
        value.maximumNumberOfLines = 0
        value.compressHorizontally(priority: 450)
        let stack = NSStackView(views: [label, value])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 2
        return stack
    }

    private func sectionLabel(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = Theme.Font.sectionLabel
        label.textColor = Theme.Chrome.faint
        label.alphaValue = 0.9
        return label
    }

    private func microLabel(_ text: String) -> NSTextField {
        let field = NSTextField(labelWithString: text.uppercased())
        field.font = Theme.Font.sectionLabel
        field.textColor = Theme.Chrome.faint
        return field
    }

    private func styled(
        _ field: NSTextField,
        font: NSFont,
        color: NSColor = Theme.Chrome.text
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

    private func configureAction(
        _ button: NSButton,
        identifier: String,
        primary: Bool = false
    ) {
        Theme.styleMockupButton(button, primary: primary)
        button.setAccessibilityIdentifier(identifier)
        button.setAccessibilityRole(.button)
    }

    private func selectHierarchyNode(_ nodeId: String) {
        onHorizonSelect?(nodeId)
        guard let node = horizon?.snapshot.nodes.first(where: { $0.nodeId == nodeId }),
              case .present(let binding) = node.binding
        else { return }
        if let session = sessions.first(where: {
            $0.agentID == binding.agentId || $0.id == binding.agentId
        }) {
            selectSession(id: session.id)
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
            Theme.styleMockupButton(button, primary: candidate == tab)
            button.setAccessibilityValue(candidate == tab ? "selected" : "unselected")
        }
    }

    private func updateControlStrip(_ session: LiveRunSessionSummary?) {
        scopeValue.stringValue = viewedScope(for: session)
        focusValue.stringValue = session?.name ?? "none"
        if let projection = controlProjection, let session,
           projection.agentID == session.id {
            switch projection.inputOwner.state {
            case .free:
                inputOwnerValue.stringValue = "free"
            case .owned:
                inputOwnerValue.stringValue =
                    "\(projection.inputOwner.kind!.rawValue) · claimed"
            case .unknown:
                inputOwnerValue.stringValue = "unknown"
            }
        } else {
            inputOwnerValue.stringValue = session.map { _ in "unknown" } ?? "unknown"
        }
        if let generation = session?.locator?.generation {
            generationValue.stringValue = "\(generation) · exact"
            attachButton.title = "Attached live · g\(generation)"
            attachButton.isEnabled = true
            attachButton.toolTip = "Viewer is attached to exact generation \(generation)."
        } else {
            generationValue.stringValue = "unknown"
            attachButton.title = "Attached live"
            attachButton.isEnabled = false
            attachButton.toolTip = "No exact terminal locator is selected."
        }
        releaseInputButton.isEnabled = false
        releaseInputButton.toolTip = session?.inputOwner.reason
            ?? "workspace-feed does not project the terminal input owner"
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
        if session.isQueen { return "orchestrator · no code" }
        return agentUiLine(for: session)
    }

    private func agentUiLine(for session: LiveRunSessionSummary) -> String {
        let providerID = session.isQueen
            ? (queenProvider ?? session.provider)
            : session.provider
        if providerID == ProviderID("unknown") {
            return "Agent UI"
        }
        return "Agent UI · \(ProviderBranding.title(for: providerID))"
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
            return "Run budget · \(horizon.snapshot.nodes.count) admitted · 19 target"
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

    init(
        session: LiveRunSessionSummary,
        selected: Bool,
        depth: Int = 0,
        role: String? = nil,
        onSelect: @escaping () -> Void
    ) {
        self.onSelect = onSelect
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        isBordered = false
        title = ""
        target = self
        action = #selector(selectRow)
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.backgroundColor = selected
            ? Theme.Chrome.navActive.cgColor
            : nil
        if selected {
            layer?.borderWidth = 0
        }

        let titleText = session.isQueen ? "queen · root" : session.name
        let name = NSTextField(labelWithString: titleText)
        name.font = Theme.Font.headline
        name.textColor = Theme.Chrome.text
        name.lineBreakMode = .byTruncatingTail
        name.compressHorizontally(priority: 300, toolTip: titleText)
        let detail = NSTextField(labelWithString:
            "\(role ?? "Agent UI") · \(session.task ?? session.model ?? session.rawStatus)")
        detail.font = Theme.Font.caption
        detail.textColor = Theme.Chrome.muted
        detail.lineBreakMode = .byTruncatingTail
        detail.compressHorizontally(priority: 250, toolTip: detail.stringValue)
        let copy = NSStackView(views: [name, detail])
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = 1

        let symbol = NSImageView()
        symbol.image = NSImage(
            systemSymbolName: session.activity.appearance.symbol,
            accessibilityDescription: session.activity.displayLabel)
        symbol.contentTintColor = Theme.statusColor(for: session.activity.appearance.color)
        symbol.translatesAutoresizingMaskIntoConstraints = false
        symbol.widthAnchor.constraint(equalToConstant: 14).isActive = true
        symbol.heightAnchor.constraint(equalToConstant: 14).isActive = true

        let chip = ActivityChip(activity: session.activity)
        let row = NSStackView(views: [symbol, copy, chip])
        row.translatesAutoresizingMaskIntoConstraints = false
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = Theme.Space.s
        addSubview(row)
        let indent = Theme.Space.s + CGFloat(max(0, depth)) * Theme.Space.l
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: indent),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Theme.Space.s),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
        ])
        copy.setContentHuggingPriority(.defaultLow, for: .horizontal)
        chip.setContentHuggingPriority(.required, for: .horizontal)

        toolTip = session.task ?? session.model
        setAccessibilityIdentifier("live-run-session-\(session.id)")
        setAccessibilityLabel(
            "\(session.name), \(ProviderBranding.title(for: session.provider)), \(session.activity.displayLabel)")
        heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    @objc private func selectRow() {
        onSelect()
    }
}

private final class ActivityChip: NSView {
    init(activity: AgentActivity) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.cornerRadius = Theme.Metric.badgeCornerRadius
        let color = Theme.statusColor(for: activity.appearance.color)
        layer?.backgroundColor = color.withAlphaComponent(0.16).cgColor

        let label = NSTextField(labelWithString: activity.displayLabel.uppercased())
        label.font = Theme.Font.badge
        label.textColor = color
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2),
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel(activity.displayLabel)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}
