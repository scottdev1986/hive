#!/usr/bin/env bash
# Proves seed-dense-routes.sh cannot be redirected by repointing the caller's
# HIVE_HOME symlink after the guard has already accepted it.
#
#   qa/seed-dense-routes-isolation-probe.sh
#
# A stand-in CLI replaces the real one, so nothing here talks to a daemon. It
# repoints the symlink during the first call and records the home each later
# call actually saw; the probe fails if any of them saw the replacement.
set -euo pipefail

work=$(mktemp -d /tmp/hvqa-probe-XXXXXX)
# The decoy sits under a prefix the guard rejects, while the real home sits
# under one it accepts. Observing the decoy therefore means the guard was
# bypassed outright, not that one acceptable home was swapped for another.
decoy=$(mktemp -d /tmp/hv-probe-decoy-XXXXXX)
real="$work/qa-home"
link="$work/link"
seen="$work/homes-seen"
mkdir -p "$real"
ln -sfn "$real" "$link"
: > "$seen"
trap 'rm -rf "$work" "$decoy"' EXIT

mkdir -p "$work/fake/src"
cat > "$work/fake/src/cli.ts" <<'FAKE'
// Records the home this invocation actually resolved to, then — on the first
// call only — repoints the caller's symlink at the decoy. A script that hands
// its CLI the original symlink name will observe the decoy from the next call
// onward; one that pins the resolved path never can.
import { appendFileSync, symlinkSync, unlinkSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";

const seen = process.env.PROBE_SEEN!;
const decoy = process.env.PROBE_DECOY!;
const link = process.env.PROBE_LINK!;
appendFileSync(seen, realpathSync(process.env.HIVE_HOME!) + "\n");

if (readFileSync(seen, "utf8").trim().split("\n").length === 1) {
  unlinkSync(link);
  symlinkSync(decoy, link);
}

if (process.argv.includes("export")) {
  const candidates = Array.from({ length: 40 }, (_, i) => ({ model: `m${i}` }));
  process.stdout.write(JSON.stringify({ revision: 1, global: { candidates } }));
}
FAKE

set +e
PROBE_SEEN="$seen" PROBE_DECOY="$decoy" PROBE_LINK="$link" \
  HIVE_HOME="$link" \
  "$(dirname "$0")/seed-dense-routes.sh" --port 9999 --src-root "$work/fake" \
  > "$work/run.log" 2>&1
status=$?
set -e

decoy_real=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$decoy")
calls=$(wc -l < "$seen" | tr -d ' ')

echo "stand-in CLI calls: $calls"
echo "homes observed:"
sort -u "$seen" | sed 's/^/  /'

# Fail closed: an empty log means the calls never happened and the probe proved
# nothing, so too few calls is a failure rather than a silent pass.
if [[ "$calls" -lt 2 ]]; then
  echo "PROBE INCONCLUSIVE: expected at least 2 CLI calls, saw $calls" >&2
  cat "$work/run.log" >&2
  exit 1
fi
if grep -qxF "$decoy_real" "$seen"; then
  echo "PROBE FAILED: a call observed the swapped decoy $decoy_real" >&2
  exit 1
fi
if [[ "$status" -ne 0 ]]; then
  echo "PROBE FAILED: seeding script exited $status" >&2
  cat "$work/run.log" >&2
  exit 1
fi
echo "PROBE PASSED: the symlink was repointed mid-run and no call observed the decoy"
