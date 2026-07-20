#!/bin/bash
# Gate 10 (M1-B1), engine scope: qualify the seventh bridge export
# (hive_ghostty_surface_semantic_snapshot_v1) on the shipped GhosttyKit
# artifact — C ABI + alloc ownership/bounds/alignment + atomic
# row/text/cursor/selection/geometry consistency + sanitizer run — and
# positive-control the patch-series digest's missing-entry failure mode.
# The AppKit accessibility/perf/VoiceOver proof is renderer-blocked and
# qualified separately. Usage: qualify-ghostty-gate10.sh [artifact-dir] [evidence-dir]
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
EVIDENCE=${2:-"$CACHE/qualification/ghostty-gate10-snapshot"}
XCFRAMEWORK="$ARTIFACT/GhosttyKit.xcframework"
if [[ ! -d "$XCFRAMEWORK" ]]; then
  echo "GhosttyKit artifact missing: $XCFRAMEWORK" >&2
  exit 1
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/hive-ghostty-gate10.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$EVIDENCE"
find "$EVIDENCE" -mindepth 1 -depth -delete
/usr/bin/rsync -a --exclude .build --exclude Vendor "$ROOT/workspace/" "$TMP/workspace/"
mkdir -p "$TMP/native/include" "$TMP/workspace/Vendor"
/usr/bin/rsync -a "$ROOT/native/include/" "$TMP/native/include/"
/usr/bin/ditto "$XCFRAMEWORK" "$TMP/workspace/Vendor/GhosttyKit.xcframework"

{
  printf 'qualification=M1-B1 Gate 10 semantic snapshot (engine scope)\n'
  printf 'host_arch=%s\n' "$(uname -m)"
  /usr/bin/sw_vers
  /usr/bin/xcodebuild -version
  /usr/bin/xcrun swift --version
  printf 'ghostty_commit=%s\n' "$(lock_value ghostty.commit)"
  printf 'ghostty_patched_tree=%s\n' "$(lock_value ghostty.patchedTree)"
  printf 'patch_series_sha256=%s\n' "$(lock_value ghostty.patchSeriesSha256)"
  printf 'bridge_header_sha256=%s\n' "$(lock_value ghostty.bridgeHeaderSha256)"
  printf 'symbol_list_sha256=%s\n' "$(lock_value ghostty.symbolListSha256)"
} >"$EVIDENCE/provenance.txt" 2>&1

# Patch-series digest controls. Green control: the real series digests to the
# locked value. Missing-patch positive control: deleting one series entry from
# a copied fake repo root must make the digest command fail with NO digest on
# stdout — this is the guard that a dropped entry can never silently digest a
# partial payload (the pre-fix pipeline subshell swallowed the failure).
expected_series_sha=$(lock_value ghostty.patchSeriesSha256)
green_series_sha=$("$ROOT/scripts/vendor-ghostty.sh" patch-series-sha256)
if [[ "$green_series_sha" != "$expected_series_sha" ]]; then
  echo "patch series digest $green_series_sha != locked $expected_series_sha" >&2
  exit 1
fi
printf 'digest=%s\nlocked=%s\nmatch=yes\n' "$green_series_sha" "$expected_series_sha" \
  >"$EVIDENCE/series-digest-green.txt"

mkdir -p "$TMP/series-control/scripts" "$TMP/series-control/native"
/bin/cp "$ROOT/scripts/vendor-ghostty.sh" "$TMP/series-control/scripts/"
/usr/bin/rsync -a "$ROOT/native/ghostty-patches/" "$TMP/series-control/native/ghostty-patches/"
/bin/cp "$LOCK" "$TMP/series-control/native/"
first_patch=$(/usr/bin/awk 'NF && $1 !~ /^#/ { print $1; exit }' "$ROOT/native/ghostty-patches/series")
/bin/rm "$TMP/series-control/native/ghostty-patches/$first_patch"
control_status=0
control_output=$("$TMP/series-control/scripts/vendor-ghostty.sh" patch-series-sha256 2>"$TMP/series-control.stderr") \
  || control_status=$?
{
  printf 'removed_entry=%s\n' "$first_patch"
  printf 'exit_status=%s\n' "$control_status"
  printf 'stdout=[%s]\n' "$control_output"
  printf 'stderr=[%s]\n' "$(/bin/cat "$TMP/series-control.stderr")"
} >"$EVIDENCE/series-digest-missing-patch.txt"
if [[ "$control_status" -eq 0 || -n "$control_output" ]]; then
  echo "missing-patch positive control FAILED: digest survived a dropped series entry" >&2
  exit 1
fi

# Seven-symbol allowlist on the shipped embedded library, both arches.
mac_plist="$XCFRAMEWORK/Info.plist"
mac_index=$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries" "$mac_plist" \
  | /usr/bin/awk '/Dict {/ { idx++ } /SupportedPlatform = macos/ { print idx - 1; found=1 } END { if (!found) exit 1 }')
mac_identifier=$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries:$mac_index:LibraryIdentifier" "$mac_plist")
mac_binary_path=$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries:$mac_index:BinaryPath" "$mac_plist")
embedded_library="$XCFRAMEWORK/$mac_identifier/$mac_binary_path"
for arch in arm64 x86_64; do
  /usr/bin/nm -arch "$arch" -gUj "$embedded_library" \
    | /usr/bin/sed 's/^_//' \
    | /usr/bin/grep '^hive_ghostty_' \
    | LC_ALL=C /usr/bin/sort -u >"$EVIDENCE/$arch-seven-symbols.txt"
  /usr/bin/cmp "$EVIDENCE/$arch-seven-symbols.txt" "$ROOT/native/abi/ghostty-bridge.exports"
done

assert_protocol() {
  local protocol=$1
  /usr/bin/jq -c . "$protocol" >/dev/null
  for stage in null-arguments alloc-contract failing-allocator stress complete; do
    if ! /usr/bin/grep -q "\"stage\":\"$stage\"" "$protocol"; then
      echo "gate 10 probe protocol is missing stage $stage: $protocol" >&2
      return 1
    fi
  done
}

run_probe() {
  local arch=$1
  local binary=$2
  local slug=$3
  local protocol="$EVIDENCE/$slug-protocol.jsonl"
  local stderr_log="$EVIDENCE/$slug-probe.stderr.txt"
  /usr/bin/arch "-$arch" "$binary" >"$protocol" 2>"$stderr_log"
  assert_protocol "$protocol"
}

for arch in arm64 x86_64; do
  if [[ "$arch" == x86_64 ]] && ! /usr/bin/arch -x86_64 /usr/bin/true; then
    echo "Rosetta x86_64 execution is required for gate 10 qualification" >&2
    exit 1
  fi
  (
    unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy
    cd "$TMP/workspace"
    /usr/bin/arch "-$arch" /usr/bin/swift build \
      --product GhosttyGate10Probe \
      --scratch-path "$TMP/build-$arch" \
      --triple "$arch-apple-macosx$(lock_value deploymentTarget)"
  )
  run_probe "$arch" "$TMP/build-$arch/$arch-apple-macosx/debug/GhosttyGate10Probe" "$arch-gate10"
done

# Sanitizer run on the host architecture: the probe's copies, frees, and every
# write into the caller-owned block execute under ASan redzones.
host_arch=$(uname -m)
(
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy
  cd "$TMP/workspace"
  /usr/bin/swift build \
    --product GhosttyGate10Probe \
    --sanitize=address \
    --scratch-path "$TMP/build-asan" \
    --triple "$host_arch-apple-macosx$(lock_value deploymentTarget)"
)
ASAN_OPTIONS=abort_on_error=1:halt_on_error=1:detect_leaks=0 \
  "$TMP/build-asan/$host_arch-apple-macosx/debug/GhosttyGate10Probe" \
  >"$EVIDENCE/asan-gate10-protocol.jsonl" 2>"$EVIDENCE/asan-gate10-probe.stderr.txt"
assert_protocol "$EVIDENCE/asan-gate10-protocol.jsonl"
if /usr/bin/grep -E 'ERROR: (AddressSanitizer|UndefinedBehaviorSanitizer)' \
  "$EVIDENCE/asan-gate10-probe.stderr.txt" >/dev/null; then
  echo "sanitizer reported a gate 10 memory error" >&2
  exit 1
fi

(
  cd "$EVIDENCE"
  find . -type f ! -name evidence-sha256.txt -print \
    | LC_ALL=C /usr/bin/sort \
    | while IFS= read -r evidence_file; do /usr/bin/shasum -a 256 "$evidence_file"; done \
    >evidence-sha256.txt
)
echo "Gate 10 semantic-snapshot qualification passed; evidence: $EVIDENCE"
