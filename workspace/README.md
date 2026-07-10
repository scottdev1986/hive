# Hive Workspace

The Swift/AppKit workspace window for one Hive project: the master pane is a
real terminal running the selected Claude or Codex orchestrator, every satellite pane
is a real terminal attached to one agent's daemon-owned tmux session, and the
pane set is driven by the `hive workspace-feed` NDJSON stream. Hive does not
roll its own renderer — SwiftTerm hosts the native claude/codex TUIs on real
ptys, and typing in a pane goes straight to them.

The earlier mock-driven UI prototype (fixture scripts, transcript renderer,
ANSI parser) is gone; its evidence write-up survives in
[docs/prototype-hypothesis-2-evidence.md](docs/prototype-hypothesis-2-evidence.md).

## Launch contract

The CLI launches the app; users never open it directly. `hive init` is the
headless onboarding command (profile, then daemon), while bare `hive` opens
this Workspace after the same session boundary:

```sh
open -a HiveWorkspace --args --project <abs project dir> --port <daemon port> --hive <abs hive binary> --orchestrator-session <tmux session> [--orchestrator claude|codex]
```

- `--project` one window per launch invocation, titled after the directory;
  it is also the cwd of every pane's shell.
- `--port` the local daemon's HTTP port, handed to the feed subprocess.
- `--hive` the hive binary; the master pane runs the private
  `<hive> workspace-orchestrator` boundary, while the feed
  runs `<hive> workspace-feed --port <port>`.
- `--orchestrator` selects Claude or Codex for the master pane; absent means
  Claude, preserving bare `hive` as the default Workspace entry.
- `--orchestrator-session` carries Hive's instance-scoped tmux identity into
  the app, so terminal features never have to duplicate its naming algorithm.
- `--feed <binary>` (hidden) overrides the feed executable — the
  process-boundary seam the smoke harness uses.
- `--smoke` headless end-to-end checks (see below).

Launched with no arguments (Dock click), the app shows a plain window
explaining to run `hive` from a project directory. No fixtures, ever.

## How panes work

- **Master** — `/bin/zsh -lc "exec '<hive>' workspace-orchestrator --tool
  <claude|codex> --port <n>"`. The private boundary starts the selected
  read-only orchestrator in its fixed tmux session. Public `hive claude` and
  `hive codex` first open Workspace through the shared session boundary;
  keeping those public commands out of the pane prevents recursive launches.
- **Satellites** — `/bin/zsh -lc "exec tmux attach-session -t '<session>'"`,
  one per live agent in the feed. Closing a pane SIGTERMs only the attach
  client; the agent and its session are never touched (`tmux kill-session`
  does not exist in this codebase on purpose). Login shells so the user's
  PATH (`claude`, `tmux`) resolves.
- The child is spawned on the first settled layout commit
  (`commitCellGeometry()`), so the pty is born with real dimensions.

### Feed → pane set

`hive workspace-feed --port <n>` prints one JSON object per line:
`{"v":1,"agents":[...]}` snapshots or `{"v":1,"error":"..."}`. The app decodes
only the fields it needs (`name`, `tool`, `model`, `status`,
`taskDescription`, `tmuxSession`, `contextPct`, `closedAt`) and ignores
everything unknown. Reconciliation rules:

- new live agent → pane inserted via the least-disruptive split
- `closedAt` present, or agent missing from a snapshot → the pane keeps its
  final status border for a 2 s grace, then closes through the normal command
  path ("done"/"failed" get a visible beat instead of vanishing mid-glance)
- agents already closed (or `dead`) that never had a pane are ignored
- feed process dies → agent panes turn gray dashed (statuses untrusted); no
  auto-restart, relaunch via `hive`

Status words map onto the existing status/attention model: spawning/working/
idle → running (blue); awaiting-approval, control-paused, stuck → amber +
attention; done → green until acknowledged; failed → red + badge; dead → gray
dashed. The raw word still shows in the pane header, next to tool, model, and
context %.

### Lifecycle

Closing the window terminates the feed and the pane children (detaching tmux
clients). The app quits after the last window closes
(`applicationShouldTerminateAfterLastWindowClosed == true`): one launch
invocation is one project window, and quitting is what returns external
viewer windows to the daemon. Agents keep running either way — they live in
daemon-owned tmux sessions, never in this process.

## Run it

```sh
cd workspace
swift build              # debug build
swift test               # WorkspaceCore unit tests
scripts/smoke.sh         # headless e2e against real tmux (requires tmux)
```

`scripts/smoke.sh` creates real detached tmux sessions, generates a feed
binary (a shell script speaking the exact NDJSON contract — a process-boundary
stub, invisible to the app) plus a fake `hive` whose `claude` subcommand does
`tmux new-session -A`, then runs `HiveWorkspace --smoke` offscreen. The app
asserts: a pane per live agent, buffers showing the sessions' real output,
keystroke round trip through tmux, close-detaches, and the solved
master/satellite layout. The harness then asserts every session survived and
the typed marker really landed in the tmux pane. Exit 0/1 with a failure list.

## Layout of the code

- `Sources/WorkspaceCore` — platform-independent logic, fully unit-tested:
  - `LayoutTree` — deterministic master/satellite split tree (master fixed to
    the 55–60 % band, default 0.58; least-disruptive insertion; close
    collapses only the parent split; promote is an atomic swap).
  - `SpatialNavigation` — arrow-key focus movement over solved frames.
  - `Status` / `Attention` — the five status states and the severity+time
    attention queue.
  - `AgentFeed` — the workspace-feed NDJSON contract: tolerant decoding and
    the status-word → semantic-status mapping.
  - `ProjectState` — the one reducer: feed reconciliation in,
    `WorkspaceCommand`s in, `StateChange`s out.
  - `Command` — the one shared `WorkspaceCommand` model every input surface
    dispatches through.
  - `LayoutTransition` — the ~180 ms ease curve and interruptible-retarget math.
- `Sources/HiveWorkspace` — the AppKit shell (HIG-native: system semantic
  colors, system fonts, SF Symbols, native chrome/menus/materials):
  - `main` / `LaunchConfig` — the CLI launch contract above.
  - `AppDelegate` — window + feed wiring, placeholder window, lifecycle.
  - `FeedClient` — the `workspace-feed` subprocess and its NDJSON stream.
  - `ProjectWindowController` — one window + reducer per project; the single
    command dispatch point; schedules grace closes; key window owns routing.
  - `PaneView` — header (tool · model · status · ctx %), status border,
    separate inset focus ring, failure badge, bounded amber pulse,
    accessibility custom actions.
  - `TerminalPaneView` — the SwiftTerm `LocalProcessTerminalView` host:
    deferred spawn on settled geometry, SIGTERM-detach on close.
  - `LayoutAnimator` — 180 ms interruptible transitions; terminal-cell
    geometry commits exactly once at the end; Reduce Motion snaps.
  - `AttentionCenter` / `ProjectSwitcherController` — attention panel and
    sanitized project cards.
  - `SmokeRunner` — the in-process half of `scripts/smoke.sh`.

SwiftTerm is pinned to v1.11.2 — the newest release before the Metal GPU
backend, whose shader resource makes the universal (`--arch arm64 --arch
x86_64`) release build depend on the optional Metal toolchain component that
Xcode 26 machines and CI runners frequently lack.

## Keyboard map (all also in the Pane/Workspace menus)

| Command | Keys |
| --- | --- |
| Promote focused pane to master | ⌘↩ (or double-click pane header) |
| Return Orchestrator to Master | ⇧⌘↩ |
| Focus orchestrator | ⌘0 |
| Move focus spatially | ⌥⌘←/→/↑/↓ |
| Acknowledge focused pane | ⇧⌘K |
| Close pane (detach, never kill) | ⇧⌘W |
| Attention queue | ⌥⌘A |
| Projects | ⇧⌘P |

Approve/deny and message sending have no app-level surface anymore: panes are
the native TUIs, so those happen by typing in the terminal.
