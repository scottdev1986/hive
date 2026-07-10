# Model routing and token efficiency

## What this is and why

Hive's routing today answers one question well — "which vendor and model can I safely launch right now?" — and leaves a more expensive question unanswered: "what is the cheapest launch that will still produce work I don't have to redo?" This document is the research pass on that second question: how Hive should classify jobs, choose among the models actually available to it (GPT-5.6 Sol/Terra/Luna via Codex; Fable 5, Opus 4.8, Sonnet 5/4.6, Haiku 4.5 via Claude Code), spend tokens deliberately instead of by default, and know afterward whether the choice was right. It reads the current code (`src/schemas/routing.ts`, `src/daemon/quota.ts`, `src/daemon/spawner-impl.ts`, `src/config/load.ts`, `src/adapters/tools/models.ts`) plus the minimum current provider sources, and ends with an implementable decision matrix, a routing rubric, telemetry, an evaluation plan, and a staged rollout. Verified facts and time-sensitive assumptions are kept separate; the assumptions section at the end is dated.

The one-sentence thesis: **Hive's biggest cost lever is not smarter model choice at the top — it is stopping the silent resolution of routine work onto frontier models, and closing the loop so estimates, tiers, and escalations learn from what runs actually cost.** Everything below serves that.

## Where the tokens actually go today (verified against the code)

The current pipeline, end to end. The orchestrator classifies a task into a tier (`deep`/`standard`/`cheap`/`review`); `resolveRoute` merges `~/.hive/routing.toml` over `defaultRoutingTable(now)` (`src/config/load.ts:70-119`); the spawner resolves both vendors' concrete models, inserts Opus 4.8 as a same-vendor release valve whenever the Claude candidate is Fable (`src/daemon/spawner-impl.ts:614-627`); `routeAndReserve` scores each candidate by worst post-reservation headroom across the five-hour and weekly windows, ties broken by preferred tool then name, and atomically reserves tier-keyed planning units before any process exists (`src/daemon/quota.ts:516-554`). `cheap` and `standard` spawns must additionally clear a deep-capacity reserve floor (defaults: 15% five-hour, 20% weekly — `src/schemas/quota.ts:36-37`). Unconfigured pools fall into compatibility mode: an unbounded reservation at `missing` confidence and one deduplicated warning (`src/daemon/quota.ts:558-589`).

This is a genuinely good safety design, and three observations about it explain most of Hive's avoidable spend:

**1. The defaults resolve routine work onto frontier models.** The Codex column of every tier says model `"default"`, which `resolveConcreteModel` reads from `~/.codex/config.toml` (`src/adapters/tools/models.ts:59-74`). On this machine that file says `gpt-5.6-sol` at `model_reasoning_effort = "xhigh"` — OpenAI's premium frontier model at its second-highest effort. So a `cheap` Codex spawn launches Sol; the tier only lowers the effort flag. The `standard` tier — the default for most implementation work — is Codex-preferred, so the modal Hive worker today is a frontier model. On the Claude side, `deep` resolves `best` → Fable 5 until the 2026-07-12 cutoff (`FABLE_AUTO_ROUTING_CUTOFF`, `src/schemas/routing.ts:77`), after which it pins `claude-opus-4-8`. The mid-tier models that providers explicitly position for exactly this work — GPT-5.6 Terra ("balancing intelligence and cost effectiveness") and Luna ("optimized for cost-sensitive workloads"), Sonnet 5 ("near-Opus quality on coding and agentic work at Sonnet cost") — are unreachable by default routing on the Codex side and only partially used on the Claude side.

Why the code is this way is documented and real: naming a concrete Codex model in the defaults killed every spawn on a ChatGPT-plan account ("model not supported" — SPEC §6). `"default"` is entitlement-safe by construction. The recommendation below keeps that property while escaping the premium-default trap.

**2. Quota-aware routing is inert until someone writes `quota.toml`.** On this machine `~/.hive/quota.toml`, `~/.hive/routing.toml`, and `~/.hive/config.toml` are all empty. With an empty `limits` array every candidate scores the same sentinel, ties resolve to the preferred tool, and reservations are unbounded. The scoring machinery, the deep-reserve floors, the Fable→Opus release valve — none of it can fire. The cheapest high-leverage change in this entire document is shipping a starter `quota.toml`.

**3. Nothing learns.** Tier estimates are static config (`deep: 20, standard: 10, cheap: 4, review: 8` planning units — `src/schemas/quota.ts:39-44`). Reconciliation exists (a completed turn settles the reservation to provider-reported consumption when a hook supplies it), and provenance is honestly labeled (`authoritative`/`reported`/`estimated`/`missing`/`stale`), but no loop feeds actuals back into the estimates, no record ties "this tier choice" to "this outcome," and the orchestrator's classification never sees the price of being wrong. The telemetry section below closes this.

Worth naming what the codebase already gets right, because the fix is *not* to rebuild it: minimal spawn briefings (task + file scope + memory index only — `buildAgentPrompt`, `src/daemon/spawner-impl.ts:239-255`); index-only memory injection capped at 30 lines with on-demand `memory_read` (SPEC §5); artifact-first messaging ("reference large artifacts instead of pasting them" is in every writer prompt); context recycling at a 65% quality line with structured handoffs instead of lossy `/compact` (SPEC §7); an orchestrator that is idle by default and physically cannot code (SPEC §2, §11); and a landing protocol that bounds retry loops at three attempts. These are token-efficiency mechanisms that most orchestrators lack. This document extends them; it does not replace them.

## The model landscape (prices as of the sources cited)

Hive spawns subscription CLIs, so the binding constraint is usually plan capacity (five-hour and weekly windows), not API dollars. API prices still matter twice over: they are the best available proxy for how hard a model draws on shared plan capacity, and they become the literal bill wherever usage is metered (Fable 5 after 2026-07-12; any API-keyed account).

| Model | ID | Ctx | $/MTok in→out | Position |
|---|---|---|---|---|
| Claude Fable 5 | `claude-fable-5` | 1M | 10 → 50 | frontier; thinking always on; refusal classifiers; deep-route default until 2026-07-12 |
| Claude Opus 4.8 | `claude-opus-4-8` | 1M | 5 → 25 | top Opus; deep-route default after cutoff |
| Claude Sonnet 5 | `claude-sonnet-5` | 1M | 3 → 15 (intro 2 → 10 through 2026-08-31) | near-Opus on coding/agentic; new tokenizer ≈ +30% token counts |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M | 3 → 15 | previous Sonnet; current `standard`/`review` alias target |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | 1 → 5 | cheap tier |
| GPT-5.6 Sol | `gpt-5.6-sol` (alias `gpt-5.6`) | 1.05M | 5 → 30 | frontier; this machine's Codex default at xhigh |
| GPT-5.6 Terra | `gpt-5.6-terra` | 1.05M | 2.5 → 15 | mid: "balancing intelligence and cost effectiveness" |
| GPT-5.6 Luna | `gpt-5.6-luna` | 1.05M | 1 → 6 | cost-optimized |

Sources: Anthropic model catalog and pricing (platform.claude.com/docs/en/about-claude/models/overview.md, pricing.md; cached reference dated 2026-06-24, model IDs re-verified against live docs in `src/adapters/tools/models.ts` comments dated 2026-07-09/10). OpenAI lineup fetched live 2026-07-10 (developers.openai.com/api/docs/models); all three GPT-5.6 variants take reasoning effort `none|low|medium|high|xhigh|max` and 128K max output.

Two provider mechanics change the economics enough to shape routing. **Effort is a bigger intra-model lever than most model swaps**: both vendors expose it (Codex via `model_reasoning_effort`, already routed per tier; Claude models via `output_config.effort`, low→max), and provider guidance is that lower effort means fewer tool calls, less preamble, and terser output — often a multiple of the spend at the same per-token price. **Prompt caching makes conversation continuation nearly free relative to restart**: cache reads bill ~0.1× input, writes 1.25× (5-minute TTL), so resuming an existing session (which Hive's crash recovery already does via `claude --resume`/`codex resume`) is strongly preferred over respawning whenever the conversation is the asset. Batch APIs (50% off) don't apply to interactive CLIs and can be ignored here.

## Choosing a model per job

The orchestrator's classification instinct ("deep/standard/cheap") is right and stays — an LLM judging task difficulty is durable; an LLM recalling model lineups is not (SPEC §6). What's missing is a rubric that makes the classification honest, and a matrix that resolves it onto the models above.

**Classify on five dimensions, take the max.** A task's tier is driven by whichever dimension is worst, not an average:

- **Risk** — blast radius if the output is subtly wrong. Auth, money, migrations, concurrency, safety-stack code (Hive's own capability/landing machinery) are high regardless of size. Changelogs, formatting, doc stubs are low regardless of size.
- **Complexity** — how much must be held in mind at once: cross-module invariants, protocol state machines, novel design vs. pattern-following edits.
- **Uncertainty** — is the task well-specified, or does the agent have to discover what "done" means? Underspecified work burns tokens on exploration; either spec it tighter (cheaper) or send a stronger model (more expensive but converges).
- **Context load** — how much must be read before writing. High-context tasks favor models that navigate repos efficiently at high effort over cheap models that re-read.
- **Tool-use intensity** — long agentic loops (many test runs, migrations across many files) multiply per-turn cost; loop length matters more than model here, so bound the loop, then pick the model.

**Role modifies tier.** The orchestrator itself should be a capable model — it is one long-lived session whose misjudgments multiply across every spawn, and it is read-only and idle by default so its token draw is modest; economizing here is false economy. Workers take the matrix below. Reviewers need less than authors: review is bounded reading plus judgment, not construction — `review` correctly resolves to mid-tier, cross-vendor from the author (`src/daemon/quota.ts:519-522`). Integrators (conflict merges) are judgment-heavy on small context: standard tier, never cheap.

**The compact decision matrix.** Job archetypes → route. Claude effort assumes the route schema grows an effort field (recommendation R3); until then the Claude effort column is aspirational and the model column alone applies.

| Archetype (examples) | Tier | Claude route | Codex route | Validation | Budget guidance |
|---|---|---|---|---|---|
| Novel design, hard debugging, cross-cutting refactor, safety-stack code | deep | Opus 4.8 @ high–xhigh (Fable only by explicit pin) | Sol @ xhigh | tests + cross-vendor review | full context OK; one agent, no fan-out until design lands |
| Well-scoped feature, ordinary bug fix, test authoring | standard | Sonnet 5 @ medium–high | Terra @ medium (until Terra is routable: default @ medium) | tests; review only if risk-high | brief ≤ 1K tokens; expect ≤ ⅓ of context window |
| Mechanical edits, changelogs, doc formatting, config touch-ups, skill authoring | cheap | Haiku 4.5 @ low | Luna @ low (until routable: default @ low) | tests/lint only | hard small budget; escalate rather than grind |
| Code review of another agent's diff | review | Sonnet 5 @ medium | Terra @ medium | n/a (is the validation) | diff + touched files only, not the repo |
| Integration/conflict merge (escalation only) | standard | Sonnet 5 @ high | Terra @ high | tests | scope = the conflict, nothing else |
| Research/summarization, repo Q&A | cheap→standard | Haiku→Sonnet 5 @ low–medium | Luna→Terra @ low–medium | none | read-only agent in main checkout (free of worktree cost) |

The deliberate asymmetry: **deep stays frontier, and everything else moves down one provider price band from today's behavior.** Sonnet 5 at Sonnet prices covering "near-Opus quality on coding" is precisely the standard tier's job description; Terra is OpenAI's same positioning. The savings estimate is straightforward: if the modal spawn today is Sol ($5/$30) or resolves through a frontier default, and the modal spawn after is Terra/Sonnet 5 ($2.5-3/$15), the standard tier — the bulk of spawns — costs roughly half per token, before effort tuning, which compounds another large factor on output-heavy agentic work.

**Escalation and de-escalation.** SPEC §6 already names retry-with-a-bigger-model as the escape hatch; make it the explicit ladder: a cheap agent that fails, stalls, or reports "this is harder than briefed" is killed (worktree preserved) and the task respawns one tier up with the failure note in the brief — cheap→standard→deep, one rung at a time, never skipping to deep on the first miss. Symmetrically, de-escalate deliberately: mechanical follow-ups discovered during deep work (rename sweeps, doc updates) are spawned down at cheap rather than done in the deep agent's expensive context. The escalation attempt cap is 2 (three total attempts across tiers), mirroring the landing protocol's 3-attempt bound; after that the orchestrator surfaces it to the user rather than burning a fourth run. A tier bump is also the answer to *uncertainty*: when the orchestrator cannot spec a task tightly, either spend its own (read-only, cheap) turns reading code to tighten the spec, or send standard with an explicit "report back if scope exceeds X" tripwire — never send cheap into fog.

**Early stopping and validation depth.** Every brief should carry a proportionality clause: budget guidance ("this is a ≤N-step task; if you exceed it, stop and report"), and validation scaled to risk — lint-only for cheap mechanical work, tests for standard (structurally enforced by landing anyway), tests plus cross-vendor review for deep or risk-high diffs. Uniform maximum validation is the hidden token tax of cautious orchestrators; the landing protocol's red-tests-never-merge floor means the *minimum* is already safe, so depth above the floor should be bought only where risk pays for it. API-level `task_budget` is not reachable through the interactive CLIs, so budgets are prompt-level (soft) backed by the context-% watchdog and the resource sweep (hard) — acceptable, because the expensive failure mode is grinding, and a grinding agent trips either the 65% line or the orchestrator's stall detection.

**When multi-agent is justified — and when it isn't.** Fan out only when file scopes are disjoint and the interface between them landed first (SPEC §3), when cross-vendor review adds an independent perspective, or when an integrator is escalated. Sequential tasks split across agents get *worse*, not just slower (SPEC §14 cites 39–70% degradation on sequential tasks), and every extra agent pays a fixed overhead — worktree, spawn, briefing, its own repo reading — that a single agent's warm context amortizes. The default answer to "should this be two agents?" is no; the 2–4 writer ceiling is a cap, not a target. The orchestrator brief should say this in one line: *prefer one agent with a good brief over two agents with a coordination problem.*

**Duplicate-work prevention.** Three existing mechanisms just need consistent use: durable memory (check the injected index before spawning research — a fact like this document's existence should stop a future orchestrator from re-running this exact task; that is what the companion memory entry is for), run history (the daemon logs every task descriptor; near-duplicate descriptors within a session are a prompt to reuse the prior agent or its artifacts), and artifact-first handoffs (an agent that wrote `docs/research/X.md` reports the path, and the next agent reads the file rather than receiving a re-narration through the orchestrator's context — which also keeps the orchestrator's own window lean, protecting its cache prefix).

**Caching discipline.** Two rules cover most of the value. First, prefer resume over respawn whenever the conversation is the asset — crash recovery already does this; context-line recycling deliberately does not (the handoff is the compression). Second, keep spawn-prompt prefixes stable: `buildAgentPrompt` interpolates name and task first, so no cross-agent prefix sharing is possible — harmless today at one spawn per agent, but any future template growth should put static protocol text (the landing protocol, tool instructions) ahead of per-agent content, and never interpolate timestamps or IDs early. The CLIs manage their own caching internally; Hive's job is merely not to defeat it.

**Safe fallback behavior.** The existing posture is correct and should be preserved verbatim in any refactor: an explicit user tool choice is never silently overridden — an unsafe explicit spawn returns remaining capacity, reset times, and the recommended fallback instead of a substitution (`src/daemon/quota.ts:645-675`); control restarts pin the immutable execution identity and fail closed rather than guess (`src/daemon/spawner-impl.ts:296-310`); exhausted vendors mean no process starts. The one addition: when the Fable→Opus valve or any future cost-based downgrade fires, the decision `reason` already flows back through spawn — surface it in the orchestrator's envelope so downgrades are visible, not silent.

## The routing rubric, as an algorithm

What the orchestrator does (judgment, in the brief):

```
classify(task):
  risk, complexity, uncertainty, context_load, tool_intensity ∈ {low, med, high}
  tier = max-dimension mapping:
    any high in {risk, complexity}            → deep
    uncertainty high                          → tighten spec, else standard + tripwire
    all low and mechanical                    → cheap
    otherwise                                 → standard
  review needed = (risk ≥ med) or (diff will be large) → schedule review tier, cross-vendor
```

What the machine does (deterministic, extending `routeAndReserve`):

```
resolve(tier, route, request):
  candidates = [claude(route), codex(route)]            # concrete models
  if claude == fable: insert claude/opus-4.8 after it   # existing valve
  # R2 below generalizes the valve: each tier's route may list a same-vendor
  # downshift chain; append chain entries after the primary.
  filter by explicitTool if present
  score = min(post-reservation headroom, 5h and weekly) # existing
  sort by score, then preferred tool, then name         # existing
  reserve first candidate clearing floors               # existing
  effort = route[tool].effort                           # Codex today; Claude after R3
  on failure: report capacity + reset + safe fallback; never substitute an explicit choice
```

The rubric deliberately adds no new scoring inputs to the deterministic half — headroom remains the only machine-judged quantity, because it is the only one Hive can measure honestly today. Cost-optimality lives in the *table* (which model each tier names), not in a runtime cost model; that keeps the resolver boring, auditable, and immune to stale price data. A runtime $/token optimizer was considered and rejected: subscription capacity is the real constraint, prices staleness-decay, and a wrong price silently rerouting work is worse than a legible table the user can read and override.

## Recommendations, concretely

- **R1 — Ship a starter `quota.toml` and make compatibility mode loud.** Until pools exist, nothing else in this document has teeth. Provide a commented template (Claude pool, Codex pool, sensible five-hour/weekly allowances for common plans) and have `hive claude` nudge once per session while `limits` is empty. Effort: small; config plus one warning path.
- **R2 — Generalize the Fable→Opus valve into per-tier downshift chains.** Replace the hardcoded `if claudeModel === CLAUDE_BEST_MODEL` splice with an optional `fallbacks: [model...]` list on each route entry, same semantics (appended after primary; ties keep the primary). This lets standard declare Sonnet 5 → Sonnet 4.6, or Sol → Terra, without touching resolver logic. The existing valve becomes data.
- **R3 — Add `effort` to the Claude route column** (`ClaudeRouteSchema`), plumbed the same way Codex's already is — *after verifying the current Claude Code CLI's supported mechanism for setting effort at launch* (flag, settings key, or env). Not specced here from memory, deliberately: this repo has been burned by unverified CLI flags before (`.hive/memory` lesson "verify vendor docs before speccing"). Half the verification already exists: `research/cross-vendor-architecture-review.md` confirms (against claude 2.1.206) that the stream-json `initialize` control request returns a zero-cost per-model enumeration including `supportsEffort` and `supportedEffortLevels` — so effort support is machine-discoverable per account; what remains unverified is only the launch-time setter.
- **R4 — Point default routes at mid-tier models where entitlement-safe.** Claude column: `standard`/`review` → `sonnet` alias already resolves to the current Sonnet (entitlement-adaptive, correct); no change needed beyond effort. Codex column: `"default"` cannot be dropped safely (SPEC §6's entitlement lesson), so use R2's chain inverted — attempt `gpt-5.6-terra` (standard) / `gpt-5.6-luna` (cheap) first, and let the existing 15-second launch-failure monitor (`monitorReadiness`, which already detects "model not supported"-class failures) trigger a respawn on `"default"`. One extra failed launch per unsupported account per session is the cost; frontier-by-default forever is the alternative.
- **R5 — Put the classification rubric and the fan-out caution into `ORCHESTRATOR_BRIEF`.** Today the brief says "classify each task as deep, standard, or cheap" with no criteria. Add the five dimensions, the max rule, the escalation ladder, the "prefer one well-briefed agent" line, and the budget-tripwire habit. This is the highest-leverage prompt edit in the system: every routing decision flows through it.
- **R6 — Close the estimate loop.** Reconciliation already writes actuals when telemetry supplies them; add a periodic job (or `hive quota calibrate`) that compares reserved estimates to reconciled actuals per tier and proposes updated `estimates` values. Keep it propose-not-apply, matching the skills rule-of-three posture.

## Telemetry

Record per spawn, in the daemon's existing SQLite (most fields already exist on the agent row or reservation ledger; the delta is joining and keeping them): tier, requested vs. resolved tool/model/effort, decision `reason`, estimate vs. reconciled actual (with provenance confidence), wall time, turn count if the hook path supplies it, terminal outcome (landed / failed / killed / escalated / recycled), escalation lineage (which agent this respawn continues), landing attempts, and review verdict where a review tier ran. Derived weekly views: planning units by tier×model (where the money goes), estimate error by tier (feeds R6), escalation rate by tier (misclassification signal — a high cheap→standard rate means the rubric or the brief is wrong), first-attempt landing rate by model (quality signal), and review catch rate (whether paid validation is finding anything). Provenance stays first-class exactly as the quota store does it: an `estimated` cost row must never be presented with `authoritative` confidence.

## Evaluation plan

Three layers, cheapest first. **(1) Offline replay:** the daemon logs every task descriptor; hand-classify a sample of ~50 historical descriptors against the rubric and compare to the tiers the orchestrator actually chose — this validates R5 before it ships and needs no spawns. **(2) Shadow scoring:** for two weeks after R1/R2 land, log what the new table *would* have chosen alongside what the old table did choose, and diff projected planning units; no behavior change, pure measurement. **(3) A/B by session:** alternate sessions between old and new defaults on real Hive-builds-Hive work (the v1.1 dogfood gate is the natural venue) and compare the telemetry views above — cost per landed task, first-attempt landing rate, escalation rate, and user interventions. Success criteria: standard-tier planning units per landed task down ≥30% with first-attempt landing rate within 5 points of baseline. If landing rate degrades more than that, the mid-tier models are not carrying the standard tier and the matrix moves that archetype back up — the telemetry makes the retreat cheap and legible.

## Staged rollout

1. **Measure and arm (no routing change):** R1 starter `quota.toml` + compatibility-mode nudge; telemetry joins; offline replay of the rubric. Nothing about spawn behavior changes except that reservations become bounded and honest.
2. **Route (reversible by config):** R2 downshift chains, R3 Claude effort, R4 mid-tier defaults with launch-failure fallback, R5 brief update — each independently revertible via `routing.toml` overrides, which always win over defaults. Shadow-score for two weeks, then A/B.
3. **Learn (propose, never auto-apply):** R6 estimate calibration; escalation-rate feedback into the rubric text; eventually the curated routing manifest (SPEC §6) carries the matrix so new model generations update the table without a Hive release. Auto-applying learned changes is explicitly deferred — a self-tuning router that drifts silently is the failure mode the immutable-identity and provenance work exists to prevent.

## Verified facts vs. time-sensitive assumptions

**Verified in code or config on 2026-07-10** (durable until the cited files change): everything attributed to a `src/` path above; the empty `~/.hive/{quota,routing,config}.toml` on this machine; `~/.codex/config.toml` naming `gpt-5.6-sol` @ `xhigh`; `FABLE_AUTO_ROUTING_CUTOFF = 2026-07-12T00:00:00Z`; `claude --model best` billing to `claude-fable-5` and `claude-opus-4-8` launching directly (both re-verified against the live CLI 2026-07-09/10 per `src/adapters/tools/models.ts` comments).

**Time-sensitive assumptions (as of 2026-07-10):**

- Provider prices and lineups in the table above — Anthropic figures from a reference cached 2026-06-24; OpenAI figures fetched live 2026-07-10. Model generations turned over twice in the past year; re-verify before acting on any specific number, and treat the *ratios* (frontier ≈ 2× mid ≈ 5× cheap) as the durable content.
- Sonnet 5's intro pricing ($2/$10) ends 2026-08-31.
- Fable 5 moving to usage-only billing off subscription plans on 2026-07-12 is recorded in this repo's code comments and SPEC §6; the provider-side detail has not been independently re-verified here.
- "Sol/Terra/Luna" positioning language is the vendor's own; independent quality comparisons (does Terra actually carry Hive's standard tier?) are exactly what the evaluation plan exists to test, not something this document asserts.
- Claude Code's launch-time effort mechanism (R3) is deliberately left unverified here — check live CLI docs before implementing.
- The Codex CLI tolerating an unentitled `--model` with a clean, detectable launch failure (R4's fallback mechanism) matches the field-test behavior SPEC §6 records, but should be re-confirmed against the current CLI before R4 ships.

## How a fresh orchestrator should use this

Don't re-run the research — the durable memory entry pointing here exists precisely so this pass isn't repeated. Use the classification rubric and the decision matrix when tiering tasks; treat the matrix's model names as defaults the routing table may already encode, not values to pass explicitly (`hive_spawn` takes a tier, and the table resolves it). Before recommending routing changes to the user, check which recommendations (R1–R6) have already landed by reading `src/schemas/routing.ts` and `~/.hive/quota.toml` — this document describes the state on its date, and the code outranks it afterward. The time-sensitive assumptions section lists exactly what to re-verify before acting on a price or a CLI behavior.

## Open questions

- **Does the review tier pay for itself?** Telemetry's review-catch-rate view will answer whether cross-vendor review finds enough real defects to justify its planning units, feeding the SPEC's open self-land-vs-gate question with data instead of instinct.
- **Where is the effort sweet spot per tier?** Provider guidance says medium/high covers most work and xhigh helps hardest coding tasks; Hive should sweep this in the A/B rather than trust guidance written for API callers.
- **Can classification be assisted without being automated?** A cheap-model pre-classifier suggesting a tier to the orchestrator was considered and deferred: it adds a spawn to save a judgment the orchestrator makes adequately, and the telemetry will show whether misclassification is even the binding problem.
