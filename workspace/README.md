# Hive Workspace

The Swift/AppKit Workspace is one native Shell for observing and controlling a
Hive project. Its sidebar, menus, routes, and renderer share one declared-screen
registry. Screens without an honest daemon contract are absent rather than shown
as disabled placeholders.

Live Run hosts one `HiveTerminalView` backed by the selected agent-ui session.
The daemon owns each session; changing selection or leaving Live Run detaches the
viewer without terminating the session.

## Launch contract

The CLI launches the app with project and daemon identity:

```sh
open -a HiveWorkspace --args \
  --project <abs project dir> \
  --port <daemon port> \
  --instance-id <instance id> \
  --instance-home <abs instance home> \
  --hive <abs hive binary>
```

- `--project` identifies the project shown in the Shell.
- `--port`, `--instance-id`, and `--instance-home` identify the daemon instance.
- `--hive` is the exact Hive binary used for daemon reads and terminal attach.

The Shell is the only launch surface. Missing or invalid launch data produces a
visible Shell fault; it never opens the retained pane-era UI as a fallback.

The separate `HiveWorkspaceQA` executable adds frozen-corpus and smoke hooks.
The shipped executable does not link those hooks.

## Terminal lifecycle

1. The daemon asks `sessiond` to create an interactive zsh session.
2. Hive's agent-ui starts beneath that retained shell for the selected provider.
3. Live Run reads the exact session locator from the strict workspace feed.
4. The workbench attaches at most one Ghostty viewer to that generation.
5. Selection changes detach the prior viewer without killing either session.
6. Stopping the provider returns the same PTY to zsh; terminal termination is a
   separate explicit lifecycle action.

## Run and verify

`GhosttyKit.xcframework` and Gate 6's checkpoint fixtures are gitignored build
output. Materialize both from the shared, lock-validated native cache before
running SwiftPM; the command builds them with the existing native builder only
when that cache is absent or invalid. Do not commit either artifact.

```sh
scripts/native/stage-ghosttykit.sh
cd workspace
swift build
swift test
```

`make stage-ghosttykit` runs the same staging path. The staging command verifies
a host-usable macOS archive plus the exact Gate 6 corpus inputs after copying;
`--verify` checks an existing stage without changing it.

To exercise the frozen Shell proof through the built QA binary:

```sh
HIVE_SHELL_PROOF=1 .build/debug/HiveWorkspaceQA \
  --workspace-shell Tests/WorkspaceCoreTests/Fixtures
```

A complete run ends with `SHELL-PROOF-END screens=<count>`. Consumers must
require that terminator and compare its count with the emitted `SHELL-SCREEN`
lines; process exit alone is not proof that the run completed.

## Code layout

- `Sources/WorkspaceCore` owns typed projections, Shell routes, commands, state,
  and the declared-screen registry.
- `Sources/HiveWorkspace/Shell` owns the AppKit Shell, daemon gateways, and Live
  Run workbench.
- `HiveTerminalKit` provides the shared Ghostty renderer and session client.
- `WorkspaceQAKit` provides hooks linked only by `HiveWorkspaceQA`.

The pane-era AppDelegate, pane grid, project switcher, spatial navigation, and
standalone Settings code remain compiled and tested for a later coordinated
deletion. They are unreachable from both shipped and QA launch entry points.

## Keyboard map

| Command | Keys |
| --- | --- |
| Live Run | ⌘1 |
| Task Router | ⌘2 |
| Models & Quota | ⌘3 |
| Attach selected live terminal | Return |
| Enter full terminal | ⌃⌘F |
| Attention drawer | ⌥⌘A |
| Inspector | ⌥⌘I |
| Detach Workspace | ⌘Q |
