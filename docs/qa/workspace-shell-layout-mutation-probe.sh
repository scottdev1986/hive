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

expect_failure() {
  local name="$1"
  local filter="$2"
  local log="$LOG_DIR/$name.log"
  ( cd "$REPO_ROOT/workspace" && swift test --filter "$filter" ) > "$log" 2>&1
  # A build error also exits non-zero, so the probe only counts when the suite
  # compiled and a named test case reported failure.
  grep -q "^Build complete!" "$log" \
    || die "$name: the mutated tree did not compile, so nothing was proven ($log)"
  grep -q "^Test Case .*$filter.* failed" "$log" \
    || die "$name: $filter still passed without the constraint it depends on ($log)"
  echo "PROBE BITES: $name -> $filter failed"
}

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
