
import AppKit
import WorkspaceCore

final class WorkspaceShellWindowController: NSWindowController, NSToolbarDelegate {

    private static let attentionItemID = NSToolbarItem.Identifier("shell.attention")

    private var state: ShellState
    private let dispatcher: ShellDispatcher
    private let sidebar: ShellSidebarView
    private let bannerStack = NSStackView()
    private var emptyBannerHeightConstraint: NSLayoutConstraint?
    private let mainRow = NSStackView()
    private let screenScrollView = NSScrollView()
    private let screenHost = ShellScreenDocumentView()
    private var liveRunHeightCeiling: NSLayoutConstraint?
    private var outerHorizonViewportConstraint: NSLayoutConstraint?
    private var drawer: ShellAttentionDrawerView?
    private var drawerSeparator: NSBox?
    private var inspector: ShellInspectorView?
    private var inspectorSeparator: NSBox?
    private var attentionToolbarItem: NSToolbarItem?
    /// Kept across shell renders so unrelated state refreshes can reuse the selected exact-generation viewer.
    private var liveRunWorkbench: LiveRunWorkbenchView?
    var probeRefreshHandler: (() -> Void)?
    private var providerProbeRefreshState: ShellProviderProbeRefreshState = .idle
    /// The daemon write seam. A launch without a daemon connection leaves this nil and the Model Control controls stay disabled rather than pretending.
    var policyWriteHandler: ((ShellPolicyWrite) -> Void)?
    var queenProviderSwapHandler: (() -> Void)?
    var memoryRecallHandler: ((String) -> Void)?
    var memoryLibraryPageHandler: ((MemoryLibraryStep, MemoryLibraryFilter) -> Void)?
    var memoryJobHandler: ((MemoryJobKind) -> Void)?
    private var memoryActionBanner: ShellBanner?
    private var routerCategory: TaskCategory?
    private var renderedRoute: ShellRoute?

    init(context: ShellSidebarView.Context, state: ShellState) {
        self.state = state
        routerCategory = state.modelControlView?.routing.categories.first
        dispatcher = ShellDispatcher(transport: shellUnavailableTransport)
        sidebar = ShellSidebarView(context: context, onSelect: { _ in })
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        window.minSize = NSSize(width: 940, height: 560)
        window.title = "Hive Workspace — \(context.projectName)"
        window.center()
        super.init(window: window)
        sidebar.onSelect = { [weak self] route in
            self?.performRoute(route)
        }
        layoutContent()
        installToolbar()
        render()
        window.initialFirstResponder = sidebar.navButtonsInOrder.first
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    var navButtonCount: Int { sidebar.navButtonsInOrder.count }

    var currentState: ShellState { state }

    func apply(_ mutation: (inout ShellState) -> Void) {
        mutation(&state)
        let categories = state.modelControlView?.routing.categories ?? []
        if routerCategory.map({ categories.contains($0) }) != true {
            routerCategory = categories.first
        }
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
        render()
    }

    func detachLiveRunViewer() {
        liveRunWorkbench?.setRouteVisible(false)
    }

    private func layoutContent() {
        guard let contentView = window?.contentView else { return }

        bannerStack.orientation = .vertical
        bannerStack.spacing = Theme.Space.s
        bannerStack.translatesAutoresizingMaskIntoConstraints = false
        bannerStack.edgeInsets = NSEdgeInsets(
            top: Theme.Space.m, left: Theme.Space.l,
            bottom: 0, right: Theme.Space.l)
        bannerStack.setAccessibilityIdentifier("shell-banners")

        mainRow.orientation = .horizontal
        mainRow.distribution = .fill
        mainRow.spacing = 0
        mainRow.alignment = .top
        mainRow.translatesAutoresizingMaskIntoConstraints = false

        sidebar.widthAnchor.constraint(equalToConstant: 224).isActive = true

        let separator = NSBox.hdsSeparator()
        // This is a vertical edge, so its 1-point intrinsic height must not compete with the window height it is meant to follow.
        separator.setContentHuggingPriority(.defaultLow, for: .vertical)
        separator.widthAnchor.constraint(equalToConstant: 1).isActive = true

        screenScrollView.translatesAutoresizingMaskIntoConstraints = false
        screenScrollView.hasVerticalScroller = true
        screenScrollView.drawsBackground = false
        screenScrollView.documentView = screenHost
        screenScrollView.setAccessibilityIdentifier("shell-screen-scroll")
        screenHost.translatesAutoresizingMaskIntoConstraints = false
        screenHost.setAccessibilityIdentifier("shell-screen-host")

        mainRow.addArrangedSubview(sidebar)
        mainRow.addArrangedSubview(separator)
        mainRow.addArrangedSubview(screenScrollView)

        let root = NSView()
        root.translatesAutoresizingMaskIntoConstraints = false
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
            bannerStack.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            bannerStack.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            bannerStack.topAnchor.constraint(equalTo: root.topAnchor),
            mainRow.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            mainRow.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            mainRow.topAnchor.constraint(equalTo: bannerStack.bottomAnchor),
            mainRow.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            screenHost.widthAnchor.constraint(
                equalTo: screenScrollView.contentView.widthAnchor),
            screenHost.heightAnchor.constraint(
                greaterThanOrEqualTo: screenScrollView.contentView.heightAnchor),
        ])
        liveRunHeightCeiling = screenHost.heightAnchor
            .constraint(lessThanOrEqualTo: screenScrollView.contentView.heightAnchor)
        separator.heightAnchor.constraint(equalTo: mainRow.heightAnchor).isActive = true
    }

    private func installToolbar() {
        guard let window else { return }
        let toolbar = NSToolbar(identifier: "shell.toolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        window.toolbar = toolbar
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [Self.attentionItemID]
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [Self.attentionItemID]
    }

    func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool
    ) -> NSToolbarItem? {
        guard itemIdentifier == Self.attentionItemID else { return nil }
        let item = NSToolbarItem(itemIdentifier: itemIdentifier)
        item.image = NSImage(
            systemSymbolName: "exclamationmark.circle",
            accessibilityDescription: "Attention")
        item.target = self
        item.action = #selector(toggleAttentionDrawer(_:))
        item.toolTip = "Toggle the Attention drawer (⌥⌘A)"
        attentionToolbarItem = item
        return item
    }

    /// The one dispatch entry every menu item points at. The command travels in the item's identifier — a menu row cannot fire an unnamed action.
    @objc func performShellCommand(_ sender: NSMenuItem) {
        guard let raw = sender.identifier?.rawValue,
              let command = ShellCommand(rawValue: raw) else { return }
        perform(command)
    }

    @objc private func toggleAttentionDrawer(_ sender: Any?) {
        perform(.toggleAttention)
    }

    private func performRoute(_ route: ShellRoute) {
        dispatcher.navigate(to: route, state: &state)
        render()
    }

    private func perform(_ command: ShellCommand) {
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
        let count = state.attentionQueue.count
        attentionToolbarItem?.label =
            count > 0 ? "Attention (\(count))" : "Attention"
    }

    private func renderBanners() {
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
            let view = ShellBannerView(banner: banner)
            bannerStack.addArrangedSubview(view)
            view.widthAnchor.constraint(
                equalTo: bannerStack.widthAnchor, constant: -Theme.Space.l * 2
            ).isActive = true
        }
        emptyBannerHeightConstraint?.isActive = banners.isEmpty
        bannerStack.edgeInsets = banners.isEmpty
            ? NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
            : NSEdgeInsets(
                top: Theme.Space.m, left: Theme.Space.l,
                bottom: 0, right: Theme.Space.l)
        bannerStack.isHidden = banners.isEmpty
    }

    private func renderScreen() {
        let routeChanged = renderedRoute != state.activeRoute
        let liveRunVisible = state.activeRoute == .liveRun && liveRunWorkbench != nil
        liveRunHeightCeiling?.isActive = liveRunVisible
        liveRunWorkbench?.setRouteVisible(liveRunVisible)
        outerHorizonViewportConstraint?.isActive = false
        outerHorizonViewportConstraint = nil
        for subview in screenHost.subviews {
            subview.removeFromSuperview()
        }
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
        case (.taskRouter, let editor?)
            where routerCategory != nil && state.modelControlView != nil:
            let category = routerCategory!
            let routing = state.modelControlView!.routing
            panel = TaskRouterScreenView(
                screen: screen,
                editor: editor,
                categories: routing.categories,
                category: category,
                routing: routing,
                onSelectCategory: { [weak self] category in
                    self?.routerCategory = category
                    self?.render()
                },
                onEditRoute: { [weak self] route in
                    guard let self else { return }
                    apply { $0.editRouter { $0.setRoute(route, for: category) } }
                },
                onApply: { [weak self] in
                    guard let self else { return }
                    policyWriteHandler?(.route(category))
                })
        case (.memoryOverview, _):
            panel = MemoryOverviewScreenView(
                screen: screen, overview: state.memory.overview)
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
                onInspect: { [weak self] query in self?.memoryRecallHandler?(query) })
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
        let separator = NSBox.hdsSeparator()
        separator.widthAnchor.constraint(equalToConstant: 1).isActive = true
        mainRow.addArrangedSubview(separator)
        mainRow.addArrangedSubview(panel)
        separator.heightAnchor.constraint(equalTo: mainRow.heightAnchor).isActive = true
        inspector = panel
        inspectorSeparator = separator
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
        let separator = NSBox.hdsSeparator()
        separator.widthAnchor.constraint(equalToConstant: 1).isActive = true
        mainRow.addArrangedSubview(separator)
        mainRow.addArrangedSubview(drawer)
        separator.heightAnchor.constraint(equalTo: mainRow.heightAnchor).isActive = true
        self.drawer = drawer
        drawerSeparator = separator
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

private final class ShellScreenDocumentView: NSView {
    override var isFlipped: Bool { true }
}
