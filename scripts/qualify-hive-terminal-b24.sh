#!/bin/bash
# B2.4 viewer-semantics qualification. Requires an unlocked GUI session.
# Usage: qualify-hive-terminal-b24.sh [artifact-dir] [evidence-dir]
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
  CANDIDATES=(
    "$CACHE/artifacts/ghostty-$commit-zig-$zig_sha"
    "$ROOT/../../.cache/native/artifacts/ghostty-$commit-zig-$zig_sha"
    "$ROOT/../../../.cache/native/artifacts/ghostty-$commit-zig-$zig_sha"
  )
  ARTIFACT=${CANDIDATES[0]}
  for candidate in "${CANDIDATES[@]}"; do
    if [[ -d "$candidate/GhosttyKit.xcframework" ]]; then
      ARTIFACT=$candidate
      break
    fi
  done
fi
EVIDENCE=${2:-"$ROOT/bootstrap/evidence/m1-b2-b24-viewer"}
XCFRAMEWORK="$ARTIFACT/GhosttyKit.xcframework"
MANIFEST="$ARTIFACT/artifact-manifest.json"
MACOS_LIBRARY_PATH='GhosttyKit.xcframework/macos-arm64_x86_64/libghostty-internal.a'

if [[ ! -d "$XCFRAMEWORK" || ! -f "$MANIFEST" ]]; then
  echo "bound GhosttyKit artifact is missing: $ARTIFACT" >&2
  exit 1
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/hive-terminal-b24.XXXXXX")
trap '/bin/rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$EVIDENCE"
for stale in \
  provenance.txt artifact-binding.txt artifact-binding-control.txt \
  clean-build.txt corpus-viewer.txt live-rendered.txt live-metrics.txt \
  rendered-viewer.png renderer-frame-observer.png renderer-frame-observer.txt \
  qualification-summary.txt \
  instruments-time-profiler-summary.txt instruments-allocations-summary.txt \
  instruments-metal-system-trace-summary.txt evidence-sha256.txt
do
  /bin/rm -f "$EVIDENCE/$stale"
done
for trace in \
  instruments-time-profiler.trace instruments-allocations.trace \
  instruments-metal-system-trace.trace
do
  /bin/rm -rf "$EVIDENCE/$trace"
done

manifest_matches_lock() {
  local manifest=$1
  /usr/bin/jq -e \
    --arg commit "$(lock_value ghostty.commit)" \
    --arg upstream "$(lock_value ghostty.upstreamTree)" \
    --arg patched "$(lock_value ghostty.patchedTree)" \
    --arg patches "$(lock_value ghostty.patchSeriesSha256)" \
    --arg header "$(lock_value ghostty.upstreamPublicHeaderSha256)" \
    --arg bridge "$(lock_value ghostty.bridgeHeaderSha256)" \
    --arg symbols "$(lock_value ghostty.symbolListSha256)" '
      .source.commit == $commit and
      .source.upstreamTree == $upstream and
      .source.patchedTree == $patched and
      .source.patchSeriesSha256 == $patches and
      .source.upstreamPublicHeaderSha256 == $header and
      .source.bridgeHeaderSha256 == $bridge and
      .source.symbolListSha256 == $symbols
    ' "$manifest"
}

manifest_matches_lock "$MANIFEST" >"$EVIDENCE/artifact-binding.txt"
recorded_library_sha=$(
  /usr/bin/jq -r --arg path "$MACOS_LIBRARY_PATH" \
    '.files[] | select(.path == $path) | .sha256' "$MANIFEST"
)
actual_library_sha=$(
  /usr/bin/shasum -a 256 "$ARTIFACT/$MACOS_LIBRARY_PATH" | /usr/bin/cut -d' ' -f1
)
if [[ -z "$recorded_library_sha" || "$recorded_library_sha" != "$actual_library_sha" ]]; then
  echo "GhosttyKit library does not match its artifact manifest" >&2
  exit 1
fi
{
  printf 'manifest_lock_match=true\n'
  printf 'artifact_manifest_sha256=%s\n' \
    "$(/usr/bin/shasum -a 256 "$MANIFEST" | /usr/bin/cut -d' ' -f1)"
  printf 'macos_library_sha256=%s\n' "$actual_library_sha"
} >>"$EVIDENCE/artifact-binding.txt"

/usr/bin/jq '.source.patchedTree = "negative-control"' "$MANIFEST" >"$TMP/tampered-manifest.json"
if manifest_matches_lock "$TMP/tampered-manifest.json" >/dev/null 2>&1; then
  echo "artifact binding negative control did not bite" >&2
  exit 1
fi
printf 'tampered_patched_tree=REJECTED\nnegative_control=BIT\n' \
  >"$EVIDENCE/artifact-binding-control.txt"

/usr/bin/rsync -a --exclude .build --exclude '.build-*' --exclude Vendor \
  "$ROOT/workspace/" "$TMP/workspace/"
mkdir -p "$TMP/native/include" "$TMP/vendor/ghostty/include" "$TMP/workspace/Vendor"
/usr/bin/rsync -a "$ROOT/native/include/" "$TMP/native/include/"
/usr/bin/rsync -a "$ROOT/vendor/ghostty/include/" "$TMP/vendor/ghostty/include/"
/bin/cp "$LOCK" "$TMP/native/toolchain-lock.json"
/usr/bin/ditto "$XCFRAMEWORK" "$TMP/workspace/Vendor/GhosttyKit.xcframework"

TARGET_TRIPLE="$(uname -m)-apple-macosx$(lock_value deploymentTarget)"
TRIPLE_DIR="$(uname -m)-apple-macosx"
BUILD="$TMP/build"
TEST_BUNDLE="$BUILD/$TRIPLE_DIR/debug/HiveWorkspacePackageTests.xctest"
XCTEST=$(/usr/bin/xcrun -f xctest)
LIVE_TEST='HiveTerminalKitTests.B24ViewerSemanticsTests/testLiveRenderedSustainedOutputQualification'

{
  printf 'qualification=M1-B2 B2.4 viewer semantics\n'
  printf 'host_arch=%s\n' "$(uname -m)"
  /usr/bin/sw_vers
  /usr/bin/xcodebuild -version
  /usr/bin/xcrun swift --version
  printf 'ghostty_commit=%s\n' "$(lock_value ghostty.commit)"
  printf 'ghostty_patched_tree=%s\n' "$(lock_value ghostty.patchedTree)"
  printf 'artifact=%s\n' "$ARTIFACT"
  printf 'gui_session=required_unlocked\n'
  printf 'scrollback_limit_bytes=50331648\n'
  printf 'live_input_floor_bytes=83886080\n'
} >"$EVIDENCE/provenance.txt" 2>&1

(
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy
  cd "$TMP/workspace"
  /usr/bin/swift build --build-tests --scratch-path "$BUILD" --triple "$TARGET_TRIPLE"
) >"$EVIDENCE/clean-build.txt" 2>&1

: >"$EVIDENCE/corpus-viewer.txt"
for suite in B24ViewerSemanticsTests Gate8ClipboardTests Gate9ActionPolicyTests; do
  (
    cd "$TMP/workspace"
    "$XCTEST" -XCTest "HiveTerminalKitTests.$suite" "$TEST_BUNDLE"
  ) >>"$EVIDENCE/corpus-viewer.txt" 2>&1
  if ! /usr/bin/grep -q "Test Suite '$suite' passed" "$EVIDENCE/corpus-viewer.txt"; then
    echo "$suite did not pass" >&2
    exit 1
  fi
done

PLAIN_FRAME="$EVIDENCE/renderer-frame-observer.png"
(
  cd "$TMP/workspace"
  HIVE_B24_LIVE=1 \
  HIVE_B24_SCREENSHOT_PATH="$EVIDENCE/rendered-viewer.png" \
  HIVE_B24_FRAME_PATH="$PLAIN_FRAME" \
  HIVE_B24_METRICS_PATH="$EVIDENCE/live-metrics.txt" \
    "$XCTEST" -XCTest "$LIVE_TEST" "$TEST_BUNDLE"
) >"$EVIDENCE/live-rendered.txt" 2>&1
/usr/bin/grep -q '^B24_LIVE_METRICS ' "$EVIDENCE/live-metrics.txt"
{
  printf 'observer=CIImage(IOSurface) raw frame export\n'
  printf 'status=NON_AUTHORITATIVE_BACKGROUND_ONLY_ON_AUTHORING_RUN\n'
  printf 'frame_sha256=%s\n' \
    "$(/usr/bin/shasum -a 256 "$PLAIN_FRAME" | /usr/bin/cut -d' ' -f1)"
  printf 'frame_bytes=%s\n' "$(/usr/bin/stat -f %z "$PLAIN_FRAME")"
  printf 'positive_control=HiveTerminalVisualProofTests/testProductionSurfaceWritesC1PNGAtLiveGeometry\n'
  printf 'disposition=known renderer-test observer blind spot; do not treat raw export as pixel proof\n'
} >"$EVIDENCE/renderer-frame-observer.txt"

record_instruments() {
  local template=$1 slug=$2
  local trace="$EVIDENCE/instruments-$slug.trace"
  local summary="$EVIDENCE/instruments-$slug-summary.txt"
  local metrics="$TMP/instruments-$slug-metrics.txt"
  local screenshot="$TMP/instruments-$slug-viewer.png"
  local frame="$TMP/instruments-$slug-frame.png"
  local status=0
  if (
    cd "$TMP/workspace"
    HIVE_B24_LIVE=1 \
    HIVE_B24_INSTRUMENTED=1 \
    HIVE_B24_SCREENSHOT_PATH="$screenshot" \
    HIVE_B24_FRAME_PATH="$frame" \
    HIVE_B24_METRICS_PATH="$metrics" \
      /usr/bin/xcrun xctrace record \
        --template "$template" \
        --time-limit 120s \
        --output "$trace" \
        --no-prompt \
        --launch -- "$XCTEST" -XCTest "$LIVE_TEST" "$TEST_BUNDLE"
  ) >"$TMP/xctrace-$slug.stdout.txt" 2>"$TMP/xctrace-$slug.stderr.txt"; then
    status=0
  else
    status=$?
  fi
  {
    printf 'template=%s\n' "$template"
    printf 'exit_status=%s\n' "$status"
    printf 'trace=%s\n' "$trace"
    if [[ -e "$trace" ]]; then
      printf 'trace_bytes=%s\n' \
        "$(/usr/bin/du -sk "$trace" | /usr/bin/awk '{print $1 * 1024}')"
      printf 'trace_listing_sha256=%s\n' \
        "$(/usr/bin/find "$trace" -type f -print0 | /usr/bin/sort -z | /usr/bin/xargs -0 /usr/bin/shasum -a 256 | /usr/bin/shasum -a 256 | /usr/bin/cut -d' ' -f1)"
      if /usr/bin/xcrun xctrace export --input "$trace" --toc \
          >"$TMP/toc-$slug.xml" 2>"$TMP/toc-$slug.stderr.txt"; then
        printf 'toc_export=ok\n'
        /usr/bin/sed -n '1,160p' "$TMP/toc-$slug.xml"
      else
        printf 'toc_export=failed\n'
        /bin/cat "$TMP/toc-$slug.stderr.txt"
      fi
    else
      printf 'trace_bytes=0\n'
    fi
    printf '%s\n' '--- completion state ---'
    if [[ -f "$metrics" ]]; then /bin/cat "$metrics"; else printf 'metrics=MISSING\n'; fi
    printf '%s\n' '--- xctrace stdout ---'
    /bin/cat "$TMP/xctrace-$slug.stdout.txt"
    printf '%s\n' '--- xctrace stderr ---'
    /bin/cat "$TMP/xctrace-$slug.stderr.txt"
  } >"$summary"
  if [[ "$status" -ne 0 || ! -e "$trace" || ! -f "$metrics" ]]; then
    echo "xctrace $template did not complete the B2.4 live path" >&2
    /bin/cat "$summary" >&2
    return 1
  fi
}

record_instruments 'Time Profiler' time-profiler
record_instruments 'Allocations' allocations
record_instruments 'Metal System Trace' metal-system-trace

{
  printf 'status=AUTOMATED_PASS\n'
  printf 'unit_corpus=B24 viewer + Gate8 clipboard + Gate9 action policy\n'
  printf 'live_gui=retained search, selection, stable scroll anchor, new-output badge, occlusion, sleep/wake notifications, renderer-health recovery\n'
  printf 'instruments=Time Profiler, Allocations, Metal System Trace\n'
  printf 'memory_bounds=settled growth <= 128 MiB; peak growth <= 192 MiB during >= 80 MiB input\n'
  printf 'physical_sleep=REUSE Gate7 independently recorded human row; notification transition is automated here\n'
  printf 'gpu_recreation=NO_VIEW_API; renderer-health pending-frame recovery is proven, hardware fault/replacement remains Gate7/B2 orchestration scope\n'
  printf 'vttest=record only after OPOST/ONLCR dependency lands; see capability-manifest.txt\n'
  printf 'renderer_frame_observer=NON_AUTHORITATIVE; rendered-viewer.png is the B2.4 AppKit UI proof\n'
} >"$EVIDENCE/qualification-summary.txt"

(
  cd "$EVIDENCE"
  /usr/bin/find . -type f \
    ! -name evidence-sha256.txt \
    ! -path '*/instruments-*.trace/*' \
    ! -name '*.trace' \
    -print0 \
    | /usr/bin/sort -z \
    | /usr/bin/xargs -0 /usr/bin/shasum -a 256 \
    >evidence-sha256.txt
)

echo "HiveTerminalView B2.4 automated qualification passed; evidence: $EVIDENCE"
echo "HOLD: vttest dependency and cross-vendor review remain; do not land."
