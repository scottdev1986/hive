# Seeing a live terminal pane in the Workspace app

Answers one question: what do I type to get a rendered terminal on screen, and
why did `hive build` / `hive run` give me nothing?

## The short answer

`hive build` and `hive run` **do not exist**. They are not "start the daemon
only" and they do not launch a stale app — they are unknown arguments. Both exit
non-zero with `error: too many arguments` followed by the full help text, and
nothing is started at all. There was never an app to show a terminal in.

Measured against the real dispatcher (`src/cli.ts:230-250`, commander with
`.exitOverride()`):

```
argv=["run"]:   ERROR code=commander.excessArguments  error: too many arguments. Expected 0 arguments but got 1: run.
argv=["build"]: ERROR code=commander.excessArguments  error: too many arguments. Expected 0 arguments but got 1: build.
argv=[]:        parsed with NO error   (bare `hive` is the launch verb)
```

`build` and `run` are **Makefile** targets, not CLI verbs. The CLI's launch verb
is bare `hive`, with no subcommand.

## The procedure

Run these in your own Terminal.app, in the main checkout, on an unlocked screen.

```sh
cd /Users/scottkellar/Projects/hive
make build
make run
```

| Step | What you should SEE |
|---|---|
| `make build` | Zig/GhosttyKit/sessiond/Swift build output, ending in `staged: hive 0.0.0 (<sha>, …)`. Stages an unsigned dev release under `.dev/`. |
| `make run` | A **HiveWorkspace window opens with one full-window terminal pane already running** — the orchestrator ("queen") pane, a Claude TUI. This is a real TTY: type into it. |
| type into the queen pane | e.g. `spawn an agent named ada to list this repo`. The orchestrator calls `hive_spawn`. |
| a few seconds later | A **second pane appears** for `ada`, rendering that agent's live session. |

Terminal number one requires **no agent**. `bootstrapOrchestrator()` runs
unconditionally at launch (`workspace/Sources/HiveWorkspace/AppDelegate.swift:137`),
so an empty workspace still shows the queen pane. If you see zero terminals, the
app either never launched or fell to the no-project placeholder.

There is **no spawn button**. `MainMenuBuilder.swift` has no "New Agent" item;
agent creation is daemon-driven only. You ask the orchestrator, in prose, in its
pane.

## Symptom → cause

All of these read as "no terminal appeared".

| Symptom | Cause | Fix |
|---|---|---|
| `error: too many arguments … got 1: run` + help dump | `hive run`/`hive build` are not commands | `make run`; bare `hive` to launch |
| 480×200 window: "No project is open. Run `hive` from a project directory" | App launched without the 5-arg contract — a Dock click, or launched outside a git repo (`AppDelegate.swift:79-95`) | Launch via `make run`, or `hive` from inside a git repo |
| `no dev build staged; run 'make build' first` | `make run` with an empty `.dev/` | `make build` |
| Window opens, pane area totally blank, no process | Pane geometry never exceeded 40×40 pt, so the child was never spawned (`TerminalPaneView.swift:244-245`) — silent | Make sure the window is key/active and not zero-sized; resize it |
| Queen pane fine, agent panes never appear | The workspace-feed subprocess is failing; statuses go stale. After 5 restarts the whole app quits | Check the daemon is up; re-run `make run` |
| Agent pane blank forever, no error | tmux-backed pane polling `until tmux has-session` in an infinite loop (`ProjectWindowController.swift:351-352`) | Session was never created; check daemon logs |
| Agent pane themed but empty, no error, no badge | Ghostty/sessiond pane: `ghostty_init` or `makeView()` threw and was swallowed to NSLog (`PaneView.swift:60-63`) | Missing/mismatched `GhosttyKit.xcframework` → `make build` |
| Agent pane with a **red badge / "renderer disconnected"** | sessiond attach failed 6 times: grant refused, locator mismatch, or UDS connect failed | Broker not ready; check `hive-sessiond` |
| App won't build at all | `workspace/Vendor/GhosttyKit.xcframework` absent — it's a `binaryTarget` build output, not checked in | `make build` |
| Everything "works" but the surface returns nulls | Not an unlocked Aqua GUI session (locked screen, ssh, agent shell) | Run it yourself, at your own console, screen unlocked |

Note the preflight's console check (`stat -f '%Su' /dev/console`) passes whenever
you own the console — it does **not** prove the screen is unlocked. That
precondition is only ever satisfied by a human at the machine.

## Is `hive` a supported path to a terminal?

Bare `hive` (not `hive run`) is architecturally the product path, but on this
machine it will not give you a live Ghostty pane today:

- It launches the **installed release**, never the working tree —
  `launchWorkspace` resolves the app from `installRoot()` and the source comment
  is explicit: "`hive` opens the installed release build, never a development
  build" (`src/cli/workspace.ts:57-69`).
- The installed release is **0.0.37, commit 40c4efa, 2026-07-16**. Main has
  **318 commits touching `workspace/` and `native/sessiond/` since**.
- 0.0.37's own signed manifest lists three artifacts: two CLI slices and
  `HiveWorkspace.tar.gz`. **No sessiond artifact.** `~/.local/share/hive/versions/0.0.37/`
  contains `hive` and `HiveWorkspace.app` and no `hive-sessiond`, so the broker
  the Ghostty pane attaches to cannot start.

So bare `hive` gets you the app and a queen pane, but not the current terminal
work. `make run` is required to see it. That is by design, not a bug.

The one thing worth filing: `hive run` and `hive build` are plausible enough
guesses, and the failure is a bare `too many arguments` buried under a full help
dump — it never says "did you mean `make run`?". A targeted error for these two
words would have saved this whole investigation.

## Milestone honesty

**PARTIAL.** B2.2 and B2.4 landed; C1.0/C1.1/C1.2 landed on top. The sessiond →
`HiveTerminalView` path is landed production code, default-on, gated only by the
daemon-assigned `locator.hostKind == "sessiond"` — no feature flag
(`ProjectWindowController.swift:307-317`).

What is **not** yet recorded is the live-GUI evidence cell. `raw/qualification/hive-b25-production-pane/EVIDENCE.md`
marks "Production wiring full (sessiond agent + HiveTerminalView under real
Workspace)" as **OPEN**, and B2.5 row K (the Claude/Codex/Grok vendor matrix) is
open on all three rows. The daemon-side half is green; nobody has yet recorded a
run where a real spawned vendor agent rendered a live pane in a normally launched
app.

The queen pane is a different stack — SwiftTerm, not Ghostty — and is not subject
to any of that. It works today.

## What no agent can do for you

The visual confirmation. A rendered terminal is proven only by a human looking at
a real GUI session with the screen unlocked; the production surface returns nulls
in a locked screen or a plain agent shell, and headless byte-level tests do not
substitute. Everything above is verified from source, the Makefile, the installed
release manifest, and a live dispatcher probe — but the last step, "I can see the
cursor blink and type into it", is yours.
