import AppKit
import SwiftTerm
import WorkspaceCore

/// SwiftTerm 1.11.2 misencodes no-button SGR motion as a button release.
/// Drop that one packet at the PTY boundary; clicks, drags, and wheels pass
/// through byte-for-byte. Hover highlighting is optional; committing is not.
private final class WorkspaceTerminalView: LocalProcessTerminalView {
    var onComposerInput: ((ComposerInputAction) -> Void)?

    override func paste(_ sender: Any) {
        onComposerInput?(.editing)
        super.paste(sender)
    }

    override func send(source: TerminalView, data: ArraySlice<UInt8>) {
        if case .anyEvent = source.getTerminal().mouseMode,
           isMalformedNoButtonMotion(Array(data)) {
            return
        }
        super.send(source: source, data: data)
    }
}

/// Serializes and coalesces tmux copy-mode commands for panes where Hive
/// intentionally suppresses terminal mouse reporting. Trackpads can emit many
/// events while one tmux process is running; adjacent events in the same
/// direction become one command instead of an unbounded subprocess queue.
private final class TmuxScrollController: @unchecked Sendable {
    private let session: String
    private let socket: String?
    private let queue = DispatchQueue(label: "dev.hive.workspace.tmux-scroll", qos: .userInteractive)
    private let lock = NSLock()
    private var pending: [TerminalScrollRequest] = []
    private var workerScheduled = false

    init(session: String, socket: String?) {
        self.session = session
        self.socket = socket
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
        let socketArguments = socket.map { ["-L", $0] } ?? []
        let command = (["exec", "tmux"] + socketArguments + arguments)
            .map(shellQuoted).joined(separator: " ")
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
/// running either the selected orchestrator TUI or a `tmux
/// attach-session` client for one agent. Hive never rolls its own renderer —
/// the native claude/codex TUIs draw themselves here, and typing goes straight
/// to the pty.
///
/// The child is always `/bin/zsh -lc "exec …"`: a login shell so the user's
/// PATH (where the real `claude` CLI and tmux live) resolves, exec so the
/// interesting process owns the pty directly.
final class TerminalPaneView: NSView, LocalProcessTerminalViewDelegate {

    let terminal: LocalProcessTerminalView = WorkspaceTerminalView(frame: .zero)
    private let tmuxScroller: TmuxScrollController?
    private let forwardsScrollWheel: Bool
    private var scrollMonitor: Any?
    private var keyMonitor: Any?

    private var pendingLaunch: (command: String, workingDirectory: String)?
    private(set) var childRunning = false
    var onChildExit: ((Int32?) -> Void)?
    var onComposerInput: ((ComposerInputAction) -> Void)? {
        didSet {
            (terminal as? WorkspaceTerminalView)?.onComposerInput = onComposerInput
        }
    }

    init(tmuxSession: String? = nil, tmuxSocket: String? = nil,
         allowsMouseReporting: Bool = true) {
        tmuxScroller = tmuxSession.map { TmuxScrollController(session: $0, socket: tmuxSocket) }
        forwardsScrollWheel = allowsMouseReporting
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
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
    }

    override func layout() {
        super.layout()
        startPendingChildIfGeometryReady()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let scrollMonitor {
            NSEvent.removeMonitor(scrollMonitor)
            self.scrollMonitor = nil
        }
        if let keyMonitor {
            NSEvent.removeMonitor(keyMonitor)
            self.keyMonitor = nil
        }
        if window != nil {
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, event.window === self.window,
                      let responder = self.window?.firstResponder as? NSView,
                      responder === self.terminal || responder.isDescendant(of: self.terminal)
                else { return event }
                let action = classifyComposerInput(
                    characters: event.charactersIgnoringModifiers ?? event.characters ?? "",
                    command: event.modifierFlags.contains(.command),
                    control: event.modifierFlags.contains(.control))
                if action == .editing {
                    self.onComposerInput?(action)
                } else if action == .submitted || action == .cancelled {
                    DispatchQueue.main.async { [weak self] in
                        self?.onComposerInput?(action)
                    }
                }
                return event
            }
        }
        guard window != nil, tmuxScroller != nil else { return }
        scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            guard let self, event.window === self.window,
                  self.bounds.contains(self.convert(event.locationInWindow, from: nil)),
                  self.submitScroll(event)
            else { return event }
            return nil
        }
    }

    @discardableResult
    func submitScroll(_ event: NSEvent, locationInTerminal: CGPoint? = nil) -> Bool {
        guard event.scrollingDeltaY != 0 else { return false }
        if forwardsScrollWheel {
            let term = terminal.getTerminal()
            let point = locationInTerminal
                ?? terminal.convert(event.locationInWindow, from: nil)
            let column = min(max(Int(point.x / max(terminal.bounds.width, 1)
                                     * CGFloat(term.cols)) + 1, 1), term.cols)
            let row = min(max(term.rows - Int(point.y / max(terminal.bounds.height, 1)
                                              * CGFloat(term.rows)), 1), term.rows)
            let button = event.scrollingDeltaY > 0 ? 64 : 65
            terminal.send(txt: "\u{1b}[<\(button);\(column);\(row)M")
            return true
        }
        return submitScroll(deltaY: event.scrollingDeltaY)
    }

    @discardableResult
    func submitScroll(deltaY: CGFloat) -> Bool {
        guard let tmuxScroller,
              let request = TerminalScrollRequest(
                deltaY: deltaY,
                visibleRows: terminal.getTerminal().rows)
        else { return false }
        tmuxScroller.submit(request)
        return true
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
        layoutSubtreeIfNeeded()
        startPendingChildIfGeometryReady()
    }

    private func startPendingChildIfGeometryReady() {
        guard let launch = pendingLaunch, bounds.width > 40, bounds.height > 40 else { return }
        pendingLaunch = nil
        childRunning = true
        // SwiftTerm supplies TERM/COLORTERM/LANG/HOME/USER. Preserve the two
        // caller values the root also needs: PATH finds tmux/providers, while
        // TMPDIR keeps Codex's socket out of the /tmp symlink fallback.
        let environment = terminalProcessEnvironment(
            base: Terminal.getEnvironmentVariables(termName: "xterm-256color"),
            inherited: ProcessInfo.processInfo.environment)
        terminal.startProcess(
            executable: "/bin/zsh",
            args: ["-lc", launch.command],
            environment: environment,
            execName: nil,
            currentDirectory: launch.workingDirectory)
    }

    /// SIGTERMs the child — for agent panes that is the `tmux attach` client,
    /// which detaches. NEVER `tmux kill-session`: closing a client must never
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

private func isMouseWheelPacket(_ bytes: [UInt8]) -> Bool {
    guard bytes.count >= 8, bytes[0...2] == [0x1b, 0x5b, 0x3c],
          let flagEnd = bytes[3...].firstIndex(of: 0x3b),
          let flags = Int(String(decoding: bytes[3..<flagEnd], as: UTF8.self))
    else { return false }
    return flags & 64 != 0
}

/// SwiftTerm deliberately receives a bounded environment. PATH selects the
/// installed provider CLIs; TMPDIR is equally load-bearing on macOS because
/// Codex binds its instance-scoped app-server socket in the private per-user
/// temporary directory. Omitting it makes Node fall back to `/tmp`, a symlink
/// that Codex rejects as a socket parent.
func terminalProcessEnvironment(
    base: [String],
    inherited: [String: String]
) -> [String] {
    var environment = base
    for key in ["PATH", "TMPDIR"] {
        if let value = inherited[key] {
            environment.append("\(key)=\(value)")
        }
    }
    return environment
}

/// Single-quotes a string for embedding in a `zsh -c` command line.
func shellQuoted(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}
