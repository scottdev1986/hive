#!/bin/bash
# Gate 7 (M1-B1): RENDERING / GEOMETRY / GPU physical-slice live proof —
# live-proof matrix rows F + I (partial; human dual-display + sleep remain).
#
# AUTOMATABLE on an unlocked GUI session (this script):
#   * artifact binding to this pin's source tuple (fail closed)
#   * Gate7RenderingTests XCTest corpus (physical multi-display test skipped)
#   * GhosttyGate7Probe: main-thread admission, idle, live-resize,
#     occlusion-via-window-ordering, serial rapid-churn (clean teardown)
#   * Instruments via xctrace: Time Profiler, Allocations, Activity Monitor
#     (Mac energy-adjacent), Leaks — launched against the probe. Power Profiler
#     is attempted once as a measured negative control (iOS/iPadOS-only).
#   * GPU/device-fault honesty scope document (no fabricated recovery path)
#
# HUMAN-REQUIRED (slots only; checklist written for the operator):
#   * real dual-display Retina/non-Retina drag + inventory
#   * real sleep/wake cycle
#
# Evidence: .txt (and .jsonl protocol); never .log. No `| tail`.
# Debug-vs-ReleaseFast sessiond fence is out of band for this pure-renderer
# slice; provenance records the rule so a later sessiond-coupled run matches.
#
# Usage: qualify-ghostty-gate7-physical.sh [artifact-dir] [evidence-dir]
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
  # Prefer worktree cache; fall back to siblings that share a machine-level cache.
  CANDIDATES=(
    "$CACHE/artifacts/ghostty-$commit-zig-$zig_sha"
    "$ROOT/../../.cache/native/artifacts/ghostty-$commit-zig-$zig_sha"
    "$ROOT/../../../.cache/native/artifacts/ghostty-$commit-zig-$zig_sha"
  )
  ARTIFACT="${CANDIDATES[0]}"
  for candidate in "${CANDIDATES[@]}"; do
    if [[ -d "$candidate/GhosttyKit.xcframework" ]]; then
      ARTIFACT=$candidate
      break
    fi
  done
fi
EVIDENCE=${2:-"$ROOT/raw/qualification/ghostty-b1-gate7-physical"}
XCFRAMEWORK="$ARTIFACT/GhosttyKit.xcframework"
if [[ ! -d "$XCFRAMEWORK" ]]; then
  echo "GhosttyKit artifact missing: $XCFRAMEWORK" >&2
  exit 1
fi

MACOS_LIBRARY_PATH='GhosttyKit.xcframework/macos-arm64_x86_64/libghostty-internal.a'

validate_artifact_binding() {
  local artifact=$1 report=$2
  local manifest="$artifact/artifact-manifest.json"
  : >"$report"
  printf 'artifact=%s\n' "$artifact" >>"$report"
  if [[ ! -f "$manifest" ]]; then
    printf 'artifact_manifest=MISSING -> fail closed\n' >>"$report"
    return 1
  fi
  printf 'artifact_manifest_sha256=%s\n' \
    "$(/usr/bin/shasum -a 256 "$manifest" | /usr/bin/cut -d' ' -f1)" >>"$report"

  local failures=0 pair jq_path lock_key manifest_value lock_value_actual
  for pair in \
    '.source.commit=ghostty.commit' \
    '.source.upstreamTree=ghostty.upstreamTree' \
    '.source.patchedTree=ghostty.patchedTree' \
    '.source.declaredVersion=ghostty.declaredVersion' \
    '.source.patchSeriesSha256=ghostty.patchSeriesSha256' \
    '.source.upstreamPublicHeaderSha256=ghostty.upstreamPublicHeaderSha256' \
    '.source.bridgeHeaderSha256=ghostty.bridgeHeaderSha256' \
    '.source.symbolListSha256=ghostty.symbolListSha256' \
    '.toolchain.zig.version=zig.version' \
    '.toolchain.zig.arm64Sha256=zig.arm64Sha256' \
    '.toolchain.zig.x86_64Sha256=zig.x86_64Sha256' \
    '.toolchain.apple.xcode=apple.xcode' \
    '.toolchain.apple.build=apple.build' \
    '.toolchain.apple.swift=apple.swift' \
    '.toolchain.deploymentTarget=deploymentTarget'
  do
    jq_path=${pair%%=*}
    lock_key=${pair#*=}
    manifest_value=$(/usr/bin/jq -r "$jq_path // empty" "$manifest")
    lock_value_actual=$(lock_value "$lock_key")
    if [[ -z "$manifest_value" || -z "$lock_value_actual" \
       || "$manifest_value" != "$lock_value_actual" ]]; then
      printf 'MISMATCH %s manifest=[%s] lock=[%s]\n' \
        "$jq_path" "$manifest_value" "$lock_value_actual" >>"$report"
      failures=$((failures + 1))
    else
      printf 'ok %s=%s\n' "$jq_path" "$manifest_value" >>"$report"
    fi
  done

  local recorded actual
  recorded=$(/usr/bin/jq -r \
    --arg p "$MACOS_LIBRARY_PATH" \
    '.files[] | select(.path == $p) | .sha256' "$manifest")
  if [[ -f "$artifact/$MACOS_LIBRARY_PATH" ]]; then
    actual=$(/usr/bin/shasum -a 256 "$artifact/$MACOS_LIBRARY_PATH" | /usr/bin/cut -d' ' -f1)
  else
    actual=""
  fi
  if [[ -z "$recorded" || -z "$actual" || "$recorded" != "$actual" ]]; then
    printf 'MISMATCH macos_library manifest=[%s] actual=[%s]\n' "$recorded" "$actual" >>"$report"
    failures=$((failures + 1))
  else
    printf 'ok macos_library_sha256=%s\n' "$actual" >>"$report"
  fi

  printf 'mismatches=%s\n' "$failures" >>"$report"
  [[ "$failures" -eq 0 ]]
}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/hive-ghostty-gate7.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$EVIDENCE"
# Preserve human-filled slots across re-runs; wipe only machine-generated names.
for stale in \
  provenance.txt artifact-binding.txt artifact-binding-controls.txt \
  display-inventory.txt corpus-gate7.txt \
  plain-gate7-protocol.jsonl plain-gate7-probe.stderr.txt \
  main-thread-admission.txt occlusion-window-ordering.txt rapid-churn.txt \
  instruments-time-profiler-summary.txt instruments-allocations-summary.txt \
  instruments-power-energy-summary.txt instruments-leaks-summary.txt \
  gpu-device-fault-scope.txt engine-fence-note.txt \
  human-checklist.txt evidence-sha256.txt
do
  rm -f "$EVIDENCE/$stale"
done
# .trace packages are directories on modern Xcode.
for stale_trace in \
  instruments-time-profiler.trace instruments-allocations.trace \
  instruments-power-energy.trace instruments-leaks.trace
do
  rm -rf "$EVIDENCE/$stale_trace"
done
# Human transcript slots: create PENDING placeholders only if absent.
for human_slot in \
  human-dual-display-inventory.txt \
  human-dual-display-transcript.txt \
  human-sleep-wake-transcript.txt
do
  if [[ ! -f "$EVIDENCE/$human_slot" ]]; then
    printf 'STATUS=PENDING_HUMAN\nslot=%s\n' "$human_slot" >"$EVIDENCE/$human_slot"
  fi
done

echo "== artifact binding =="
if ! validate_artifact_binding "$ARTIFACT" "$EVIDENCE/artifact-binding.txt"; then
  echo "artifact is NOT bound to this pin's source tuple; see $EVIDENCE/artifact-binding.txt" >&2
  /bin/cat "$EVIDENCE/artifact-binding.txt" >&2
  exit 1
fi

binding_control_record="$EVIDENCE/artifact-binding-controls.txt"
: >"$binding_control_record"
run_binding_control() {
  local name=$1 dir=$2
  local report="$TMP/binding-control-$name.txt"
  local status=0
  validate_artifact_binding "$dir" "$report" || status=$?
  {
    printf 'control=%s exit_status=%s\n' "$name" "$status"
    /usr/bin/sed 's/^/  /' "$report"
  } >>"$binding_control_record"
  if [[ "$status" -eq 0 ]]; then
    echo "binding control $name DID NOT BITE: validation accepted a bad artifact" >&2
    exit 1
  fi
}
mkdir -p "$TMP/binding-missing"
run_binding_control missing-manifest "$TMP/binding-missing"
mkdir -p "$TMP/binding-tampered"
/usr/bin/jq '.source.patchedTree = "a27fc0e700000000000000000000000000000000"' \
  "$ARTIFACT/artifact-manifest.json" >"$TMP/binding-tampered/artifact-manifest.json"
run_binding_control tampered-patched-tree "$TMP/binding-tampered"
mkdir -p "$TMP/binding-swapped/$(/usr/bin/dirname "$MACOS_LIBRARY_PATH")"
/bin/cp "$ARTIFACT/artifact-manifest.json" "$TMP/binding-swapped/artifact-manifest.json"
printf 'not the qualified library' >"$TMP/binding-swapped/$MACOS_LIBRARY_PATH"
run_binding_control swapped-library "$TMP/binding-swapped"

/usr/bin/rsync -a --exclude .build --exclude '.build-*' --exclude Vendor \
  "$ROOT/workspace/" "$TMP/workspace/"
mkdir -p "$TMP/native/include" "$TMP/workspace/Vendor"
/usr/bin/rsync -a "$ROOT/native/include/" "$TMP/native/include/"
/usr/bin/ditto "$XCFRAMEWORK" "$TMP/workspace/Vendor/GhosttyKit.xcframework"

TARGET_TRIPLE="$(uname -m)-apple-macosx$(lock_value deploymentTarget)"
TRIPLE_DIR="$(uname -m)-apple-macosx"
GATE7_FILTER='Gate7RenderingTests'

{
  printf 'qualification=M1-B1 Gate 7 rendering/geometry/GPU physical slice (matrix rows F+I partial)\n'
  printf 'host_arch=%s\n' "$(uname -m)"
  /usr/bin/sw_vers
  /usr/bin/xcodebuild -version
  /usr/bin/xcrun swift --version
  printf 'ghostty_commit=%s\n' "$(lock_value ghostty.commit)"
  printf 'ghostty_patched_tree=%s\n' "$(lock_value ghostty.patchedTree)"
  printf 'patch_series_sha256=%s\n' "$(lock_value ghostty.patchSeriesSha256)"
  printf 'bridge_header_sha256=%s\n' "$(lock_value ghostty.bridgeHeaderSha256)"
  printf 'symbol_list_sha256=%s\n' "$(lock_value ghostty.symbolListSha256)"
  printf 'artifact_dir=%s\n' "$ARTIFACT"
  /usr/bin/grep -E '^(artifact_manifest_sha256|ok macos_library_sha256)=' \
    "$EVIDENCE/artifact-binding.txt" | /usr/bin/sed 's/^ok //'
  printf 'gui_session=required_unlocked\n'
  printf 'instruments_tool=xctrace\n'
  printf 'energy_template_note=Power Profiler is attempted once as a measured negative control (see instruments-power-energy-summary.txt); Activity Monitor is the Mac energy/CPU-power-adjacent positive pass.\n'
} >"$EVIDENCE/provenance.txt" 2>&1

echo "== display inventory (authoring host) =="
{
  printf 'captured_at=%s\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'screen_count_nsscreen_note=see probe bootstrap stage\n'
  /usr/sbin/system_profiler SPDisplaysDataType
} >"$EVIDENCE/display-inventory.txt" 2>&1

{
  printf 'rule=Debug-vs-ReleaseFast engine fence\n'
  printf 'scope=sessiond host attach paths (M3); pure Gate7 renderer probe does not cross the fence\n'
  printf 'requirement=when a later Gate7 run attaches through sessiond, sessiond and renderer build modes must match (both Debug or both ReleaseFast) or the fence fails closed by design\n'
  printf 'this_run=probe+xctest only; no sessiond attach\n'
} >"$EVIDENCE/engine-fence-note.txt"

echo "== GPU / device-fault honesty scope =="
cat >"$EVIDENCE/gpu-device-fault-scope.txt" <<'EOF'
Gate 7 GPU / device-fault recovery — honesty scope
==================================================

Pinned engine fact (upstream 73534c4680a809398b396c94ac7f12fcccb7963d):
  * Ghostty's Metal renderer installs its own IOSurface-backed CALayer on the
    supplied NSView (src/renderer/Metal.zig). It is NOT a CAMetalLayer host.
  * The public/bridge surface exposes NO device-recreation API.
  * Therefore a local "recreate MTLDevice and rebuild the layer" path cannot
    be invented in HiveTerminalKit without forking Ghostty's renderer.

What IS provable (and is proven in this evidence package):
  1. Host contract for renderer health (Gate7RenderingTests):
       - UNHEALTHY suspends frame submission
       - HEALTHY resynchronizes + refresh and presents at most one pending frame
       - health actions are surface-scoped (one surface unhealthy does not
         affect a sibling)
  2. Host suspension gates: closed / unhealthy / sleep / zero-size / occluded
     retain at most one pending frame and submit none until recovery.
  3. Layer type is the real IOSurfaceLayer Ghostty installs (not a fabricated
     CAMetalLayer).

What is NOT provable without hardware + B2 orchestration:
  1. An actual GPU/device fault or forced hardware-disconnect event that
     originates inside Ghostty's Metal stack.
  2. In-process device recreation at the view layer (API does not exist).
  3. Full surface replacement: that is the agreed Gate 6/B2 path —
       close old-surface admission → create fresh same-architecture surface →
       atomically restore sessiond's last exported checkpoint → replay retained
       output from checkpoint through_seq → reconcile geometry/config → first
       fully restored frame. The dying surface has no checkpoint-export API.

STATUS for matrix row "GPU/device-fault recovery":
  HOST_CONTRACT = GREEN (automated)
  HARDWARE_FAULT_OR_B2_REPLACEMENT = OPEN (human/hardware + Gate 6 ownership)
  This file deliberately refuses to mark the hardware row green.
EOF

build_probe() {
  local scratch=$1
  (
    unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy
    cd "$TMP/workspace"
    /usr/bin/swift build \
      --product GhosttyGate7Probe \
      --scratch-path "$scratch" \
      --triple "$TARGET_TRIPLE" \
      >/dev/null
  )
  echo "$scratch/$TRIPLE_DIR/debug/GhosttyGate7Probe"
}

assert_protocol() {
  local protocol=$1
  /usr/bin/jq -c . "$protocol" >/dev/null
  local stage
  for stage in bootstrap main-thread-admission idle live-resize \
               occlusion-window-order rapid-churn complete; do
    if ! /usr/bin/grep -q "\"stage\":\"$stage\"" "$protocol"; then
      echo "gate 7 probe protocol is missing stage $stage: $protocol" >&2
      return 1
    fi
  done
  if /usr/bin/grep -q '"stage":"failed"' "$protocol"; then
    echo "gate 7 probe reported a failed stage: $protocol" >&2
    return 1
  fi
}

extract_stage() {
  local protocol=$1 stage=$2 out=$3
  /usr/bin/jq -c --arg s "$stage" 'select(.stage == $s)' "$protocol" >"$out"
}

echo "== host corpus: Gate7RenderingTests (physical multi-display skipped) =="
(
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy
  cd "$TMP/workspace"
  # Do NOT set HIVE_GHOSTTY_GATE7_PHYSICAL — default suite must skip the
  # interactive multi-display test rather than hang for a human drag.
  /usr/bin/swift test \
    --scratch-path "$TMP/build-corpus" \
    --triple "$TARGET_TRIPLE" \
    --filter "$GATE7_FILTER" \
    >"$EVIDENCE/corpus-gate7.txt" 2>&1
)

echo "== probe plain (live AppKit) =="
PLAIN_PROBE=$(build_probe "$TMP/build-plain")
# Run under a short timeout safety net only if the probe hangs; do not SIGKILL
# mid-surface — the probe exits itself after clean teardown.
"$PLAIN_PROBE" >"$EVIDENCE/plain-gate7-protocol.jsonl" 2>"$EVIDENCE/plain-gate7-probe.stderr.txt"
assert_protocol "$EVIDENCE/plain-gate7-protocol.jsonl"
extract_stage "$EVIDENCE/plain-gate7-protocol.jsonl" main-thread-admission \
  "$EVIDENCE/main-thread-admission.txt"
extract_stage "$EVIDENCE/plain-gate7-protocol.jsonl" occlusion-window-order \
  "$EVIDENCE/occlusion-window-ordering.txt"
extract_stage "$EVIDENCE/plain-gate7-protocol.jsonl" rapid-churn \
  "$EVIDENCE/rapid-churn.txt"

# Instruments: launch a fresh probe under each template. Time limits cover the
# full autonomous probe run (idle 2s + resize + occlusion + 20 churn cycles).
record_instruments() {
  local template=$1 out_trace=$2 out_summary=$3
  local status=0
  echo "== instruments: $template =="
  # Prefer launching the probe so the recording covers the full lifecycle.
  # --no-prompt skips privacy dialogs on an already-authorized developer machine.
  if /usr/bin/xctrace record \
      --template "$template" \
      --time-limit 120s \
      --output "$out_trace" \
      --no-prompt \
      --launch -- "$PLAIN_PROBE" \
      >"$TMP/xctrace-$template.stdout.txt" 2>"$TMP/xctrace-$template.stderr.txt"; then
    status=0
  else
    status=$?
  fi
  {
    printf 'template=%s\n' "$template"
    printf 'exit_status=%s\n' "$status"
    printf 'trace=%s\n' "$out_trace"
    printf 'captured_at=%s\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)"
    if [[ -e "$out_trace" ]]; then
      # .trace is a package directory on modern Xcode; size is the package tree.
      printf 'trace_bytes=%s\n' "$(/usr/bin/du -sk "$out_trace" | /usr/bin/awk '{print $1 * 1024}')"
      if [[ -d "$out_trace" ]]; then
        printf 'trace_kind=package_directory\n'
        # Digest a stable listing of package contents rather than hashing a dir.
        printf 'trace_listing_sha256=%s\n' \
          "$(/usr/bin/find "$out_trace" -type f -print0 | /usr/bin/sort -z | /usr/bin/xargs -0 /usr/bin/shasum -a 256 | /usr/bin/shasum -a 256 | /usr/bin/cut -d' ' -f1)"
      else
        printf 'trace_kind=file\n'
        printf 'trace_sha256=%s\n' "$(/usr/bin/shasum -a 256 "$out_trace" | /usr/bin/cut -d' ' -f1)"
      fi
      # TOC export as text for review without opening Instruments.app.
      if /usr/bin/xctrace export --input "$out_trace" --toc \
          >"$TMP/toc-$template.xml" 2>"$TMP/toc-$template.err"; then
        printf 'toc_export=ok\n'
        # Keep the TOC body in the summary (bounded).
        /usr/bin/sed -n '1,200p' "$TMP/toc-$template.xml"
      else
        printf 'toc_export=failed\n'
        /bin/cat "$TMP/toc-$template.err"
      fi
    else
      printf 'trace_bytes=0\n'
      printf 'error=trace package missing\n'
      /bin/cat "$TMP/xctrace-$template.stderr.txt"
    fi
    printf '%s\n' '--- xctrace stderr ---'
    /bin/cat "$TMP/xctrace-$template.stderr.txt"
  } >"$out_summary"
  # Instruments failure is a hard fail for the automatable pass: the retained
  # row requires these artifacts.
  if [[ "$status" -ne 0 || ! -e "$out_trace" ]]; then
    echo "xctrace record failed for template '$template' (exit $status)" >&2
    /bin/cat "$out_summary" >&2
    return 1
  fi
}

# Note: do not commit multi-hundred-MB .trace blobs by default. Summaries are
# the review artifact; traces stay in the evidence dir for local inspection and
# are listed in the manifest only when present. .gitignore at evidence root
# keeps *.trace out of git if huge — summaries are always committed.
record_instruments "Time Profiler" \
  "$EVIDENCE/instruments-time-profiler.trace" \
  "$EVIDENCE/instruments-time-profiler-summary.txt"
record_instruments "Allocations" \
  "$EVIDENCE/instruments-allocations.trace" \
  "$EVIDENCE/instruments-allocations-summary.txt"

# Energy: MEASURED negative control first (F1). Power Profiler must fail on
# macOS; we record real exit+stderr so the claim is not prose-only. Then the
# Mac energy-adjacent positive pass uses Activity Monitor into the same
# summary file (negative control first, then positive).
echo "== instruments: Power Profiler (measured negative control) =="
POWER_NEG_TRACE="$EVIDENCE/instruments-power-profiler-negative.trace"
POWER_NEG_STATUS=0
rm -rf "$POWER_NEG_TRACE"
if /usr/bin/xctrace record \
    --template "Power Profiler" \
    --time-limit 15s \
    --output "$POWER_NEG_TRACE" \
    --no-prompt \
    --launch -- "$PLAIN_PROBE" \
    >"$TMP/xctrace-PowerProfiler.stdout.txt" 2>"$TMP/xctrace-PowerProfiler.stderr.txt"; then
  POWER_NEG_STATUS=0
else
  POWER_NEG_STATUS=$?
fi
{
  printf '%s\n' '=== measured_negative_control: Power Profiler ==='
  printf 'template=Power Profiler\n'
  printf 'role=negative_control_mac_unsupported\n'
  printf 'exit_status=%s\n' "$POWER_NEG_STATUS"
  printf 'captured_at=%s\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'expect=non_zero_exit_and_ios_only_message\n'
  printf '%s\n' '--- xctrace stdout ---'
  /bin/cat "$TMP/xctrace-PowerProfiler.stdout.txt"
  printf '%s\n' '--- xctrace stderr ---'
  /bin/cat "$TMP/xctrace-PowerProfiler.stderr.txt"
} >"$EVIDENCE/instruments-power-energy-summary.txt"
# Fail closed if the "unsupported" claim no longer holds (template suddenly works).
if [[ "$POWER_NEG_STATUS" -eq 0 ]]; then
  echo "Power Profiler negative control DID NOT BITE (exit 0); energy claim needs re-measurement" >&2
  exit 1
fi
if ! /usr/bin/grep -qiE 'not supported on macOS|iOS or iPadOS' \
  "$TMP/xctrace-PowerProfiler.stderr.txt" \
  "$TMP/xctrace-PowerProfiler.stdout.txt"; then
  echo "Power Profiler failed but without the expected macOS-unsupported message; inspect summary" >&2
  /bin/cat "$EVIDENCE/instruments-power-energy-summary.txt" >&2
  exit 1
fi
printf 'negative_control=BIT\n' >>"$EVIDENCE/instruments-power-energy-summary.txt"
rm -rf "$POWER_NEG_TRACE"

# Positive energy-adjacent pass: Activity Monitor (append after negative control).
echo "== instruments: Activity Monitor (Mac energy-adjacent positive) =="
ACTIVITY_TRACE="$EVIDENCE/instruments-power-energy.trace"
ACTIVITY_STATUS=0
if /usr/bin/xctrace record \
    --template "Activity Monitor" \
    --time-limit 120s \
    --output "$ACTIVITY_TRACE" \
    --no-prompt \
    --launch -- "$PLAIN_PROBE" \
    >"$TMP/xctrace-ActivityMonitor.stdout.txt" 2>"$TMP/xctrace-ActivityMonitor.stderr.txt"; then
  ACTIVITY_STATUS=0
else
  ACTIVITY_STATUS=$?
fi
{
  printf '\n%s\n' '=== positive_pass: Activity Monitor (Mac energy-adjacent) ==='
  printf 'template=Activity Monitor\n'
  printf 'role=mac_energy_adjacent_positive\n'
  printf 'exit_status=%s\n' "$ACTIVITY_STATUS"
  printf 'trace=%s\n' "$ACTIVITY_TRACE"
  printf 'captured_at=%s\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ -e "$ACTIVITY_TRACE" ]]; then
    printf 'trace_bytes=%s\n' "$(/usr/bin/du -sk "$ACTIVITY_TRACE" | /usr/bin/awk '{print $1 * 1024}')"
    printf 'trace_kind=package_directory\n'
    printf 'trace_listing_sha256=%s\n' \
      "$(/usr/bin/find "$ACTIVITY_TRACE" -type f -print0 | /usr/bin/sort -z | /usr/bin/xargs -0 /usr/bin/shasum -a 256 | /usr/bin/shasum -a 256 | /usr/bin/cut -d' ' -f1)"
    if /usr/bin/xctrace export --input "$ACTIVITY_TRACE" --toc \
        >"$TMP/toc-ActivityMonitor.xml" 2>"$TMP/toc-ActivityMonitor.err"; then
      printf 'toc_export=ok\n'
      /usr/bin/sed -n '1,200p' "$TMP/toc-ActivityMonitor.xml"
    else
      printf 'toc_export=failed\n'
      /bin/cat "$TMP/toc-ActivityMonitor.err"
    fi
  else
    printf 'error=trace package missing\n'
  fi
  printf '%s\n' '--- xctrace stderr ---'
  /bin/cat "$TMP/xctrace-ActivityMonitor.stderr.txt"
} >>"$EVIDENCE/instruments-power-energy-summary.txt"
if [[ "$ACTIVITY_STATUS" -ne 0 || ! -e "$ACTIVITY_TRACE" ]]; then
  echo "Activity Monitor positive energy pass failed (exit $ACTIVITY_STATUS)" >&2
  exit 1
fi

record_instruments "Leaks" \
  "$EVIDENCE/instruments-leaks.trace" \
  "$EVIDENCE/instruments-leaks-summary.txt"

echo "== human checklist (scripted; slots for operator captures) =="
cat >"$EVIDENCE/human-checklist.txt" <<'EOF'
Gate 7 physical — HUMAN-REQUIRED checklist
==========================================
Pin/runner: scripts/qualify-ghostty-gate7-physical.sh
Evidence dir: raw/qualification/ghostty-b1-gate7-physical/
Evidence format: .txt (never .log). Drop each capture into the named slot.

Prereqs
-------
[ ] Mac with ONE Retina and ONE non-Retina display both online (not mirrored).
[ ] Unlocked GUI session; Displays preference shows both as extended desktop.
[ ] Repo at the Gate 7 pin; GhosttyKit artifact bound (re-run the qualify script
    first if unsure — it rewrites machine slots and preserves human slots that
    are already filled).
[ ] Debug-vs-ReleaseFast: if you also attach a live sessiond terminal, build
    modes MUST match or the M3 fence fails by design. Pure probe/xctest is fine.

A. Dual-display Retina ↔ non-Retina drag
---------------------------------------
1. Capture inventory into slot: human-dual-display-inventory.txt
     system_profiler SPDisplaysDataType > raw/qualification/ghostty-b1-gate7-physical/human-dual-display-inventory.txt
   Accept only if BOTH displays are Online, Mirror: Off, and scales differ
   (Retina contentsScale 2.x vs non-Retina 1.x).

2. From workspace/, run the opt-in XCTest (do NOT background it):
     cd workspace
     HIVE_GHOSTTY_GATE7_PHYSICAL=1 \
     swift test --filter Gate7RenderingTests/testPhysicalMonitorScaleAndSleepWakeQualification
   (Omit HIVE_GHOSTTY_GATE7_PHYSICAL_SLEEP here; sleep is section B.)

3. When the test prints:
     GATE7 PHYSICAL: drag the qualification window to the other-scale display
   drag the titled window fully onto the other display within 120s.
   Confirm the test continues (display ID + content scale both change; idle
   frame silence for 2s; drawable size == convertToBacking).

4. Capture the full swift test transcript into:
     human-dual-display-transcript.txt
   Replace the PENDING_HUMAN placeholder. Include exit status.

Pass criteria:
  * transcript ends with test passed
  * inventory shows two displays with different scale
  * transcript contains a changed display identity / scale observation

B. Sleep / wake
---------------
1. Same machine, still dual-display if available.
2. Run:
     cd workspace
     HIVE_GHOSTTY_GATE7_PHYSICAL=1 \
     HIVE_GHOSTTY_GATE7_PHYSICAL_SLEEP=1 \
     swift test --filter Gate7RenderingTests/testPhysicalMonitorScaleAndSleepWakeQualification
3. Complete the dual-display drag when prompted, then when it prints:
     GATE7 PHYSICAL: sleep and wake the Mac now
   put the Mac to sleep (Apple menu → Sleep, or close clamshell only if the
   external display keeps the session alive — prefer full system sleep), wait
   ≥5s, wake, unlock if needed. The test waits up to 600s for
   wakeTransitionCount to increment and occlusion to re-apply as visible.
4. Capture the full transcript into:
     human-sleep-wake-transcript.txt

Pass criteria:
  * wakeTransitionCount advanced (test assertion)
  * applied occlusion visible after wake
  * no crash / no hung draw path

C. Optional: attach Instruments during human drag / minimize / wake
------------------------------------------------------------------
If queen asks for Instruments on the multi-display path specifically:
  1. Start Instruments (Time Profiler + Allocations + Activity Monitor — the
     Mac energy-adjacent template; do NOT use Power Profiler on macOS, it is
     iOS/iPadOS-only and is already recorded as a measured negative control)
     against the running xctest/HiveTerminalKitTests process during the drag,
     while minimized, and after wake.
  2. Export run notes as additional .txt beside the transcripts (do not use
     .log). Name them instruments-human-*.txt.

What you do NOT need to invent
------------------------------
  * A CAMetalLayer or device-recreation API — see gpu-device-fault-scope.txt.
  * Concurrent surface creation (global-singleton race; can null).
  * SIGKILL of a live surface test (leaks GPU resources). Tear down cleanly.

When all human slots no longer say STATUS=PENDING_HUMAN, re-run:
  (cd raw/qualification/ghostty-b1-gate7-physical && /usr/bin/shasum -a 256 \
     $(/usr/bin/find . -type f ! -name evidence-sha256.txt ! -name '*.trace' | /usr/bin/sort) \
     > evidence-sha256.txt)
and tell queen the human rows are filled for cross-vendor review.
EOF

echo "== evidence digests =="
(
  cd "$EVIDENCE"
  # Manifest committed text/jsonl evidence only. Binary .trace packages are
  # gitignored; their package listing digests live inside each
  # instruments-*-summary.txt.
  /usr/bin/find . -type f \
    ! -name evidence-sha256.txt \
    ! -path '*/instruments-*.trace/*' \
    ! -name '*.trace' \
    -print0 \
    | /usr/bin/sort -z \
    | /usr/bin/xargs -0 /usr/bin/shasum -a 256 \
    >evidence-sha256.txt
)

echo "Gate 7 physical automatable pass complete."
echo "Evidence: $EVIDENCE"
echo "Human slots still PENDING unless previously filled:"
/usr/bin/grep -l 'STATUS=PENDING_HUMAN' \
  "$EVIDENCE"/human-dual-display-inventory.txt \
  "$EVIDENCE"/human-dual-display-transcript.txt \
  "$EVIDENCE"/human-sleep-wake-transcript.txt 2>/dev/null || true
echo "HOLD: do not land until human rows + cross-vendor review clear."
