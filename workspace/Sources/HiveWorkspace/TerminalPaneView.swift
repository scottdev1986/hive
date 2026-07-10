import AppKit
import SwiftTerm
import WorkspaceCore

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

    private var pendingLaunch: (command: String, workingDirectory: String)?
    private(set) var childRunning = false
    var onChildExit: ((Int32?) -> Void)?

    init() {
        super.init(frame: .zero)
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
