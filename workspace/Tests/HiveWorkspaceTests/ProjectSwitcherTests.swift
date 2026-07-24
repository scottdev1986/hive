import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore

@MainActor
final class ProjectSwitcherTests: XCTestCase {

    func testVisibleProjectCardRefreshesWithState() throws {
        _ = NSApplication.shared
        let state = ProjectState(
            projectID: ProjectID("/tmp/refresh-project"),
            displayName: "refresh-project")
        _ = state.addOrchestrator()
        let switcher = ProjectSwitcherController()
        switcher.register(state: state) {}
        switcher.showPanel()
        defer { NSApp.windows.filter { $0.title == "Projects" }.forEach { $0.close() } }

        XCTAssertTrue(labelValues().contains("1 panes · 1 running"))

        _ = state.apply(feed: [AgentSnapshot(name: "worker", status: "working")])
        switcher.refresh()

        let refreshedLabels = labelValues()
        XCTAssertTrue(
            refreshedLabels.contains("2 panes · 1 running"),
            "rendered labels: \(refreshedLabels)")
        let labels = NSApp.windows
            .filter { $0.title == "Projects" }
            .flatMap { textFields(in: $0.contentView) }
        for label in labels {
            XCTAssertLessThan(
                label.contentCompressionResistancePriority(for: .horizontal).rawValue, 500)
            XCTAssertEqual(label.toolTip, label.stringValue)
        }
    }

    func testProjectControllerPublishesStateChanges() {
        let state = ProjectState(
            projectID: ProjectID("/tmp/state-change"), displayName: "state-change")
        _ = state.apply(feed: [AgentSnapshot(name: "worker", status: "working")])
        let controller = ProjectWindowController(
            state: state, attentionCenter: AttentionCenter(),
            projectDirectory: "/tmp", hivePath: "/usr/bin/true", daemonPort: 1,
            orchestrator: "codex",
            instanceID: "test", instanceHome: "/tmp")
        defer { controller.window?.close() }
        var notifications = 0
        controller.onStateChange = { notifications += 1 }

        controller.applyFeed([AgentSnapshot(name: "worker", status: "failed")])

        XCTAssertEqual(notifications, 1)
    }

    private func labelValues() -> [String] {
        NSApp.windows
            .filter { $0.title == "Projects" }
            .flatMap { textFields(in: $0.contentView) }
            .map(\.stringValue)
    }

    private func textFields(in view: NSView?) -> [NSTextField] {
        guard let view else { return [] }
        return (view as? NSTextField).map { [$0] } ?? view.subviews.flatMap(textFields)
    }
}
