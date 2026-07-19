# HiveTerminalView B2.2 — attach + live output (the first watchable frame)

Status: frozen for cross-vendor review. The author must not call `hive_land`;
the next state transition is an independent cross-vendor review at this exact
pin.

## Contract source

Implements the story's [B2.2 build row](../../planning/story-m1-b2-hive-terminal-view.md#build-increments-and-review-pairs)
("Exact grant/binding, manual output ingestion, checkpoint/replay,
acknowledgements, first-correct-frame, retarget fencing, typed gaps/failures,
exit/reap") and [Session attachment, replay, output, and exit](../../planning/story-m1-b2-hive-terminal-view.md#session-attachment-replay-output-and-exit),
scoped by the queen brief to ATTACH + OUTPUT: the user can WATCH a terminal
render; typing is B2.3. The locator fence is built input-ready: a wrong or
superseded generation neither draws nor can later receive input (the grant
binds viewer identity, operations, and geometry; HOST_ATTACH re-fences by
exact locator before token evaluation).

## What landed where

**Contract (src/schemas/session-protocol.ts).** The §20 viewer→host output
acknowledgement is frozen as the third `AppliedPayloadSchema` branch
(`resultKind: "output"`, `throughSeq` decimal-u64). Conformance corpus and
count freeze updated; all three language projections regenerate from the same
source.

**Native host (native/sessiond/src/session_host.zig).** The deferred
snapshot/output serve now exists:

- `beginViewerStream` — after viewer authorization, a cursor below the
  retained journal start receives the newest verified HVTCP001 checkpoint
  envelope as correlated `SNAPSHOT_BYTES` chunks; every retained byte after
  the effective base replays as ordered `OUTPUT` (stream_seq = absolute byte
  offset, chunked at the negotiated bound). A cursor that neither journal nor
  checkpoint can bridge is a typed `CHECKPOINT_UNAVAILABLE` failure.
- `AttachedViewer` — one live viewer stream owned by `runHostLoop`; new PTY
  bytes push each loop iteration, paused while the unacknowledged window
  exceeds the negotiated `viewer_queue_bytes`. Inbound frames (output APPLIED
  acks, claim/input/resize requests) dispatch from the same loop with a
  per-iteration bound so a chatty viewer cannot starve the PTY pump.
- §26 retarget: a later successful attach for the same exact generation
  supersedes the previous connection (closed by the host). A wrong-generation
  `HOST_ATTACH` is a typed `GENERATION_MISMATCH` refusal
  (`error.AttachLocatorMismatch`) before any grant/token evaluation.
- PTY close pushes the journaled tail to the attached viewer before the
  endpoint closes (§20 drain).

**Broker (native/sessiond/src/broker.zig).** `ATTACH_REQUEST` now dispatches
to `ProductionBackend.issueAttach`: mints a one-use token, registers only its
hash on the live exact-generation host (visibility-gated by
`Registry.registerGrant` → real `grant_register` RPC), and returns the frozen
`ATTACH_GRANT` (endpoint = host socket path, expiry, engine build id,
checkpoint/output seqs — informational broker-record snapshots; the host
serves the truth).

**Daemon (src/daemon/...).** `SessiondHost.issueAttach` speaks
ATTACH_REQUEST/ATTACH_GRANT over broker.sock; `HiveTerminalHostAdapter
.issueAttach` fences on the exact completed binding (unknown or incomplete
locator refuses loudly — no vacuous grants) and verifies the returned grant's
locator and engine against the binding. `POST /agents/<name>/attach-grant`
(action `terminal:observe`) refuses a stale generation with the same typed
`session-locator-mismatch` shape as kill; `hive workspace-attach` prints the
grant as JSON for the Workspace renderer.

**Workspace (workspace/Sources/...).** `UdsHostTransport` is the production
`HostTransport` (blocking UDS + FrameCodec, per-connection id for §26).
`AttachReplayClient.sendApplied` emits the frozen output-ack branch with its
own request ids (the native header validator refuses response-flagged id-0
frames). `HiveTerminalView.pumpHostFrame` applies live post-attach frames
through the locator-fenced client. `SessiondPaneTerminal` drives a pane's
renderer by the pane's EXACT `sessionLocator` — never a name lookup — with a
client-side grant/locator equality check, a background frame pump, and
re-attach at the acknowledged high-water on transport loss. A pane whose
locator has `hostKind == "sessiond"` hosts a `HiveTerminalView`; tmux panes
are untouched; renderer detach never claims close.

## Defects found and fixed on the way

1. **Broker recovery vs live output** (`adoptionMatches`): the launch-time
   `record.json` freezes `outputSeq=0`, and adoption required exact equality
   with the live readback — so daemon-restart recovery QUARANTINED any
   session that had ever produced output. Progress counters now compare
   monotonically (readback ≥ record; regression still fails closed). Unit
   test + golden banner leg; both mutation-verified red.
2. **Broker↔daemon handshake hang** (`loadDaemonHandshake`): the broker read
   the daemon's `/handshake` to EOF, but Bun.serve keeps the connection alive
   even with `Connection: close` — every real-daemon broker authentication
   timed out (`WouldBlock`). Prior proofs used a fake handshake server that
   closed explicitly, so the real pairing had never been exercised. The
   reader now stops at the framed Content-Length body (EOF still honored);
   the daemon endpoint also sets `connection: close`. Unit-tested.
3. **Engine identity across optimize modes**: the engine build id hashes
   `slow_runtime_safety`, so a Debug sessiond refuses a ReleaseFast renderer
   (M3 fence fired in the live proof — fail-closed working as designed).
   Both sides must ship the same optimize mode; the live proof builds
   sessiond ReleaseFast. Recorded here because a dev-built Debug sessiond
   will refuse the production renderer by design.

## Blocking proof

- `native/sessiond/test/real-host-golden.zig` (runs in `bun run
  test:sessiond`): real broker → real host → real `/bin/sh` provider. New
  legs at the §20 wire: pre-attach banner REPLAY from afterSeq 0; live push
  of input-echoed output; frozen output-ack APPLIED (duplicate acks harmless,
  over-ack fails closed); wrong-generation HOST_ATTACH → typed
  `GENERATION_MISMATCH`, zero output bytes, connection closed, live viewer
  undisturbed; broker-issued one-use grant drives a second attach whose
  replay is byte-identical (`ReplayDiverged` guard) and supersedes the first
  connection. `ViewerReader` asserts §20 contiguity on every OUTPUT frame.
  Positive controls: adoption-equality revert and stream_seq off-by-one both
  turn the suite red.
- `workspace/Tests/HiveTerminalKitTests/LiveHostAttachTests.swift` (opt-in
  via `HIVE_B22_PROOF_HOME`, run against `scripts/b22-live-attach-proof.ts`):
  the PRODUCTION Swift wire path (`UdsHostTransport` + `AttachReplayClient` +
  `HiveTerminalView` fencing, fake engine standing in for Ghostty) against
  the real host. Proves grant → attach → first-correct-frame; live ordered
  output reaching the surface; wire-vs-disk digest equality (surface bytes ==
  host `journal.bin` bytes); renderer recreation re-attaching the SAME exact
  generation at the acknowledged high-water with the old connection
  superseded; typed wrong-generation refusal. Recorded run:
  `bootstrap/evidence/m1-b2-b22-attach/live-host-attach-test.txt`.
- Suites: conformance 8/8; bun 1725 pass / 10 live-account skips / 0 fail;
  `tsc --noEmit` clean; native sessiond suite green (golden included); Swift
  374 tests with 13 failures that are the pre-existing environmental
  real-surface set — proven identical (branch ⊆ main) on an unmodified main
  scratch checkout with the same staged artifact; cause is production-config
  surface creation without an unlocked GUI session (no CVDisplayLink), not
  code.

## The watchable recording

`scripts/b22-live-attach-proof.ts` stands up the complete real stack (broker,
in-process real daemon, one manually-created sessiond session running an
animated color ticker — M1 black-box, NOT M2 spawn) and launches the real
Workspace app; the pane for the session carries the exact sessiond locator
and renders through the new wiring. The machine was at the lock screen for
this entire session (verified by screenshot), and production surface creation
requires the unlocked GUI session, so the screen recording could not be
produced headlessly. Everything up to pixels-on-glass is proven by the live
wire test above; the recording is one command with the user present:

```sh
bun scripts/b22-live-attach-proof.ts   # boots stack + app; Ctrl-C tears down
```

## Residuals (named, not hidden)

- The watchable screen recording awaits an unlocked user session (above).
- The harness sustains the visibility lease itself (its own publisher
  identity). The real Workspace's own publications renew only sessions whose
  create was bound to the Workspace's identity — that binding arrives with
  M2 spawn integration; B2.2's brief is a manually-launched session.
- Host inbound handling still trusts same-uid viewers not to stall mid-frame
  (bounded by the lease-derived socket timeout); flow control beyond the
  viewer-queue pause (REBASE on overflow) is later B2 work with the 100 MiB
  stress fixture.
- `checkpointSeq`/`outputSeq` in ATTACH_GRANT are broker-record snapshots and
  may lag the host; clients start from their own cursor and the host serves
  the truth.
