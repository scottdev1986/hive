import Foundation

/// The exact Hive instance whose daemon feed and tmux socket this window views.
/// A name or port alone is not identity: two HIVE_HOMEs may use the same agent
/// names, and a restarted daemon may reuse a port.
public struct WorkspaceInstanceIdentity: Equatable, Sendable {
    public let instanceID: String
    public let instanceHome: String
    public let daemonPort: Int
    public let tmuxSocket: String

    public init(instanceID: String, instanceHome: String, daemonPort: Int,
                tmuxSocket: String) {
        self.instanceID = instanceID
        self.instanceHome = instanceHome
        self.daemonPort = daemonPort
        self.tmuxSocket = tmuxSocket
    }
}

/// Everything that must still agree before a pane may reuse a tmux child.
/// Agent names are deliberately absent: they are presentation/routing labels,
/// not process identity. The provider conversation id (`toolSessionID`) is also
/// absent: it is telemetry/resume/attestation identity, and the Codex path never
/// binds it, so gating tmux viewing on it left Codex panes permanently closed.
/// This tuple — instance + agent UUID + process incarnation + tmux session —
/// already distinguishes cross-instance, reused-name, and process-replacement
/// cases exactly.
public struct PaneAttachmentIdentity: Equatable, Sendable {
    public let workspace: WorkspaceInstanceIdentity
    public let agentID: String
    public let processIncarnation: Int
    public let tmuxSession: String

    public init(workspace: WorkspaceInstanceIdentity, agentID: String,
                processIncarnation: Int, tmuxSession: String) {
        self.workspace = workspace
        self.agentID = agentID
        self.processIncarnation = processIncarnation
        self.tmuxSession = tmuxSession
    }
}

/// Pure pane-child lifecycle decision. The AppKit layer applies `recreate` by
/// detaching the old tmux client before it starts the exact new attachment.
public enum PaneAttachmentTransition: Equatable {
    case unchanged
    case recreate
    case disconnect

    public static func between(_ current: PaneAttachmentIdentity?,
                               _ desired: PaneAttachmentIdentity?) -> Self {
        switch (current, desired) {
        case (nil, nil):
            return .unchanged
        case (.some, nil):
            return .disconnect
        case (nil, .some):
            return .recreate
        case let (.some(current), .some(desired)):
            return current == desired ? .unchanged : .recreate
        }
    }
}
