#!/bin/sh
set -eu

artifact_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
proof="$artifact_dir/live-proof.jsonl"

jq -s -e '
  ([.[] | select(.kind == "metadata")]
    | length == 1
      and all(.clipboard_read_config_policy == "deny"
        and .config_diagnostics_count == 0
        and .host_read_callback_positive_control == "paste_from_clipboard"
        and .host_read_callback_positive_control_action_result == false
        and .host_read_callback_positive_control_delta == 1))
  and ([.[] | select(.kind == "query")]
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
      and all(. as $record
        | $record.callback_count == 0
          and $record.callback_hex == []
          and $record.positive_control_input_hex == "1b5b63"
          and $record.positive_control_callback_hex == ["1b5b3f36323b323263"]
          and $record.positive_control_exact_once == true
          and ($record.required_event == null
            or ($record.event_types | index($record.required_event)) != null)
          and $record.pass == true))
  and ([.[] | select(.kind == "silence_policy" and .host_read_callback_must_stay_flat == true)]
    | length == 2
      and all(.host_read_callback_count == 0))
  and ([.[] | select(.kind == "silence_policy"
      and (.name == "OSC 52 clipboard write denied"
        or .name == "OSC 52 clipboard clear denied"))]
    | length == 2
      and all(.required_event == 5 and (.event_types | index(5)) != null))
  and ([.[] | select(.kind == "disabled_policy")]
    | length == 1
      and all(.callback_count == 0
        and .callback_hex == []
        and .enabled_positive_control_callback_hex == ["1b5b3f36323b323263"]
        and .enabled_positive_control_exact_once == true
        and .pass == true))
  and ([.[] | select(.kind == "vendor_corpus")]
    | length == 3
      and all(.callback_count == (.expected_callback_hex | length)
        and .callback_hex == .expected_callback_hex
        and .exact_once_in_order == true
        and .positive_control_callback_hex == ["1b5b3f36323b323263"]
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
