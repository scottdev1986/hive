#!/bin/bash
# Records the B2.3/A3 input acceptance matrix evidence bundle.
#
# Usage: scripts/b23-acceptance-matrix.sh
#
# Writes one .txt per suite into bootstrap/evidence/m1-b2-b23-input/ plus a
# sha256 manifest. Evidence is named .txt deliberately: *.log is gitignored,
# which would leave the manifest unverifiable on a fresh checkout.
#
# Only defect-independent rows run here (encoder + fake-host). Live-PTY rows
# are recorded separately once the parallel PTY/resize fixes land on main.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/bootstrap/evidence/m1-b2-b23-input"
MANIFEST="evidence-sha256.txt"

mkdir -p "$OUT"

# Suite filter -> evidence file. Each runs unpiped so its real exit code is the
# one recorded; piping into a pager would report the pager's status instead.
run_suite() {
    local name="$1"
    local filter="$2"
    local dest="$OUT/$name.txt"

    echo "recording $name (filter: $filter)"
    swift test --package-path "$ROOT/workspace" --filter "$filter" > "$dest" 2>&1
    local status=$?
    echo "" >> "$dest"
    echo "REAL_EXIT=$status" >> "$dest"
    if [ "$status" -ne 0 ]; then
        echo "  FAILED (exit $status) — recorded in $dest, not edited away"
    fi
    return "$status"
}

overall=0
run_suite "mouse-mode-matrix" "B23MouseModeMatrixTests" || overall=1
run_suite "paste-boundary-matrix" "B23PasteBoundaryMatrixTests" || overall=1
run_suite "unknown-retry-matrix" "B23UnknownRetryMatrixTests" || overall=1

# Pre-existing suites this matrix cites as the proof for its recorded rows.
run_suite "attach-input" "AttachInputTests" || overall=1
run_suite "input-encoding" "InputEncodingTests" || overall=1
run_suite "kitty-keyboard-golden" "KittyKeyboardGoldenTests" || overall=1

# The manifest must exclude itself: a file cannot contain its own digest.
( cd "$OUT" && find . -maxdepth 1 -type f -name '*.txt' ! -name "$MANIFEST" \
    -exec basename {} \; | sort | xargs shasum -a 256 > "$MANIFEST" )

echo ""
echo "manifest written: $OUT/$MANIFEST"
( cd "$OUT" && shasum -a 256 -c "$MANIFEST" )

exit "$overall"
