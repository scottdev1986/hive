import Foundation

/// What Ghostty should exec as the PTY child. Swift hosts the view; Ghostty owns the terminal.
public struct TerminalLaunch: Equatable, Sendable {
    public var workingDirectory: String
    public var command: String
    public var environment: [String: String]

    public init(
        workingDirectory: String,
        command: String = "/bin/zsh -l -i",
        environment: [String: String] = [:]
    ) {
        self.workingDirectory = workingDirectory
        self.command = command
        self.environment = environment
    }

    public static func loginShell(
        workingDirectory: String,
        environment: [String: String] = [:]
    ) -> TerminalLaunch {
        TerminalLaunch(
            workingDirectory: workingDirectory,
            command: "/bin/zsh -l -i",
            environment: environment
        )
    }
}

/// Daemon-prepared Ghostty exec spec from workspace-feed (`cwd`, `command`, `environment`).
public struct TerminalLaunchSpec: Equatable, Sendable, Codable {
    public var cwd: String
    public var command: String
    public var environment: [String: String]

    public init(cwd: String, command: String, environment: [String: String]) {
        self.cwd = cwd
        self.command = command
        self.environment = environment
    }

    public var launch: TerminalLaunch {
        TerminalLaunch(
            workingDirectory: cwd,
            command: command,
            environment: environment
        )
    }
}
