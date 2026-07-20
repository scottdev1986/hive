import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore

@MainActor
final class AppDelegateLifecycleTests: XCTestCase {

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

    func testTerminationWaitsForVerifiedStopBeforeAllowingQuit() async {
        _ = NSApplication.shared
        let owner = AppDelegate(config: completeConfig())
        var finish: ((Result<Void, Error>) -> Void)?
        var replies: [Bool] = []
        let replied = expectation(description: "termination reply")
        owner.stopForTermination = { finish = $0 }
        owner.replyToApplicationTermination = {
            replies.append($0)
            replied.fulfill()
        }
        owner.presentTerminationFailure = { _ in
            XCTFail("successful teardown must not present failure")
        }

        XCTAssertEqual(
            owner.applicationShouldTerminate(.shared), .terminateLater)
        XCTAssertEqual(
            owner.applicationShouldTerminate(.shared), .terminateLater)
        XCTAssertTrue(replies.isEmpty)
        finish?(.success(()))
        await fulfillment(of: [replied], timeout: 1)
        XCTAssertEqual(replies, [true])
    }

    func testTerminationFailureCancelsQuitAndSurfacesReason() async {
        _ = NSApplication.shared
        let owner = AppDelegate(config: completeConfig())
        var finish: ((Result<Void, Error>) -> Void)?
        var replies: [Bool] = []
        var failure = ""
        let replied = expectation(description: "termination rejection")
        owner.stopForTermination = { finish = $0 }
        owner.replyToApplicationTermination = {
            replies.append($0)
            replied.fulfill()
        }
        owner.presentTerminationFailure = { failure = $0 }

        XCTAssertEqual(owner.applicationShouldTerminate(.shared), .terminateLater)
        finish?(.failure(NSError(
            domain: "test", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "provider tree survived"])))
        await fulfillment(of: [replied], timeout: 1)

        XCTAssertEqual(replies, [false])
        XCTAssertEqual(failure, "provider tree survived")
    }

    func testPaneCloseCarriesTheExactFeedLocatorToKill() throws {
        _ = NSApplication.shared
        let state = ProjectState(projectID: "project", displayName: "Project")
        let controller = ProjectWindowController(
            state: state, attentionCenter: AttentionCenter(),
            projectDirectory: "/tmp", hivePath: "/usr/bin/false", daemonPort: 1,
            orchestrator: "claude", orchestratorSession: nil,
            instanceID: "instance", instanceHome: "/tmp")
        controller.window?.isReleasedWhenClosed = false
        defer { controller.close() }
        let locator = AgentSessionLocator(
            instanceId: "instance",
            subject: AgentSessionSubject(kind: "agent", agentId: "agent-worker"),
            generation: 7,
            sessionId: "ses_0198a8f0-0000-7000-8000-000000000007",
            hostKind: "sessiond", engineBuildId: "engine")
        var killed: (String, AgentSessionLocator)?
        controller.killAgent = { killed = ($0, $1) }
        controller.applyFeed([
            AgentSnapshot(
                id: "agent-worker", name: "worker", status: "working",
                sessionLocator: locator),
        ])

        controller.dispatch(.closePane(ProjectState.paneID(forAgent: "worker")))

        XCTAssertEqual(killed?.0, "worker")
        XCTAssertEqual(killed?.1, locator)
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
        let state = ProjectState(projectID: "project", displayName: "Project")
        let controller = ProjectWindowController(
            state: state, attentionCenter: AttentionCenter(),
            projectDirectory: "/tmp", hivePath: "/usr/bin/false", daemonPort: 1,
            orchestrator: "claude", orchestratorSession: nil,
            instanceID: "instance", instanceHome: "/tmp")
        controller.window?.isReleasedWhenClosed = false
        defer { controller.close() }

        controller.reportKillFailure(agent: "worker", reason: "daemon unavailable")
        XCTAssertEqual(controller.window?.sheets.count, 1)

        controller.applyFeed([
            AgentSnapshot(
                name: "worker", status: "done",
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
