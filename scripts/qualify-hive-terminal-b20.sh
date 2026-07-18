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
  if [[ -z "${HIVE_NATIVE_CACHE:-}" ]]; then
    CACHE=$(CDPATH= cd -- "$ARTIFACT/../.." && pwd)
  fi
else
  commit=$(lock_value ghostty.commit)
  case "$(uname -m)" in
    arm64) zig_sha=$(lock_value zig.arm64Sha256) ;;
    x86_64) zig_sha=$(lock_value zig.x86_64Sha256) ;;
  esac
  ARTIFACT="$CACHE/artifacts/ghostty-$commit-zig-$zig_sha"
fi
EVIDENCE=${2:-"$CACHE/qualification/hive-terminal-b20"}
XCFRAMEWORK="$ARTIFACT/GhosttyKit.xcframework"
if [[ ! -d "$XCFRAMEWORK" ]]; then
  echo "GhosttyKit artifact missing: $XCFRAMEWORK" >&2
  exit 1
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/hive-terminal-b20.XXXXXX")
trap '/bin/rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$EVIDENCE"
find "$EVIDENCE" -mindepth 1 -depth -delete
/usr/bin/rsync -a --exclude .build --exclude Vendor "$ROOT/workspace/" "$TMP/workspace/"
mkdir -p "$TMP/native/include" "$TMP/vendor/ghostty/include" "$TMP/workspace/Vendor"
/usr/bin/rsync -a "$ROOT/native/include/" "$TMP/native/include/"
/bin/cp "$LOCK" "$TMP/native/toolchain-lock.json"
/usr/bin/rsync -a "$ROOT/vendor/ghostty/include/" "$TMP/vendor/ghostty/include/"
/usr/bin/ditto "$XCFRAMEWORK" "$TMP/workspace/Vendor/GhosttyKit.xcframework"

# Positive controls precede every negative inventory claim. First prove the
# process reader sees a real child; then prove lsof sees both a known FIFO and
# a real pseudoterminal before trusting an empty renderer inventory.
/bin/sleep 30 &
observer_child=$!
if ! /usr/bin/pgrep -P $$ | /usr/bin/grep -qx "$observer_child"; then
  echo "process-tree observer failed its child positive control" >&2
  exit 1
fi
{
  printf 'observer_parent=%s observer_child=%s\n' "$$" "$observer_child"
  /bin/ps -p $$,"$observer_child" -o pid=,ppid=,pgid=,sess=,stat=,comm=
} >"$EVIDENCE/observer-positive-control.process-tree.txt"
/bin/kill "$observer_child"
wait "$observer_child" 2>/dev/null || true

/usr/bin/script -q /dev/null /bin/sleep 30 </dev/null >/dev/null 2>&1 &
pty_control=$!
pty_seen=0
for ((attempt = 0; attempt < 100; attempt++)); do
  /usr/sbin/lsof -nP -a -p "$pty_control" -d 0-255 -F ftn \
    >"$EVIDENCE/observer-positive-control.pty-fds.txt" 2>/dev/null || true
  if /usr/bin/grep -E '^n/dev/(ptmx|pty|ttys)' \
    "$EVIDENCE/observer-positive-control.pty-fds.txt" >/dev/null; then
    pty_seen=1
    break
  fi
  /bin/sleep 0.05
done
/bin/kill "$pty_control" 2>/dev/null || true
wait "$pty_control" 2>/dev/null || true
if [[ $pty_seen -ne 1 ]]; then
  echo "fd observer failed its PTY positive control" >&2
  exit 1
fi

"$ROOT/scripts/vendor-ghostty.sh" verify
mac_plist="$XCFRAMEWORK/Info.plist"
mac_index=$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries" "$mac_plist" \
  | /usr/bin/awk '/Dict {/ { idx++ } /SupportedPlatform = macos/ { print idx - 1; found=1 } END { if (!found) exit 1 }')
mac_identifier=$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries:$mac_index:LibraryIdentifier" "$mac_plist")
mac_binary_path=$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries:$mac_index:BinaryPath" "$mac_plist")
embedded_library="$XCFRAMEWORK/$mac_identifier/$mac_binary_path"

{
  printf 'qualification=M1-B2 B2.0 engine/contract lock\n'
  printf 'host_arch=%s\n' "$(uname -m)"
  /usr/bin/sw_vers
  /usr/bin/xcodebuild -version
  /usr/bin/xcrun swift --version
  printf 'ghostty_commit=%s\n' "$(lock_value ghostty.commit)"
  printf 'ghostty_upstream_tree=%s\n' "$(lock_value ghostty.upstreamTree)"
  printf 'ghostty_patched_tree=%s\n' "$(lock_value ghostty.patchedTree)"
  printf 'patch_series_sha256=%s\n' "$(lock_value ghostty.patchSeriesSha256)"
  printf 'upstream_public_header_sha256=%s\n' "$(lock_value ghostty.upstreamPublicHeaderSha256)"
  printf 'bridge_header_sha256=%s\n' "$(lock_value ghostty.bridgeHeaderSha256)"
  printf 'symbol_list_sha256=%s\n' "$(lock_value ghostty.symbolListSha256)"
  printf 'artifact=%s\n' "$ARTIFACT"
} >"$EVIDENCE/provenance.txt" 2>&1

/usr/bin/jq '{
  source,
  toolchain,
  verification: {
    productFloor: .verification.productFloor,
    architectureSets: .verification.architectureSets
  }
}' "$ARTIFACT/artifact-manifest.json" \
  >"$EVIDENCE/artifact-summary.json"
/usr/bin/jq -e --arg commit "$(lock_value ghostty.commit)" \
  --arg upstream "$(lock_value ghostty.upstreamTree)" \
  --arg patched "$(lock_value ghostty.patchedTree)" \
  --arg patch "$(lock_value ghostty.patchSeriesSha256)" \
  --arg header "$(lock_value ghostty.upstreamPublicHeaderSha256)" \
  --arg bridge "$(lock_value ghostty.bridgeHeaderSha256)" \
  --arg symbols "$(lock_value ghostty.symbolListSha256)" '
    .source.commit == $commit and
    .source.upstreamTree == $upstream and
    .source.patchedTree == $patched and
    .source.patchSeriesSha256 == $patch and
    .source.upstreamPublicHeaderSha256 == $header and
    .source.bridgeHeaderSha256 == $bridge and
    .source.symbolListSha256 == $symbols
  ' "$ARTIFACT/artifact-manifest.json" >"$EVIDENCE/artifact-lock-match.txt"
/usr/bin/shasum -a 256 "$ARTIFACT/artifact-manifest.json" "$embedded_library" \
  >"$EVIDENCE/loaded-artifact-sha256.txt"
/usr/bin/lipo -archs "$embedded_library" >"$EVIDENCE/library-architectures.txt"
if [[ "$(cat "$EVIDENCE/library-architectures.txt")" != *arm64* \
   || "$(cat "$EVIDENCE/library-architectures.txt")" != *x86_64* ]]; then
  echo "GhosttyKit archive is not universal" >&2
  exit 1
fi
HIVE_NATIVE_CACHE="$CACHE" "$ROOT/scripts/check-ghostty-abi.sh" "$embedded_library" \
  >"$EVIDENCE/c-zig-abi-symbol-lock.txt" 2>&1

collect_descendants() {
  local root_pid=$1
  local frontier=$root_pid
  local next child parent
  local seen=" $root_pid "
  while [[ -n "$frontier" ]]; do
    next=""
    for parent in $frontier; do
      for child in $(/usr/bin/pgrep -P "$parent" 2>/dev/null || true); do
        if [[ "$seen" != *" $child "* ]]; then
          printf '%s\n' "$child"
          seen="$seen$child "
          next="$next $child"
        fi
      done
    done
    frontier=$next
  done
}

wait_for_stage() {
  local pid=$1
  local protocol=$2
  local stage=$3
  for ((attempt = 0; attempt < 600; attempt++)); do
    if /usr/bin/grep -q "\"stage\":\"$stage\"" "$protocol" 2>/dev/null; then
      return 0
    fi
    if ! /bin/kill -0 "$pid" 2>/dev/null; then
      echo "B2.0 probe exited before stage $stage" >&2
      return 1
    fi
    /bin/sleep 0.05
  done
  echo "timed out waiting for B2.0 stage $stage" >&2
  return 1
}

capture_state() {
  local arch=$1
  local pid=$2
  local stage=$3
  local prefix="$EVIDENCE/$arch-$stage"
  local descendants
  descendants=$(collect_descendants "$pid")
  {
    printf 'stage=%s arch=%s root_pid=%s\n' "$stage" "$arch" "$pid"
    /bin/ps -p "$pid" -o pid=,ppid=,pgid=,sess=,stat=,comm=
    for child in $descendants; do
      /bin/ps -p "$child" -o pid=,ppid=,pgid=,sess=,stat=,comm=
    done
    if [[ -z "$descendants" ]]; then printf 'descendants=0\n'; fi
  } >"$prefix.process-tree.txt"
  /usr/sbin/lsof -nP -a -p "$pid" -d 0-255 -F ftn >"$prefix.fds.txt"
  /bin/ps -M -p "$pid" -o pid=,stat=,comm= \
    | /usr/bin/sed 's/[[:space:]]*$//' >"$prefix.threads.txt"

  if [[ -n "$descendants" ]]; then
    echo "B2.0 renderer has descendants at $arch/$stage" >&2
    return 1
  fi
  if /usr/bin/grep -E '^n/dev/(ptmx|pty|ttys)' "$prefix.fds.txt" >/dev/null; then
    echo "B2.0 renderer owns a PTY at $arch/$stage" >&2
    return 1
  fi
  if ! /usr/bin/grep -F "/$arch.control" "$prefix.fds.txt" >/dev/null; then
    echo "fd observer missed the known control FIFO at $arch/$stage" >&2
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
  printf 'next\n' >&3
  wait_for_stage "$pid" "$protocol" use
  capture_state "$arch" "$pid" use
  printf 'next\n' >&3
  wait_for_stage "$pid" "$protocol" free
  capture_state "$arch" "$pid" free
  printf 'next\n' >&3
  wait "$pid"
  exec 3>&-

  /usr/bin/grep -q '"ghosttyCommit":"73534c4680a809398b396c94ac7f12fcccb7963d"' "$protocol"
  /usr/bin/grep -q '"layerClass":"IOSurfaceLayer"' "$protocol"
  /usr/bin/grep -q '"hasPresentedContents":true' "$protocol"
  /usr/bin/grep -q '"orderedChunkCount":3' "$protocol"
  /usr/bin/grep -q '"hasPresentedContents":false' "$protocol"
  if [[ -s "$stderr_log" ]]; then
    echo "B2.0 probe wrote stderr for $arch" >&2
    return 1
  fi
}

if rg -n 'import (HiveGhosttyC|GhosttyKit)' "$ROOT/workspace/Tests/HiveTerminalB20Probe" \
  >"$EVIDENCE/public-probe-import-audit.txt"; then
  echo "public B2.0 probe imports the upstream boundary" >&2
  exit 1
else
  printf 'imports=AppKit,Darwin,Foundation,HiveTerminalKit\n' \
    >"$EVIDENCE/public-probe-import-audit.txt"
fi

for arch in arm64 x86_64; do
  if [[ "$arch" == x86_64 ]] && ! /usr/bin/arch -x86_64 /usr/bin/true; then
    echo "Rosetta x86_64 execution is required by B2.0" >&2
    exit 1
  fi
  build="$TMP/build-$arch"
  (
    unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy
    cd "$TMP/workspace"
    /usr/bin/arch "-$arch" /usr/bin/swift build \
      --build-tests \
      --scratch-path "$build" \
      --triple "$arch-apple-macosx$(lock_value deploymentTarget)"
  ) >"$EVIDENCE/$arch-clean-build.txt" 2>&1

  behavior_log="$EVIDENCE/$arch-behavior-lock.txt"
  : >"$behavior_log"
  test_bundle="$build/$arch-apple-macosx/debug/HiveWorkspacePackageTests.xctest"
  for suite in \
    B20EngineContractTests \
    CallbackDisciplineTests \
    Gate4ABIQualificationTests \
    TerminalReplyCorpusTests \
    RendererReplySuppressionTests \
    LateFrameRejectionTests \
    Gate7RenderingTests \
    Gate3OperationDomainTests \
    Gate3ConcurrentCreationTests \
    AppWakeupLifecycleTests \
    GhosttyBridgeLinkTests \
    OrderedOutputEngineTests \
    OrderedOutputStressTests; do
    (
      unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy
      cd "$TMP/workspace"
      /usr/bin/arch "-$arch" /usr/bin/xcrun xctest \
        -XCTest "HiveTerminalKitTests.$suite" \
        "$test_bundle"
    ) >>"$behavior_log" 2>&1
    if ! /usr/bin/grep -q "Test Suite '$suite' passed" "$EVIDENCE/$arch-behavior-lock.txt"; then
      echo "$suite did not pass for $arch" >&2
      exit 1
    fi
  done

  symbol_dir="$TMP/symbols-$arch"
  mkdir -p "$symbol_dir"
  sdk=$(/usr/bin/xcrun --sdk macosx --show-sdk-path)
  /usr/bin/xcrun swift-symbolgraph-extract \
    -module-name HiveTerminalKit \
    -target "$arch-apple-macosx$(lock_value deploymentTarget)" \
    -sdk "$sdk" \
    -I "$build/$arch-apple-macosx/debug/Modules" \
    -I "$build/$arch-apple-macosx/debug/ModuleCache" \
    -I "$TMP/workspace/Sources/HiveGhosttyC/include" \
    -I "$TMP/workspace/Vendor/GhosttyKit.xcframework/$mac_identifier/Headers" \
    -minimum-access-level public \
    -output-dir "$symbol_dir"
  /usr/bin/jq -r '
    .symbols[] |
    [.identifier.precise, ([.declarationFragments[]?.spelling] | join(""))] |
    @tsv
  ' "$symbol_dir/HiveTerminalKit.symbols.json" \
    >"$EVIDENCE/$arch-public-api.txt"
  if /usr/bin/grep -E 'Ghostty|ghostty_|BridgeCallbackContext|ManualSurfaceEngine|GhosttyManualSurface|GhosttyBridgeFactory' \
    "$EVIDENCE/$arch-public-api.txt" >/dev/null; then
    echo "upstream Ghostty surface escaped the public Hive adapter for $arch" >&2
    exit 1
  fi

  run_probe "$arch" "$build/$arch-apple-macosx/debug/HiveTerminalB20Probe"
done

arm_build_id=$(/usr/bin/jq -r 'select(.stage == "create") | .engineBuildId' "$EVIDENCE/arm64-protocol.jsonl")
x86_build_id=$(/usr/bin/jq -r 'select(.stage == "create") | .engineBuildId' "$EVIDENCE/x86_64-protocol.jsonl")
if [[ -z "$arm_build_id" || -z "$x86_build_id" || "$arm_build_id" == "$x86_build_id" ]]; then
  echo "engine build identity must be present and architecture-bound" >&2
  exit 1
fi
{
  printf 'arm64=%s\n' "$arm_build_id"
  printf 'x86_64=%s\n' "$x86_build_id"
} >"$EVIDENCE/architecture-bound-engine-ids.txt"

(
  cd "$EVIDENCE"
  find . -type f ! -name evidence-sha256.txt -print \
    | LC_ALL=C /usr/bin/sort \
    | while IFS= read -r evidence_file; do /usr/bin/shasum -a 256 "$evidence_file"; done \
    >evidence-sha256.txt
)

echo "HiveTerminalView B2.0 qualification passed; evidence: $EVIDENCE"
