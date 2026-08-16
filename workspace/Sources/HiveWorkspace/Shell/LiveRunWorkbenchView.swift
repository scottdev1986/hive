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
    private let railStack = NSStackView()
    private let terminalHost = NSView()
    private let terminalPlaceholder = NSTextField(wrappingLabelWithString: "")
    private let errorLabel = NSTextField(wrappingLabelWithString: "")
    private let titleLabel = NSTextField(labelWithString: "No live session selected")
    private let subtitleLabel = NSTextField(labelWithString: "Waiting for workspace-feed v1")
    private let locatorLabel = NSTextField(labelWithString: "Exact generation · unknown")
    private let providerHost = NSView()
    private let inspectorName = NSTextField(labelWithString: "No selection")
    private let inspectorModel = NSTextField(labelWithString: "model unknown")
    private let statusValue = NSTextField(labelWithString: "unknown")
    private let shellValue = NSTextField(wrappingLabelWithString: "unknown")
    private let providerRunValue = NSTextField(wrappingLabelWithString: "absent")
    private let inputValue = NSTextField(wrappingLabelWithString: "unknown")
    private let censusValue = NSTextField(wrappingLabelWithString: "absent")
    private let terminationValue = NSTextField(wrappingLabelWithString: "unknown")
    private let stopButton = NSButton(title: "Stop Provider", target: nil, action: nil)
    private let terminateButton = NSButton(title: "Terminate Terminal", target: nil, action: nil)

    private var sessions: [LiveRunSessionSummary] = []
    private var selectedID: String?
    private var terminal: LiveRunTerminalSurface?
    private var visibleLocator: AgentSessionLocator?
    private var controlProjection: LiveRunControlProjection?
    private var routeVisible = false

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
            selectedID = sessions.first(where: { $0.locator != nil })?.id
                ?? sessions.first?.id
        }
        if sessions != priorSessions || selectedID != priorSelection {
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
        wantsLayer = true
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        let rail = makeRail()
        let center = makeCenter()
        let inspector = makeInspector()
        let leftSeparator = NSBox.hdsSeparator()
        let rightSeparator = NSBox.hdsSeparator()
        leftSeparator.widthAnchor.constraint(equalToConstant: 1).isActive = true
        rightSeparator.widthAnchor.constraint(equalToConstant: 1).isActive = true

        let layout = NSStackView(views: [rail, leftSeparator, center, rightSeparator, inspector])
        layout.translatesAutoresizingMaskIntoConstraints = false
        layout.orientation = .horizontal
        layout.alignment = .top
        layout.spacing = 0
        addSubview(layout)
        NSLayoutConstraint.activate([
            layout.leadingAnchor.constraint(equalTo: leadingAnchor),
            layout.trailingAnchor.constraint(equalTo: trailingAnchor),
            layout.topAnchor.constraint(equalTo: topAnchor),
            layout.bottomAnchor.constraint(equalTo: bottomAnchor),
            rail.widthAnchor.constraint(equalToConstant: 210),
            inspector.widthAnchor.constraint(equalToConstant: 220),
            center.widthAnchor.constraint(greaterThanOrEqualToConstant: 360),
            rail.heightAnchor.constraint(equalTo: layout.heightAnchor),
            center.heightAnchor.constraint(equalTo: layout.heightAnchor),
            inspector.heightAnchor.constraint(equalTo: layout.heightAnchor),
            leftSeparator.heightAnchor.constraint(equalTo: layout.heightAnchor),
            rightSeparator.heightAnchor.constraint(equalTo: layout.heightAnchor),
        ])
    }

    private func makeRail() -> NSView {
        let heading = sectionLabel("SESSIONS")
        let summary = NSTextField(labelWithString: "typed status · one live viewer")
        summary.font = Theme.Font.caption
        summary.textColor = .secondaryLabelColor

        railStack.orientation = .vertical
        railStack.alignment = .leading
        railStack.spacing = Theme.Space.xs
        railStack.translatesAutoresizingMaskIntoConstraints = false

        let scroll = NSScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.contentView = LiveRunRailClipView()
        scroll.documentView = railStack
        railStack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor).isActive = true

        let container = NSStackView(views: [heading, summary, scroll])
        container.translatesAutoresizingMaskIntoConstraints = false
        container.orientation = .vertical
        container.alignment = .leading
        container.spacing = Theme.Space.s
        container.edgeInsets = NSEdgeInsets(
            top: Theme.Space.l, left: Theme.Space.m,
            bottom: Theme.Space.l, right: Theme.Space.m)
        scroll.widthAnchor.constraint(equalTo: container.widthAnchor).isActive = true
        return container
    }

    private func makeCenter() -> NSView {
        titleLabel.font = Theme.Font.title
        titleLabel.compressHorizontally(toolTip: titleLabel.stringValue)
        subtitleLabel.font = Theme.Font.caption
        subtitleLabel.textColor = .secondaryLabelColor
        subtitleLabel.compressHorizontally()
        let identity = NSStackView(views: [titleLabel, subtitleLabel])
        identity.orientation = .vertical
        identity.alignment = .leading
        identity.spacing = 2

        let oneSurface = CapsuleBadge(
            text: "1 GHOSTTY SURFACE", symbol: "rectangle.on.rectangle.slash", style: .neutral)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let header = NSStackView(views: [identity, spacer, oneSurface])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = Theme.Space.s

        locatorLabel.font = Theme.Font.monoCaption
        locatorLabel.textColor = .secondaryLabelColor
        locatorLabel.compressHorizontally(priority: 450)

        errorLabel.font = Theme.Font.caption
        errorLabel.textColor = .systemOrange
        errorLabel.maximumNumberOfLines = 0

        terminalHost.translatesAutoresizingMaskIntoConstraints = false
        terminalHost.wantsLayer = true
        terminalHost.layer?.backgroundColor = NSColor.black.cgColor
        terminalHost.layer?.cornerRadius = Theme.Metric.insetCornerRadius
        terminalHost.layer?.masksToBounds = true
        terminalHost.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        terminalHost.setAccessibilityIdentifier("live-run-terminal-host")

        terminalPlaceholder.translatesAutoresizingMaskIntoConstraints = false
        terminalPlaceholder.font = Theme.Font.monoBody
        terminalPlaceholder.textColor = .secondaryLabelColor
        terminalPlaceholder.alignment = .center
        terminalPlaceholder.maximumNumberOfLines = 0
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

        let container = NSStackView(views: [header, locatorLabel, errorLabel, terminalHost])
        container.translatesAutoresizingMaskIntoConstraints = false
        container.orientation = .vertical
        container.alignment = .leading
        container.spacing = Theme.Space.m
        container.edgeInsets = NSEdgeInsets(
            top: Theme.Space.l, left: Theme.Space.l,
            bottom: Theme.Space.l, right: Theme.Space.l)
        for view in [header, locatorLabel, errorLabel, terminalHost] {
            view.widthAnchor.constraint(equalTo: container.widthAnchor).isActive = true
        }
        return container
    }

    private func makeInspector() -> NSView {
        providerHost.translatesAutoresizingMaskIntoConstraints = false
        providerHost.heightAnchor.constraint(equalToConstant: Theme.Metric.markSize).isActive = true
        providerHost.widthAnchor.constraint(equalToConstant: Theme.Metric.markSize).isActive = true
        inspectorName.font = Theme.Font.title
        inspectorName.compressHorizontally()
        inspectorModel.font = Theme.Font.monoCaption
        inspectorModel.textColor = .secondaryLabelColor
        inspectorModel.compressHorizontally()
        let identity = NSStackView(views: [providerHost, inspectorName])
        identity.orientation = .horizontal
        identity.alignment = .centerY
        identity.spacing = Theme.Space.s

        let stack = NSStackView()
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.m
        stack.edgeInsets = NSEdgeInsets(
            top: Theme.Space.l, left: Theme.Space.m,
            bottom: Theme.Space.l, right: Theme.Space.m)
        stack.addArrangedSubview(sectionLabel("SESSION FACTS"))
        stack.addArrangedSubview(identity)
        stack.addArrangedSubview(inspectorModel)
        stack.addArrangedSubview(NSBox.hdsSeparator())
        for (label, value) in [
            ("Agent status", statusValue),
            ("Shell root", shellValue),
            ("ProviderRun", providerRunValue),
            ("Input owner", inputValue),
            ("Cwd census", censusValue),
            ("Termination proof", terminationValue),
        ] {
            stack.addArrangedSubview(fact(label, value: value))
        }
        stack.addArrangedSubview(NSBox.hdsSeparator())
        stopButton.bezelStyle = .rounded
        stopButton.target = self
        stopButton.action = #selector(stopProvider)
        stopButton.isEnabled = false
        stopButton.isHidden = true
        stopButton.setAccessibilityIdentifier("live-run-stop-provider")
        terminateButton.bezelStyle = .rounded
        terminateButton.target = self
        terminateButton.action = #selector(terminateTerminal)
        terminateButton.isEnabled = false
        terminateButton.isHidden = true
        terminateButton.setAccessibilityIdentifier("live-run-terminate-terminal")
        stack.addArrangedSubview(stopButton)
        stack.addArrangedSubview(terminateButton)
        stopButton.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        terminateButton.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        return stack
    }

    private func rebuildRail() {
        for view in railStack.arrangedSubviews {
            railStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
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
        subtitleLabel.stringValue = "\(ProviderBranding.title(for: session.provider)) · \(session.rawStatus)"
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
            terminalPlaceholder.stringValue = "Terminal renderer unavailable: \(error.localizedDescription)"
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
        label.textColor = .secondaryLabelColor
        value.font = Theme.Font.monoCaption
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
        label.textColor = .secondaryLabelColor
        label.alphaValue = 0.9
        return label
    }
}

private final class LiveRunRailClipView: NSClipView {
    override var isFlipped: Bool { true }
}

private final class LiveRunSessionButton: NSButton {
    private let onSelect: () -> Void

    init(session: LiveRunSessionSummary, selected: Bool, onSelect: @escaping () -> Void) {
        self.onSelect = onSelect
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        target = self
        action = #selector(selectRow)
        bezelStyle = .recessed
        alignment = .left
        imagePosition = .imageLeading
        imageHugsTitle = true
        font = Theme.Font.callout
        title = "\(session.name) · \(ProviderBranding.title(for: session.provider))"
        image = NSImage(
            systemSymbolName: session.activity.appearance.symbol,
            accessibilityDescription: session.rawStatus)
        contentTintColor = Theme.statusColor(for: session.activity.appearance.color)
        state = selected ? .on : .off
        toolTip = session.task ?? session.model
        setAccessibilityIdentifier("live-run-session-\(session.id)")
        setAccessibilityLabel(
            "\(session.name), \(ProviderBranding.title(for: session.provider)), \(session.rawStatus)")
        heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    @objc private func selectRow() {
        onSelect()
    }
}
