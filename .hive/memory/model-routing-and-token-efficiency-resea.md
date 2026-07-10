---
title: Model routing and token efficiency research (2026-07)
date: 2026-07-10
tags: [routing, quota, cost, models, research]
---

Completed research lives at `docs/research/model-routing-and-token-efficiency.md`; the verified per-CLI model-selection mechanics live at `docs/model-selection.md`. Do not re-run either; read the docs. The research doc's time-sensitive assumptions section (dated 2026-07-10) lists exactly what to re-verify (prices, Codex unentitled-model failure behavior).

Durable routing principles:
- The orchestrator classifies on five dimensions (risk, complexity, uncertainty, context load, tool-use intensity); tier = worst dimension, not the average.
- Deep stays frontier (Opus 4.8 default; Fable 5 only by explicit pin); standard/cheap/review move down one provider price band (Sonnet 5/Terra; Haiku/Luna) — the biggest cost lever is stopping routine work from silently resolving onto frontier models (Codex `default` resolves to gpt-5.6-sol @ xhigh from ~/.codex/config.toml).
- Effort is a bigger intra-model lever than most model swaps; escalate one tier at a time on failure (max 2 bumps), de-escalate mechanical follow-ups; prefer resume over respawn (cache); prefer one well-briefed agent over fan-out on sequential work.
- Model selection now has two Hive knobs: `~/.hive/routing.toml` per tier (deep is pinned to claude-opus-4-8 since 2026-07-10, resolving the "can't open a 4.8 terminal" incident), and `hive_spawn`'s optional `model` field (landed b8042a3) — a user-directive pass-through, launched verbatim, vendor-bound for quota, never silently substituted (Fable→Opus valve excluded). Orchestrators: pass model only when the user names one.
- Claude CLI verified (2.1.206): `--model` accepts concrete IDs and aliases (`claude-opus-4-8`, `opus`, `opus[1m]`, `best`→Fable, `sonnet`, `haiku`); `--effort <low..max>` is a real launch flag; zero-cost account model enumeration via stream-json initialize control request. Never probe with guessed subcommands (billable). Codex (0.144.0): `-m/--model`, `-c model_reasoning_effort=...`.
- Keep the deterministic resolver scoring headroom only — cost-optimality lives in the routing table, not a runtime price model.

Implementation recommendation, remaining: R1 ship a starter quota.toml (quota routing is inert while `limits` is empty — highest-leverage change); R2 generalize the Fable→Opus valve into per-tier downshift chains; R3 add effort to ClaudeRouteSchema (both halves verified: `--effort` flag + per-model supportsEffort discovery); R4 mid-tier Codex defaults with launch-failure fallback to "default"; R5 fold the classification rubric into ORCHESTRATOR_BRIEF; R6 propose-not-apply estimate calibration. Rollout: measure → route (config-revertible) → learn.
