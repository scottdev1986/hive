# M1-B1 Gate 3 — lifetime / threading / event loop: live proof (matrix row E)

Story: `planning/story-m1-b1-ghosttykit-qualification.md` §"P0 qualification
gates" gate 3, §"Live-proof matrix" row E.

Runner: `scripts/qualify-ghostty-gate3.sh`
Evidence: `raw/qualification/ghostty-b1-gate3-lifetime/` (machine-generated;
the runner clears and rewrites the directory on every run, so nothing is
hand-edited into it — this document is the prose half).

Gate 3 previously had code and unit tests on main but no committed live proof.
This closes that: every gate 3 property is measured against the shipped
GhosttyKit artifact, under AddressSanitizer and ThreadSanitizer, with a positive
control per claim.

## Two scopes, because one harness cannot cover both

**Engine scope — `GhosttyGate3Probe`** (`workspace/Tests/GhosttyGate3Probe`)
drives the real C ABI directly: no fakes, no Swift wrapper. It is the only
harness that executes the real `ghostty_app_tick`, the real
`ghostty_surface_free`, and real engine-owned callback memory. Same pattern as
the gate 1 and gate 10 probes.

**Host scope — the HiveTerminalKit gate 3 XCTest corpus** (21 tests across
`CallbackDisciplineTests`, `AppWakeupLifecycleTests`, `Gate3OperationDomainTests`,
`Gate3ConcurrentCreationTests`) covers the Swift callback and teardown
discipline, and is re-run here under both sanitizers so its guarantees are
sanitizer-backed rather than only logically argued.

## What the probe proves, and how each claim can go red

| Stage | Property | Positive control | Result |
|---|---|---|---|
| `wakeup-tick` | `wakeup_cb` fires and its **deferred** `ghostty_app_tick` actually executes, on main, never inside the callback | — (see the coverage note below) | 2 wakeups / 2 ticks at the stage, 0 inline; 12 / 12 by completion, all on main |
| `copy-before-return` | Callback payloads must be copied before return: the pointer is valid only for the call | `--defect=retain-callback-pointer` reads the pointer after return | **RED**, exit 1 — bytes no longer match |
| `no-callback-after-free` | No callback is delivered after `ghostty_surface_free` | `--defect=callback-after-free` injects one post-free delivery through the same recorder | **RED**, exit 1 |
| `multi-surface` | Four live surfaces, no cross-attribution of callbacks | assertion is two-sided (fed surface must grow, others must not) | 4 surfaces, only the fed one grew |
| `inflight-close` | Close while output and draw are in flight, with host serialization | `--defect=unserialized-output` drops the serialization | **RED**, exit 134 — ASan `dynamic-stack-buffer-overflow`, 3/3 deterministic |
| `rapid-create-free` | 50 serial create/use/free cycles, no escaped delivery | shares the `no-callback-after-free` predicate | 50 cycles, 0 late deliveries |
| `free-ordering` | surface → app → config | `--defect=free-app-before-surface` frees the app first | **RED**, exit 134 — ASan `stack-buffer-underflow` |

Green run: **0 AddressSanitizer reports, 0 ThreadSanitizer data races**, all
eight stages reached. The total callback-delivery count (a few thousand) and
`outputCallsWhileClosing` vary between runs because the `inflight-close` stage
feeds for a fixed wall-clock window rather than a fixed count; every asserted
value — tick counts, inline ticks, late deliveries, cycles, free order — is
deterministic. The committed protocol files are the record of one run.

Surfaces are created serially on main because
`hive_ghostty_surface_new_manual_v1` fills a **process-global backend slot** —
concurrent creation is a contract violation, not a race to qualify. The
marshalled-concurrency discipline is covered by `Gate3ConcurrentCreationTests`.

## What the host controls prove

Each deletes a load-bearing production line **in a throwaway copy of the tree**
(never in the repo) and requires the corpus to go red. The runner also requires
the failure to be a real test failure, since a mutation that merely breaks the
build would exit nonzero and prove nothing.

| Control | Line removed | Result |
|---|---|---|
| `teardown-wait` | the `while activeCallbacks > 0 { condition.wait() }` in `beginTeardown` | **RED** — `testSurfaceFreeWaitsForCallbackCopyAlreadyInFlight`, "2 is not less than 1" |
| `noop-wakeup` | `ctx.scheduleTick()` in the wakeup trampoline | **RED** — 7 failures across 5 tests in `AppWakeupLifecycleTests` |
| `delivery-guards` | both the `acceptingCallbacks` recheck and `writeHandler = nil` | **RED** — 2 failures, deliveries 1 ≠ 0 |

`teardown-wait` is the direct closure of cross-vendor review finding **F1**,
which reported that deleting that wait left the whole corpus green. It no longer
does: the ordering is now asserted directly and the control bites.

## Three findings recorded rather than smoothed over

**1. The host corpus cannot detect deletion of the real `ghostty_app_tick`
call.** The first `noop-wakeup` control deleted the real `ghostty_app_tick(app)`
statement and the corpus stayed **green**. Every test in
`AppWakeupLifecycleTests` drives the tick through the `tickOverride` spy seam,
so no host test executes the real C call. This is not a defect in the production
code and not a reason to remove the seam — it is a statement of what that corpus
can and cannot witness. The real call is covered only by the probe's
`wakeup-tick` stage. The control was retargeted at what the corpus does guard
(that the trampoline schedules at all), and the finding is recorded in the
runner beside it.

**2. The no-delivery-after-free guarantee has two independent mechanisms.**
Removing only the execution-time `acceptingCallbacks` recheck leaves the corpus
green, because `beginTeardown` also nils the handler — and vice versa. That is
defense in depth working as intended, not a coverage gap, but it means a
single-line control cannot bite. The committed control removes both.

**3. ThreadSanitizer reports one benign thread leak.** `ghostty_init`'s
`GlobalState.init` spawns a thread that finishes but is never joined, so TSan
reports a *thread leak* and sets a nonzero exit status on every run that loads
the engine — probe and corpus alike. The gate 3 claim is the absence of **data
races**, which is asserted directly and is zero; the exit status is deliberately
not asserted, and the full stderr is committed so the leak stays visible rather
than suppressed. `tsan-summary.txt` records both counts.

## Reproducing

```
scripts/build-ghosttykit.sh          # if .cache/native/artifacts is cold
scripts/qualify-ghostty-gate3.sh     # ~10 min warm; exit 0 == gate 3 green
shasum -c raw/qualification/ghostty-b1-gate3-lifetime/evidence-sha256.txt
```

The manifest excludes itself and every evidence file is committed (`.txt` /
`.jsonl`, nothing gitignored), so `shasum -c` self-verifies from a fresh
checkout, not only for the author.

## Scope boundary

This is the engine-and-host-discipline half of gate 3. AppKit/Metal main-thread
requirements under a real renderer belong to the B2 renderer wiring and are
qualified with gate 7's hardware-dependent evidence; they are not claimed here.
