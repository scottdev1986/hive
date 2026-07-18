# Gate 6 checkpoint/restore qualification — evidence index (three-fix pin)

Agent: diego · Category: complex_coding · Updated: 2026-07-18
Branch: hive/diego-category-complex-coding-m1-b1
Base: main 655c9c1c (landed Gate 2/5 e13480fb; Gate 3/7 reviewed pin e6d5413c).
Format contract: docs/terminal/checkpoint-format-v1.md
Serializer: vendor/ghostty/src/hive_checkpoint.zig (patch 0001) + restore hunks (patch 0003)
Patch series: patched-tree e9030ee5, series da6bc38f (vendor verify + lock validation green)
Engine build ids (new format): arm64 7791a60d… · x86_64 34e0e103… (cross-arch inequality)

## Delta fixes carried by this pin (all with regressions + positive controls)

1. RESTORE USE-AFTER-MOVE (found: dominic/edith integration; confirmed present
   here). restoreStream returned a replayed TerminalStream by value; a partial
   OSC engages osc.Parser.Capture whose writer + fixed backing reference the
   stream's own storage, so the move left it dangling → later OSC continuation
   wrote through the stale pointer (EXC_BAD_ACCESS, deterministic under Gate 3's
   async tick). Present in BOTH production paths (lib-vt checkpoint_import AND
   embedded HiveManual.restore). FIX: restoreStream is infallible in-place
   init+replay into caller-owned final storage; both call sites build the
   stream after the terminal swap in a point-of-no-return region.
   REGRESSION: pins the engaged capture's writer POINTER IDENTITY in final
   storage + completes the OSC end-to-end. POSITIVE CONTROL: RED under the
   by-value shape (scratch revert).

2. PAGE-COUNT ALLOC-BOMB (found: edmund review). count validated only vs
   payload SIZE, then MemoryPool.init preheated count × ~512 KiB before any
   page validated → multi-TB preheat within the 64 MiB cap. FIX: reject a
   count the remaining payload cannot structurally back (>= page_size_min raw
   bytes/page) + cap the preheat (pools grow on demand). REGRESSION: proves
   reject with ZERO allocations via first-alloc failing allocator. POSITIVE
   CONTROL: RED without fix (OutOfMemory vs InvalidCheckpoint).

3. GRAPHEME/HYPERLINK-MAP INTERIOR-OFFSET UB — corruption-A (found: my
   extended fuzz; queen Decision-1 = option A). grapheme_map/grapheme_alloc/
   hyperlink_map store interior offsets whose alignment is asserted on deref
   (Offset.ptr → unreachable in ReleaseFast); their headers live in raw
   backing memory with no public accessor, so minimal in-place validation is
   not cleanly reachable. FIX: scrub those regions on the wire + rebuild cell
   associations from range-validated side tables via public appendGrapheme/
   setHyperlink (same pattern as styles/hyperlink_set) — no raw byte
   dereferenced on decode. Also validated: row cell offsets + cursor
   bounds/pin-coordinate-match before any cell deref. POSITIVE CONTROL: the
   aggressive u32 fuzz CRASHED (grapheme Offset.ptr assert, then screen
   assertIntegrity) on the pre-fix code; GREEN after. Deterministic regression
   over a grapheme+hyperlink payload asserts reject-or-roundtrip, no
   crash/leak. NOTE: the earlier 15 GB watchdog kill was diagnosed as
   AGGREGATE fuzz cost (un-strided full-payload sweep under a
   metadata-retaining DebugAllocator), NOT an unbounded decode alloc — the
   bounded 128 MiB arena sweep peaks at 700 MB and passes; every decode
   allocation is payload/capacity-bounded.

## Carry-forward proofs (re-run required on new format)

- Cross-build determinism (3 clean builds, both arches, full fixture corpus):
  GREEN on new format — fixture_difference_count=0 (repro-gate6-v3b.log,
  exit 0; shipped runtime a==b==c byte-identical on a warm cache). The v3
  run's build-a variance in GhosttyKit's libghostty-internal.a was a polluted
  first-build cache artifact (b==c proved source determinism); it is a
  manifestation of the KNOWN Gate-4 path/cache-independence follow-up
  (dexter's B1.0 finding: static archives embed ~22,254 absolute build-path
  references), non-blocking for Gate 6, NOT a checkpoint-determinism issue.
- Backlog A arch-proof (page size held equal): arch-proof-fingerprints.txt
  (re-run on new format).
- FULL APP RESTART (both-arch release lock, cross-lib cross-process): re-run on
  new artifacts.
- Both-arch headless harness "all checks passed" + cross-arch build-id
  inequality: GREEN (build-run3.log; 7791a60d != 34e0e103).
- Backlog B: unfingerprinted-type serialization is a compile error.
- Backlog C: ci-release-lock-wiring.txt (CI does not invoke the release lock).

## Suites on the fixed tree

- Full test-lib-vt: only failure was proven-PRE-EXISTING tertiary-DA (edwin;
  landed fix c4325217 on main — gone at landing rebase). All checkpoint/restore
  tests green.
- sessiond 0, typecheck 0, bun test green.

## Cited cross-gate contracts

- Gate 2/5 (dimitri): main e13480fb / baseline 11792ac3.
- Gate 3/7 (dominic): pin e6d5413c.
- DA3 fix (edwin): landed main c4325217.

## Landing turn (COMPLETE — rebased onto main d3e4b282, async base)

Rebase: replayed the three-fix serializer + in-place restore onto main. main's
HiveManual.restore was still the by-value UAF (Gate 3 async did not touch the
restore fn), so my fix applied to a Gate-3-untouched region — no foreign-code
merge. Series regenerated: 0001 re-spliced, 0002 absorbed-hunks stripped, new
ordered 0003 restore delta; patched-tree 7bad8cc8, series 5de6aa43; vendor
verify + lock validation green; six exports + symbolListSha256 unchanged (no
fork-surface growth). Post-rebase build ids: arm64 de9688e2 · x86_64 4eb4c9f6.

Async items (all done + proven, both arches):
- Gate6SurfaceRestoreTests UN-SKIPPED; pumpMainQueue drives Gate 3's async
  callback delivery; restoredWrites.isEmpty made non-vacuous (pumped) plus a
  new assertion that real DSR reply bytes flow (referenceWrites/restoredWrites
  non-empty, not empty==empty). UAF fix makes pumping safe.
- qualify-ghostty-release-lock.sh asserts the test PASS-executed AND was NOT
  skipped (xctest exits 0 on XCTSkip/zero-match — the false-green).

Landing-turn proofs:
- RELEASE LOCK async: EXIT=0, "executed and passed (not skipped)" on arm64 AND
  x86_64 (release-lock-landing.log).
- POSITIVE CONTROL (mandatory): forced XCTSkip → release lock EXIT=1; xctest
  itself exited 0 ("Executed 1 test, with 1 test skipped and 0 failures" — the
  false-green) but the not-skipped assertion caught it: "did not PASS-execute …
  (skipped or zero-matched?)" (release-lock-poscontrol.log). Guard bites.
- Determinism post-rebase: fixture_difference_count=0, shipped runtime a==b==c
  (repro-landing.log, exit 0).
- typecheck 0, sessiond 0. Full test-lib-vt: tertiary-DA gone post-rebase
  (edwin's DA3 landed on main).
