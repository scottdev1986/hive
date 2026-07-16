import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore

@MainActor
final class AppDelegateLifecycleTests: XCTestCase {

    func testTerminalEnvironmentPreservesPrivateTempDirectoryForCodexSocket() {
        XCTAssertEqual(
            terminalProcessEnvironment(
                base: ["TERM=xterm-256color"],
                inherited: [
                    "PATH": "/usr/local/tools/bin:/usr/bin",
                    "TMPDIR": "/var/folders/user/T/",
                ]),
            [
                "TERM=xterm-256color",
                "PATH=/usr/local/tools/bin:/usr/bin",
                "TMPDIR=/var/folders/user/T/",
            ])
    }

    func testTrackedMenuIsCancelledWhenTheInstanceCloses() {
        _ = NSApplication.shared
        let owner = AppDelegate(config: LaunchConfig())
        let menu = RecordingMenu(title: "Tracked")
        NotificationCenter.default.post(
            name: NSMenu.didBeginTrackingNotification, object: menu)

        owner.closeOwnedSurfaces()

        XCTAssertEqual(menu.cancellationCount, 1)
    }

    func testExhaustedFeedRetriesCloseSurfacesBeforeTermination() {
        _ = NSApplication.shared
        let owner = AppDelegate(config: LaunchConfig())
        let menu = RecordingMenu(title: "Tracked")
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 120, height: 80),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.orderFront(nil)
        NotificationCenter.default.post(
            name: NSMenu.didBeginTrackingNotification, object: menu)
        var didTerminate = false

        owner.terminateAfterFeedFailure {
            XCTAssertEqual(menu.cancellationCount, 1)
            XCTAssertFalse(window.isVisible)
            didTerminate = true
        }

        XCTAssertTrue(didTerminate)
    }

    func testProjectCloseEndsEverySheetBeforeClosingOtherWindows() {
        let project = NSObject()
        let settings = NSObject()
        var ended: [ObjectIdentifier] = []
        var closed: [ObjectIdentifier] = []

        AppDelegate.tearDownWindows(
            [project, settings], keeping: project,
            endSheets: { ended.append(ObjectIdentifier($0)) },
            close: { closed.append(ObjectIdentifier($0)) })

        XCTAssertEqual(
            Set(ended), Set([ObjectIdentifier(project), ObjectIdentifier(settings)]))
        XCTAssertEqual(closed, [ObjectIdentifier(settings)])
    }

    func testOnlyAnOwnedAppModalSessionIsAborted() {
        let owned = NSObject()
        let sibling = NSObject()
        var abortCount = 0

        AppDelegate.abortModalIfOwned(owned, ownedWindows: [owned]) {
            abortCount += 1
        }
        AppDelegate.abortModalIfOwned(sibling, ownedWindows: [owned]) {
            abortCount += 1
        }

        XCTAssertEqual(abortCount, 1)
    }

    func testAgentClosureDismissesItsKillFailureSheet() throws {
        _ = NSApplication.shared
        let state = ProjectState(
            projectID: "project", displayName: "Project",
            workspaceIdentity: WorkspaceInstanceIdentity(
                instanceID: "instance", instanceHome: "/tmp",
                daemonPort: 1, tmuxSocket: "hive-test"))
        let controller = ProjectWindowController(
            state: state, attentionCenter: AttentionCenter(),
            projectDirectory: "/tmp", hivePath: "/usr/bin/false",
            orchestrator: "claude", orchestratorSession: nil)
        controller.window?.isReleasedWhenClosed = false
        defer { controller.close() }

        controller.reportKillFailure(agent: "worker", reason: "daemon unavailable")
        XCTAssertEqual(controller.window?.sheets.count, 1)

        controller.applyFeed([
            AgentSnapshot(
                id: "agent-worker", name: "worker", status: "done",
                closedAt: "2026-07-13T23:00:00.000Z"),
        ])

        XCTAssertEqual(controller.window?.sheets.count, 0)
    }

    func testStatusAndFocusOverlaysAreAboveTheOpaquePaneBackground() throws {
        let pane = PaneView(paneID: "worker", title: "worker") { _ in }
        let backgroundIndex = try XCTUnwrap(
            pane.subviews.firstIndex(where: { $0 is NSVisualEffectView }))
        let statusIndex = try XCTUnwrap(
            pane.subviews.firstIndex(where: { $0 is PaneStatusBorderView }))
        let focusIndex = try XCTUnwrap(
            pane.subviews.firstIndex(where: { $0 is PaneFocusRingView }))

        XCTAssertGreaterThan(statusIndex, backgroundIndex)
        XCTAssertGreaterThan(focusIndex, backgroundIndex)
        XCTAssertNil(pane.subviews[statusIndex].hitTest(.zero))
        XCTAssertNil(pane.subviews[focusIndex].hitTest(.zero))
    }

    func testExactAttachmentChangeReplacesPaneChildAndDriftKeepsAuthoringOpen() throws {
        _ = NSApplication.shared
        let state = ProjectState(
            projectID: "project", displayName: "Project",
            workspaceIdentity: WorkspaceInstanceIdentity(
                instanceID: "instance", instanceHome: "/tmp/hive",
                daemonPort: 4317, tmuxSocket: "hive-test"))
        let controller = ProjectWindowController(
            state: state, attentionCenter: AttentionCenter(),
            projectDirectory: "/tmp", hivePath: "/usr/bin/true",
            orchestrator: "codex", orchestratorSession: nil)
        defer { controller.close() }
        let paneID = ProjectState.paneID(forAgent: "worker")
        func agent(id: String, session: String, identityState: String) -> AgentSnapshot {
            AgentSnapshot(
                id: id, name: "worker", tool: "codex", model: "gpt-launch",
                executionIdentity: LaunchIdentitySnapshot(
                    model: "gpt-launch", effort: "high"),
                observedIdentity: ObservedIdentitySnapshot(
                    model: identityState == "drift" ? "gpt-other" : "gpt-launch",
                    effort: "high"),
                identityState: identityState, status: "working",
                tmuxSession: session, toolSessionID: "tool-\(id)",
                processIncarnation: 1, writeRevoked: false)
        }

        controller.applyFeed([agent(
            id: "uuid-old", session: "tmux-old", identityState: "matching")])
        let firstView = try XCTUnwrap(controller.paneViewObjectID(paneID))
        XCTAssertEqual(controller.paneAttachmentIdentity(paneID)?.agentID, "uuid-old")
        XCTAssertEqual(controller.paneAllowsAuthoring(paneID), true)

        controller.applyFeed([agent(
            id: "uuid-new", session: "tmux-new", identityState: "drift")])

        XCTAssertNotEqual(controller.paneViewObjectID(paneID), firstView)
        XCTAssertEqual(controller.paneAttachmentIdentity(paneID)?.agentID, "uuid-new")
        // Identity drift is header information, never a keyboard lock: the
        // human must always be able to type into a live pane.
        XCTAssertEqual(controller.paneAllowsAuthoring(paneID), true)
    }

    func testPaneTitleTruncatesWithoutDrivingWindowWidth() throws {
        let pane = PaneView(paneID: "worker", title: "initial-title") { _ in }
        let title = try XCTUnwrap(textFields(in: pane).first {
            $0.stringValue == "initial-title"
        })

        XCTAssertLessThan(
            title.contentCompressionResistancePriority(for: .horizontal).rawValue, 500)
        XCTAssertEqual(title.toolTip, "initial-title")

        pane.update(state: PaneState(
            id: "worker", kind: .agent, title: "updated-title",
            feedStatus: "working", status: .running))
        XCTAssertEqual(title.toolTip, "updated-title")
        XCTAssertTrue(textFields(in: pane).contains {
            $0.stringValue.contains("working") && $0.toolTip == $0.stringValue
        })
    }

    func testCellGeometryCommitPropagatesSnappedPaneFrameToTerminal() {
        let pane = PaneView(paneID: "worker", title: "worker") { _ in }
        pane.frame = NSRect(x: 0, y: 0, width: 900, height: 600)

        pane.commitCellGeometry()

        XCTAssertGreaterThan(pane.contentView.bounds.width, 40)
        XCTAssertGreaterThan(pane.contentView.bounds.height, 40)
    }

    private func textFields(in view: NSView) -> [NSTextField] {
        ((view as? NSTextField).map { [$0] } ?? [])
            + view.subviews.flatMap(textFields)
    }

    private final class RecordingMenu: NSMenu {
        var cancellationCount = 0

        override func cancelTrackingWithoutAnimation() {
            cancellationCount += 1
        }
    }
}
