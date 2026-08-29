
import AppKit
import WorkspaceCore
#if HIVE_QA_BUILD
import HiveTerminalKit
#endif

/// The only shell operations the separate QA target may drive. The concrete
/// controller stays internal to the application module.
public protocol WorkspaceShellQASurface: AnyObject {
    var shellQAWindow: NSWindow? { get }
    var shellQAHasLiveRunWorkbench: Bool { get }
    func selectShellQARoute(named route: String) -> Bool
}

final class WorkspaceShellWindowController: NSWindowController {

    private var state: ShellState
    private let dispatcher: ShellDispatcher
    private let sidebar: ShellSidebarView
    private let topBar = ShellTopBarView()
    private let bannerStack = NSStackView()
    private var emptyBannerHeightConstraint: NSLayoutConstraint?
    private var bannerContentBottomConstraint: NSLayoutConstraint?
    private let mainRow = NSStackView()
    private let screenScrollView = NSScrollView()
    private let screenHost = ShellScreenDocumentView()
    private var liveRunHeightCeiling: NSLayoutConstraint?
    private var outerHorizonViewportConstraint: NSLayoutConstraint?
    private var drawer: ShellAttentionDrawerView?
    private var drawerSeparator: NSBox?
    private var inspector: ShellInspectorView?
    private var inspectorSeparator: NSBox?
    /// Kept across shell renders so unrelated state refreshes can reuse the selected exact-generation viewer.
    private var liveRunWorkbench: LiveRunWorkbenchView?
    var probeRefreshHandler: (() -> Void)?
    private var providerProbeRefreshState: ShellProviderProbeRefreshState = .idle
    /// The daemon write seam. A launch without a daemon connection leaves this nil and the Model Control controls stay disabled rather than pretending.
    var policyWriteHandler: ((ShellPolicyWrite) -> Void)?
    var queenProviderSwapHandler: (() -> Void)?
    var memoryRecallHandler: ((MemoryRecallRequest) -> Void)?
    var memoryLibraryPageHandler: ((MemoryLibraryStep, MemoryLibraryFilter) -> Void)?
    var memoryJobHandler: ((MemoryJobKind) -> Void)?
    private var memoryActionBanner: ShellBanner?
    private var renderedRoute: ShellRoute?

    init(context: ShellSidebarView.Context, state: ShellState) {
        self.state = state
        dispatcher = ShellDispatcher()
        sidebar = ShellSidebarView(context: context, onSelect: { _ in })
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        window.minSize = NSSize(width: 940, height: 560)
        window.title = "Hive Workspace — \(context.projectName)"
        window.backgroundColor = Theme.workspaceBackground
        window.center()
        super.init(window: window)
        sidebar.onSelect = { [weak self] route in
            self?.performRoute(route)
        }
        topBar.onAttention = { [weak self] in self?.perform(.toggleAttention) }
        layoutContent()
        render()
        window.initialFirstResponder = sidebar.navButtonsInOrder.first
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    var navButtonCount: Int { sidebar.navButtonsInOrder.count }

    var currentState: ShellState { state }
    var qaCurrentRoute: String { state.activeRoute.rawValue }
    var selectedLiveRunLocator: AgentSessionLocator? { liveRunWorkbench?.selectedLocator }
    var installedLiveRunTerminalCount: Int {
        liveRunWorkbench?.installedTerminalCount ?? 0
    }
#if HIVE_QA_BUILD
    var qaAttachedTerminalView: HiveTerminalView? {
        liveRunWorkbench?.qaAttachedTerminalView
    }
#endif

    func apply(_ mutation: (inout ShellState) -> Void) {
        mutation(&state)
        render()
    }

    @discardableResult
    func beginProviderProbeRefresh() -> Bool {
        guard providerProbeRefreshState != .refreshing else { return false }
        providerProbeRefreshState = .refreshing
        render()
        return true
    }

    func finishProviderProbeRefresh(_ result: ShellProviderProbeRefreshState) {
        providerProbeRefreshState = result
        render()
    }

    /// Reports an action result without rewriting the projection it acted on. In particular, a daemon refusal is an answer, not a lost connection.
    func showMemoryActionBanner(_ banner: ShellBanner?) {
        memoryActionBanner = banner
        render()
    }

    func installLiveRunWorkbench(_ workbench: LiveRunWorkbenchView) {
        liveRunWorkbench?.setRouteVisible(false)
        liveRunWorkbench = workbench
        workbench.setRouteVisible(state.activeRoute == .liveRun)
        render()
    }

    func detachLiveRunViewer() {
        liveRunWorkbench?.setRouteVisible(false)
    }

    private func layoutContent() {
        guard let contentView = window?.contentView else { return }

        bannerStack.orientation = .vertical
        bannerStack.spacing = 0
        bannerStack.translatesAutoresizingMaskIntoConstraints = false
        bannerStack.setAccessibilityIdentifier("shell-banners")

        mainRow.orientation = .horizontal
        mainRow.distribution = .fill
        mainRow.spacing = 0
        mainRow.alignment = .top
        mainRow.translatesAutoresizingMaskIntoConstraints = false
        mainRow.setAccessibilityIdentifier("shell-main-row")

        sidebar.widthAnchor.constraint(
            equalToConstant: Theme.Metric.sidebarWidth).isActive = true

        let separator = NSBox.hdsVerticalDivider()

        screenScrollView.translatesAutoresizingMaskIntoConstraints = false
        screenScrollView.hasVerticalScroller = true
        screenScrollView.drawsBackground = true
        screenScrollView.backgroundColor = Theme.workspaceBackground
        screenScrollView.documentView = screenHost
        screenScrollView.setAccessibilityIdentifier("shell-screen-scroll")
        screenHost.translatesAutoresizingMaskIntoConstraints = false
        screenHost.setAccessibilityIdentifier("shell-screen-host")

        mainRow.addArrangedSubview(sidebar)
        mainRow.addArrangedSubview(separator)
        mainRow.addArrangedSubview(screenScrollView)

        let root = ShellFillView(color: Theme.workspaceBackground)
        root.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(topBar)
        root.addSubview(bannerStack)
        root.addSubview(mainRow)
        contentView.addSubview(root)
        let emptyBannerHeightConstraint = bannerStack.heightAnchor.constraint(
            equalToConstant: 0)
        emptyBannerHeightConstraint.isActive = true
        self.emptyBannerHeightConstraint = emptyBannerHeightConstraint
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            root.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            root.topAnchor.constraint(equalTo: contentView.topAnchor),
            root.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
            topBar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            topBar.topAnchor.constraint(equalTo: root.topAnchor),
            topBar.heightAnchor.constraint(equalToConstant: Theme.Metric.topBarHeight),
            bannerStack.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            bannerStack.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            bannerStack.topAnchor.constraint(equalTo: topBar.bottomAnchor),
            mainRow.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            mainRow.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            mainRow.topAnchor.constraint(equalTo: bannerStack.bottomAnchor),
            mainRow.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            sidebar.heightAnchor.constraint(equalTo: mainRow.heightAnchor),
            screenHost.widthAnchor.constraint(
                equalTo: screenScrollView.contentView.widthAnchor),
            screenHost.heightAnchor.constraint(
                greaterThanOrEqualTo: screenScrollView.contentView.heightAnchor),
            screenScrollView.heightAnchor.constraint(equalTo: mainRow.heightAnchor),
        ])
        liveRunHeightCeiling = screenHost.heightAnchor
            .constraint(lessThanOrEqualTo: screenScrollView.contentView.heightAnchor)
        separator.heightAnchor.constraint(equalTo: mainRow.heightAnchor).isActive = true
    }

    /// The one dispatch entry every menu item points at. The command travels in the item's identifier — a menu row cannot fire an unnamed action.
    @objc func performShellCommand(_ sender: NSMenuItem) {
        guard let raw = sender.identifier?.rawValue,
              let command = ShellCommand(rawValue: raw) else { return }
        perform(command)
    }

    private func performRoute(_ route: ShellRoute) {
        dispatcher.navigate(to: route, state: &state)
        render()
    }

    func perform(_ command: ShellCommand) {
        let outcome = dispatcher.dispatch(command, state: &state)
        switch outcome {
        case .localPerformed(.aboutHive):
            NSApp.orderFrontStandardAboutPanel(nil)
        case .localPerformed(.detachWorkspace):
            NSApp.terminate(nil)
        case .localPerformed(.enterFullTerminal):
            // The viewer the Live Run workbench already hosts, shown full-window.
            // The command is only offered when that workbench is installed, so
            // this never navigates to a terminal that does not exist.
            state.navigate(to: .liveRun)
            window?.toggleFullScreen(nil)
        default:
            break
        }
        render()
    }

    private func render() {
        sidebar.select(route: state.activeRoute)
        renderBanners()
        renderScreen()
        renderInspector()
        renderDrawer()
        chainKeyViews()
        topBar.apply(
            queenProvider: state.queenProvider?.observed.liveProvider,
            attentionCount: state.attentionQueue.count)
    }

    private func renderBanners() {
        bannerContentBottomConstraint?.isActive = false
        bannerContentBottomConstraint = nil
        for view in bannerStack.arrangedSubviews {
            bannerStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        var banners: [ShellBanner] = []
        let liveRunRetainsHierarchy = state.activeRoute == .liveRun
            && state.outerHorizonWarning != nil
        if !liveRunRetainsHierarchy,
           let screenBanner = state.activeScreen?.banner {
            banners.append(screenBanner)
        }
        if state.activeRoute == .liveRun,
           let outerHorizonWarning = state.outerHorizonWarning {
            banners.append(outerHorizonWarning)
        }
        if let commandBanner = state.commandBanner {
            banners.append(commandBanner)
        }
        if let memoryActionBanner {
            banners.append(memoryActionBanner)
        }
        for banner in banners {
            let view = ShellBannerView(banner: banner, presentation: .global)
            bannerStack.addArrangedSubview(view)
            view.widthAnchor.constraint(
                equalTo: bannerStack.widthAnchor
            ).isActive = true
        }
        emptyBannerHeightConstraint?.isActive = banners.isEmpty
        if let lastBanner = bannerStack.arrangedSubviews.last {
            let constraint = bannerStack.bottomAnchor.constraint(
                equalTo: lastBanner.bottomAnchor)
            constraint.isActive = true
            bannerContentBottomConstraint = constraint
        }
        bannerStack.isHidden = banners.isEmpty
    }

    private func renderScreen() {
        let routeChanged = renderedRoute != state.activeRoute
        let liveRunVisible = state.activeRoute == .liveRun && liveRunWorkbench != nil
        liveRunWorkbench?.applyHierarchy(
            state.outerHorizon,
            screen: state.screens[.liveRun],
            onSelect: { [weak self] nodeId in
                self?.apply { $0.editOuterHorizon { $0.select(nodeId: nodeId) } }
            },
            onToggleExpansion: { [weak self] nodeId in
                self?.apply { $0.editOuterHorizon { $0.toggleExpansion(nodeId: nodeId) } }
            })
        liveRunHeightCeiling?.isActive = liveRunVisible
        liveRunWorkbench?.setRouteVisible(liveRunVisible)
        let screen = state.activeScreen ?? .notFrozen(
            "No projection has been applied for this screen in this build.")
        // Exhaustive over the route on purpose: a screen declared in the
        // registry with no view here is a compile error, not a generic panel at
        // runtime. A case may still fall back to the availability panel when its
        // own typed projection has not arrived — that is a screen without a
        // reading, not a screen without an implementation.
        let panel: NSView
        switch (state.activeRoute, state.router) {
        case (.liveRun, _) where liveRunWorkbench != nil:
            panel = liveRunWorkbench!
        case (.liveRun, _) where state.outerHorizon != nil:
            panel = OuterHorizonScreenView(
                screen: screen,
                horizon: state.outerHorizon!,
                onSelect: { [weak self] nodeId in
                    self?.apply { $0.editOuterHorizon { $0.select(nodeId: nodeId) } }
                },
                onToggleExpansion: { [weak self] nodeId in
                    self?.apply {
                        $0.editOuterHorizon { $0.toggleExpansion(nodeId: nodeId) }
                    }
                })
        case (.queen, _) where state.queenProvider != nil:
            let editor = state.queenProvider!
            panel = QueenProviderScreenView(
                screen: screen,
                editor: editor,
                onSelect: { [weak self] provider in
                    self?.apply { $0.editQueenProvider { $0.select(provider) } }
                },
                onSwap: { [weak self] in self?.queenProviderSwapHandler?() })
        case (.modelsQuota, _):
            panel = ModelsQuotaScreenView(
                screen: screen,
                view: state.modelControlView,
                mutationsAllowed: state.router?.mutationsAllowed ?? false,
                probeState: providerProbeRefreshState,
                onProbe: { [weak self] in self?.probeRefreshHandler?() },
                onWrite: { [weak self] write in self?.policyWriteHandler?(write) })
        case (.taskRouter, let editor?) where state.modelControlView != nil:
            let routing = state.modelControlView!.routing
            panel = TaskRouterScreenView(
                screen: screen,
                editor: editor,
                categories: routing.categories,
                routing: routing,
                probeState: providerProbeRefreshState,
                onProbe: { [weak self] in self?.probeRefreshHandler?() },
                onEditRoute: { [weak self] category, route in
                    guard let self else { return }
                    guard self.state.router == editor else {
                        apply {
                            $0.record(policyWriteRefusal:
                                "The route changed before this edit could be applied. "
                                    + "Review the current route and edit again.")
                        }
                        return
                    }
                    apply {
                        $0.editRouter { $0.setRoute(route, for: category) }
                        $0.record(policyWriteRefusal: nil)
                    }
                },
                onApply: { [weak self] in
                    // One set-route per edited category. The write seam runs
                    // them in order against each accepted read-back.
                    guard let self, let handler = policyWriteHandler else { return }
                    for category in editor.editedCategories(routing.categories) {
                        handler(.route(category))
                    }
                })
        case (.memoryOverview, _):
            panel = MemoryOverviewScreenView(
                screen: screen, overview: state.memory.overview,
                onTestRecall: { [weak self] in self?.performRoute(.memoryRecallLab) })
        case (.memoryLibrary, _):
            panel = MemoryLibraryScreenView(
                screen: screen,
                pager: state.memory.library,
                actionsEnabled: screen.availability == .current
                    && memoryLibraryPageHandler != nil,
                onPage: { [weak self] step in
                    self?.memoryLibraryPageHandler?(
                        step, self?.state.memory.library?.filter ?? MemoryLibraryFilter())
                },
                // A filter change restarts the walk: the cursors on screen name
                // positions in the list that is being replaced.
                onFilter: { [weak self] filter in
                    self?.memoryLibraryPageHandler?(.first, filter)
                })
        case (.memoryRecallLab, _):
            panel = MemoryRecallScreenView(
                screen: screen,
                preview: state.memory.recall,
                actionsEnabled: screen.availability == .current
                    && memoryRecallHandler != nil,
                onInspect: { [weak self] request in self?.memoryRecallHandler?(request) })
        case (.memoryMaintenance, _):
            panel = MemoryMaintenanceScreenView(
                screen: screen,
                maintenance: state.memory.maintenance,
                actionsEnabled: screen.availability == .current
                    && memoryJobHandler != nil,
                onStart: { [weak self] kind in self?.memoryJobHandler?(kind) })
        case (.taskRouter, _), (.liveRun, _), (.queen, _):
            panel = ShellAvailabilityPanel(route: state.activeRoute, screen: screen)
        }
        let alreadyShowing = screenHost.subviews.count == 1 && screenHost.subviews.first === panel
        if !alreadyShowing {
            outerHorizonViewportConstraint?.isActive = false
            outerHorizonViewportConstraint = nil
            for subview in screenHost.subviews {
                subview.removeFromSuperview()
            }
            screenHost.addSubview(panel)
            if panel is OuterHorizonScreenView {
                let constraint = screenHost.heightAnchor.constraint(
                    equalTo: screenScrollView.contentView.heightAnchor)
                constraint.isActive = true
                outerHorizonViewportConstraint = constraint
            }
            NSLayoutConstraint.activate([
                panel.leadingAnchor.constraint(equalTo: screenHost.leadingAnchor),
                panel.trailingAnchor.constraint(equalTo: screenHost.trailingAnchor),
                panel.topAnchor.constraint(equalTo: screenHost.topAnchor),
                panel.bottomAnchor.constraint(equalTo: screenHost.bottomAnchor),
            ])
        }
        if routeChanged {
            screenScrollView.contentView.scroll(to: .zero)
            screenScrollView.reflectScrolledClipView(screenScrollView.contentView)
        }
        renderedRoute = state.activeRoute
    }

    private func renderInspector() {
        inspector?.removeFromSuperview()
        inspector = nil
        inspectorSeparator?.removeFromSuperview()
        inspectorSeparator = nil
        guard state.inspectorVisible else { return }
        let panel = ShellInspectorView(
            projection: state.inspector,
            tab: state.inspectorTab,
            onSelectTab: { [weak self] tab in
                self?.apply { $0.selectInspectorTab(tab) }
            },
            onClose: { [weak self] in
                self?.perform(.toggleInspector)
            })
        panel.widthAnchor.constraint(equalToConstant: 320).isActive = true
        let divider = NSBox.hdsVerticalDivider()
        mainRow.addArrangedSubview(divider)
        mainRow.addArrangedSubview(panel)
        divider.heightAnchor.constraint(equalTo: mainRow.heightAnchor).isActive = true
        inspector = panel
        inspectorSeparator = divider
    }

    private func renderDrawer() {
        drawer?.removeFromSuperview()
        drawer = nil
        drawerSeparator?.removeFromSuperview()
        drawerSeparator = nil
        guard state.attentionDrawerVisible else { return }
        let drawer = ShellAttentionDrawerView(queue: state.attentionQueue) { [weak self] in
            self?.perform(.toggleAttention)
        }
        drawer.widthAnchor.constraint(equalToConstant: 300).isActive = true
        let divider = NSBox.hdsVerticalDivider()
        mainRow.addArrangedSubview(divider)
        mainRow.addArrangedSubview(drawer)
        divider.heightAnchor.constraint(equalTo: mainRow.heightAnchor).isActive = true
        self.drawer = drawer
        drawerSeparator = divider
    }

    private func chainKeyViews() {
        let buttons = sidebar.navButtonsInOrder
        let trail: NSView? = inspector?.closeButton ?? drawer?.closeButton
        for (index, button) in buttons.enumerated() {
            button.nextKeyView = index + 1 < buttons.count
                ? buttons[index + 1]
                : (trail ?? buttons.first)
        }
        if let inspectorClose = inspector?.closeButton {
            inspectorClose.nextKeyView = drawer?.closeButton ?? buttons.first
        }
        drawer?.closeButton.nextKeyView = buttons.first
    }
}

extension WorkspaceShellWindowController: WorkspaceShellQASurface {
    var shellQAWindow: NSWindow? { window }
    var shellQAHasLiveRunWorkbench: Bool { liveRunWorkbench != nil }

    func selectShellQARoute(named route: String) -> Bool {
        guard let route = ShellRoute(rawValue: route),
              ShellScreenRegistry.screens.contains(where: { $0.route == route }) else {
            return false
        }
        performRoute(route)
        return true
    }
}

private final class ShellScreenDocumentView: NSView {
    override var isFlipped: Bool { true }
}

private final class ShellTopBarView: NSView {

    var onAttention: () -> Void = {}

    private let queenStatus = ActionButton(title: "Queen · Unknown")
    private let attentionStatus = ActionButton(title: "Attention 0")
    private let appearanceButton = ActionButton(title: "", symbol: "gearshape")
    private var appearancePopover: NSPopover?

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        setAccessibilityIdentifier("shell-top-bar")

        let brand = ShellBrandView()
        queenStatus.setAccessibilityRole(.staticText)
        queenStatus.setAccessibilityIdentifier("shell-queen-status")

        attentionStatus.style = .warning
        attentionStatus.target = self
        attentionStatus.action = #selector(attentionPressed(_:))
        attentionStatus.setAccessibilityIdentifier("shell-attention-status")
        attentionStatus.toolTip = "Show Attention queue (⌥⌘A)"

        appearanceButton.target = self
        appearanceButton.action = #selector(appearancePressed(_:))
        appearanceButton.setAccessibilityIdentifier("shell-appearance")
        appearanceButton.setAccessibilityLabel("Appearance")
        appearanceButton.toolTip = "Appearance"
        appearanceButton.widthAnchor.constraint(
            equalToConstant: Theme.Metric.actionButtonHeight).isActive = true

        let statusRow = NSStackView(views: [queenStatus, attentionStatus, appearanceButton])
        statusRow.translatesAutoresizingMaskIntoConstraints = false
        statusRow.orientation = .horizontal
        statusRow.alignment = .centerY
        statusRow.spacing = Theme.Space.s

        let divider = NSBox.hdsVerticalDivider()
        addSubview(brand)
        addSubview(divider)
        addSubview(statusRow)
        NSLayoutConstraint.activate([
            brand.leadingAnchor.constraint(equalTo: leadingAnchor),
            brand.topAnchor.constraint(equalTo: topAnchor),
            brand.bottomAnchor.constraint(equalTo: bottomAnchor),
            brand.widthAnchor.constraint(equalToConstant: Theme.Metric.sidebarWidth),
            divider.leadingAnchor.constraint(equalTo: brand.trailingAnchor),
            divider.topAnchor.constraint(equalTo: topAnchor),
            divider.bottomAnchor.constraint(equalTo: bottomAnchor),
            statusRow.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            statusRow.centerYAnchor.constraint(equalTo: centerYAnchor),
            statusRow.leadingAnchor.constraint(
                greaterThanOrEqualTo: divider.trailingAnchor, constant: Theme.Space.m),
        ])

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Workspace status")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func updateLayer() {
        layer?.backgroundColor = Theme.shellChromeFill.cgColor
        layer?.borderWidth = 0
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        Theme.cardStroke.setStroke()
        let border = NSBezierPath()
        border.move(to: NSPoint(x: bounds.minX, y: bounds.minY + 0.5))
        border.line(to: NSPoint(x: bounds.maxX, y: bounds.minY + 0.5))
        border.lineWidth = 1
        border.stroke()
    }

    func apply(queenProvider: ProviderID?, attentionCount: Int) {
        let provider: String
        switch queenProvider {
        case .claude: provider = "Claude"
        case .codex: provider = "Codex"
        case .grok: provider = "Grok"
        case .kimi: provider = "Kimi"
        case .opencode: provider = "OpenCode"
        case .some(let unknown): provider = unknown.rawValue
        case nil: provider = "Unknown"
        }
        queenStatus.title = "Queen · \(provider)"
        queenStatus.setAccessibilityLabel("Queen provider: \(provider)")
        attentionStatus.title = "Attention \(attentionCount)"
        attentionStatus.style = attentionCount > 0 ? .warning : .neutral
        attentionStatus.setAccessibilityLabel("Attention: \(attentionCount) items")
    }

    @objc private func attentionPressed(_ sender: Any?) { onAttention() }

    @objc private func appearancePressed(_ sender: Any?) {
        if let popover = appearancePopover, popover.isShown {
            popover.performClose(nil)
            return
        }
        let host = NSViewController()
        host.view = AppearanceScreenView()
        let popover = NSPopover()
        popover.behavior = .transient
        popover.contentViewController = host
        appearancePopover = popover
        popover.show(
            relativeTo: appearanceButton.bounds,
            of: appearanceButton,
            preferredEdge: .minY)
    }
}

private final class ShellBrandView: NSView {

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let icon = NSImageView(image: NSApp.applicationIconImage)
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.imageScaling = .scaleProportionallyUpOrDown

        let name = NSTextField(labelWithString: "Hive")
        name.font = Theme.Font.chromeBrand
        name.textColor = Theme.primaryText
        let detail = NSTextField(labelWithString: "AGENTIC WORKSPACE")
        detail.font = Theme.Font.chromeSubtitle
        detail.textColor = Theme.secondaryText
        let copy = NSStackView(views: [name, detail])
        copy.translatesAutoresizingMaskIntoConstraints = false
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = 1

        addSubview(icon)
        addSubview(copy)
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 31),
            icon.heightAnchor.constraint(equalToConstant: 31),
            copy.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 9),
            copy.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -8),
            copy.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Hive, agentic workspace")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

private final class ShellFillView: NSView {

    private let color: NSColor

    init(color: NSColor) {
        self.color = color
        super.init(frame: .zero)
        wantsLayer = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func updateLayer() {
        layer?.backgroundColor = color.cgColor
    }
}
