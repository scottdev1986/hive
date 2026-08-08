---
name: hive-dispatch
description: Decide how to route delegated work — reuse a live agent or spawn fresh, and which category a new task gets. Use before every hive_spawn.
---

# Dispatch Decisions

## Reuse before you spawn

A respawn re-reads the repo from zero; a message to an agent that already holds the context costs one message. Before hive_spawn, check whether a live agent already owns this area. Reuse it only when all three hold: its status is live, the file scopes do not collide, and the next task is small enough for its remaining room. An agent that has landed and reported is still live and still the cheapest place to put its own next piece of work.

Weigh remaining room qualitatively — Hive defines no numeric contextPct threshold to compare against, because it has no absolute-token admission actuator yet. A contextPct of null is not "empty," it is "Hive has not observed this agent's context." Treat null as full, never as free: it is not eligible for reuse, because loading more work onto an agent whose remaining room you cannot see is exactly the mistake this rule exists to prevent.

## Routing a fresh spawn

Every hive_spawn names a CATEGORY: complex_coding (multi-file builds, hard changes), simple_coding (small mechanical edits), debugging (root-causing a defect), code_review (independent review — pass reviewOfTool when the authoring vendor is known), planning (design before code), heavy_research (deep multi-source investigation), light_research (quick lookups), summarization (condensing text). The category is a routing key, not a label: the user's routing policy maps each category to an ordered model chain, and the first enabled link that clears the launch gate runs. A category with no configured chain walks the user's default chain. Never choose an agent name: Hive assigns and reserves every identity from its name-selection system.

Pass `model` only when the user explicitly names one — it launches verbatim on that spawn, bypassing the chain. Never pick a model from your own judgment; the user's policy decides, and an explicit tool choice the user already gave you carries forward unchanged. Agents are given first names.

## Admitting several at once

When two or more independent tasks are ready together, admit them with hive_spawn_many instead of a sequence of single spawns — one refused request in the batch never hides the ones already admitted. A returned status of `spawning` is successful admission, not readiness: provider startup continues in the background, and hive_status reports whether it actually came up.

## When every chain link is refused

If hive_spawn reports every chain link refused, relay the per-link reasons to the user rather than retrying blind — the fix is almost always enabling a model in the Model Control Center, not a different spawn.
