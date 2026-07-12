import AppKit

/// The Settings window: one section today (Models — the Model Control
/// Center), sized and constrained so the design is honest at its minimum.
final class SettingsWindowController: NSWindowController, NSWindowDelegate {

    convenience init(hivePath: String?) {
        let dataSource = ModelControlDataSource(hivePath: hivePath)
        let controller = ModelControlCenterViewController(dataSource: dataSource)
        let window = NSWindow(contentViewController: controller)
        window.title = "Settings — Models"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.setContentSize(NSSize(width: 1040, height: 760))
        // The smallest width at which the single-column layout still works;
        // below this the design would break, so the window refuses to go there.
        window.contentMinSize = NSSize(
            width: Theme.Metric.minContentWidth + 2 * Theme.Space.page, height: 420)
        window.setFrameAutosaveName("HiveModelControlCenter")
        self.init(window: window)
        window.delegate = self
    }

    func show() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
