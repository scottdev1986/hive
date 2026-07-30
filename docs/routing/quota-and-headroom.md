# Quota and Headroom — facts without a common currency

Updated: 2026-07-30
Source: Hive source tree and linked raw measurements, 2026-07-30
Raw: `../../raw/grok/grok-spend-sensitivity-experiment.md`, `../../raw/grok/grok-billing-{BEFORE,AFTER1,AFTER3}.json`

## Summary

**Quota no longer selects anything.** Selection belongs to the router
(`src/daemon/router.ts`), which distributes by the user's own weights with
smooth weighted round-robin. Quota's contract narrowed to facts and booking:
it observes provider usage, reports proven drains and launch-health cooldowns,
names the pools governing a candidate, and books an already-selected launch.
**Quota percentages never rank candidates**, because unlike windows are not a
common currency.

## The load-bearing argument

Claude meters a ~5-hour and a 7-day window. Codex meters a ~300-minute and a
~10080-minute window (on some plans, only the weekly one — repo memory:
*codex-prolite-meters-one-weekly-window*). Grok meters one weekly pool and has no
five-hour surface at all.

> **Unlike quota windows are not a common currency and cannot be a cross-vendor
> distribution score.**

"Claude is 40% through five hours" and "Grok is 8% through a week" are not comparable
magnitudes; sorting by remaining-headroom-percent silently asserts they are. Worse, it
needs an answer for a provider that publishes no number at all — and every answer to
that is invented. **Never compare a five-hour percentage with a weekly percentage to
rank providers.** This argument used to justify quota's own fair-dispatch chooser;
it now justifies something stronger: quota supplies yes/no facts and the router
distributes by user weights, so no cross-vendor magnitude comparison exists
anywhere.

## The narrowed contract

`QuotaService` (`src/daemon/quota.ts`). `routeAndReserve` is **gone** — there is
no quota-owned selection, no `spread`/`strict` dispatch mode, and the
`quota_fair_dispatch` history table is dropped on ledger startup
(`DROP TABLE IF EXISTS quota_fair_dispatch`, `src/daemon/quota-ledger.ts`).
What remains is exactly what the router and the drain handler consume:

- **Observations.** `refreshFromProviders` polls each provider's usage surface and folds
  authoritative or reported readings into the store, stamped per window; a
  provider that cannot answer records why, and Hive reports the gap as unknown
  rather than carrying forward a number nobody measured.
- **`poolsGoverning(candidate)`** — every pool that meters this model, not the
  first one that matches. A model with its own cap spends from two meters at
  once: the account-wide pool and its own. Both govern; the tighter one decides.
  The router uses the pool names for a handoff's `excludedPoolIds` check.
- **`drainFor(candidate)`** — is any pool metering this model spent, and when
  does the drained window reset? One drained window is a drain: a model-scoped
  cap at zero empties the model even while the general pool has room. An
  unmetered or unmeasured window cannot be drained — **unknown stays unknown,
  it never reads as empty** (`drainedWindowFor`). The router turns a proven
  drain into the `pool-exclusion` refusal; the drain handler uses the same read
  for hold-versus-handoff.
- **`launchCooldown(candidate)`** — is this exact route currently known not to
  start? Eligibility is headroom *and* viability: a gate that refuses an
  exhausted model only to hand the work to a route that cannot start has
  protected nothing. Repeat failures hold the route back longer, but the
  cooldown is capped — a route always gets retried and can always come back.
  Nothing here knows the name of a vendor or a category; it reports what
  happened when Hive last tried, and it forgets on a schedule. The router turns
  it into the `route-health` refusal.
- **`reserveLaunch(agentName, candidate, category)`** — book one
  **already-selected** launch against its governing pools, **never refusing for
  usage**: pool exhaustion is a mid-work condition, handled by the drain
  handler, and selection belongs to the router. An unmetered candidate is
  normal for a provider with no usage surface (opencode) or a quiet one; it
  books against its `unconfigured:` pool, which the status displays already
  read.
- **All-drained arithmetic** — `allMeteredDrained` and `nearestDrainResets`
  feed the drain handler's wait decision when every metered general pool is
  spent.

The invariant this layout enforces, verbatim from the router's design spec
(`docs/design/hive-router.html` §08): *quota provides observations and proven
exclusions; it never supplies a preference multiplier.* 20%, 50%, or 90% used is
ignored for selection — continuous headroom ranking is a hidden second weighting
system. Unknown or unmetered remains eligible — unknown is not zero and not
exhaustion.

### The 0.15 argument — settled, and worth keeping

For a while `quota.ts` held `UNKNOWN_HEADROOM_SCORE = 0.15` and consumed it in
real dispatch: *unknown headroom scored as exactly 15%*. It was a genuine
disagreement between two defensible positions, and both are worth preserving
because the shape recurs.

**The defense** (the constant's own deleted comment, last at `5b565ae:src/daemon/quota.ts:59-63`):

> The fixed, deliberately modest headroom an UNMEASURED pool competes with:
> present enough to catch work when measured pools are nearly spent, never enough
> to beat a healthy one. **An unknown must not resolve to "best".**

That intent is sound. An unmetered vendor should not win by virtue of being
unreadable, and it should not be starved either. 0.15 is a handicap, not a claim.

**The prosecution:** the handicap is still a *fabricated provider reading competing in a
real sort*. Choosing zero would starve the vendor and choosing one would slam it, and
**choosing 0.15 merely hides the same unsupported decision in the middle.** It is the
house bug class — *absence read as the permissive or convenient answer*.

**The prosecution won, and the resolution is the durable part.** Commit `1483ae7`
(2026-07-13) deleted the constant *and every cross-provider headroom sort*.
The fix was not a better guess at the number — it was **removing the axis on which
a guess was required at all.** When a design demands a value nobody can measure,
that is evidence the design is wrong, not that the value needs tuning. The V3
router finishes the thought: the weighted-fair deficit chooser that replaced the
sort has itself been replaced by the router's smooth weighted round-robin over
**user-authored weights**, and quota keeps no distribution history at all.

## Effort

Five-valued in policy (`EffortTargetSchema`, `src/schemas/routing-policy.ts`);
a route candidate carries the four launchable values (`CandidateEffortSchema` —
`never-configured` is a model-row state, not a launchable intent). Resolution is
per candidate in the router's launch gate (`linkEffort`,
`src/daemon/spawner-impl.ts`). An explicit `request.effort` outranks the
candidate. `exact` is validated against the model's own record; `none` means the
vendor stated there is no effort axis; `never-configured` on a model row makes
`provider-controlled` resolution refuse rather than guess.

**`provider-controlled`** omits the candidate-level flag unless the model row
carries a standing exact or Hive-decides choice. Otherwise the launch gate uses
the vendor's honest default: Claude passes no flag; Grok and Codex take their
*discovered* default; Codex's CLI requires a flag, so it last-resorts to
`"medium"` — the one remaining invented value, scoped to a CLI that will not
start without one.

**`hive-decides`** is built (`resolveAutoEffort`, `src/daemon/effort.ts`) and is
*not* the same thing: it picks an exact advertised level and records it. Hive
orders the model's **advertised** levels using `PROVED_EFFORT_ORDER` —
per-provider ordering semantics proved from vendor documentation, not model
knowledge — then picks by the category's coding tier (simple → lowest, complex →
highest). An advertised level whose ordering is unproved makes it **refuse**:
array position is never silently promoted into meaning. (The live Grok cache
returns `high, medium, low`, proving raw array order is not a portable ordering
contract.)

## The task rubric

The orchestrator classifies, because it sees the request, decomposition, file scope,
and expected proof; the daemon sees a task descriptor and deliberately does not grow a
second, weaker classifier (SPEC §6). The rubric is about **task demands, never model
names**:

- **Simple** — mechanical and local: tightly specified, one small surface, obvious
  verification, no cross-component invariant and no meaningful design choice.
- **Standard** — bounded engineering judgment: several related files or one subsystem,
  familiar interactions to reason through, tests need design, but a clear boundary and
  no high-blast-radius invariant.
- **Complex** — architecture, concurrency, security/authority, data migration,
  cross-subsystem state, substantial ambiguity, or a correctness argument that cannot
  be localized.

> **Maximum-risk rule.** A task is simple only when *every* dimension is simple. Any
> complex dimension makes it complex. Everything between is standard. **Uncertainty
> raises the tier; it never lowers it to find an available model.**

The classifier may see task requirements. It must **not** see quota headroom, and must
never change a category to reach a less loaded vendor. Escalation is a handoff, not an
in-session model switch — and an explicit category CHOICE is never silently raised.

## Grok: the gauge that is not a guard

The controlled spend-sensitivity experiment (2026-07-13, grok 0.2.99 — raw timeline at
`../../raw/grok/grok-spend-sensitivity-experiment.md`, payloads at
`../../raw/grok/grok-billing-{BEFORE,AFTER1,AFTER3}.json`):

| When | `creditUsagePercent` | Money rails |
|---|---|---|
| BEFORE | 7.0 | all `val=0` |
| Burn A (~85k tokens), +0/+15/+45s | 7.0 | all `val=0` |
| Probe-only control ×3 | 7.0 | all `val=0` |
| ~+5 min | **8.0** | all `val=0` |

- `config.creditUsagePercent` is a **real gauge** of the SuperGrok weekly pool — it
  moved with model spend (7→8, and 2→8 over a longer series).
- It is **not** a money-credit fraction: `prepaidBalance`, `onDemandUsed`, `onDemandCap`
  stayed at zero while the percent climbed. The money rails on the same payload are a
  **guard** (*would this spend money?*), never a **gauge** (*how full is the pool?*).
  Rendering their zeros as capacity reads as "full tank."
- It is **coarse and lagging** — integer percent, multi-minute delay. No tight control loop.
- The probe is session-free and non-billable (control stable).
- Grok is therefore **metered** weekly and **positively not metered** for five hours.
  A recognized weekly surface that *lacks* the percent is `READ_FAILED`, **not**
  not-metered — positive controls established that the vendor meters this window.

This falsified the earlier design that treated Grok's pool as unmeasurable and waited
for a limit-shaped failure to infer exhaustion. It also kills the **pressure-valve**
policy: Grok is a peer, not a relief vendor. *"Grok receives work because it is capable,
consented, affordable, and behind its earned share — not because another vendor's meter
is low."* Leaning on a vendor whenever other meters are low is not distribution; it
recreates the load-concentration bug this router exists to remove.

`usageSurface` in `src/cli/model-control.ts` classifies the metered providers;
`src/daemon/quota-sources.ts` reads the gauge while keeping the money rails in
the schema *specifically so parsers cannot confuse them with it*. Deeper wire facts live
in [../providers/quota-surfaces.md](../providers/quota-surfaces.md).

## What the V2 proposals became

The retired routing-distribution proposal's unbuilt items are worth an update,
because the V3 router landed several of them under different names:

- **User-authored provider scheduling weights** — landed, better: per-candidate
  integer weights 1–100 on the route itself (`RouteCandidateSchema`). The
  honesty argument survived intact: *a weight claims only desired work share,
  never capacity* — which is why it beat asking the user to declare a capacity
  percentage for an unmetered vendor.
- **A "why this agent?" decision record** — landed as the `launch_decisions`
  ledger plus the per-candidate `CandidateEvaluation` refusals surfaced in every
  no-candidate error. *"A user should not need logs to discover that another
  model was considered or why one disappeared."*
- **`WindowMetering` as a first-class union** (`METERED | NOT_METERED |
  READ_FAILED` carrying positive wire evidence) — still not built. The
  distinction is real and load-bearing — a gauge Hive *expected* and could not
  read is not the same as a vendor that has none — but today it is only
  implicit in availability/freshness fields.

## See Also

- [routing-policy.md](routing-policy.md) — the routes, the router, and the gate quota is downstream of
- [model-control-center.md](model-control-center.md) — how a meter may and may not be rendered
- [rejected-approaches.md](rejected-approaches.md) — headroom sorting and quota-owned selection, and why they lost
- [../design/hive-router.html](../design/hive-router.html) — the router design spec, §08 quota contract
- [../providers/quota-surfaces.md](../providers/quota-surfaces.md) — the vendor wire contracts
- [../providers/grok.md](../providers/grok.md) — the vendor, end to end
