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
    /// Restarts are capped so a feed that can never run — a missing binary, a
    /// daemon that is gone for good — stops thrashing and says so instead.
    private static let feedRestartLimit = 5
    private var feedRestartsLeft = AppDelegate.feedRestartLimit
    /// How long a quit waits for `hive stop` before going ahead without it.
    private static let stopDeadline: TimeInterval = 5
    /// Set once the app has decided the feed should stay dead (window closing,
    /// app quitting), so a restart already in flight cannot resurrect it.
    private var feedRetired = false
    /// The unrecoverable-feed alert is shown once, not once per retry.
    private var feedFailureAnnounced = false
    /// Whichever menu is tracking right now, if any. An open NSMenu runs a
    /// nested tracking loop and belongs to no window, so closing the windows
    /// cannot dismiss it — the instance has to cancel it by hand on the way
    /// out. Weak, and per-instance: nothing here outlives this process.
    private weak var trackingMenu: NSMenu?

    init(config: LaunchConfig) {
        self.config = config
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NotificationCenter.default.addObserver(
            forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main
        ) { [weak self] note in
            self?.trackingMenu = note.object as? NSMenu
        }

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
            if config.settings { showSettings(nil) }
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

        controller.onWindowWillClose = { [weak self, weak controller] in
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
                controller.commitInitialGeometry()
                NSApp.activate(ignoringOtherApps: true)
                controller.window?.makeKeyAndOrderFront(nil)
            }
            controller.window?.layoutIfNeeded()
            runner.run() // exits the process 0/1
        } else {
            controller.showWindow(nil)
            controller.commitInitialGeometry()
            NSApp.activate(ignoringOtherApps: true)
            controller.window?.makeKeyAndOrderFront(nil)
            if config.settings { showSettings(nil) }
        }
    }

    /// The feed is a long-lived subprocess printing NDJSON snapshots; while it
    /// runs, the daemon knows a workspace is attached and stops opening
    /// external terminal windows. It dies with the app (`retireFeed()` below).
    private func startFeed() {
        guard let invocation = config.feedInvocation else { return }
        let feed = FeedClient(executable: invocation.executable, arguments: invocation.arguments)
        feed.onSnapshot = { [weak self] agents, orchestrator in
            // A snapshot is the feed proving it works: the budget is for a feed
            // that cannot run, not for one that was killed five times.
            self?.feedRestartDelay = 1
            self?.feedRestartsLeft = AppDelegate.feedRestartLimit
            self?.controller?.applyFeed(agents, orchestrator: orchestrator)
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
    /// This class used to carry the opposite contract — "there is deliberately
    /// no auto-restart: if the feed dies the workspace marks agent panes
    /// disconnected and the user relaunches via `hive`" — and it failed in the
    /// field on 2026-07-12. An agent verifying UI work ran
    /// `pkill -9 -f "workspace-feed --port 4483"` against the *user's real
    /// daemon*; his app's feed has exactly that command line, so it died. The
    /// app went on sitting there, attached and normal-looking, while the daemon
    /// watched the lease lapse, concluded nobody was watching, and opened
    /// Terminal.app windows over live panes for 39 minutes. The old contract
    /// outsourced recovery to a human who was never told he had to recover
    /// anything: it required him to notice a failure that is, by construction,
    /// invisible — a blind workspace looks exactly like a healthy one. Do not
    /// restore it out of respect for the comment that used to be here. Hive
    /// heals itself, and when it cannot, it says so.
    ///
    /// The fallback survives because the app is the supervisor: a crashed or
    /// force-quit app has nobody left to restart the feed, its lease lapses on
    /// the TTL, and the daemon goes back to external viewers — which is the
    /// whole reason presence is a lease. Only a *live* app reclaims it.
    private func scheduleFeedRestart() {
        guard !feedRetired, config.feedInvocation != nil else { return }
        guard feedRestartsLeft > 0 else {
            announceFeedFailure()
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

    /// Healing quietly is fine; failing quietly is what caused the incident.
    /// A feed we cannot restart means the app is blind — agent status is frozen
    /// and the daemon is about to start opening its own windows — and the user
    /// must not have to deduce that from a stray Terminal window half an hour
    /// later. So say it, unmissably, once.
    private func announceFeedFailure() {
        guard !feedFailureAnnounced, !config.smoke else { return }
        feedFailureAnnounced = true
        NSLog("workspace-feed could not be restarted; the workspace is blind")
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Hive lost its status feed"
        alert.informativeText = """
            This workspace can no longer see your agents: their status is frozen \
            and Hive will start opening separate Terminal windows for new agents.

            Your agents are still running — they live in the daemon's tmux \
            sessions, not in this app. Quit and relaunch the workspace with \
            `hive` to reconnect.
            """
        alert.addButton(withTitle: "OK")
        alert.runModal()
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
        closeOwnedSurfaces()
        retireFeed()
        controller?.terminateAllTerminals()
        stopSession()
    }

    /// Quitting the workspace ends the Hive session: `hive stop` is the daemon's
    /// own shutdown — it stops every live agent and then the daemon itself — so
    /// no agent, and no daemon, outlives the window that was showing them.
    ///
    /// Bounded, and never a dialog. The user asked for immediate: nothing here
    /// prompts, and the wait is capped, because a quit that hangs on a daemon
    /// which cannot answer is a worse failure than a quit that leaves the last
    /// second of shutdown to a command that goes on running without us (the
    /// child outlives this process — the wait is to observe it, not to power
    /// it).
    private func stopSession() {
        guard let hivePath = config.hivePath, !config.smoke else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: hivePath)
        process.arguments = ["stop"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.standardError
        do {
            try process.run()
        } catch {
            NSLog("could not run hive stop: %@", error.localizedDescription)
            return
        }
        let deadline = Date().addingTimeInterval(Self.stopDeadline)
        while process.isRunning, Date() < deadline {
            usleep(50_000)
        }
        if process.isRunning {
            NSLog("hive stop is still running after %.0fs; quitting anyway", Self.stopDeadline)
        } else if process.terminationStatus != 0 {
            NSLog("hive stop failed (exit %d)", process.terminationStatus)
        }
    }

    /// Take down every surface this instance owns. Menus first: an open menu is
    /// running a nested tracking loop that no window owns, so closing windows
    /// alone leaves it on screen. Then the windows — the project or placeholder
    /// window, Settings, and the attention/project panels are all this
    /// process's windows, so `NSApp.windows` is exactly this instance's surface
    /// set and nothing else's.
    private func closeOwnedSurfaces(except keep: NSWindow? = nil) {
        trackingMenu?.cancelTrackingWithoutAnimation()
        NSApp.mainMenu?.cancelTrackingWithoutAnimation()
        for window in NSApp.windows where window !== keep {
            // A sheet outlives the window it hangs on unless it is ended first
            // (a failed agent kill puts one there), and it would hold the quit.
            for sheet in window.sheets {
                window.endSheet(sheet)
            }
            window.close()
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
        window.delegate = self
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
