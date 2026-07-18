# M1-B2.1 task-zero cross-vendor review — visibility contract + fixtures

- Pin reviewed: `2b42c449` (`feat(terminal): freeze B2.1 visibility contract candidate`)
- Author: elaine (Codex). Reviewer: enzo (Claude) — cross-vendor requirement satisfied.
- Method: pin materialized detached in a scratch worktree; HEAD never moved; tracked content verified pristine after every probe. All evidence reproduced independently — the author's ephemeral `/tmp` artifact was not consulted.

## Verdict: **NO-LAND**

Everything the brief asked to confirm is confirmed (sections 1, 3, 4, 5 below all pass, and the
mutation controls are genuinely self-checking). One contract-level defect blocks the freeze:
the visibility layer does not bind a session key to a single live leased generation, and its
expiry sweep has no per-lease error isolation. Together these break the §4 guarantee —
"bounded expiry + verified teardown" — that B2.1–B2.6 all inherit.

## Blocking finding

### B1. Expiry sweep aborts on the first failing teardown, leaving live leases un-torn-down

`neutral-visibility-fixture.ts:201-203` — `advance()` iterates leases and awaits
`expireLease()` with no error isolation. `expireLease` calls `terminal.terminate()`
(line 301), which can throw. A throw escapes `advance()` and **skips teardown of every
remaining lease**, leaving them held, no `expiryResult` recorded, and no typed failure state.

The contract's §5 requires unknown/partial evidence to surface as a typed `unknown`, and §4
requires survivors and unknown evidence to remain "explicit failure states". A throwing
terminate is neither — it escapes the model entirely. Production teardown can fail for exactly
the reasons the doc enumerates, so this is reachable without any fault injection.

### B2. Guarded create admits a same-source second create over a still-active lease

`neutral-visibility-fixture.ts:126-128` — the exclusive-ownership guard rejects only when the
existing owner is a **different** source (`owner !== request.visibility.source.sessionId`).
A second create from the *same* source with a new idempotency key on the same represented key
is admitted. The base host then supersedes the record (`neutral-fixture.ts:113`, unconditional
`records.set`), so the prior incarnation becomes stale while the visibility layer still holds
its lease (leases are keyed by `key\0incarnation`).

Doc §1 states the guard as "exclusive source ownership" but then narrows it to "Another source
already owning the same session key" (`terminal-host-visibility-v1.md:25`). Case R exercises
only the two-source path, so the fixture never reaches this state.

B2 is the trigger that makes B1 observable, but B1 is independently a defect.

### Reproduction (both probes attached, run against the pin)

```
A: inc-1 B: inc-2
leases held: A true | B true
advance() THREW: StaleIncarnationError stale incarnation for k3
A lease still held after throw: true
B lease still held after throw: true
```

Neither generation is torn down; both leases outlive their deadline. This is precisely the
property the visibility contract exists to guarantee.

### Suggested remedy (author's call on shape)

1. Bind one key to one live leased generation: reject create when the key already has an
   active lease, regardless of source — or explicitly expire/tear down the prior generation
   before admitting the replacement. Then say so in §1 rather than "another source".
2. Isolate each lease's teardown in the expiry sweep and convert a failing terminate into a
   typed failure/`unknown` outcome recorded per lease, so one failure cannot silence the rest.
3. Add a fixture case (T) with its own mutation control covering same-key re-create under an
   active lease, and a case proving a failing teardown does not abort the sweep.

## Non-blocking observations

- **O1. `if rg` fails open** — `scripts/qualify-hive-terminal-b20.sh:252` runs bare `rg` as an
  `if` condition. `rg` is not on `PATH` for the script's bash, so the command-not-found takes
  the else branch and writes a hardcoded `imports=...` PASS record; the qualifier log shows
  `line 252: rg: command not found` while still exiting 0. Pre-existing B2.0 code, not this
  pin's change. I verified the underlying claim by hand: the probe imports are exactly
  AppKit, Darwin, Foundation, HiveTerminalKit — so the verdict is correct but unproven.
  Use `/usr/bin/grep` (as the neighbouring public-API check does) and branch on exact exit code.
- **O2. Replayed create result can assert an active lease for a torn-down session.**
  `VisibilityLease.state` is the literal `"active"`, so no lease value can represent expiry.
  Replay after expiry returns `state: "created"` with `lease.state: "active"` for a terminated
  session. Authority still fails closed (renewal → `lease-expired`, `currentLease` → null), so
  this is a shape wart, not a hole — but production wiring must not read a replayed lease as
  live authority.
- **O3. Rejections are cached under the idempotency key.** A corrected retry with the same
  idempotency key replays the stale rejection (`stale-revision` even once the revision is
  current). Fail-closed, and arguably beyond what §2 sanctions ("already-completed create").
  Worth a sentence in the doc either way.

## Confirmed as required

### 1. Project neutrality — PASS
Zero coupling hits across the contract *and* the fixture for `hive|workspace|bun|worktree|tmux|
sessiond|provider|agent|claude|codex|grok|pane|.hive|planning/` — including terms the enforced
denylist does not cover. The in-suite denylist (`visibility-contract.test.ts:298-301`) reads a
real file, so a bad path throws rather than passing vacuously. Base contract carries its own
denylist (`contract.test.ts:389`).

### 2. Contract semantics — enforced, with the B1/B2 exception
Type-level enforcement is genuine, not declarative:
- `VisibilityRejected.completeness` is the literal `"complete"`; `VisibilityUnknown.completeness`
  is `Exclude<Completeness, "complete">` — an `unknown` can never claim complete evidence.
- Failure postconditions are intersected literal types (`createInvoked: false; session: null;
  lease: null`, and `renewed: false`), so a rejection cannot be constructed claiming a launch.
- Rejection reasons are a closed string-literal union, not free-form strings; `diagnostic` is
  advisory and cannot strengthen completeness.
- `VisibilityTerminalHost = Omit<TerminalHost,"create"> & VisibilityAdmissionHost` — an
  unguarded `create` is a type error, so both-doors exposure is compile-time prevented.
- Source identity requires PID **and** start token (`sameProcess`); same-PID token reuse is
  rejected. Revisions are canonical-positive by regex, so `0`/`01` fail before create.
- Equal-or-later renewal, stale/unverified replay rejection, and generation fencing all verified.

### 3. Fixture positive controls — PASS, and non-vacuous
All eight L–S mutation controls bite **at the intended assertion**, not incidentally. I captured
each faulted failure diff: L accepts an invalid revision and issues a lease; M leases on a stale
revision; N leases despite an identity mismatch; O renews an unrepresented session; P never
expires; Q reports `rejected/complete` for partial evidence; R creates under a duplicate owner;
S renews across generations. Each is that case's own semantic violation.

### 4. ELLEN F1–F4 — PASS on both arches
- F1: `RendererReplySuppressionTests` wired into the qualifier suite list and executed on arm64
  **and** x86_64: `answered_when_enabled_count=7`, `vacuous_count=0`, both tests passed. No query
  is checked against empty output — the non-vacuity assertion is explicit
  (`RendererReplySuppressionTests.swift:82-87`), plus an observation-channel positive control.
- F2: `testingAllowFocusSteal` is now internal; 0 occurrences in either public symbol dump.
- F3: `HiveGhosttyActionNotification` → `HiveTerminalActionNotification`; 0 occurrences of the
  old vendor-named symbol, 1 of the new one (a positive control that the reader can see it).
- F4: denylist widened to bare `Ghostty`; **0** bare-Ghostty public symbols on both arches
  against a non-vacuous 394-line dump, so the zero is a real negative, not an empty file.

### 5. Suites — all green, independently reproduced
| Check | Result |
|---|---|
| `bun test` | 1712 pass / 10 skip / 0 fail, real exit 0 |
| `bun run typecheck` | clean, real exit 0 |
| `bun test test/terminal-host-freeze/` | 26 pass / 0 fail |
| `swift test` (full) | 321 executed / 2 skipped / 0 failures, real exit 0 |
| `swift build --build-tests` | clean, both arches (inside qualifier) |
| dual-arch B2 qualifier | exit 0, arm64 + x86_64, incl. new suppression suite |

Dependencies were installed fresh at the pin (`bun install --frozen-lockfile`, 99 packages);
no borrowed `node_modules`. The GhosttyKit artifact was verified to match the pin's
`native/toolchain-lock.json` generation before use.
