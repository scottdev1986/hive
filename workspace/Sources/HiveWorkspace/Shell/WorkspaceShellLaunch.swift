// WorkspaceShellLaunch.swift The launch configuration for the Workspace shell.
// The shipped app always uses the live daemon. A QA build may inject a frozen
// corpus loader selected by `--workspace-shell <dir>`; the shipped executable
// does not link that parser or loader.

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

    init(arguments: [String], fixtureState: FixtureShellLoader?) {
        var live = false
        var fullscreen = false
        for argument in arguments {
            if argument == Self.liveFlag {
                live = true
            } else if argument == Self.fullscreenFlag {
                fullscreen = true
            }
        }
        self.fixtureState = live ? nil : fixtureState
        self.fullscreen = fullscreen
        let environment = ProcessInfo.processInfo.environment
        scenario = environment["HIVE_SHELL_SCENARIO"]
            .flatMap(ProjectionAvailability.init(rawValue:)) ?? .current
        // HIVE_QA permits QA behavior; this selector only chooses the existing
        // headless fixture proof beneath that gate. It cannot expose QA alone.
        proofMode = environment["HIVE_QA"] == "1"
            && environment["HIVE_SHELL_PROOF"] == "1"
        proofMutation = environment["HIVE_SHELL_PROOF_MUTATE"]
    }
}
