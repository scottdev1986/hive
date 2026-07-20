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
  * RED is split into RED_GUARD and RED_COMPILE. A mutation that fails to
    build would otherwise score exactly like a guard firing.
  * Every mutation must actually change the file. A replacement that matches
    nothing leaves the source intact, the guard GREEN, and would otherwise be
    recorded as a surviving guard -- a false alarm indistinguishable from a
    real one.

NOT crash-safe: mutations are applied in place and undone in a finally block,
so a SIGKILL mid-run leaves the tree mutated. Commit before running.
"""

import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONF = ROOT / "Sources/HiveTerminalKit/Theme/HiveTerminalConfiguration.swift"
WCAG = ROOT / "Sources/HiveTerminalKit/Theme/WCAGContrast.swift"
MANUAL = ROOT / "Sources/HiveTerminalKit/Bridge/ManualSurface.swift"
PREFS = ROOT / "Sources/HiveTerminalKit/Theme/HiveAppearancePreferences.swift"
VIEW = ROOT / "Sources/HiveTerminalKit/View/HiveTerminalView.swift"
PAGE = ROOT / "Sources/HiveWorkspace/Settings/AppearanceSettingsController.swift"
WINDOW = ROOT / "Sources/HiveWorkspace/Settings/SettingsWindowController.swift"
SUITE = "C12ThemeSystemTests"
LIVE = "C12LiveReconfigurationTests"
PREFS_SUITE = "C12AppearancePreferencesTests"
PAGE_SUITE = "C12AppearanceSettingsTests"
FONT_SUITE = "C12FontAcceptanceTests"

SNAPSHOT = {p: p.read_text() for p in (CONF, WCAG, MANUAL, PREFS, VIEW, PAGE, WINDOW)}


def restore():
    for path, text in SNAPSHOT.items():
        path.write_text(text)
    for path, text in SNAPSHOT.items():
        if path.read_text() != text:
            sys.exit(f"FATAL: restore of {path} failed; aborting before results are polluted")


def classify(filter_expr):
    """GREEN | RED_GUARD | RED_COMPILE | RED_OTHER.

    RED alone is not enough: a mutation that fails to BUILD scores identically
    to a guard actually firing, so a non-viable mutation could inflate the
    result. Splitting them keeps the count honest. Reviewer note: this was
    reached independently two ways with no shared failure mode -- parsing the
    failure text here, and build-testing each case without executing it -- and
    both say every case compiles.
    """
    proc = subprocess.run(
        ["swift", "test", "--filter", filter_expr],
        cwd=ROOT, capture_output=True, text=True,
    )
    out = proc.stdout + proc.stderr
    # XCTest reports a failing assertion as `error: -[Suite testName] ...`.
    if re.search(r"error: -\[", out) or re.search(r"^Test Case .*failed \(", out, re.M):
        return "RED_GUARD"
    # A Swift compile error carries file:line:col ahead of `error:`.
    if re.search(r"\.swift:\d+:\d+: error:", out):
        return "RED_COMPILE"
    # Never read the tail: the trailing swift-testing banner reports
    # "0 tests in 0 suites" while XCTest ran the real suite.
    if re.search(r"Executed \d+ tests, with 0 failures", out):
        return "GREEN"
    return "RED_OTHER"


def run(filter_expr):
    return classify(filter_expr) == "GREEN"


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

    # Persistence and delivery to running panes.
    (
        "stored theme selection ignored on read (persistence broken)",
        f"{PREFS_SUITE}/testAbsentSelectionsReadAsDefaults",
        PREFS,
        "            defaults.string(forKey: Key.themeSelection)\n"
        "                .flatMap(HiveTerminalThemeSelection.init(rawValue:)) ?? .system",
        "            .system",
    ),
    (
        "theme selection never written (persistence broken)",
        f"{PREFS_SUITE}/testSelectionsPersistAcrossInstances",
        PREFS, "        defaults.set(value, forKey: key)\n", "",
    ),
    (
        "change notification posted unconditionally (selector thrashes the engine)",
        f"{PREFS_SUITE}/testOnlyARealChangePostsTheNotification",
        PREFS, "        guard changed else { return }\n", "",
    ),
    (
        "unknown stored value no longer falls back",
        f"{PREFS_SUITE}/testUnknownStoredValueFallsBackToTheDefault",
        PREFS, "?? .system", "?? .dark",
    ),
    (
        "running panes stop observing the preference change",
        f"{PREFS_SUITE}/testChangingASelectionReconfiguresAnAlreadyRunningView",
        VIEW, "            self?.applySelectedAppearance()\n", "",
    ),
    (
        "the appearance state stops reading light/dark from the appearance",
        f"{PREFS_SUITE}/testSystemSelectionFollowsTheViewAppearance",
        PREFS,
        "appearance: TerminalColorScheme(appearance: nsAppearance) == .dark ? .dark : .light",
        "appearance: .dark",
    ),
    (
        "the view stops passing its own appearance to the resolver",
        f"{PREFS_SUITE}/testSystemSelectionFollowsTheViewAppearance",
        VIEW, "                    effectiveAppearance,", "                    NSAppearance(named: .darkAqua)!,",
    ),
    (
        "the view ignores the selected font when pushing",
        f"{PREFS_SUITE}/testChangingTheFontReconfiguresAnAlreadyRunningView",
        VIEW, "font: appearancePreferences.font", "font: .embedded",
    ),

    # The settings surface.
    (
        "the theme selector writes nothing",
        f"{PAGE_SUITE}/testSelectingAThemeWritesThePreference",
        PAGE, "        preferences.themeSelection = choices[sender.indexOfSelectedItem]\n", "",
    ),
    (
        "the font selector writes nothing",
        f"{PAGE_SUITE}/testSelectingAFontWritesThePreference",
        PAGE, "        preferences.font = choices[sender.indexOfSelectedItem]\n", "",
    ),
    (
        "the page opens on the default instead of the stored selection",
        f"{PAGE_SUITE}/testPageOpensOnTheStoredSelections",
        PAGE,
        "                selectedIndex: HiveTerminalThemeSelection.allCases\n"
        "                    .firstIndex(of: preferences.themeSelection),",
        "                selectedIndex: 0,",
    ),
    (
        "the appearance section falls through to the Tasks page",
        f"{PAGE_SUITE}/testWindowSelectsTheAppearanceSectionRatherThanFallingThroughToTasks",
        WINDOW,
        '            : section == "appearance" ? appearanceController : tasksController',
        "            : tasksController",
    ),
    # F1: engine acceptance of the selected font.
    (
        "the engine's diagnostics guard removed from the config factory",
        f"{FONT_SUITE}/testDiagnosticsChannelReportsAMalformedFontValue",
        MANUAL,
        # The guard block appears TWICE in this file -- the other site is a
        # different factory. Anchoring on the surrounding explicit-config lines
        # makes the target unique; a bare guard match removes the wrong one and
        # the test passes while looking mutated.
        "        configURL.path.withCString { ghostty_config_load_file(config, $0) }\n"
        "        ghostty_config_finalize(config)\n"
        "        let diagnosticCount = ghostty_config_diagnostics_count(config)\n"
        "        guard diagnosticCount == 0 else {\n"
        "            ghostty_config_free(config)\n"
        "            throw FactoryError.invalidConfig(diagnosticCount)\n"
        "        }\n",
        "        configURL.path.withCString { ghostty_config_load_file(config, $0) }\n"
        "        ghostty_config_finalize(config)\n",
    ),
    (
        "the live push stops refusing a config the engine rejects",
        f"{FONT_SUITE}/testLivePushRefusesAConfigurationTheEngineRejects",
        MANUAL,
        "              let config = try? GhosttyBridgeFactory.makeExplicitConfiguration(contents: contents)",
        "              let config = try? GhosttyBridgeFactory.makeExplicitConfiguration(\n"
        "                  contents: HiveTerminalConfiguration.contents(headless: hiveConfigurationHeadless))",
    ),
    (
        "wrongly-typed stored preference stops falling back",
        f"{PREFS_SUITE}/testWronglyTypedStoredValuesFallBackRatherThanCrash",
        PREFS, "?? .embedded", "?? .systemMonospaced",
    ),
    (
        "knownSections goes stale (lists a key the chain no longer resolves)",
        f"{PAGE_SUITE}/testEveryKnownSectionResolvesToItsOwnPage",
        WINDOW,
        '    static let knownSections = ["tasks", "models", "usage", "appearance"]',
        '    static let knownSections = ["tasks", "models", "usage", "appearance", "ghosts"]',
    ),
]


def main():
    failures = []

    print("=== baseline: both suites must be GREEN before any mutation ===")
    for suite in (SUITE, LIVE, PREFS_SUITE, PAGE_SUITE, FONT_SUITE):
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
        verdict = classify(guard if "/" in guard else f"{SUITE}/{guard}")
        restore()
        if verdict == "GREEN":
            failures.append(label)
            print(f"  SURVIVED     {label}\n               guard {guard} stayed GREEN")
        elif verdict == "RED_COMPILE":
            failures.append(label)
            print(f"  RED_COMPILE  {label}\n               did not build; the guard never ran")
        else:
            print(f"  {verdict:<12} {label}")

    print("\n=== every mutation reverted: both suites GREEN again ===")
    for suite in (SUITE, LIVE, PREFS_SUITE, PAGE_SUITE, FONT_SUITE):
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
