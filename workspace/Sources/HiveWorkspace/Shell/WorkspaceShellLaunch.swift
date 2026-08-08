// WorkspaceShellLaunch.swift The development hook: `--workspace-shell-live` at launch swaps the pane-era app for the new native shell against the running daemon. The parsing lives here — inside the shell's own module — so the pane-era launch path never learns the flag exists; WorkspaceLaunch holds the one branch, and it goes away when the new shell becomes the default launch. The frozen-corpus counterpart is a QA build's `--workspace-shell <dir>`: nothing here parses it, and the loader arrives already built as `fixtureState`.

import AppKit
import WorkspaceCore

struct WorkspaceShellLaunch {
    /// The frozen-corpus loader when a QA build selected fixtures, nil for the live daemon-backed launch. The shipped binary installs no QA hook, so this is always nil there and the shell is always live.
    let fixtureState: FixtureShellLoader?
    /// Which corpus row every wired screen renders. A development affordance for looking at the honest non-current states; invalid values fall back to current rather than guessing a state.
    let scenario: ProjectionAvailability
    let proofMode: Bool
    let proofMutation: String?
    /// `--workspace-shell-fullscreen`: enter fullscreen once the window is on screen. The screenshot tour asks for this so its captures hold no title bar or toolbar — chrome repaints when the window gains or loses focus, and a capture without chrome cannot record that as a change in the screen. Only a launch that passes the flag is affected.
    let fullscreen: Bool

    static let liveFlag = "--workspace-shell-live"
    static let fullscreenFlag = "--workspace-shell-fullscreen"

    /// Live and fixtures stay mutually distinguishable: an invocation that asks for both gets the live daemon, never a silent fixture fallback.
    var isLive: Bool { fixtureState == nil }

    init?(arguments: [String], fixtureState: FixtureShellLoader?) {
        var live = false
        var fullscreen = false
        for argument in arguments {
            if argument == Self.liveFlag {
                live = true
            } else if argument == Self.fullscreenFlag {
                fullscreen = true
            }
        }
        guard live || fixtureState != nil else { return nil }
        self.fixtureState = live ? nil : fixtureState
        self.fullscreen = fullscreen
        let environment = ProcessInfo.processInfo.environment
        scenario = environment["HIVE_SHELL_SCENARIO"]
            .flatMap(ProjectionAvailability.init(rawValue:)) ?? .current
        proofMode = environment["HIVE_SHELL_PROOF"] == "1"
        proofMutation = environment["HIVE_SHELL_PROOF_MUTATE"]
    }
}
