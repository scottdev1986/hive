import AppKit
import WorkspaceCore

/// The workspace app for one project: a master terminal running the
/// selected Claude or Codex orchestrator, satellite terminals attached to each agent's
/// daemon-owned tmux session, and the feed subprocess that drives the pane
/// set. Launched by the CLI as
/// `open -a HiveWorkspace --args --project <dir> --port <n> --hive <bin>
/// --orchestrator-session <tmux session> --orchestrator <claude|codex>`.
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {

    private let config: LaunchConfig
    private(set) var controller: ProjectWindowController?
    private var feedClient: FeedClient?
    private let attentionCenter = AttentionCenter()
    private let projectSwitcher = ProjectSwitcherController()
    private var placeholderWindow: NSWindow?
    private var smokeRunner: SmokeRunner?
    /// The daemon's live writer-autonomy dial as last reported by the feed or
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
    /// Set once the app has decided the feed should stay dead (window closing,
    /// app quitting), so a restart already in flight cannot resurrect it.
    private var feedRetired = false

    init(config: LaunchConfig) {
        self.config = config
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard config.isComplete,
              let projectDirectory = config.projectDirectory,
              let hivePath = config.hivePath,
              let daemonPort = config.port else {
            NSApp.mainMenu = MainMenuBuilder.build()
            if config.smoke {
                // Smoke must never hang on a bad invocation.
                print("SMOKE FAIL:\n  --smoke requires --project, --port, and --hive")
                exit(1)
            }
            // Dock click / bare CLI launch: project-neutral home, never cwd data.
            showPlaceholderWindow()
            return
        }

        let displayName = (projectDirectory as NSString).lastPathComponent
        let state = ProjectState(projectID: ProjectID(projectDirectory), displayName: displayName)
        let controller = ProjectWindowController(
            state: state, attentionCenter: attentionCenter,
            projectDirectory: projectDirectory, hivePath: hivePath,
            daemonPort: daemonPort, orchestrator: config.orchestrator,
            orchestratorSession: config.orchestratorSession)
        self.controller = controller
        NSApp.mainMenu = MainMenuBuilder.build(paneTarget: controller)

        projectSwitcher.register(state: state) { [weak controller] in
            controller?.window?.makeKeyAndOrderFront(nil)
        }
        attentionCenter.activateHandler = { [weak controller] _, paneID in
            controller?.window?.makeKeyAndOrderFront(nil)
            controller?.dispatch(.focusPane(paneID))
        }

        controller.onWindowWillClose = { [weak self] in
            self?.retireFeed()
        }
        controller.bootstrapOrchestrator()
        startFeed()

        if config.smoke {
            let runner = SmokeRunner(controller: controller, config: config)
            smokeRunner = runner
            controller.window?.layoutIfNeeded()
            runner.run() // exits the process 0/1
        } else {
            controller.showWindow(nil)
            controller.commitInitialGeometry()
            NSApp.activate(ignoringOtherApps: true)
            controller.window?.makeKeyAndOrderFront(nil)
        }
    }

    /// The feed is a long-lived subprocess printing NDJSON snapshots; while it
    /// runs, the daemon knows a workspace is attached and stops opening
    /// external terminal windows. It dies with the app (`retireFeed()` below).
    private func startFeed() {
        guard let invocation = config.feedInvocation else { return }
        let feed = FeedClient(executable: invocation.executable, arguments: invocation.arguments)
        feed.onSnapshot = { [weak self] agents in
            self?.feedRestartDelay = 1
            self?.controller?.applyFeed(agents)
        }
        feed.onAutonomy = { [weak self] autonomy in
            self?.currentAutonomy = autonomy
        }
        feed.onError = { message in
            NSLog("workspace-feed error: %@", message)
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

    /// A feed that exited is an event, not the state "no workspace is present".
    ///
    /// The feed is an ordinary child process: it can be killed (a stray
    /// `pkill -f workspace-feed` aimed at someone else's test run matches it
    /// exactly), crash, or be dropped by a daemon restart. It used to stay
    /// dead, and the app went on sitting there — attached, visible, panes
    /// live — while the daemon watched the lease lapse, concluded nobody was
    /// watching, and reopened external Terminal.app windows over those panes.
    /// So the live app restarts its own feed.
    ///
    /// The fallback survives because the app is the supervisor: a crashed or
    /// force-quit app has nobody left to restart the feed, its lease lapses on
    /// the TTL, and the daemon goes back to external viewers — which is the
    /// whole reason presence is a lease. Only a *live* app reclaims it.
    private func scheduleFeedRestart() {
        guard !feedRetired, config.feedInvocation != nil else { return }
        let delay = feedRestartDelay
        feedRestartDelay = min(feedRestartDelay * 2, Self.feedRestartCeiling)
        NSLog("restarting workspace-feed in %.0fs", delay)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.feedRetired else { return }
            self.startFeed()
        }
    }

    /// Stop the feed and keep it stopped: the workspace is going away, so the
    /// daemon should get its external viewers back.
    private func retireFeed() {
        feedRetired = true
        feedClient?.stop()
    }

    // MARK: Writer autonomy (Agents menu)

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
        guard let hivePath = config.hivePath, let port = config.port else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: hivePath)
        process.arguments = ["autonomy", mode, "--port", String(port)]
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

    @objc func showAttentionPanel(_ sender: Any?) {
        attentionCenter.showPanel()
    }

    @objc func showProjectSwitcher(_ sender: Any?) {
        projectSwitcher.showPanel()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // One launch invocation == one project window. Once it closes there is
        // nothing left to show, and quitting tears down the feed (so the
        // daemon resumes opening external terminals) and detaches the tmux
        // clients. Agents keep running either way — they live in daemon-owned
        // tmux sessions, never in this process.
        true
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            controller?.window?.makeKeyAndOrderFront(nil)
            placeholderWindow?.makeKeyAndOrderFront(nil)
        }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        retireFeed()
        controller?.terminateAllTerminals()
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

        let body = NSTextField(wrappingLabelWithString:
            "No project is open.\n\nRun `hive` from a project directory to open it here. New project? Run `hive init` there first.")
        body.font = Theme.bodyFont
        body.textColor = .secondaryLabelColor
        body.alignment = .center

        let stack = NSStackView(views: [title, body])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 30, left: 30, bottom: 30, right: 30)
        window.contentView = stack

        placeholderWindow = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
