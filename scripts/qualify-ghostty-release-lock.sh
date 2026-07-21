#!/bin/bash
# Gate 6 release lock: restore the lib-vt-authored adversarial corpus through
# the shipped embedded surface on both macOS architectures.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
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
if ! "$ROOT/scripts/ghostty-artifact-lock-check.sh" "$ARTIFACT" "$LOCK"; then
  echo "Gate 6 release lock requires a ReleaseFast artifact bound to the current source tuple" >&2
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
    testid='HiveTerminalKitTests.Gate6SurfaceRestoreTests/testEveryLibVtAuthoredSplitRestoresIntoRealSurface'
    out="$TMP/xctest-$arch.log"
    HIVE_GHOSTTY_ARTIFACT="$ARTIFACT" HIVE_EXPECTED_TEST_ARCH="$arch" \
      /usr/bin/arch "-$arch" /usr/bin/xcrun xctest \
        -XCTest "$testid" "$bundle" 2>&1 | /usr/bin/tee "$out"
    xctest_status="${PIPESTATUS[0]}"
    if [[ "$xctest_status" -ne 0 ]]; then
      echo "release lock: xctest exited $xctest_status on $arch" >&2
      exit "$xctest_status"
    fi
    # EXECUTED + NOT-SKIPPED enforcement. xctest exits 0 even when a test is
    # XCTSkip'd or when zero tests match the -XCTest selector, so a bare exit
    # code is a false-green (the exact failure mode this lock guards). Require
    # the test case to PASS-execute, forbid any "skipped", and require exactly
    # one executed test with no failures.
    if ! /usr/bin/grep -q \
      "Test Case '-\[HiveTerminalKitTests.Gate6SurfaceRestoreTests testEveryLibVtAuthoredSplitRestoresIntoRealSurface\]' passed" \
      "$out"; then
      echo "release lock: Gate6SurfaceRestoreTests did not PASS-execute on $arch (skipped or zero-matched?)" >&2
      /usr/bin/grep -iE "skipped|Executed [0-9]+ test" "$out" >&2 || true
      exit 1
    fi
    if /usr/bin/grep -qi "skipped" "$out"; then
      echo "release lock: Gate6SurfaceRestoreTests reported a skip on $arch" >&2
      exit 1
    fi
    if ! /usr/bin/grep -q "Executed 1 test, with 0 failures" "$out"; then
      echo "release lock: expected exactly one executed test with no failures on $arch" >&2
      exit 1
    fi
    echo "release lock: Gate6SurfaceRestoreTests executed and passed (not skipped) on $arch"
  )
done
