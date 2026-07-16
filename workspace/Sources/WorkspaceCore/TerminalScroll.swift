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
        return pane.attachmentIdentity?.tmuxSession
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

/// Identifies SwiftTerm's malformed SGR no-button motion packet. In all-motion
/// mode SwiftTerm emits `ESC[<32;x;ym`, which looks like a button release.
public func isMalformedNoButtonMotion(_ bytes: [UInt8]) -> Bool {
    guard bytes.count >= 8,
          bytes[0...2] == [0x1b, 0x5b, 0x3c],
          bytes.last == 0x6d,
          let flagEnd = bytes[3...].firstIndex(of: 0x3b),
          let flags = Int(String(decoding: bytes[3..<flagEnd], as: UTF8.self)),
          flags & 32 != 0, flags & 3 == 0
    else { return false }
    return true
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
