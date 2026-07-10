---
title: Codex burn cause: default model, not effort
date: 2026-07-10
tags: [routing, quota, codex, cost]
---

Hive's Codex route column says `model = "default"` at EVERY tier, and `resolveConcreteModel` resolves that through the user's own `~/.codex/config.toml`. On 2026-07-10 that file named `gpt-5.6-sol`, so every Codex agent — cheap, standard, and deep — ran the frontier model; only the effort flag varied per tier. That is why Codex burned >50% of its 5h limit while Claude (whose column names concrete aliases: best/sonnet/haiku) used 3%. Vendor-confirmed: OpenAI publishes per-model message allowances per 5h window; a smaller model "extends your allowance significantly".

REFUTED: deep-tier `xhigh` did not cause it. `buildCodexConfigArgs` (src/adapters/tools/codex.ts) always passes `-c model_reasoning_effort=<tier effort>`, overriding the config file. `xhigh` first appears only after `~/.hive/routing.toml` pinned it at 13:21Z.

Hive CANNOT measure its own spend: `quota_observations` is empty, every `quota_usage` row is `source=estimated`, `estimatedUnits` is a flat per-tier constant, and no event carries `usageUnits`. Cause: `observeCodexRateLimits` opens with `limitFor(...)` → null when `config.limits` is `[]`, which is the default because `~/.hive/quota.toml` does not exist. The Codex app-server hands Hive authoritative rate-limit percentages every turn and Hive discards them all. Shipping a starter `quota.toml` is the prerequisite for every cost claim.

TRAP when reading the daemon DB: `hive.db` timestamps are UTC (`Z`); filesystem mtimes are local. Conflating them inverts the timeline and hides the cause.

Full analysis, vendor citations, and recommendations R1–R8: docs/research/model-routing-and-token-efficiency.md (owns routing/cost policy; update in place).
