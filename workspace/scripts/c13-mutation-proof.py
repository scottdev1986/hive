#!/usr/bin/env python3
"""C1.3 mutation proof — break exactly what each check guards, confirm RED.

A green suite proves nothing on its own: a check that asserts a tautology is
green forever. Each case below edits ONE source location, re-runs the specific
tests that are supposed to guard it, and demands they turn RED. A case that
stays GREEN means the check is decorative.

Design rules this harness follows, each of which has burned this repo before:

  * **Restore never uses git.** `git checkout --` destroys uncommitted work and
    fails atomically on a bad pathspec. Every file is snapshotted in memory
    before mutation and written back verbatim, then verified byte-for-byte.
  * **Every mutation must actually change the file.** A pattern that silently
    fails to match would produce a GREEN "the guard did not fire" result that
    really means "nothing was mutated". Non-matching patterns abort.
  * **Anchors must be unique.** `match_count != 1` aborts. A guard block that
    appears twice once meant the edit hit the wrong copy and measured nothing.
  * **RED is classified, never assumed.** A compile error is NOT a guard
    firing — it proves only that the code stopped building. Cases are reported
    as RED_GUARD (an assertion failed: the check works) or RED_COMPILE (did not
    build: inconclusive) and the two are never conflated.

Not crash-safe: commit before running. If it dies mid-case, `git status` will
show the mutated file and `git diff` will show the single edit to revert.

Usage:  python3 workspace/scripts/c13-mutation-proof.py [--case NAME]
Run from anywhere; paths resolve against this file's location.
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # workspace/
SOURCES = ROOT / "Sources" / "HiveWorkspace"
TESTS = ROOT / "Tests" / "HiveWorkspaceTests"

PANE_VIEW = SOURCES / "PaneView.swift"
ATTENUATION = SOURCES / "PaneAttenuationView.swift"
BACKGROUND = SOURCES / "PaneBackgroundView.swift"
CHROME_TESTS = TESTS / "C13PaneChromeTests.swift"


class Case:
    def __init__(self, name, path, old, new, tests, guards):
        self.name = name
        self.path = path
        self.old = old
        self.new = new
        self.tests = tests          # --filter expression
        self.guards = guards        # prose: what this proves


CASES = [
    # --- the no-vibrancy-ancestor check -------------------------------------
    Case(
        name="replant-visual-effect-background",
        path=PANE_VIEW,
        old="private let backgroundView = PaneBackgroundView()",
        new="private let backgroundView = NSVisualEffectView()",
        tests="C13PaneChromeTests/testTerminalContentHasNoVibrancyEnabledAncestor",
        guards=(
            "Restores the exact defect this increment fixed: the terminal "
            "surface descending from an NSVisualEffectView. The ancestor walk "
            "must catch it."
        ),
    ),
    Case(
        name="blind-the-vibrancy-walk",
        path=CHROME_TESTS,
        old="var next = view.superview",
        new="var next: NSView? = nil",
        tests="C13PaneChromeTests/testVibrancyCheckDetectsAPlantedVisualEffectView",
        guards=(
            "Neuters the ancestor walk so it inspects nothing. The planted-"
            "NSVisualEffectView positive control must notice that an empty "
            "result now means a broken walk, not a clean chain."
        ),
    ),
    Case(
        name="make-pane-background-transparent",
        path=BACKGROUND,
        old="override var isOpaque: Bool { true }",
        new="override var isOpaque: Bool { false }",
        tests="C13PaneChromeTests/testPaneBackgroundIsOpaqueAndNotAVisualEffectView",
        guards="The pane background must be opaque behind terminal content.",
    ),

    # --- behavioral fallout from dropping NSVisualEffectView -----------------
    Case(
        name="hardcode-the-background-color",
        path=BACKGROUND,
        old="NSColor.controlBackgroundColor.setFill()",
        new="NSColor.white.setFill()",
        tests="C13PaneChromeTests/testPaneBackgroundStillRespondsToAppearanceAfterDroppingVibrancy",
        guards=(
            "Replaces the semantic fill with a fixed color — exactly the silent "
            "loss that dropping NSVisualEffectView's automatic material "
            "response could cause. The pane would look right in light mode and "
            "be wrong in dark."
        ),
    ),
    Case(
        name="stop-repainting-on-appearance-change",
        path=BACKGROUND,
        old="needsDisplay = true",
        new="needsDisplay = false",
        tests="C13PaneChromeTests/testPaneBackgroundRepaintsOnAppearanceChange",
        guards=(
            "Drops the redraw that a live light/dark switch depends on. "
            "NSVisualEffectView did this for free; the replacement must do it "
            "explicitly."
        ),
    ),

    # --- the overlay-vs-sublayer hazard demonstration ------------------------
    Case(
        name="sublayer-becomes-an-overlay",
        path=CHROME_TESTS,
        old="sublayerRoot.layer?.addSublayer(dimLayer)",
        new="sublayerRoot.addSubview(DimOverlayView(frame: Self.bounds))",
        tests="C13PaneChromeTests/testSublayerDimIsAbsentWhileSiblingOverlayDimIsVisible",
        guards=(
            "Turns the hazard construction into the sanctioned one. The "
            "'sublayer dim is absent' assertion must fail, proving it is "
            "measuring attachment order rather than restating a constant."
        ),
    ),
    Case(
        name="break-the-offscreen-instrument",
        path=CHROME_TESTS,
        old="view.cacheDisplay(in: view.bounds, to: rep)",
        new="_ = rep",
        tests="C13PaneChromeTests/testSublayerDimIsAbsentWhileSiblingOverlayDimIsVisible",
        guards=(
            "Stops the capture from rendering at all. The instrument pin and "
            "the positive control must reject the run instead of reporting a "
            "confident (and meaningless) result."
        ),
    ),

    # --- focus by attenuation ------------------------------------------------
    Case(
        name="attenuate-the-focused-pane",
        path=ATTENUATION,
        old="var isAttenuated: Bool { indicator == .none }",
        new="var isAttenuated: Bool { indicator != .none }",
        tests="C13PaneChromeTests/testUnfocusedPaneIsAttenuatedAndFocusedPaneIsNot",
        guards="Inverts the affordance so the focused pane dims instead.",
    ),
    Case(
        name="attenuation-swallows-clicks",
        path=ATTENUATION,
        old="override func hitTest(_ point: NSPoint) -> NSView? { nil }",
        new="override func hitTest(_ point: NSPoint) -> NSView? { self }",
        tests="C13PaneChromeTests/testAttenuationPassesClicksThroughToTheTerminal",
        guards="Chrome must never take a click away from the terminal.",
    ),
    Case(
        name="attenuation-covers-status",
        path=PANE_VIEW,
        old="""attenuation.translatesAutoresizingMaskIntoConstraints = false
        addSubview(attenuation)
        statusBorder.translatesAutoresizingMaskIntoConstraints = false
        addSubview(statusBorder)""",
        new="""statusBorder.translatesAutoresizingMaskIntoConstraints = false
        addSubview(statusBorder)
        attenuation.translatesAutoresizingMaskIntoConstraints = false
        addSubview(attenuation)""",
        tests="C13PaneChromeTests/testAttenuationIsBelowStatusAndFocusChrome",
        guards=(
            "Reorders attenuation above the status border, which would dim the "
            "pane's correctness signal."
        ),
    ),
]


def run_tests(filter_expr):
    """Run the given tests. Returns (classification, tail_of_output)."""
    proc = subprocess.run(
        ["swift", "test", "--filter", filter_expr],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    output = proc.stdout + proc.stderr
    if proc.returncode == 0:
        return "GREEN", output
    # A build failure is not a guard firing. Distinguish them explicitly.
    if re.search(r"^.*error: .*$", output, re.MULTILINE) and "XCTAssert" not in output:
        return "RED_COMPILE", output
    if "XCTAssert" in output or re.search(r"Test Case .* failed", output):
        return "RED_GUARD", output
    return "RED_UNKNOWN", output


def apply_case(case):
    """Mutate, verify the edit landed, run, restore, verify restoration."""
    original = case.path.read_text()

    occurrences = original.count(case.old)
    if occurrences != 1:
        raise SystemExit(
            f"ABORT [{case.name}]: anchor matched {occurrences} times in "
            f"{case.path.name}, expected exactly 1. A non-unique anchor edits "
            f"the wrong site and measures nothing."
        )

    mutated = original.replace(case.old, case.new, 1)
    if mutated == original:
        raise SystemExit(
            f"ABORT [{case.name}]: mutation did not change {case.path.name}. "
            f"A no-op mutation reports GREEN and means nothing."
        )

    case.path.write_text(mutated)
    try:
        classification, output = run_tests(case.tests)
    finally:
        case.path.write_text(original)
        restored = case.path.read_text()
        if restored != original:
            raise SystemExit(
                f"FATAL [{case.name}]: {case.path} was NOT restored byte-for-"
                f"byte. Inspect it before doing anything else."
            )
    return classification, output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", help="run only the named case")
    args = parser.parse_args()

    cases = CASES
    if args.case:
        cases = [c for c in CASES if c.name == args.case]
        if not cases:
            raise SystemExit(f"no such case: {args.case}")

    results = []
    for case in cases:
        print(f"\n=== {case.name} ===", flush=True)
        print(f"    {case.path.relative_to(ROOT)}", flush=True)
        print(f"    proves: {case.guards}", flush=True)
        classification, output = apply_case(case)
        print(f"    -> {classification}", flush=True)
        if classification == "RED_COMPILE":
            print("    (inconclusive: did not build, so no guard was exercised)")
        results.append((case.name, classification))

    print("\n" + "=" * 68)
    print("C1.3 MUTATION PROOF SUMMARY")
    print("=" * 68)
    verdict = 0
    for name, classification in results:
        ok = classification == "RED_GUARD"
        print(f"  {'PASS' if ok else 'FAIL'}  {name:38s} {classification}")
        if not ok:
            verdict = 1
    print("=" * 68)
    print(
        "PASS means the mutation made a guard fail — the check is real.\n"
        "GREEN means the check never noticed the defect it exists to catch.\n"
        "RED_COMPILE is inconclusive and must be rewritten, not counted."
    )
    return verdict


if __name__ == "__main__":
    sys.exit(main())
