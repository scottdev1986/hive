import AppKit
import WorkspaceCore

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation, NSWindowDelegate {

    static let terminationStopArguments = ["stop", "--force"]

    private let config: LaunchConfig
    private(set) var controller: ProjectWindowController?
    private var feedClient: FeedClient?
    private let attentionCenter = AttentionCenter()
    private let projectSwitcher = ProjectSwitcherController()
    private var placeholderWindow: NSWindow?
    /// Where a QA build attaches. Empty in the shipped app, whose binary holds no harness to attach.
    private let qa: WorkspaceQAHooks
    /// The daemon's live agent-autonomy dial as last reported by the feed or confirmed by a `hive autonomy` set. nil means unknown (no feed yet, or the daemon does not expose the dial) — the menu items disable rather than guess.
    private(set) var currentAutonomy: String?
    /// How long to wait before restarting a feed that exited. One second in the common case (a killed or crashed feed), doubling to a ceiling so a feed that cannot run at all — missing binary, dead daemon — is retried without a spawn storm. A snapshot resets it: that is the feed proving it works.
    private var feedRestartDelay: TimeInterval = 1
    private static let feedRestartCeiling: TimeInterval = 15
    /// Set once the app has decided the feed should stay dead (window closing, app quitting), so a restart already in flight cannot resurrect it.
    private var feedRetired = false
    /// Whichever menu is tracking right now, if any. An open NSMenu runs a nested tracking loop and belongs to no window, so closing the windows cannot dismiss it — the instance has to cancel it by hand on the way out. Weak, and per-instance: nothing here outlives this process.
    private weak var trackingMenu: NSMenu?
    private let workspaceSessionID = UUID().uuidString
    private(set) var terminationReason: TerminationLog.Reason?
    private var terminationStopStarted = false
    private var terminationProcess: Process?

    lazy var stopForTermination: (@escaping (Result<Void, Error>) -> Void) -> Void = {
        [weak self] completion in self?.runStopSession(completion: completion)
    }

    var enqueueFeedRestart: (TimeInterval, @escaping () -> Void) -> Void = { delay, work in
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    init(config: LaunchConfig, qa: WorkspaceQAHooks = WorkspaceQAHooks()) {
        self.config = config
        self.qa = qa
        super.init()
        NotificationCenter.default.addObserver(
            self, selector: #selector(menuDidBeginTracking(_:)),
            name: NSMenu.didBeginTrackingNotification, object: nil)
    }

    deinit {
        NotificationCenter.default.removeObserver(
            self, name: NSMenu.didBeginTrackingNotification, object: nil)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard config.isComplete,
              config.projectDirectory != nil,
              let projectID = config.projectID,
              let projectName = config.projectName,
              let hivePath = config.hivePath,
              let daemonPort = config.port,
              config.instanceID != nil,
              let instanceHome = config.instanceHome else {
            NSApp.mainMenu = MainMenuBuilder.build()
            if config.smoke {
                // Smoke must never hang on a bad invocation.
                print("SMOKE FAIL:\n  --smoke requires project identity, --port, and --hive")
                TerminationLog.record(
                    .exiting, reason: .smokeInvalidInvocation,
                    detail: "code=1 --smoke requires project identity, --port, and --hive")
                exit(1)
            }
            // Dock click / bare CLI launch: project-neutral home, never cwd data.
            showPlaceholderWindow()
            if config.settings { showSettings(nil) }
            return
        }

        let state = ProjectState(projectID: ProjectID(projectID), displayName: projectName)
        let controller = ProjectWindowController(
            state: state, attentionCenter: attentionCenter,
            hivePath: hivePath, daemonPort: daemonPort,
            instanceHome: instanceHome)
        self.controller = controller
        NSApp.mainMenu = MainMenuBuilder.build(paneTarget: controller)

        projectSwitcher.register(state: state) { [weak controller] in
            controller?.window?.makeKeyAndOrderFront(nil)
        }
        controller.onStateChange = { [weak self] in
            self?.projectSwitcher.refresh()
            self?.publishVisibility()
        }
        attentionCenter.activateHandler = { [weak controller] _, paneID in
            controller?.window?.makeKeyAndOrderFront(nil)
            controller?.dispatch(.focusPane(paneID))
        }

        controller.onWindowWillClose = { [weak self, weak controller] in
            self?.retireFeed()
            // The project window is this instance's reason to exist: when it goes, so does everything else the instance put on screen. Without this, an open Settings window or panel keeps the process alive (the app quits only after its *last* window closes), and an open menu keeps tracking — the workspace disappears and its leftovers stay up.
            self?.closeOwnedSurfaces(except: controller?.window)
        }
        startFeed()
        // Publish the initially empty terminal inventory before the root surface attaches. The backend owns Queen's process lifecycle; this app only reports the terminal it can actually display.
        publishVisibility()
        controller.prepareInitialLayout()

        if config.smoke {
            guard let smoke = qa.smoke else {
                // Smoke must never hang on a build that cannot run it.
                print("SMOKE FAIL:\n  --smoke needs the QA build (HiveWorkspaceQA)")
                TerminationLog.record(
                    .exiting, reason: .smokeInvalidInvocation,
                    detail: "code=1 --smoke needs the QA build")
                exit(1)
            }
            if ProcessInfo.processInfo.environment["HIVE_SMOKE_VISIBLE"] == "1" {
                controller.showWindow(nil)
                NSApp.activate(ignoringOtherApps: true)
                controller.window?.makeKeyAndOrderFront(nil)
                controller.commitInitialGeometry()
                DispatchQueue.main.async { [weak controller] in
                    controller?.commitInitialGeometry()
                }
            }
            controller.window?.layoutIfNeeded()
            smoke(controller, config) // exits the process 0/1
        } else {
            controller.showWindow(nil)
            NSApp.activate(ignoringOtherApps: true)
            controller.window?.makeKeyAndOrderFront(nil)
            controller.commitInitialGeometry()
            // The first separate process for one bundle can receive its final content bounds one run-loop turn after becoming key. This retry is idempotent: a terminal whose pending launch was consumed is never spawned twice.
            DispatchQueue.main.async { [weak controller] in
                controller?.commitInitialGeometry()
            }
            // The harness reads its own environment to decide whether this
            // interactive launch is one it drives.
            qa.smoke?(controller, config)
            if config.settings { showSettings(nil) }
        }
    }

    private func startFeed() {
        guard let invocation = config.feedInvocation(
            workspaceSessionID: workspaceSessionID
        ) else { return }
        let feed = FeedClient(executable: invocation.executable,
                              arguments: invocation.arguments,
                              environment: invocation.environment)
        feed.onSnapshot = { [weak self] agents, orchestrator in
            // A snapshot is the feed proving it works: the backoff is for a feed that cannot run, not for one that was killed.
            self?.feedRestartDelay = 1
            self?.controller?.applyFeed(agents, orchestrator: orchestrator)
            self?.publishVisibility()
        }
        feed.onAutonomy = { [weak self] autonomy in
            self?.currentAutonomy = autonomy
        }
        feed.onError = { [weak self] message in
            NSLog("workspace-feed error: %@", message)
            if message.hasPrefix("workspace-feed agent schema error:") {
                self?.controller?.reportFeedFailure(reason: message)
            }
        }
        feed.onExit = { [weak self] in
            NSLog("workspace-feed exited; agent statuses are stale")
            self?.controller?.feedLost()
            self?.scheduleFeedRestart()
        }
        feedClient = feed
        do {
            try feed.start()
        } catch {
            NSLog("failed to start workspace-feed: %@", error.localizedDescription)
            controller?.feedLost()
            scheduleFeedRestart()
        }
    }

    private func publishVisibility() {
        guard let controller, let feedClient else { return }
        do {
            try feedClient.publishVisibility(controller.state.visibilityInventory(
                geometries: controller.visibilityGeometries()))
        } catch {
            NSLog("workspace visibility publish failed: %@", error.localizedDescription)
        }
    }

    /// A live workspace must not retain stale status after a transient feed exit, so the feed is retried with the backoff held at its ceiling — indefinitely. A status-poll timeout is an absent heartbeat, never positive evidence of a dead fleet: the workspace stays up in its visible disconnected state (every pane is already marked disconnected by `feedLost()`) and only a user-initiated quit stops the fleet.
    func scheduleFeedRestart() {
        guard !feedRetired,
              config.feedInvocation(workspaceSessionID: workspaceSessionID) != nil else { return }
        let delay = feedRestartDelay
        feedRestartDelay = min(feedRestartDelay * 2, Self.feedRestartCeiling)
        NSLog("restarting workspace-feed in %.0fs", delay)
        enqueueFeedRestart(delay) { [weak self] in
            guard let self, !self.feedRetired else { return }
            self.startFeed()
        }
    }

    private func retireFeed() {
        feedRetired = true
        feedClient?.stop()
    }

    @objc func selectSandboxedAutonomy(_ sender: Any?) {
        setAutonomy("sandboxed")
    }

    @objc func selectDangerousAutonomy(_ sender: Any?) {
        setAutonomy("dangerous")
    }

    /// Sets the dial through `hive autonomy <mode>` — the same daemon endpoint the CLI uses, which persists to `~/.hive/config.toml` before applying. The checkmark updates only from the daemon's own answer (stdout names the confirmed mode); the feed reconciles it afterwards regardless, so the menu never claims a state the daemon doesn't hold.
    private func setAutonomy(_ mode: String) {
        guard let hivePath = config.hivePath, let port = config.port,
              let instanceHome = config.instanceHome else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: hivePath)
        process.arguments = ["autonomy", mode, "--port", String(port)]
        var environment = ProcessInfo.processInfo.environment
        environment["HIVE_HOME"] = instanceHome
        process.environment = environment
        let stdout = Pipe()
        process.standardOutput = stdout
        process.standardError = FileHandle.standardError
        process.terminationHandler = { finished in
            let data = stdout.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""
            let confirmed = ["sandboxed", "dangerous"].first { output.contains("now \($0)") }
            DispatchQueue.main.async { [weak self] in
                if finished.terminationStatus == 0, let confirmed {
                    self?.currentAutonomy = confirmed
                } else {
                    NSLog("hive autonomy %@ failed (exit %d): %@",
                          mode, finished.terminationStatus, output)
                }
            }
        }
        do {
            try process.run()
        } catch {
            NSLog("could not run hive autonomy: %@", error.localizedDescription)
        }
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(selectSandboxedAutonomy(_:)):
            menuItem.state = currentAutonomy == "sandboxed" ? .on : .off
            return currentAutonomy != nil
        case #selector(selectDangerousAutonomy(_:)):
            menuItem.state = currentAutonomy == "dangerous" ? .on : .off
            return currentAutonomy != nil
        default:
            return true
        }
    }

    private var settingsController: SettingsWindowController?

    @objc func showSettings(_ sender: Any?) {
        if settingsController == nil {
            settingsController = SettingsWindowController(
                hivePath: config.hivePath, daemonPort: config.port,
                instanceHome: config.instanceHome,
                initialWidth: config.settingsWidth)
        }
        if let page = config.settingsPage {
            settingsController?.select(section: page)
        }
        settingsController?.show()
    }

    @objc func showAttentionPanel(_ sender: Any?) {
        attentionCenter.showPanel()
    }

    @objc func showProjectSwitcher(_ sender: Any?) {
        projectSwitcher.showPanel()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        noteTerminationReason(.lastWindowClosed, detail: "last window closed")
        return true
    }

    private func noteTerminationReason(
        _ reason: TerminationLog.Reason, detail: String
    ) {
        guard terminationReason == nil else { return }
        terminationReason = reason
        TerminationLog.record(.requested, reason: reason, detail: detail)
    }

    private func unclaimedTerminationReason() -> TerminationLog.Reason {
        NSAppleEventManager.shared().currentAppleEvent?.eventID == kAEQuitApplication
            ? .appleEventQuit
            : .userQuit
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let reason = terminationReason ?? unclaimedTerminationReason()
        terminationReason = reason
        guard config.isComplete, !config.smoke else {
            TerminationLog.record(
                .decision, reason: reason,
                detail: "reply=terminateNow no-session-to-stop")
            return .terminateNow
        }
        if !terminationStopStarted {
            terminationStopStarted = true
            stopForTermination { result in
                if case .failure(let error) = result {
                    NSLog(
                        "Hive cleanup continued after Workspace exit: %@",
                        error.localizedDescription)
                }
            }
        }
        TerminationLog.record(
            .decision, reason: reason,
            detail: "reply=terminateNow cleanup-delegated-to-daemon")
        return .terminateNow
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            controller?.window?.makeKeyAndOrderFront(nil)
            placeholderWindow?.makeKeyAndOrderFront(nil)
        }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        TerminationLog.record(
            .willTerminate, reason: terminationReason, detail: "teardown starting")
        closeOwnedSurfaces()
        retireFeed()
        controller?.terminateAllTerminals()
    }

    /// Quitting the workspace ends the Hive session: `hive stop` is the daemon's own shutdown — it stops every live agent and then the daemon itself — so no agent, and no daemon, outlives the window that was showing them. The subprocess is best effort and never controls whether AppKit exits. Once the Workspace process disappears, the daemon's verified owner watch independently drives the same cleanup path.
    private func runStopSession(completion: @escaping (Result<Void, Error>) -> Void) {
        guard let hivePath = config.hivePath, let instanceHome = config.instanceHome,
              !config.smoke else {
            completion(.success(()))
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: hivePath)
        // Agent teardown already preserves unlanded commits and worktrees. Quit is not an interactive terminal, so do not turn that preserved work into a confirmation prompt that can only cancel application termination.
        process.arguments = Self.terminationStopArguments
        var environment = ProcessInfo.processInfo.environment
        environment["HIVE_HOME"] = instanceHome
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        let stderr = Pipe()
        process.standardError = stderr
        process.terminationHandler = { [weak self] finished in
            let detail = String(
                data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            DispatchQueue.main.async { self?.terminationProcess = nil }
            if finished.terminationStatus == 0 {
                completion(.success(()))
            } else {
                let message = detail.isEmpty
                    ? "hive stop failed (exit \(finished.terminationStatus))"
                    : detail
                completion(.failure(NSError(
                    domain: "HiveWorkspace.Termination", code: Int(finished.terminationStatus),
                    userInfo: [NSLocalizedDescriptionKey: message])))
            }
        }
        do {
            terminationProcess = process
            try process.run()
        } catch {
            process.terminationHandler = nil
            terminationProcess = nil
            completion(.failure(error))
        }
    }

    @objc private func menuDidBeginTracking(_ notification: Notification) {
        trackingMenu = notification.object as? NSMenu
    }

    func closeOwnedSurfaces(except keep: NSWindow? = nil) {
        trackingMenu?.cancelTrackingWithoutAnimation()
        NSApp.mainMenu?.cancelTrackingWithoutAnimation()
        let windows = NSApp.windows
        Self.abortModalIfOwned(
            NSApp.modalWindow, ownedWindows: windows, abort: NSApp.abortModal)
        Self.tearDownWindows(
            windows, keeping: keep,
            endSheets: { window in
                for sheet in window.sheets {
                    window.endSheet(sheet)
                }
            },
            close: { $0.close() })
    }

    static func abortModalIfOwned<Surface: AnyObject>(
        _ modalWindow: Surface?, ownedWindows: [Surface], abort: () -> Void
    ) {
        guard let modalWindow,
              ownedWindows.contains(where: { $0 === modalWindow }) else { return }
        abort()
    }

    static func tearDownWindows<Window: AnyObject>(
        _ windows: [Window], keeping keep: Window?,
        endSheets: (Window) -> Void, close: (Window) -> Void
    ) {
        for window in windows {
            endSheets(window)
            if window !== keep { close(window) }
        }
    }

    func windowWillClose(_ notification: Notification) {
        closeOwnedSurfaces(except: notification.object as? NSWindow)
    }

    private func showPlaceholderWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 200),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered, defer: false)
        window.title = "Hive Workspace"
        window.center()

        let title = NSTextField(labelWithString: "Hive Workspace")
        title.font = NSFont.systemFont(ofSize: 15, weight: .semibold)
        title.alignment = .center
        title.compressHorizontally()

        let body = NSTextField(wrappingLabelWithString:
            "No project is open.\n\nRun `hive` from a project directory to open it here. New project? Run `hive init` there first.")
        body.font = Theme.bodyFont
        body.textColor = .secondaryLabelColor
        body.alignment = .center
        body.compressHorizontally()

        let stack = NSStackView(views: [title, body])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 30, left: 30, bottom: 30, right: 30)
        window.contentView = stack

        placeholderWindow = window
        window.delegate = self
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
