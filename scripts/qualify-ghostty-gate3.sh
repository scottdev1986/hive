#!/bin/bash
# Gate 3 (M1-B1): LIFETIME / THREADING / EVENT LOOP live proof — live-proof
# matrix row E. Two halves, both run here against the shipped GhosttyKit
# artifact:
#
#   ENGINE SCOPE   GhosttyGate3Probe drives the real C ABI: wakeup->tick,
#                  callback-payload lifetime, no-callback-after-free,
#                  surface->app->config free ordering, multiple surfaces,
#                  rapid create/free, and close-while-output/draw-in-flight.
#                  Run plain, under AddressSanitizer, and under ThreadSanitizer.
#
#   HOST SCOPE     The HiveTerminalKit Gate 3 XCTest corpus (the Swift callback
#                  and teardown discipline) under both sanitizers.
#
# Every claim carries a positive control that MUST go RED. Engine-scope controls
# are probe defect modes (--defect=...); host-scope controls delete the
# load-bearing production line in a throwaway copy of the tree and require the
# corpus to fail. A control that cannot go red is not evidence.
#
# Usage: qualify-ghostty-gate3.sh [artifact-dir] [evidence-dir]
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
EVIDENCE=${2:-"$ROOT/raw/qualification/ghostty-b1-gate3-lifetime"}
XCFRAMEWORK="$ARTIFACT/GhosttyKit.xcframework"
if [[ ! -d "$XCFRAMEWORK" ]]; then
  echo "GhosttyKit artifact missing: $XCFRAMEWORK" >&2
  exit 1
fi

MACOS_LIBRARY_PATH='GhosttyKit.xcframework/macos-arm64_x86_64/libghostty-internal.a'

# Bind the exercised binary to THIS pin's source tuple, cryptographically.
#
# Existence of an xcframework proves nothing about which source produced it:
# the artifact cache key is upstream-commit + Zig-SHA only, so it excludes
# patchedTree and patchSeries and two different patch series collide on one
# key. (Measured on this machine: the same key has held both the current
# artifact and an older one with a different patchedTree.) Without this check a
# committed corpus cannot say which compatible binary produced it.
#
# Two links are verified, both FAIL CLOSED — an absent manifest is a hard
# error, never a skipped check:
#   A  artifact-manifest.json's source/toolchain identity == toolchain-lock.json
#   B  the macOS library's actual bytes == the sha256 the manifest records for
#      it, so a manifest cannot vouch for a different binary beside it
#
# A missing key reads back as null rather than raising, so null/empty is
# treated as a mismatch explicitly instead of comparing equal to an absent
# lock value.
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

  # Link B: the library the probe and corpus actually link against.
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

TMP=$(mktemp -d "${TMPDIR:-/tmp}/hive-ghostty-gate3.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$EVIDENCE"
find "$EVIDENCE" -mindepth 1 -depth -delete

echo "== artifact binding =="
if ! validate_artifact_binding "$ARTIFACT" "$EVIDENCE/artifact-binding.txt"; then
  echo "artifact is NOT bound to this pin's source tuple; see $EVIDENCE/artifact-binding.txt" >&2
  /bin/cat "$EVIDENCE/artifact-binding.txt" >&2
  exit 1
fi

# The binding check is itself positive-controlled: a validator that cannot go
# red is exactly the gap it was added to close. Both controls drive the SAME
# function, so a bite proves the committed check, not a parallel copy of it.
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
# Absent manifest must be a hard error, not a silent skip.
mkdir -p "$TMP/binding-missing"
run_binding_control missing-manifest "$TMP/binding-missing"
# One doctored identity field — a different patch series on the same cache key,
# which is precisely the collision the cache key cannot distinguish.
mkdir -p "$TMP/binding-tampered"
/usr/bin/jq '.source.patchedTree = "a27fc0e700000000000000000000000000000000"' \
  "$ARTIFACT/artifact-manifest.json" >"$TMP/binding-tampered/artifact-manifest.json"
run_binding_control tampered-patched-tree "$TMP/binding-tampered"
# A manifest that vouches for a library it does not describe.
mkdir -p "$TMP/binding-swapped/$(/usr/bin/dirname "$MACOS_LIBRARY_PATH")"
/bin/cp "$ARTIFACT/artifact-manifest.json" "$TMP/binding-swapped/artifact-manifest.json"
printf 'not the qualified library' >"$TMP/binding-swapped/$MACOS_LIBRARY_PATH"
run_binding_control swapped-library "$TMP/binding-swapped"
/usr/bin/rsync -a --exclude .build --exclude '.build-*' --exclude Vendor \
  "$ROOT/workspace/" "$TMP/workspace/"
mkdir -p "$TMP/native/include" "$TMP/workspace/Vendor"
/usr/bin/rsync -a "$ROOT/native/include/" "$TMP/native/include/"
# swift test/build in the copy needs the binary target materialized here: the
# package's Vendor path is relative to the package root, not the repo root.
/usr/bin/ditto "$XCFRAMEWORK" "$TMP/workspace/Vendor/GhosttyKit.xcframework"

TARGET_TRIPLE="$(uname -m)-apple-macosx$(lock_value deploymentTarget)"
# SwiftPM drops the OS version from the build directory name.
TRIPLE_DIR="$(uname -m)-apple-macosx"
GATE3_FILTER='CallbackDisciplineTests|AppWakeupLifecycleTests|Gate3OperationDomainTests|Gate3ConcurrentCreationTests'

{
  printf 'qualification=M1-B1 Gate 3 lifetime/threading/event-loop (live-proof matrix row E)\n'
  printf 'host_arch=%s\n' "$(uname -m)"
  /usr/bin/sw_vers
  /usr/bin/xcodebuild -version
  /usr/bin/xcrun swift --version
  printf 'ghostty_commit=%s\n' "$(lock_value ghostty.commit)"
  printf 'ghostty_patched_tree=%s\n' "$(lock_value ghostty.patchedTree)"
  printf 'patch_series_sha256=%s\n' "$(lock_value ghostty.patchSeriesSha256)"
  printf 'bridge_header_sha256=%s\n' "$(lock_value ghostty.bridgeHeaderSha256)"
  printf 'symbol_list_sha256=%s\n' "$(lock_value ghostty.symbolListSha256)"
  # Identity of the binary actually exercised, not merely of the pin it should
  # have come from. Full validated field table in artifact-binding.txt.
  printf 'artifact_dir=%s\n' "$ARTIFACT"
  /usr/bin/grep -E '^(artifact_manifest_sha256|ok macos_library_sha256)=' \
    "$EVIDENCE/artifact-binding.txt" | /usr/bin/sed 's/^ok //'
} >"$EVIDENCE/provenance.txt" 2>&1

build_probe() {
  local scratch=$1
  shift
  (
    unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy
    cd "$TMP/workspace"
    /usr/bin/swift build \
      --product GhosttyGate3Probe \
      --scratch-path "$scratch" \
      --triple "$TARGET_TRIPLE" \
      "$@" >/dev/null
  )
  echo "$scratch/$TRIPLE_DIR/debug/GhosttyGate3Probe"
}

# Stages the probe must reach for the run to count as a proof rather than an
# early exit that merely failed to crash.
assert_protocol() {
  local protocol=$1
  /usr/bin/jq -c . "$protocol" >/dev/null
  local stage
  for stage in wakeup-tick copy-before-return no-callback-after-free \
               multi-surface inflight-close rapid-create-free free-ordering complete; do
    if ! /usr/bin/grep -q "\"stage\":\"$stage\"" "$protocol"; then
      echo "gate 3 probe protocol is missing stage $stage: $protocol" >&2
      return 1
    fi
  done
}

echo "== engine scope: probe, plain =="
PLAIN_PROBE=$(build_probe "$TMP/build-plain")
"$PLAIN_PROBE" >"$EVIDENCE/plain-gate3-protocol.jsonl" 2>"$EVIDENCE/plain-gate3-probe.stderr.txt"
assert_protocol "$EVIDENCE/plain-gate3-protocol.jsonl"

echo "== engine scope: probe, AddressSanitizer =="
ASAN_PROBE=$(build_probe "$TMP/build-asan" --sanitize=address)
export ASAN_OPTIONS=abort_on_error=1:halt_on_error=1:detect_leaks=0
"$ASAN_PROBE" >"$EVIDENCE/asan-gate3-protocol.jsonl" 2>"$EVIDENCE/asan-gate3-probe.stderr.txt"
assert_protocol "$EVIDENCE/asan-gate3-protocol.jsonl"
if /usr/bin/grep -E 'ERROR: (AddressSanitizer|UndefinedBehaviorSanitizer)' \
  "$EVIDENCE/asan-gate3-probe.stderr.txt" >/dev/null; then
  echo "AddressSanitizer reported a gate 3 memory error on the green run" >&2
  exit 1
fi

echo "== engine scope: probe, ThreadSanitizer =="
TSAN_PROBE=$(build_probe "$TMP/build-tsan" --sanitize=thread)
export TSAN_OPTIONS=halt_on_error=0
# Exit status is deliberately not asserted here: ThreadSanitizer reports one
# KNOWN, benign thread leak — a finished, never-joined engine thread created
# inside ghostty_init's GlobalState.init — and sets a nonzero status for it.
# The gate 3 claim is the absence of DATA RACES, which is asserted directly.
# The full stderr is recorded so the leak stays visible rather than suppressed.
"$TSAN_PROBE" >"$EVIDENCE/tsan-gate3-protocol.jsonl" 2>"$EVIDENCE/tsan-gate3-probe.stderr.txt" || true
assert_protocol "$EVIDENCE/tsan-gate3-protocol.jsonl"
race_count=$(/usr/bin/grep -c 'ThreadSanitizer: data race' "$EVIDENCE/tsan-gate3-probe.stderr.txt" || true)
leak_count=$(/usr/bin/grep -c 'ThreadSanitizer: thread leak' "$EVIDENCE/tsan-gate3-probe.stderr.txt" || true)
{
  printf 'data_race_reports=%s\n' "$race_count"
  printf 'thread_leak_reports=%s\n' "$leak_count"
  printf 'known_benign_leak=ghostty_init GlobalState.init spawns a thread that finishes but is never joined\n'
} >"$EVIDENCE/tsan-summary.txt"
if [[ "$race_count" -ne 0 ]]; then
  echo "ThreadSanitizer reported $race_count data race(s) on the green run" >&2
  exit 1
fi

# ---- engine-scope positive controls -----------------------------------------
# Each reintroduces one gate 3 defect and drives the SAME assertion the green
# run passed. All must exit nonzero. `expected` names the sanitizer whose report
# (or whose assertion) is the bite; it is recorded, not asserted on text alone.
echo "== engine scope: positive controls =="
control_record="$EVIDENCE/engine-positive-controls.txt"
: >"$control_record"
run_control() {
  local name=$1 binary=$2 sanitizer=$3
  local out="$EVIDENCE/control-$name.stdout.jsonl"
  local err="$EVIDENCE/control-$name.stderr.txt"
  local status=0
  "$binary" "--defect=$name" >"$out" 2>"$err" || status=$?
  local report
  report=$(/usr/bin/grep -m1 -o 'ERROR: AddressSanitizer: [a-z-]*' "$err" || true)
  local assertion
  assertion=$(/usr/bin/grep -o '"error":"[^"]*"' "$out" | /usr/bin/head -1 || true)
  {
    printf 'control=%s sanitizer=%s exit_status=%s\n' "$name" "$sanitizer" "$status"
    printf '  sanitizer_report=[%s]\n' "$report"
    printf '  probe_assertion=[%s]\n' "$assertion"
  } >>"$control_record"
  if [[ "$status" -eq 0 ]]; then
    echo "positive control $name DID NOT BITE: the probe exited 0 with the defect applied" >&2
    exit 1
  fi
}
run_control retain-callback-pointer "$PLAIN_PROBE" none
run_control callback-after-free "$PLAIN_PROBE" none
run_control free-app-before-surface "$ASAN_PROBE" address
run_control unserialized-output "$ASAN_PROBE" address

# ---- host scope: the HiveTerminalKit gate 3 corpus under both sanitizers -----
run_corpus() {
  local slug=$1
  shift
  local status=0
  (
    unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy
    cd "$TMP/workspace"
    /usr/bin/swift test --filter "$GATE3_FILTER" "$@"
  ) >"$EVIDENCE/$slug.txt" 2>&1 || status=$?
  echo "$status"
}

echo "== host scope: gate 3 XCTest corpus, AddressSanitizer =="
asan_corpus_status=$(run_corpus corpus-asan --sanitize=address --scratch-path "$TMP/test-asan")
if [[ "$asan_corpus_status" -ne 0 ]]; then
  echo "gate 3 XCTest corpus failed under AddressSanitizer (exit $asan_corpus_status)" >&2
  exit 1
fi

echo "== host scope: gate 3 XCTest corpus, ThreadSanitizer =="
# Same treatment as the probe's ThreadSanitizer run: the corpus loads the same
# engine, so the same known benign thread leak sets a nonzero exit status even
# with every test passing. Assert on the two things that carry the claim —
# every test passed, and no data race — never on the status alone.
tsan_corpus_status=$(run_corpus corpus-tsan --sanitize=thread --scratch-path "$TMP/test-tsan")
corpus_race_count=$(/usr/bin/grep -c 'ThreadSanitizer: data race' "$EVIDENCE/corpus-tsan.txt" || true)
# A filter that matches nothing also "passes", so the executed count is asserted
# to be nonzero rather than merely failure-free.
corpus_tsan_tests=$(/usr/bin/sed -n \
  's/.*Executed \([0-9][0-9]*\) tests, with 0 failures.*/\1/p' \
  "$EVIDENCE/corpus-tsan.txt" | /usr/bin/sort -rn | /usr/bin/head -1)
if [[ -z "$corpus_tsan_tests" || "$corpus_tsan_tests" -eq 0 ]]; then
  echo "gate 3 XCTest corpus reported no passing tests under ThreadSanitizer" >&2
  exit 1
fi
if [[ "$corpus_race_count" -ne 0 ]]; then
  echo "ThreadSanitizer reported $corpus_race_count data race(s) in the gate 3 corpus" >&2
  exit 1
fi
{
  printf 'corpus_tsan_exit_status=%s (nonzero: known benign engine thread leak)\n' "$tsan_corpus_status"
  printf 'corpus_tsan_data_races=%s\n' "$corpus_race_count"
  printf 'corpus_tsan_tests_passed=%s\n' "$corpus_tsan_tests"
} >>"$EVIDENCE/tsan-summary.txt"

# ---- host-scope positive controls -------------------------------------------
# Delete a load-bearing production line in the THROWAWAY copy (never in $ROOT)
# and require the corpus to go red. The byte delta is measured and recorded, so
# a control that silently failed to edit anything cannot pass as a bite.
echo "== host scope: positive controls =="
host_record="$EVIDENCE/host-positive-controls.txt"
: >"$host_record"
CALLBACK_CONTEXT="$TMP/workspace/Sources/HiveTerminalKit/Bridge/CallbackContext.swift"
MANUAL_SURFACE="$TMP/workspace/Sources/HiveTerminalKit/Bridge/ManualSurface.swift"

run_host_control() {
  local name=$1 file=$2 filter=$3 mutation=$4
  local pristine="$TMP/pristine-$name"
  /bin/cp "$file" "$pristine"
  local before after
  before=$(/usr/bin/wc -c <"$file" | /usr/bin/tr -d ' ')
  /usr/bin/perl -0pi -e "$mutation" "$file"
  after=$(/usr/bin/wc -c <"$file" | /usr/bin/tr -d ' ')
  if [[ "$before" == "$after" ]]; then
    echo "host control $name edited nothing ($before bytes before and after)" >&2
    exit 1
  fi
  local status=0
  (
    unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy
    cd "$TMP/workspace"
    /usr/bin/swift test --filter "$filter" --scratch-path "$TMP/test-control"
  ) >"$EVIDENCE/host-control-$name.txt" 2>&1 || status=$?
  {
    printf 'control=%s file=%s\n' "$name" "$(/usr/bin/basename "$file")"
    printf '  bytes_before=%s bytes_after=%s\n' "$before" "$after"
    printf '  filter=%s exit_status=%s\n' "$filter" "$status"
  } >>"$host_record"
  /bin/cp "$pristine" "$file"
  if [[ "$status" -eq 0 ]]; then
    echo "host control $name DID NOT BITE: the corpus stayed green with the guard removed" >&2
    exit 1
  fi
  # A mutation that stops the tree COMPILING also exits nonzero. That is not a
  # bite: it proves nothing about the assertion. Require the run to have reached
  # the tests and reported real failures.
  if ! /usr/bin/grep -qE 'Executed [0-9]+ tests, with [1-9][0-9]* failure' \
    "$EVIDENCE/host-control-$name.txt"; then
    echo "host control $name exited $status without any test failure — likely a build error, not a bite" >&2
    exit 1
  fi
}

# PC-A: the in-flight-callback wait in beginTeardown — the single mechanism
# preventing ghostty_surface_free from running while a native worker is inside a
# callback copy. Cross-vendor review finding F1 was that deleting it left the
# corpus green; this control proves that gap is now closed.
run_host_control teardown-wait "$CALLBACK_CONTEXT" 'CallbackDisciplineTests' \
  's/\n *while activeCallbacks > 0 \{\n *condition\.wait\(\)\n *\}//'

# PC-B: the pre-B1 snapshot's no-op wakeup callback — the trampoline stops
# scheduling a tick at all.
#
# NOTE, recorded because it changes what this control proves: deleting the real
# `ghostty_app_tick(app)` statement instead leaves this corpus GREEN. Every test
# in AppWakeupLifecycleTests drives the tick through `tickOverride`, the spy
# seam, so no host test executes the real C call. That path is covered only by
# the engine-scope probe, whose wakeup-tick stage calls the real
# `ghostty_app_tick` and asserts a tick actually ran. This control therefore
# targets what the host corpus genuinely guards: that the trampoline schedules.
run_host_control noop-wakeup "$MANUAL_SURFACE" 'AppWakeupLifecycleTests' \
  's/ctx\.scheduleTick\(\)/_ = ctx/'

# PC-C: the no-delivery-after-free guarantee for work already queued when free
# ran. Two INDEPENDENT mechanisms enforce it — the execution-time
# `acceptingCallbacks` recheck inside the deferred block, and `beginTeardown`
# nil-ing the handler — so removing either alone correctly leaves the corpus
# green (measured: the recheck-only mutation does not bite). This control
# removes BOTH, which is what it takes to actually lose the guarantee, and the
# corpus must go red.
run_host_control delivery-guards "$CALLBACK_CONTEXT" 'CallbackDisciplineTests' \
  's/let handler = self\.acceptingCallbacks \? self\.writeHandler : nil/let handler = self.writeHandler/g; s/\n        writeHandler = nil\n/\n/'

(
  cd "$EVIDENCE"
  find . -type f ! -name evidence-sha256.txt -print \
    | LC_ALL=C /usr/bin/sort \
    | while IFS= read -r evidence_file; do /usr/bin/shasum -a 256 "$evidence_file"; done \
    >evidence-sha256.txt
)
echo "Gate 3 lifetime/threading qualification passed; evidence: $EVIDENCE"
