# C3 context measurement

Measured 2026-07-24 from the running daemon's durable agent and message rows.
Only byte counts were read; task and message bodies were not copied into this
artifact.

## Bootstrap

The sample contains the 11 worker launch prompts retained by the daemon. The
authored-task size is the exact UTF-8 byte length of `agents.taskDescription`.
Hive-added size is the launch-prompt byte length minus that exact task.

| bytes | p50 | p90 | max |
|---|---:|---:|---:|
| exact authored task | 5,108 | 6,265 | 6,305 |
| Hive-added prompt | 14,500 | 16,836 | 17,845 |
| complete prompt | 19,157 | 22,031 | 23,371 |

Repeated Hive prose within every full-category writer bootstrap measured:

| block | bytes | estimated tokens |
|---|---:|---:|
| coding guidelines | 1,335 | 333 |
| Hive protocol rules | 1,108 | 275 |
| search hygiene | 477 | 119 |
| landing protocol | 1,954 | 485 |

The task-selected brief and graph sources already have purpose-level bounds of
12,000 and 6,000 characters respectively. The bootstrap diet therefore targets
the repeated landing and protocol prose, not the orchestrator-authored task or
its selected sources.

## Normal-message wakes

The sample contains 72 durable normal messages:

| UTF-8 body bytes | p50 | p90 | max |
|---|---:|---:|---:|
| normal message | 942 | 4,205 | 8,443 |

The existing memory wake delta has a separate 300-token bound. An 8 KiB normal
message-batch projection covers the measured common case while making the
single observed larger message exercise exact-source overflow retrieval.
