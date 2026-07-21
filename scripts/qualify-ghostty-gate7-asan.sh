#!/bin/bash
# Gate 7 (M1-B1): rerun the automatable renderer XCTest corpus with ASan.
# Physical display and sleep/wake proof remain separate human-only slots.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/native/toolchain-lock.json"
CACHE=${HIVE_NATIVE_CACHE:-"$HOME/.cache/hive/native"}

lock_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$LOCK"
}

if [[ $# -gt 2 ]]; then
  echo "usage: $0 [artifact-dir] [evidence-dir]" >&2
  exit 2
fi
if [[ $# -ge 1 ]]; then
  ARTIFACT=$1
else
  commit=$(lock_value ghostty.commit)
  ARTIFACT="$CACHE/artifacts/ghostty-$commit-zig-$(lock_value zig.version)"
fi
EVIDENCE=${2:-"$ROOT/raw/qualification/ghostty-b1-gate7-asan"}
XCFRAMEWORK="$ARTIFACT/GhosttyKit.xcframework"
if [[ ! -d "$XCFRAMEWORK" ]]; then
  echo "GhosttyKit artifact missing: $XCFRAMEWORK" >&2
  exit 1
fi
if ! "$ROOT/scripts/ghostty-artifact-lock-check.sh" "$ARTIFACT" "$LOCK"; then
  echo "Gate 7 ASan requires a ReleaseFast artifact bound to the current source tuple" >&2
  exit 1
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/hive-ghostty-gate7-asan.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$EVIDENCE"
find "$EVIDENCE" -mindepth 1 -depth -delete
/usr/bin/rsync -a --exclude .build --exclude Vendor "$ROOT/workspace/" "$TMP/workspace/"
mkdir -p "$TMP/native/include" "$TMP/workspace/Vendor"
/usr/bin/rsync -a "$ROOT/native/include/" "$TMP/native/include/"
# The matching XCFramework must be staged before SwiftPM resolves the binary
# target: a source-tuple mismatch first surfaces only when a real surface is
# created, too late for a compile-only result to establish this qualification.
/usr/bin/ditto "$XCFRAMEWORK" "$TMP/workspace/Vendor/GhosttyKit.xcframework"

{
  printf 'qualification=M1-B1 Gate 7 AddressSanitizer renderer XCTest rerun\n'
  printf 'host_arch=%s\n' "$(uname -m)"
  printf 'ghostty_commit=%s\n' "$(lock_value ghostty.commit)"
  printf 'ghostty_patched_tree=%s\n' "$(lock_value ghostty.patchedTree)"
  printf 'patch_series_sha256=%s\n' "$(lock_value ghostty.patchSeriesSha256)"
  printf 'optimize_mode=ReleaseFast\n'
  printf 'artifact_manifest_sha256=%s\n' \
    "$(/usr/bin/shasum -a 256 "$ARTIFACT/artifact-manifest.json" | /usr/bin/awk '{ print $1 }')"
  printf 'scope=automatable Gate7RenderingTests; physical display and sleep/wake remain PENDING_HUMAN\n'
} >"$EVIDENCE/provenance.txt"

TARGET_TRIPLE="$(uname -m)-apple-macosx$(lock_value deploymentTarget)"
ASAN_OPTIONS=abort_on_error=1:halt_on_error=1:detect_leaks=0 \
  /usr/bin/swift test \
    --sanitize=address \
    --scratch-path "$TMP/build-asan" \
    --triple "$TARGET_TRIPLE" \
    --package-path "$TMP/workspace" \
    --filter Gate7RenderingTests \
    >"$EVIDENCE/corpus-asan.txt" 2>&1

# The physical dual-display/sleep case is deliberately the one known skip.
# A zero-match filter, any other skip, a failed XCTest, or an ASan report is a
# false green and must fail the qualification.
if ! /usr/bin/grep -q 'testPhysicalMonitorScaleAndSleepWakeQualification.*skipped' \
  "$EVIDENCE/corpus-asan.txt"; then
  echo "Gate 7 ASan corpus did not record the expected physical-only skip" >&2
  exit 1
fi
if /usr/bin/grep -E 'Test Case.*skipped' "$EVIDENCE/corpus-asan.txt" \
  | /usr/bin/grep -v 'testPhysicalMonitorScaleAndSleepWakeQualification' >/dev/null; then
  echo "Gate 7 ASan corpus reported an unexpected skipped test" >&2
  exit 1
fi
if ! /usr/bin/grep -Eq 'Executed [1-9][0-9]* tests?, with ([0-9]+ tests? skipped and )?0 failures' \
  "$EVIDENCE/corpus-asan.txt"; then
  echo "Gate 7 ASan corpus did not execute passing tests" >&2
  exit 1
fi
if /usr/bin/grep -E 'ERROR: (AddressSanitizer|UndefinedBehaviorSanitizer)' \
  "$EVIDENCE/corpus-asan.txt" >/dev/null; then
  echo "AddressSanitizer reported a Gate 7 memory error" >&2
  exit 1
fi

(
  cd "$EVIDENCE"
  find . -type f ! -name evidence-sha256.txt -print \
    | LC_ALL=C /usr/bin/sort \
    | while IFS= read -r evidence_file; do /usr/bin/shasum -a 256 "$evidence_file"; done \
    >evidence-sha256.txt
)
echo "Gate 7 ASan qualification passed; evidence: $EVIDENCE"
