#!/usr/bin/env python3
"""C1.2 mutation proof.

Each case breaks exactly the mechanism one guard protects and requires that
guard to go RED. A guard that survives its own mutation is not a guard.

Three properties this harness enforces about itself, because an earlier shell
version silently failed all three:

  * Restore is a file copy from an in-memory snapshot, not `git checkout` --
    that reverts an untracked file to nothing and an uncommitted file to HEAD,
    and one bad pathspec aborts the revert of every other file too.
  * Every restore is verified byte-for-byte. A failed restore would leak a
    mutation into the next case and into the recorded result.
  * Every mutation must actually change the file. A replacement that matches
    nothing leaves the source intact, the guard GREEN, and would otherwise be
    recorded as a surviving guard -- a false alarm indistinguishable from a
    real one.
"""

import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONF = ROOT / "Sources/HiveTerminalKit/Theme/HiveTerminalConfiguration.swift"
WCAG = ROOT / "Sources/HiveTerminalKit/Theme/WCAGContrast.swift"
MANUAL = ROOT / "Sources/HiveTerminalKit/Bridge/ManualSurface.swift"
SUITE = "C12ThemeSystemTests"
LIVE = "C12LiveReconfigurationTests"

SNAPSHOT = {p: p.read_text() for p in (CONF, WCAG, MANUAL)}


def restore():
    for path, text in SNAPSHOT.items():
        path.write_text(text)
    for path, text in SNAPSHOT.items():
        if path.read_text() != text:
            sys.exit(f"FATAL: restore of {path} failed; aborting before results are polluted")


def run(filter_expr):
    """Return True when GREEN. A build error is RED, never a pass."""
    proc = subprocess.run(
        ["swift", "test", "--filter", filter_expr],
        cwd=ROOT, capture_output=True, text=True,
    )
    out = proc.stdout + proc.stderr
    if re.search(r"error:", out):
        return False
    # Never read the tail: the trailing swift-testing banner reports
    # "0 tests in 0 suites" while XCTest ran the real suite.
    return bool(re.search(r"Executed \d+ tests, with 0 failures", out))


CASES = [
    ("palette entry dropped below its contrast floor",
     "testEveryFirstPartyThemeMeetsItsMeasuredContrastFloors",
     CONF, '"ff6b7a"', '"1a1d24"'),
    ("increased-contrast variant made dimmer than its base",
     "testIncreasedContrastVariantsNeverReduceContrast",
     CONF, '"8fe8b0"', '"11331f"'),
    ("emitted palette drifts from the measured palette",
     "testMeasuredPaletteIsTheEmittedConfiguration",
     CONF, 'palette = \\($0.offset)=\\($0.element)', 'palette = \\($0.offset)=000000'),
    ("emitted background drifts from the measured background",
     "testMeasuredPaletteIsTheEmittedConfiguration",
     CONF, '"background = \\(background)"', '"background = 123456"'),
    ("palette generation switched on",
     "testThemesAuthorOnlyAnsi0Through15AndLeaveGenerationOff",
     CONF, '"palette-generate = false"', '"palette-generate = true"'),
    ("index 16 authored beyond the ANSI 16",
     "testThemesAuthorOnlyAnsi0Through15AndLeaveGenerationOff",
     CONF, '"palette-generate = false",', '"palette = 16=abcdef", "palette-generate = false",'),
    ("cursor color authored as hex instead of symbolically",
     "testCursorAndSelectionAreSymbolicAndBoldAliasIsNeverEmitted",
     CONF, '"cursor-color = cell-foreground"', '"cursor-color = ff00ff"'),
    ("deprecated bold alias emitted",
     "testCursorAndSelectionAreSymbolicAndBoldAliasIsNeverEmitted",
     CONF, '"bold-color = bright"', '"bold-is-bright = true"'),
    ("a theme names a font family, preempting the embedded face",
     "testNoThemeConfiguresAFontFamily",
     CONF, '"palette-generate = false",', '"font-family = Menlo", "palette-generate = false",'),
    ("appearance resolution inverted",
     "testSelectionResolvesAppearanceAndIncreasedContrast",
     CONF, "case .system: wantsDark = appearance == .dark",
     "case .system: wantsDark = appearance != .dark"),
    ("increased-contrast resolution ignored",
     "testSelectionResolvesAppearanceAndIncreasedContrast",
     CONF, "return increasedContrast ? .hiveDarkHighContrast : .hiveDark",
     "return .hiveDark"),
    ("theme emitted AFTER the product overrides (C1.0 central mutation)",
     "testThemeIsEmittedBeforeProductOverrides",
     CONF, "var lines = theme.configurationLines + font.configurationLines + overrideLines",
     "var lines = overrideLines + theme.configurationLines + font.configurationLines"),
    ("selected font dropped before reaching the generated file (the C1.1 gap)",
     "testSelectedFontReachesTheGeneratedConfiguration",
     CONF, "var lines = theme.configurationLines + font.configurationLines + overrideLines",
     "var lines = theme.configurationLines + overrideLines"),
    ("hex parser made lenient (truncating instead of rejecting)",
     "testMalformedHexIsRejectedRatherThanTruncated",
     WCAG, "guard scalars.count == 6 else { throw ColorError.malformedHex(hex) }",
     "let trimmed = Array(scalars.prefix(6)); _ = trimmed"),

    # Engine-boundary mutations. The first is the one that matters most: the
    # operationObserver fires around the real call, so it still reports a
    # begin/end pair after the call is deleted. Only a check that reads the
    # engine's own result can tell consumption from call-boundary noise.
    (
        "the real ghostty_surface_update_config call deleted (consumption, not call-boundary)",
        f"{LIVE}/testLiveThemeChangeRepaintsWithoutWipingPaneContent",
        MANUAL, "ghostty_surface_update_config(surface, config)",
        "_ = (surface, config)",
    ),
    (
        "the real update_config deleted, every-theme push proof",
        f"{LIVE}/testEveryFirstPartyThemePushesToARunningSurface",
        MANUAL, "ghostty_surface_update_config(surface, config)",
        "_ = (surface, config)",
    ),
    (
        "dedup guard removed so every selection re-pushes",
        f"{LIVE}/testRepeatedThemeSelectionPushesOnlyOnRealChange",
        MANUAL, "guard hiveConfigurationContents != contents,", "guard true,",
    ),
    (
        "font dropped at the live push site (the C1.1 gap, at the engine)",
        f"{LIVE}/testLiveFontChangeAloneReachesTheEngine",
        MANUAL, "            font: font,\n", "",
    ),
]


def main():
    failures = []

    print("=== baseline: both suites must be GREEN before any mutation ===")
    for suite in (SUITE, LIVE):
        if run(suite):
            print(f"  GREEN (expected)  {suite}")
        else:
            sys.exit(f"  RED at baseline in {suite} -- fix it before proving anything")

    print("\n=== mutations: each must turn its own guard RED ===")
    for label, guard, path, old, new in CASES:
        original = SNAPSHOT[path]
        mutated = original.replace(old, new, 1)
        if mutated == original:
            failures.append(label)
            print(f"  HARNESS ERROR  {label}: replacement matched nothing")
            continue
        path.write_text(mutated)
        green = run(guard if "/" in guard else f"{SUITE}/{guard}")
        restore()
        if green:
            failures.append(label)
            print(f"  SURVIVED  {label}\n            guard {guard} stayed GREEN")
        else:
            print(f"  RED       {label}")

    print("\n=== every mutation reverted: both suites GREEN again ===")
    for suite in (SUITE, LIVE):
        if run(suite):
            print(f"  GREEN (expected)  {suite}")
        else:
            failures.append(f"post-run baseline {suite}")
            print(f"  RED (UNEXPECTED) in {suite} -- a mutation leaked")

    print(f"\ncases: {len(CASES)}   failures: {len(failures)}")
    if failures:
        for f in failures:
            print(f"  FAILED: {f}")
        return 1
    print("C1.2 MUTATION PROOF COMPLETE")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        restore()
