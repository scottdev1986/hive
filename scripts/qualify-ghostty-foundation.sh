#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/native/toolchain-lock.json"
CACHE=${HIVE_NATIVE_CACHE:-"$ROOT/.cache/native"}

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
  case "$(uname -m)" in
    arm64) zig_sha=$(lock_value zig.arm64Sha256) ;;
    x86_64) zig_sha=$(lock_value zig.x86_64Sha256) ;;
  esac
  ARTIFACT="$CACHE/artifacts/ghostty-$commit-zig-$zig_sha"
fi
EVIDENCE=${2:-"$CACHE/qualification/ghostty-foundation"}
XCFRAMEWORK="$ARTIFACT/GhosttyKit.xcframework"
if [[ ! -d "$XCFRAMEWORK" ]]; then
  echo "GhosttyKit artifact missing: $XCFRAMEWORK" >&2
  exit 1
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/hive-ghostty-foundation.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$EVIDENCE"
find "$EVIDENCE" -mindepth 1 -depth -delete
/usr/bin/rsync -a --exclude .build --exclude Vendor "$ROOT/workspace/" "$TMP/workspace/"
mkdir -p "$TMP/native/include" "$TMP/workspace/Vendor" "$TMP/thin"
/usr/bin/rsync -a "$ROOT/native/include/" "$TMP/native/include/"
/usr/bin/ditto "$XCFRAMEWORK" "$TMP/workspace/Vendor/GhosttyKit.xcframework"

# Observer positive control: prove the process-tree reader can see a real
# direct child before trusting an empty descendant inventory for the probe.
/bin/sleep 30 &
observer_child=$!
observer_seen=$(/usr/bin/pgrep -P "$$" 2>/dev/null || true)
if ! printf '%s\n' "$observer_seen" | /usr/bin/grep -qx "$observer_child"; then
  echo "process-tree observer failed its positive control" >&2
  exit 1
fi
{
  printf 'observer_parent=%s observer_child=%s\n' "$$" "$observer_child"
  /bin/ps -p "$$" -o pid=,ppid=,pgid=,sess=,stat=,comm=
  /bin/ps -p "$observer_child" -o pid=,ppid=,pgid=,sess=,stat=,comm=
} >"$EVIDENCE/observer-positive-control.process-tree.txt"
/bin/kill "$observer_child"
wait "$observer_child" 2>/dev/null || true

{
  printf 'qualification=Ghostty fork foundation gates 4 and 1\n'
  printf 'host_arch=%s\n' "$(uname -m)"
  /usr/bin/sw_vers
  /usr/bin/xcodebuild -version
  /usr/bin/xcrun swift --version
  printf 'zig=%s\n' "$(lock_value zig.version)"
  printf 'deployment_target=%s\n' "$(lock_value deploymentTarget)"
  printf 'ghostty_commit=%s\n' "$(lock_value ghostty.commit)"
  printf 'ghostty_upstream_tree=%s\n' "$(lock_value ghostty.upstreamTree)"
  printf 'ghostty_patched_tree=%s\n' "$(lock_value ghostty.patchedTree)"
  printf 'patch_series_sha256=%s\n' "$(lock_value ghostty.patchSeriesSha256)"
  printf 'upstream_public_header_sha256=%s\n' "$(lock_value ghostty.upstreamPublicHeaderSha256)"
  printf 'bridge_header_sha256=%s\n' "$(lock_value ghostty.bridgeHeaderSha256)"
  printf 'symbol_list_sha256=%s\n' "$(lock_value ghostty.symbolListSha256)"
} >"$EVIDENCE/provenance.txt" 2>&1

wait_for_stage() {
  local pid=$1
  local protocol=$2
  local stage=$3
  local attempt
  for ((attempt = 0; attempt < 600; attempt++)); do
    if /usr/bin/grep -q "\"stage\":\"$stage\"" "$protocol" 2>/dev/null; then
      return 0
    fi
    if ! /bin/kill -0 "$pid" 2>/dev/null; then
      echo "manual isolation probe exited before stage $stage" >&2
      return 1
    fi
    /bin/sleep 0.05
  done
  echo "timed out waiting for manual isolation stage $stage" >&2
  return 1
}

capture_state() {
  local arch=$1
  local pid=$2
  local stage=$3
  local prefix="$EVIDENCE/$arch-$stage"
  local children

  children=$(/usr/bin/pgrep -P "$pid" 2>/dev/null || true)
  {
    printf 'stage=%s arch=%s root_pid=%s\n' "$stage" "$arch" "$pid"
    /bin/ps -p "$pid" -o pid=,ppid=,pgid=,sess=,stat=,comm=
    for child in $children; do
      /bin/ps -p "$child" -o pid=,ppid=,pgid=,sess=,stat=,comm=
    done
    if [[ -z "$children" ]]; then printf 'children=0\n'; fi
  } >"$prefix.process-tree.txt"
  /usr/sbin/lsof -nP -a -p "$pid" -d 0-255 -F ftn >"$prefix.fds.txt"
  /bin/ps -M -p "$pid" -o pid=,stat=,comm= \
    | /usr/bin/sed 's/[[:space:]]*$//' >"$prefix.threads.txt"

  if [[ -n "$children" ]]; then
    echo "manual isolation probe has child processes at $arch/$stage" >&2
    return 1
  fi
  if /usr/bin/grep -E '^n/dev/(pty|ttys)' "$prefix.fds.txt" >/dev/null; then
    echo "manual isolation probe owns a PTY at $arch/$stage" >&2
    return 1
  fi
  if ! /usr/bin/grep -F "/$arch.control" "$prefix.fds.txt" >/dev/null; then
    echo "fd observer missed its known control FIFO at $arch/$stage" >&2
    return 1
  fi
}

run_probe() {
  local arch=$1
  local binary=$2
  local fifo="$TMP/$arch.control"
  local protocol="$EVIDENCE/$arch-protocol.jsonl"
  local stderr_log="$EVIDENCE/$arch-probe.stderr.txt"
  local pid

  /usr/bin/mkfifo "$fifo"
  exec 3<>"$fifo"
  /usr/bin/arch "-$arch" "$binary" <&3 >"$protocol" 2>"$stderr_log" &
  pid=$!

  wait_for_stage "$pid" "$protocol" before
  capture_state "$arch" "$pid" before
  printf 'next\n' >&3
  wait_for_stage "$pid" "$protocol" create
  capture_state "$arch" "$pid" create
  /usr/bin/sample "$pid" 1 1 -file "$EVIDENCE/$arch-create.sample.txt" >/dev/null
  /usr/bin/awk '
    /Thread_[^:]*: io$/ { capture=1 }
    capture && lines > 0 && /Thread_[^:]*:/ { exit }
    capture { print; lines++ }
  ' "$EVIDENCE/$arch-create.sample.txt" >"$EVIDENCE/$arch-io-thread-stack.txt"
  if ! /usr/bin/grep -q 'backend.kqueue.Loop.tick' "$EVIDENCE/$arch-io-thread-stack.txt"; then
    echo "manual io thread is not blocked in the kqueue event loop for $arch" >&2
    return 1
  fi
  if [[ "$arch" == arm64 ]] \
    && ! /usr/bin/grep -q 'kevent64' "$EVIDENCE/$arch-io-thread-stack.txt"; then
    echo "manual io thread is not blocked in kevent64 for $arch" >&2
    return 1
  fi
  if /usr/bin/grep -Ei '(^|[^[:alnum:]_])(pty|waitpid|read|write)([^[:alnum:]_]|$)' \
    "$EVIDENCE/$arch-io-thread-stack.txt" >/dev/null; then
    echo "manual io thread entered a process reader/writer stack for $arch" >&2
    return 1
  fi
  printf 'next\n' >&3
  wait_for_stage "$pid" "$protocol" use
  capture_state "$arch" "$pid" use
  printf 'next\n' >&3
  wait_for_stage "$pid" "$protocol" free
  capture_state "$arch" "$pid" free
  printf 'next\n' >&3
  wait "$pid"
  exec 3>&-

  /usr/bin/grep -q '"initialInputVisible":false' "$protocol"
  /usr/bin/grep -q '"foregroundPid":"0"' "$protocol"
  /usr/bin/grep -q '"ttyLength":0' "$protocol"
  /usr/bin/grep -q '"remoteOutputVisible":true' "$protocol"
  /usr/bin/grep -q '"hostInputVisible":false' "$protocol"
  /usr/bin/grep -q '"writeCallbacks":1' "$protocol"
  if [[ -s "$stderr_log" ]]; then
    echo "manual isolation probe wrote stderr for $arch" >&2
    return 1
  fi
}

mac_plist="$XCFRAMEWORK/Info.plist"
mac_index=$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries" "$mac_plist" \
  | /usr/bin/awk '/Dict {/ { idx++ } /SupportedPlatform = macos/ { print idx - 1; found=1 } END { if (!found) exit 1 }')
mac_identifier=$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries:$mac_index:LibraryIdentifier" "$mac_plist")
mac_binary_path=$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries:$mac_index:BinaryPath" "$mac_plist")
embedded_library="$XCFRAMEWORK/$mac_identifier/$mac_binary_path"
/usr/bin/lipo -archs "$embedded_library" >"$EVIDENCE/library-architectures.txt"
"$ROOT/scripts/check-ghostty-abi.sh" "$embedded_library" >"$EVIDENCE/c-zig-abi.txt" 2>&1
/usr/bin/shasum -a 256 "$ARTIFACT/artifact-manifest.json" "$ARTIFACT/sbom.cdx.json" \
  >"$EVIDENCE/artifact-metadata-sha256.txt"
/usr/bin/jq '{source, toolchain, verification}' "$ARTIFACT/artifact-manifest.json" \
  >"$EVIDENCE/artifact-summary.json"
(
  cd "$ARTIFACT/notices"
  find . -type f -print | LC_ALL=C /usr/bin/sort
) >"$EVIDENCE/license-notice-inventory.txt"
find "$ARTIFACT" -type f \( -name '*.dylib' -o -name '*.so' \) -print \
  >"$EVIDENCE/artifact-dynamic-libraries.txt"
if [[ -s "$EVIDENCE/artifact-dynamic-libraries.txt" ]]; then
  echo "Ghostty artifact contains an unexpected dynamic library" >&2
  exit 1
fi

for arch in arm64 x86_64; do
  if [[ "$arch" == x86_64 ]] && ! /usr/bin/arch -x86_64 /usr/bin/true; then
    echo "Rosetta x86_64 execution is required for foundation qualification" >&2
    exit 1
  fi
  (
    unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy
    cd "$TMP/workspace"
    /usr/bin/arch "-$arch" /usr/bin/swift build \
      --build-tests \
      --scratch-path "$TMP/build-$arch" \
      --triple "$arch-apple-macosx$(lock_value deploymentTarget)"
  )
  bundle="$TMP/build-$arch/$arch-apple-macosx/debug/HiveWorkspacePackageTests.xctest"
  /usr/bin/arch "-$arch" /usr/bin/xcrun xctest \
    -XCTest 'HiveTerminalKitTests.Gate4ABIQualificationTests/testBridgeValuesLayoutAndCSignaturesAtRuntime' \
    "$bundle" >"$EVIDENCE/$arch-swift-abi.txt" 2>&1
  /usr/bin/arch "-$arch" /usr/bin/xcrun xctest \
    -XCTest 'HiveTerminalKitTests.AttachReplayTests/testForeignEngineCheckpointRejected' \
    "$bundle" >"$EVIDENCE/$arch-build-id-rejection.txt" 2>&1
  binary="$TMP/build-$arch/$arch-apple-macosx/debug/GhosttyManualIsolationProbe"
  /bin/cp "$binary" "$TMP/thin/GhosttyManualIsolationProbe-$arch"
  /usr/bin/nm -arch "$arch" -gUj "$embedded_library" \
    | /usr/bin/sed 's/^_//' \
    | /usr/bin/grep '^hive_ghostty_' \
    | LC_ALL=C /usr/bin/sort -u >"$EVIDENCE/$arch-six-symbols.txt"
  /usr/bin/cmp "$EVIDENCE/$arch-six-symbols.txt" "$ROOT/native/abi/ghostty-bridge.exports"
  run_probe "$arch" "$binary"
done

/usr/bin/lipo -create \
  "$TMP/thin/GhosttyManualIsolationProbe-arm64" \
  "$TMP/thin/GhosttyManualIsolationProbe-x86_64" \
  -output "$TMP/GhosttyManualIsolationProbe"
identity=$(/usr/bin/security find-identity -v -p codesigning \
  | /usr/bin/awk '/Developer ID Application/ { print $2; exit }')
if [[ -z "$identity" ]]; then
  echo "Developer ID Application identity is unavailable" >&2
  exit 1
fi
/usr/bin/codesign --force --timestamp --options runtime --sign "$identity" "$TMP/GhosttyManualIsolationProbe"
/usr/bin/codesign --verify --strict --verbose=4 "$TMP/GhosttyManualIsolationProbe" \
  >"$EVIDENCE/codesign-verify.txt" 2>&1
/usr/bin/codesign -d --verbose=4 "$TMP/GhosttyManualIsolationProbe" \
  >"$EVIDENCE/codesign-display.txt" 2>&1
/usr/bin/otool -L "$TMP/GhosttyManualIsolationProbe" >"$EVIDENCE/carrier-dynamic-libraries.txt"
if /usr/bin/awk '/^\t/ { print $1 }' "$EVIDENCE/carrier-dynamic-libraries.txt" \
  | /usr/bin/grep -Ev '^(/System/Library/Frameworks/|/usr/lib/)' >/dev/null; then
  echo "signed carrier links a non-system dynamic library" >&2
  exit 1
fi
/usr/bin/shasum -a 256 "$TMP/GhosttyManualIsolationProbe" >"$EVIDENCE/signed-carrier-sha256.txt"
/usr/bin/ditto -c -k --keepParent "$TMP/GhosttyManualIsolationProbe" "$TMP/GhosttyManualIsolationProbe.zip"
/usr/bin/shasum -a 256 "$TMP/GhosttyManualIsolationProbe.zip" >"$EVIDENCE/notarization-submission-zip-sha256.txt"

if [[ -n "${MACOS_NOTARY_KEY_PATH:-}" && -n "${MACOS_NOTARY_KEY_ID:-}" && -n "${MACOS_NOTARY_ISSUER_ID:-}" ]]; then
  /usr/bin/xcrun notarytool submit "$TMP/GhosttyManualIsolationProbe.zip" \
    --key "$MACOS_NOTARY_KEY_PATH" --key-id "$MACOS_NOTARY_KEY_ID" \
    --issuer "$MACOS_NOTARY_ISSUER_ID" --wait --output-format json \
    >"$EVIDENCE/notarization-result.json"
  /usr/bin/jq -e '.status == "Accepted"' "$EVIDENCE/notarization-result.json" >/dev/null
  printf 'notarization_submission=accepted\n' >"$EVIDENCE/notarization-status.txt"
else
  printf 'notarization_submission=blocked_missing_MACOS_NOTARY_credentials\n' \
    >"$EVIDENCE/notarization-status.txt"
fi

(
  cd "$EVIDENCE"
  find . -type f ! -name evidence-sha256.txt -print \
    | LC_ALL=C /usr/bin/sort \
    | while IFS= read -r evidence_file; do /usr/bin/shasum -a 256 "$evidence_file"; done \
    >evidence-sha256.txt
)
if /usr/bin/grep -q '=accepted' "$EVIDENCE/notarization-status.txt"; then
  echo "Ghostty foundation qualification passed; evidence: $EVIDENCE"
else
  echo "Ghostty foundation qualification complete except notarization submission: credentials unavailable" >&2
  echo "evidence: $EVIDENCE" >&2
  exit 3
fi
