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

VT_INCLUDE="$ARTIFACT/include/ghostty-vt"
MAC_PLIST="$ARTIFACT/GhosttyKit.xcframework/Info.plist"
if [[ ! -f "$MAC_PLIST" ]]; then
  echo "GhosttyKit artifact missing: $MAC_PLIST (run scripts/build-ghosttykit.sh)" >&2
  exit 1
fi
mac_index=$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries" "$MAC_PLIST" \
  | /usr/bin/awk '
      /Dict {/ { idx++ }
      /SupportedPlatform = macos/ { print idx - 1; found=1 }
      END { if (!found) exit 1 }
    ')
mac_identifier=$(/usr/libexec/PlistBuddy -c \
  "Print :AvailableLibraries:$mac_index:LibraryIdentifier" "$MAC_PLIST")
mac_binary_path=$(/usr/libexec/PlistBuddy -c \
  "Print :AvailableLibraries:$mac_index:BinaryPath" "$MAC_PLIST")
EMBEDDED_LIB="$ARTIFACT/GhosttyKit.xcframework/$mac_identifier/$mac_binary_path"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/hive-ghostty-checkpoint.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

run_arch() {
  local arch=$1
  shift
  /usr/bin/arch "-$arch" "$@"
}

arm64_id=
x86_64_id=
for arch in arm64 x86_64; do
  VT_LIB="$ARTIFACT/lib-vt/$arch/libghostty-vt.a"
  if [[ ! -f "$VT_LIB" ]]; then
    echo "lib-vt artifact missing: $VT_LIB (run scripts/build-ghosttykit.sh)" >&2
    exit 1
  fi

  /usr/bin/clang -arch "$arch" -std=c11 -Wall -Werror \
    -I "$VT_INCLUDE" \
    "$ROOT/native/tests/checkpoint/headless-checkpoint-harness.c" \
    "$VT_LIB" \
    -o "$TMP/harness-$arch"
  /usr/bin/clang -arch "$arch" -std=c11 -Wall -Werror \
    "$ROOT/native/tests/checkpoint/engine-build-id-probe.c" \
    "$EMBEDDED_LIB" \
    -framework AppKit -framework Carbon -framework CoreGraphics \
    -framework CoreText -framework Foundation -framework IOSurface \
    -framework Metal -framework QuartzCore -lc++ \
    -o "$TMP/embedded-id-$arch"

  # Both architecture authoring runs are mandatory. On Apple Silicon the
  # x86_64 invocation proves Rosetta is present; failure is never a skip.
  FIXTURES="$ARTIFACT/checkpoint-fixtures/$arch"
  mkdir -p "$FIXTURES"
  run_arch "$arch" "$TMP/harness-$arch" "$FIXTURES"
  vt_id=$(/bin/cat "$FIXTURES/engine-build-id.txt")
  embedded_id=$(run_arch "$arch" "$TMP/embedded-id-$arch")
  if [[ ! "$vt_id" =~ ^[0-9a-f]{64}$ ]]; then
    echo "invalid lib-vt engine build id for $arch: $vt_id" >&2
    exit 1
  fi
  if [[ "$vt_id" != "$embedded_id" ]]; then
    echo "checkpoint engine build id mismatch for $arch:" >&2
    echo "  lib-vt:   $vt_id" >&2
    echo "  embedded: $embedded_id" >&2
    exit 1
  fi
  case "$arch" in
    arm64) arm64_id=$vt_id ;;
    x86_64) x86_64_id=$vt_id ;;
  esac
  echo "checkpoint engine build id ($arch): $vt_id"
done

if [[ "$arm64_id" == "$x86_64_id" ]]; then
  echo "checkpoint ids must describe the architecture-specific Page layout" >&2
  exit 1
fi
