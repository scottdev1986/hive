# Production sessiond lifecycle — round-five cross-vendor review

- Author: Helga (Grok). Reviewer: Henrietta (Claude), replacing Horace (Codex,
  crashed mid-round-four at `fac2db0b`).
- Briefed pin: `e2b299088d900702d758ad569b448d03450ce178` — **NO-LAND** (hole 6).
- Reviewed and cleared tip: `950bdf1975288054e76eec00bb3d112dfa8ec819` on
  `hive/helga-fix-two-review-blockers-on-the`.
- History: `production-sessiond-lifecycle-cross-vendor-review-horace.md` (rounds
  one through three). Rounds four/five holes were never written up — Horace
  crashed before landing that doc.
- Method: each commit materialized detached and verified clean; every probe run
  against staged real binaries; all recorded statuses are real process exit
  codes, never a pipeline's.

## Verdict: **PASS at `950bdf19`** — clear to land

The kernel-bound redesign holds. All five prior holes stay dead, and I confirmed
them against the real gate rather than the test encodings. One new blocker —
hole 6 — was found on the briefed pin and is fixed at the reviewed tip.

## Hole 6 (found on the briefed pin `e2b29908`, fixed at `950bdf19`)

The new ordering writes `daemon.port` before `sessiondBroker.start()`, which is
structurally the advertise-then-fail shape Horace's B2 forbade. It was not merely
a transient advertisement — it was worse than the original B2.

Staged orphan probe at `e2b29908` (real orphan broker owning `broker.sock`):

```text
orphan pid:  73172 (owns broker.sock)
daemon exit: still-running          <-- required: non-zero
daemon.port: PRESENT -> 43122       <-- required: absent
daemon.pid:  PRESENT -> 73201
advertised port answers: YES (live)
daemon alive after startup: yes
stderr: hive: hive-sessiond serve exited 1 before kernel peer ownership of
        broker.sock was proven for child pid 73212 (last ready error:
        broker.sock kernel peer pid 73172 is not the owned child 73212)
```

The ready-gate itself worked perfectly — it detected the peer mismatch and
refused. The failure was downstream: `await sessiondBroker.start()` sat outside
any `try`, so the rejection unwound to `src/cli.ts:900`, which prints and returns
1. But `daemon.start()` had already created a `Bun.serve` listener holding the
event loop open, and nothing called `daemon.stop()`. So `process.exitCode = 1`
was set and **never taken**: the daemon ran on indefinitely as a brokerless
daemon still answering `/handshake` on an advertised port.

That is strictly more dangerous than Horace's original B2, where startup at least
completed and failed asynchronously. Here the failure path is indistinguishable
from the success path — my normal-load control produced the identical
`still-running / port live` reading. A daemon in this state accepts work it can
never service.

Helga independently measured the same defect and fixed it in `950bdf19` while
this review was running; my measurement above was taken before that message
arrived, so the two derivations are independent.

The fix wraps the whole `start()` call: stop broker, stop daemon,
`cleanupLifecycleFiles()`, then `process.exit(1)` — the explicit exit being the
load-bearing part, since it is what defeats the `Bun.serve` event-loop hold.
Because one `catch` wraps the entire call, cleanup is path-independent by
construction: timeout, child-exit, and already-started rejections share it.

Re-measured at `950bdf19`:

```text
orphan pid:  82679 (owns broker.sock)
daemon exit: 1
daemon.port: absent
daemon.pid:  absent
daemon alive after startup: no
stderr: sessiond broker failed to start: ... kernel peer pid 82679 is not the
        owned child 82719
```

Normal-load control at the same commit still comes up healthy and serving, so
the fix does not cost the success path.

### Every broker-failure route reaches the same cleanup, not just orphan-reject

The staged orphan probe and Helga's `startup-fail` test both exercise only the
child-**exit** route (`BrokerAlreadyRunning`), where the child is already dead by
the time cleanup runs. The HELLO-failure and ready-timeout routes differ in a way
that matters: the child is still **alive** at failure, so `sessiondBroker.stop()`
must kill a live child and `daemon.stop()` must not hang before
`process.exit(1)` — a hang there would resurrect hole 6 exactly.

Probed with a fake sessiond injected via `HIVE_SESSIOND_BIN` that binds the real
`broker.sock` (so the peer gate legitimately **passes**) and then stays mute and
alive, forcing the ready-timeout route:

```text
control:      fake sessiond WAS used (as pid 14555)
daemon exit:  1  (after 15s; ready timeout is 10s)
daemon.port:  absent
daemon.pid:   absent
daemon.lock:  absent
daemon alive: no
leaked fake broker children: 0
stderr: sessiond broker failed to start: ... did not prove kernel ownership ...
        within 10000ms (last ready error: sessiond HELLO request timed out)
```

Same cleanup, same exit 1, and the live child is reaped rather than leaked.
Connect-timeout converges on this same throw site — a failed connect is retryable
and ends at the identical deadline throw — so the two teardown-relevant shapes
(child-dead and child-alive) are both measured. Combined with the single `catch`
wrapping the whole `start()` call, every broker-failure route is covered.

The `control:` line is load-bearing. On the first run I had not made the fake
executable, so `resolveSessiondBinary` rejected it, the daemon silently fell back
to the real staged sessiond, and it simply started up healthy — a reading that
superficially looks like a hole but was purely a probe defect. The probe now
aborts as unattributable unless the fake's own stderr proves it was spawned.

## The five prior holes — all dead, verified against the real gate

Helga encoded all five as unit tests, and they pass 12/12. But four of those
encodings inject a **stubbed** `proveReady`, so they exercise the supervisor loop
rather than the kernel gate. They are legitimate loop tests — a stamp-shortcut
implementation would still resolve and fail them — but they cannot by themselves
establish that the kernel gate refuses. So I re-derived holes 3 and 5 against the
real default `proveReady` (connect + `LOCAL_PEERPID` + HELLO), no seam:

| Composition | lock staged as | stamp | Result |
|---|---|---|---|
| Hole 3 — opener counted as holder | opened, no flock | `== child pid` | rejected |
| Holes 3/4 — real kernel lock held | genuine `LOCK_EX` (rc=0) | `== child pid` | rejected |
| Hole 5 — exact shape | **no lock ever taken** | `== child pid` | rejected |
| **Positive control** | none | — | **passed peer gate**, failed at HELLO |

Every rejection cited `broker.sock kernel peer pid 50751 is not the owned child
54993`. The positive control is what makes those three attributable: with the
child pid set to the socket's real binder, the gate is passed and the failure
moves to `sessiond HELLO request timed out`. Without it, a broken probe would
report "hole dead" three times for the wrong reason.

Holes 3, 4 and 5 are dead structurally, not just behaviorally: the implementation
contains no `lsof`, no lock read, and no stamp read. Their inputs are no longer
consulted at all. `broker.lock` is demoted to the broker's internal exclusion and
the stdout announce to debug, exactly as the redesign directed.

- **Hole 1** (stale base reverting `16908cc1`): `16908cc1` is an ancestor of the
  pin, and `teardown.ts` / `teardown.test.ts` are byte-identical to `main`.
  Heidi's matrix passes 92/92 — the regression guard bites.
- **Hole 2** (250ms settle counted as ownership): `OWNERSHIP_SETTLE_MS` is gone;
  readiness is a deadline-bounded poll that only ever returns on a proven peer.

## Other brief items

- **Foreign-bound socket** → peer-pid mismatch with a clear error naming both
  pids. Confirmed live in my re-derivation and in the 12/12 encoding.
- **`LOCAL_PEERPID` reproduces**: `SOL_LOCAL=0`, `LOCAL_PEERPID=0x002`,
  `getsockopt` rc=0, peer equals the bound process. My positive control read the
  binder's pid off a live connection; the live suite reads it off the real broker.
- **Crash recovery / no hang**: staged proof killed broker 92217 and had 92360
  serving with the socket restored in ~470 ms, so the 500 ms connect timeout
  cannot wedge recovery on a stale post-SIGKILL socket.
- **No spin past the deadline**: the retry loop is `while (now() < deadline)`;
  connect is capped at 500 ms and HELLO carries its own request timeout
  (`sessiond-host.ts:318`). Every retryable branch is individually bounded.

## Suites at `950bdf19` — real exit codes

| Check | Result |
|---|---|
| `sessiond-broker.test.ts` (unit) | 12 pass / 0 fail, exit 0 |
| `sessiond-broker.startup-fail.test.ts` (residual) | 1 pass / 0 fail, exit 0 |
| `sessiond-broker.live.test.ts` | 3 pass / 0 fail, exit 0 |
| teardown + server (Heidi, hole-1 guard) | 92 pass / 0 fail, exit 0 |
| independent hole 3/5 re-derivation | 0 holes alive, control valid, exit 0 |
| staged orphan ordering probe (child-exit route) | exit 1, nothing advertised |
| HELLO-failure / ready-timeout route (child alive) | exit 1, nothing advertised, 0 leaked children |
| normal-load control | healthy, serving |
| `bun scripts/sessiond-lifecycle-staged-proof.ts` | PASS, exit 0 |
| `bun run typecheck` | exit 0 |
| `make build` | exit 0; staged version reports `950bdf19` |
| native provenance | Ghostty `73534c46`, Zig `3cc2bab3`, patch series `ddeaf792` |

The residual staged test passes in ~340 ms, which is fast enough to look like a
skip. It is not: mutating `expect(exitCode).toBe(1)` to `999` turned the suite RED
with `Received: 1`, proving it really spawns the daemon and reads a real exit
code. The `describeIfStaged` guard does skip when binaries are absent, so it must
be run after `make build` to mean anything.

## Non-blocking observations

1. **Post-startup fatal still only logs** (`src/cli/daemon.ts:90-92`). If the
   broker exhausts its 3-restarts-in-60s budget *after* a good startup, the
   supervisor goes `failed`, `onFatal` prints, and the daemon keeps running
   brokerless — the same end state hole 6 produced, reached at runtime instead of
   startup. This is unchanged from what Horace passed in all four prior rounds
   and is outside the ready-gate redesign, so it does not block. Worth an issue
   against #37: decide whether a fatally-failed broker should terminate the
   daemon or surface as degraded health.
2. `brokerLockPath()` is exported but has no non-test caller now that the lock is
   internal. Flagging, not deleting.
3. The pin moved during review (`e2b29908` → `950bdf19`). It was the right fix
   for a real blocker, but re-pinning mid-review is the pattern that costs a
   round; a residual is normally landed-then-followed-up or flagged. Freeze
   confirmed holding at `950bdf19` for the duration of this verdict.

## Design status

No hole 6 remains in the ready-gate: the kernel-bound identity proof
(`connect` ∧ `LOCAL_PEERPID == child pid` ∧ HELLO/WELCOME on that connection) did
not need a pivot. Hole 6 was in the *startup sequencing around* the gate, not in
the gate, and it is now closed. The design stands.
