# Cross-vendor review — howard's B2.4 viewer-semantics bundle, pin `ba7e2557`

Reviewer: helen. Reviewed at the frozen pin
`ba7e25573e6bfb7ee8e38bddd81766bc92d343e5` (branch
`hive/howard-m1-item-3-hard-critical-path-b`), which contains main `79179d41`.

**Verdict: PASS**, with two follow-ups and one verification leg I could not
independently reproduce. C1 execution unblocks.

## Materialization

The pin was confirmed as the exact tip both by howard and independently by me:
4 commits, tree clean, based on `79179d41`.

**Main moved twice during the review** (`79179d41` -> `56907f63` -> `4ab8a45d`,
and later `0fc26a6c`), so the pin is *behind* main and must be rebased before
landing. The file sets are disjoint from everything that landed since, so the
rebase should be textually clean — but it must be re-verified green (F2).

There is a semantic adjacency worth naming: howard edits `pumpHostFrame`, the
exact function whose internals hector changed in the resize-receipt work. It is
benign — production fix #1 fires only when `highWater` *advances*, and resize
receipts return `.continueReplay` without advancing it, so the two changes
cannot interact.

## Reproduced at the pin

All runs mine, real unpiped exit codes.

| Check | Result |
| --- | --- |
| `swift test` | exit 0 — **449 tests, 9 skipped, 0 failures** |
| `bun run typecheck` | exit 0 |
| `make sessiond` | exit 0 (ReleaseFast) |
| `make workspace` | exit 0 |
| `scripts/qualify-hive-terminal-b24.sh` | **exit 0** |

**The qualify result closes a gap howard disclosed himself.** He reported —
unprompted — that his qualify/Instruments pass ran immediately *before* the final
rebase that produced `ba7e2557`, so the committed evidence was carried forward
byte-for-byte rather than regenerated at the pin. I ran the full script *at*
`ba7e2557`, into a separate evidence directory, and my `qualification-summary.txt`
is **byte-identical** to his committed one. The bundle is therefore attributable
to the reviewed hash by measurement, not by attestation.

### Live metrics — same order, as required

| metric | howard | helen | delta |
| --- | --- | --- | --- |
| `input_bytes` | 86,028,153 | 86,028,153 | **identical** |
| `scrollback_limit_bytes` | 50,331,648 | 50,331,648 | **identical** |
| `settled_bytes` | 50,152,312 | 50,365,328 | +0.4% |
| `peak_growth_bytes` | 34,619,416 | 35,110,936 | +1.4% |
| `settled_growth_bytes` | 0 | 0 | identical |

The deterministic quantities are byte-identical and the memory measurements agree
within ~1.4%. `settled_bytes` lands just above the 48 MiB configured bound — the
bound is doing the work rather than being incidentally satisfied.

## Mutations

- **A — production fix #1 reverted** (`pumpHostFrame` no longer notifies on
  high-water advance): **RED**,
  `testProductionHostFrameMarksNewOutputWhileViewportIsAnchored`. Bites.
- **C — scrollback bound row removed** from the engine policy list: **RED**,
  `testProductPolicyPinsBoundedHistoryAndLocalSelectionAfterTheme`. Bites.
- **B — production fix #2 reverted** (unseen-output no longer reads the atomic
  semantic viewport): the unit suite stayed **fully GREEN** (250 tests, 0
  failures). I did not stop there: re-running the *live* leg with the mutation
  still in place went **RED** precisely on the new-output badge
  (`XCTAssertEqual failed: ("nil") is not equal to ("Optional("New output ↓"))`).

So fix #2 is covered — but only by `testLiveRenderedSustainedOutputQualification`,
one of the 9 skips in a normal run. See F1.

## Gate 9 / clipboard — PASS, structurally

- `HiveGhosttyActionPolicy.handle` returns `false` on **every** verdict path, and
  the new `SEARCH_TOTAL` / `SEARCH_SELECTED` cases live in the *observe*-switch,
  which is entirely separate from the *verdict*-switch that determines the return.
  Forwarding a tag cannot change its security disposition.
- Both tags are in `engineInertTags`, asserted twice — including
  `testHandleRoutesThroughTheVerdictNotABlanketFalse`, which drives the real
  callback, asserts the return is `false`, **and** asserts the verdict was routed
  rather than blanket-returned. That is behavior, not the table, and it answers
  the earlier cross-vendor criticism the test cites.
- `copy-on-select = false` is present, `clipboard-read/write = deny` retained, and
  an ordering test pins `copy-on-select` *after* the theme so it cannot be
  overridden by a later row.
- `canCopySelection` prefers the atomic snapshot per queen ruling `c1784ed2`;
  production `GhosttyManualSurface` conforms to
  `ManualSurfaceSemanticSnapshotProviding`, so the tearing-prone `readSelection()`
  fallback is reachable only by test doubles.

## Test seam in a production file — PASS

`GhosttyBridgeFactory.makeManualSurfaceForConfigurationTesting` is a new seam in
`Sources/`. It is **internal, not public**, with three call sites, all in
`B24ViewerSemanticsTests`, and **zero** production call sites. `HiveWorkspace`
cannot reach it across the module boundary at all — containment enforced by the
type system rather than by a runtime gate, which is stronger than an env-var seam.

## Honesty — the #47 deferral is wired, not merely disclaimed

`HIVE_B24_SCREENSHOT_PATH` is an `XCTUnwrap`, so the live test *fails* if the slot
is absent, and `capture(window:at:)` refreshes it on every run. The capture is
therefore mandatory and continuous; what is deferred is **admissibility**, not
existence. The deferral is recorded in four places with root cause and owner
(horst). Nothing auto-fails when #47 lands — the flip is manual — but howard is
performing exactly that flip as a separate follow-up commit, retaining `ba7e2557`
as the reviewed reference.

## Evidence and manifest hygiene — PASS

20 manifest entries = 20 files present; all 20 tracked in HEAD; the manifest
correctly excludes itself (and is itself tracked, 21st file); `.trace` directories
are consistently gitignored *and* excluded from the manifest; all 20 shas verify
from HEAD.

*Instrument caveat worth recording:* my first pass reported all 20 files as
untracked. That was PATH corruption inside my own command — `head: command not
found` in the same output was the tell — not evidence. Re-run with positive and
negative controls it is clean. A false alarm from the instrument, not the tree.

## Known traps — spot-checked

- **Journal rolling window:** explicitly avoided and documented —
  `history_source=in-memory OUTPUT frames captured immediately; rolling sessiond
  journal was not used as unbounded history`.
- **Settle-then-assert on counting rows:** the memory rows settle before
  measuring, with peak tracked as a running max.
- **Drag-selection higher-endpoint-exclusive:** the `drag()` rows assert mouse
  *routing* (local / captured / Shift-override), not endpoint arithmetic, so this
  trap does not arise here. Recorded as *inapplicable*, not as *handled*.

## Not independently reproduced (1 of 6 items)

The **live vttest regeneration**. howard's recipe, run on my own port 43120, dies
at session create with `sessiond VERIFICATION_UNKNOWN`.

What I ruled out:

- My environment: a control run of the same harness on the same port *without*
  `SHELL=` the shim comes up normally and writes `b22-proof.json`. The shim is the
  only variable.
- Corpus staging: all three shim pins verify exactly — archive `cd6886f9…`, binary
  `adac6a5d…`, version `2.7 (20251205)`.
- Quarantine attributes, and the shim's executable bit.

howard traced the cause honestly on request: `ProductionHostLauncher.launchCallback`
collapses *any* `launchOne` exception to `null`, and `broker.launchHost` maps
`null` to `VERIFICATION_UNKNOWN`. **The error name is misleading** — it is not
evidence that a SHELL-specific verification rule rejected anything; the real inner
error is discarded. His suggested discriminator (running the shim under a fresh
PTY via `script`) could not run here either: my agent shell has no controlling
TTY (`tcgetattr/ioctl: Operation not supported on socket`), which is itself a
plausible differentiator given the shim's first act is `stty sane`.

**This leg rests on howard's attestation** (regenerated sha `bd8251f8…`, `cmp`
exit 0), not on my reproduction. Stated as such rather than claimed.

What I *did* verify structurally is that the fixture is not self-verifying: it is
produced by a live, opt-in test driving the sha-pinned vttest through the real
input path (`real Ghostty key encoder -> authenticated human CLAIM_ACQUIRE ->
INPUT_SUBMIT -> correlated APPLIED`), with positive controls recorded, and its
sha appears only in evidence files — never as a test oracle.

## Follow-ups (neither blocks)

- **F1** — production fix #2 has **no unit coverage**. Reverting it keeps
  `swift test` green; only the live GUI qualification leg catches it, so a
  regression passes CI and surfaces only in a manual qualify run. Asymmetric with
  fix #1, which is unit-covered. A unit test with a fake snapshot provider would
  close it.
- **F2** — the pin is behind main and must be rebased; the overlap analysis says
  clean, but it must be re-verified green before landing.
