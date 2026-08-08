// WorkspaceLaunch.swift The launch sequence both executables run: the shipped
// app and the QA harness. Everything the harness adds arrives through
// WorkspaceQAHooks, and the shipped executable installs none of it — which is
// the whole reason the harness is a separate module. A hook that is nil is not
// a disabled feature; the code behind it is not in the binary at all.

import AppKit
import Darwin
import WorkspaceCore

/// Builds the shell's render state from a frozen corpus, for the availability
/// row the launch selected.
public typealias FixtureShellLoader = (ProjectionAvailability) throws -> ShellState

/// Where a QA build attaches to the app. The shipped executable passes an empty
/// value.
public struct WorkspaceQAHooks {
    /// Resolves a frozen-corpus shell launch out of the command line, or nil
    /// when these arguments do not select one. Only a QA build knows the flag
    /// that selects it, so the shipped app cannot be talked into fixtures.
    public var fixtureShell: ((_ arguments: [String]) -> FixtureShellLoader?)?

    /// Hands the launched project window to the harness. Under `--smoke` the
    /// app never becomes interactive and the harness exits the process; on a
    /// normal launch the harness reads its own environment to decide whether to
    /// drive the window at all.
    public var smoke: ((_ surface: any SmokeSurface, _ config: LaunchConfig) -> Void)?

    public init(
        fixtureShell: ((_ arguments: [String]) -> FixtureShellLoader?)? = nil,
        smoke: ((_ surface: any SmokeSurface, _ config: LaunchConfig) -> Void)? = nil
    ) {
        self.fixtureShell = fixtureShell
        self.smoke = smoke
    }
}

public enum WorkspaceLaunch {
    /// The CLI launches the app with backend-issued project identity plus
    /// --project <abs dir> --port <daemon port> --hive <abs hive binary>. `--smoke`
    /// runs the headless end-to-end checks and exits 0/1; `--feed <binary>`
    /// overrides the feed subprocess for that harness.
    public static func run(qa: WorkspaceQAHooks = WorkspaceQAHooks()) {
        // A helper can exit between an isRunning check and a pipe write. Make
        // that ordinary race throw EPIPE instead of terminating the Workspace.
        signal(SIGPIPE, SIG_IGN)

        let arguments = Array(CommandLine.arguments.dropFirst())
        let config = LaunchConfig.parse(arguments)
        let shellLaunch = WorkspaceShellLaunch(
            arguments: arguments,
            fixtureState: qa.fixtureShell.flatMap { $0(arguments) })

        let app = NSApplication.shared
        if let appearance = config.appearance {
            app.appearance = NSAppearance(
                named: appearance == "light" ? .aqua : .darkAqua)
        }
        let delegate: NSApplicationDelegate
        if let shellLaunch {
            delegate = WorkspaceShellDelegate(config: config, launch: shellLaunch)
        } else {
            delegate = AppDelegate(config: config, qa: qa)
        }
        app.delegate = delegate
        let smokeVisible = ProcessInfo.processInfo.environment["HIVE_SMOKE_VISIBLE"] == "1"
        let backgroundOnly = (config.smoke && !smokeVisible) || shellLaunch?.proofMode == true
        app.setActivationPolicy(backgroundOnly ? .accessory : .regular)
        app.run()
    }
}
