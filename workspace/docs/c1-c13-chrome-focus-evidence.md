# C1.3 — Pane chrome, padding, and the focus affordance: evidence

Author: hazelton. Status: **PINNED, awaiting cross-vendor review.** Not landed.

Predecessor hollis2 landed C1.0–C1.2; this increment is greenfield on top of
them. Reviewer is Claude (Codex and Grok pools are quota-dry until 2026-07-26),
so this document is written to be **re-derived from first principles** rather
than read and trusted. Every command is exact and runnable.

---

## 0. The headline: C1.3's no-vibrancy rule was violated by landed code

Before this increment, `PaneView`'s background was an `NSVisualEffectView`:

```
workspace/Sources/HiveWorkspace/PaneView.swift:12   private let backgroundView = NSVisualEffectView()
                                            :87-94  material .contentBackground, blendingMode .withinWindow, state .active
                                            :158    backgroundView.addSubview(contentView)
                                            :40     contentView.addSubview(terminalView)   // HiveTerminalView
```

So the terminal surface descended from a vibrancy-enabled view — exactly what
the story forbids at line 142 ("The terminal surface therefore must not be a
descendant of a vibrancy-enabled view") and what DoD item 6 requires be
*proven* false.

This was not a missing check. It was a live defect, and it shipped through
C1.0–C1.2 because nothing tested for it. The pre-existing test that came
closest, `AppDelegateLifecycleTests.testStatusAndFocusOverlaysAreAboveTheOpaquePaneBackground`,
actually **located the pane background by `$0 is NSVisualEffectView`** — it
encoded the defect in its locator, so it could never have caught it.

**Fix:** `PaneBackgroundView` (new, `Sources/HiveWorkspace/PaneBackgroundView.swift`)
— a plain opaque `NSView` filling with the semantic `controlBackgroundColor`.
The pre-existing test's locator was updated to `PaneBackgroundView`; its intent
and every assertion are unchanged.

### The natural positive control — the check RED on the real pre-fix tree

The strongest evidence that this check is real is that it fails against the
actual shipped defect, at the actual commit, in a pristine checkout — not
against a defect invented to be caught.

```
commit:  eccf2c58c8f7f1501be1f3ef54ee8a9c3cbf93ad
tree:    pristine, via `git worktree add --detach`
         PaneView.swift:12 reads `private let backgroundView = NSVisualEffectView()`
command: cd workspace && swift test --filter C13NaturalControlTests
```

```
C13NaturalControlTests.swift:44: error: -[...testTerminalContentHasNoVibrancyEnabledAncestor] :
  XCTAssertTrue failed - Terminal content descends from a vibrancy-enabled view:
  NSVisualEffectView (NSVisualEffectView).
Test Case '-[...testTerminalContentHasNoVibrancyEnabledAncestor]' failed (0.406 seconds).
Test Case '-[...testWalkSeesAPlantedVisualEffectView]'            passed (0.000 seconds).
REAL_EXIT=1
```

The second line is what makes the first a *finding*: the walk's own instrument
control passes on that same tree, so the failure is a real detection and not a
broken traversal. Full record and the exact test source (which references
nothing C1.3 adds, so it compiles on unmodified main):

```
workspace/docs/evidence/c13-natural-control-prefix-main.txt
workspace/docs/evidence/c13-natural-control-test.swift.txt
```

The **synthetic** control — planting an `NSVisualEffectView` post-fix — is
`testVibrancyCheckDetectsAPlantedVisualEffectView`, and mutation case
`replant-visual-effect-background` re-creates the historical defect in place.
Three independent ways of showing the check is not vacuous.

### Behavioral fallout from dropping NSVisualEffectView

`NSVisualEffectView` is not only a look: its material re-resolves automatically
across light and dark. Pane chrome may have been riding that rather than owning
it, so the replacement had to be **shown** to preserve what mattered, not
assumed to.

`testPaneBackgroundStillRespondsToAppearanceAfterDroppingVibrancy` renders the
background under `.aqua` and `.darkAqua` and samples it:

| Appearance | Center luminance |
|---|---|
| `.aqua` (light) | `1.0` |
| `.darkAqua` (dark) | `0.11863740533590317` |

The semantic `controlBackgroundColor` re-resolves, so the automatic response is
preserved by a different mechanism rather than silently lost. Mutation case
`hardcode-the-background-color` proves this check bites: swapping the semantic
fill for `NSColor.white` turns it RED.

**A finding against my own code, kept visible rather than tidied away.** I first
also added an explicit `viewDidChangeEffectiveAppearance` override to schedule
the repaint, plus a test for it. Mutation case
`stop-repainting-on-appearance-change` came back **GREEN** — neutering the
override changed nothing. A direct probe confirmed why: AppKit's own
`super.viewDidChangeEffectiveAppearance()` already invalidates the view.

```
after super-only call, needsDisplay = true
```

The override was dead code and its test was decoration, so **the override, the
test, and the mutation case were all removed**. This is recorded rather than
quietly dropped because it is exactly what the mutation proof exists to find.
(`PaneFocusRingView` carries the same likely-redundant pattern. It is
pre-existing and was left alone — flagged, not touched.)

---

## 1. What was built

| Item | Status |
|---|---|
| No glass/vibrancy behind terminal content | **Done** — `NSVisualEffectView` background replaced; ancestor check + mutation proof |
| Overlay-vs-sublayer hazard **proven**, not asserted | **Done** — see §3 |
| Focus by attenuation | **Done** — `PaneAttenuationView`, unfocused panes dimmed |
| System focus indicator | **Already landed** — `PaneFocusRingView` draws `.keyboardFocusIndicatorColor`; unchanged |
| Padding, balance, extension | **Already landed in C1.1** — verified present, not rebuilt (§5) |
| Thin divider | **NOT built — open design decision, see §6** |
| Cell-based pane minimums | **NOT built — see §6** |
| Every-pane-count captures | **LOCK-DEFERRED — see §7** |

---

## 2. Reproducing the environment

The worktree was cold. The ghostty artifact was cloned from the primary
checkout only after verifying all three generation keys matched this worktree's
computed expectation — a mismatched artifact fails *only* surface creation,
silently, so this check is not optional:

```
GHOSTTY_COMMIT    = 73534c4680a809398b396c94ac7f12fcccb7963d
ZIG_SHA           = 3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b
GHOSTTY_PATCH_SHA = ddeaf79284f0072f29d69dbf6580fd8f58eba98ceff11525f83f91f03f6e09e0
```

Verify them yourself with `make -p 2>/dev/null | grep -E '^GHOSTTY_PATCH_SHA :=|^GHOSTTY_COMMIT :=|^ZIG_SHA :='`,
then `make ghosttykit`.

Never `zig build test` or `bun run test:sessiond` (issue #54, build-runner IPC
deadlock). The Swift suite is `cd workspace && swift test`.

---

## 3. The overlay-vs-sublayer hazard, demonstrated failing

> **This proof is not the fix.** The overlay fix already landed, before this
> increment: `PaneFocusRingView` and `PaneStatusBorderView` are sibling
> overlays, hit-test transparent, and there are **zero** `addSublayer` calls in
> `workspace/Sources/`. `PaneFocusRingView.swift:8-11` documents the original
> bug in-source. C1.3's job on this hazard is to *prove* the rule that fix
> encodes. Do not read what follows as introducing the pattern.

Repo law says AppKit paints a view's own layer and its sublayers *beneath* the
layers of that view's subviews, so a dimming `CALayer` sublayer under an opaque
background subview is **absent, not subtle**. The story asks for this to be
demonstrated rather than asserted.

`C13PaneChromeTests.testSublayerDimIsAbsentWhileSiblingOverlayDimIsVisible`
builds three constructions that are identical except for how the dim attaches,
renders each offscreen via `cacheDisplay(in:to:)`, and samples the center pixel:

| Construction | Center luminance |
|---|---|
| Negative control — no dim at all | `1.0` |
| **Sibling overlay view** (the sanctioned pattern) | **`0.570460855960846`** |
| **`CALayer` sublayer** (the hazard) | **`1.0`** |

The sublayer dim is **exactly** as absent as adding no dim whatsoever. The
overlay dim, the same 50% black, is plainly visible.

**Why this is a demonstration and not a tautology.** Three things had to hold,
and each is asserted in the test with a message that says so:

1. **Instrument pin** — the negative control must read as the white it was told
   to draw (`1.0`). A capture that returned a constant would otherwise make the
   sublayer result pass for entirely the wrong reason.
2. **Positive control** — the sibling overlay must read materially darker than
   the negative control. If the instrument cannot resolve *this* dim, it cannot
   resolve any dim and the sublayer reading proves nothing. The test says
   "INSTRUMENT FAILURE, not a finding" in that case.
3. Only then is "the sublayer dim equals the undimmed control" meaningful.

Both controls are mutation-proven (§4, cases `sublayer-becomes-an-overlay` and
`break-the-offscreen-instrument`).

This is entirely offscreen — no window server — so it holds under a locked GUI
session.

> Note on reading raw output: `swift test` prints a trailing
> `✔ Test run with 0 tests in 0 suites passed` banner from swift-testing. That
> is an artifact, not a result. The authoritative lines are
> `Test Case '-[...]' passed/failed`.

---

## 4. Mutation proof — every check broken on purpose

A green suite proves nothing by itself; a check asserting a tautology is green
forever. `workspace/scripts/c13-mutation-proof.py` edits one source location
per case, re-runs the tests meant to guard it, and demands RED.

```
python3 workspace/scripts/c13-mutation-proof.py
```

Result — **9/9 RED_GUARD**, working tree restored clean:

| Case | File | RED via |
|---|---|---|
| `replant-visual-effect-background` | PaneView.swift | RED_GUARD |
| `blind-the-vibrancy-walk` | C13PaneChromeTests.swift | RED_GUARD |
| `make-pane-background-transparent` | PaneBackgroundView.swift | RED_GUARD |
| `hardcode-the-background-color` | PaneBackgroundView.swift | RED_GUARD |
| `sublayer-becomes-an-overlay` | C13PaneChromeTests.swift | RED_GUARD |
| `break-the-offscreen-instrument` | C13PaneChromeTests.swift | RED_GUARD |
| `attenuate-the-focused-pane` | PaneAttenuationView.swift | RED_GUARD |
| `attenuation-swallows-clicks` | PaneAttenuationView.swift | RED_GUARD |
| `attenuation-covers-status` | PaneView.swift | RED_GUARD |

`replant-visual-effect-background` is the important one: it restores the *exact
defect that was on main* and the ancestor walk catches it. That gives the check
two independent positive controls — the real historical defect, and the
synthetic planted `NSVisualEffectView` in
`testVibrancyCheckDetectsAPlantedVisualEffectView`.

Harness properties, each of which has burned this repo before:

- **Restore never uses git.** Files are snapshotted in memory and written back,
  then verified byte-for-byte; a failed restore is FATAL and stops everything.
  (`git checkout --` destroys uncommitted work and fails atomically.)
- **Non-matching or no-op mutations abort.** A pattern that silently fails to
  match would report GREEN meaning "nothing was mutated".
- **Anchors must be unique** — `match_count != 1` aborts. A duplicated guard
  block once meant a mutation edited the wrong copy and measured nothing.
- **RED is classified.** `RED_COMPILE` (did not build) is reported as
  *inconclusive* and never counted as a guard firing. All 9 above are
  `RED_GUARD` — a real assertion failed in a building binary.

Verify restoration yourself: `git status --porcelain -uall` is empty after the
run.

---

## 5. Test counts and the suite

**Executed count equals the source-derived count.** Source says 9:

```
grep -cE '^    func test[A-Za-z]' workspace/Tests/HiveWorkspaceTests/C13PaneChromeTests.swift   # -> 9
grep -cE '^Test Case .*C13PaneChromeTests.* (passed|failed)' <log>                             # -> 9
```

The extractor is itself sanity-bounded (aborts outside 4…40) because a failed
`rg`/`grep` once printed help text that parsed as a 124-name list.

**Full suite, this branch:** `512 passed, 2 failed, REAL_EXIT=1`.
**Baseline, unmodified main in this same worktree:** `495 passed, 9 failed, REAL_EXIT=1`.

### The environment changed mid-increment — read these numbers carefully

The two runs are **not** directly comparable, and the difference is not
attributable to this branch. The baseline ran while the GUI session was locked;
by the final run the session had become available, so seven real-surface tests
that were red under lock now pass. This is an environment change, not a fix
delivered here — no line in this branch touches them.

Reconciled exactly, by name-set difference rather than by count:

```
baseline unique test cases: 504      final unique test cases: 514
executed now but not at baseline:  9 C13 tests
                                 + 1 pre-existing, GhosttyBridgeLinkTests
                                     testSurfaceStronglyRetainsHostViewAndCallbackContext
                                     (needs a real surface; could not run under lock)
executed at baseline but not now:  none
```

504 + 9 + 1 = 514. Nothing disappeared.

Now-passing, previously red under lock (**not** this branch's doing):

```
HiveTerminalKitTests.Gate7RenderingTests       testBackingDisplayAndOcclusionChangesReachRealSurface
HiveTerminalKitTests.Gate7RenderingTests       testProductionViewHostsPinnedGhosttyIOSurfaceLayer
HiveTerminalKitTests.Gate7RenderingTests       testRealOutputProducesGPUBackedLayerContents
HiveTerminalKitTests.Gate7RenderingTests       testRealViewAndRendererOwnerReleaseWithoutExplicitClose
HiveTerminalKitTests.Gate7RenderingTests       testResizeUsesGhosttyReportedCellGeometryExactly
HiveTerminalKitTests.Gate7RenderingTests       testRuntimeHealthActionTargetsOnlyItsRealSurface
HiveWorkspaceTests.SessiondPaneInputFocusTests testFocusedSessiondPaneRoutesRealKeyEventThroughClaimAndOutput
```

Still failing, in the baseline set both times, unrelated to this branch:

```
HiveTerminalKitTests.B20EngineContractTests  testProductionViewSuppressesRepliesAndPresentsOrderedNeutralReplay
HiveTerminalKitTests.B24ViewerSemanticsTests testConfiguredHistoryPrunesOldestRowsButKeepsRecentRowsSearchable
```

**Regressions introduced by this branch: none**, verified by set difference
against the baseline failure set, not by comparing counts:

```
comm -13 <sorted baseline failures> <sorted branch failures>   # empty
```

**One regression was caused and fixed during this increment**, recorded rather
than quietly repaired: replacing the background broke
`AppDelegateLifecycleTests.testStatusAndFocusOverlaysAreAboveTheOpaquePaneBackground`,
whose `XCTUnwrap` located the background by `is NSVisualEffectView`. Only the
locator changed, to `PaneBackgroundView`. No assertion was relaxed.

### Padding is already landed — verified, not rebuilt

C1.1 already emits every padding key the story asks for, in
`HiveTerminalConfiguration.overrideLines`:

```
window-padding-x = 10        window-padding-balance = true
window-padding-y = 8         window-padding-color   = extend
```

Symmetric points, balance on, extension on (the heuristic variant, not
always-extend). Nothing was re-implemented here.

### Inviolables from landed work — all held

- Theme is emitted **before** overrides, so `copy-on-select = false` survives
  any push. Untouched by this increment.
- No configured font family for the embedded font. Untouched.
- Hive-authored config goes through `surface_update_config`, never
  `load_default_files`. Untouched.
- **Gate 9 not weakened.** This increment adds no privileged read of any kind —
  all chrome resolves from semantic `NSColor`s and view structure. No
  `NSWorkspace` call was added.

---

## 6. Open design decision — the divider, and the minimums that depend on it

**I did not build this, and I am not going to pick silently.**

The story adopts Apple's split-view guidance: "prefer the thin 1 pt divider and
set pane minimum sizes such that the divider never appears to vanish."

But this codebase has **no divider and no `NSSplitView`**. Panes are discrete
rounded cards (`cornerRadius 10`) laid out by a deterministic solver into
frames separated by an **8 pt gap** (`WorkspaceCore/LayoutTree.swift:88`,
`LayoutMetrics.gap = 8`). Negative space, not a drawn line.

Drawing a 1 pt line into an 8 pt gap between rounded cards is not the HIG
pattern the story cites — that pattern assumes flush adjacent panes. The three
readings:

1. **Card gap *is* the separator.** Keep the 8 pt gap, build no divider. The
   story's intent (separation always perceptible) is already satisfied.
2. **Convert to flush panes with a real 1 pt divider.** Faithful to the cited
   HIG, but discards the card visual language C1.0–C1.2 built on.
3. **Hairline inside the gap.** Draws the line but between rounded cards, which
   is likely to read as an artifact.

My recommendation is **(1)**, recorded for the C1.5 aesthetic signoff where the
user personally approves — this is a look decision, and it should be made
looking at pixels, not prose.

**Cell-based pane minimums** are coupled to this and also not built. The
rationale the story gives for them is "so the divider never appears to vanish";
with reading (1) that rationale changes to "so a pane never shrinks below a
usable cell count", which is still worth having but is a different constraint.
Mechanically it is a real addition: the solver lives in `WorkspaceCore` and is
pure and deterministic, while cell metrics live in the AppKit/engine layer
(`PaneView.commitCellGeometry`), so cell size would have to be injected into
the solver and `LayoutTreeTests` re-derived.

---

## 7. Lock-deferred — labeled, never relabeled

**Every-pane-count production captures.** The story requires the affordance be
photographed on screen at every pane count before review ("a decoration that
has never been seen is not a decoration"). **This is not done and cannot be
done from here:** the GUI session is locked, and WindowServer captures do not
work under lock. hollis2 measured that manual-surface config proofs and
IOSurface reads *do* work under lock, but captures do not.

This is deferred with its measurement, not waived. What is owed before C1.3 can
be called complete:

- A screenshot of 1, 2, 3, and 4+ pane layouts showing exactly one undimmed
  pane and the focus ring on it.
- Taken in an unlocked GUI session, on the production app.

What §3 gives instead is an offscreen pixel demonstration that the attenuation
mechanism reaches the screen at all — which is the hazard the captures exist to
catch, but it is **not a substitute for the captures**. Do not let this section
be read as satisfying the acceptance criterion.

---

## 8. Files changed

```
Sources/HiveWorkspace/PaneBackgroundView.swift    new — opaque, non-vibrancy pane background
Sources/HiveWorkspace/PaneAttenuationView.swift   new — focus by attenuation
Sources/HiveWorkspace/PaneView.swift              background type; attenuation view + constraints + focus wiring
Tests/HiveWorkspaceTests/C13PaneChromeTests.swift new — 9 tests, the two demonstrations
Tests/HiveWorkspaceTests/AppDelegateLifecycleTests.swift  locator only (NSVisualEffectView -> PaneBackgroundView)
scripts/c13-mutation-proof.py                     new — 9-case mutation harness
docs/c1-c13-chrome-focus-evidence.md              this document
```
