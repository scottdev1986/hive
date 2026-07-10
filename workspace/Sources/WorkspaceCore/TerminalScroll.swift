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

/// A normalized terminal scroll gesture. The AppKit terminal host translates
/// this into tmux copy-mode commands for panes attached to tmux sessions.
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
