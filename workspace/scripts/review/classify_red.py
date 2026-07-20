#!/usr/bin/env python3
"""hadley: does each C1.2 mutation still COMPILE?

hollis2's run() maps a build error to RED, identically to a guard firing:
    if re.search(r"error:", out): return False
So a mutation that cannot compile scores exactly like a mutation a test caught.
"30/30 RED" therefore overstates how many of her TESTS are load-bearing by
however many mutations are merely non-viable.

This reuses HER case list verbatim (imported, not retyped) and asks only one
question per case: does `swift build --build-tests` succeed?
  COMPILES -> that case's RED came from a real test failure. The guard is real.
  BROKEN   -> that case's RED is the compiler talking, not the test.
"""
import importlib.util
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(sys.argv[1]).resolve()          # .../workspace
spec = importlib.util.spec_from_file_location(
    "proof", ROOT / "scripts/c12-mutation-proof.py")
proof = importlib.util.module_from_spec(spec)
sys.modules["proof"] = proof
spec.loader.exec_module(proof)                       # snapshots on import

print(f"reusing {len(proof.CASES)} cases from hollis2's own harness\n")


def build_ok():
    p = subprocess.run(["swift", "build", "--build-tests"],
                       cwd=ROOT, capture_output=True, text=True)
    return p.returncode == 0, (p.stdout + p.stderr)


ok, out = build_ok()
if not ok:
    sys.exit("FATAL: baseline tree does not build; nothing below would mean anything\n"
             + out[-2000:])
print("baseline builds clean -- proceeding\n")

compiles, broken = [], []
try:
    for label, guard, path, old, new in proof.CASES:
        original = proof.SNAPSHOT[path]
        mutated = original.replace(old, new, 1)
        if mutated == original:
            print(f"  HARNESS ERROR (matched nothing)  {label}")
            continue
        path.write_text(mutated)
        ok, _ = build_ok()
        proof.restore()
        (compiles if ok else broken).append(label)
        print(f"  {'COMPILES' if ok else 'BROKEN  '}  {label}")
finally:
    proof.restore()

print(f"\n=== {len(compiles)} compile (test-proven) | {len(broken)} do not compile "
      f"(compiler-proven) ===")
if broken:
    print("\nRED from the COMPILER, not from a guard:")
    for b in broken:
        print(f"  - {b}")
    print("\nThese are still legitimate safety nets -- the defect cannot ship --")
    print("but they do not demonstrate that the named TEST detects the defect.")
else:
    print("\nEvery mutation compiles: all 30/31 REDs are real test failures.")
