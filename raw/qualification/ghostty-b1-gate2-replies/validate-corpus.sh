#!/bin/sh
set -eu

artifact_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
proof="$artifact_dir/live-proof.jsonl"

jq -s -e '
  ([.[] | select(.kind == "query")]
    | length > 0
      and all(.expected_nonempty == true
        and .expected_hex != ""
        and .callback_count == 1
        and .callback_hex == [.expected_hex]
        and .exact_once == true))
  and ([.[] | select(.kind == "ordered_burst")]
    | length > 0
      and all(.callback_count == (.names | length)
        and .callback_hex == .expected_callback_hex
        and .in_order_exact_once == true))
  and ([.[] | select(.kind == "silence_policy")]
    | length > 0
      and all(.callback_count == 0
        and .positive_control_exact_once == true
        and .pass == true))
  and ([.[] | select(.kind == "vendor_corpus")]
    | length == 3
      and all(.callback_count == (.expected_callback_hex | length)
        and .callback_hex == .expected_callback_hex
        and .exact_once_in_order == true
        and .positive_control_exact_once == true))
  and ([.[] | select(.kind == "summary")]
    | length == 1
      and all(.query_count == .exact_once_query_count
        and .vacuous_query_count == 0
        and .ordered_burst_pass == true
        and .silence_policy_count == .silence_policy_pass_count
        and .vendor_corpus_count == .vendor_corpus_pass_count
        and .all_pass == true))
' "$proof" >/dev/null

(
  cd "$artifact_dir"
  shasum -a 256 -c evidence-sha256.txt
)

printf '%s\n' 'Gate 2 corpus: PASS'
