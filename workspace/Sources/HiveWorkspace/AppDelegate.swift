import AppKit
import WorkspaceCore

/// One AppKit process multiplexing every project as an in-process tenant:
/// one window controller, layout tree, and reducer per project; one shared
/// menu bar, attention center, and event pump.
final class AppDelegate: NSObject, NSApplicationDelegate {

    private let smokeMode: Bool
    private(set) var controllers: [ProjectID: ProjectWindowController] = [:]
    private let attentionCenter = AttentionCenter()
    private let projectSwitcher = ProjectSwitcherController()
    private var eventPump: EventPump?

    init(smokeMode: Bool) {
        self.smokeMode = smokeMode
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = MainMenuBuilder.build()

        let projects: [(ProjectID, String)] = [
            (FixtureScript.hiveProject, "hive"),
            (FixtureScript.docsProject, "docs-site"),
        ]
        for (offset, (projectID, name)) in projects.enumerated() {
            let state = ProjectState(projectID: projectID, displayName: name)
            let controller = ProjectWindowController(
                state: state, attentionCenter: attentionCenter, cascadeIndex: offset)
            controllers[projectID] = controller
            projectSwitcher.register(state: state) { [weak controller] in
                controller?.window?.makeKeyAndOrderFront(nil)
            }
            if !smokeMode {
                controller.showWindow(nil)
            }
        }
        attentionCenter.activateHandler = { [weak self] projectID, paneID in
            guard let controller = self?.controllers[projectID] else { return }
            controller.window?.makeKeyAndOrderFront(nil)
            controller.dispatch(.focusPane(paneID))
        }

        let source = MockEventSource(script: FixtureScript.standard())
        let pump = EventPump(source: source) { [weak self] envelope in
            self?.controllers[envelope.projectID]?.ingest(envelope)
        }
        eventPump = pump

        if smokeMode {
            runSmokeChecksAndExit(pump: pump)
        } else {
            NSApp.activate(ignoringOtherApps: true)
            controllers[FixtureScript.hiveProject]?.window?.makeKeyAndOrderFront(nil)
            pump.startScheduled()
        }
    }

    @objc func showAttentionPanel(_ sender: Any?) {
        attentionCenter.showPanel()
    }

    @objc func showProjectSwitcher(_ sender: Any?) {
        projectSwitcher.showPanel()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Blueprint: closing UI never stops agents; in the real product the
        // tenant keeps running headless. The prototype mirrors that by keeping
        // the process alive until explicit quit.
        false
    }

    // MARK: Smoke mode

    private func runSmokeChecksAndExit(pump: EventPump) {
        var failures: [String] = []
        func check(_ condition: Bool, _ label: String) {
            if !condition { failures.append(label) }
        }

        pump.fastForward()

        guard let hive = controllers[FixtureScript.hiveProject],
              let docs = controllers[FixtureScript.docsProject] else {
            print("SMOKE FAIL: controllers missing")
            exit(1)
        }
        hive.window?.layoutIfNeeded()
        docs.window?.layoutIfNeeded()

        check(hive.state.panes.count == 5, "hive has 5 panes")
        check(docs.state.panes.count == 2, "docs has 2 panes")
        check(hive.state.layout.master == PaneID("orchestrator"), "orchestrator is master")
        check(hive.paneViewCount == 5, "hive renders 5 pane views")

        // Frames are committed (no animation pending in smoke) and tile.
        let frames = hive.currentPaneFrames()
        check(frames.count == 5, "5 solved frames")
        let masterFrame = frames[PaneID("orchestrator")]
        check(masterFrame != nil && masterFrame!.width > 0, "master has geometry")

        // Command model round trip: promote + return.
        hive.dispatch(.promotePane("migrator"))
        check(hive.state.layout.master == PaneID("migrator"), "promote via command model")
        hive.dispatch(.returnOrchestratorToMaster)
        check(hive.state.layout.master == PaneID("orchestrator"), "return orchestrator to master")

        // Attention queue is populated and ordered by severity.
        let attention = attentionCenter.orderedItems()
        check(!attention.isEmpty, "attention queue populated")
        check(attention.first?.severity == .failed, "failure ranks first")

        // Transcript rendered real content, including the collapsed huge output.
        check(hive.transcriptTextLength(pane: "indexer") > 0, "indexer transcript rendered")
        check(hive.transcriptTextLength(pane: "styler") > 0, "styler transcript rendered")

        // Explicit approval resolution through the shared command model.
        hive.dispatch(.resolveApproval(approvalID: "appr-schema-migration", approved: true))
        check(hive.state.panes[PaneID("migrator")]?.status == .running, "approval resolves to running")

        if failures.isEmpty {
            print("SMOKE OK — \(controllers.count) project windows, \(hive.state.panes.count + docs.state.panes.count) panes")
            exit(0)
        } else {
            print("SMOKE FAIL:\n  " + failures.joined(separator: "\n  "))
            exit(1)
        }
    }
}

/// Drives the mock event source either on the main run loop (scheduled, for
/// interactive runs) or synchronously (fast-forward, for smoke/tests).
final class EventPump {
    private let source: MockEventSource
    private let handler: (AgentEventEnvelope) -> Void

    init(source: MockEventSource, handler: @escaping (AgentEventEnvelope) -> Void) {
        self.source = source
        self.handler = handler
    }

    func fastForward() {
        source.fastForward(handler)
    }

    func startScheduled() {
        scheduleNext()
    }

    private func scheduleNext() {
        guard let delay = source.nextDelay else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, let envelope = self.source.next() else { return }
            self.handler(envelope)
            self.scheduleNext()
        }
    }
}
