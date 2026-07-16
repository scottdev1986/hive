import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore

@MainActor
final class ProjectSwitcherTests: XCTestCase {

    private func state(_ path: String) -> ProjectState {
        ProjectState(
            projectID: ProjectID(path), displayName: (path as NSString).lastPathComponent,
            workspaceIdentity: WorkspaceInstanceIdentity(
                instanceID: "instance", instanceHome: "/tmp/hive",
                daemonPort: 4317, tmuxSocket: "hive-test"))
    }

    private func agent(status: String) -> AgentSnapshot {
        AgentSnapshot(
            id: "agent-worker", name: "worker", model: "opus", liveModel: "opus",
            observedIdentity: ObservedIdentitySnapshot(model: "opus"),
            identityState: "matching", status: status, tmuxSession: "hive-worker",
            toolSessionID: "session-worker", processIncarnation: 1)
    }

    func testVisibleProjectCardRefreshesWithState() throws {
        _ = NSApplication.shared
        let state = state("/tmp/refresh-project")
        _ = state.addOrchestrator()
        let switcher = ProjectSwitcherController()
        switcher.register(state: state) {}
        switcher.showPanel()
        defer { NSApp.windows.filter { $0.title == "Projects" }.forEach { $0.close() } }

        XCTAssertTrue(labelValues().contains("1 panes · 1 running"))

        _ = state.apply(feed: [agent(status: "working")])
        switcher.refresh()

        let refreshedLabels = labelValues()
        XCTAssertTrue(
            refreshedLabels.contains("2 panes · 2 running"),
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
        let state = state("/tmp/state-change")
        _ = state.apply(feed: [agent(status: "working")])
        let controller = ProjectWindowController(
            state: state, attentionCenter: AttentionCenter(),
            projectDirectory: "/tmp", hivePath: "/usr/bin/true",
            orchestrator: "codex", orchestratorSession: nil)
        defer { controller.window?.close() }
        var notifications = 0
        controller.onStateChange = { notifications += 1 }

        controller.applyFeed([agent(status: "failed")])

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
