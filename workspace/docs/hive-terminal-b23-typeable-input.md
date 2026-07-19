# HiveTerminalView B2.3 — typeable input freeze candidate

Status: frozen for independent cross-vendor review at the pin reported with
this document. The author must not call `hive_land`; the next state transition
is review of this exact pin.

## Scope

This closes the B2.3 TYPEABLE milestone from the queen brief: Gate 8's existing
keyboard, NSTextInputClient IME, paste, and mouse encoders now feed the
authenticated B2.2 attach socket, acquire a synchronous human-input claim, and
submit frozen `INPUT_SUBMIT` transactions to the live session PTY. Correlated
`APPLIED` receipts and typed refusals are surfaced to the pane.

The reverse path uses the same exact `SurfaceBinding` as output. Each queued
encoder batch, claim response, request receipt, and pump callback carries that
binding. Retargeting closes the old transport and discards its pending input;
a response from a late connection cannot release bytes into the new one.

## Wiring

- `HiveTerminalView` retains Gate 8 as the sole encoder. Its existing
  `CallbackContext.onWrite` delivers the encoded bytes to `AttachReplayClient`;
  no key, IME, paste, or mouse encoding was duplicated.
- `AttachReplayClient` holds bytes until `CLAIM_ACQUIRE` returns a human claim,
  then sends a content-sensitive `INPUT_SUBMIT` JSON transaction containing
  the exact session key and incarnation, claim token, transaction/idempotency
  ids, and base64 bytes. It correlates the host's input `APPLIED` receipt.
- The Workspace attach grant requests `view`, `human-input`, and `resize`.
  Missing input authority is a local typed refusal; the host independently
  authenticates the one-use grant, operation set, exact generation, and claim
  token before its existing InputArbiter/PtyHost write path can run.
- `SessiondPaneTerminal` captures the transport's exact binding before its
  background pump starts. Main-queue delivery passes that captured binding
  into `HiveTerminalView`, rather than relabeling a queued old frame with the
  view's current generation.
- The existing B2.2 watch harness keeps its animated output and now also reads
  the PTY, returning `B2.3 RESPONSE:<typed-line>` for the live pane proof.

Atomic encoder writes above the frozen 128 KiB v1 transaction cap produce
`PAYLOAD_TOO_LARGE` and send zero claim/input frames. Host or receipt errors
produce `refused`/`unknown` input state and fence further writes until a fresh
attach.

## Blocking proof

- `AttachInputTests`: claim-before-input; exact-locator/claim/base64 payload;
  no legacy raw `HUMAN_INPUT`; correlated `APPLIED`; superseded-connection
  claim response releases zero bytes; oversize input is a typed refusal and
  emits zero input frames.
- `native/sessiond/test/real-host-golden.zig`: an authenticated attached viewer
  with a valid human claim submits the wrong incarnation and receives typed
  `GENERATION_MISMATCH`; the shell's byte-exact proof file contains only the
  later correct-generation transaction. The correct transaction reaches the
  real `/bin/sh` PTY and its response returns over ordered `OUTPUT`.
- `LiveHostAttachTests.testLiveGate8InputRoundTrip` (opt-in): production Swift
  UDS transport and `HiveTerminalView.insertText` drive Gate 8 -> claim ->
  `INPUT_SUBMIT` -> real sessiond PTY -> shell response -> ordered output,
  byte-verified as `B2.3 RESPONSE:b23-byte-round-trip`, with a correlated
  `written-to-terminal` receipt.

Recorded verification after the final rebase:

```text
swift test --filter 'AttachInputTests|AttachReplayTests|LateFrameRejectionTests'
  16 tests, 0 failures
HIVE_B22_PROOF_HOME=/tmp/hb23f43131 \
  swift test --filter LiveHostAttachTests.testLiveGate8InputRoundTrip
  1 test, 0 failures; production UDS/PTY round-trip passed
HIVE_NATIVE_CACHE=/Users/scottkellar/Projects/hive/.cache/native bun run test:sessiond
  passed (including wrong-generation positive control and correct round-trip)
bun test
  1725 pass, 10 opt-in skips, 0 fail
bun run typecheck
  passed
swift build
  passed
swift test
  395 tests, 4 skipped; only Gate6SurfaceRestoreTests failed because matching
  arm64 cross-library fixtures are absent. The identical two assertions were
  reproduced at current main f6782ad0 in a detached source-clean worktree with
  the same matching native artifact, so this is a proven pre-existing
  environment/artifact failure.
```

## Scott-watched proof

The automated live proof is complete. The remaining optional visual milestone
is ready for Scott: run `bun scripts/b22-live-attach-proof.ts`, click the real
sessiond pane, type a line, and observe `B2.3 RESPONSE:<line>` in that pane.
The existing advancing B2.2 ticker remains visible throughout.

## Review focus

1. Confirm every reverse-path operation is bound to the actual connection and
   exact session incarnation, including frames queued across a retarget.
2. Confirm denied, stale, malformed, oversize, and uncorrelated outcomes write
   zero additional PTY bytes and remain visible rather than silently retrying.
3. Confirm Gate 8 remains the only key/IME/paste/mouse encoder and no event can
   take a competing raw-input path.
4. Confirm claim/input authority is authenticated on the one-use attach grant
   and rechecked in the native host before InputArbiter/PtyHost.
