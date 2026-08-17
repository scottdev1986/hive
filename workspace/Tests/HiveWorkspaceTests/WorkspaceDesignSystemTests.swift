import AppKit
import XCTest

@testable import HiveWorkspace
import WorkspaceCore

final class WorkspaceDesignSystemTests: XCTestCase {

    func testFoundationPrimitivesExposeOneComposableScreenContract() throws {
        let action = NSButton(title: "Refresh", target: nil, action: nil)
        let header = PageHeaderView(
            title: "Models & Quota",
            subtitle: "Measured capacity evidence.",
            actions: [action])
        let card = SectionCardView(title: "Claude")
        let row = DataTableRowView(columns: [
            NSTextField(labelWithString: "Model"),
            NSTextField(labelWithString: "claude-opus"),
        ])
        let meter = MeterBarView()
        meter.state = .fill(fraction: 0.5, color: Theme.accent)
        card.contentStack.addArrangedSubview(row)
        card.contentStack.addArrangedSubview(meter)

        XCTAssertEqual(header.accessibilityIdentifier(), "hds-page-header")
        XCTAssertEqual(card.accessibilityIdentifier(), "hds-section-card")
        XCTAssertEqual(row.accessibilityIdentifier(), "hds-data-row")
        XCTAssertEqual(meter.accessibilityIdentifier(), "hds-meter-bar")
    }

    func testShellChromeUsesCompactSidebarAndNamedTopBarControls() throws {
        _ = NSApplication.shared
        let controller = WorkspaceShellWindowController(
            context: ShellSidebarView.Context(
                projectName: "hive",
                projectPath: "/Users/test/Projects/hive",
                instanceLabel: "instance · fixture"),
            state: ShellState())
        let window = try XCTUnwrap(controller.window)
        window.setContentSize(NSSize(width: 1_100, height: 720))
        window.contentView?.layoutSubtreeIfNeeded()
        let content = try XCTUnwrap(window.contentView)

        let topBar = try XCTUnwrap(findView(in: content, identifier: "shell-top-bar"))
        let sidebar = try XCTUnwrap(findView(in: content, identifier: "shell-sidebar"))
        XCTAssertEqual(topBar.frame.height, Theme.Metric.topBarHeight, accuracy: 1)
        XCTAssertEqual(sidebar.frame.width, Theme.Metric.sidebarWidth, accuracy: 1)
        for identifier in [
            "shell-sandbox-status",
            "shell-queen-status",
            "shell-attention-status",
            "shell-settings",
        ] {
            XCTAssertNotNil(findView(in: topBar, identifier: identifier), identifier)
        }
        let attention = try XCTUnwrap(findView(
            in: topBar, identifier: "shell-attention-status") as? NSButton)
        XCTAssertFalse(controller.currentState.attentionDrawerVisible)
        attention.performClick(nil)
        XCTAssertTrue(controller.currentState.attentionDrawerVisible)
    }

    private func findView(in view: NSView, identifier: String) -> NSView? {
        if view.accessibilityIdentifier() == identifier { return view }
        for child in view.subviews {
            if let found = findView(in: child, identifier: identifier) { return found }
        }
        return nil
    }
}
