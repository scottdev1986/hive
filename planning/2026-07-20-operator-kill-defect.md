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

---

## 2. The trigger, ranked

### H1 — `hive stop` fan-out from a termination attempt that never completed. **REFUTED for this incident, but a real defect that fired earlier the same day.**

The mechanism, read from `src/cli/control.ts:530-575`: `hive stop` collects
`sessiondAgents` (live agents with `hostKind === "sessiond"`), kills them all concurrently via
`Promise.allSettled`, and only *afterwards* verifies and SIGTERMs the daemon. If verification fails
it throws **after the agents are already dead**:

```ts
if (sessiondFailures.length > 0) {
  throw new Error("Hive refused shutdown because sessiond teardown was not verified: " + ...);
}
try { (deps.kill ?? process.kill)(pid, "SIGTERM"); }
```

The GUI then takes the `.failure` branch at `AppDelegate.swift:424-437`: sets
`terminationPending = false`, calls `replyToApplicationTermination(false)`, and shows an alert. **The
app comes back to life; the agents do not.**

**Evidence for.** The cardinality fits perfectly. At 16:07:40Z the live sessiond agents were exactly
maya and david (sam already dead; queen has no `agents` row at all, so the fan-out would skip it) —
and they died 20ms apart, the signature of `Promise.allSettled`. At 16:17:23Z the only live agent
was john — one kill. The daemon survived both times, which the `throw`-before-`SIGTERM` ordering
explains exactly. And this failure mode is **not hypothetical** — it is in the unified log, verbatim,
naming this exact pair:

```
2026-07-20 11:44:56.454 HiveWorkspace[45900] hive-terminate phase=requested  reason=last-window-closed detail=last window closed
2026-07-20 11:44:56.455 HiveWorkspace[45900] hive-terminate phase=decision   reason=last-window-closed detail=reply=terminateLater awaiting-verified-hive-stop
2026-07-20 11:44:56.613 HiveWorkspace[45900] hive-terminate phase=resolved   reason=last-window-closed
    detail=outcome=cancelled still-running: hive: Hive refused shutdown because sessiond teardown was
    not verified: maya: sessiond locator has no terminal-host binding in this Hive instance;
    david: sessiond locator has no terminal-host binding in this Hive instance
```

(An earlier occurrence at 11:15:30/11:15:41/11:15:49 local shows the same thing for `reconciler`.)

**Evidence against — decisive.** That log entry is **pid 45900**, a *different, now-dead* workspace
process, at 11:44:56 local = **15:44:56Z** — 23 minutes *before* maya (15:57:30Z) and david
(15:58:43Z) were even created. Those are name reuses from a previous instance. It is a precedent,
not this incident.

For *this* incident the refutation is direct: `stopForTermination` has **exactly one call site**
(`AppDelegate.swift:418`), inside `applicationShouldTerminate`, which unconditionally logs
`phase=requested` and `phase=decision` (`:387`, `:414-416`) *before* running `hive stop`. There is
**no `hive-terminate` record at 12:07:40 or 12:17:23 local** (= 16:07:40Z / 16:17:23Z).

*Positive control on that negative* (per Hive protocol 3): the unified log is retained and readable
at that instant — 5,208 log lines exist in the 15s around 12:07:40 local, and 291 lines from process
`HiveWorkspace` in 12:05-12:20, including pid 75200 activity at 12:07:45-12:08:16. The reader sees
positives there. The absence of `hive-terminate` is real, not a bad query.

**Therefore no termination was attempted, so `hive stop` never ran, so H1 did not kill these three.**
H1 remains an open, separately-reportable defect: *`hive stop` destroys agents before it has earned
the right to, and its caller treats the resulting failure as "nothing happened".*

### H2 — pane close → `hive kill`. **The only surviving route; mechanism confirmed, initiator unproven.**

With H1 refuted and no Swift HTTP client existing, `hive kill` via
`ProjectWindowController.swift:144-154` is the *only* remaining way these audit rows could exist.
One `.closePane` dispatch on an agent pane ⇒ one named kill. Two dispatches ⇒ maya and david. One
⇒ john. This is consistent with everything observed.

What is **not** established is what dispatched `.closePane`. There is no fan-out loop over panes
anywhere in the tree (all sites enumerated in §1.3), so maya and david required **two separate
dispatches 20ms apart**. Ranked sub-hypotheses:

- **H2a — ⇧⌘W / menu `closeFocusedPane` firing twice.** After the first pane closes, focus advances
  to the next pane, so a repeated invocation closes a *second, different* agent. *For:* explains a
  pair with one intent, and explains why the user does not remember issuing a kill — they closed a
  pane, not an agent. *Against:* 20ms is faster than macOS key-repeat (typical initial delay is
  hundreds of ms); this looks like two dispatches in a single run-loop pass, not two keystrokes.
- **H2b — the accessibility action (`PaneView.swift:373`) driven programmatically** by VoiceOver, a
  window manager, or automation. *For:* would be machine-speed and invisible to the user. *Against:*
  no evidence of an accessibility client in the log window.
- **H2c — one X-button action delivered to two panes** in a single pass (stale `paneID` capture or a
  duplicated action send). *For:* matches the 20ms timing best. *Against:* purely structural; no
  direct evidence.

**The user-facing symptom that distinguishes H2 from a normal close:** after each kill the GUI
requested `terminal:observe` **for the agent it had just killed** — maya at 16:07:43.572Z; david at
16:07:45.599, 16:07:46.601, 16:07:48.615; john at 16:17:26.608, 16:17:27.605. A pane that was
genuinely closed by the user would not be re-attached three times. The GUI killed the agent while
*keeping the pane*. That is why the user is certain they issued no kill: **from the screen, nothing
closed.**

### H3 — daemon-internal idle reap. **REFUTED.**

`reapIdleAgents()` (`src/daemon/server.ts:2150-2219`) kills after two warnings, and the `events`
table is superficially suggestive: a `notification` fires ~60s after each `turn-end` (david
16:02:55.467→16:03:55.589; maya 16:04:55.418→16:05:55.637; queen 16:15:25.075→16:16:25.189).

It is refuted twice over. First, that path calls `killAgentTeardown` **in-process**, with no HTTP
and no capability check, so it cannot produce `route=/agents/kill, callerSubject=operator` rows.
Second, the timing does not fit a per-agent timer at all: maya died 105s after her notification and
david 225s after his — *yet they died together*. A per-agent idle timeout cannot produce a
simultaneous pair.

### H4 — GUI roster-reconcile cull. **REFUTED.**

`ProjectWindowController.applyFeed` (`:120-126`) only dismisses stale kill-failure sheets; it never
kills. The one timer that could have — `scheduleGracefulClose` (`:357-368`) — routes to
`removeClosedPane` (`:162-164`), which calls `state.apply(.closePane(...))` **directly, bypassing
`dispatch`**, deliberately and with a comment saying so at `:159-161`. The kill is only reachable
through `dispatch`. A registry that forgot rows could not have killed anything.

---

## 3. The secondary defect: recovery cannot tell a kill from a crash

This is a **separate defect** from §2. It did not kill anyone; it resurrected a corpse. It would fire
for *any* deliberate kill, including a correct one.

### 3.1 Where recovery decides "crashed"

`src/daemon/recovery.ts:274-291`, driven from `HiveServer.reconcileAgents()`
(`src/daemon/server.ts:2134-2136`) on the periodic reconciliation timer (`:665`, `:1115`, `:1262`):

```ts
for (const candidate of this.deps.db.listAgents()) {
  const agent = this.migrateSessionLocator(candidate);
  const isSpawning = agent.status === "spawning";
  if (!isSpawning && !LIVE_STATUSES.includes(agent.status) &&
    agent.status !== "control-paused") { continue; }
  ...
  if (await this.sessionPresent(agent)) { continue; }
```

with `LIVE_STATUSES = ["working","idle","awaiting-approval","stuck"]` (`recovery.ts:157-162`).

**"Crashed" is defined as: the row still claims a live status, and the session is gone.** That is the
entire predicate. Resume follows at `recovery.ts:330`, gated only by the attempt cap
(`recovery.ts:408`, max 3 at `:60`), bumping `recoveryAttempts` at `:465-478`, forcing status back to
`idle` at `:613-617`, and sending the "Your previous process crashed…" notice as `hive-recovery` at
`:705-713`.

### 3.2 Why an audited allow-decision did not mark the agent deliberately closed

Two independent reasons.

**(a) Nothing in recovery ever looks.** `recovery.ts` contains **zero** references to `closedAt`,
`terminationAuditJson`, or any deliberate-closure concept — the only occurrences of "killed" or
"deliberate" are prose in comments (`:58`, `:627`, `:695`, `:724`). The predicates that omit it:
sweep `:277-281`, `recoverOne`/`recoverOneExclusive` `:399-438`, manual `recoverAgent` `:337-372`.
`terminal_host_bindings.terminationAuditJson` — which *does* record the kill (`db.ts:1127`, read at
`db.ts:1144`/`:1154`) — is never read by recovery.

**(b) The closure marker is written too late to be seen anyway.** `killAgentTeardown`
(`src/daemon/server.ts:1861-1874`) destroys the process **before** any row says the agent is closed:

```ts
const reaped = await this.stopAgentProcesses(agent, () => {...});   // :1861 — kills session, SIGKILLs tree, AWAITS
const timestamp = options.at ?? new Date().toISOString();
const killed = this.db.markAgentDead(agent.id, timestamp, options.failureReason);  // :1867
this.status.closeAssignment(agent.id, timestamp);                    // :1874
```

The documented order at `:1818-1829` confirms it: capture tree → kill session → SIGKILL and verify →
*then* mark dead. Between `:1861` and `:1867` the row reads `working`/`idle` **with no session
present** — bit-for-bit the crash predicate of §3.1. `killAgentTeardown` takes no interlock against
the recovery sweep (`recovery.ts:186`) and sets no pre-kill intent marker.

**This window is measurable, and it is large.** From the DB:

| agent | killed (audit) | `closedAt` | window |
|---|---|---|---|
| maya  | 16:07:40.555Z | 16:07:43.225Z | **2.67s** |
| david | 16:07:40.575Z | 16:08:14.515Z | **33.9s** |
| john  | 16:17:23.749Z | 16:17:26.288Z | **2.54s** |

A reconciliation tick landing anywhere in those windows classifies the kill as a crash. For david it
did.

Compounding it: `markAgentDead` (`db.ts:1270-1289`) writes only `status`, `failureReason` and
`lastEventAt` — **`/agents/kill` passes no `failureReason` at all**, which is why maya and john show
`failureReason` empty. `closedAt` is never written by any caller; it is stamped derivatively by
`resolveClosedAt` (`db.ts:1250-1264`) inside `upsertAgent`, and per the comment at `db.ts:1251-1256`
a resume **actively clears it**. So a killed agent and a crashed agent are byte-identical in the
schema apart from a field the kill route does not set.

### 3.3 What actually happened to david

Killed at 16:07:40.575Z → sweep saw `idle` + no session → resumed (`recoveryAttempts` 1) → the resume
itself died, recording:

> `resume launch failed: the pane is redrawing but no /Users/scottkellar/.local/bin/claude process is
> running in it: the launch died behind a live wrapper`

produced by `orphanedPaneReason` at `src/daemon/readiness.ts:211-214`: the tmux pane exists and is
repainting, but the vendor CLI never survived. His `sessionLocator` shows the damage — generation 2
with `hostKind: "tmux"` and `engineBuildId: null`, where every other agent is `sessiond` with a real
build id. **Recovery downgraded him off sessiond while resurrecting an agent that was never supposed
to come back.**

---

## 4. Reproduction and instrumentation

### 4.1 Minimal reproduction hypotheses

**R1 — the kill path (§2/H2).** Spawn two agents so both have panes. With the window focused, invoke
`closeFocusedPane` twice in rapid succession (⇧⌘W, or hold it), then read:

```
sqlite3 -readonly "$HIVE_HOME/hive.db" \
  "select at,requestedSubject,callerSubject,reason from audit_log where route='/agents/kill';"
```

Two `/agents/kill` rows from one gesture confirms H2a. Zero rows while agents nonetheless die means
the kill came from somewhere §1.3 does not enumerate, which is a bigger finding.

**R2 — the teardown-before-verify defect (§2/H1), already proven to fire.** With a live
sessiond-hosted agent whose terminal-host binding is missing from the instance, close the last
window. Expected: `hive stop` kills every sessiond agent, *then* throws "sessiond teardown was not
verified", the GUI cancels termination, and you are left with a running app, a running daemon, and
dead agents. This one needs no new instrumentation — it is already in the unified log:

```
/usr/bin/log show --predicate 'subsystem == "dev.hive.workspace"' --last 2h --info --debug --style compact
```

**R3 — the recovery race (§3).** Kill any agent and watch `recoveryAttempts`. Any reconciliation tick
inside the 2.5-34s window of §3.2 resumes it.

### 4.2 The instrumentation: one field, and the first reason must win

The cascade here ran **kill → recovery-resume → resume-failure**, and the *last* reason won: david's
row records only `"resume launch failed: …"`, which describes the third event and erases the first.
maya and john, killed identically, record **nothing at all**. Reading the `agents` table alone, this
incident is invisible — it took the audit log, the binding revisions and the unified log to
reconstruct.

**The one line, and where.** `audit_log.reason` already exists and is **empty on all three kill
rows**. Populate it at the origin:

- `killAgentCli` (`src/cli/control.ts:258-315`) sends an origin string with the kill request —
  the CLI subcommand that ran (`kill` vs `stop`), argv, and the parent pid.
- `POST /agents/<name>/kill` (`src/daemon/server.ts:3185-3250`) writes that string into
  `audit_log.reason` on the allow-decision.

That single field separates Path 1 from Path 2 at a glance and names the invoking process. It would
have collapsed this entire investigation into one query. Note it must be captured **at the first
step and never overwritten** — the same first-writer-wins discipline `noteTerminationReason` already
applies at `AppDelegate.swift:381-390` ("First writer wins, so a self-quit keeps its own reason") and
that `agents.failureReason` currently violates.

Corollary on the recovery side: the marker must be written **before** `stopAgentProcesses`
(`server.ts:1861`), not after — a closure bit set only on the far side of the teardown cannot be seen
by a sweep that runs during it.

---

## 5. Summary

1. **Primary.** The three agents were killed by the GUI's `hive kill` pane-close path
   (`ProjectWindowController.swift:144-154`) — the only operator kill route left standing once
   `hive stop` is refuted. The GUI killed the agents while *keeping their panes*, re-attaching to
   them afterwards, which is why the user is certain they issued no kill. **What dispatched
   `.closePane` twice at 20ms is not yet proven** and is the open question.
2. **Separate, proven, real.** `hive stop` destroys every sessiond agent *before* verifying it may
   shut down, and its GUI caller reports the resulting failure as "still running" — an app that
   survives with all its agents dead. Fired at 11:15 and 11:44 local today.
3. **Secondary.** Recovery defines "crashed" as status-live + session-absent and consults no closure
   marker; the marker is written after teardown anyway, leaving a 2.5-34s window in which any
   deliberate kill reads as a crash. It resurrected david and downgraded him off sessiond.
4. **Why it was hard.** No kill records its origin. `audit_log.reason` is empty by construction.
