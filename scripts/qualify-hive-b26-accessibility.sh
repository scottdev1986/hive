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

# Machine inspector-shaped audit + consistency cross-check + torn-fixture positive control.
python3 "$ROOT/scripts/audit-hive-b26-ax-dumps.py" --self-test "$EVIDENCE"

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
