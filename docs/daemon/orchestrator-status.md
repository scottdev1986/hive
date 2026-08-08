# Orchestrator status

Updated: 2026-08-15
Source: Hive source tree, 2026-08-15

## Summary

The root orchestrator is named queen. It has no row in the `agents` table, so it has no `status` column to read — and for months the Workspace papered over that by inventing a status word in Swift, which the UI correctly degraded to "unknown", leaving the root's dot gray forever. The fix was not to give the root a fake row: it was to **derive its status from the only surface that actually records it, and to say nothing when that surface contradicts itself.**

Prefer queen when addressing or referring to the root. The architectural role remains orchestrator; old and user input that says `orchestrator` is still understood. Authority is unchanged: queen is still the read-only root role with no agents row and no landing right.

The derivation is `src/daemon/status-service/status-orchestrator.ts`; provider-native boundary bridging is `src/cli/orchestrator-turn-monitor.ts`. This article is the *why*.

## The rule

`deriveOrchestratorStatus` (`src/daemon/status-service/status-orchestrator.ts:73-84`) reads the root's two most recent turn boundaries, newest first, and answers:

- newest is `turn-start` → **working**
- newest is `turn-end`, preceded by a `turn-start` → **idle**
- **anything else → `null`**

It reads event **kinds only, never timestamps**. That is not stylistic — it is the type signature enforcing the design. No timeout inference can be introduced without changing the function's signature, which is exactly the review a timeout deserves.

This word describes activity only. The status spine's durable assignment record (`status_assignments`) is a report binding, not an outcome machine: one row per agent session, `open` from spawn until the kill closes it, and its job is to validate the agent's reports against the exact assignment identifiers its prompt carried. The report phases (`planning` / `implementing` / `testing` / `reviewing` / `blocked` / `complete`) ride on that binding and are descriptive — `complete` approves nothing and changes no task, gate, review, or landing state. A worker becoming idle, landing, or having a clean worktree never touches the row. What the work came to is settled elsewhere, never inferred from this word.

Every provider feeds the same boundary stream under the root's preferred address queen. Delivery accepts the synonym `orchestrator` (case-insensitive) and stores the preferred form; pre-rename undelivered rows keyed as `orchestrator` still drain:

- Claude posts `turn-start` on `UserPromptSubmit` and `turn-end` on `Stop` through its native hooks.
- Codex's rollout records exact `task_started` and `task_complete` events.
- Grok's `updates.jsonl` records streaming updates and the exact terminal `turn_completed` event.

The Workspace queen (orchestrator) supervisor resolves the new Codex/Grok session artifact once, then reads only that bounded file tail. It ignores a predecessor session, reports transitions through the authenticated daemon event endpoint, and pairs a first-observed completed turn when a short turn finished before the first poll. Missing or malformed artifacts remain unknown. It never scrapes terminal text and never infers from elapsed time.

Agent reports follow the same provider boundary. Delivery to every interactive
provider uses the exact `sessiond` locator and its serialized input lane. The
root provider is selected only from the live supervisor
marker under that instance's `HIVE_HOME`; PID liveness rejects stale markers,
and a named instance cannot wake another instance.

## Contradiction is not absence

That third line is the whole article.

**A `turn-end` whose predecessor is another `turn-end` is a contradiction.** A turn cannot end without having started. It means the hooks are lying to us — which is not hypothetical.

Measured in the live `events` table: between **2026-07-11T19:39Z and 2026-07-12T10:58Z — 15 hours and 19 minutes — the root posted 231 `turn-end`s and exactly zero `turn-start`s.** A daemon port change had re-pointed every hook *except* `turn-start`, so the root kept posting turn-starts to a dead port. Grouped by hour, the imbalance is a clean step function: balanced before, 0/231 through the window, balanced again after the fix landed.

A naive "the newest boundary is a `turn-end`, so it's idle" would have rendered a confident yellow **idle** dot for fifteen hours while the root worked continuously. Returning `null` there means the field is omitted, and an absent field is unknown, never false. The dot goes back to honest gray.

So the distinction that keeps the whole design honest:

> **An unpaired `turn-end` is a contradiction in the record; a long gap is merely an absence of news, and absence of news is unknown, never stuck.**

A contradiction is something we are *allowed to conclude from* — one unpaired turn-end is enough to know something is wrong, and it does not become more true after five minutes. An absence is not. This is also why a root that has posted no boundary at all (a fresh session, or one whose `turn-start` hook never landed) gets `null`: those two are indistinguishable from here, and we say nothing rather than pick the flattering one.

The same invariant appears in [database-resilience.md](database-resilience.md) as the absence test, and in [authorization.md](authorization.md) as *no evidence must never be converted into permission*. It keeps arriving in different clothes.

## What we refused to synthesise

**No timeout-based `stuck`. Ever.** "The root has not ended a turn in N minutes" describes a deep build turn exactly as well as it describes a wedged process. Delivery learned this the expensive way: the same inference fired **seven times in one evening** on agents that were merely working. Elapsed time is not a state. This is the *measures acting, not being* bug class wearing a new hat, and it is precisely how that class keeps getting reintroduced — each time it looks like a reasonable safety net rather than a guess.

**No `needsUser` (red) for the root.** Red is reserved for *measured* blocked-on-user states — a pending approval record, control-paused, stuck. The root is a user-facing TUI, and a user sitting at it is not a blocked agent. There is no observation that would justify red, so no code path may produce it. A root that goes red is a bug by construction.

**No fake `agents` row.** The "queen / orchestrator has no agents row" invariant is load-bearing in at least four places — name reuse, capability grants (`src/daemon/authorization/authorization-service.ts:243-247`: the user and the root orchestrator have no row, which is also why they are exempt from the epoch check), spawner reservations, and delivery all read that table and assume its members are spawned agents. Adding a fake row to satisfy a *colour* would be the expensive kind of clever.

**No terminal scraping.** Reading the root's pane buffer to guess what it is doing burns context on screenshots and turns the conductor into a babysitter. Codex and Grok already persist typed turn boundaries, so Hive reads those exact records instead.

**Not the one-word edit.** Changing the fabricated `"running"` to `"idle"` in Swift turns the dot yellow today, costs nothing, and is wrong the moment the root starts working. A constant is not an observation.

## Liveness and turn state fail independently

**The status dot is feed-derived.** Its turn word comes from daemon hook events.

The feed and terminal process can therefore disagree: a provider's boundary source can go silent while the process is perfectly alive (the 15-hour Claude window above), and the process can die while the feed still carries the last boundary-derived state.

## The accepted residual

One gap remains, deliberately. If a provider's boundary source stops updating **cleanly** — no contradiction, just nothing more at all — the last boundary stays a legitimate `turn-end`, the contradiction rule sees nothing wrong, and the dot sits **yellow (idle)** while the root is mid-turn. You would see a yellow dot that never goes green no matter what you type, next to a terminal visibly producing output. The terminal would be right.

We accept it because it is bounded, self-evidently wrong to anyone looking at the terminal, and strictly better than a dot that is gray 100% of the time. It cannot produce red, so it cannot manufacture a false alarm. And the underlying cause (hooks pointing at a dead port) is fixed — the contradiction rule exists to catch the *recurrence*, not to trust that there will not be one.

## Authorization

`GET /orchestrator-status` (`src/daemon/server.ts:2828-2857`) is gated on `status:read` — the same action `hive_status` needs, and one every role already holds. **No new `Action` was added.** This is the root's status, not a new kind of authority, and the feed that polls it every second already carries a capability that permits it. The allow is not audited, for the same reason no poll surface is: it would bury every row that matters. See [authorization.md](authorization.md#the-routes-and-tools).

## See Also

- [Authorization](authorization.md) — `status:read`, the no-agents-row invariant, epoch exemption
- [Database resilience](database-resilience.md) — the absence test, of which this rule is one instance
- `src/daemon/status-service/status-orchestrator.ts` — the derivation itself, and the rule stated in full
