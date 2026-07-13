import AppKit

/// The Settings window: two sections in a System-Settings-style toolbar.
/// TASKS (the routing table — what the user opens on) and MODELS (the
/// inventory, meters, and consent toggles). Two lenses on one policy.
final class SettingsWindowController: NSWindowController, NSToolbarDelegate {

    private static let tasksItem = NSToolbarItem.Identifier("hive.settings.tasks")
    private static let modelsItem = NSToolbarItem.Identifier("hive.settings.models")

    private var tasksController: TasksSettingsController!
    private var modelsController: ModelsSettingsController!
    private let container = NSViewController()

    convenience init(hivePath: String?) {
        let dataSource = ModelControlDataSource(hivePath: hivePath)
        let tasks = TasksSettingsController(dataSource: dataSource)
        let models = ModelsSettingsController(dataSource: dataSource)

        let container = NSViewController()
        container.view = NSView(frame: NSRect(x: 0, y: 0, width: 760, height: 720))

        let window = NSWindow(contentViewController: container)
        window.title = "Settings"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        self.init(window: window)

        tasksController = tasks
        modelsController = models
        for page in [tasks, models] as [NSViewController] {
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

        // The window must open ON the screen: a sensible default, clamped to
        // the visible frame, and an honest minimum below which the design
        // does not work. (AppKit's fitting-size pass is what once opened this
        // window wider than the display.)
        let visible = NSScreen.main?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1280, height: 900)
        let size = NSSize(
            width: min(880, visible.width - 40),
            height: min(820, visible.height - 40))
        let origin = NSPoint(
            x: visible.midX - size.width / 2,
            y: visible.midY - size.height / 2)
        window.setFrame(NSRect(origin: origin, size: size), display: false)
        window.contentMinSize = NSSize(
            width: Theme.Metric.minContentWidth + 2 * Theme.Space.page, height: 420)
        window.setFrameAutosaveName("HiveModelControlCenter")

        dataSource.refresh()
    }

    private func select(page: SettingsPageController) {
        tasksController.view.isHidden = page !== tasksController
        modelsController.view.isHidden = page !== modelsController
        window?.title = page === tasksController ? "Settings — Tasks" : "Settings — Models"
    }

    func show() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        // After the key-view loop settles: open at the top, not wherever the
        // first focusable control happened to live.
        DispatchQueue.main.async { [weak self] in
            self?.tasksController.scrollToTop()
            self?.modelsController.scrollToTop()
        }
    }

    // MARK: NSToolbarDelegate

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [Self.tasksItem, Self.modelsItem]
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
        default:
            return nil
        }
        item.target = self
        return item
    }

    @objc private func showTasks(_ sender: Any?) { select(page: tasksController) }
    @objc private func showModels(_ sender: Any?) { select(page: modelsController) }

    /// Programmatic section selection ("tasks" / "models") — used by the
    /// launch affordance and the smoke harness.
    func select(section: String) {
        let page: SettingsPageController =
            section == "models" ? modelsController : tasksController
        window?.toolbar?.selectedItemIdentifier =
            section == "models" ? Self.modelsItem : Self.tasksItem
        select(page: page)
    }
}
