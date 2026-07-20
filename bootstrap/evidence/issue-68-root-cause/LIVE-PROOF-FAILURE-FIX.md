# #68 live-proof failure: root cause and fix (2026-07-20, follow-up to LIVE-PROOF-PROCEDURE.md)

The first live proof of the interim delivery wire failed on the 19:22 daemon:
message `3b869f2d-8595-4530-b860-de220afe5b41` (queen→james) stayed
`queued | deliveredAt NULL` across ~24 maintenance ticks, and the only
diagnostic went to a `/dev/null` stderr, leaving three candidate causes
indistinguishable from disk (held human claim / injector throwing / rejected
receipt). The prescribed live discriminator (close james's Workspace pane)
became unrunnable when james was killed at 23:38:50Z.

## The answer: cause 2 — the wire was broken, deterministically, every tick

Discriminated by running the REAL injector against the REAL engine
(`native/sessiond/test/ts-live-create.ts`, which spawns an actual broker and
session host): `SessiondViewerAgentInput.injectIdle` fabricated the neutral
host's `SessionRef` as

```
{ key: locator.sessionId, incarnation: String(locator.generation) }
```

and passed it to the **broker** `inspect` RPC. The broker addresses sessions
by its ENGINE-assigned incarnation, not the Hive locator generation, so the
very first RPC of every inject answered `SessiondWireError: NOT_FOUND` —
thrown, caught by `deliver()`, logged to the discarded stderr, envelope left
queued. Every tick, forever. A held human claim was never reached; the
never-steal path was innocent.

The subtlety that made this survivable-looking in review: **the two wires
disagree about what `SessionRef.incarnation` means.**

- Broker RPCs (`list`/`inspect`): engine-assigned incarnation. A
  locator-generation ref gets `NOT_FOUND`.
- Viewer-wire frames (`CLAIM_ACQUIRE`/`INPUT_SUBMIT`/`CLAIM_RELEASE`):
  generation→incarnation mapping (`session_host.zig` "Frozen A0 addresses
  the host by SessionRef; map generation→incarnation"; the working Swift
  reference client `AttachReplayClient` sends `String(locator.generation)`).
  An engine-assigned ref gets `GENERATION_MISMATCH` — verified by trying
  exactly that against the real engine while fixing this.

The unit tests were green through all of it because the injector tests mocked
`broker.inspect` and the fake viewer host accepted any incarnation — the
"two green suites, one broken wire" trap, caught only when the injector ran
against the real engine.

## What changed

1. **The wire fix** (`src/daemon/session-host/sessiond-agent-input.ts`):
   `injectIdle` resolves the session via the broker's own `list()` (keyed on
   `sessionId`; the returned inspection also answers lifecycle), and speaks
   to the host with the locator-derived ref. Both halves are now proven
   against the real engine on every `test:sessiond` run: the live harness
   performs a full daemon-side inject (grant → HELLO(viewer) → HOST_ATTACH →
   CLAIM_ACQUIRE(automation) → INPUT_SUBMIT) and asserts a real receipt.
2. **The observability fix** (the gap that made the live proof
   undiagnosable): every failed or declined inject now records its cause on
   the message row — `messages.deliveryDiagnostic` / `deliveryDiagnosticAt`
   (schema + migration for existing databases), cleared when delivery
   succeeds. Declines carry the arbiter's own diagnostic out, including the
   holder of a denying human claim and its lease expiry. One tick after any
   future stall, the cause is a `SELECT` away.
3. **Stale prose fix**: `hive_send`'s queued-explanation for idle sessiond
   recipients no longer claims "no daemon delivery wire yet (M2 #16)" — it
   now describes the wake-loop retry and points at `deliveryDiagnostic`.
4. `CLAIM_RELEASE` uses the same session ref the claim was granted under,
   instead of re-deriving it.

## Instrument notes (inherited from the live-proof report)

- macOS `nc -z -U` reports "refused" even against a working UDS — useless as
  a broker/host liveness probe.
- The daemon's stdout/stderr go to `/dev/null` in production; anything worth
  diagnosing must be persisted, not printed.

## Still required

A daemon rebuild + restart window, then LIVE-PROOF-PROCEDURE.md again. The
never-steal negative control in that procedure is unchanged and now
observable: while a human holds the claim, the row must stay queued with
`deliveryDiagnostic` naming the human holder — not silence.
