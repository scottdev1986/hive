#!/bin/bash
# scripts/qa/classify-swift-test-run.sh — the one reader of a `swift test` log.
#
#     scripts/qa/classify-swift-test-run.sh <log>          # prints one verdict
#     scripts/qa/classify-swift-test-run.sh --self-check   # proves the reader works
#
# Prints exactly one of: caught, survived, no-measurement.
#
#   caught          the run finished and reported failures
#   survived        the run finished and reported none
#   no-measurement  the run produced no evidence either way
#
# The three must never fold together. A survival claim says the code under test
# is unprotected; a crash says nothing at all. Reading the second as the first
# is how a dead test gets kept, and reading it as a pass is how a crashed suite
# gets reported green.
#
# WHY THIS IS THE ONLY DETECTOR. A `swift test` process that dies mid-run leaves
# no macOS crash report in this repo: Ghostty's GlobalState.init installs a
# process-wide breakpad exception handler inside the test process, so breakpad
# takes the mach exception port and the OS never files anything. Often nothing
# is printed either. The shape of the log is all the evidence there is.
#
# THE MISTAKE THIS EXISTS TO PREVENT. XCTest prints an "Executed N tests, with M
# failures" line per suite as well as once at the end. A crashed run has already
# printed a dozen green per-suite lines before it dies, so an unanchored grep
# for that text reports a dead process as a clean run. Only the AGGREGATE line —
# the one under `Test Suite 'All tests'` for a full run, or `Test Suite
# 'Selected tests'` under `--filter` — closes the accounting, and only its
# presence means the process lived long enough to say anything.

set -u

usage() {
  echo "usage: classify-swift-test-run.sh <log> | --self-check" >&2
  exit 2
}

# Reads one swift-test log and prints one verdict.
#
# no-measurement covers every way a run can fail to produce evidence: the tree
# did not build, the process died before XCTest closed its accounting, or the
# filter selected zero tests — a filter typo would otherwise read as survival.
classify_run() {
  local log="$1"
  # A log that is not there is a caller mistake, not a verdict. Answering
  # no-measurement for a mistyped path would make "you pointed at nothing" and
  # "the run died" indistinguishable, which is the same collapse this whole
  # script exists to prevent — one directory up.
  if [ ! -f "$log" ]; then
    echo "classify-swift-test-run: no such log: $log" >&2
    return 2
  fi
  # One gate decides everything: is there an aggregate accounting line? Only
  # that line is trusted. Per-suite lines are also printed, and summing them
  # would count the same tests two or three times over.
  #
  # There is deliberately no separate "did it build" check. A build failure
  # stops `swift test` before any test runs, so it cannot produce an aggregate
  # line, and it lands on no-measurement through this gate — the build-failed
  # fixture in the self-check proves that. A second gate for it read as a safety
  # net but could not be made to fail: mutating it away changed no verdict, and
  # a guard that cannot bite is a guard nobody can trust.
  local accounting
  accounting="$(grep -A 1 "^Test Suite '\(All\|Selected\) tests' \(passed\|failed\) at" "$log" \
    | grep -m 1 -E "Executed [0-9]+ test")"
  # The failure count is read as "the number in front of the word failure",
  # never as "the number after with". A run with skips says "with 14 tests
  # skipped and 3 failures", so anchoring on "with" reads the count as absent
  # and reports every real full-suite run — which always skips something — as
  # no measurement.
  local executed failures
  executed="$(printf '%s' "$accounting" | sed -n 's/.*Executed \([0-9][0-9]*\) test.*/\1/p')"
  failures="$(printf '%s' "$accounting" | sed -n 's/.*[^0-9]\([0-9][0-9]*\) failure.*/\1/p')"
  # An aggregate line that does not yield both numbers is an aggregate line this
  # script does not understand — a toolchain that changed its wording, most
  # likely. Refuse it rather than guess: a reader that half-parses a future
  # format is worse than one that says it cannot read it.
  if [ -z "$failures" ] || [ "$executed" -eq 0 ]; then
    echo no-measurement
    return
  fi
  if [ "$failures" -gt 0 ]; then
    echo caught
  else
    echo survived
  fi
}

# The classifier is a claim until it is exercised against logs of every shape.
# The truncated cases are the ones that matter: they are real passing runs cut
# off mid-suite, which is exactly what a crash leaves behind, and they must come
# back as no measurement rather than as the survival an unanchored read reports.
self_check() {
  local work verdict got=0
  work="$(mktemp -d -t classify-swift-test-run)" || exit 1

  # A genuine filtered run, in the format the tool actually emits.
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

  # A full run says 'All tests' where a filtered run says 'Selected tests'. The
  # agent-facing case is the full run, so it is covered in its own right rather
  # than assumed to follow from the filtered one.
  sed "s/Selected tests/All tests/g" "$work/passing.log" > "$work/full-passing.log"
  sed "s/Selected tests/All tests/g" "$work/failing.log" > "$work/full-failing.log"

  # The shape that motivated this script: a full run that died mid-suite after
  # several suites had already printed their own green accounting lines. An
  # unanchored grep for "Executed N tests, with M failures" matches those
  # per-suite lines and calls a dead process a clean run.
  cat > "$work/full-truncated.log" <<'LOG'
Build complete!
Test Suite 'All tests' started at 2026-08-18 10:38:12.001.
Test Suite 'AgentActivityTests' started at 2026-08-18 10:38:12.002.
Test Suite 'AgentActivityTests' passed at 2026-08-18 10:38:12.010.
	 Executed 5 tests, with 0 failures (0 unexpected) in 0.008 (0.008) seconds
Test Suite 'B23MouseModeMatrixTests' started at 2026-08-18 10:38:24.660.
Test Suite 'B23MouseModeMatrixTests' passed at 2026-08-18 10:38:26.243.
	 Executed 6 tests, with 0 failures (0 unexpected) in 1.583 (1.584) seconds
Test Suite 'B23PasteBoundaryMatrixTests' started at 2026-08-18 10:38:26.243.
Test Case '-[HiveTerminalKitTests.B23PasteBoundaryMatrixTests testPositiveControlDefaultStateIsUnbracketedThroughSameReader]' started.
LOG

  # Every real full-suite run of this repo skips something, and the accounting
  # line then reads "with N tests skipped and M failures". Synthetic logs
  # without skips all passed against a reader that could not parse that line at
  # all, so the skip-bearing shapes are fixtures in their own right.
  cat > "$work/skips-passing.log" <<'LOG'
Build complete!
Test Suite 'Selected tests' passed at 2026-08-18 11:19:33.100.
	 Executed 77 tests, with 1 test skipped and 0 failures (0 unexpected) in 13.964 (13.970) seconds
LOG

  cat > "$work/skips-failing.log" <<'LOG'
Build complete!
Test Suite 'All tests' failed at 2026-08-18 10:36:13.783.
	 Executed 801 tests, with 14 tests skipped and 3 failures (0 unexpected) in 97.706 (97.767) seconds
LOG

  # Swift toolchains have changed this wording before. An aggregate line that
  # announces itself but does not yield both numbers must refuse, not guess.
  cat > "$work/unknown-format.log" <<'LOG'
Test Suite 'All tests' failed at 2026-08-18 10:36:13.783.
	 Ran some tests, and some of them did not go well
LOG

  # Half-recognisable is the dangerous shape: a real count of tests alongside
  # failure wording this script cannot read. It must refuse, not read the run as
  # clean because it found no number.
  cat > "$work/no-failure-count.log" <<'LOG'
Test Suite 'All tests' passed at 2026-08-18 10:36:13.783.
	 Executed 6 tests, with no failures (0 unexpected) in 0.001 (0.002) seconds
LOG


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
  check_verdict "a passing full run" "$work/full-passing.log" survived
  check_verdict "a failing full run" "$work/full-failing.log" caught
  check_verdict "a full run crashed after green suites" "$work/full-truncated.log" no-measurement
  check_verdict "a passing run that skipped tests" "$work/skips-passing.log" survived
  check_verdict "a failing full run that skipped tests" "$work/skips-failing.log" caught
  check_verdict "an aggregate line this script cannot parse" "$work/unknown-format.log" no-measurement
  check_verdict "an aggregate line with no failure count" "$work/no-failure-count.log" no-measurement

  # A missing log must refuse rather than return a verdict, so it is checked on
  # exit status and silence instead of through check_verdict.
  local absent_out absent_status
  absent_out="$(classify_run "$work/absent.log" 2>/dev/null)"
  absent_status=$?
  if [ "$absent_status" -eq 2 ] && [ -z "$absent_out" ]; then
    echo "  OK: a log that does not exist -> refused, no verdict"
  else
    echo "  FAIL: a log that does not exist -> status $absent_status, printed '$absent_out'" >&2
    got=1
  fi
  rm -rf "$work"
  if [ "$got" -ne 0 ]; then
    echo "FAIL: the run classifier does not separate the three outcomes" >&2
    exit 1
  fi
  echo "PASS: caught, survived and no-measurement are decided independently"
}

case "${1:-}" in
  --self-check) [ "$#" -eq 1 ] || usage; self_check ;;
  "" | -*) usage ;;
  *) [ "$#" -eq 1 ] || usage; classify_run "$1" ;;
esac
