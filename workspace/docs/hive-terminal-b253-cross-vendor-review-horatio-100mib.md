# B2.5.3 100-MiB pane ordered-output leg — independent cross-vendor review (harper, Claude)

**Subject:** horatio (Codex), branch `hive/horatio-m1-item-6-hard-b2-5-production`
**Code pin:** `064e7de8d47806ad4ca462e8b4c0d9fc9690d009`
**Evidence tip:** `9a02ae946da13181f1f0cdbbf50d2d335134f873` (code pin confirmed an ancestor)

**VERDICT: PASS.**

Every claim in this leg is carried by its instrument, and the two claims most at
risk of being decorative — main-run-loop responsiveness, and Gate-5 prior art —
both survived a direct attack. This leg is also free of the durability defect I
filed against the A4 quit cell (F2 there); its generator emits every structural
field itself.

## Method

Verified from `git archive 9a02ae94`, plus a full independent re-run in a detached
worktree at the evidence tip (`/tmp/hb25s`, `cp -Rc` warm cache, `make ghostty`).
Real exit codes throughout; nothing piped.

| Command | Exit | Result |
|---|---|---|
| `shasum -a 256 -c .../evidence-sha256.txt` (archive root) | 0 | 21/21 OK, 0 FAILED |
| `HIVE_B25_STRESS_RUN_ID=harper-baseline swift test --filter PaneOrderedOutputStressTests` | 0 | Executed 2 tests, 0 failures |
| **stall probe** (1.0s main-thread sleep injected) | **1** | `maxHeartbeatGap` 0.0362s → **1.0183s**, assertion failed |
| `HIVE_B25_EVIDENCE=/tmp/hb25rev-pane bun scripts/b25-pane-stress-proof.ts` | 0 | full regeneration |

`bun run test:sessiond` and `zig build test` were not run (#54 deadlock).

My baseline reproduced every invariant exactly: `bytes=104857600`, `chunks=1600`,
`streamHighWater=104857619`, `stressAppliedAcks=1601`, `finalAppliedAcks=1602`,
mutation `highWater=19`. Only the timing-dependent values moved (duration 23.741s
vs his 21.347s; heartbeats 2369 vs 2132; maxGap 0.0362s vs 0.0326s), which is what
should move between hosts.

## 1. The responsiveness claim is non-vacuous — proven by injected stall

This was the claim most worth attacking, because a heartbeat can easily be wired
somewhere that cannot observe the work it purports to measure.

The instrument is sound by construction: a `Timer(timeInterval: 0.01)` on
`RunLoop.main` in `.common` mode, while every one of the 1,600 frames is pumped
via `DispatchQueue.main.sync { terminal.pumpHostFrame(...) }`. The pane work
therefore genuinely occupies the main thread, and the timer can only fire between
chunks — so a main-thread block necessarily starves it and widens the gap.

Two independent confirmations that it is live, not decorative:

**Arithmetic coherence.** His run: 21.347s ÷ 0.01 ≈ 2,135 expected fires against
2,132 observed — three missed ticks, matching a 0.0326s max gap. Mine: 23.741s ≈
2,374 expected against 2,369. A fabricated or disconnected metric would not stay
consistent across two hosts at two durations.

**Direct mutation (queen's requirement).** I injected a 1.0s `Thread.sleep` inside
the `DispatchQueue.main.sync` block on chunk 800 and re-ran:

```
maxHeartbeatGap=1.0183s   (baseline 0.0362s)
PaneOrderedOutputStressTests.swift:85: error: XCTAssertLessThan failed:
  ("1.0182768333470449") is not less than ("0.5")
  - pane blocked the main thread for 1.0182768333470449s
```

Real exit 1. The metric tracked the injected stall to within 2 ms, and the `<0.5`
assertion bit. Every other invariant (bytes, chunks, high-water, both ack counts)
was unchanged, so the stall isolated cleanly to the responsiveness metric rather
than perturbing the run. **A main-thread stall would be detected.** The source was
reverted afterward and re-hashed to the pinned `487edabd…`.

Note the assertion threshold (`0.5`) is the same value the manifest publishes as
`limits.maxHeartbeatGapSeconds`, so the declared limit is the enforced one.

## 2. One-byte gap mutation — PASS, and non-vacuous as a pair

`testOneByteSequenceGapBreaksThePaneRow` pumps a frame at `streamSeq = before + 1`
and asserts three things: high-water unchanged, `engine.throughSeq` unchanged, and
`surfaceState == .lost(evidence: "REBASE_REQUIRED")`. It passed in my baseline and
again inside the generator run (`highWater=19`).

Worth naming explicitly, because "nothing changed" assertions are the classic
vacuity risk: an inert fixture would also leave high-water unchanged. That reading
is defeated *by the pairing* — the 100-MiB test proves, in the same fixture, that
`pumpHostFrame` does advance high-water across 1,600 contiguous frames. One test
proves frames land; the other proves a gapped frame does not. Neither alone would
settle it; together they do. The third assertion (`REBASE_REQUIRED`) additionally
requires the product to *actively report* the detection, not merely decline to
advance. The pipe detects corruption rather than swallowing it.

## 3. Gate-5 prior art — PASS, verified as a live check

The citation is not a copied constant. `b25-pane-stress-proof.ts` reads the prior
transcript's bytes, recomputes the SHA-256, and compares it against Gate 5's *own*
`evidence-sha256.txt` — an independent source of truth — throwing
`"Gate 5 row-C prior-art transcript failed its recorded SHA-256"` on mismatch. It
then asserts each of the three cited controls appears in the transcript as
`<testName>]' passed`, throwing if any is missing. So "PRIOR ART VERIFIED" means
the file is both intact *and* still contains the green controls it is cited for.

I confirmed the cited artifact is the landed one, by blob identity rather than by
path: `e204c7e3` is an ancestor of `main`, and
`e204c7e3:raw/qualification/ghostty-b1-gate5-ordered/arm64-stress-xctest.txt` and
`main:` the same path both resolve to blob `9c038df587ded7c8…`. The recomputed
digest `30f40a47…` matches the manifest.

## 4. Honest boundary — PASS, and stated where a reader lands

No cell claims physical rendering. I grepped the leg's matrix and manifest for
`metal|physical|pixel|rendered on screen`: the only hit is the disclaimer itself.

The separation is stated in both places a reader actually arrives:

- `matrix/stress-100mib-pane.txt` — *"NOTE locked XCTest cannot create the physical
  Metal surface; this row uses the real headless Ghostty C surface inside the real
  Workspace pane hierarchy. Production physical pane evidence is a separate B2.5 cell."*
- `EVIDENCE.md` prose — *"The locked XCTest uses Ghostty's real headless manual
  surface, while the separate production-pane cell owns physical Metal/window
  evidence."*

The manifest's `panePath` stops at `hive_ghostty_surface_process_output_v1` and
claims nothing past the C boundary. This is the same composed/pending discipline
the A4 quit cell showed, applied correctly again.

## 5. Evidence hygiene — PASS, and no A4-style durability defect

Self-check is clean: 21/21 OK from a git-archive, real exit 0, all three stress
artifacts covered.

The manifest is faithful to its transcript — every published metric (2132, 0.0326,
104857600, 1601, 1602) appears in the XCTest transcript's own print line, and the
two are bound by a shared `runID=b25-pane-mrsw4u55`. That binding is a real
property: it defeats substitution of a transcript from a different run, which
adjacency alone would not.

**Queen asked whether this leg's generator carries the A4 F2 defect. It does not.**
I re-ran the generator and diffed structurally: `cell`, `ok`, `head`, `panePath`,
`limits`, `mutation`, `priorArt.sha256`, `priorArt.controls`, and `environment` are
all regenerated identically, and the boundary NOTE, the MUTATION VERIFIED line, and
the PRIOR ART VERIFIED line are all emitted by the script. Only genuinely run-specific
values differ (`runID`, `startedAt`, `durationSeconds`, `heartbeats`,
`maxHeartbeatGapSeconds`), plus `head`, which correctly tracked my worktree's HEAD
because the generator reads real HEAD rather than a baked constant. Nothing here is
hand-applied, so a re-run cannot silently revert an honest field. horatio stated
this in advance and it checks out.

## Findings (non-blocking)

**G1 — absolute worktree paths in the manifest**, same as A4's F6:
`test.transcript`, `test.source`, and `priorArt.artifact` point into
`/Users/scottkellar/…/worktrees/horatio/…`, which resolve for nobody else. This is
the one structural field that differed on regeneration, purely because the path
follows the checkout. Repo-relative pointers would travel.

**G2 — `heartbeatCount > 10` is a very loose floor.** Actual counts are ~2,100–2,400.
A run that fired 11 times would pass a check whose sibling assertion assumes
continuous sampling. The max-gap assertion is doing the real work; this one would
not catch a badly degraded timer. Tightening it toward the expected
`duration / interval` would make it bite.

**G3 — prior-art controls are matched by substring** (`"<testName>]' passed"`).
The pattern is distinctive enough that false positives are unlikely, and the SHA
check makes the file's identity certain, so this is an observation rather than a
defect. Structural parsing would be strictly stronger.

**G4 (process, not this pin) — the skipped-suite hazard recurred, on me.** My first
stall probe used a guessed test name; `swift test` reported
`"No matching test cases were run"`, `Executed 0 tests`, and **exit 0**. Had I read
the exit code alone I would have recorded a stall probe that never ran as a pass —
which is exactly F3 from the A4 review, seen from the other side. It reinforces that
F3 is worth fixing in `runSwiftTest`: assert `Executed N > 0` with zero skips, never
exit code alone.

## Environment

arm64 macOS 26.3.1, Swift 6.3.3, Ghostty `73534c4680a809398b396c94ac7f12fcccb7963d`.
Reviewed under a locked GUI session; the leg's headless-surface boundary is
declared rather than worked around, so no lock-blocked evidence was chased.
