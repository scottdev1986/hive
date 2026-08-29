#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
LOCK="$ROOT/native/toolchain-lock.json"
CACHE=${HIVE_NATIVE_CACHE:-"$HOME/.cache/hive/native"}

lock_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$LOCK"
}

if [[ $# -gt 1 ]]; then
  echo "usage: $0 [artifact-dir]" >&2
  exit 2
fi
if [[ $# -eq 1 ]]; then
  ARTIFACT="$1"
else
  commit=$(lock_value ghostty.commit)
  ARTIFACT="$CACHE/artifacts/ghostty-$commit-zig-$(lock_value zig.version)"
fi

XCFRAMEWORK="$ARTIFACT/GhosttyKit.xcframework"
if [[ ! -d "$XCFRAMEWORK" ]]; then
  echo "GhosttyKit artifact missing: $XCFRAMEWORK" >&2
  exit 1
fi
if ! "$ROOT/scripts/native/ghostty-artifact-lock-check.sh" "$ARTIFACT" "$LOCK"; then
  echo "Gate 6 release lock requires a ReleaseFast artifact bound to the current source tuple" >&2
  exit 1
fi

# Swift panes no longer restore checkpoints; Ghostty owns the PTY. Headless
# checkpoint qualification is qualify-ghostty-checkpoint.sh (already ran).
# This lock forbids the deleted viewer path from returning.
if /usr/bin/grep -R -n --include='*.swift' \
  'hive_ghostty_surface_restore_checkpoint_v1\|hive_ghostty_surface_new_manual_v1\|hive_ghostty_surface_process_output_v1' \
  "$ROOT/workspace/Sources" >/tmp/hive-ghostty-release-lock-hits 2>/dev/null; then
  echo "release lock: Swift sources must not call the manual Ghostty I/O ABI:" >&2
  /bin/cat /tmp/hive-ghostty-release-lock-hits >&2
  exit 1
fi
echo "release lock: Swift viewer does not call the manual Ghostty I/O ABI"
