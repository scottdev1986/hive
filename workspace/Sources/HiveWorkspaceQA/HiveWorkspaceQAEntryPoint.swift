// HiveWorkspaceQAEntryPoint.swift
//
// The QA harness executable: the same app plus the frozen-corpus shell loader
// the shipped binary must not carry. `make workspace/.build/debug/HiveWorkspaceDev`
// stages this one, so the evidence flows keep launching the binary they always
// did while the product loses the harness.

import HiveWorkspace
import WorkspaceQAKit

WorkspaceLaunch.run(qa: WorkspaceQAHooks(
    fixtureShell: { arguments in
        ShellFixtureStore.launchDirectory(arguments: arguments).map { directory in
            { scenario in try ShellFixtureStore(directory: directory).loadState(scenario: scenario) }
        }
    }))
