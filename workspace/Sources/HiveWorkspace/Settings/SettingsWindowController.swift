import AppKit

/// The Settings window: task routing, model consent, and session token usage.
final class SettingsWindowController: NSWindowController, NSToolbarDelegate {

    private static let tasksItem = NSToolbarItem.Identifier("hive.settings.tasks")
    private static let modelsItem = NSToolbarItem.Identifier("hive.settings.models")
    private static let usageItem = NSToolbarItem.Identifier("hive.settings.usage")
    private static let appearanceItem = NSToolbarItem.Identifier("hive.settings.appearance")

    private var tasksController: TasksSettingsController!
    private var modelsController: ModelsSettingsController!
    private var usageController: UsageSettingsController!
    private var appearanceController: AppearanceSettingsController!
    private(set) var dataSource: ModelControlDataSource!
    private let container = NSViewController()

    convenience init(hivePath: String?, daemonPort: Int?, initialWidth: Double? = nil) {
        let dataSource = ModelControlDataSource(hivePath: hivePath, daemonPort: daemonPort)
        let tasks = TasksSettingsController(dataSource: dataSource)
        let models = ModelsSettingsController(dataSource: dataSource)
        let usage = UsageSettingsController(dataSource: dataSource)
        let appearance = AppearanceSettingsController(dataSource: dataSource)

        let width = CGFloat(initialWidth ?? 880)
        let container = NSViewController()
        container.view = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 820))
        // Pin the window's idea of the content size. Without this, AppKit
        // adopts the content's Auto Layout FITTING width at display time and
        // overrides any frame we set (this window once opened wider than the
        // screen that way).
        container.preferredContentSize = NSSize(width: width, height: 820)

        let window = NSWindow(contentViewController: container)
        window.title = "Settings"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        self.init(window: window)

        self.dataSource = dataSource
        forcedWidth = initialWidth.map { CGFloat($0) }

        tasksController = tasks
        modelsController = models
        usageController = usage
        appearanceController = appearance
        for page in [tasks, models, usage, appearance] as [NSViewController] {
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
        // The user's own saved frame wins when one exists; otherwise the
        // window opens at a sensible default CLAMPED TO THE SCREEN — it must
        // never open off it (AppKit's fitting-size pass once opened this
        // window wider than the display). Verification runs (explicit width)
        // skip the autosave entirely so they never fight a saved frame and
        // never overwrite the user's.
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

    /// The selected section, reasserted on every show so window display
    /// quirks can never leave the toolbar and the visible page disagreeing.
    private var currentSection = "tasks"
    /// Verification affordance: reassert this width after display, because
    /// the first display pass re-adopts the content's fitting width.
    private var forcedWidth: CGFloat?

    private func select(page: SettingsPageController) {
        currentSection = page === tasksController ? "tasks"
            : page === modelsController ? "models"
            : page === appearanceController ? "appearance" : "usage"
        tasksController.view.isHidden = page !== tasksController
        modelsController.view.isHidden = page !== modelsController
        usageController.view.isHidden = page !== usageController
        appearanceController.view.isHidden = page !== appearanceController
        window?.title = page === tasksController ? "Settings — Tasks"
            : page === modelsController ? "Settings — Models"
            : page === appearanceController ? "Settings — Appearance" : "Settings — Usage"
    }

    func show() {
        dataSource.refresh()
        select(section: currentSection)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        // After the key-view loop settles: open at the top, not wherever the
        // first focusable control happened to live.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let width = self.forcedWidth, let window = self.window {
                let clamped = max(window.contentMinSize.width, width)
                // The hard cap is the one sizing input the fitting pass
                // cannot exceed.
                window.contentMaxSize = NSSize(
                    width: clamped, height: .greatestFiniteMagnitude)
                window.setContentSize(NSSize(width: clamped, height: 820))
            }
            self.tasksController.scrollToTop()
            self.modelsController.scrollToTop()
            self.usageController.scrollToTop()
            self.appearanceController.scrollToTop()
        }
    }

    // MARK: NSToolbarDelegate

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [Self.tasksItem, Self.modelsItem, Self.usageItem, Self.appearanceItem]
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
        case Self.usageItem:
            item.label = "Usage"
            item.image = NSImage(
                systemSymbolName: "chart.bar.xaxis",
                accessibilityDescription: "Session token usage")
            item.action = #selector(showUsage(_:))
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
    @objc private func showUsage(_ sender: Any?) { select(page: usageController) }
    @objc private func showAppearance(_ sender: Any?) { select(page: appearanceController) }

    /// Programmatic section selection ("tasks" / "models" / "usage") — used by the
    /// launch affordance and the smoke harness.
    func select(section: String) {
        let page: SettingsPageController = section == "models" ? modelsController
            : section == "usage" ? usageController
            : section == "appearance" ? appearanceController : tasksController
        window?.toolbar?.selectedItemIdentifier = section == "models" ? Self.modelsItem
            : section == "usage" ? Self.usageItem
            : section == "appearance" ? Self.appearanceItem : Self.tasksItem
        select(page: page)
    }
}
