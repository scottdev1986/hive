# 2026-07-21 messaging regression: queen→agent delivery deadlocks on an orphaned human input claim

Investigated live against the running dev instance (daemon pid 17226, started
2026-07-21 14:51Z, HIVE_HOME `/tmp/hv-a27e3d322a`, instance `adc6ff7499`) by
nadia. All timestamps UTC; workspace.log lines are local (UTC−4) and are
converted where quoted.

## Root cause

Queen→agent **normal-priority** delivery to a sessiond-hosted Claude agent is
denied by the sessiond input arbiter with `claim denied: HumanOrphaned`, and
that state is a **deadlock with no automated exit**:

1. The Workspace TUI claims an agent's input the moment the user types into
   its pane (`AttachReplayClient.handleEncodedWrite` →
   `beginClaimAcquire`, kind `human`, 60 s lease —
   `workspace/Sources/HiveTerminalKit/Attach/AttachReplayClient.swift:247-289`).
2. The claim does not expire while the pane stays visible: every visibility
   renewal extends the active claim to the new lease horizon
   (`native/sessiond/src/session_host.zig:3617-3623`, introduced by 9e8a3b54).
   A typed-but-unsubmitted draft therefore holds input ownership indefinitely.
3. Any unclean viewer drop — pane re-layout, transport loss, app exit — runs
   `onViewerDetached` → `viewerDisconnect`, which moves the arbiter to
   `human_orphaned` to preserve the human's draft
   (`session_host.zig:4548-4558` → `2831`; `input_arbiter.zig:508-535`).
4. In `human_orphaned`, automation input is refused: the daemon's inject
   acquires its claim with kind `automation`
   (`src/daemon/session-host/sessiond-viewer-attach.ts:257`), and the host
   denies it with diagnostic `HumanOrphaned`
   (`session_host.zig:2781-2788`; arbiter guards at
   `input_arbiter.zig:355,687`).
5. The only exits from `human_orphaned` are a returning **human** viewer
   (`operatorResume`, human-kind enforced by construction,
   `input_arbiter.zig:545-561`) or `operatorDiscard`
   (`input_arbiter.zig:637-665`) — and **`operatorDiscard` has no caller
   anywhere**: no wire operation in `session_host.zig` exposes it and nothing
   in `src/` invokes it. If the viewer cannot re-attach, no component in the
   system can ever clear the state.
6. The daemon's delivery layer handles the denial "honestly": it records
   `sessiond inject declined: claim denied: HumanOrphaned` on the message row
   and leaves it queued (`src/daemon/delivery.ts:902-937`). The maintenance
   tick retries, is denied again, and re-records the same diagnostic forever.
   Nothing surfaces this to the user or queen; daemon stderr goes to
   /dev/null in production. The message queue is silently dead for that
   recipient.

An aggravator makes the deadlock self-inflicting: when an **expired** human
claim is still registered, the daemon's own automation claim first drops it
via `onViewerDetached` — which orphans the arbiter — and then denies itself
(`session_host.zig:2721-2723` → `2781`). The delivery path can poison its own
future without any viewer drop.

### Why this appeared today

Before 22773766, the pane viewer never completed an attach: 689bc0a0
regenerated the ghostty patch series without moving the vendored commit, the
GhosttyKit cache key omits the patch series, and the app shipped an engine
sessiond did not share — every viewer attach failed the M3 engine fence
("renderer disconnected"). **No viewer ever attached ⇒ no human claim was
ever taken ⇒ the arbiter stayed `free` ⇒ automation always won.** 22773766
fixed the engine split; panes attach, users type, claims flow — and the
orphan deadlock, latent since the arbiter landed (8c15a27b, WP4-A; never-steal
tightened in 43addc66/#40), became reachable in production the same day.

This is the same fragility class as #68's symlink hot-patch, inverted: a
safety mechanism (never-steal on human input) with no durable recovery path,
armed by an unrelated fix, failing silently.

## Live evidence (measured, not inferred)

Message rows, `/tmp/hv-a27e3d322a/hive.db` `messages` (fresh DB; daemon start
14:51Z — prior history was deleted by `make clean`):

| id | from→to | priority | state | created | evidence |
|---|---|---|---|---|---|
| 95ec3364 | queen→marta | steer | applied | 15:09:08Z | diagnostic `sessiond inject declined: claim denied: HumanOrphaned` at 15:10:04.8Z, then injected 15:10:07.186 = deliveredAt with applied +121 ms — the **steer hook-pull signature** (`delivery.ts:723-739`, steer claims mark `injected`; `confirmSteerAtToolBoundary` `delivery.ts:663-675`), which bypasses the arbiter. The denial 3 s earlier proves the arbiter was orphaned; the "success" does not contradict it. |
| e7d9a818, 3d6c0e18 | marta→queen | normal | applied | 15:16:19Z, 15:18:39Z | injected 15:20:37/38Z, applied 15:22:07Z — the tmux **root-wake path works** (tick-retry + turn-boundary flush). |
| abb209b4 | queen→marta | normal | **queued (stuck)** | 15:21:13Z | diagnostic `sessiond inject declined: claim denied: HumanOrphaned` at 15:22:37Z; marta was killed at 15:22:49Z; the row is permanently undelivered. |
| e63fc878 | hive-control→queen | normal | applied | 15:26:37Z | root wake healthy. |
| 04429812 | queen→nadia | steer | applied | 15:31:38Z | hook-pull signature again (injected→applied 104 ms). |

workspace.log (app pid 17245), local−4 converted:

- 15:04:23–15:10:10Z — six `hive claim: granted … viewer=workspace-pane-marta`
  events: the user typing in marta's pane. **Zero `release` lines appear in
  the entire log** — no claim was ever cleanly released
  (`releaseClaimBestEffort` silently no-ops when the transport is already
  gone, `AttachReplayClient.swift:219-237`).
- 15:21:31Z — diego spawns; pane layout changes (RESIZE 61x39→61x18);
  15:21:44Z `sessiond pane marta gave up after 6 attach attempts: host
  transport lost` — marta's viewer is gone for good, orphaning the claim.
  The daemon could still reach marta's host at 15:22:37Z (it received the
  HumanOrphaned denial from it), so this was a viewer-side loss, not host
  death.
- `attach grant refused: … no terminal-host binding`, `… no completed create
  evidence`, `… VERIFICATION_UNKNOWN` for freshly spawned diego/ingrid/nadia
  panes — the attach retry loop rides through the spawn race; nadia's pane
  attached and was claimed at 15:29:26Z and 15:32:41Z.
- `workspace visibility publish failed: HTTP 409` at 15:22:53Z and 15:28:57Z
  match diego's and ingrid's death timestamps to the second
  (15:22:53.573Z, 15:28:57.417Z). Queen killed those agents (and marta,
  SIGKILL — `final.json` exitSignal 9); a renewal for a just-killed host
  "fails closed" and the whole publish returns 409
  (`src/daemon/server.ts:2941-2969`). Symptom of the kills, not a cause.

Delivery topology (why only this lane broke): normal messages to Claude
sessiond agents have exactly one push channel — the arbiter-guarded terminal
inject. The "native control" fast path is codex-only
(`nativeControl` = `codexControl`, `src/daemon/server.ts:562`;
`delivery.ts:451,552`). Steer rides the tool-boundary hook pull, so it only
works while the agent is actively taking turns; to an idle agent with an
orphaned arbiter, steer sticks exactly like normal.

A live positive control is in flight: nadia sent herself a normal-priority
probe (row 01117404, idempotencyKey `nadia-selfprobe-inject-1`) at 15:43:50Z.
The user's 15:32:41Z claim on nadia's pane means the row resolves the
question either way: injected ⇒ that claim was released (Enter submits and
releases, `input_arbiter.zig:466-504`) and the arbiter wire works when free;
queued with a HumanOrphaned diagnostic ⇒ nadia's own pane is deadlocked too.
Read the row before trusting either conclusion.

## Rule-in / rule-out

**22773766 (poisoned-cache heal; app and sessiond share one engine) — ruled
in as the enabling change, not the defect.** It touched build wiring,
`workspace/Sources/HiveWorkspace/PaneView.swift` reattach behavior, and the
heal script; it contains no delivery code. Its effect is that viewer attaches
succeed for the first time, which arms the latent orphan deadlock: human
claims now actually happen and can be stranded.

**689bc0a0 (sessiond control-plane/kill-path hardening) — partially ruled in.**
It did not create the orphan state (that is 8c15a27b/43addc66, landed
earlier) and did not change the never-steal semantics; it also indirectly
*caused* the TUI outage that 22773766 fixed (patch series regenerated without
moving the vendored commit). Its per-connection absolute deadlines and
adoption-secret requirements are visible in today's logs only as attach-race
refusals (`VERIFICATION_UNKNOWN`, binding races) that the retry loop absorbs.
No evidence ties its authorization changes to the stuck row: the recorded
denial is the arbiter's, on a live, reachable, adopted host.

**65855caa (GhosttyKit cache publish decision) — ruled out for delivery.**
Footprint is Makefile + artifact publish/lock scripts + a publish test.
Build-time only; no runtime surface.

**d427d5db (Makefile four-target reduction) — ruled out.** Footprint is
Makefile/docs/scripts/tests; the only `src/` change is an error-message
string in `src/cli/daemon.ts`. Its commit message proves `make clean`
byte-identical via a filtered `make -n` diff.

**Process-level (make clean + kills) — contributing context, not the defect.**
`make clean` killed the previous instance and deleted the short HIVE_HOME, so
the current DB starts at 14:51Z (prior delivery history, including the ~15:16Z
positive control queen cited, lives only in the deleted DB). The instance id
is unchanged (`adc6ff7499` hashes HIVE_HOME `/tmp/hv-a27e3d322a`,
`src/daemon/tmux-sessions.ts:13-27`), sockets and DB were re-created
consistently; no component was found pointing at pre-clean state. Queen's
kills explain marta/diego/ingrid dying and the 409 noise, and killing marta
converted her stuck message from "deadlocked" to "moot".

**The #68 tmux socket-path split is FIXED and is not today's mechanism.**
The durable fix landed in 9c4edc53 (TMUX_TMPDIR removed from DEV_ENV;
root-message tick retry in `wakeIdleRecipients`, `delivery.ts:708-719`) and
survives d427d5db as the deliberate comment at `Makefile:132-134`. Measured
now: daemon env has no `TMUX_TMPDIR`; `.dev/tmux/` is empty; queen's server
listens at `/tmp/tmux-501/hive-adc6ff7499` (session
`hive-orchestrator-adc6ff7499`, attached); root wakes delivered at 15:20:37Z
and 15:26:37Z. The memory article
`issue-68-acceptance-failed-manual-enter-and-no-queen-wake` says "code fix
still open" — **that claim is outdated and wrong**; the constraint it records
(a daemon-only TMUX_TMPDIR splits the daemon from the launcher's tmux server
and kills every root wake) still holds and is still honored by the code.
(`bootstrap/hive-bootstrap` sets TMUX_TMPDIR, but it sets it for everything
it launches — launcher and daemon share it, so no split.)

## Fix spec (for the implementing agent)

Goal: queen→agent delivery either succeeds or fails loudly; an orphaned human
claim can never permanently wedge a recipient.

**1. sessiond: expose orphan resolution to the operator plane.**
Add a broker-role RPC on host.sock — `INPUT_ORPHAN_DISCARD` — following the
existing hardened broker verbs (adoption-secret-authenticated, like
`terminate`/`grant_register`/`visibility_renew`; see 689bc0a0's broker auth
in `session_host.zig`/`broker.zig`). It calls
`arbiter.operatorDiscard()` (already implemented and tested,
`input_arbiter.zig:637-665`: cancel-encodes the draft, zeroizes, frees input)
and `clearOrphanedClaim()` on the host core. Response reports prior owner
viewer/claim ids (the host retains them in `orphaned_claim`,
`session_host.zig:2580-2584`) so the caller can audit. Never-steal is
preserved: automation still cannot *resume* a draft; this is an authenticated
operator discard with an audit trail, the exact role `operatorDiscard` was
written for.

**2. daemon: bounded orphan recovery in the delivery path.**
In `SessiondViewerAgentInput.injectIdle`
(`src/daemon/session-host/sessiond-agent-input.ts`) or its caller
(`delivery.ts:902-937`): on `claim denied: HumanOrphaned`, consult the
broker's inspection (`SessionInspection.inputOwner`,
`src/daemon/session-host/terminal-host-contract.ts:260`) and the attach
state; if the orphan is older than a grace period (recommend 120 s, constant,
no config) and no live viewer is attached, issue `INPUT_ORPHAN_DISCARD`,
then retry the inject once. Record what happened on the message row either
way (`deliveryDiagnostic: "orphaned draft discarded after 120s; retrying"` /
`"orphan discard refused: <reason>"`). The grace period gives a returning
viewer time to resume; the discard destroys at most one unsubmitted draft in
a pane nobody is looking at — deliberately the right trade against a
permanently deaf agent.

**3. app: stop stranding claims.**
In `HiveTerminalView`/`AttachReplayClient`: release the claim on composition
end and on pane teardown even when the transport is degraded, and **log when
`releaseClaimBestEffort` skips** (today the `transport != nil` guard returns
silently, `AttachReplayClient.swift:220`). On successful re-attach to a
session whose arbiter reports orphaned-by-us, resume then release if the
local draft buffer is empty. This is hygiene, not the correctness anchor —
the app can always crash; item 1+2 are the anchor.

Correctness across clean/rebuild/restart: the RPC lives in sessiond's wire
protocol (versioned with the ABI; `header-standalone.c` has two compile
sites — run `test:sessiond`), the daemon policy is plain runtime code, and
nothing depends on filesystem state that `make clean` deletes. No
hot-patchable component remains in the loop.

## Hardening recommendations (ordered by payoff; separable)

1. **Loud failure on stuck deliveries (do first — smallest, broadest).**
   Maintenance tick: any message queued > N minutes (suggest 5) with a
   recorded `deliveryDiagnostic` and a live recipient triggers ONE
   `hive-control → queen` message naming recipient, message id, diagnostic,
   and age (idempotencyKey per message id — the alert wire is proven, row
   e63fc878). Also surface a `deliveryBlocked` flag + diagnostic in
   `hive_status` output. Size: ~½ day incl. tests. This alone converts every
   future silent-delivery failure of any cause into a visible event.
2. **Regression test that fails while the wake path is unresolvable.**
   (a) Arbiter/host level, `native/sessiond` zig tests + ts-live harness
   (`native/sessiond/test/ts-live-create.ts` pattern): create session, human
   claim, unclean viewer drop, assert automation inject is denied, assert
   `INPUT_ORPHAN_DISCARD` + retry delivers — the discard RPC's contract test.
   (b) Daemon level, `delivery.test.ts`: a sessiond recipient whose injector
   declines `HumanOrphaned` n times must produce the queen alert and, with
   the discard path stubbed, recover. Both run in `make test`. Include a
   positive control (inject succeeds on a free arbiter) so the deny
   assertions can't pass vacuously. Size: ~1 day.
3. **Implement the fix spec above** (RPC + daemon policy + app hygiene).
   Size: ~1–2 days including the zig wire test and ABI check.
4. **Startup/tick wake-path self-check.** On daemon start and every tick:
   for the root, the tmux socket file the wake would dial must accept a
   connection (this re-arms #68 detection); for each live sessiond agent,
   broker `list` must show the session running. Failure → same loud path as
   (1). Size: ~½ day.
5. **Stop letting claims outlive their requested lease.** Revisit the
   renewal clamp (`session_host.zig:3617-3623`): cap total claim lifetime at
   e.g. max(requested, 5 min) unless input arrived recently, so an abandoned
   draft decays to the expired-claim path instead of holding ownership for
   hours. Requires care with the legitimate slow-typist case; do after 1–3.
   Size: ~½ day.
6. **Route daemon delivery errors somewhere durable.** Two acceptance runs
   and this incident all lost the initiating error to a /dev/null stderr;
   `deliverNative`'s failure detail still only reaches `console.error`
   (`delivery.ts:650-655`). Minimum: append delivery-layer errors to a
   bounded per-instance log file under HIVE_HOME. Size: small.
