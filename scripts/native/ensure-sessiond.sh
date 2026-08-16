#!/bin/sh
# Makes native/sessiond/zig-out/bin/hive-sessiond present and current before
# anything that needs it runs, and names on stderr which of three states it
# found: current, MISSING, or STALE.
#
#   ensure-sessiond.sh [root]            build if missing or stale, then report
#   ensure-sessiond.sh --check [root]    report only; never builds
#
# Exit: 0 current (or built), 2 make could not answer, 3 missing, 4 stale,
# 5 the build failed. The three "cannot run" causes get three exit codes and
# three messages because a caller that collapses them costs a diagnosis: a
# sessiond-backed test that never reached the wire fails in single-digit
# milliseconds and looks exactly like a logic failure in the log.
#
# --check exists for callers that must not build the tree they are pointed at:
# docs/qa/rig.sh runs against a source root that may be a frozen build or
# another agent's checkout, so it refuses by name instead of repairing it.
#
# FRESHNESS, NOT PRESENCE. `make -q` answers "is this file up to date?" against
# the Makefile's own SESSIOND_INPUTS prerequisite list without building
# anything. Asking make means there is one declaration in this repository of
# what hive-sessiond is built from; a second list here would drift from the
# rule that actually rebuilds. The comparison is therefore mtime, like every
# other rule in that Makefile. A content digest would need a manifest of its
# own and would be a second authority that can disagree with the rule doing the
# work. mtime's known weakness -- a checkout that moves a timestamp without
# changing bytes -- costs one cache-warm rebuild and never a false pass, and a
# false pass is precisely the failure this gate exists to delete.
set -u

CHECK=0
if [ "${1:-}" = "--check" ]; then
  CHECK=1
  shift
fi
ROOT=${1:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)}
# make sets CURDIR from getcwd(), so the target has to be spelled the physical
# way $(SESSIOND_BIN) expands to or it matches no rule.
ROOT=$(CDPATH= cd -- "$ROOT" && pwd -P) || {
  echo "sessiond: UNKNOWN -- no such source root: $ROOT" >&2
  exit 2
}
BIN="$ROOT/native/sessiond/zig-out/bin/hive-sessiond"

if [ ! -x "$BIN" ]; then
  STATE=missing
  REASON="MISSING -- no executable at $BIN"
else
  make -C "$ROOT" -q "$BIN" >/dev/null 2>&1
  case $? in
    0)
      STATE=current
      ;;
    1)
      STATE=stale
      # Diagnostic text only: make already decided, and this just names the
      # first few culprits. Staleness can also come from inputs outside these
      # paths, in which case the list is empty and the message says so.
      newer=$(find "$ROOT/native/sessiond/src" \
        "$ROOT/native/sessiond/build.zig" \
        "$ROOT/native/sessiond/build.zig.zon" \
        -type f -newer "$BIN" 2>/dev/null | head -3 | tr '\n' ' ')
      [ -n "$newer" ] || newer="a build input outside native/sessiond/src"
      REASON="STALE -- $BIN is older than: $newer"
      ;;
    *)
      echo "sessiond: UNKNOWN -- make could not evaluate $BIN in $ROOT" >&2
      exit 2
      ;;
  esac
fi

if [ "$STATE" = current ]; then
  echo "sessiond: current -- $BIN ($(/usr/bin/stat -f %z "$BIN") bytes, built $(/usr/bin/stat -f %Sm "$BIN")); a sessiond failure after this line ran against a current binary" >&2
  exit 0
fi

if [ "$CHECK" -eq 1 ]; then
  echo "sessiond: $REASON" >&2
  [ "$STATE" = missing ] && exit 3
  exit 4
fi

echo "sessiond: $REASON -- building it with 'make sessiond'" >&2
if ! make -C "$ROOT" sessiond >&2; then
  echo "sessiond: BUILD FAILED -- 'make sessiond' in $ROOT did not produce a current $BIN; whatever runs after this line did not run against sessiond at all" >&2
  exit 5
fi
echo "sessiond: built -- $BIN ($(/usr/bin/stat -f %z "$BIN") bytes)" >&2
