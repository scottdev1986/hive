# The operator-kill defect: what killed maya, david and john on 2026-07-20

**Status:** investigation only. This document *defines* the defect. It fixes nothing.

**Instance:** `adc6ff7499`, instance home `/tmp/hv-a27e3d322a`, GUI `HiveWorkspace` **pid 75200**
(`.dev/root/versions/0.0.0/HiveWorkspace.app`).

**Clock note.** The DB stores UTC (`...Z`); the macOS unified log prints **local time, EDT = UTC-4**.
Every cross-reference below converts explicitly. Getting this wrong is what makes this incident look
unexplainable, so each citation carries both.

---

## 0. The established facts

Three agents died. None crashed. All three died through an authorized, audited operator kill:

| agent | audit id | at (UTC) | route | caller | decision |
|---|---|---|---|---|---|
| maya  | 367 | 16:07:40.555Z | `/agents/kill` | `operator`/`operator` | allow |
| david | 368 | 16:07:40.575Z | `/agents/kill` | `operator`/`operator` | allow |
| john  | 550 | 16:17:23.749Z | `/agents/kill` | `operator`/`operator` | allow |

All three carry the **same `capabilityId` `9dfcd759-4d58-4b80-8d1b-2a9b3056a26a`** — one operator
credential, i.e. one client process, fired all three. The control case is sam (audit id 43,
15:48:34.599Z), killed via `/mcp:hive_kill` by `queen`/`orchestrator` — a different route, a
different caller, and deliberate. sam is *not* part of this defect.

### 0.1 The GUI is provably the caller

`terminal_host_bindings.visibilityJson` records `workspacePid: 75200`, and `pgrep` confirms pid
75200 is the live `HiveWorkspace.app` for instance `adc6ff7499`. The operator credential belongs to
that GUI.

### 0.2 The kill is issued by the same component that drives the 5.3s visibility loop

`visibilityJson.openTerminalRevision` is frozen into the binding **at kill time**. It corresponds
exactly, 1:1, with the count of `/workspace-visibility` audit rows preceding each kill:

| agent | frozen `openTerminalRevision` | `/workspace-visibility` rows before the kill |
|---|---|---|
| sam         | 33  | 33  |
| maya, david | 320 | 320 |
| john        | 474 | 474 |

Three exact matches. `openTerminalRevision` *is* the visibility-write counter. This proves the kill
path and the ~5.3s visibility write loop (known issue #48) run in the same process and share state,
and that the visibility snapshot is captured synchronously on the kill.

It also proves **maya and david were killed at the same revision (320)** — the same GUI observation,
20ms apart. That is a machine-speed pair, not two human clicks.

---

## 1. The GUI-side call sites

### 1.1 The route

`src/daemon/server.ts:3185-3250` — `POST /agents/<name>/kill`, documented in-tree as "the pane's X
button". Authenticated at `:3200`, capability `agent:kill` checked at `:3210`, dispatched at
`:2504`, delegating to `killAgentTeardown` (`src/daemon/server.ts:1836`) at `:3250`. The operator
role holds `agent:kill` per `src/daemon/capabilities.ts:71,79,119` and `docs/daemon/authorization.md:121`.

### 1.2 There is exactly one operator-role HTTP client

`src/cli/control.ts:258-315` — `killAgentCli(name, port, expectedLocator)`, using `operatorFetch`
(`src/cli/credential.ts:44`).

**No Swift code speaks HTTP to this route.** Neither `HiveWorkspace` nor `HiveTerminalKit` contains
kill-related HTTP code; `HiveTerminalKit` has none at all. The GUI always shells out to the `hive`
binary. So every operator kill is `hive kill` or `hive stop`.

`killAgentCli` has exactly two callers:

- **A — `hive kill <agent>`** (`src/cli.ts:500-521`), one named agent per invocation.
- **B — `hive stop`** (`src/cli/control.ts:553-561`), which **fans out over every live
  sessiond-hosted agent** via `Promise.allSettled` (`:530-532`, `:558-560`).

### 1.3 The two GUI paths

**Path 1 — pane close.** `workspace/Sources/HiveWorkspace/ProjectWindowController.swift:170-208`
(`lazy var killAgent`) spawns `hive kill <name> --port <p> --session-locator <json>` at `:179-182`,
fire-and-forget. Its sole call site is `:144-154` in `dispatch(_:)`:

```swift
if case .closePane(let paneID) = command,
   let pane = state.panes[paneID], pane.kind == .agent {
    react(to: state.markUserClosed(paneID))
    ...
    killAgent(pane.title, locator)
```

`.closePane` is dispatched from exactly three production sites:
- `workspace/Sources/HiveWorkspace/PaneView.swift:352` — the pane's X button
- `workspace/Sources/HiveWorkspace/PaneView.swift:373` — accessibility action "Close Pane"
- `workspace/Sources/HiveWorkspace/ProjectWindowController.swift:533` — `closeFocusedPane(_:)`, the
  menu item / ⇧⌘W

(`SmokeRunner.swift:496,786` also dispatch, but `controller.killAgent` is stubbed at `:779`.)

**Path 2 — app termination.** `AppDelegate.swift:399-440` `applicationShouldTerminate` returns
`.terminateLater` and calls `stopForTermination` (`:418`) → `runStopSession` (`:466-504`) → `hive
stop` (`:475`) → caller B → a kill for every live sessiond agent.
`applicationShouldTerminateAfterLastWindowClosed` (`:373-378`) returns `true`, so **closing the last
window enters this path**.

### 1.4 What the observed behaviour violates

`docs/daemon/agent-teardown.md` "Immediate is a UX constraint, not permission to destroy" (:56-66)
and "Quitting stops the machine, not just the process" (:67-74): teardown is meant to be a
*complete, verified* transition, not a partial one. Path 2 violates this — see §2.1: it destroys
agents first and verifies shutdown afterwards, and on failure leaves the app alive with the agents
already dead. `docs/daemon/authorization.md` "Audit" (:189-194) is satisfied in the narrow sense
(the decision was recorded) but the audit record carries **no origin**: `reason` is empty on all
three rows and `terminationAuditJson.reason` is only `"stop agent <uuid>"`. The matrix proves *who
was allowed*; nothing proves *what asked*. That gap is the reason this incident needed a
reconstruction at all.
