#!/bin/bash
# Gate 6 release lock: restore the lib-vt-authored adversarial corpus through
# the shipped embedded surface on both macOS architectures.
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
    arm64) zig_sha=$(lock_value zig.arm64Sha256) ;;
    x86_64) zig_sha=$(lock_value zig.x86_64Sha256) ;;
  esac
  ARTIFACT="$CACHE/artifacts/ghostty-$commit-zig-$zig_sha"
fi

XCFRAMEWORK="$ARTIFACT/GhosttyKit.xcframework"
if [[ ! -d "$XCFRAMEWORK" ]]; then
  echo "GhosttyKit artifact missing: $XCFRAMEWORK" >&2
  exit 1
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/hive-ghostty-release-lock.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
/usr/bin/rsync -a --exclude .build --exclude Vendor \
  "$ROOT/workspace/" "$TMP/workspace/"
mkdir -p "$TMP/native/include"
/usr/bin/rsync -a "$ROOT/native/include/" "$TMP/native/include/"
mkdir -p "$TMP/workspace/Vendor"
/usr/bin/ditto "$XCFRAMEWORK" "$TMP/workspace/Vendor/GhosttyKit.xcframework"

for arch in arm64 x86_64; do
  if [[ "$arch" == x86_64 ]] && ! /usr/bin/arch -x86_64 /usr/bin/true; then
    echo "Rosetta x86_64 execution is required by the Gate 6 release lock" >&2
    exit 1
  fi
  echo "qualifying cross-library checkpoint restore: $arch"
  (
    unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy
    cd "$TMP/workspace"
    /usr/bin/arch "-$arch" /usr/bin/swift build \
      --build-tests \
      --scratch-path "$TMP/build-$arch" \
      --triple "$arch-apple-macosx14.0"
    bundle="$TMP/build-$arch/$arch-apple-macosx/debug/HiveWorkspacePackageTests.xctest"
    HIVE_GHOSTTY_ARTIFACT="$ARTIFACT" HIVE_EXPECTED_TEST_ARCH="$arch" \
      /usr/bin/arch "-$arch" /usr/bin/xcrun xctest \
        -XCTest 'HiveTerminalKitTests.Gate6SurfaceRestoreTests/testEveryLibVtAuthoredSplitRestoresIntoRealSurface' \
        "$bundle"
  )
done
