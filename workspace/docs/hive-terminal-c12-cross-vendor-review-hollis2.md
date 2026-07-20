# C1.2 Appearance — cross-vendor review of hollis2's increment

Reviewer: hadley (Claude/Opus 4.8). Author: hollis2 (Claude/Opus).
Pin reviewed: **a95b2940** on `hive/hollis2-m1-item-4-c1-2-the-appearance`,
merge-base `ea8bbdfd`, 9 commits, 13-file footprint.
Date: 2026-07-20. Host: macOS 26.3.1 (25D2128), GUI session locked.

## Vendor caveat — this is NOT a cross-vendor review

The Codex and Grok pools are both quota-exhausted until 2026-07-26, so the
reviewer and the author are the same model family. That removes the main thing a
cross-vendor review buys: an independent prior. Two instances of one model share
failure modes, and "the reviewer agreed" is weak evidence when agreement is the
default.

The compensation was to re-derive rather than read, and to carry a negative
control on every instrument:

- The contrast table was recomputed from the WCAG 2.2 text with a
  from-scratch implementation, parsing the palettes out of the shipped Swift.
  It was validated against a four-point sanity vector before any of its output
  was trusted, and it carries a deliberate failure case.
- The author's `NSAppearance` measurement was re-run on this host rather than
  accepted.
- The pre-existing-failure claim was reproduced with an independent control run.
- Instruments were checked for blindness by planting a defect they should catch.
  **One instrument failed this check and its result was discarded** (see
  Methodology).

Where this review agrees with hollis2, it agrees from a separate derivation.
Where the agreement is only "I read their artifact and it looked right", that is
labelled as such. A genuine second vendor should still review the C1.2b
re-authoring when the pools recover.

## Verdict: PASS — land a95b2940

No blocking defect. Gate 9 is genuinely un-weakened, every load-bearing claim in
the evidence doc reproduced independently, and the honesty audit found no
relabelled or overstated result. Two findings are recorded below; neither blocks.

F1 (font consumption unproven at the engine) is a REQUIRED FOLLOW-UP rather than
a blocker: the threading is proven at three other boundaries, so the defect it
admits is narrow and no current code path reaches it.

F2 (symmetric lightness) is a real miss on a stated acceptance criterion, already
adjudicated by queen and scoped to C1.2b. It is filed here independently, with
magnitudes the author did not report.

---

## Attack 1 — Gate 9 (load-bearing)

The concern: reading Increase Contrast via `NSWorkspace` put a privileged opener
in `HiveTerminalKit` and turned Gate 9 RED. hollis2 removed the read rather than
weakening the gate. Verified that this is what actually happened.

**The gate's own artifacts are byte-identical to main.** sha256, not eyeball:

| file | main vs a95b2940 |
| --- | --- |
| `Gate9ActionPolicyTests.swift` | IDENTICAL |
| `Gate9CallbackMatrixTests.swift` | IDENTICAL |
| `Gate9ReachabilityTraceTests.swift` | IDENTICAL |
| `Gate10AccessibilityTests.swift` | IDENTICAL |
| `Bridge/CallbackContext.swift` | IDENTICAL |

`ManualSurface.swift` is the only Gate-9-relevant file in the footprint, and it
holds the `engineInert` table (L977–1095). Every changed line in that file was
enumerated; all of them are font-threading:

- `applyHiveConfiguration(theme:)` → `(theme:font:)` on the protocol, the fake,
  and the real surface
- the fake's dedup extended to the `(theme, font)` tuple
- `font: font,` threaded into the `contents(...)` call
- the `NSLog` fingerprint made theme-derived instead of a constant

The `engineInert` table, the action matrix and the deny list are outside the
diff entirely. **No relaxation.**

**No privileged API entered the kit.** `NSWorkspace` does appear in the kit —
but it appears on main too, at the same four sites (`willSleepNotification`,
`didWakeNotification`, and two `notificationCenter` fetches). The pin's set is
main's set plus one doc comment. `NSApplication.shared` at
`HiveTerminalView+Accessibility.swift:468` is pre-existing and that file is not
in the footprint. A positive control confirmed the search could see `NSWorkspace`
where it does exist (`HiveWorkspace/`), so the negative is a real negative.

> NIT: the comment at `HiveAppearancePreferences.swift:78` says `NSWorkspace` is
> something "the kit may not reference (Gate 9)". That is stricter than the
> actual rule — the kit references `NSWorkspace` for sleep/wake on main and
> always has. The constraint is on the privileged *accessibility/opener* surface,
> not on the symbol. Worth correcting so a future reader does not "fix" the
> sleep/wake observers to satisfy a rule that does not exist.

### The deferral justification, re-derived on this host

hollis2's claim is that Increase Contrast cannot be recovered from any
appearance read, so `NSWorkspace` is the only reader and the live signal must
wait for C1.4. If that claim were false, the hardcoded `increasedContrast: false`
would be hiding an available signal behind a Gate 9 excuse.

Measured directly on macOS 26.3.1, not taken from the comment:

```
CLAIM 1 — does an HC appearance report its own name back?
  NSAppearanceNameAccessibilityAqua        -> NSAppearanceNameAqua          COLLAPSED
  NSAppearanceNameAccessibilityDarkAqua    -> NSAppearanceNameDarkAqua      COLLAPSED
  NSAppearanceNameAccessibilityVibrantLight-> NSAppearanceNameVibrantLight  COLLAPSED
  NSAppearanceNameAccessibilityVibrantDark -> NSAppearanceNameVibrantDark   COLLAPSED

CLAIM 2 — does bestMatch ever return an HC name?
  ... from HC+base -> the BASE name, every time
  ... from HC-only -> nil, every time      <- decisive: nothing to collapse onto, still nil

CONTROL — NSWorkspace.accessibilityDisplayShouldIncreaseContrast = false (readable)
```

The HC-only `bestMatch` returning `nil` is the decisive form: with no base name
in the candidate list, a preserved HC identity would have to match itself. It
does not. **Claim CONFIRMED.** The control proves the bit is readable in
principle, so this is a real API limitation and not an unreadable-anywhere
artifact. Deferring the live signal to C1.4 is justified.

`HiveTerminalAppearanceState` keeps `increasedContrast` as a required
initialiser parameter with no default, so the inert value is supplied visibly at
the one call site rather than defaulted somewhere it would look wired. That is
the right shape for a deliberately-inert input.

## Attack 2 — mutations

### The harness

Re-ran `workspace/scripts/c12-mutation-proof.py` at the pin. **31/31 cases RED**,
baselines GREEN before and after, no leak. (At the earlier pin b688f6eb the same
harness gave 30/30; a95b2940 adds the `knownSections` case.) The author's claim
reproduces.

The harness is unusually well-built and defends against the specific traps that
have bitten this repo: restore is a file copy from an in-memory snapshot rather
than `git checkout`, every restore is verified byte-for-byte, a replacement that
matches nothing is reported as a HARNESS ERROR rather than a surviving guard, and
it never reads swift test's trailing banner.

### Is the harness itself lenient?

hollis2 caught their own instrument accepting a corrupted hex as a confident
17.14:1 pass during authoring. The shipped parser was checked directly rather
than trusted: `WCAGContrast.channels` requires exactly six digits and rejects any
non-hex byte, and the `testMalformedHexIsRejectedRatherThanTruncated` guard goes
RED when the length check is removed. The independent implementation used for
this review also rejects `"6e footer"` — the exact corruption from the earlier
incident.

Two residual leniencies in `run()`, neither exploitable here, both worth knowing
before the harness is reused:

**(a) A zero-match filter reads as GREEN.** Measured, not reasoned:

```
$ swift test --filter C12AppearanceSettingsTests/testThisNameDoesNotExistAnywhere
  Executed 0 tests, with 0 failures (0 unexpected)     exit 0
```

`run()` returns `bool(re.search(r"Executed \d+ tests, with 0 failures", out))`,
and `\d+` matches `0`. So a mistyped filter is indistinguishable from a passing
suite.

This is **safe by construction in this harness**, which is worth stating plainly
rather than filing as a defect: in the mutation loop GREEN means *the guard
survived its own mutation*, i.e. a recorded FAILURE. A typo'd guard name
therefore fails loud. The silent direction — a misspelled suite constant passing
the baseline vacuously — is closed by the same inversion, because every mutation
targeting that suite would then report SURVIVED. The danger only appears if
`run()` is lifted into a context where GREEN means success. If this harness is
ever generalised, assert executed-count equality against a source-derived count.

**(b) A build error is scored identically to a guard firing.**
`if re.search(r"error:", out): return False` maps a non-compiling mutation to
RED. That is conservative and deliberate — the docstring says so — but it means
"31/31 RED" cannot by itself distinguish a mutation a *test* caught from one the
*compiler* rejected.

Resolved by measurement rather than argument: each of the author's own 31 cases
was applied and `swift build --build-tests` run against it.

**Result: 31 compile, 0 do not.** Every mutation the author wrote produces a
tree that builds, so every one of the 31 REDs is a real test failure and not the
compiler talking. The concern is resolved in the author's favour and the
mutation proof is stronger than the raw count suggests: all 31 named guards are
demonstrably load-bearing.

This was worth measuring rather than assuming — several cases look like they
should break the build (deleting `font: font,` from a call, deleting
`defaults.set(...)` from a body) and do not, because the callee has a default
argument or the enclosing body stays well-formed. Reasoning about it would have
produced the wrong answer in at least two cases.

### The two mutations that matter, attacked independently

**Theme-before-overrides (C1.0's central clobber-proof).** `contents()` assembles
`theme.configurationLines + font.configurationLines + overrideLines`, so the
product overrides land last and win. howard's `copy-on-select = false` is in
`overrideLines`, alongside `clipboard-read = deny`, `clipboard-write = deny` and
`keybind = clear`. Confirmed the ordering guard has teeth: hollis2's mutation
flips the concatenation order and `testThemeIsEmittedBeforeProductOverrides`
goes RED, so the test asserts position rather than merely outcome.

Worth recording precisely, because it changes what the guard is *for*: the key
sets were extracted from both sides and **no theme key collides with any
override key today**. The four themes emit `background`, `foreground`,
`palette`, `palette-generate`, `bold-color`, `cursor-*` and `selection-*`; the
overrides emit font metrics, padding, scrollback and the clipboard/keybind
denials. So the ordering is not currently load-bearing for any shipped value —
it is defence-in-depth against a future theme that adds, say, a `keybind`. That
is the right thing to guard, and the guard is real, but the security property
does not presently depend on it.

**Font threading.** hollis2's own mutation deletes `font: font,` at the live push
site. This compiles — `contents(theme:font:headless:)` defaults `font` to
`.embedded` — so the RED is a genuine test failure: a `.systemMonospaced`
selection collapses to the same contents as `.embedded`, the dedup guard returns
false, and the test's `XCTAssertTrue` fails. The threading is genuinely proven at
the generator, at the fake surface, and at the view.

It is **not** proven at the real engine. See F1.

## Attack 3 — contrast, independently computed

Recomputed from the WCAG 2.2 normative text — channel/255, linearise at the
0.03928 threshold, `L = 0.2126R + 0.7152G + 0.0722B`,
`ratio = (L1+0.05)/(L2+0.05)` — with the four palettes parsed out of
`HiveTerminalConfiguration.swift` at the pin, so the numbers are bound to the
shipped colors rather than to any table.

Instrument validated before use, against hollis2's sanity vector:

| pair | expected | computed |
| --- | --- | --- |
| `000000`/`ffffff` | 21.00 | 21.000 |
| `777777`/`ffffff` | 4.48 | 4.478 |
| `767676`/`ffffff` | 4.54 | 4.542 |
| `0000ff`/`ffffff` | 8.59 | 8.592 |

(`777777` and `767676` straddle 4.5 and catch a wrong linearisation threshold.)
Negative controls: `808080`/`7f7f7f` = 1.014, and `"6e footer"` is rejected
rather than parsed as `0x6e`.

**All 68 entries (4 themes × 17 rows) match hollis2's published table to the
digit.** Floors independently re-checked — foreground ≥ 7:1, de-emphasis slots
0 and 8 ≥ 3:1, every other slot ≥ 4.5:1 — **VIOLATIONS: NONE**.

**The Apple case.** Increase Contrast in Dark Mode can *reduce* dark-on-dark
contrast, so "the HC variant is more contrasty" cannot be assumed. Checked
entry-for-entry rather than in aggregate: both HC variants **strictly** dominate
their base on all 17 entries, with no ties.

| | tightest entry | margin |
| --- | --- | --- |
| hive-dark | slot 0 `626b7e` 3.53 | floor 3.0 |
| hive-light | slot 8 `858da0` 3.15 | floor 3.0 |
| hive-dark-high-contrast | slot 0 `8e97ab` 7.16 | floor 3.0 |
| hive-light-high-contrast | slot 8 `6e7688` 4.56 | floor 3.0 |

hive-light slot 8 at **3.15:1 against a 3.0 floor** is the tightest value shipped.
It clears the stated floor and is not filed as a finding on its own; it is the
same slot that the F2 re-authoring would raise.

## Attack 4 — persistence

`UserDefaults` round-trip, absent-key fallback and unknown-value fallback are all
tested, and `testAbsentSelectionsReadAsDefaults` carries the control that
matters: it writes and reads back, so a misspelled key cannot pass by returning
every default. Corrupt values (`"solarized-mocha"`, `"comic-sans"`) fall back.
The mutation `?? .system` → `?? .dark` goes RED, so the fallback *value* is
pinned and not just the fallback path.

One case was not covered, and was probed directly: a stored value of the wrong
*type*. Running hollis2's exact read expression against seven planted types:

```
Data -> nil -> system     Array  -> nil    -> system     Dict -> nil -> system
Bool -> "1" -> system     Int    -> "42"   -> system     Double -> "3.14" -> system
empty-> ""  -> system
NO CRASH -- all wrong-type values fell back
```

`string(forKey:)` returns `nil` for non-string-coercible values and a coerced
string otherwise; neither reaches a valid `rawValue`, and nothing in the path
force-unwraps. **Fallback holds for every type, no crash, never an unthemed
surface.** This is stronger than what is tested, so it is robust by construction
rather than by accident — but it is untested, and a future refactor to
`defaults.object(forKey:) as! String` would break it silently.

**Live apply.** The settings controller and the view both default to
`HiveAppearancePreferences.shared`, which uses `UserDefaults.standard` and
`NotificationCenter.default`; the view observes that same centre with
`object: nil`, so a write from the settings surface reaches already-running
panes. The observer is registered in `wireWorkspaceEvents()`, whose only two
call sites are initialisers — so exactly one registration per view, no
double-registration, and it is removed in `deinit`. The post is content-keyed and
`guard changed else { return }` suppresses no-op writes, so the selector cannot
thrash the engine; that guard is itself mutation-proven.

## Attack 5 — suite honesty

Reproduced independently, in two clean worktrees staged from the same vendored
xcframework.

| | executed | skipped | failures | unexpected |
| --- | --- | --- | --- | --- |
| unmodified `main` (ea8bbdfd) | 483 | 14 | 17 | 9 |
| pin a95b2940 | 513 | 14 | 17 | 9 |

**The failing-test SETS are identical** — diffed, empty. All are
real-production-surface tests carrying the locked-session
`hive_ghostty_surface_new_manual_v1` signature (`Gate7RenderingTests` ×6,
`Gate6SurfaceRestoreTests`, `B20EngineContractTests`, `B24ViewerSemanticsTests`,
`SessiondPaneInputFocusTests`). No C1.2 test is among them. The set-differ was
negative-controlled with a planted extra identity.

**Executed counts equal source-derived counts.** 513 − 483 = **30**, and hollis2
adds exactly 30 tests. Each of the 30 was then confirmed by name to have both run
and passed, with the name list derived from the *pin* rather than from a working
tree. This closes the "a mistyped filter exits 0 having run nothing" hole
directly rather than by inference.

**GUI/WindowServer:** none claimed, none relabelled. The evidence doc carries an
explicit "Environment-deferred legs" section naming the locked session and
listing what is *not* claimed. The one claim that could have been overstated —
"the presented IOSurface pixel for every theme" — was checked and it bites:
`testEveryFirstPartyThemePushesToARunningSurface` loops all four themes through
`assertBackground`, which reads a real `IOSurface` via `CIContext` and
`XCTFail`s on timeout rather than falling through. Substantiated.

Per instruction, `bun run test:sessiond` and `zig build test` were NOT run (#54
IPC deadlock). The branch touches zero files under `native/`, `src/`, `scripts/`,
`package.json` or `Makefile`, confirmed by footprint.

---

## Findings

### F1 — the font is never proven to reach the engine (REQUIRED FOLLOW-UP)

`testLiveFontChangeAloneReachesTheEngine` is the only test that pushes a font to
a **real** surface. It asserts:

1. `apply(dark, embedded)` → true
2. `apply(dark, embedded)` → false — dedup control
3. `apply(dark, systemMonospaced)` → **true** — the claimed proof
4. `configColor(config, key: "background") == 0f1117`

Assertion 3 proves only that the generated contents *differed* and the engine
accepted the push. Assertion 4 reads back `background` — a **theme** property,
unchanged across the font switch. **The font is never read back.** A theme
assertion is standing where the font consumption proof should be.

This is the exact distinction hollis2 draws correctly for the theme, in their own
evidence doc: *"the operationObserver fires around the real call, so it still
reports a begin/end pair after the call is deleted. Only a check that reads the
engine's own result can tell consumption from call-boundary noise."* That
reasoning was applied to the theme and not to the font.

What survives this gap: `.systemMonospaced` emits
`font-family = .AppleSystemUIFontMonospaced`. If the engine rejected or ignored
that key — a plausible failure, since this codebase has already been bitten by
font-family resolution, where naming the embedded face silently resolved to
Menlo — every assertion above still passes. The push returns true because the
contents string differs; the background is still `0f1117`.

Not a blocker: the threading is proven at the generator
(`testSelectedFontReachesTheGeneratedConfiguration`), at the fake surface, and at
the view (`testChangingTheFontReconfiguresAnAlreadyRunningView`), and all three
mutations go RED. The unproven link is only the final engine parse.

Cheap to close, and the tools are already in the tree:

- `ghostty_config_get` is `void*`-generic;
  `HiveTerminalConfigurationTests.swift:136` already reads a non-colour value
  through it, so a `font-family` readback needs no new bridge surface.
- Stronger, and probably the right assertion: the pinned header exposes
  `ghostty_config_diagnostics_count` / `ghostty_config_get_diagnostic`. Asserting
  **zero diagnostics** after pushing `font-family = .AppleSystemUIFontMonospaced`
  proves the engine *accepted* the key, which is the thing currently unproven —
  and it would also catch a future typo'd config key in any theme.

Recommended as a C1.2 follow-up before C1.4 builds on the font path.

### F2 — "symmetric lightness" is not honored (acceptance criterion 4)

Self-disclosed by hollis2 before I reached it, and already adjudicated by queen:
C1.2 lands on floors, with the method shortfall recorded and the re-authoring
scoped to C1.2b feeding C1.5. Filed here as an independent derivation, with
magnitudes the author did not report.

Story acceptance criterion 4 (`planning/story-m1-c1-beautiful-blank-terminal.md:272`)
requires the paired themes be *"authored together with symmetric lightness"*;
line 103 defines the method as Solarized's — authored in CIELAB with symmetric
lightness across modes so switching preserves **perceived** contrast rather than
producing two unrelated designs. Measured in CIELAB L\* from the shipped source:

| measure | value |
| --- | --- |
| mean \|ΔL\* asymmetry\| over the 16 accent slots | **14.2 L\* units** |
| max \|ΔL\* asymmetry\| | **25.5** (slot 3 yellow) |
| mean \|WCAG ratio gap\| dark vs light | 3.99 |
| max \|WCAG ratio gap\| | 6.87 (slot 3 yellow) |
| slots sharing hex across modes | **0 / 16** (Solarized's strong form is 16/16) |
| foreground pair | 0.8 — symmetric, the one place it holds |

A just-noticeable difference is ~1 L\* unit, so the accent slots sit roughly 14×
JND apart. The floors clause of criterion 4 fully passes; the method clause does
not. Switching appearance does not preserve perceived contrast — the light theme
sits in a systematically lower band (dark green 10.37 vs light green 5.04, dark
yellow 11.67 vs light 4.81).

**One point not in the author's disclosure, and it matters for C1.2b: the fix
direction is compatible with the floors, not in tension with them.** Mirroring
about L\*50 means light-mode `L* = 100 − dark-mode L*`. The light theme is the
loose half of the pair, so mirroring tightens it.

This was computed rather than asserted, because the author is carrying it into
the C1.2b brief. For each slot: mirror the dark-mode L\*, convert back to
luminance, and take the WCAG ratio against the **existing** light background.
Hue drops out — the ratio depends only on relative luminance and L\* fixes it
exactly — so these are exact ratios for the mirrored design at any hue:

| | now | mirrored | floor |
| --- | --- | --- | --- |
| 2 green | 5.04 | **11.58** | 4.5 |
| 3 yellow | 4.81 | **13.17** | 4.5 |
| 8 br.black | 3.15 | **6.50** | 3.0 |
| foreground | 15.83 | 17.11 | 7.0 |

**Entries below floor under mirroring: 0. The background `f7f9fc` does not have
to move,** and the foreground does not collide. Mean ratio change across the 16
slots: **+4.92**.

> **Qualification, and the one thing C1.2b must carry:** 15 of 16 slots improve,
> not 16. **Slot 0 black degrades, 4.43 → 3.58** — still clear of its 3.0
> de-emphasis floor, but it becomes the *new tightest entry* in the light theme,
> displacing br.black. Slot 0 is the only accent whose dark-mode L\* sits below
> the midpoint (45.1), so mirroring pushes it *up* to 54.9 — lighter, on a light
> background — while every other slot mirrors downward. A brief promising that
> everything improves would send someone hunting for a bug when slot 0 comes back
> lower by design.

This corrects a warning the author had already sent upstream — that mirroring
would fight the 7:1 foreground and might force the background off `f7f9fc`.
It does not. That correction is theirs and is in flight to queen.

This does not block landing: no defect, no false claim, floors all met, and the
gap was disclosed rather than discovered.

### NITs (no action required to land)

- `HiveAppearancePreferences.swift:78` overstates the Gate 9 rule (see Attack 1).
- `applyHiveConfiguration()` and `applyHiveConfiguration(theme:)` survive as
  extension overloads defaulting `font` to `.embedded`. **No production call site
  uses them** — the only one is `HiveTerminalView.applySelectedAppearance()`,
  which passes both — so the C1.1 gap is genuinely closed. But they are a footgun:
  a future call site gets `.embedded` silently, which is exactly the bug C1.2
  fixed. Same applies to the defaults on `HiveTerminalConfiguration.contents(...)`.
  Consider narrowing to the test target once the C1.0/C1.1 tests are migrated.
- The mutation harness mutates sources in place and is not crash-safe (author's
  own (e)). Confirmed: restore runs in a `finally`, so a SIGKILL leaves the tree
  mutated. Acceptable for a dev-run script; worth a line in its docstring.
- `HiveTerminalConfigurationTests` uses a 0.04045 linearisation threshold while
  `WCAGContrast.swift` uses 0.03928. Both are accepted sRGB variants and the
  numerical difference is negligible, but two thresholds in one repo will
  eventually be read as a bug. Pre-existing; not hollis2's to fix here.

---

## Methodology, including what went wrong

Four worktrees: the pin, a control at unmodified `main`, a probe tree, and the
author's own tree (read-only — never mutated, so the author's numbers and mine
stay independent). All staged from the same vendored `GhosttyKit.xcframework`.

Two corrections, recorded because a review that reports only its successes is
not auditable:

**A discarded instrument.** The first Gate-9 check extracted policy-relevant
lines with a grep and diffed them across revisions. It reported IDENTICAL. Its
negative control — planting a `deny` → `allow` relaxation — did **not** register,
because `.deny` never appeared in the extracted lines at all. The instrument was
blind and its clean result meaningless. Discarded and replaced with a full
line-level diff of `ManualSurface.swift`, which is what Attack 1 reports.

**A withdrawn finding.** An earlier pass reported that
`testEveryKnownSectionResolvesToItsOwnPage` never ran (29 executed vs 30
source-derived). This was the reviewer's error: the test list was derived from
the author's live worktree — already advanced to a95b2940 — while the suite ran
at b688f6eb, where that test did not yet exist. The count check that surfaced it
is the same check that resolved it. Re-derived at a single frozen pin, the
arithmetic closes exactly: 513 − 483 = 30 = 30 source-derived, all confirmed run
by name. **Derive expected counts from the pin under test, never from a live
worktree that can move underneath the run.**

A stale cloned `.build` also produced a 4-second "failing" run with zero
`Executed` lines — module-cache paths are absolute and do not survive
`cp -Rc` between worktrees. Clearing `ModuleCache` fixes it. Worth noting because
that failure mode reads as a broken branch, and because it means a poisoned cache
would make *every* mutation report RED through the `error:` rule — a false 31/31.
hollis2's baseline-GREEN gate closes that hole, since a poisoned tree cannot pass
the baseline.

## Reproduction

```sh
# contrast, independent implementation + negative controls
python3 contrast_indep.py workspace/Sources/HiveTerminalKit/Theme/HiveTerminalConfiguration.swift

# CIELAB symmetry (F2)
python3 lab_symmetry.py workspace/Sources/HiveTerminalKit/Theme/HiveTerminalConfiguration.swift

# the Increase Contrast deferral claim, on this host
swiftc -O hcprobe.swift -o hcprobe && ./hcprobe

# mutation proof (31 cases) and the compile/test classification of its REDs
cd workspace && python3 scripts/c12-mutation-proof.py
python3 classify_red.py workspace

# suite + control; compare Executed counts and failing SETS, never the tail
cd workspace && swift test        # pin: 513 executed, 9 unexpected
                                  # main: 483 executed, 9 unexpected, identical set
```

Scripts are attached alongside this document under `workspace/scripts/review/`.
