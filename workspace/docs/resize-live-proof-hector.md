# Actual-app live-resize input proof (2026-07-19)

## Outcome

The faithful app-level attempt did not reproduce a resize-caused input failure.
Input was already unavailable before the resize because the test Workspace
window could not become the key window in this GUI session. No product fix was
made from this result.

## Procedure

The proof ran the normal Workspace app created by the B22 `make terminal`
harness against a fresh broker, daemon, sessiond, and login zsh. It posted
in-process key events before and after a mouse-driven resize. The resize used
AppKit's modal mouse tracking path: a left-button down on the actual window's
resize corner, queued drag/up events, and `NSWindow.sendEvent`, with checks for
`willStartLiveResize`, `inLiveResize`, and `didEndLiveResize`.

The final run used port 43118:

```sh
HIVE_SMOKE_VISIBLE=1 \
HIVE_SMOKE_SESSIOND_LIVE_RESIZE_INPUT=1 \
make DEMO_PORT=43118 terminal
```

Port 43118 was assigned to this run at the time. It is now allocated to Horst;
future reruns must use the port currently assigned by queen rather than reusing
the historical command verbatim.

## Evidence

The final run's fresh harness directory was `/tmp/hb22-82bb`. Its Workspace
output recorded:

```text
frame (120, 80, 1280, 832) -> (120, 0, 1440, 912)
geometry 61x39 -> 70x43
input waitingForClaim
highWater 218 -> 218
```

The modal live-resize notifications, `inLiveResize`, live surface state, and
terminal first-responder checks passed. The combined resize assertion reported
failure because, although geometry changed, the outbound RESIZE counter did not
advance. Most importantly, the app window never became key, and the identical
pre-resize marker neither reached the terminal nor produced output. The
post-resize marker failed the same way. This run therefore supplies no causal
RED for resize; treating the post-resize failure alone as one would be a harness
artifact.

The durable fallback change correlates host resize receipts in
`AttachReplayClient`. That material was ported only from the reviewed immutable
source `geoff@519c5eb0`; neither Geoff's moving branch tip nor its unreviewed
`0d8e80e7` commit was used.

## Claim-path handoff for Hattie

The resize attempt exposed a likely earlier attach/claim defect:

- In the clean final run, both pre- and post-resize input stopped at
  `waitingForClaim`. That state is set only after `CLAIM_ACQUIRE` is written by
  `AttachReplayClient.beginClaimAcquire`; no correlated `CLAIM_RESULT` reached
  the client, no `INPUT_SUBMIT` followed, and output high-water stayed at 218.
- Two other fresh attempts (`/tmp/hb22-f0f5` and `/tmp/hb22-e7d5`) also ended at
  `waitingForClaim` with high-water 218. They lacked the pre-resize control and
  are corroboration only.
- An earlier reused-host attempt was invalid as a resize proof, but its claim
  evidence is still useful: the surface became lost after `MALFORMED_FRAME`,
  and a later acquisition was denied while the arbiter reported an orphaned
  human lease. Treat this as a lifecycle clue, not a clean reproduction.
- Henry's production-pump synthetic control completed the healthy sequence:
  `CLAIM_ACQUIRE` -> granted `CLAIM_RESULT` -> `INPUT_SUBMIT` -> input APPLIED,
  with PTY output advancing. Removing the receive pump left request 5
  unanswered on a closed transport, proving that version was a harness
  artifact.
- Hubert separately observed a blank pane on fresh attach while the host
  journal already contained bytes. That is not evidence from this run, but it
  may share the same missing host-to-viewer delivery boundary.

A healthy client consumes `CLAIM_RESULT` in
`AttachReplayClient.handleHostFrame`, drains the held input batch, and submits
it. The actual app's background receive/delivery boundary is
`SessiondPaneTerminal.startPump`. On the host,
`session_host.zig` maps `CLAIM_ACQUIRE` through `HostCore.claimInput`; an
existing active claim, expired visibility lease, missing binding/arbiter, or an
arbiter in `human_orphaned` produces denied/unknown rather than granted.

The next live probe should correlate one request ID across four points:

1. client `CLAIM_ACQUIRE` send, frozen binding/generation, and idempotency key;
2. host receipt plus active-claim, visibility-lease, `lease_current`, and
   arbiter state before `claimAcquire`;
3. encoded `CLAIM_RESULT` state/diagnostic on the host and receipt by
   `SessiondPaneTerminal.startPump`;
4. main-thread delivery into `handleHostFrame`, including whether request ID
   still equals `claimRequestId`.

That will distinguish a host-side orphan/lease refusal from a pump or
main-thread delivery loss without inferring state from a successful send.
