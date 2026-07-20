import AppKit
import WorkspaceCore

/// The workspace app for one project: a master terminal running the
/// selected Claude or Codex orchestrator, satellite terminals attached to each agent's
/// daemon-owned tmux session, and the feed subprocess that drives the pane
/// set. Launched by the CLI as
/// `open -a HiveWorkspace --args --project <dir> --port <n> --hive <bin>
/// --orchestrator-session <tmux session> --orchestrator <claude|codex|grok>`.
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation, NSWindowDelegate {

    private let config: LaunchConfig
    private(set) var controller: ProjectWindowController?
    private var feedClient: FeedClient?
    private let attentionCenter = AttentionCenter()
    private let projectSwitcher = ProjectSwitcherController()
    private var placeholderWindow: NSWindow?
    private var smokeRunner: SmokeRunner?
    private var composerLeases: ComposerLeaseStore?
    /// The daemon's live agent-autonomy dial as last reported by the feed or
    /// confirmed by a `hive autonomy` set. nil means unknown (no feed yet, or
    /// the daemon predates the dial) — the menu items disable rather than
    /// guess.
    private(set) var currentAutonomy: String?
    /// How long to wait before restarting a feed that exited. One second in the
    /// common case (a killed or crashed feed), doubling to a ceiling so a feed
    /// that cannot run at all — missing binary, dead daemon — is retried
    /// without a spawn storm. A snapshot resets it: that is the feed proving it
    /// works.
    private var feedRestartDelay: TimeInterval = 1
    private static let feedRestartCeiling: TimeInterval = 15
    /// Restarts are capped so a feed that can never run — a missing binary, a
    /// daemon that is gone for good — stops thrashing.
    private static let feedRestartLimit = 5
    private var feedRestartsLeft = AppDelegate.feedRestartLimit
    /// Set once the app has decided the feed should stay dead (window closing,
    /// app quitting), so a restart already in flight cannot resurrect it.
    private var feedRetired = false
    /// Whichever menu is tracking right now, if any. An open NSMenu runs a
    /// nested tracking loop and belongs to no window, so closing the windows
    /// cannot dismiss it — the instance has to cancel it by hand on the way
    /// out. Weak, and per-instance: nothing here outlives this process.
    private weak var trackingMenu: NSMenu?
    private let workspaceSessionID = UUID().uuidString
    private var terminationPending = false
    private var terminationFailureAlert: NSAlert?
    private var terminationProcess: Process?

    lazy var stopForTermination: (@escaping (Result<Void, Error>) -> Void) -> Void = {
        [weak self] completion in self?.runStopSession(completion: completion)
    }
    lazy var replyToApplicationTermination: (Bool) -> Void = { allow in
        NSApp.reply(toApplicationShouldTerminate: allow)
    }
    lazy var presentTerminationFailure: (String) -> Void = { [weak self] reason in
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Hive could not quit safely"
        alert.informativeText = reason
        alert.addButton(withTitle: "OK")
        self?.terminationFailureAlert = alert
        alert.window.makeKeyAndOrderFront(nil)
    }

    init(config: LaunchConfig) {
        self.config = config
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
              let projectDirectory = config.projectDirectory,
              let hivePath = config.hivePath,
              let daemonPort = config.port,
              let instanceID = config.instanceID,
              let instanceHome = config.instanceHome else {
            NSApp.mainMenu = MainMenuBuilder.build()
            if config.smoke {
                // Smoke must never hang on a bad invocation.
                print("SMOKE FAIL:\n  --smoke requires --project, --port, and --hive")
                exit(1)
            }
            // Dock click / bare CLI launch: project-neutral home, never cwd data.
            showPlaceholderWindow()
            if config.settings { showSettings(nil) }
            return
        }

        let displayName = (projectDirectory as NSString).lastPathComponent
        let state = ProjectState(projectID: ProjectID(projectDirectory), displayName: displayName)
        let controller = ProjectWindowController(
            state: state, attentionCenter: attentionCenter,
            projectDirectory: projectDirectory, hivePath: hivePath,
            daemonPort: daemonPort, orchestrator: config.orchestrator,
            orchestratorSession: config.orchestratorSession,
            tmuxSocket: config.tmuxSocket,
            instanceID: instanceID, instanceHome: instanceHome)
        self.controller = controller
        let composerLeases = ComposerLeaseStore(instanceHome: instanceHome)
        self.composerLeases = composerLeases
        controller.onComposerInput = { [weak composerLeases] recipient, action in
            composerLeases?.handle(recipient: recipient, action: action)
        }
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
            self?.composerLeases?.clear()
            self?.retireFeed()
            // The project window is this instance's reason to exist: when it
            // goes, so does everything else the instance put on screen. Without
            // this, an open Settings window or panel keeps the process alive
            // (the app quits only after its *last* window closes), and an open
            // menu keeps tracking — the workspace disappears and its leftovers
            // stay up.
            self?.closeOwnedSurfaces(except: controller?.window)
        }
        controller.bootstrapOrchestrator()
        startFeed()

        if config.smoke {
            let runner = SmokeRunner(controller: controller, config: config)
            smokeRunner = runner
            // Focus is only real in a key window: macOS routes the first click
            // into an inactive window to activation, not to a control. The
            // click-to-focus checks therefore need a shown, activated window,
            // which HIVE_SMOKE_VISIBLE=1 asks for (and which is also how the
            // indicator gets looked at). Default smoke stays offscreen.
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
            runner.run() // exits the process 0/1
        } else {
            controller.showWindow(nil)
            NSApp.activate(ignoringOtherApps: true)
            controller.window?.makeKeyAndOrderFront(nil)
            // A second Workspace process with the same bundle id does not get
            // usable content bounds until it is active/key. Committing before
            // this point leaves its orchestrator pane at 0×0 forever.
            controller.commitInitialGeometry()
            // The first separate process for one bundle can receive its final
            // content bounds one run-loop turn after becoming key. This retry
            // is idempotent: a terminal whose pending launch was consumed is
            // never spawned twice.
            DispatchQueue.main.async { [weak controller] in
                controller?.commitInitialGeometry()
            }
            if ProcessInfo.processInfo.environment["HIVE_SMOKE_SESSIOND_LIVE_RESIZE_INPUT"] == "1" {
                let runner = SmokeRunner(controller: controller, config: config)
                smokeRunner = runner
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { runner.run() }
            }
            if config.settings { showSettings(nil) }
        }
    }

    /// The feed is a long-lived subprocess printing status snapshots. It dies
    /// with the app (`retireFeed()` below).
    private func startFeed() {
        guard let invocation = config.feedInvocation(
            workspaceSessionID: workspaceSessionID
        ) else { return }
        let feed = FeedClient(executable: invocation.executable,
                              arguments: invocation.arguments,
                              environment: invocation.environment)
        feed.onSnapshot = { [weak self] agents, orchestrator in
            // A snapshot is the feed proving it works: the budget is for a feed
            // that cannot run, not for one that was killed five times.
            self?.feedRestartDelay = 1
            self?.feedRestartsLeft = AppDelegate.feedRestartLimit
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
            try feedClient.publishVisibility(controller.state.visibilityInventory())
        } catch {
            NSLog("workspace visibility publish failed: %@", error.localizedDescription)
        }
    }

    /// A live workspace must not retain stale status after a transient feed
    /// exit. Retries are bounded so a persistent failure becomes visible.
    private func scheduleFeedRestart() {
        guard !feedRetired,
              config.feedInvocation(workspaceSessionID: workspaceSessionID) != nil else { return }
        guard feedRestartsLeft > 0 else {
            terminateAfterFeedFailure()
            return
        }
        feedRestartsLeft -= 1
        let delay = feedRestartDelay
        feedRestartDelay = min(feedRestartDelay * 2, Self.feedRestartCeiling)
        NSLog("restarting workspace-feed in %.0fs", delay)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.feedRetired else { return }
            self.startFeed()
        }
    }

    /// A permanently lost feed makes this instance unable to own its agent UI
    /// honestly. End its nested UI sessions and windows before terminating.
    func terminateAfterFeedFailure(terminate: () -> Void = { NSApp.terminate(nil) }) {
        NSLog("workspace-feed could not be restarted; terminating the workspace")
        closeOwnedSurfaces()
        retireFeed()
        terminate()
    }

    /// Stop the feed and suppress restart callbacks once its workspace closes.
    private func retireFeed() {
        feedRetired = true
        feedClient?.stop()
    }

    // MARK: Agent autonomy (Agents menu)

    @objc func selectSandboxedAutonomy(_ sender: Any?) {
        setAutonomy("sandboxed")
    }

    @objc func selectDangerousAutonomy(_ sender: Any?) {
        setAutonomy("dangerous")
    }

    /// Sets the dial through `hive autonomy <mode>` — the same daemon
    /// endpoint the CLI uses, which persists to `~/.hive/config.toml` before
    /// applying. The checkmark updates only from the daemon's own answer
    /// (stdout names the confirmed mode); the feed reconciles it afterwards
    /// regardless, so the menu never claims a state the daemon doesn't hold.
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
            // "autonomy is now <mode> — ..." — trust the named mode, not the
            // exit code alone.
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

    // MARK: Settings (Model Control Center)

    private var settingsController: SettingsWindowController?

    @objc func showSettings(_ sender: Any?) {
        if settingsController == nil {
            // Works in both launch modes: with `--hive` the screen reads live
            // data; a bare Dock launch has no binary path and the screen says
            // so instead of guessing.
            settingsController = SettingsWindowController(
                hivePath: config.hivePath, daemonPort: config.port,
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
        // One launch invocation owns one project window. Once it closes, no UI
        // surface remains to own this Hive instance.
        true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard config.isComplete, !config.smoke else { return .terminateNow }
        guard !terminationPending else { return .terminateLater }
        terminationPending = true
        stopForTermination { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success:
                    self.replyToApplicationTermination(true)
                case .failure(let error):
                    self.terminationPending = false
                    self.replyToApplicationTermination(false)
                    self.presentTerminationFailure(error.localizedDescription)
                }
            }
        }
        return .terminateLater
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            controller?.window?.makeKeyAndOrderFront(nil)
            placeholderWindow?.makeKeyAndOrderFront(nil)
        }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        composerLeases?.clear()
        closeOwnedSurfaces()
        retireFeed()
        controller?.terminateAllTerminals()
    }

    /// Quitting the workspace ends the Hive session: `hive stop` is the daemon's
    /// own shutdown — it stops every live agent and then the daemon itself — so
    /// no agent, and no daemon, outlives the window that was showing them.
    ///
    /// AppKit holds termination until this process exits successfully. `hive
    /// stop` itself returns only after exact process-tree absence has been read
    /// back; an error cancels quit and remains visible.
    private func runStopSession(completion: @escaping (Result<Void, Error>) -> Void) {
        guard let hivePath = config.hivePath, let instanceHome = config.instanceHome,
              !config.smoke else {
            completion(.success(()))
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: hivePath)
        process.arguments = ["stop"]
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

    /// Take down every surface this instance owns. Menus and app-modal alerts
    /// run nested event loops that closing their windows does not end; cancel
    /// those loops first, then end sheets before closing their parents.
    /// `NSApp.windows` is process-local, so a sibling Hive instance is outside
    /// this set.
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

    /// The placeholder window is the no-project instance's only window; closing
    /// it ends that instance the same way closing the project window does.
    func windowWillClose(_ notification: Notification) {
        closeOwnedSurfaces(except: notification.object as? NSWindow)
    }

    // MARK: No-args launch

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
