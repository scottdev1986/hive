# M1-B2.1 task-zero cross-vendor DELTA re-review — visibility contract + fixtures

- Pin reviewed: `6290a81c` (`fix(terminal): close B2.1 visibility review gaps`)
- Prior pin: `2b42c449` — NO-LAND by enzo (Claude), reaped. Acceptance criteria persisted at `f5ad9429`.
- Author: elaine (Codex). Reviewer: ernest (Claude) — cross-vendor requirement satisfied.
- Method: pin materialized detached in a scratch worktree; HEAD never moved (`6290a81c` at entry and exit);
  tracked content verified pristine after every probe. All evidence reproduced independently — the
  author's ephemeral `/tmp` artifact was not consulted. GhosttyKit artifact borrowed from a sibling
  worktree only after its `native/toolchain-lock.json` was verified byte-identical to this pin's, and
  the qualifier re-verified `patched_tree=a27fc0e7…` against the lock during the run.

## Verdict: **PASS** — land-authorized at `6290a81c`

Both blocking findings are genuinely fixed, and each fix was proven by mutation rather than by
inspection. The three non-blocking observations are addressed. The full contract surface, the eight
L–S controls, and ELLEN F1–F4 are undisturbed. Two new non-blocking observations are recorded below;
neither blocks the freeze.

## Blocking findings — both closed

### B1. Expiry-sweep isolation — CLOSED, mutation-proven (2 independent mutations)

`neutral-visibility-fixture.ts` now wraps `terminal.terminate()` in try/catch inside `expireLease`,
converting a throw into that lease's own typed `unknown` `TerminationResult`
(`reap.authority: "unavailable"`, `completeness: "unknown"`, diagnostic carrying the error text) and
recording the lease as `state: "expired"` with `expiredAt` + `teardown`. The sweep continues.

The committed case is `P: one throwing expiry teardown becomes unknown and does not skip later leases`
(`visibility-contract.test.ts:228-278`). It is **not vacuous** — the failed-launch generation's
`terminate()` genuinely throws, so the catch path is genuinely exercised. Proven twice:

| Mutation applied to the pin | Result | Bites at |
|---|---|---|
| `catch (error) { throw error; … }` — remove the isolation | RED | `:252` `await expect(host.advance(...)).resolves.toBeUndefined()` — "Received promise that rejected" |
| keep the catch, `break` after the first expired lease | RED | `:262` `expect(host.expiryResult(running.session))` — "received value must be a non-null object" |

The first proves the throw is converted rather than escaping; the second proves *later leases still
tear down*, independently of the first. Both faulted failure diffs captured; the pin restored and
verified pristine after each.

### B2. One key → one live leased generation — CLOSED, mutation-proven

The guard is now `if (this.owners.has(request.terminal.key))` — source-independent. Doc §1 wording is
corrected off "another source" to "A session key with an active or unreconciled leased generation
rejects another create regardless of whether the source is the same or different", and the Case R row
in §6 is updated to match.

Mutation control: reverting **only** the same-source half of the guard back to the `2b42c449`
behaviour (`owner && owner !== request.visibility.source.sessionId`) turns two cases RED at exactly
the new assertions —

- Case R at `visibility-contract.test.ts:318` — the new same-source `duplicate-session-owner`
  expectation (received a full `state: "created"` record, `incarnation: "inc-2"`).
- The sweep case at `:274` — the new *unreconciled-generation* re-create expectation.

The in-suite `allow-duplicate-owner` fault also now bites at the same-source assertion first, because
it bypasses the whole guard. Exact idempotent replay remains non-creating.

**Key release is not leaked by the new fence.** I probed the path the fix introduces: `owners` is
cleared only on verified absence (`terminated` + `complete` + no survivors + reaped). After a clean
teardown a new generation *is* admitted (same source and cross source both reach `created`,
`incarnation: inc-2`), while an `unknown` teardown keeps the key fenced. The fence does not become
permanent.

### Criterion 3 — enzo's orphaned-lease reproducer

Run verbatim at the pin it **errors at line 18** (`b.result` undefined) — because the second create is
now *rejected*, so the probe can no longer construct its own precondition. That is the fix, not a
failure. Adapted to assert the rejection instead of assuming the create:

```
A state: created inc: inc-1
B state: rejected reason: duplicate-session-owner createInvoked: false
A lease held: active
advance() completed WITHOUT throwing
A lease after sweep: expired
A teardown: "terminated"
A inspect: exited
```

Against `2b42c449` this printed `advance() THREW: StaleIncarnationError` with both leases still held.
The orphaned-lease state is now unreachable at the admission gate and the surviving generation is torn
down with typed evidence. **GREEN in substance.**

## Non-blocking observations from enzo — all addressed

- **O1 (fail-open qualifier) — FIXED and POSITIVE-CONTROLLED.** The shipped block
  (`qualify-hive-terminal-b20.sh:252-272`) was extracted verbatim and exercised on all three exit
  paths against real trees:

  | Scenario | Status | Outcome |
  |---|---|---|
  | pristine probe tree | 1 | no exit, record written — correct |
  | probe with `import GhosttyKit` appended | 0 | `public B2.0 probe imports the upstream boundary`, **exit 1** |
  | probe directory absent | 2 | `import audit failed with status 2`, exit 1 |

  The guard genuinely goes RED. Contrast: the **old** block from `2b42c449`, run against the *same*
  boundary-importing probe, printed `bash: rg: command not found`, **exited 0**, and wrote the
  hardcoded PASS record. The fix is real, not cosmetic. (`rg` is on an interactive `PATH` but not
  inside the script's `bash` — enzo's diagnosis confirmed.)
- **O2 — FIXED at type level.** `VisibilityLease` is now `ActiveVisibilityLease | ExpiredVisibilityLease`;
  the expired variant carries `expiredAt` + `teardown: TerminationResult`. `VisibilityRenewalResult`'s
  active arm is narrowed to `ActiveVisibilityLease`, and `VisibilityCreateResult.created.lease` is the
  **union**, so a consumer must discriminate before reading it as authority. The replay assertion
  (`:226-228`) requires `replayed.lease.state === "expired"`. Production wiring can no longer read a
  replayed lease as live.
- **O3 — DOCUMENTED and TESTED.** Doc §2 now states rejections/unknowns are cached by terminal key plus
  idempotency key and that a corrected request uses a new key. Test `create rejections are sticky for
  one idempotency pair` (`:396-419`) asserts the sticky replay *and* that a corrected **new** key
  reaches `created`.

## Full contract surface — undisturbed

- **Eight L–S mutation controls**: all pass semantic + faulted halves (the `cases` table runs both).
- **ELLEN F1–F4**, from the qualifier evidence I generated, on **both** arches:
  F1 `answered_when_enabled_count=7`, `vacuous_count=0`; F2 `testingAllowFocusSteal` 0 occurrences;
  F3 old `HiveGhosttyActionNotification` 0 / new `HiveTerminalActionNotification` 1 (positive control
  that the reader can see a hit); F4 bare-`Ghostty` public symbols **0** against a non-vacuous
  394-line dump. Identical to enzo's numbers at the prior pin.
- **Project neutrality**: 0 hits for enzo's wider term set
  (`hive|workspace|bun|worktree|tmux|sessiond|provider|agent|claude|codex|grok|pane|.hive|planning/`,
  case-insensitive) across the contract *and* the changed fixture; the same pattern hits the qualifier
  script 24 times, so the zero is a real negative. The doc's 3 hits are the pre-existing prose/citation
  lines untouched by this delta.

## Suites — reproduced independently at the pin

| Check | Result |
|---|---|
| `bun test` (full) | **1714 pass / 10 skip / 0 fail**, real exit 0 |
| `bun run typecheck` | clean, real exit 0 |
| `bun test test/terminal-host-freeze/` | **28 pass / 0 fail** (26 at prior pin + 2 new) |
| `bun test …/visibility-contract.test.ts` | **12 pass / 0 fail**, 87 expect() calls |
| `swift test` (full) | **321 executed / 2 skipped / 0 failures**, real exit 0 |
| `swift build --build-tests` | clean, real exit 0 |
| dual-arch B2 qualifier | **exit 0**, arm64 + x86_64, patched tree verified against the lock |

Dependencies installed fresh at the pin (`bun install --frozen-lockfile`, 99 packages); no borrowed
`node_modules`. Every exit code read directly, never through a pipe.

## New non-blocking observations (follow-ups, not freeze blockers)

- **N1. The new sweep case has no *in-suite* mutation control.** `P: one throwing expiry teardown…`
  and the sticky-rejection case sit outside the `cases` fault table, so their non-vacuity rests on a
  one-time reviewer act (mine, recorded above) rather than a control that re-runs forever. The case is
  genuinely coupled — I proved it goes RED on both plausible regressions — so this is a durability gap,
  not a correctness one. Cheap fix: add an `abort-sweep-on-teardown-failure` variant to
  `VisibilityFreezeFault` and register the case in the `cases` table.
- **N2. The qualifier's pass-branch record is still hardcoded prose.** On the not-found path the fixed
  block writes a literal `imports=AppKit,Darwin,Foundation,HiveTerminalKit` rather than the imports it
  actually observed. The load-bearing check is now genuine and proven, but the *attestation* can go
  stale silently — if the probe added a different benign import, the record would still claim the old
  set. Suggest printing the observed `import` lines instead of a constant.

## Evidence

`bootstrap/evidence/m1-b2-b21-rereview-ernest/` — reproduction summary, the adapted orphaned-lease
probe, the key-release probe, and the O1 qualifier positive-control transcript.
