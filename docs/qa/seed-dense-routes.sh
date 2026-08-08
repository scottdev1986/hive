#!/usr/bin/env bash
# Seeds ~40 distinct route candidates onto a QA daemon's `global` route, so a
# live Task Router screen carries the same density as the dense fixture corpus
# in workspace/Tests/WorkspaceCoreTests/Fixtures-dense. Without it the live
# walk shows a handful of rows and the pileup density exposes never appears.
#
#   HIVE_HOME=/tmp/hvqa-<name> qa/seed-dense-routes.sh --port <port> [--src-root <repo>]
#
# The write goes through `routing set-route`, the same compare-and-set path the
# Task Router's Apply button uses: read the revision, present it back, and let
# the daemon reject a stale write rather than clobber a concurrent one.
set -euo pipefail

PORT=""
SRC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --src-root) SRC_ROOT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$PORT" ]] || {
  echo "usage: seed-dense-routes.sh --port <port> [--src-root <repo>]" >&2
  exit 2
}

# The write lands on whichever daemon holds the credential in HIVE_HOME, so any
# home outside the QA scratch namespace is refused. Forty synthetic routes in
# the dev or prod daemon would be a live routing change, not a test. The name
# is resolved before it is matched: a symlink called /tmp/hvqa-something can
# point at the user's own home, and only the resolved path shows that.
[[ -n "${HIVE_HOME:-}" ]] || {
  echo "HIVE_HOME must name the QA daemon's home (/tmp/hvqa-*)" >&2
  exit 2
}
resolved_home=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$HIVE_HOME")
case "$resolved_home" in
  /tmp/hvqa-*|/private/tmp/hvqa-*) ;;
  *) echo "refusing to seed non-QA home $HIVE_HOME (resolves to $resolved_home);" \
          "expected /tmp/hvqa-*" >&2
     exit 2 ;;
esac

# Every command below sees the path that was checked, not the name that was
# given. Handing the CLI the caller's original name would re-read the symlink
# at each invocation, so repointing it after the check above would send the
# write somewhere the check never approved.
export HIVE_HOME="$resolved_home"

hive_cli() { bun run "$SRC_ROOT/src/cli.ts" "$@" --port "$PORT"; }
policy_field() { python3 -c "import json,sys; print($1)"; }

revision=$(hive_cli routing export | policy_field 'json.load(sys.stdin)["revision"]')

# Five providers times eight models each. A route may not name the same target
# twice, so density has to come from distinct (provider, model) pairs rather
# than one candidate repeated.
providers=(claude codex grok kimi opencode)
candidates=()
for provider in "${providers[@]}"; do
  for n in 1 2 3 4 5 6 7 8; do
    candidates+=("$provider/qa-dense-$n@none=1")
  done
done

hive_cli routing set-route global user-weighted "${candidates[@]}" \
  --expect-revision "$revision" > /dev/null

# Both readings come back from the daemon rather than being assumed, so a write
# the daemon refused fails here instead of being reported as a success.
after=$(hive_cli routing export)
count=$(printf '%s' "$after" | policy_field 'len(json.load(sys.stdin)["global"]["candidates"])')
seeded=$(printf '%s' "$after" | policy_field 'json.load(sys.stdin)["revision"]')
echo "seeded $count candidates onto the global route (revision $revision -> $seeded)"
[[ "$count" -eq ${#candidates[@]} ]] || {
  echo "expected ${#candidates[@]} candidates, got $count" >&2
  exit 1
}
