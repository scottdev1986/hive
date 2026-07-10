# AgentHost crash outcome matrix

This is deterministic process-level evidence. Every row launches separate simulated UI, broker, AgentHost, and provider processes; the named target receives `SIGKILL` at the named boundary. Claude and Codex fixtures use their own profile names but share the provider-neutral contract. Live installed-provider evidence is recorded separately in `live-providers.json`.

| Provider | Killed | Boundary | Outcome | Prompt / approval / tool executions | Forbidden result |
|---|---|---|---|---:|---|
| claude | ui | before_accept | replayed_known_state | 1 / 1 / 1 | none |
| claude | ui | after_accept_before_write | replayed_known_state | 1 / 1 / 1 | none |
| claude | ui | after_write_before_first_event | replayed_known_state | 1 / 1 / 1 | none |
| claude | ui | during_tool_approval | replayed_known_state | 1 / 1 / 1 | none |
| claude | ui | after_provider_final_before_wal | replayed_known_state | 1 / 1 / 1 | none |
| claude | ui | after_wal_before_broker_ack | replayed_known_state | 1 / 1 / 1 | none |
| claude | broker | before_accept | replayed_known_state | 1 / 1 / 1 | none |
| claude | broker | after_accept_before_write | replayed_known_state | 1 / 1 / 1 | none |
| claude | broker | after_write_before_first_event | replayed_known_state | 1 / 1 / 1 | none |
| claude | broker | during_tool_approval | replayed_known_state | 1 / 1 / 1 | none |
| claude | broker | after_provider_final_before_wal | replayed_known_state | 1 / 1 / 1 | none |
| claude | broker | after_wal_before_broker_ack | replayed_known_state | 1 / 1 / 1 | none |
| claude | host | before_accept | replayed_known_state | 1 / 1 / 1 | none |
| claude | host | after_accept_before_write | UNKNOWN_OUTCOME | 0 / 0 / 0 | none |
| claude | host | after_write_before_first_event | clean_vendor_resume | 1 / 1 / 1 | none |
| claude | host | during_tool_approval | clean_vendor_resume | 1 / 1 / 1 | none |
| claude | host | after_provider_final_before_wal | clean_vendor_resume | 1 / 1 / 1 | none |
| claude | host | after_wal_before_broker_ack | replayed_known_state | 1 / 1 / 1 | none |
| claude | provider | before_accept | replayed_known_state | 1 / 1 / 1 | none |
| claude | provider | after_accept_before_write | UNKNOWN_OUTCOME | 0 / 0 / 0 | none |
| claude | provider | after_write_before_first_event | clean_vendor_resume | 1 / 1 / 1 | none |
| claude | provider | during_tool_approval | clean_vendor_resume | 1 / 1 / 1 | none |
| claude | provider | after_provider_final_before_wal | clean_vendor_resume | 1 / 1 / 1 | none |
| claude | provider | after_wal_before_broker_ack | replayed_known_state | 1 / 1 / 1 | none |
| codex | ui | before_accept | replayed_known_state | 1 / 1 / 1 | none |
| codex | ui | after_accept_before_write | replayed_known_state | 1 / 1 / 1 | none |
| codex | ui | after_write_before_first_event | replayed_known_state | 1 / 1 / 1 | none |
| codex | ui | during_tool_approval | replayed_known_state | 1 / 1 / 1 | none |
| codex | ui | after_provider_final_before_wal | replayed_known_state | 1 / 1 / 1 | none |
| codex | ui | after_wal_before_broker_ack | replayed_known_state | 1 / 1 / 1 | none |
| codex | broker | before_accept | replayed_known_state | 1 / 1 / 1 | none |
| codex | broker | after_accept_before_write | replayed_known_state | 1 / 1 / 1 | none |
| codex | broker | after_write_before_first_event | replayed_known_state | 1 / 1 / 1 | none |
| codex | broker | during_tool_approval | replayed_known_state | 1 / 1 / 1 | none |
| codex | broker | after_provider_final_before_wal | replayed_known_state | 1 / 1 / 1 | none |
| codex | broker | after_wal_before_broker_ack | replayed_known_state | 1 / 1 / 1 | none |
| codex | host | before_accept | replayed_known_state | 1 / 1 / 1 | none |
| codex | host | after_accept_before_write | UNKNOWN_OUTCOME | 0 / 0 / 0 | none |
| codex | host | after_write_before_first_event | clean_vendor_resume | 1 / 1 / 1 | none |
| codex | host | during_tool_approval | clean_vendor_resume | 1 / 1 / 1 | none |
| codex | host | after_provider_final_before_wal | clean_vendor_resume | 1 / 1 / 1 | none |
| codex | host | after_wal_before_broker_ack | replayed_known_state | 1 / 1 / 1 | none |
| codex | provider | before_accept | replayed_known_state | 1 / 1 / 1 | none |
| codex | provider | after_accept_before_write | UNKNOWN_OUTCOME | 0 / 0 / 0 | none |
| codex | provider | after_write_before_first_event | clean_vendor_resume | 1 / 1 / 1 | none |
| codex | provider | during_tool_approval | clean_vendor_resume | 1 / 1 / 1 | none |
| codex | provider | after_provider_final_before_wal | clean_vendor_resume | 1 / 1 / 1 | none |
| codex | provider | after_wal_before_broker_ack | replayed_known_state | 1 / 1 / 1 | none |

Result: 48 rows; 32 replayed known state, 12 clean vendor resumes, 4 explicit unknown outcomes. No forbidden result occurred.

`UNKNOWN_OUTCOME` is expected when an accepted command loses its host or provider before any vendor session exists. The harness never retries that prompt. Before acceptance, a replacement broker may issue a new command only after reconnect proves no `ACCEPTED` record exists.
