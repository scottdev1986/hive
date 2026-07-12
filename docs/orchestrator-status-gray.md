# Why the orchestrator's status dot is gray

Investigation, 2026-07-12. No code changed. The diagnosis is read from source;
§6a is measured, by a read-only `SELECT` against `~/.hive/hive.db` (the daemon
was never attached to, restarted, or written to, and the Workspace was never
launched).

## Summary

Gray does mean UNKNOWN — confirmed, not assumed. But neither of the two
diagnoses we set out to distinguish is the right one. The Workspace does not
mishandle missing data, and the daemon is not failing to publish a status it
holds. The truth is a third thing:

**The Workspace never asks the daemon about the orchestrator at all. It
synthesises the orchestrator pane locally and hardcodes the status word
`"running"` — a word that exists in no daemon vocabulary. The dot mapping
correctly sends any unrecognised word to `.unknown`, so the dot is gray.**

The gray dot is the UI being honest about a status word that was invented in
the UI. It is a stale-literal / vocabulary-mismatch bug, and it lives entirely
in Swift.

The good news, and the actual point of the fix: the daemon *can* observe the
orchestrator's real state — it already does, for delivery. The states are
live-and-working, live-and-idle, and gone, and all three are measurable
(§6). None has to be guessed. This is now **measured, not inferred**: the root
has posted 209 turn-starts and 447 turn-ends, and one of them landed 75 ms after
this investigation messaged it (§6a).

And the measurement found something the source alone would not have: for **15
hours and 19 minutes yesterday, the root posted 231 turn-ends and zero
turn-starts** — the stale-port hook failure, visible as a scar in the events
table. A naive fix would have rendered that as a confident yellow "idle" while
the root worked. It is detectable in the same table (a turn-end that never
started is impossible), so the fix should detect it and show gray rather than
lie. See §6a and §7c.

## 1. What the colours mean (verified)

`Theme.dotColor(for:)` — `workspace/Sources/HiveWorkspace/Theme.swift:26-37`:

| Activity | Colour |
| --- | --- |
| `.working` | green |
| `.idle` | yellow |
| `.needsUser` | red |
| `.spawning` | blue |
| `.done` | purple (dimmed once acknowledged) |
| `.failed` | orange |
| `.unknown` | **gray** (`Theme.swift:35`) |

So gray is `.unknown`. It is not idle — idle is yellow, and the codebase is
emphatic that the two are different states (`AgentFeed.swift:111-119`,
`AgentActivityTests.swift:21-23`). The user's belief was correct.

The dot is a *different, finer* signal from the pane border. The border comes
from `Theme.statusColor(for: PaneStatus)` (`Theme.swift:11-20`), where
`.disconnected` is the only gray. The two mappings disagree about unknown
words, and that disagreement is what hid this bug — see §4.

## 2. Where the orchestrator's status word comes from

It comes from a Swift literal, not from the daemon.

`ProjectState.addOrchestrator()` —
`workspace/Sources/WorkspaceCore/ProjectState.swift:126-131`:

```swift
panes[paneID] = PaneState(
    id: paneID, kind: .orchestrator, title: title,
    feedStatus: "running", status: .running)
```

The comment two lines above says it outright (`ProjectState.swift:123-124`):
"The master pane is the selected orchestrator terminal, created by the window
at open — **the feed only describes worker agents.**"

That `feedStatus` is never updated again. `apply(feed:)` only ever touches
panes keyed `agent:<name>` (`ProjectState.swift:156-157`), and `markFeedLost()`
explicitly skips the orchestrator (`ProjectState.swift:189`).

Now follow `"running"` into the dot. `PaneView.update(state:)` —
`workspace/Sources/HiveWorkspace/PaneView.swift:219-221`:

```swift
statusIcon.contentTintColor = Theme.dotColor(
    for: FeedStatusMap.activity(for: state.feedStatus),
    acknowledged: doneAcknowledged)
```

And `FeedStatusMap.activity(for:)` —
`workspace/Sources/WorkspaceCore/AgentFeed.swift:132-145` — recognises exactly:
`working`, `idle`, `awaiting-approval`, `control-paused`, `stuck`, `spawning`,
`done`, `failed`. Everything else, by design, falls to `.unknown`.

**`"running"` is not on that list.** It is not on the daemon's list either. The
daemon's status vocabulary is nine words —
`src/schemas/agent.ts:77-87`: `spawning, working, idle, awaiting-approval,
control-paused, stuck, done, dead, failed`. `"running"` is not one of them and
never was.

So: literal `"running"` → `activity(for:)` default branch → `.unknown` →
`systemGray`. That is the whole bug.

## 3. Is the orchestrator missing from the daemon's agent table? Yes — but that is not the bug

It is missing, and deliberately so. The daemon says so in four places:

- `src/daemon/db.ts:826-828` — "The orchestrator is not a spawned agent and has
  no agents-table row; its viewer window handle lives in the meta table."
- `src/daemon/db.ts:1029-1032` — `getAgentByName("orchestrator")` is null.
- `src/daemon/capabilities.ts:234` — "the operator and the orchestrator have no
  row."
- `src/daemon/delivery.ts:734-736` — same.

And the feed carries only that table: `workspace-feed.ts` emits
`fetchAgentStatus(port)` (`src/cli/workspace-feed.ts:170`), which is
`hive_status` → its `agents` key → `AgentRecord[]` (`src/cli/mcp.ts:67-74`). The
orchestrator has no record, so it is not in the array, so it never reaches
`apply(feed:)`.

But this absence causes no gray. The Swift side never looks the orchestrator up
in the feed and therefore never gets a miss — it fabricates the pane and the
word before the feed is ever consulted. If you fixed only "the daemon doesn't
publish an orchestrator row", the dot would *still* be gray, because
`addOrchestrator` would still stamp `"running"` over it.

That is the distinction the brief asked for, and it matters: **the UI is not
falling back to unknown on missing data. It is rendering a value it made up.**

## 4. Why nobody noticed: the border and the dot disagree about unknown words

`FeedStatusMap.paneStatus(for:)` (`AgentFeed.swift:80-97`) maps unrecognised
words to `.running` — "anything unknown → running (unknown is never rendered as
an alarm)" (`AgentFeed.swift:78`). So the orchestrator's *border* has always
been steady blue and looked right.

`FeedStatusMap.activity(for:)` was added later with the opposite and stricter
rule — an unrecognised word must not impersonate a real state
(`AgentFeed.swift:140-143`) — which is the right rule. It simply inherited a
pane whose word was fiction. The dot didn't introduce the bug; it revealed it.

## 5. Is this the "measures ACTING, not BEING" bug class?

Not quite — it is the degenerate case of it. The orchestrator's status is not
inferred from tool calls, message traffic, or elapsed time. It is inferred from
*nothing at all*: it is a constant. Hive did not measure the wrong thing here;
it measured nothing and hardcoded an answer.

The bug class is still the live hazard, though — in the **fix**. Three tempting
fixes are all instances of it and should be refused:

- Hardcode `"working"` instead of `"running"`. A permanently green dot. A lie
  whenever the root is idle, which is most of the time.
- Hardcode `"idle"`. A permanently yellow dot. The same lie, inverted.
- Scrape the orchestrator's terminal buffer for signs of activity. This is
  literally "the screen redrew, so it is alive". Refuse.

The honest fix requires reading a surface that records the root's *state*.
Hive already has one.

## 6. What the orchestrator's states are, and how each is honestly observed

The root posts lifecycle events through its own Claude Code hooks, under the
agent name `orchestrator`. The chain is fully in source:

- `src/cli/orchestrator.ts:150-162` — `prepareOrchestratorConfig` calls
  `writeClaudeAgentConfig(orchestratorConfigRoot(), { name: "orchestrator", … })`.
- `src/adapters/tools/claude.ts:447-456` — every hook becomes
  `hive event <kind> --agent orchestrator --port <n>`.
- `src/adapters/tools/claude.ts:506-516` — `SessionStart` → `session-start`,
  `UserPromptSubmit` → `turn-start`, `Stop` → `turn-end`.

Those land in the `events` table keyed by `agentName`
(`src/cli/event.ts:27`), and the daemon already reads them for the root
specifically. `DB.latestTurnBoundary(agentName)` —
`src/daemon/db.ts:1062-1080` — returns the newest boundary *with its kind*, and
its own doc comment states the semantics we need:

> "a newest boundary of `turn-start` means a turn is open right now … while
> `turn-end` means the recipient is idle."

Delivery's stalled-message triage already tells BUSY from DEAF with exactly
this (`src/daemon/delivery.ts:855-863, 891`), and it does so *because* the
orchestrator has no agents row — `delivery.ts:844-854` is the recorded
post-mortem of reading the wrong surface for the root.

These events demonstrably exist for the root — see §6a, where they are counted.

So, mapped onto the dot vocabulary:

| Real state | Observed how | Status word | Dot |
| --- | --- | --- | --- |
| live, mid-turn | newest boundary is `turn-start` | `working` | green |
| live, waiting for a prompt or an envelope | newest is `turn-end`, **preceded by a `turn-start`** | `idle` | yellow |
| gone | the pane's child process exited — the app owns that PTY and already knows (`controller.terminalChildRunning(pane:)`, used at `SmokeRunner.swift:204`) | `dead` | gray dashed |
| no boundaries, or a self-contradicting record | nothing trustworthy observed | *omit the field* | gray |

**Correction to my own first draft.** That table originally had a fourth row —
"live, session up but no turn yet → `idle` (yellow)", justified by a
`session-start` event. Implementing it changed my mind, and the measurement is
why. A root that has posted `session-start` and no boundary is *indistinguishable
from* a root whose turn-start hook is orphaned: both look like silence. Calling
that "idle" is the exact guess this document exists to refuse, and during the
15-hour window in §6a it would have been wrong. It is now `unknown`. The cost is
a gray dot for the few seconds between the app opening and the user's first
prompt; the benefit is that gray always means gray.

## 6a. Measured, not inferred

The claim above — that the root posts turn boundaries the daemon can read — is
now measured. Read-only query against the live `events` table, 2026-07-12
~16:28Z:

```
agentName     kind           n    newest
orchestrator  session-start   18  2026-07-12T13:31:18.290Z
orchestrator  turn-end       447  2026-07-12T16:25:23.075Z
orchestrator  turn-start     209  2026-07-12T16:26:26.697Z
```

The rows are there, for this session, in quantity. The newest `turn-start`
(16:26:26.697Z) is 75 ms after my own `hive_send` to the root
(16:26:26.622Z) — my message woke the orchestrator and its hook posted the
turn-start. The mechanism is live and it works.

Positive control (protocol #3): the same query returns turn boundaries for ~70
other agents, so an empty orchestrator result would have meant a bad key, not
an empty world. It was not empty.

Recent boundaries alternate cleanly, so the derivation in §6 is stable:

```
turn-start  16:27:33.238Z      turn-start  16:24:31.684Z
turn-end    16:27:33.155Z      turn-end    16:24:14.610Z
turn-start  16:26:26.697Z      turn-start  16:23:56.498Z
turn-end    16:25:23.075Z      turn-end    16:20:46.117Z
```

`latestTurnBoundary("orchestrator")` right now returns `turn-start`, i.e.
**working** — which is correct: the root is mid-turn, handling this task.

### The stale-port failure is not hypothetical. It happened, and it left a scar.

The lifetime counts are lopsided — 209 turn-starts against 447 turn-ends — and
that imbalance is not noise. Grouped by hour it is a clean step function:

| Window | turn-start | turn-end |
| --- | --- | --- |
| 2026-07-10T20 → 2026-07-11T18 | balanced (e.g. 22/19, 19/19, 23/24, 21/21) | balanced |
| **2026-07-11T19:39Z → 2026-07-12T10:58Z** | **0** | **231** |
| 2026-07-12T11 (recovery) | 8 | 17 |
| 2026-07-12T12 onward | 18/18, 14/14, 11/12 | balanced |

For **15 hours and 19 minutes**, the orchestrator posted 231 turn-ends and
exactly zero turn-starts. That is the incident recorded at
`src/adapters/tools/claude.ts:509-513` — a daemon port change re-pointed every
hook *except* `turn-start`, so the root kept posting turn-starts to a dead
port — visible in the data, with its start and end times, and the recovery when
the fix landed.

**This is the honest-limit case of §7, and it is measured, not imagined.** Had
the fix in §7 been shipped before that window, the orchestrator's dot would
have been a confident yellow "idle" for fifteen hours while the root was
working continuously, because the newest boundary would have been a stale
`turn-end` the whole time.

That changes the recommendation — for the better. See §7c: the failure is
**detectable in the same table**, so we do not have to accept the lie.

## 6b. The two states we must NOT synthesise

Holding this line is most of the value of the fix.

- **`needsUser` (red) stays unreachable for the root.** Red is reserved for
  *measured* blocked-on-human states — a pending approval record, or
  control-paused/stuck — and it is enforced as such
  (`AgentFeed.swift:111-119`, `AgentActivityTests.swift:14-24`). The root has
  none of those: it is a human-facing TUI, and a human sitting at it is not a
  blocked agent. There is no observation that would justify red, so no code path
  should be able to produce it. A root that goes red is a bug by construction.
- **No timeout-based `stuck`. Ever.** "The root has not ended a turn in N
  minutes" describes a deep build turn exactly as well as it describes a wedged
  process; delivery learned this the expensive way, and its comment records the
  cost — the same inference "fired seven times in one evening for agents that
  were simply working" (`src/daemon/delivery.ts:768-776`). Elapsed time is not a
  state. This is the measures-acting-not-being class wearing a new hat, and it is
  precisely how the class keeps getting reintroduced: each time it looks like a
  reasonable safety net rather than a guess.

The distinction that keeps §7c honest and this dishonest: an unpaired turn-end
is a *contradiction in the record* (a turn ended that never started — impossible,
so something is broken). A long gap is merely *an absence of news*, and absence
of news is unknown, never "stuck".

### How "gone" is observed (locally, and for real)

The app owns the orchestrator's PTY: the orchestrator pane runs the root TUI as
its own child process, and SwiftTerm delivers an exit callback when that child
dies. `TerminalPaneView.processTerminated(source:exitCode:)` —
`workspace/Sources/HiveWorkspace/TerminalPaneView.swift:247-248` — sets
`childRunning = false`, surfaced through
`ProjectWindowController.terminalChildRunning(pane:)`
(`ProjectWindowController.swift:268-269`) and already asserted against the
orchestrator pane in the smoke suite (`SmokeRunner.swift:204`).

That is a *callback on process exit*, not a poll and not a heuristic — the
kernel told us the process is gone. It is the strongest signal in this whole
document, and it needs no daemon round-trip. "Gone" is therefore free and
honest: when `childRunning` goes false for the orchestrator pane, the pane is
disconnected (gray dashed), and that gray means what gray is supposed to mean.

Note the asymmetry, because it is the useful part: **liveness is observed by
the app, turn state is observed by the hooks.** They fail independently. Broken
hooks cost us working-vs-idle; they never cost us alive-vs-dead.

## 7. Recommended fix

Two layers. The first is required; the second is what makes it honest rather
than a nicer-coloured constant.

**A. Publish the orchestrator's observed status on the feed (daemon, TS).**

Add a top-level field to the feed line rather than a synthetic row in the
`agents` array:

```json
{"v":1,"agents":[...],"orchestrator":{"status":"working"},"autonomy":"sandboxed"}
```

Derived in the daemon from `db.latestTurnBoundary(ORCHESTRATOR_NAME)` per the
table in §6, and **omitted entirely when nothing has been observed** — an absent
field is unknown, never false, and the UI's existing gray is then exactly right.

Why a new field and not an `AgentRecord` for the orchestrator: the "the
orchestrator has no agents row" invariant is load-bearing in at least four
places (§3) — name reuse, capability grants, spawner reservations and
delivery all read that table and assume its members are spawned agents. Adding a
fake row to satisfy a colour would be the expensive kind of clever. The feed
line is additive: `FeedLine` already ignores unknown fields
(`AgentFeed.swift:52-67`), so an older app decodes a newer daemon fine.

**B. Stop fabricating the status word (Workspace, Swift).**

- `ProjectState.addOrchestrator` should seed the pane with a status word that
  means "not yet observed" — i.e. `"unknown"`, not `"running"` — so the initial
  gray is a truth rather than an accident, and delete `"running"`, which is
  vocabulary that exists nowhere else in the system.
- Apply the feed's `orchestrator.status` to the orchestrator pane on each
  snapshot, the same way agent panes are updated.
- On feed loss, the orchestrator's *status word* should go unknown (its
  terminal is still attached and still live — only the metadata stream is
  gone). Note this reverses the current explicit carve-out at
  `ProjectState.swift:189`; the carve-out was correct when the word was a
  constant and is wrong once it is observed.

**C. Detect the broken-hook case instead of lying through it.**

§6a measured a 15-hour window in which the root emitted 231 turn-ends and zero
turn-starts. Naive derivation renders that as a confident yellow "idle" while
the root works. We do not have to accept that, because **the failure is visible
in the same table we are already reading**: a turn-end with no preceding
turn-start is a *structurally impossible* sequence. A turn cannot end without
having started.

So the daemon should derive:

- newest boundary is `turn-start` → **working**
- newest boundary is `turn-end`, and it was preceded by a `turn-start` →
  **idle**
- newest boundary is `turn-end`, and the boundary before it was *also* a
  `turn-end` → **the hooks are lying to us.** Emit nothing. The field is
  omitted, the dot is gray, and gray means unknown — which is the truth.

That is not a timeout, not a heuristic, and not an inference from elapsed time.
It is a contradiction in the observed record, and it is exactly the kind of
thing we are allowed to conclude from. One unpaired turn-end is enough to know
something is wrong; it does not become true after five minutes.

This turns the one confident lie this design could produce into an honest
unknown, using data we already have. It is worth the extra query.

### The conscious acceptance

Even with (C), one gap remains, and I want it legible rather than buried:

**What we are trading.** Today the dot is *always* gray — 100% wrong, in the
sense that it conveys nothing about a root that is by definition alive. After
this fix it is right in the ordinary case (green while working, yellow while
waiting for you) and gray in the broken-hook case. We are trading an
always-useless signal for a usually-correct one that degrades to the same
useless signal it had before. There is no state in which this fix makes the dot
*more* wrong than it is today. That is why it is worth shipping.

**What a user would see if it went wrong anyway.** The residual failure is:
hooks silently stop firing *cleanly* — no unpaired turn-end, just nothing more
at all — while the root keeps working. The last boundary stays a legitimate
`turn-end`, (C) sees no contradiction, and the dot sits **yellow (idle)** while
the root is in fact mid-turn. Concretely: you would see a yellow orchestrator
dot that never goes green no matter what you type at it, while the root's
terminal is visibly producing output. The terminal and the dot would disagree,
and the terminal would be right.

**What would tell us it is happening.** Three signals, in increasing cost:
a yellow dot on a root whose PTY is visibly scrolling; the root's turn-start
count flatlining while turn-end keeps climbing (`SELECT` above, and this is
what (C) automates); and the `hive event` hook command in the root's
`settings.local.json` naming a port other than the daemon's current one — the
root cause of the recorded incident.

**Why we accept it.** Yellow-when-actually-working is bounded, self-evidently
wrong to anyone looking at the terminal next to it, and strictly better than a
gray dot that is wrong 100% of the time. It cannot cause red — the root can
never render needs-you — so it cannot manufacture a false alarm. And the fix for
the underlying cause (hooks pointing at a dead port) already landed; (C)
catches the recurrence rather than trusting that it never recurs.

### Trade-offs

- **Cost.** Small but cross-language: a daemon read + one feed field, a Swift
  decode, a `ProjectState` branch, and tests on both sides. Bigger than a
  one-word edit; that is the price of not lying.
- **The one-word edit alternative.** Changing `"running"` → `"idle"` in
  `ProjectState.swift:131` turns the dot yellow today, costs nothing, and is
  wrong the moment the root starts working. I do not recommend shipping it
  alone. If the team wants an immediate cosmetic stop-gap ahead of (A), it
  should land *with* the honest fix already scheduled, not instead of it.
- **What we still cannot see.** Whether the human is looking at the window.
  Whether a mid-turn root is productively working or wedged. We should not try.

## 8. What shipped

Implemented as recommended, in three pieces:

- **`src/daemon/orchestrator-status.ts`** (new) — the pure derivation, including
  the unpaired-turn-end contradiction rule. It reads *kinds only, never
  timestamps*, so no timeout inference can be introduced without changing its
  signature. Unit-tested for all five shapes, including the two that must return
  null.
- **`src/daemon/db.ts`** — `recentTurnBoundaries(agentName, limit = 2)`, newest
  first. Two rows, because one cannot express the difference between "idle" and
  "the hooks are lying".
- **`src/daemon/server.ts`** — `GET /orchestrator-status`, gated on the existing
  `status:read` action (this is the root's status, not a new kind of authority,
  and the feed already holds that capability — no new `Action` was added).
- **`src/cli/workspace-feed.ts`** — the `orchestrator` field on the snapshot
  line, **omitted** when the daemon returns null, and omitted when the read
  itself fails. A status we could not read is not a status we may invent.
- **Swift** — `OrchestratorSnapshot` decoded from the feed line;
  `addOrchestrator` seeds `"unknown"` instead of the fictional `"running"`;
  `apply(feed:orchestrator:)` applies the measured word and *reverts to unknown*
  when the field is absent; `markFeedLost` no longer exempts the orchestrator.

The old test `testMarkFeedLostTurnsAgentsGrayButLeavesOrchestrator` asserted the
exemption and now asserts the opposite, renamed accordingly. That is a
deliberate contract change, and §7B is the argument for it: the exemption was
correct only while the status was a constant.

## Scope note

The Workspace was never launched, the daemon was never attached to or
restarted, and nothing was written: a live verification of the UI would have
killed the user's feed. The diagnosis (§1-§5) is entirely source-derived. The
observability claim (§6) is measured in §6a by a read-only `SELECT` against
`~/.hive/hive.db`, which touches the file, not the daemon.

What remains unverified, stated plainly: **nobody has seen the dot change
colour.** The derivation, the wire format, the decode, and the pane update are
each tested (Swift: 59 tests green; TypeScript: 1354 green), and the Swift
package builds — but confirming that the orchestrator's dot actually renders
green mid-turn and yellow at rest requires launching the Workspace against a
live daemon, which is the one thing that would kill the user's feed. So it was
not done. The failure this leaves open is a wiring mistake (a status that is
derived and published correctly but never reaches the icon); the logic itself is
covered. Whoever next runs the Workspace should glance at the root's dot, and
that glance is the last verification step.
