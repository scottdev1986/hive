# M1-B2.1a cross-vendor review — production visibility CREATE + SUSTAIN

- **Pin reviewed:** `11a41904` ("feat: wire Workspace visibility to sessiond"), materialized detached; HEAD never moved and the tracked tree was byte-clean at start and finish.
- **Author:** elaine (Codex). **Reviewer:** evan (Claude) — cross-vendor satisfied.
- **Scope:** B2.1a create + sustain only. Teardown/close/quit is B2.1b and is *not* faulted here.
- **Verdict: PASS — land-authorized at `11a41904`.**

All suites below were reproduced independently in a fresh worktree, not read from the
author's artifacts. Every run records `REAL_EXIT` separately, because a trailing
`echo`/pipe reports the wrong status (this bit once during the review: the first native
run notified "exit 0" while `REAL_EXIT=1`, Zig unprovisioned).

## Verified axes

**1. Project-neutrality — PASS.** `terminal-host-visibility-contract.ts` and
`terminal-host-contract.ts` are untouched by the pin and contain zero
`workspace`/`pane` vocabulary (grep positive-controlled: 29 hits for `Visibility`,
0 for the forbidden terms — the zero is a real zero, not a broken reader). The neutral
request stays nested (`{source:{sessionId,process}, inventoryRevision}`); the flattened
`workspace*` shape lives only at the Hive boundary in `session-protocol.ts`, which is
also unchanged. Contract identical to the landed B2.1 contract.

**2. Authenticated full-snapshot inventory — PASS, with one coverage gap (below).**
Publisher peer authenticated (`workspace-visibility:write`, operator-only: 403 writer /
200 operator / 409 replay, all asserted). Live PID + exact start-token re-read on every
publish *and* again at admission. `macProcessIdentity` throws on a dead process and both
call sites catch → `false`/no-publish, so dead-source is fail-closed. Older-revision,
duplicate-terminal, locator-mismatch, and dead-source rejections each have committed
biting controls; reconnect replaces state from a full snapshot.

**3. Exact-generation binding — PASS.** `prepare()` is availability-only (engine identity,
no visibility claim). `admit()` runs twice against the *current* snapshot — once after the
DB row exists (`awaitInitialSessiondPolicy`) and again at final create
(`requireSessiondPolicy`) — with no caching across a revision, and each cross-checks
`engineBuildId` against the record locator. The DB renewal `UPDATE` is keyed on exact
`instanceId + sessionId + generation`.

**4. Renewal — PASS.** The broker validates, then forwards the **exact payload bytes** to
the recorded host (`WireHostClient.renewVisibility` re-checks `sameLocator` against
`expected_record`), and mutates its mirror **only after** host proof. The host fences on
`sameLocator` + live `observeProcess` + exact start-token + revision, failing closed on
absent/unobservable. Stale, expired, wrong-workspace, wrong-token, and wrong-generation
all fail closed with positive and negative controls. `connectDirect` untouched. The native
delta lives in `native/sessiond` (Hive's own daemon) and is **separate from the Ghostty
patch budget** — patch-series SHA-256 recomputed from the pin's checked-in patches is
unchanged at `5de6aa43…`.

*Non-vacuity proven, not assumed:* `zig build test` is silent on pass, so a green run
proves nothing. Neutralizing the stub's start-token fence turned the suite **RED at
exactly** `stub_host.test.production VISIBILITY_RENEW forwards exact bytes and mutates
only after host proof` (193 tests). File restored; SHA-256 back to baseline.

**5. Feed — PASS.** `process.ppid` is captured once at CLI start, with an explicit
reparenting comment, and never re-read; a later ppid can never become a new source.

**6. Publisher-death — PASS.** A real `/bin/sleep` publisher is SIGKILLed, then **both**
the spawned host and the spawned provider are polled absent by `pid + startToken` via
`macProcessIdentity` — real process readback, not inference — after which the inspection
reports `visibility.state === "expired"`.

**7. N1 (ernest's carry-forward) — PASS, non-vacuous on every run.** Both new cases are in
the permanent `cases` fault table. I instrumented the loop and re-ran it: **all 10** faults
bite, and each fails at its *intended* semantic assertion, not an incidental setup error —
`P2` fails on "expected promise that resolves / received rejected" (the sweep propagated),
`T` on `toEqual` of the sticky rejection (the fault changes the replay to
`session-not-represented`).

**8. N2 — PASS.** The pass-branch records observed imports, handles all three grep outcomes
(0 forbidden → fail, 1 → observe, other → fail), uses absolute tool paths (so a missing
tool cannot fail open), and guards the empty attestation. Reproduced identically and
positive-controlled: a mutated probe copy yields `AppKit,Combine,Darwin,…`.

**9. F1–F4 — PASS, reproduced in my own regenerated evidence.**
`answered_when_enabled_count=7`, `vacuous_count=0` on both arches; F2 denylist zero
bare-Ghostty hits, positive-controlled (a planted `GhosttyManualSurface` is detected).

**10. Suites — all reproduced, all green.**

| Suite | Result | Claimed |
|---|---|---|
| bun | 1721 pass / 10 skip / 0 fail, `REAL_EXIT=0` | matches |
| typecheck | `REAL_EXIT=0` | matches |
| native sessiond | `REAL_EXIT=0` (193 Zig + identity parity + live create/renew/publisher-death) | matches |
| B2.0 qualifier, arm64 + x86_64 | `REAL_EXIT=0` | matches |
| Swift arm64 | 322 / 1 skip / 0 fail | matches |
| Swift x86_64 (Rosetta `xctest`) | 322 / 1 skip / 0 fail | matches |
| evidence manifest | 51/51 verify, coverage complete (only self excluded) | matches |

The single Swift skip is `testPhysicalMonitorScaleAndSleepWakeQualification` — interactive
multi-display hardware, unrelated to B2.1a. `swift test --arch x86_64` cannot run here
(the x86_64 bundle will not dlopen into the arm64 helper); the bundle was confirmed
`Mach-O 64-bit bundle x86_64` and 322 tests genuinely executed, so this is not the
"0 tests, exit 0" trap.

## Teardown honesty — PASS (the explicit ask)

`production-visibility-summary.txt` states plainly: *"It does not claim the B2.1
authoritative close/quit gate. B2.1b must add locator-fenced pane kill and sessiond-aware
`hive stop`/Workspace quit with positive provider-tree absence before B2.2."* It is
equally honest that a user close is represented as `closing` and stops renewal. **There is
no false "quit works" claim anywhere in the pin.**

## Findings (none blocking)

1. **`source-identity-mismatch` has no committed control.** The production authority's
   live-source exclusivity branch (`workspace-visibility.ts:126-132`) is never exercised:
   the shipped `authority()` fixture's `observeProcess` can only report **one** live PID at
   a time, so the branch is structurally unreachable in that file. The neutral freeze
   fixture covers the *neutral* implementation, which is a different one. I proved by
   ad-hoc probe that the branch is **correct and fails closed** — a second simultaneously
   live Workspace cannot hijack the inventory, and a same-PID relaunch under a new
   `sessionId` is also rejected — so this is *correct behavior, untested*, not a defect.
   Recommend a committed two-live-source control in B2.1b. This is the same shape as the
   earlier B2.1 NO-LAND (an ownership guard that only tested one side).
2. **A previously-green teardown assertion was removed** from `ts-live-create.ts`
   (`stopSpawnedSession` → `survivors: []` + `terminationAudit`), replaced by the
   publisher-death path. This is the honest consequence of deferring teardown, but the
   summary discloses the *deferral* without disclosing the *removal*. B2.1b should restore
   it.
3. **`AgentFeed` decodes `sessionLocator` with `try?`**, so schema drift yields `nil`
   silently → the terminal is dropped from the inventory → create waits 10s and throws
   "never became visible in the Workspace inventory". Fail-closed, but the diagnostic
   points at the wrong thing.
4. **Doc nit:** the new `POST /workspace-visibility` row in `docs/daemon/authorization.md`
   cites `src/daemon/server.ts` with no line range, while every other row has one.
5. **Story not amended:** `planning/story-m1-b2-hive-terminal-view.md` §B2.1 still states
   the undivided DoD ("pane close, quit, and publisher death yield verified tree absence");
   the a/b split is recorded only in the evidence summary.

## Reviewer's note on the engine artifact

Seven worktree caches hold **six different artifact generations under the same directory
name**; only the author's matched the pin. Rather than trust it by provenance, I bound it
to the pin's own source: `patchSeriesSha256`, `bridgeHeaderSha256`, and `symbolListSha256`
were recomputed from the pin's checked-in files and all three match the artifact's
self-described manifest, as do the recorded manifest and `libghostty-internal.a` digests.
Using the primary checkout's artifact instead would have produced a spurious failure
attributable to the author.
