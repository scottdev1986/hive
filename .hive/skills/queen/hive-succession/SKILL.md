---
name: hive-succession
description: Capture run state with hive_run_checkpoint, and know what a fresh boot as a backup generation must do before anything else. Use at semantic boundaries and immediately on waking as a backup.
---

# Succession and Checkpoints

## When a checkpoint is required versus merely requested

Four boundaries make a checkpoint requested: a task completes, a gate moves, run control acts, or a promotion lands. Three make it required, meaning skipping it is already the failure it exists to prevent: repeated failure on the same subgoal, a provider compaction event, or an unknown-context event. Write it at the boundary that triggered it, not after — a checkpoint written late has already lost the state it was meant to capture.

hive_run_checkpoint takes the event, your measured context usage (or an explicit unknown — never a guess), your compact-versus-replace decision, and a short written layer in your own words; the daemon fills in the snapshot, pending messages, and hierarchy references, and assigns the revision and digest itself. hive_run_checkpoint_get reads back the latest checkpoint, or one exact revision, and reports absence or a digest mismatch as an explicit state rather than silently returning nothing.

## Why an early checkpoint matters

hive_spawn refuses to admit new work while your context usage is unmeasured and no verified checkpoint exists — unknown usage is never treated as free room. Measured usage still refuses admission if resident tokens, the estimated remaining control work, and the handoff reserve together would exceed the absolute ceiling. Either way the fix is the same: checkpoint now, at whatever boundary you are at, rather than pushing more work through first. An early first checkpoint is what keeps you able to admit anything at all.

## Booting as a backup generation

If you ever boot as a backup generation, your recovery brief names the succession that produced you, the live-agent snapshot Hive observed at recovery time, and a numbered list of required recovery actions — follow that list as given, not from memory, since which tools it requires you to re-read has changed before and will again. Treat the snapshot as a starting point, not current truth, and do not duplicate or restart any agent's work before confirming it needs restarting. The daemon records each re-read and gates every other tool until the brief's whole list is done. If the brief names a verified RunCheckpoint, check what you re-read against it, and where the two disagree, what you measure now is true — the disagreement itself stays on the record as a contradiction, not a thing to paper over.

Only then attest: hive_succession_attest with the exact succession id, your generation, and the checkpoint digest from your recovery brief (or null when the brief declared no checkpoint existed). Your other tools stay gated until that attestation lands. After attesting, run hive_run_bootstrap when the brief says reconstruction is required — that is the sanctioned path back from a missing or contradicted checkpoint, never the agent table alone.
