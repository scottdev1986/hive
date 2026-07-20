# #45 final-gate execution — machine-runnable items

Executed by Henrietta (Claude), 2026-07-20. Both items below are the
machine-runnable half of issue #45. The remaining items (human captures, live
resize-and-type, C2 clean-machine) are user- or future-gated.

Per #45's rule, every claim here points at an artifact a reviewer can open.

## Item 1 — Live b22 dead-broker Ctrl-C re-run — **DISCHARGED**

The exact user-reported scenario from the start of the campaign, deferred at
#41's closure by Harold's review ruling and never re-exercised end-to-end.

- Evidence: `raw/qualification/hive-b22-dead-broker-ctrlc/` — probe capture with
  before/after `ps` (`probe-run-1.txt`, `probe-run-2.txt`), the harness's own
  transcripts (`harness-transcript-run-1.txt`, `harness-transcript-run-2.txt`,
  which corroborate the capture independently), `provenance.txt`, the probe and
  identity helper, and `evidence-sha256.txt` (verifies `OK` for all seven,
  excluding itself).
- Two independent runs, distinct broker pids (51305, 52690), identical result.

Scenario, per run: fresh `make terminal DEMO_PORT=43122` (real interactive
`/bin/zsh -l`, Workspace app launched, `HIVE_B22_NO_APP=0`, unlocked Aqua
session) → SIGKILL the sessiond broker out from under it mid-run → Ctrl-C the
harness.

Required result and what was measured:

| Requirement | Measured |
|---|---|
| clean orderly exit | `shutting down (SIGINT)` → `daemon stopped; session torn down`, deliberate `process.exit(130)` |
| no refusal wedge | `daemon.stop()` **succeeded**; the `daemon stop refused` branch was never entered |
| no reconciliation spam | reconciliation lines: **0**; exactly **one** `SessiondBrokerUnavailableError` line total |
| no leaked processes | zero surviving processes referencing the run's `HIVE_HOME` |
| first Ctrl-C only | exit after **1s**; no second signal sent |

The no-wedge result is `16908cc1` working as designed: with the broker dead,
`daemon.stop()` treats an unreachable broker as an already-dead session rather
than a refusal, so teardown completes instead of wedging. The single
unavailability line is the visibility renewal noticing the dead broker once —
the failure is observed, not retried into a storm.

### Identity discipline

The brief required the broker be re-identified by evidence at kill time, never
from a remembered pid. The probe connects to the live `broker.sock` and reads
`LOCAL_PEERPID` — the kernel's own answer to which process is bound right now —
then **positive-controls that identity against `ps comm` and refuses to signal
anything that is not `hive-sessiond`**. A dead-broker re-run that kills the
wrong process proves nothing, and other agents had their own brokers running on
this machine throughout (see `probe-run-1.txt`'s BEFORE snapshot).

For the same reason the leak assertion is scoped to this run's `HIVE_HOME`
rather than a global process count: a global count would charge other agents'
brokers to this run, or hide this run's leak among theirs.

### Isolation from F6 (helen's known app-mode Ctrl-C defect)

The b22 harness has a separate known defect — F6, a two-teardowns race on the
app-mode Ctrl-C path that can leak the session with a forced-exit line. Neither
run entered it: `HIVE_SMOKE_SESSIOND_LIVE_RESIZE_INPUT` was **absent** from the
environment for both (verified with `env`), so the branch at
`b22-live-attach-proof.ts:376` was skipped and teardown ran solely through the
SIGINT handler.

Worth stating precisely, because the gate is `!== undefined`: setting that
variable to `0` or to the empty string still **enters** F6's branch. Only
genuine absence skips it. Neither run showed a forced-exit line or a leaked
session, so nothing here contradicts or re-derives F6 — the dead-broker gate
proven above is a different path, and F6 remains open for hector.

Two probe defects were found and fixed before the recorded runs, both of which
would have produced a misleading result:

1. The home was parsed from a string that only appears in the transcript file,
   not on stdout — the probe declared SETUP FAILED while the run was in fact
   healthy.
2. The leak check was initially global rather than run-scoped.

## Item 2 — AppKit/Metal real-renderer main-thread proof — **DISCHARGED**

The #45 item reads: *Gate 3 row E carve-out, coupled to Gate 7. Engine + host
row E is closed on main; the real-renderer half is not demonstrated.* Verified
that Hilda's landed Gate 7 slice discharges exactly that, as written.

- Evidence: `raw/qualification/ghostty-b1-gate7-physical/main-thread-admission.txt`
  (tracked; matches its `evidence-sha256.txt` entry —
  `d6295415ca22aaf83d556e40161501407f9fb9dbb56ac4b3083621d36ea6aa66`, verified).
- Artifact binding: `artifact-binding.txt` (`mismatches=0`) and
  `artifact-binding-controls.txt`.
- Mutation verification: `workspace/docs/ghostty-gate7-physical-cross-vendor-review.md`
  §"Mutation controls"; F3 fix in `3cb46484`, delta-verified PASS in `4d7764b2`.

What the artifact proves: a **real** Ghostty IOSurface-backed layer
(`layerClass: IOSurfaceLayer`, `layerIsIOSurface: true`) driven through
create → present → free with `drawCount: 1` and
`hasPresentedContents: true` — a real renderer that actually presented, not a
seam and not a fabricated `CAMetalLayer`.

Why the main-thread half is genuine rather than tautological:

- Production `ManualSurface.swift` arms `dispatchPrecondition(.onQueue(.main))`
  on ~15 wrapper entry points plus
  `precondition(Thread.isMainThread, …)` at creation
  (`ManualSurface.swift:428`). The probe drives a live surface through
  create/present/free with those preconditions **armed** — that is the
  enforcement.
- The mutation control bites: moving creation off the main thread gives
  `REAL_EXIT=133` (SIGTRAP), `Precondition failed: LiveSurface must be
  constructed on main`, and the protocol never reaches the
  `main-thread-admission` stage, so `assert_protocol` fails the runner closed.
- `onMainHelperUsed: false` records that create/present/free were **not**
  wrapped in the dispatch-to-main helper, so the readings are not self-fulfilling.

This last point is why the item discharges *now* and would not have before.
Review finding **F3** had established that the earlier artifact recorded
constants rather than observations: `layerClass` was a hardcoded string literal,
and the three main-thread booleans were assigned *inside* `onMain { … }`, making
them tautologies that could never read false. `3cb46484` fixed the derivation —
`main.swift:242` now emits the observed `presentEvidence.layerClass`, and
`pthread_main_np()` is recorded alongside `Thread.isMainThread` as an
independent second reading. The artifact was genuinely regenerated, not merely
re-attested: its field names (`createPthreadMainNp`, `onMainHelperUsed`) do not
exist in the pre-fix shape.

Artifact selection is itself positive-controlled — the failure mode that once
cost Gate 3 a NO-LAND, where every green claim was unattributable because the
selection step accepted any binary. `artifact-binding-controls.txt` records
three controls all failing closed: missing manifest (`exit_status=1`), tampered
patched-tree (`exit_status=1`, 2 mismatches), and swapped library
(`exit_status=1`, detects a different library sha256). The real binding reports
`mismatches=0` against the pinned tuple (Ghostty `73534c46`, patch series
`ddeaf792`, Zig `3cc2bab3`).

## Not claimed

- Gate 7's two restored OPEN rows (Instruments minimized/after-wake, ASan)
  remain open; nothing here touches them.
- The three Gate 7 `PENDING_HUMAN` slots and the live human resize-and-type
  acceptance are human-gated by nature.
