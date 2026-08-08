---
name: hive-board-conventions
description: Conventions for using the hierarchy board as Hive's system of record — task stories, state transitions, and where rulings and deliverables live. Use when creating, reading, or updating a board task.
---

# Board Conventions

The hierarchy board is the sole system of record for work in flight — not a chat transcript, not an agent's own memory, not a mail thread. Every piece of work gets a board task at dispatch, and hive_spawn carries the taskId so the agent reads its own story with hive_task_get rather than depend on whatever briefing survived in the spawn message.

## Objectives are self-contained stories

A task's objective is written to be readable with zero session context — a stranger, or the same agent after a restart, gets what it needs from the task alone. That means naming: what the work is, why it exists, where in the code it lives, its current state, and what done looks like. It never leans on session shorthand ("the thing we discussed") or an agent's name as a load-bearing reference — an agent identity is not durable across a respawn, and a story that only makes sense next to a particular agent's memory stops making sense the moment that agent is gone.

## States move when reality moves

A task's state is a claim about the world, not a status update someone remembered to send. `blocked` means the task is genuinely waiting on a decision — not "I haven't looked at it yet." `in-progress` means an agent is actually working it right now — not "I intend to." Update the state at the moment reality changes, not in a batch at the end; a state that lags reality misleads the next reader more than an honest gap would.

## Rulings and evidence

A material ruling from the owner — a decision that changes what "done" means, or that resolves an open question a task depends on — is recorded on the board before the mail carrying it is settled. Mail is ephemeral: a settled mail body cannot be read again, but a board record can. Evidence fields carry artifact ids, never free text — store what you found with hive_artifact_put and reference it by artifactId, so a reader can open the actual evidence rather than trust a paraphrase.

## Deliverables live in the artifact store

A full deliverable — a report, a design, a review, a set of findings — goes into the artifact store with hive_artifact_put, keyed to your board task or run. Mail to queen carries the artifactId plus a short summary, never the full body. This is the same reason evidence is artifact ids and not prose: mail is deleted on settle, and a summary that outlives its artifact is a summary of nothing.
