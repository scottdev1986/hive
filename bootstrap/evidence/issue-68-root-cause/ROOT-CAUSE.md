# Issue #68 — Root cause: sessiond-hosted sessions have no envelope delivery wire

**Author:** noah (writer) · **Date:** 2026-07-20 · **Anchors are section/function-level; files move, line numbers rot.**

## Falsifiable root-cause claim

Hive's redelivery machinery is complete and correct, but its **final primitive —
"push input bytes into an already-running session" — is implemented only for
tmux hosting.** For a `hostKind: "sessiond"` session there is no daemon-side
input wire, so every push path deliberately declines and leaves the envelope
`queued`. An idle agent produces no turn boundary of its own, so nothing ever
retries into a channel that could take it. The orchestrator (queen) shares the
identical gap and additionally has no tmux fallback at all.

This is falsifiable: if a daemon-side path could inject into a sessiond session
today, the code below would call it instead of returning the stored (queued)
message — it does not, and no such path exists in TypeScript.

### Where the daemon decides it cannot deliver (agents)

`src/daemon/delivery.ts` → `MessageDelivery.deliver()`. The sessiond branch:

```
if (recipient.sessionLocator?.hostKind === "sessiond") {
  requireSessiondAgentLocator(recipient);
  return this.getStoredMessage(message.id);   // honest: leave it QUEUED
}
```

This is reached from every push path — `send()` (idle recipient), `flushQueued()`,
`flushUrgent()`, `flushSteer()`, and the maintenance-tick `wakeIdleRecipients()`.
All of them funnel through `deliver()` and hit this wall. The diagnostic literal
`queuedDeliveryNote()` states the cause to the sender ("…no daemon delivery wire
yet (M2 #16)…").

### What "delivery at a turn boundary" meant under tmux, and what is absent

Under tmux hosting, `deliver()` calls `sessions.sendSessionMessage()` →
`BunSessionSender.writeAutomated()` → `TmuxSessionHost` → `tmux send-keys`
(paste + Enter) into the agent's TUI pane. That is the injection primitive.
"Turn boundary" is the moment the TUI submits the pasted text and the model
starts a turn; `reconcileInjected()` later confirms `injected → applied` by
reading the agent's own turn-boundary events (`turnBoundaryAt`).

For sessiond hosting the equivalent primitive is **INPUT_SUBMIT over the
per-session neutral-host viewer wire** — and it does not exist on the daemon
side. `SessiondHost.submitInput()`/`claimInput()` are shaped correctly but call
`this.connectDirect(session)`, which in **both** production constructors
(`src/cli/daemon.ts` `new SessiondHost({...})` and `src/daemon/server.ts`
`new SessiondHost({...})`) is the default stub that throws
`SessiondWireNotReadyError("direct host operations")`. `CoexistingSessionSender`
makes the same refusal explicit for the delivery path.

### Why an idle session "reaches no turn boundary"

The only thing that starts a turn for an idle Claude agent is input submitted
into its TUI. Redelivery triggers (`flushQueued` on session-start/turn-end,
`flushUrgent` at a tool boundary) all hang off the agent's own activity — things
a *working* agent does. A finished/idle agent makes no tool calls and reaches no
boundary, so the queued envelope is retried by nothing. The daemon already
recognises this and added `wakeIdleRecipients()` (maintenance tick) to do the
waking itself — but that path also terminates at the sessiond wall in
`deliver()`, so for sessiond hosting the wake is a no-op.

### Queen (orchestrator) shares the gap, and fails harder

Queen has no agents row; her wake goes through `wakeOrchestrator()` →
`deliverRoot()` → `rootProtocol.deliverMessage()`. In production `rootProtocol`
defaults to `OrchestratorRootDelivery` (`src/daemon/orchestrator-root-delivery.ts`),
which pastes into `orchestratorTmuxSession()` via **tmux**. In an all-sessiond
environment there is no tmux server at all, so this paste has no target and the
wake silently fails (`.catch(() => false)` → stays queued). Queen therefore
receives **no** wake injection — matching the issue exactly. The same missing
sessiond viewer wire is the fix home for the root as well.

## Live verification (against the running daemon, HIVE_HOME=/tmp/hv-a27e3d322a)

All six spawned agents this instance are `hostKind: "sessiond"`, `tool: claude`.
No tmux server is running (`tmux ls` → socket absent). Message states in the live
DB confirm the defect on the documented instances:

| id (prefix) | from → to | state | note |
|---|---|---|---|
| `126d8ab6` | queen → james | **queued** | never delivered (documented stuck msg) |
| `dd72612a` | queen → james | **queued** | never delivered |
| `28594d81` | hive-lifecycle → zoe | **queued** | never delivered |
| `b00caeed` | sam → queen | applied | only via human-prompted `hive_inbox` poll |
| `8a9db404` | james → queen | applied | only via human-prompted `hive_inbox` poll |
| `2f648bd1` | zoe → queen | applied | only via human-prompted `hive_inbox` poll |

The agent→queen reports reached `applied` **only** because a human prompted queen
to poll `orchestratorInbox()` (the pull path) — not because any wake injection
fired. The queen→agent messages, which have no pull path an idle agent would run,
sat `queued` permanently. This is the liveness gap, reproduced live with no
instrumentation required.

## Engine/wire status (why the fix is not a small patch)

- **Engine side is landed and tested**, but input is accepted **only over an
  attached *viewer* stream**: `session_host.zig` `handleViewerFrame` dispatches
  `CLAIM_ACQUIRE`/`INPUT_SUBMIT` after a viewer `HELLO(viewer)` + `HOST_ATTACH`
  one-use grant. The broker-authenticated adopt path (`serveBrokerRequest`)
  returns `unsupported_frame` for input — so the daemon cannot inject over its
  existing broker connection.
- **The broker does not proxy input.** `broker.sock` accepts only
  create/list/inspect/terminate/visibility-renew/attach-request. Its only role
  for input is to mint a one-use `ATTACH_GRANT` whose `endpoint` is the session's
  own `host.sock`.
- **No TypeScript viewer-attach client exists.** `issueAttach` (grant minting) is
  landed, but nothing on the TS side consumes a grant, connects to `host.sock`,
  performs `HELLO(viewer)`+`HOST_ATTACH`, or sends `CLAIM_ACQUIRE`/`INPUT_SUBMIT`.
  The viewer wire is proven end-to-end **only in Swift**
  (`workspace/Tests/HiveTerminalKitTests/LiveHostAttachTests.swift`).

## Scope determination

The only daemon→idle-sessiond-session input channel is the **neutral-host
viewer-attach wire**: mint grant → connect `host.sock` → `HELLO(viewer)` +
`HOST_ATTACH` (with replay cursor; host then streams `SNAPSHOT`/`OUTPUT` under a
high-water/checkpoint handshake) → `CLAIM_ACQUIRE` → `INPUT_SUBMIT`. Building that
TS client **is** the core deliverable of **M2 #16 ("message delivery over the new
spine with measured receipt")** — and "measured receipt = Hive watched it render"
(terminal-ownership methodology, ACT bucket) is literally reading the `OUTPUT`
stream that same attach establishes.

There is no lighter landed channel:
- broker-adopt rejects input (`unsupported_frame`);
- the broker does not proxy input;
- there is no Codex-style native side channel for Claude;
- an idle agent runs no `hive_inbox` pull, so the pull path cannot substitute.

A partial viewer client that skipped the `OUTPUT`/high-water handshake would be
protocol-fragile (the host backpressures/drops an unacknowledged viewer) and would
be exactly the surface #16 must own — it would **fight** #16 rather than compose
with it. Therefore, per the assignment's explicit instruction, the minimal fix
**genuinely requires M2 #16 scope**, and I am stopping at the root-cause report
rather than scope-creeping a fragile half-spine.

## Recommended minimal slice for #16 to build first (so liveness lands early)

If the user wants an interim wire ahead of full #16, the smallest honest slice is:
1. A TS neutral-host **viewer-attach client** (reusing `SessiondSocketClient`
   framing) that consumes an `issueAttach` grant and completes
   `HELLO(viewer)`+`HOST_ATTACH`, including minimal `OUTPUT` high-water
   acknowledgement so the host does not backpressure.
2. Wire it into `SessiondHost.connectDirect` so `claimInput`/`submitInput` work.
3. Route `MessageDelivery.deliver()`'s sessiond branch through claim → submit →
   release **only at `status === "idle"` and no human composer lease** (existing
   gates), marking `injected` (never fabricated `applied`).
4. Add a sessiond `rootProtocol` for queen using the same client against the root
   session, replacing the tmux-only `OrchestratorRootDelivery` when hostKind is
   sessiond.
5. Reuse the existing `reconcileInjected` turn-boundary confirmation for
   `injected → applied` — defer the stronger "watched it render" receipt to full #16.

Delivery-state honesty holds throughout: `queued → injected` on `INPUT_SUBMIT`
acceptance; `applied` only on a measured boundary; never a fabricated `applied`.
This composes with #16 (which adds render-measured receipt, per-vendor semantics,
interrupt on the spine, and the composer-lease transaction migration) rather than
fighting it.
