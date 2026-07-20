# Post-hoc cross-vendor review — hector, `be48a971..ef25d41d`

Reviewer: helen. Reviewed at full pre-land rigor after the range had already
landed on `main` without pre-land review (self-reported protocol slip).

**Verdict: FOLLOW-UP REQUIRED.** Not revert-class. No finding changes default
production behavior; the four follow-ups below are all in the resize-receipt
observability surface that this landing exists to create.

## Prior reviewers

Two earlier reviewers (hedy, herta) died in vendor crash waves. herta's
preserved worktree `.hive/worktrees/herta` contains **no notes**: it is clean at
`ef25d41d` with zero commits of her own. Nothing was recoverable. Her last
visible question — *can any receipt error path propagate into production
defaults* — was re-derived from scratch and is answered under (3) below.

## (1) Seams in production files — PASS

The seam is **inert by default**, proven at every construction site rather than
by a "disabled by default" claim.

`SmokeRunner` is constructed at exactly two sites, both gated:

- `AppDelegate.swift:141` — gated by `config.smoke` (pre-existing; `SmokeRunner.swift`
  was added in `2b4c1c36`, not by this range, which added 183 lines to it).
- `AppDelegate.swift:175` — new; gated by env `HIVE_SMOKE_SESSIOND_LIVE_RESIZE_INPUT`.

With the env var unset the block is skipped entirely: nothing is constructed, no
work is scheduled, and the default path is byte-for-byte the prior behavior.
`ProjectWindowController` gains only an additive read accessor
(`sessiondTerminalView(pane:)`) with no call site on the default path.

### F1 — presence-only gate on a seam that terminates the app

`AppDelegate.swift:174` gates on `!= nil`, and `SmokeRunner.swift:261` on
`if let`. Both accept **any** value, including empty string and `0`. The sibling
gate at `AppDelegate.swift:148` uses the stricter `== "1"`.

This matters more than a style nit because the seam sits in the **non-smoke
(normal app)** branch and `run()` reaches `exit(0)`/`exit(1)`
(`SmokeRunner.swift:250-256`). So `HIVE_SMOKE_SESSIOND_LIVE_RESIZE_INPUT=0`
reads as ON and **terminates the real Workspace app** three seconds after
launch. A presence-only gate paired with a process exit is the wrong pairing.

*Fix:* gate on `== "1"` at both sites, matching line 148.

## (2) Harness — PASS

All four of heidi's reviewed behaviors are intact in
`scripts/b22-live-attach-proof.ts`:

1. SIGINT-immune broker spawn wrapper — `:101`, `trap "" INT; exec` (an ignored
   disposition survives exec, unlike a handler).
2. Exit-hook broker kill on abnormal paths — `:126`, `process.once("exit")`
   killing the broker and releasing the daemon lock.
3. Second-Ctrl-C forced exit 130 — `:309-316`.
4. `daemon.stop()`-only teardown with host-pid `SIGKILL` fallback, **process-table
   read-back**, and non-zero on survivor — `:330-358`.

hector's only change is threading `requestedExitCode` into `exitCode`. It is
**correct**: `:330` seeds `exitCode` from the request, and the sole overwrite
(`:355`) escalates `0 -> 1` on a surviving host. A failed proof can therefore
never mask as green. This is confirmed live in the cited artifact transcript:
`Workspace live-resize proof exited 1` -> `shutting down` -> exit 1.

## (3) Receipt observability — herta's question, answered

**No — a receipt error path cannot propagate into production behavior.**

The sole call site is `HiveTerminalView.swift:283`:

```swift
let outcome = (try? client.handleFrame(frame, frameBinding: frameBinding))
    ?? .rejectedLateFrame
```

`try?` maps any throw to `.rejectedLateFrame`, which the switch at `:288-295`
handles with `break` — a no-op frame drop. No teardown, no surface-state change,
no input/resize send-path change. The receipt work is genuinely additive for
**behavior**, which is why this is not revert-class.

The **observability**, however, is defective. `pendingResizeRequests` has exactly
four mentions in `AttachReplayClient.swift` — declare `:56`, insert `:278`, read
`:460`, remove-on-`.applied` `:461`. It was added beside `pendingInputRequests`
but not wired into the three places the input map is maintained.

### F2 — `.error` answer to a resize leaks the entry and staleness the result

The `.error` case (`:306-320`) removes from `pendingInputRequests` but never from
`pendingResizeRequests`. A resize answered with `.error` therefore leaves its
entry in the map **forever** (unbounded: resizes fire per drag frame during a
live window drag) and leaves `lastResizeResult` reporting the *previous* resize's
outcome.

### F3 — a non-JSON payload throws after the entry is already removed

`:462` parses *after* `:461` has removed the entry. A payload that is not valid
JSON throws there; `try?` absorbs it, so behavior is unaffected, but
`lastResizeResult` again silently retains a stale prior value.

Note the asymmetry with the input path immediately below: `:489-498` deliberately
**absorbs** a malformed receipt into `.unknown(evidence:)` rather than throwing.
The resize path escalates the exact case the input path was written to absorb.

### F4 — no reset and no binding check

`resetInputState()` (`:584`, called from three rebind/reset sites `:112`, `:186`,
`:199`) clears `pendingInputRequests` but not `pendingResizeRequests`. The resize
branch also does not check `pending.binding == binding`, which the input branch
does at `:487`. A resize receipt can therefore be consumed across a
rebind/generation change.

### Net effect

`lastResizeResult` reports a **stale success exactly when the resize errored or
was malformed** — it is failure-silent in the one surface this landing was
written to provide. hector's `testResizeReceiptsAreCorrelatedAndObservable`
covers only the well-formed `.applied` matrix (applied / stale / unknown /
wrong-`resultKind`); it never feeds an `.error` frame or a non-JSON payload, so
F2 and F3 are uncovered.

The test *structure* is otherwise sound: distinct expected values per loop
iteration mean a stale-retention bug would be caught for the cases it does feed.

## (4) Documentation — accurate, does not overclaim

`workspace/docs/resize-live-proof-hector.md` cites `/tmp/hb22-82bb` and
`/tmp/hb22-ba94`; both exist. Every quoted value matches the artifact
(`workspace.stdout.log`): geometry `61x39 -> 70x43`, `highWater 218 -> 218`,
`input waitingForClaim`, and the frame rectangle.

The doc explicitly states the run "supplies no causal RED for resize" rather than
claiming a passing proof. That is honest and correct: the proof **failed**
(exit 1, six failed assertions, beginning with `actual app window became key`).

**Status fact for planning:** the landed live-resize proof does not currently
pass. Its headline claim is unproven for an upstream attach/claim reason, which
the doc hands off. The landed value is the receipt plumbing plus the harness, not
a green proof.

Minor: the doc's repro command uses `DEMO_PORT=43118`, which is allocated to
another agent.

## Verification performed

Toolchain pins verified in the build output before trusting any result:
ghostty `commit=73534c46...`, `patches=ddeaf792...`, zig `sha256=3cc2bab3...`.

| Check | Result |
| --- | --- |
| `make workspace` | exit 0 |
| `make sessiond` | exit 0 (ReleaseFast) |
| `swift test` | exit 0 — **434 tests, 7 skipped, 0 failures** |
| `bun run typecheck` | exit 0 |
| Teardown smoke, own port 43120 | one SIGINT -> orderly exit 0, broker confirmed gone |

All exit codes were captured directly via `$?`, never through a pipe (a piped run
reports the pager's status, so a RED suite notifies as exit 0).

**Suite positive control.** `swift test` reported exit 0 while the swift-testing
library printed `0 tests in 0 suites` — the real XCTest totals are on separate
lines. The target test was confirmed to have actually *run*, not been skipped:
`AttachInputTests testResizeReceiptsAreCorrelatedAndObservable` appears as both
`started.` and `passed` in the log.

**Receipt mutation check (required, both directions).** Mutating the `stale`
branch string in `AttachReplayClient.swift:472` forced the focused matrix test
RED — exit 1 with
`XCTAssertEqual failed: ("HELEN_MUTATION currentRevision=7") is not equal to ("stale currentRevision=7")`.
The test genuinely bites on the receipt stage; it is not vacuous. The mutation
was reverted and the working tree confirmed clean of it.

**Teardown smoke, live.** Run on port 43120 (43118/43119 are allocated
elsewhere) with a short `HIVE_B22_HOME=/tmp/hb22-helen`, since scratchpad-length
paths exceed the UNIX socket limit. One SIGINT produced `shutting down (SIGINT)`
-> `daemon stopped; session torn down` -> exit 0, with **zero** occurrences of
`stop refused` / `SURVIVED SIGKILL`: the orderly path was taken, not the
fallback. The broker pid recorded at startup was then confirmed absent from the
process table — the state was read, not inferred from the kill having been sent.

### Limit of the seam mutation check — stated rather than papered over

The *inactive* direction is proven: with the env var unset the gate skips the
block entirely, and the full 434-test suite exercising the default path is green.

The *forced-active* direction has **no automated coverage**. No unit test
constructs the seam; it is reachable only by launching the real GUI app with the
env var set, and surface creation returns null in a locked/agent shell, so
forcing it active here would fail for environmental reasons and would say
nothing about the seam. The seam's inertness therefore rests on exhaustive
construction-site analysis plus the green default-path suite — not on a test.
That gap is itself worth closing, and is why F1 matters: nothing automated would
catch a regression in that gate.

## Follow-ups to file

- **F1** — gate `HIVE_SMOKE_SESSIOND_LIVE_RESIZE_INPUT` on `== "1"` at
  `AppDelegate.swift:174` and `SmokeRunner.swift:261`. Nothing automated covers
  this gate, so a regression here would be silent.
- **F2** — clear `pendingResizeRequests` in the `.error` case; set
  `lastResizeResult` to the error.
- **F3** — parse before removing, or wrap the parse so a malformed resize receipt
  records `malformed` rather than throwing — matching the input path's contract.
- **F4** — clear `pendingResizeRequests` in `resetInputState()`, and check
  `binding` in the resize branch as the input branch does.

F2/F3/F4 share one root cause and are best fixed as a single change that brings
the resize map to parity with the input map, with tests feeding an `.error` frame
and a non-JSON payload.

## Delta reviews of the fixes — all PASS

### `fcc3e05b` — F1–F4 (PASS)

Each original bug was reintroduced in production code to prove the new tests
bite. Every one went RED with the literal stale-success symptom:

- `.error` fix reverted -> `testResizeErrorReplacesStaleSuccessAndClearsRequest`
  reported `"applied 80x24"` instead of `"error CLOSED: resize rejected"`.
- non-JSON throw restored -> `testMalformedResizeReceiptReplacesStaleSuccess`
  reported `"applied 80x24"` instead of `"unknown malformed resize receipt"`.
- reset fix reverted -> `testRebindClears…` failed `XCTAssertNil` with
  `"applied 80x24"`.

The tests are stronger than the fix strictly required: each seeds
`lastResizeResult` with a real success first, so every assertion distinguishes
*reports failure* from *retained stale success*. The F1 gate was additionally
verified in the real app — `"1"` fires the seam, `"0"` and `""` do not — which
closed the coverage gap this review had flagged.

### `4dad7269` — F6/F7 (PASS)

Verified by swapping only `scripts/b22-live-attach-proof.ts` between refs (no
rebuild, so nothing else could differ), same port, same env value, app provably
alive at Ctrl-C in both runs:

- OLD ts: `shutting down (SIGINT)` -> `forced exit`, **no** `daemon stopped`.
- NEW ts: `shutting down (SIGINT)` -> `daemon stopped; session torn down`.

The race is gone, and gone because of that change. The diff is surgical — 12
changed lines including headers — and does not reach heidi's four behaviors.
`if (!shuttingDown)` is sound in single-threaded JS: `shutdown()` sets the flag
synchronously before its first await, so the block resuming from
`await workspace.exited` always observes it, and the genuine second-SIGINT
force-exit 130 is preserved.

### `d5750507` — F5 (PASS, one low note)

The derivation now matches the harness exactly, which is the property that
matters: harness `HIVE_B22_REAL_SHELL === "1" ? "terminal" : "aria"` versus
Swift `environment["HIVE_B22_REAL_SHELL"] == "1" ? "terminal" : "aria"` — same
rule, same strict comparison.

**F5a (low, non-blocking):** the test is not sensitive to the bug class it
descends from. Mutating `== "1"` to `!= nil` — exactly the presence-only
semantics F1 was about — left the suite GREEN, because the test covers only
`"1"` and an empty environment. One added case would bite:

```swift
XCTAssertEqual(
    SmokeRunner.sessiondLiveResizeInputAgent(environment: ["HIVE_B22_REAL_SHELL": "0"]),
    "aria")
```

### `d2c97987` — F5a (PASS)

The added assertion was verified the only way that means anything: the **same
mutation, before and after**.

- At `d5750507`: mutate `== "1"` to `!= nil` -> suite GREEN, 14/0/0. The gap was
  real.
- At `d2c97987`: identical mutation -> **RED**,
  `XCTAssertEqual failed: ("terminal") is not equal to ("aria")` at
  `AppDelegateLifecycleTests.swift:17` — the new assertion.

Same mutation, opposite outcomes, a one-line delta between them. The guard now
exists, and its attribution is unambiguous.
