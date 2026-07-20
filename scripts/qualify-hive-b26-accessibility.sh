#!/bin/bash
# B2.6 / Gate 10 AppKit accessibility: run machine positive controls, rewrite
# AX tree dumps + machine audit, preserve human PENDING slots, refresh
# evidence-sha256. Does not claim VoiceOver listening.
# Usage: qualify-hive-b26-accessibility.sh [evidence-dir]
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
EVIDENCE=${1:-"$ROOT/raw/qualification/hive-b26-gate10-accessibility"}
WORKSPACE="$ROOT/workspace"
XCFRAMEWORK="$WORKSPACE/Vendor/GhosttyKit.xcframework"

mkdir -p "$EVIDENCE"

if [[ ! -d "$XCFRAMEWORK" ]]; then
  echo "GhosttyKit missing at $XCFRAMEWORK — materialize from the locked artifact cache first" >&2
  exit 1
fi

# Preserve human slots if already filled (STATUS != PENDING_HUMAN).
preserve_if_filled() {
  local f=$1
  if [[ -f "$f" ]] && ! grep -q 'STATUS=PENDING_HUMAN' "$f" 2>/dev/null; then
    cp "$f" "$f.preserve"
  fi
}
restore_if_preserved() {
  local f=$1
  if [[ -f "$f.preserve" ]]; then
    mv "$f.preserve" "$f"
  fi
}

preserve_if_filled "$EVIDENCE/human-inspector-audit-transcript.txt"
preserve_if_filled "$EVIDENCE/human-voiceover-transcript.txt"

echo "qualify-hive-b26: running Gate10AccessibilityTests → $EVIDENCE"
(
  cd "$WORKSPACE"
  HIVE_B26_AX_EVIDENCE="$EVIDENCE" swift test --filter Gate10AccessibilityTests
) | tee "$EVIDENCE/machine-xctest-transcript.raw.txt"

# Normalize transcript status (never .log).
{
  printf 'STATUS=RECORDED\n'
  printf 'command=HIVE_B26_AX_EVIDENCE=%s swift test --filter Gate10AccessibilityTests\n' "$EVIDENCE"
  if grep -q "Executed .* tests, with 0 failures" "$EVIDENCE/machine-xctest-transcript.raw.txt"; then
    printf 'result=PASS\n'
  else
    printf 'result=FAIL\n'
    exit 1
  fi
  grep -E 'Test Suite|Executed|error:' "$EVIDENCE/machine-xctest-transcript.raw.txt" | tail -40
} >"$EVIDENCE/machine-xctest-transcript.txt"
rm -f "$EVIDENCE/machine-xctest-transcript.raw.txt"

# Machine inspector-shaped audit from dumps.
python3 - "$EVIDENCE" <<'PY'
import sys
from pathlib import Path
base = Path(sys.argv[1])
out = [
    "inspector-audit-machine.txt",
    "STATUS=RECORDED",
    "method=parse ax-tree-*.txt dumps produced by Gate10AccessibilityTests",
    "note=This is NOT a substitute for the human Accessibility Inspector audit slot.",
    "",
]
required = [
    "ax-tree-input.txt",
    "ax-tree-alternate-screen.txt",
    "ax-tree-alternate-screen-exit.txt",
    "ax-tree-resize.txt",
    "ax-tree-replay.txt",
    "ax-tree-scroll.txt",
    "ax-tree-teardown.txt",
]
failures = 0
for name in required:
    path = base / name
    text = path.read_text() if path.exists() else ""
    child_lines = [l for l in text.splitlines() if l.strip().startswith("child[")]
    checks = {
        "exists": path.exists(),
        "has_role": "role=" in text,
        "has_lifecycle": "lifecycle=" in text,
        "has_children_or_teardown": ("childCount=" in text) or name.endswith("teardown.txt"),
    }
    if name != "ax-tree-teardown.txt":
        checks["row_children_present"] = len(child_lines) > 0
    else:
        checks["teardown_safe"] = "lifecycle=" in text
    ok = all(checks.values())
    failures += 0 if ok else 1
    out.append(f"file={name} ok={ok} checks={checks} child_lines={len(child_lines)}")
out.append("")
out.append(f"failures={failures}")
out.append("result=" + ("PASS" if failures == 0 else "FAIL"))
(base / "inspector-audit-machine.txt").write_text("\n".join(out) + "\n")
if failures:
    raise SystemExit("machine inspector audit failed")
PY

# Ensure human placeholders exist (do not clobber filled slots).
if [[ ! -f "$EVIDENCE/human-inspector-audit-transcript.txt" ]]; then
  cat >"$EVIDENCE/human-inspector-audit-transcript.txt" <<'EOF'
slot=human-inspector-audit-transcript.txt
STATUS=PENDING_HUMAN
reason=Accessibility Inspector GUI audit requires an unlocked Aqua session and a human operator.
EOF
fi
if [[ ! -f "$EVIDENCE/human-voiceover-transcript.txt" ]]; then
  cat >"$EVIDENCE/human-voiceover-transcript.txt" <<'EOF'
slot=human-voiceover-transcript.txt
STATUS=PENDING_HUMAN
reason=VoiceOver listening requires a human ear in an unlocked GUI session.
EOF
fi
restore_if_preserved "$EVIDENCE/human-inspector-audit-transcript.txt"
restore_if_preserved "$EVIDENCE/human-voiceover-transcript.txt"

(
  cd "$EVIDENCE"
  /usr/bin/shasum -a 256 $(/usr/bin/find . -type f ! -name evidence-sha256.txt | /usr/bin/sort) >evidence-sha256.txt
)

echo "qualify-hive-b26: machine slice green"
echo "human slots:"
grep -H 'STATUS=' "$EVIDENCE"/human-*.txt || true
echo "evidence: $EVIDENCE"
