#!/bin/bash
# Gate 6 (M1-B1): run the headless checkpoint-authoring harness against the
# SHIPPED lib-vt artifact (the same static library the host/sessiond side
# links). Usage: qualify-ghostty-checkpoint.sh [artifact-dir]
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/native/toolchain-lock.json"
CACHE=${HIVE_NATIVE_CACHE:-"$ROOT/.cache/native"}

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
  case "$(uname -m)" in
    arm64) ZIG_SHA=$(lock_value zig.arm64Sha256) ;;
    x86_64) ZIG_SHA=$(lock_value zig.x86_64Sha256) ;;
  esac
  ARTIFACT="$CACHE/artifacts/ghostty-$commit-zig-$ZIG_SHA"
fi

ARCH=$(uname -m)
VT_LIB="$ARTIFACT/lib-vt/$ARCH/libghostty-vt.a"
VT_INCLUDE="$ARTIFACT/include/ghostty-vt"
if [[ ! -f "$VT_LIB" ]]; then
  echo "lib-vt artifact missing: $VT_LIB (run scripts/build-ghosttykit.sh)" >&2
  exit 1
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/hive-ghostty-checkpoint.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

/usr/bin/clang -std=c11 -Wall -Werror \
  -I "$VT_INCLUDE" \
  "$ROOT/native/tests/checkpoint/headless-checkpoint-harness.c" \
  "$VT_LIB" \
  -o "$TMP/harness"

# The harness also authors checkpoint-fixtures/authored.hvgcp into the
# artifact, consumed by the Swift surface-restore live proof
# (Gate6SurfaceRestoreTests) — authoring (lib-vt) and restoring
# (GhosttyKit surface) are different libraries that must agree.
FIXTURES="$ARTIFACT/checkpoint-fixtures"
mkdir -p "$FIXTURES"
"$TMP/harness" "$FIXTURES"
