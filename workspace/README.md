# Hive Workspace

The Swift/AppKit workspace window for one Hive project. The Queen and every
agent use the same terminal path: Hive creates an ordinary interactive login
shell, starts the selected provider TUI as its first command, and the Workspace
attaches a `HiveTerminalView` to that session through `sessiond`.

The pane layout and headers come from the `hive workspace-feed` NDJSON stream.
Terminal rendering, input, resizing, and scrollback stay in the shared
HiveTerminalKit/sessiond stack.

## Launch contract

The CLI launches the app; users do not need to open it directly:

```sh
open -a HiveWorkspace --args \
  --project <abs project dir> \
  --port <daemon port> \
  --instance-id <instance id> \
  --instance-home <abs instance home> \
  --hive <abs hive binary> \
  [--orchestrator claude|codex|grok]
```

- `--project` is the project window and the working directory for its shells.
- `--port`, `--instance-id`, and `--instance-home` identify the daemon instance.
- `--hive` is the exact Hive binary used for the feed and Queen supervisor.
- `--orchestrator` selects the Queen provider; the default is Claude.
- `--feed <binary>` is the process-boundary override used by tests.
- `--smoke` runs the headless Workspace checks.

A Dock launch without the complete contract shows the project-neutral home
window.

## Terminal lifecycle

Queen and agent panes differ only in the command and instructions supplied to
their shell:

1. The daemon asks `sessiond` to create the session.
2. The session starts `/bin/zsh -l -i`.
3. That shell runs the provider's normal CLI command.
4. The Workspace attaches the pane to the exact session locator from the feed.
5. Exiting the provider returns the same pane to an interactive zsh prompt.

Provider instructions are passed through the provider's own supported layer:
Claude uses `--append-system-prompt-file`, Codex uses an ephemeral profile with
`developer_instructions`, and Grok uses `--rules`.

Closing a pane detaches its view. It does not terminate the daemon-owned
session. Explicit Hive lifecycle operations own session termination and process
cleanup.

## Feed and pane reconciliation

`hive workspace-feed --port <n> ...` emits one JSON object per line. The app
uses each live agent's identity, status, display metadata, and exact `sessiond`
locator.

- A new live record creates and attaches one pane.
- A changed locator replaces the old attachment with the new generation.
- A closed or missing agent keeps its final status briefly, then its pane closes.
- A failed feed marks pane state untrusted; it never invents healthy state.

The Queen uses the same feed/locator contract as every agent, so renderer,
input, resize, scrollback, reconnect, and teardown behavior cannot diverge by
role.

## Run and verify

```sh
cd workspace
swift build
swift test
../scripts/b3-smoke.sh
```

The B3 smoke stands up the real `sessiond` substrate headlessly and verifies
create, attach, input, resize readiness, detach-without-kill, and clean
teardown.

## Code layout

- `Sources/WorkspaceCore` contains the feed contract, pane state reducer,
  layout tree, navigation, status, and commands.
- `Sources/HiveWorkspace` contains AppKit windows, feed wiring, pane chrome,
  and `HiveTerminalView` attachment.
- `HiveTerminalKit` provides the shared terminal renderer and session client.

## Keyboard map

| Command | Keys |
| --- | --- |
| Promote focused pane to master | ⌘↩ (or double-click pane header) |
| Return Queen to Master | ⇧⌘↩ |
| Focus Queen | ⌘0 |
| Move focus spatially | ⌥⌘←/→/↑/↓ |
| Acknowledge focused pane | ⇧⌘K |
| Close pane (detach, never kill) | ⇧⌘W |
| Attention queue | ⌥⌘A |
| Projects | ⇧⌘P |

Approve, deny, and message actions occur in the native provider TUI by typing
in its terminal pane.
