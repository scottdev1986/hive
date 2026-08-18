// HiveWorkspaceQAEntryPoint.swift
//
// The QA harness executable: the same app plus the two pieces the shipped
// binary must not carry. `make workspace/.build/debug/HiveWorkspaceDev` stages
// this one, so the evidence flows keep launching the binary they always did
// while the product loses the harness.

import AppKit
import HiveWorkspace
import WorkspaceQAKit

WorkspaceLaunch.run(qa: WorkspaceQAHooks(
    fixtureShell: { arguments in
        ShellFixtureStore.launchDirectory(arguments: arguments).map { directory in
            { scenario in try ShellFixtureStore(directory: directory).loadState(scenario: scenario) }
        }
    },
    smoke: { surface, config in
        let runner = SmokeRunner(controller: surface, config: config)
        if config.smoke {
            runner.run() // exits the process 0/1
            return
        }
        // A normal launch the harness still wants to drive: the window is up
        // and interactive, and these runs measure it after it settles.
        let environment = ProcessInfo.processInfo.environment
        guard environment["HIVE_SMOKE_SESSIOND_LIVE_RESIZE_INPUT"] == "1"
            || SmokeRunner.productionPaneAgent(environment: environment) != nil
            || SmokeRunner.a4Proof(environment: environment) != nil else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { runner.run() }
    }))
