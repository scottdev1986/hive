#!/bin/sh
set -eu

artifact_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
scratch_root=$(mktemp -d -t hive-gate2-mutations)
trap 'rm -rf "$scratch_root"' EXIT HUP INT TERM
failures=0

"$artifact_dir/validate-corpus.sh" >/dev/null

run_mutation() {
  mutation_name=$1
  jq_filter=$2
  case_dir="$scratch_root/$mutation_name"
  mkdir "$case_dir"
  cp -R "$artifact_dir"/. "$case_dir"
  jq -c "$jq_filter" "$case_dir/live-proof.jsonl" > "$case_dir/live-proof.new"
  mv "$case_dir/live-proof.new" "$case_dir/live-proof.jsonl"
  (
    cd "$case_dir"
    find . -maxdepth 1 -type f ! -name evidence-sha256.txt -print0 \
      | LC_ALL=C sort -z \
      | xargs -0 shasum -a 256 > evidence-sha256.txt
  )

  if "$case_dir/validate-corpus.sh" >/dev/null 2>&1; then
    printf '%s: FAIL (validator accepted mutation)\n' "$mutation_name"
    failures=$((failures + 1))
  else
    printf '%s: PASS (validator rejected mutation)\n' "$mutation_name"
  fi
}

run_mutation M2 'select(.kind != "disabled_policy")'
run_mutation M4 'if .kind == "silence_policy" then .positive_control_callback_hex = [] else . end'
run_mutation M5 'if .kind == "silence_policy" and (.name == "OSC 52 clipboard write denied" or .name == "OSC 52 clipboard clear denied") then .event_types |= map(select(. != 5)) else . end'

test "$failures" -eq 0
