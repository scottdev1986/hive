#!/bin/bash
# qa/workspace-shell-layout-mutation-probe.sh
#
# Proves the shell layout regressions discriminate. Each probe removes exactly
# one layout decision, runs the test that decision is supposed to protect, and
# demands that the test fail. A probe whose test still passes means the test
# cannot see the defect it claims to cover, so this script fails instead of
# reporting a green suite.

set -u

die() {
  echo "FAIL: $*" >&2
  exit 1
}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
. "$SCRIPT_DIR/repo-root.sh"
REPO_ROOT="$(qa_repo_root "$SCRIPT_DIR")" || exit 2
SELF_CHECK=0
case "${1:-}" in
  self-check) SELF_CHECK=1 ;;
  "") ;;
  *) echo "usage: qa/workspace-shell-layout-mutation-probe.sh [self-check]" >&2; exit 2 ;;
esac
SHELL_DIR="workspace/Sources/HiveWorkspace/Shell"
CONTROLLER="$SHELL_DIR/WorkspaceShellWindowController.swift"
PANEL="$SHELL_DIR/ShellAvailabilityPanel.swift"
# Set per probe by target(); every mutation and restore goes through it.
TARGET=""
TARGET_PATH=""

for source in "$CONTROLLER" "$PANEL"; do
  [ -f "$REPO_ROOT/$source" ] || die "no source at $REPO_ROOT/$source"
  [ -z "$(git -C "$REPO_ROOT" status --porcelain -- "$source")" ] \
    || die "$source has uncommitted edits; this probe restores it with git"
done

target() {
  TARGET="$1"
  TARGET_PATH="$REPO_ROOT/$1"
}
target "$CONTROLLER"

LOG_DIR="${ARTIFACTS:-$(mktemp -d -t workspace-shell-layout-mutation-probe)}"
mkdir -p "$LOG_DIR" || die "cannot create log directory: $LOG_DIR"

restore() {
  git -C "$REPO_ROOT" checkout -- "$CONTROLLER" "$PANEL" 2>/dev/null || true
}
trap restore EXIT

# Deletes the anchor line plus the given number of continuation lines. The
# anchor must match exactly one line, so a probe can never mutate a site other
# than the one it names.
delete_from_anchor() {
  local anchor="$1"
  local continuations="$2"
  local hits
  hits=$(grep -Fc -- "$anchor" "$TARGET_PATH")
  [ "$hits" = "1" ] || die "anchor matched $hits lines, expected 1: $anchor"
  awk -v anchor="$anchor" -v continuations="$continuations" '
    skip > 0 { skip--; next }
    index($0, anchor) { skip = continuations; next }
    { print }
  ' "$TARGET_PATH" > "$TARGET_PATH.probe" \
    || die "could not rewrite $CONTROLLER"
  mv "$TARGET_PATH.probe" "$TARGET_PATH"
}

replace_unique() {
  local from="$1"
  local to="$2"
  local hits
  hits=$(grep -Fc -- "$from" "$TARGET_PATH")
  [ "$hits" = "1" ] || die "anchor matched $hits lines, expected 1: $from"
  awk -v from="$from" -v to="$to" '
    index($0, from) { sub(from, to); print; next }
    { print }
  ' "$TARGET_PATH" > "$TARGET_PATH.probe" \
    || die "could not rewrite $CONTROLLER"
  mv "$TARGET_PATH.probe" "$TARGET_PATH"
}

# Reads one swift-test log and prints exactly one word: caught, survived, or
# no-measurement. The three never fold together, which is the whole point.
#
# The verdict comes from XCTest's own accounting — the "Executed N tests, with M
# failures" line under `Test Suite 'Selected tests'` — and never from grepping
# for a failure line. A crash kills the test process mid-run: no failure line is
# printed, no accounting line is reached, and the old check read that silence as
# "the test passed", reporting that the mutated code SURVIVED when in fact
# nothing ran. A survival claim and a run that never finished must not look
# alike, because one says the constraint is dead code and the other says nothing
# at all.
#
# no-measurement covers every way a run can fail to produce evidence: the tree
# did not build, the process died before XCTest closed its accounting, or the
# filter selected zero tests — a filter typo would otherwise read as survival.
classify_run() {
  local log="$1"
  if ! grep -q "^Build complete!" "$log"; then
    echo no-measurement
    return
  fi
  # Only the aggregate line is trusted. Per-suite lines are also printed, and
  # summing them would count the same tests two or three times over.
  local accounting
  accounting="$(grep -A 1 "^Test Suite 'Selected tests' \(passed\|failed\) at" "$log" \
    | grep -m 1 -E "Executed [0-9]+ test")"
  if [ -z "$accounting" ]; then
    echo no-measurement
    return
  fi
  local executed failures
  executed="$(printf '%s' "$accounting" | sed -n 's/.*Executed \([0-9]*\) test.*/\1/p')"
  failures="$(printf '%s' "$accounting" | sed -n 's/.*with \([0-9]*\) failure.*/\1/p')"
  if [ -z "$executed" ] || [ -z "$failures" ] || [ "$executed" -eq 0 ]; then
    echo no-measurement
    return
  fi
  if [ "$failures" -gt 0 ]; then
    echo caught
  else
    echo survived
  fi
}

expect_failure() {
  local name="$1"
  local filter="$2"
  local log="$LOG_DIR/$name.log"
  ( cd "$REPO_ROOT/workspace" && swift test --filter "$filter" ) > "$log" 2>&1
  local verdict
  verdict="$(classify_run "$log")"
  case "$verdict" in
    caught)
      echo "PROBE BITES: $name -> $filter failed" ;;
    survived)
      die "$name: $filter still passed without the constraint it depends on ($log)" ;;
    no-measurement)
      die "$name: NO MEASUREMENT — the run did not complete, so neither verdict is available ($log)" ;;
    *)
      die "$name: classify_run returned '$verdict', which is not a verdict ($log)" ;;
  esac
}

# The classifier is what this script's verdicts rest on, so it is exercised
# against logs of every shape before any mutation runs. The truncated case is
# the one that matters: it is a real passing run cut off mid-suite, exactly what
# a crash leaves behind, and it must come back as no measurement rather than as
# the survival the old check reported.
self_check() {
  local work verdict got=0
  work="$(mktemp -d -t shell-layout-classify)" || exit 1

  # A genuine XCTest run, in the format the tool actually emits.
  cat > "$work/passing.log" <<'LOG'
Build complete!
Test Suite 'Selected tests' started at 2026-08-15 19:36:33.089.
Test Suite 'ShellRouteTests' started at 2026-08-15 19:36:33.090.
Test Case '-[WorkspaceCoreTests.ShellRouteTests testExactlyTheTenContractRoutesExist]' started.
Test Case '-[WorkspaceCoreTests.ShellRouteTests testExactlyTheTenContractRoutesExist]' passed (0.001 seconds).
Test Suite 'ShellRouteTests' passed at 2026-08-15 19:36:33.092.
	 Executed 6 tests, with 0 failures (0 unexpected) in 0.001 (0.002) seconds
Test Suite 'Selected tests' passed at 2026-08-15 19:36:33.092.
	 Executed 6 tests, with 0 failures (0 unexpected) in 0.001 (0.002) seconds
LOG

  sed -n '1,5p' "$work/passing.log" > "$work/truncated.log"

  sed 's/with 0 failures/with 1 failure/; s/Selected tests. passed/Selected tests'"'"' failed/' \
    "$work/passing.log" > "$work/failing.log"

  cat > "$work/build-failed.log" <<'LOG'
error: could not build Objective-C module 'HiveGhosttyC'
LOG

  sed 's/Executed 6 tests/Executed 0 tests/' "$work/passing.log" > "$work/no-match.log"

  check_verdict() {
    local label="$1" log="$2" want="$3"
    verdict="$(classify_run "$log")"
    if [ "$verdict" = "$want" ]; then
      echo "  OK: $label -> $verdict"
    else
      echo "  FAIL: $label -> $verdict, wanted $want" >&2
      got=1
    fi
  }

  check_verdict "a passing run" "$work/passing.log" survived
  check_verdict "a failing run" "$work/failing.log" caught
  check_verdict "a run truncated by a crash" "$work/truncated.log" no-measurement
  check_verdict "a tree that did not build" "$work/build-failed.log" no-measurement
  check_verdict "a filter that selected nothing" "$work/no-match.log" no-measurement
  rm -rf "$work"
  [ "$got" -eq 0 ] || die "the run classifier does not separate the three outcomes"
  echo "PASS: caught, survived and no-measurement are decided independently"
}

if [ "$SELF_CHECK" -eq 1 ]; then
  self_check
  exit 0
fi

probe() {
  local name="$1"
  local filter="$2"
  shift 2
  "$@"
  ! git -C "$REPO_ROOT" diff --quiet -- "$TARGET" \
    || die "$name: the mutation changed nothing"
  expect_failure "$name" "$filter"
  restore
}

probe row-fills-window testDenseScreenFillsEveryWindowWidthItIsGiven \
  delete_from_anchor "mainRow.distribution = .fill" 0

probe document-fills-viewport-width testDenseScreenFillsEveryWindowWidthItIsGiven \
  delete_from_anchor "screenHost.widthAnchor.constraint(" 1

probe window-bounds-the-row testDenseScreenScrollsInsideTheRequestedWindowSize \
  delete_from_anchor "mainRow.bottomAnchor.constraint(equalTo: root.bottomAnchor)" 0

probe document-height-floor testSparseScreenFillsItsViewportWithoutManufacturingScroll \
  delete_from_anchor "            screenHost.heightAnchor.constraint(" 1

probe live-run-height-ceiling testLiveRunFillsItsViewportWithoutManufacturingScroll \
  delete_from_anchor "liveRunHeightCeiling = screenHost.heightAnchor" 1

probe panel-fills-document testSparseScreenFillsItsViewportWithoutManufacturingScroll \
  delete_from_anchor "panel.bottomAnchor.constraint(equalTo: screenHost.bottomAnchor)," 0

probe scroll-reset-on-route-change testDenseScreenScrollsInsideTheRequestedWindowSize \
  replace_unique "if routeChanged {" "if true {"

probe divider-vertical-hugging testVisibleWindowKeepsItsRequestedSizeAfterLayout \
  delete_from_anchor "separator.setContentHuggingPriority(.defaultLow, for: .vertical)" 0

target "$PANEL"
probe screen-content-fills-width testDenseScreenFillsEveryWindowWidthItIsGiven \
  replace_unique "equalTo: trailingAnchor, constant: -contentInset" \
    "lessThanOrEqualTo: trailingAnchor, constant: -contentInset"

echo "PASS: every shell layout regression failed when its constraint was removed"
