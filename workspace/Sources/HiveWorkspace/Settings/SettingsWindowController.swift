import AppKit

final class SettingsWindowController: NSWindowController, NSToolbarDelegate {

    private static let tasksItem = NSToolbarItem.Identifier("hive.settings.tasks")
    private static let modelsItem = NSToolbarItem.Identifier("hive.settings.models")
    private static let appearanceItem = NSToolbarItem.Identifier("hive.settings.appearance")

    private var tasksController: TasksSettingsController!
    private var modelsController: ModelsSettingsController!
    private var appearanceController: AppearanceSettingsController!
    private(set) var dataSource: ModelControlDataSource!

    convenience init(
        hivePath: String?, daemonPort: Int?, instanceHome: String? = nil,
        initialWidth: Double? = nil,
        makeDaemonClient: (() async throws -> WorkspaceDaemonClient)? = nil
    ) {
        let dataSource = ModelControlDataSource(
            hivePath: hivePath, daemonPort: daemonPort, instanceHome: instanceHome,
            makeDaemonClient: makeDaemonClient)
        let tasks = TasksSettingsController(dataSource: dataSource)
        let models = ModelsSettingsController(dataSource: dataSource)
        let appearance = AppearanceSettingsController(dataSource: dataSource)

        let width = CGFloat(initialWidth ?? 880)
        let container = NSViewController()
        container.view = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 820))
        // Pin the window's idea of the content size. Without this, AppKit adopts the content's Auto Layout FITTING width at display time and overrides any frame we set and can open the window wider than the screen.
        container.preferredContentSize = NSSize(width: width, height: 820)

        let window = NSWindow(contentViewController: container)
        window.title = "Settings"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        self.init(window: window)

        self.dataSource = dataSource
        forcedWidth = initialWidth.map { CGFloat($0) }

        tasksController = tasks
        modelsController = models
        appearanceController = appearance
        for page in [tasks, models, appearance] as [NSViewController] {
            container.addChild(page)
            page.view.translatesAutoresizingMaskIntoConstraints = false
            container.view.addSubview(page.view)
            NSLayoutConstraint.activate([
                page.view.leadingAnchor.constraint(equalTo: container.view.leadingAnchor),
                page.view.trailingAnchor.constraint(equalTo: container.view.trailingAnchor),
                page.view.topAnchor.constraint(equalTo: container.view.topAnchor),
                page.view.bottomAnchor.constraint(equalTo: container.view.bottomAnchor),
            ])
        }

        let toolbar = NSToolbar(identifier: "hive.settings.toolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconAndLabel
        toolbar.allowsUserCustomization = false
        window.toolbar = toolbar
        window.toolbarStyle = .preference
        toolbar.selectedItemIdentifier = Self.tasksItem
        select(page: tasksController)

        window.contentMinSize = NSSize(
            width: Theme.Metric.minContentWidth + 2 * Theme.Space.page, height: 420)
        // The user's own saved frame wins when one exists; otherwise the window opens at a sensible default CLAMPED TO THE SCREEN — it must never open off it; AppKit's fitting-size pass can open this window wider than the display. Verification runs (explicit width) skip the autosave entirely so they never fight a saved frame and never overwrite the user's.
        let restored: Bool
        if initialWidth == nil {
            window.setFrameAutosaveName("HiveModelControlCenter")
            restored = window.setFrameUsingName("HiveModelControlCenter")
        } else {
            restored = false
        }
        if !restored {
            let visible = NSScreen.main?.visibleFrame
                ?? NSRect(x: 0, y: 0, width: 1280, height: 900)
            let size = NSSize(
                width: min(width, visible.width - 40),
                height: min(820, visible.height - 40))
            let origin = NSPoint(
                x: visible.midX - size.width / 2,
                y: visible.midY - size.height / 2)
            window.setFrame(NSRect(origin: origin, size: size), display: false)
        }

        dataSource.refresh()
    }

    /// The selected section, reasserted on every show so window display quirks can never leave the toolbar and the visible page disagreeing.
    private var currentSection = "tasks"
    private var forcedWidth: CGFloat?

    private func select(page: SettingsPageController) {
        currentSection = page === tasksController ? "tasks"
            : page === modelsController ? "models"
            : "appearance"
        tasksController.view.isHidden = page !== tasksController
        modelsController.view.isHidden = page !== modelsController
        appearanceController.view.isHidden = page !== appearanceController
        window?.title = page === tasksController ? "Settings — Tasks"
            : page === modelsController ? "Settings — Models"
            : "Settings — Appearance"
    }

    func show() {
        dataSource.refresh()
        select(section: currentSection)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        // After the key-view loop settles: open at the top, not wherever the first focusable control happened to live.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let width = self.forcedWidth, let window = self.window {
                let clamped = max(window.contentMinSize.width, width)
                // The hard cap is the one sizing input the fitting pass cannot exceed.
                window.contentMaxSize = NSSize(
                    width: clamped, height: .greatestFiniteMagnitude)
                window.setContentSize(NSSize(width: clamped, height: 820))
            }
            self.tasksController.scrollToTop()
            self.modelsController.scrollToTop()
            self.appearanceController.scrollToTop()
        }
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [Self.tasksItem, Self.modelsItem, Self.appearanceItem]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbarSelectableItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier identifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar: Bool
    ) -> NSToolbarItem? {
        let item = NSToolbarItem(itemIdentifier: identifier)
        switch identifier {
        case Self.tasksItem:
            item.label = "Tasks"
            item.image = NSImage(
                systemSymbolName: "list.number",
                accessibilityDescription: "Task routing")
            item.action = #selector(showTasks(_:))
        case Self.modelsItem:
            item.label = "Models"
            item.image = NSImage(
                systemSymbolName: "cpu",
                accessibilityDescription: "Models and providers")
            item.action = #selector(showModels(_:))
        case Self.appearanceItem:
            item.label = "Appearance"
            item.image = NSImage(
                systemSymbolName: "paintpalette",
                accessibilityDescription: "Terminal theme and font")
            item.action = #selector(showAppearance(_:))
        default:
            return nil
        }
        item.target = self
        return item
    }

    @objc private func showTasks(_ sender: Any?) { select(page: tasksController) }
    @objc private func showModels(_ sender: Any?) { select(page: modelsController) }
    @objc private func showAppearance(_ sender: Any?) { select(page: appearanceController) }

    static let knownSections = ["tasks", "models", "appearance"]

    func select(section: String) {
        if !Self.knownSections.contains(section) {
            NSLog("hive settings: unknown section %@, falling back to tasks", section)
        }
        let page: SettingsPageController = section == "models" ? modelsController
            : section == "appearance" ? appearanceController : tasksController
        window?.toolbar?.selectedItemIdentifier = section == "models" ? Self.modelsItem
            : section == "appearance" ? Self.appearanceItem : Self.tasksItem
        select(page: page)
    }
}
