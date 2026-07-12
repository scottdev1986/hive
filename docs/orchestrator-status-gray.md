# Why the orchestrator's status dot is gray

Investigation, 2026-07-12. No code changed. Nothing was run against the live
daemon: every claim below is read from source.

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
live-and-working, live-and-idle, and gone, and all three are measurable. None
has to be guessed.

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

Positive control, per protocol #3: these events demonstrably exist for the
root. `claude.ts:509-513` records a real incident in which "the root kept
posting turn-starts to the dead port" — Hive has observed the root's
turn-starts and been burned by losing them. This is not a field we hope is
populated.

So, mapped onto the dot vocabulary:

| Real state | Observed how | Status word | Dot |
| --- | --- | --- | --- |
| live, mid-turn | `latestTurnBoundary("orchestrator").kind == "turn-start"` | `working` | green |
| live, waiting for a prompt or an envelope | `.kind == "turn-end"` | `idle` | yellow |
| live, session up but no turn yet | a `session-start` event and no boundary | `idle` | yellow |
| gone | the pane's child process exited — the app owns that PTY and already knows (`controller.terminalChildRunning(pane:)`, used at `SmokeRunner.swift:204`) | `dead` | gray dashed |
| no events at all | nothing observed | *omit the field* | gray |

Two states we should **not** synthesise:

- **`needsUser` (red).** The root is a human-facing TUI; a human sitting at it
  is not a blocked agent. Red is reserved for measured blocked-on-human states
  (`AgentActivityTests.swift:14-24`) and the root has none. Leave it unreachable.
- **`stuck` by timeout.** "No turn-end for N minutes" is a busy root as often
  as a wedged one. That inference is the bug class. Don't.

### The honest limit, stated plainly

Turn-boundary observation depends on the root's hooks pointing at the live
daemon port. If they are stale (the 2026-07-12 incident), turn-starts vanish
and the last boundary stays `turn-end` forever — the daemon would render a busy
root as a confident yellow "idle". That is a confident lie, and it is the one
failure mode this design can produce.

It is bounded, not eliminated: liveness (is the process up) is observed by the
app, which owns the PTY; turn state (is a turn open) is observed by hooks. If
the hooks are broken, we lose turn state, not liveness. I would accept that —
yellow-when-actually-working is a far cheaper error than gray-always — but it
should be a conscious acceptance, not a surprise. If we want to close it, the
daemon would have to detect the staleness itself (e.g. a session-start whose
port does not match the running daemon's), which is a separate piece of work
and out of scope here.

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

## Scope note

I did not run the Workspace, attach to the daemon, or read the live database —
per the operational warning, a live verification would have killed the user's
feed. Everything above is source-derived. The one thing a live check would add
is confirmation that `events` currently holds `turn-start`/`turn-end` rows with
`agentName = 'orchestrator'` for *this* session; the code path is proven, and
`claude.ts:509-513` records a past incident that depended on those rows
existing, but I have not observed today's. A read-only `SELECT` against the
SQLite file would settle it without touching the daemon, if the orchestrator
wants that before implementing.
