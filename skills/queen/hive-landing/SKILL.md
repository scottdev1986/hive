---
name: hive-landing
description: Decide when to spawn an integrator, and what a hive_land refusal or re-arm request actually means. Use when a writer reports landing, escalates a conflict, or a re-arm approval reaches you.
---

# Landing Decisions

Writer agents land their own finished work through hive_land: commit, rebase the primary checkout's current branch, rerun this repository's verification, then call hive_land. The daemon performs the capability-gated fast-forward merge — this is the only sanctioned path onto the primary branch, and the landing protocol is in every writer's spawn prompt, so do not restate it to a writer who already has it. hive_land reruns the harvested verification command when one is recorded in memory and still declared in the tree (package.json, Makefile, AGENTS.md, AGENT_STANDARDS.md). It does not invent bun, typecheck, or format:check. A green run promotes that command into a generic AGENT_STANDARDS.md; a custom file is left alone unless it already declares a Verification section. Learn what "green" means from this repo — AGENT_STANDARDS.md, AGENTS.md, its scripts, Hive memory — never from a compiled-in toolchain.

## A rebase conflict is never yours to resolve

A writer that hits a rebase conflict aborts the rebase and reports the conflicting files — it does not guess at a resolution, and neither do you. Two agents touching the same code is real information; spawn an integrator to inspect both sides and land the correct result. Never merge, inspect, or edit a worker's worktree yourself, and never let unmerged work be silently discarded because nobody was assigned to reconcile it.

## When to spawn an integrator

Spawn one only for: a writer's escalated rebase conflict, a hive_kill result reporting stranded or preserved work with an unmerged branch, or any other concrete report of unmerged work nobody owns. Do not spawn one speculatively — most landings need no integrator at all, because a clean rebase and a green retest are how hive_land is meant to succeed on the first call.

## Reading a landing refusal

hive_land spends a one-shot grant per call. When Hive reports the grant already spent, that is not automatically a dead end — a rebased branch with real, retested work re-arms on Hive's own evidence, and only a genuinely stuck case (the target moved further, readiness was unreadable, no branch is recorded, or the automatic re-arm budget is exhausted) files an approval for you to decide. If it names a moved target, the fix is a further rebase and retest, not a re-arm; grant the re-arm only when rebasing again is not the actual remedy.

## Closing out

Once an agent's work is merged — or it never had any to land — close it. A landed branch and an empty one both mean there is nothing left for that identity to hold.
