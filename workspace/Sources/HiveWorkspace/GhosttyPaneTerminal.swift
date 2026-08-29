import AppKit
import HiveTerminalKit
import WorkspaceCore

/// One Ghostty-owned terminal for one Live Run session. The surface is created with the pane and freed with it. Selection hide/show does not destroy the child.
final class GhosttyPaneTerminal {
    let agentName: String
    let paneLocator: AgentSessionLocator
    private let launch: TerminalLaunch
    private let viewerId: String

    private(set) var view: HiveTerminalView?

    init(session: LiveRunSessionSummary, config: LaunchConfig) {
        agentName = session.name
        paneLocator = session.locator ?? AgentSessionLocator(
            instanceId: config.instanceID ?? "",
            subject: AgentSessionSubject(
                kind: session.isQueen ? "root" : "agent",
                agentId: session.agentID
            ),
            generation: 1,
            sessionId: session.id,
            hostKind: "ghostty",
            engineBuildId: nil
        )
        viewerId = "workspace-pane-\(session.name)"
        if let spec = session.terminalLaunch {
            launch = spec.launch
        } else {
            launch = TerminalLaunch.loginShell(
                workingDirectory: config.projectDirectory ?? FileManager.default.currentDirectoryPath
            )
        }
    }

    func makeView() throws -> HiveTerminalView {
        if let view { return view }
        let terminal = try HiveTerminalView(frame: .zero, launch: launch, viewerId: viewerId)
        terminal.autoresizingMask = [.width, .height]
        view = terminal
        return terminal
    }

    func start() {}

    func hide() {
        view?.isHidden = true
    }

    func free() {
        view?.userClose()
        view?.removeFromSuperview()
        view = nil
    }
}
