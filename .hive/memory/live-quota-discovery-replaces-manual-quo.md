---
title: Live quota discovery replaces manual quota.toml pools
date: 2026-07-10
tags: [quota, routing, providers]
---

Landed 8467daa. Hive now reads real account limits from the providers themselves at every daemon start; `~/.hive/quota.toml` is an optional labelled override and is never required.

**Surfaces** (verified by driving the binaries, both non-billable and session-free — see `docs/research/provider-quota-surfaces.md`):
- Codex: `codex app-server --stdio` → JSON-RPC `initialize` → `initialized` → `account/rateLimits/read`. Stable protocol → `authoritative`. Push updates via `account/rateLimits/updated`.
- Claude: `control_request{subtype:"get_usage"}` on `claude -p --input-format stream-json --output-format stream-json`. Self-described experimental → `reported`. Costs $0; no user message is ever sent.

**Key design fact:** providers report only the *fraction of a window consumed*, never its absolute size. Discovered pools are therefore percent-denominated with allowance = 100 by construction. A manual override is denominated in the operator's units and the provider's percentages are scaled onto it. Reservations use hive-authored percent estimates (`estimatesPct`), separate per window because a run is a big slice of five hours and a small slice of a week.

**Fixed maya's discard path:** `observeCodexRateLimits` and `observeStatusline` began with `limitFor(...)`, which returned null when `config.limits` was `[]`, so authoritative percentages were dropped on every turn. Both now discover the pool from the payload instead.

**Three accounting bugs caught in adversarial review, each with a regression test in `src/daemon/quota-discovery.test.ts`:**
1. `usageTotals` used one row-level observation cutoff for both windows, swallowing weekly spend recorded between an older weekly reading and a newer five-hour one (→ overcommit). Now takes per-window cutoffs.
2. `reconcile` committed the five-hour estimate to the weekly ledger, overstating weekly spend ~5x for percent pools (→ premature spawn refusal). `quota_usage` gained a `weeklyUnits` column.
3. `orderRateLimitWindows` sorted an undated window last, misfiling the dated window beside it into the wrong bucket. Undated windows are now dropped.

**Invariant to preserve:** unknown renders as `unknown`, never `0`. A window with no observation, or one whose reset boundary passed, reports `used: null` and routes in compatibility mode rather than reserving against a number nobody measured. Refresh is forced at startup, runs on the maintenance tick when the interval lapses or a reset blinds a pool, and skips a provider whose free feeds (app-server notifications, statusLine) already keep it live — Claude's usage endpoint 429s under polling.
