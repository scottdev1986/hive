# B2.6 accessibility — post-hoc cross-vendor review (helen's half)

Reviewer: helen. Landed range `d5750507..53b32a4b` (hedda), reviewed post-hoc at
full pre-land rigor after it landed without review.

**Verdict: FOLLOW-UP REQUIRED.** No behaviour defect. Not revert.

This is one half of a split review. henrietta independently completed the whole
thing before the split was assigned, and owns the **AX-evidence half** —
artifact consistency, the tearing mechanism, the capture path's settles, and the
ordering call. Her findings are the load-bearing ones and are written up
separately in
[`hive-terminal-b26-post-hoc-review-henrietta.md`](hive-terminal-b26-post-hoc-review-henrietta.md).
This document covers only **suites, mutations, attribution and adaptation**, and
does not restate hers.

## Patch claim — CLEAN, verified first

Everything downstream hangs on this, so it was checked before anything else.

- `ghostty.patchSeriesSha256` is `ddeaf792…` identical at `53b32a4b` and at main.
- `0004-hive-semantic-snapshot.patch` is already in `native/ghostty-patches/` AND
  baked into the built artifact's `provenance/patches/`.
- The 22-file range touches **no** `toolchain-lock.json`, **no** `vendor/`, **no**
  `native/ghostty-patches/`. It is entirely `workspace/` + `scripts/` +
  `raw/qualification/`.

So: no patch added, no GhosttyKit rebuild, nothing downstream implicated. The
author's claim was exactly true.

## Suites

| Check | Result |
| --- | --- |
| `swift test` @ `53b32a4b` | exit 0 — **447 tests, 8 skipped, 0 failures** |
| `swift test` @ `43142f55` (F3 pin) | exit 0 — **448 tests, 8 skipped, 0 failures** |
| `Gate10AccessibilityTests` | 14/0 |
| `Gate10SemanticSnapshotTests` | 6/0 |
| `Gate9CallbackMatrix` | 9/0 |

The full-suite runs are this review's own contribution: the author had run
targeted filters and `swift build --target`, but no full unpiped suite.

## Mutations

Run at both `53b32a4b` and, after a production refactor landed on top, again at
`43142f55`.

- **M1 — neutralise the selection snapshot diff** (`:215`, later `:261`):
  **RED** at both pins, `testSelectionChangePostsAccessibilityNotification`.
  The selection coverage is real, and the `withPinnedSnapshot` refactor did not
  hollow it out — which was the main regression risk of a production change
  landing on top of a reviewed finding.
- **M2 — delete the real `NSAccessibility.post`, keep the probe**: **GREEN** at
  both pins (3/3 runs at the F3 pin). No machine test detects removal of the
  real AppKit post; the suite proves posting *decisions*, not delivery.

### A false positive I caught on myself

The first M2 run at `43142f55` went **RED**, and the tempting reading was "the
refactor accidentally closed the post seam". It had not. Three unmutated runs and
three further M2 runs were all clean; the failure was an unrelated intermittent
assertion (`testRecordedAccessibilityTreeDumps`, `childCount == geometry.rows` on
the resize path, 1 failure in 7 runs).

**n=1 is not causation.** Reporting that first run as a result would have shipped
a false positive in the flattering direction. It is recorded here because the
check that caught it — re-run before you attribute — is cheap and was nearly
skipped.

That intermittency was handed to henrietta as hers, and hedda subsequently
root-caused it (engine-snap vs cached-children settle under `setSize`) and fixed
it in `92d2fe09`: stress 20/20 (was 13/15), dump sha identical across N=5.

## The seam — disclosed, not discovered

`post()` calls the real `NSAccessibility.post` and then `notificationProbe`, so a
test watching the probe cannot tell whether the AppKit call happened. hedda
**predicted both mutation outcomes correctly before they were run** — that M1
would RED and that M2 would stay GREEN — and named the seam unprompted.

That is worth recording precisely because the landing skipped review: nothing in
the work was hidden. The two findings raised here were both about making implicit
things explicit, and both were addressed in `fb68a408`, whose wording is stronger
than what was asked for: *"a green Gate-10 suite is NOT permission to delete or
skip `NSAccessibility.post`."*

## Attribution — measured, not taken on trust

The nine-minute turnaround on a story graded HARD is only plausible if duncan's
`943407ba` carried most of the content. It does:

- duncan's `HiveTerminalView+Accessibility.swift`: **484 lines**
- hedda's: **614 lines**
- added 148, removed 18 → **466 of duncan's 484 lines (96%) carried through
  verbatim**, and ~76% of the final file is duncan's

The description "core controller/row/refresh/overrides ≈ wholesale" is accurate,
and attribution appears in three places: the file header, `provenance.txt`
(`foundation=duncan 943407ba … forward-ported/adapted`), and the doc. Nothing is
passed off as new.

## Adaptation quality

The wiring into `HiveTerminalView.swift` and `+Input.swift` is purely **additive
hooks** at existing lifecycle points (invalidate, bell, clipboard-denied, close,
first-correct-frame, reconnect, geometry, focus). No existing B2.4 logic is
modified.

The one structural change — `setSurfaceState` gaining a `changed` guard before
announcing — is a correct improvement: it prevents spurious AX posts on no-op
state sets.

No conflict with B2.4's `noteOutputApplied`/`scrollState`; both read the same
atomic snapshot.

## Findings

- **F1** — the real `NSAccessibility.post` is covered by no machine test. Design
  intent is that real-AX verification lives in the `PENDING_HUMAN`
  Inspector/VoiceOver slots, which is defensible, but the dependency was
  implicit. **Addressed by `fb68a408`.**
- **F2** — the six non-teardown dumps are recorded pre-`.live`
  (`lifecycle=Terminal starting`, renderer never presents in the xctest host —
  the same semantics-vs-pixels split as #47). Origin was documented; the
  pre-live lifecycle was not. **Addressed by `fb68a408`.**
- **F3** — henrietta's, and the load-bearing one. Per-accessor provider re-reads,
  an internally inconsistent committed artifact, vacuous settles, and a
  can't-fail assertion. See her document. **Open at the time of writing**; her
  ordering call is settle-fix first, re-capture last, determinism proven by
  repetition rather than by one clean run.

One contribution to her half from this one: hedda's
`fixtures/torn-ax-tree-alternate-screen-exit.txt` is **byte-identical**
(`d861c644…`) to the real committed torn artifact, so the audit's positive
control input is the genuine defective file rather than a synthetic lookalike.
Whether the audit actually goes RED on it remains hers to confirm.
