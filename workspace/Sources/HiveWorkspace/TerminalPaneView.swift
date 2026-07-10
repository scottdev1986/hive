import AppKit
import SwiftTerm
import WorkspaceCore

/// Serializes and coalesces tmux copy-mode commands. Trackpads can emit many
/// events while one tmux process is running; adjacent events in the same
/// direction become one command instead of an unbounded subprocess queue.
private final class TmuxScrollController: @unchecked Sendable {
    private let session: String
    private let queue = DispatchQueue(label: "dev.hive.workspace.tmux-scroll", qos: .userInteractive)
    private let lock = NSLock()
    private var pending: [TerminalScrollRequest] = []
    private var workerScheduled = false

    init(session: String) {
        self.session = session
    }

    func submit(_ request: TerminalScrollRequest) {
        lock.lock()
        if let last = pending.last, last.direction == request.direction {
            pending[pending.count - 1] = TerminalScrollRequest(
                direction: request.direction,
                lineCount: last.lineCount + request.lineCount)
        } else {
            pending.append(request)
        }
        let shouldSchedule = !workerScheduled
        workerScheduled = true
        lock.unlock()

        if shouldSchedule {
            queue.async { [weak self] in self?.drain() }
        }
    }

    private func drain() {
        while let request = nextRequest() {
            let target = "=\(session):"
            if request.direction == .up {
                runTmux(["copy-mode", "-e", "-t", target])
            }
            runTmux([
                "send-keys", "-X", "-N", String(request.lineCount),
                "-t", target,
                request.direction == .up ? "scroll-up" : "scroll-down",
            ])
        }
    }

    private func nextRequest() -> TerminalScrollRequest? {
        lock.lock()
        defer { lock.unlock() }
        guard !pending.isEmpty else {
            workerScheduled = false
            return nil
        }
        return pending.removeFirst()
    }

    private func runTmux(_ arguments: [String]) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        let command = (["exec", "tmux"] + arguments.map(shellQuoted)).joined(separator: " ")
        process.arguments = ["-lc", command]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            // A vanished session or unavailable tmux only makes this gesture
            // a no-op; the feed owns honest disconnected-state reporting.
        }
    }
}

/// A pane's content: a real terminal (SwiftTerm's `LocalProcessTerminalView`)
/// running either the orchestrator TUI (`hive claude`) or a `tmux
/// attach-session` client for one agent. Hive never rolls its own renderer —
/// the native claude/codex TUIs draw themselves here, and typing goes straight
/// to the pty.
///
/// The child is always `/bin/zsh -lc "exec …"`: a login shell so the user's
/// PATH (where the real `claude` CLI and tmux live) resolves, exec so the
/// interesting process owns the pty directly.
final class TerminalPaneView: NSView, LocalProcessTerminalViewDelegate {

    let terminal = LocalProcessTerminalView(frame: .zero)
    private let tmuxScroller: TmuxScrollController?
    private var scrollMonitor: Any?

    private var pendingLaunch: (command: String, workingDirectory: String)?
    private(set) var childRunning = false
    var onChildExit: ((Int32?) -> Void)?

    init(tmuxSession: String? = nil, allowsMouseReporting: Bool = true) {
        tmuxScroller = tmuxSession.map(TmuxScrollController.init)
        super.init(frame: .zero)
        terminal.allowMouseReporting = allowsMouseReporting
        terminal.processDelegate = self
        terminal.translatesAutoresizingMaskIntoConstraints = false
        addSubview(terminal)
        NSLayoutConstraint.activate([
            terminal.topAnchor.constraint(equalTo: topAnchor),
            terminal.leadingAnchor.constraint(equalTo: leadingAnchor),
            terminal.trailingAnchor.constraint(equalTo: trailingAnchor),
            terminal.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    deinit {
        if let scrollMonitor { NSEvent.removeMonitor(scrollMonitor) }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let scrollMonitor {
            NSEvent.removeMonitor(scrollMonitor)
            self.scrollMonitor = nil
        }
        guard window != nil, tmuxScroller != nil else { return }
        scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            guard let self, event.window === self.window,
                  self.bounds.contains(self.convert(event.locationInWindow, from: nil)),
                  let tmuxScroller = self.tmuxScroller,
                  let request = TerminalScrollRequest(
                    deltaY: event.scrollingDeltaY,
                    visibleRows: self.terminal.getTerminal().rows)
            else { return event }
            tmuxScroller.submit(request)
            return nil
        }
    }

    // MARK: Child process lifecycle

    /// Schedules the child; the actual spawn happens on the first
    /// `commitCellGeometry()` with real bounds, so the pty is born with its
    /// settled size instead of 0×0 (tmux clients resent that).
    func schedule(command: String, workingDirectory: String) {
        pendingLaunch = (command, workingDirectory)
    }

    /// Called exactly once per settled layout change. Converts the commit
    /// into the deferred spawn; live resizes are handled by SwiftTerm's own
    /// frame-driven winsize updates.
    func commitCellGeometry() {
        guard let launch = pendingLaunch, bounds.width > 40, bounds.height > 40 else { return }
        pendingLaunch = nil
        childRunning = true
        layoutSubtreeIfNeeded()
        // SwiftTerm supplies TERM/COLORTERM/LANG/HOME/USER. PATH is inherited
        // too: the login shell prepends the user's own PATH anyway, and this
        // keeps tmux findable when the app was launched from a shell (CI).
        var environment = Terminal.getEnvironmentVariables(termName: "xterm-256color")
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            environment.append("PATH=\(path)")
        }
        terminal.startProcess(
            executable: "/bin/zsh",
            args: ["-lc", launch.command],
            environment: environment,
            execName: nil,
            currentDirectory: launch.workingDirectory)
    }

    /// SIGTERMs the child — for agent panes that is the `tmux attach` client,
    /// which detaches. NEVER `tmux kill-session`: closing a viewer must never
    /// kill an agent.
    func terminateChild() {
        pendingLaunch = nil
        guard childRunning else { return }
        terminal.terminate()
    }

    func focusTerminal() {
        window?.makeFirstResponder(terminal)
    }

    // MARK: Smoke introspection

    /// The visible screen contents (no scrollback), newline-joined.
    var visibleText: String {
        let term = terminal.getTerminal()
        return (0..<term.rows)
            .compactMap { term.getLine(row: $0)?.translateToString(trimRight: true) }
            .joined(separator: "\n")
    }

    /// Types into the pty exactly as the keyboard would.
    func send(text: String) {
        terminal.send(txt: text)
    }

    // MARK: LocalProcessTerminalViewDelegate

    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}

    func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}

    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    func processTerminated(source: TerminalView, exitCode: Int32?) {
        childRunning = false
        onChildExit?(exitCode)
    }
}

/// Single-quotes a string for embedding in a `zsh -c` command line.
func shellQuoted(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}
