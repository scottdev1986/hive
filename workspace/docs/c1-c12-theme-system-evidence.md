# C1.2 theme system and Appearance surface evidence

Recorded 2026-07-20 EDT on macOS 26.3.1 (25D2128), Apple silicon.

## Runtime and source identity

- Ghostty source pin: `73534c4680a809398b396c94ac7f12fcccb7963d` (unmoved).
- Ghostty declared version: `1.3.2-dev`.
- Hive patch-series SHA-256: `ddeaf79284f0072f29d69dbf6580fd8f58eba98ceff11525f83f91f03f6e09e0`.
- The GhosttyKit artifact was reused from a sibling worktree only after its
  commit, Zig SHA, and patch-series stamp were each matched against this
  worktree's lock; the staging run revalidated the bridge ABI skeleton.

C1.2 builds on the mechanisms C1.0 and C1.1 landed and does not relitigate
them: a Hive-authored configuration file pushed through
`surface_update_config`, the default loaders never called, inline colors only,
theme lines emitted before the product overrides, and no default font family.

## The paired themes

Four first-party themes ship: `hive-dark`, `hive-light`, and an
increased-contrast variant of each. The light mode is authored against the dark
one — each ANSI slot keeps its hue family and takes the lightness its own
background demands — rather than being an inversion.

A theme's colors are held as structured palette data, and the emitted
`background`, `foreground`, and `palette` lines are generated from that data.
This is what makes the table below evidence rather than an assertion: a color
that is not measured cannot reach the engine, and a color that is not shipped
cannot be measured. A separate check proves each measured value appears in the
generated configuration, and mutating the generator to emit a different value
turns it RED.

### Measured contrast, per entry

Ratios are WCAG 2.x, computed from the shipped palette. WCAG 2.2 is the only
normative contrast standard; WCAG 3.0 remains a Working Draft carrying no
normative contrast algorithm, so APCA is not used.

Floors: foreground ≥ 7:1 (Apple's dark-mode small-text target), palette entries
≥ 4.5:1, and the two de-emphasis slots (0 and 8) ≥ 3:1. Nothing sits below 3:1.

| Entry | hive-dark (bg `0f1117`) | hive-light (bg `f7f9fc`) | hive-dark-high-contrast (bg `000000`) | hive-light-high-contrast (bg `ffffff`) |
| --- | --- | --- | --- | --- |
| foreground | `e6eaf2` 15.65 | `1a1e26` 15.83 | `ffffff` 21.00 | `000000` 21.00 |
| 0 black | `626b7e` 3.53 | `6c7488` 4.43 | `8e97ab` 7.16 | `5a6274` 6.12 |
| 1 red | `ff6b7a` 6.86 | `c0263c` 5.56 | `ff9aa5` 10.42 | `96001e` 9.07 |
| 2 green | `75d39a` 10.37 | `1f7a4d` 5.04 | `8fe8b0` 14.34 | `0b5c33` 8.10 |
| 3 yellow | `e6c978` 11.67 | `8a6a00` 4.81 | `f2d98c` 15.08 | `5c4700` 8.91 |
| 4 blue | `7aa9ff` 8.04 | `1e5fd0` 5.53 | `9dc0ff` 11.42 | `0b3f96` 9.70 |
| 5 magenta | `c89bff` 8.62 | `8b3fd0` 5.35 | `dcb6ff` 12.18 | `5f1f96` 9.89 |
| 6 cyan | `67d9e8` 11.38 | `0f6f80` 5.52 | `8ceaf7` 15.23 | `064a58` 9.87 |
| 7 white | `dde3ec` 14.62 | `3a4150` 9.70 | `eef2f8` 18.69 | `2b3040` 13.13 |
| 8 br.black | `8d95a7` 6.28 | `858da0` 3.15 | `b3bacb` 10.80 | `6e7688` 4.56 |
| 9 br.red | `ff8894` 8.27 | `a81d33` 6.89 | `ffb8c0` 12.87 | `8a0b26` 9.74 |
| 10 br.green | `8be3ab` 12.29 | `166740` 6.53 | `aef0c6` 16.08 | `074d2a` 9.98 |
| 11 br.yellow | `f0d98b` 13.48 | `6f5500` 6.69 | `f8e6ad` 16.91 | `4a3800` 11.31 |
| 12 br.blue | `96bbff` 9.75 | `1a4fae` 7.18 | `bcd3ff` 13.90 | `07338a` 11.35 |
| 13 br.magenta | `d8b6ff` 10.83 | `7431b3` 7.03 | `e9cfff` 14.83 | `4e128a` 11.81 |
| 14 br.cyan | `82e3ee` 12.73 | `0c5b6a` 7.32 | `aef2fb` 16.89 | `033d4a` 11.86 |
| 15 br.white | `f8fafd` 18.05 | `232833` 13.99 | `ffffff` 21.00 | `15181f` 17.76 |

### Increase Contrast in Dark Mode, verified rather than assumed

Apple warns that Increase Contrast in Dark Mode can *reduce* contrast between
dark text and dark backgrounds. That combination is checked directly: every
entry of each increased-contrast variant is measured against its own background
and required to be no lower than the corresponding entry of its base theme.
Both pairs pass with no entry reduced. Lowering a single high-contrast entry
below its base turns the check RED.

### Structural rules

Hive authors only ANSI 0–15; 16–255 are left at the engine's standard values
and `palette-generate` stays `false`, because hosted programs hardcode the
standard 256-color cube. Cursor and selection colors resolve symbolically
against the cell beneath them rather than from authored hex, which removes the
invisible-cursor-on-one-theme bug class. `bold-color` is emitted and its
deprecated compatibility alias never is. No theme names a font family.

## The contrast instrument itself

The hex parser accepts exactly six hex digits and rejects anything else rather
than truncating. This is load-bearing rather than defensive: during authoring, a
corrupted entry (`"6e footer"`) was parsed leniently by the design-time tool,
which stopped at `6e`, treated it as a dark color, and reported it as a
**passing 17.14:1**. A lenient parser reports a typo'd palette entry as a
confident pass. The shipped parser rejects all seven malformed forms tested, and
making it lenient again turns its guard RED. Four published WCAG reference
values are checked as the positive control so the instrument is not merely
strict but correct.

## Live pane reconfiguration

`SessiondPaneTerminal` records that applying a configuration after
`processOutput` was observed to wipe the VT, leaving a blank pane with a full
journal. A live re-theme is exactly that sequence, so the behavior was measured
rather than designed around: on a running surface holding known content, a
dark → light push repaints the background to `f7f9fc` **and** the content
survives in the semantic grid. The hazard does not bite for a pure config
re-theme, which is what makes a live selector safe to offer.

Also measured at the real engine boundary:

- Every first-party theme pushes to a running surface and the presented
  background reaches that theme's authored value.
- The push is content-keyed: re-selecting the running theme is a no-op, and a
  genuine change pushes exactly once.
- A font change alone reaches the engine. Before this increment it could not:
  `applyHiveConfiguration` accepted no font and never passed one to the
  generator, so the option C1.1 deferred here had no path to a live surface.

The deleted-call mutation is the one that matters. The operation observer fires
around the real `ghostty_surface_update_config` call, so it still reports a
begin/end pair with that call removed — call-boundary evidence alone cannot
tell consumption from noise. With the call deleted the proof fails for the
right reason: the surface stays at the dark pixel `[15, 17, 22]` instead of
reaching the light `[247, 249, 252]`.

## The Appearance settings surface

Settings gains an Appearance page carrying the two selectors C1.0 and C1.1 both
deferred to this increment: the terminal theme and the terminal font. Both
persist in `UserDefaults` — these are local presentation preferences, not
routing policy, so they do not round-trip through the daemon. This is the first
`UserDefaults` use in the workspace sources.

Selecting a theme or font posts a change notification that running panes
observe and reconfigure from, so a choice reaches panes that are already open
rather than only new ones. A write that changes nothing posts nothing, so a
selector cannot thrash the engine. An unknown stored value — a preference file
from a future or corrupted build — falls back to the default rather than
crashing or leaving the terminal unthemed.

There is deliberately no app-appearance control. Hive follows the system
appearance; the terminal *theme* is content, which is why it can be pinned
independently. A pinned dark terminal theme is proven to hold against a light
appearance, and under the `.system` selection the palette follows the
appearance the view is drawn in.

The Settings window routes sections through nested ternaries that fall through
to the Tasks page for anything unrecognised, so the appearance section is
asserted to reach the Appearance page rather than assumed to; removing the
appearance branch turns that check RED. The fall-through is pre-existing and is
noted rather than refactored.

## Increase Contrast is C1.4's live signal, and why

C1.2 ships the increased-contrast variants and the resolution that selects
them, both measured for either value. It does not ship the live signal.

Reading `NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast` from
the kit put a privileged opener in `HiveTerminalKit` and turned Gate 9's source
scan RED. That gate is correct and was not weakened; the read was removed.

An appearance read is not an alternative. Measured on this OS,
`NSAppearance(named: .accessibilityHighContrastAqua)` reports its own name as
plain `NSAppearanceNameAqua`, and `bestMatch` maps every high-contrast name
onto its base — so Increase Contrast cannot be recovered from an appearance at
all. A test records that, with a light/dark positive control so the check
cannot silently degrade into a constant.

Supplying the live signal and re-pushing when the user toggles it mid-session
is C1.4's increment, whose gate requires demonstrating exactly that during a
live session. The call site therefore passes `false` explicitly rather than
defaulting it somewhere it would look wired and be inert.

## Verification

Every check in this increment is mutation-proven: the check is written, then
exactly what it guards is broken, and the check must go RED.

`workspace/scripts/c12-mutation-proof.py` runs 30 cases across the theme
system, the engine boundary, persistence, delivery to running panes, and the
settings wiring. All 30 turn their own guard RED, and all four C1.2 suites are
GREEN before and after the run.

The harness enforces three properties about itself, because an earlier shell
version silently failed all three and produced an invalid run that also
destroyed uncommitted work:

- Restore is a file copy from an in-memory snapshot, not `git checkout`. That
  reverts an untracked file to nothing and an uncommitted file to HEAD, and one
  bad pathspec aborts the revert of every other file in the same invocation.
- Every restore is verified byte-for-byte, so a failed restore cannot leak a
  mutation into the next case or into the recorded result.
- Every mutation must actually change the file. A replacement matching nothing
  leaves the guard GREEN and would otherwise be recorded as a surviving guard —
  a false alarm indistinguishable from a real one. This fired once for real,
  after a refactor moved a mutated line, and was reported rather than passing.

### Suites

Recorded after rebasing onto `ea8bbdfd`.

`swift test` executes 512 tests with 14 skipped and 9 failures. Those 9 are
proven pre-existing rather than assumed: the full suite was run against
unmodified `main` in a separate worktree at the same commit, and the
failing-test **sets** are identical. All nine are real-production-surface tests
failing with `hive_ghostty_surface_new_manual_v1 failed`, the
locked-GUI-session signature. They are environment-blocked, not regressions.

Manual-surface creation and IOSurface reads *do* work in this environment — the
C1.0 transport suite passes 3/3 including its rendered leg — so the config and
rendered-pixel proofs above are real measurements, not deferred ones.

`bun test` reports 1,744 passed, 0 failed across 137 files, exit 0.
`bun run typecheck` exits 0. `swift build` completes clean.

`bun run test` also chains `native/sessiond/test.sh`, whose real-host golden leg
fails here (`AttachLocatorMismatch`, then `InvalidRealInspection`). It is not
attributable to this increment: this branch changes **zero** files under
`native/`, `src/`, `scripts/`, `package.json`, or `Makefile`, so that test
consumes a tree byte-identical to `main`'s. It is reported upward rather than
investigated here, and the native suite was not run deliberately (issue #54).

## Environment-deferred legs

The GUI session is locked. No production-window or WindowServer capture leg is
claimed here, and none is relabelled as green. Specifically deferred until the
user unlocks:

- A real Workspace window rendering each of the four themes.
- A side-by-side capture of a live theme switch in the running app.

These are recorded as C1.2 follow-ups. The mechanism they would photograph is
already measured above at the real engine boundary, including the presented
IOSurface pixel for every theme.
