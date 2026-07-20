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
HIVE_SMOKE_SESSIOND_LIVE_RESIZE_INPUT=terminal \
make DEMO_PORT=43118 terminal
```

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
