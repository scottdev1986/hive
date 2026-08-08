import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore
@testable import WorkspaceQAKit

@MainActor
final class AppDelegateLifecycleTests: XCTestCase {

    func testWorkspaceQuitForcesTheAlreadyWorkPreservingFleetStop() {
        XCTAssertEqual(AppDelegate.terminationStopArguments, ["stop", "--force"])
    }

    func testLiveResizeSmokeTargetsTheAgentCreatedByEachHarnessMode() {
        XCTAssertEqual(
            SmokeRunner.sessiondLiveResizeInputAgent(
                environment: ["HIVE_B22_REAL_SHELL": "1"]),
            "terminal")
        XCTAssertEqual(
            SmokeRunner.sessiondLiveResizeInputAgent(environment: [:]),
            "aria")
        XCTAssertEqual(
            SmokeRunner.sessiondLiveResizeInputAgent(
                environment: ["HIVE_B22_REAL_SHELL": "0"]),
            "aria")
    }

    func testProductionPaneSmokeRequiresAnExplicitAgent() {
        XCTAssertNil(SmokeRunner.productionPaneAgent(environment: [:]))
        XCTAssertNil(SmokeRunner.productionPaneAgent(
            environment: ["HIVE_B25_PRODUCTION_PANE_AGENT": ""]))
        XCTAssertEqual(
            SmokeRunner.productionPaneAgent(
                environment: ["HIVE_B25_PRODUCTION_PANE_AGENT": "aria"]),
            "aria")
    }

    func testA4ProofRequiresAnExplicitAgentAndSupportedAction() {
        XCTAssertNil(SmokeRunner.a4Proof(environment: [:]))
        XCTAssertNil(SmokeRunner.a4Proof(environment: [
            "HIVE_B25_A4_AGENT": "aria",
            "HIVE_B25_A4_ACTION": "quit",
        ]))
        XCTAssertNil(SmokeRunner.a4Proof(environment: [
            "HIVE_B25_A4_AGENT": "",
            "HIVE_B25_A4_ACTION": "close",
        ]))

        XCTAssertEqual(
            SmokeRunner.a4Proof(environment: [
                "HIVE_B25_A4_AGENT": "aria",
                "HIVE_B25_A4_ACTION": "close",
            ]),
            SmokeRunner.A4Proof(agent: "aria", action: .close)
        )
    }

    func testTerminationNeverWaitsForCleanupBeforeAllowingQuit() {
        _ = NSApplication.shared
        let owner = AppDelegate(config: completeConfig())
        var stopRequests = 0
        owner.stopForTermination = { _ in
            stopRequests += 1
        }

        XCTAssertEqual(owner.applicationShouldTerminate(.shared), .terminateNow)
        XCTAssertEqual(owner.applicationShouldTerminate(.shared), .terminateNow)
        XCTAssertEqual(stopRequests, 1)
    }

    /// Closing a pane (or a window fanning `.closePane` out to every pane)
    /// must NEVER kill the agent. The pane goes away; the agent keeps running
    /// headless, and the feed must not rebuild its pane while it does.
    func testPaneCloseClosesThePaneAndNeverKillsTheAgent() throws {
        _ = NSApplication.shared
        let state = ProjectState(projectID: "project", displayName: "Project")
        let controller = ProjectWindowController(
            state: state, attentionCenter: AttentionCenter(),
            hivePath: "/usr/bin/false", daemonPort: 1,
            instanceHome: "/tmp")
        controller.window?.isReleasedWhenClosed = false
        defer { controller.close() }
        let locator = AgentSessionLocator(
            instanceId: "instance",
            subject: AgentSessionSubject(kind: "agent", agentId: "agent-worker"),
            generation: 7,
            sessionId: "ses_0198a8f0-0000-7000-8000-000000000007",
            hostKind: "sessiond", engineBuildId: "engine")
        let snapshot = AgentSnapshot(
            id: "agent-worker", name: "worker", status: "working",
            sessionLocator: locator)
        controller.applyFeed([snapshot])
        let paneID = ProjectState.paneID(forAgent: "worker")
        XCTAssertNotNil(state.panes[paneID])

        controller.dispatch(.closePane(paneID))

        XCTAssertNil(state.panes[paneID], "the pane closes immediately")
        XCTAssertEqual(controller.paneViewCount, 0, "the pane view is torn down")

        // The agent is still alive in the next feed snapshot — the close must
        // not have asked anyone to end it, and its pane must not come back.
        controller.applyFeed([snapshot])
        XCTAssertNil(
            state.panes[paneID],
            "a user-closed pane is not rebuilt while the agent runs on")
    }

    func testFeedWireSurfacesMalformedPresentLocatorImmediately() async throws {
        let line = #"{"v":1,"agents":[{"name":"worker","sessionLocator":{"schemaVersion":1,"instanceId":"instance","subject":{"kind":"agent","agentId":"agent-worker"},"generation":"wrong","sessionId":"ses_bad","hostKind":"sessiond","engineBuildId":"engine"}}]}"#
        let feed = FeedClient(executable: "/bin/echo", arguments: [line])
        let surfaced = expectation(description: "feed schema failure")
        var message = ""
        feed.onSnapshot = { _, _ in
            XCTFail("malformed locator must not become a partial snapshot")
        }
        feed.onError = {
            message = $0
            surfaced.fulfill()
        }
        defer { feed.stop() }

        try feed.start()
        await fulfillment(of: [surfaced], timeout: 1)

        XCTAssertTrue(message.contains("sessionLocator"))
    }

    func testStrictFeedSurfacesNonJSONOutput() async throws {
        let feed = FeedClient(executable: "/bin/echo", arguments: ["not-json"])
        let surfaced = expectation(description: "non-JSON feed output")
        var message = ""
        feed.onMalformedLine = {
            message = $0
            surfaced.fulfill()
        }
        defer { feed.stop() }

        try feed.start()
        await fulfillment(of: [surfaced], timeout: 1)

        XCTAssertEqual(message, "workspace-feed envelope could not be decoded")
    }

    func testStrictFeedSurfacesInvalidUTF8() async throws {
        let feed = FeedClient(executable: "/usr/bin/printf", arguments: ["\\377\\n"])
        let surfaced = expectation(description: "invalid UTF-8 feed output")
        var message = ""
        feed.onMalformedLine = {
            message = $0
            surfaced.fulfill()
        }
        defer { feed.stop() }

        try feed.start()
        await fulfillment(of: [surfaced], timeout: 1)

        XCTAssertEqual(message, "workspace-feed emitted invalid UTF-8")
    }

    func testFreshShellPublishesEmptyVisibilityBeforeFirstAgentAdmission() throws {
        let temporary = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
            at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }

        let receipt = temporary.appendingPathComponent("inventory.json")
        let feedExecutable = temporary.appendingPathComponent("capture-feed")
        try """
        #!/bin/sh
        script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
        IFS= read -r inventory
        printf '%s\\n' "$inventory" > "$script_dir/inventory.json"
        """.write(to: feedExecutable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700], ofItemAtPath: feedExecutable.path)

        var config = completeConfig()
        config.projectDirectory = temporary.path
        config.instanceHome = temporary.path
        config.feedOverride = feedExecutable.path
        let launch = try XCTUnwrap(WorkspaceShellLaunch(
            arguments: [WorkspaceShellLaunch.liveFlag], fixtureState: nil))
        let delegate = WorkspaceShellDelegate(config: config, launch: launch)
        let workbench = LiveRunWorkbenchView(terminalFactory: nil)
        delegate.startLiveRunFeed(workbench: workbench)
        defer {
            delegate.applicationWillTerminate(Notification(
                name: NSApplication.willTerminateNotification))
        }

        let deadline = Date().addingTimeInterval(1)
        while !FileManager.default.fileExists(atPath: receipt.path), Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        let data = try Data(contentsOf: receipt)
        let inventory = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(inventory["inventoryRevision"] as? String, "1")
        XCTAssertEqual((inventory["terminals"] as? [Any])?.count, 0)
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

    /// Regression (fleet death 2026-08-02): a feed that never comes back must
    /// NEVER terminate the workspace or start the fleet stop — a status-poll
    /// timeout is an absent heartbeat, not positive evidence of death. The
    /// workspace stays up in its visible disconnected state and keeps retrying
    /// with the backoff held at its ceiling. Positive control: a user quit
    /// still stops the fleet.
    func testFeedRestartExhaustionNeverTerminatesOrStopsTheFleet() {
        _ = NSApplication.shared
        let owner = AppDelegate(config: completeConfig())
        var delays: [TimeInterval] = []
        owner.enqueueFeedRestart = { delay, _ in delays.append(delay) }
        var stopRequests = 0
        owner.stopForTermination = { _ in stopRequests += 1 }

        // Well past the old five-restart kill budget, no snapshot ever arrives.
        for _ in 0..<8 { owner.scheduleFeedRestart() }

        XCTAssertEqual(delays, [1, 2, 4, 8, 15, 15, 15, 15],
                       "retries continue with the backoff held at its ceiling")
        XCTAssertNil(owner.terminationReason, "a lost feed is not a quit reason")
        XCTAssertEqual(stopRequests, 0, "feed failure never starts the fleet stop")

        // Positive control: the user's own quit keeps its total shutdown.
        XCTAssertEqual(owner.applicationShouldTerminate(.shared), .terminateNow)
        XCTAssertEqual(stopRequests, 1)
    }

    func testLastWindowClosedRecordsItsOwnTerminationReason() {
        _ = NSApplication.shared
        let owner = AppDelegate(config: LaunchConfig())

        XCTAssertTrue(owner.applicationShouldTerminateAfterLastWindowClosed(.shared))
        XCTAssertEqual(owner.terminationReason, .lastWindowClosed)
    }

    /// A quit no in-app path claimed, with no Apple Event in flight, is the
    /// user's own Cmd-Q.
    func testAnUnclaimedQuitIsRecordedAsAUserQuit() {
        _ = NSApplication.shared
        let owner = AppDelegate(config: LaunchConfig())

        XCTAssertEqual(owner.applicationShouldTerminate(.shared), .terminateNow)
        XCTAssertEqual(owner.terminationReason, .userQuit)
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

    func testStatusAndFocusOverlaysAreAboveTheOpaquePaneBackground() throws {
        let pane = PaneView(paneID: "worker", title: "worker") { _ in }
        // The pane background is a plain opaque view (not vibrancy).
        let backgroundIndex = try XCTUnwrap(
            pane.subviews.firstIndex(where: { $0 is PaneBackgroundView }))
        let statusIndex = try XCTUnwrap(
            pane.subviews.firstIndex(where: { $0 is PaneStatusBorderView }))
        let focusIndex = try XCTUnwrap(
            pane.subviews.firstIndex(where: { $0 is PaneFocusRingView }))

        XCTAssertGreaterThan(statusIndex, backgroundIndex)
        XCTAssertGreaterThan(focusIndex, backgroundIndex)
        XCTAssertNil(pane.subviews[statusIndex].hitTest(.zero))
        XCTAssertNil(pane.subviews[focusIndex].hitTest(.zero))
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
            feedStatus: "working", status: .running, headerDetail: "working"))
        XCTAssertEqual(title.toolTip, "updated-title")
        XCTAssertTrue(textFields(in: pane).contains {
            $0.stringValue == "working" && $0.toolTip == "working"
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

    private func completeConfig() -> LaunchConfig {
        var config = LaunchConfig()
        config.projectDirectory = "/tmp/project"
        config.projectID = "project-fixture"
        config.projectName = "project"
        config.port = 1
        config.instanceID = "instance"
        config.instanceHome = "/tmp/hive"
        config.hivePath = "/usr/bin/true"
        return config
    }

    private final class RecordingMenu: NSMenu {
        var cancellationCount = 0

        override func cancelTrackingWithoutAnimation() {
            cancellationCount += 1
        }
    }
}
