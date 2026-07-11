import CoreGraphics

/// Resolves the authoritative tmux session whose history backs a terminal
/// pane. Worker sessions arrive on the agent feed; the orchestrator session
/// is launch metadata because the feed intentionally describes workers only.
public func terminalScrollSession(
    for pane: PaneState,
    orchestratorSession: String?
) -> String? {
    switch pane.kind {
    case .orchestrator:
        return orchestratorSession
    case .agent:
        return pane.tmuxSession
    }
}

/// Whether wheel events for this pane should be forwarded to the terminal's
/// SGR mouse-reporting protocol rather than driven through legacy tmux
/// copy-mode commands. Both pane kinds attach to a session with tmux mouse
/// mode enabled server-wide (`set-option -g mouse on`) and both run
/// alt-screen TUIs, which copy-mode cannot scroll — so both forward.
public func terminalAllowsMouseReporting(for pane: PaneState) -> Bool {
    true
}

/// A normalized terminal scroll gesture. The AppKit terminal host translates
/// this into tmux copy-mode commands when terminal mouse reporting is disabled.
public struct TerminalScrollRequest: Equatable, Sendable {
    public enum Direction: Equatable, Sendable {
        case up
        case down
    }

    public let direction: Direction
    public let lineCount: Int

    public init?(deltaY: CGFloat, visibleRows: Int) {
        guard deltaY != 0 else { return nil }
        direction = deltaY > 0 ? .up : .down

        let magnitude = abs(deltaY)
        if magnitude > 9 {
            lineCount = max(visibleRows, 20)
        } else if magnitude > 5 {
            lineCount = 10
        } else if magnitude > 1 {
            lineCount = 3
        } else {
            lineCount = 1
        }
    }

    public init(direction: Direction, lineCount: Int) {
        self.direction = direction
        self.lineCount = max(1, lineCount)
    }
}
