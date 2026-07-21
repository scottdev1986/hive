#!/bin/bash
# Atomic publish of a freshly built GhosttyKit artifact into the shared cache
# (#46), extracted from build-ghosttykit.sh so the incumbent decision is
# unit-testable.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <built-dir> <final-dir> <toolchain-lock.json>" >&2
  exit 2
fi
OUT=$1
FINAL_OUT=$2
LOCK=$3

# Atomic publish into the shared artifact cache (#46). The cache key
# (ghostty-<commit>-zig-<version>) omits the patch series and the other locked
# inputs, so a same-key incumbent is kept ONLY when its manifest records the
# same locked source identity — then it was built from identical inputs by a
# concurrent build and must not be deleted out from under a consumer. A
# mismatched incumbent is stale (patch-series change without a commit bump)
# and the fresh build replaces it: keeping it shipped a Workspace renderer
# whose engine build id no longer matched sessiond's (689bc0a0).
if "$ROOT/scripts/ghostty-artifact-lock-check.sh" "$FINAL_OUT" "$LOCK"; then
  /bin/rm -rf "$OUT"
else
  /bin/rm -rf "$FINAL_OUT"
  if ! /bin/mv "$OUT" "$FINAL_OUT" 2>/dev/null; then
    # Lost a publish race; our rename landed inside the winner's directory.
    /bin/rm -rf "$FINAL_OUT/${OUT##*/}" "$OUT"
    if ! "$ROOT/scripts/ghostty-artifact-lock-check.sh" "$FINAL_OUT" "$LOCK"; then
      echo "GhosttyKit artifact publish failed: $FINAL_OUT is incomplete or does not match the toolchain lock" >&2
      exit 1
    fi
  fi
fi
