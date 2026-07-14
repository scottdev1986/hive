# Quota and Headroom — distribution without a common currency

Updated: 2026-07-14
Source: Hive source tree and linked raw measurements, 2026-07-14
Raw: `../../raw/grok/grok-spend-sensitivity-experiment.md`, `../../raw/grok/grok-billing-{BEFORE,AFTER1,AFTER3}.json`

## Summary

Quota is an affordability gate on every candidate. It chooses among survivors under
`auto`, and as the last resort after a `choice` category plus Default chain are
exhausted. That chooser uses **weighted-fair deficit over work Hive itself assigned**,
never cross-vendor quota percentages, because unlike windows are not a common currency.

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
rank providers.** Evaluate each real window as its own affordability gate.

## What the code does

Two layers, and conflating them is the most common misreading of this system.

**Policy layer** (`src/schemas/routing-policy.ts:112-126`): `never-configured` | `auto` | `choice`
— the user's intent. See [routing-policy.md](routing-policy.md).

**Quota dispatch layer** (`src/daemon/quota.ts:64-78`): `QuotaRouteRequest.selection`
is `spread` | `strict`. The spawner maps `auto` to `spread` and uses `strict` for the
authored attempts under `choice` (`src/daemon/spawner-impl.ts:1779-1841`). If the
category and Default chains are non-empty but exhausted, the final `choice` attempt
uses `spread` over the remaining enabled models. Every candidate handed to quota has
**already cleared the full launch gate**; selection never bypasses a gate.

### `strict` (the authored portion of `choice`)

Walk the category and Default chains in the user's order; reserve the first link with
safe headroom (`src/daemon/quota.ts:1671-1753`). Quota may veto a link, never reorder
either authored list.

> Authored preference order bypasses distribution. **Reordering an explicit
> preference for balance would make the preference untrue.** Only after every authored
> link is refused may Hive use fair dispatch across the remaining enabled models.

A strict candidate whose capacity Hive cannot read still runs, in **compatibility mode**
(`src/daemon/quota.ts:1671-1705`): an unbounded reservation, a loud "running unconstrained" warning, and no
pretense of a number. **Meter uncertainty is not capability revocation.**

### `spread` (`auto`, and exhausted-`choice` last resort)

`QuotaLedger.tryReserveFairGroups` (`src/daemon/quota-ledger.ts:1218-1303`) chooses and reserves
**atomically** — one decision, so two concurrent spawns cannot both see the same
provider as under-share — by **weighted-fair deficit**. Each historical dispatch
credits every *eligible* provider an equal share and charges the selected provider one
unit; largest deficit wins. History lives in `quota_fair_dispatch` (bounded rolling
window of 1000 rows).

The invariant, from the code (:1218-1224):

> **Quota percentages never enter this comparison, so unlike windows are never
> compared and a not-metered provider needs no fabricated headroom score.**

This measures the thing it claims to balance: Hive can always count the work it *sent*
to a provider, even one that publishes no capacity number. Consequences worth knowing:

- **A provider earns no credit for work it could not perform** — a simple-only provider
  accumulates no claim on later complex work. *A weak model cannot win because it is idle.*
- **Explicit pins and control restarts create no fairness debt.** A direct user
  instruction must not distort the next automatic choice.
- **No catch-up bursts.** A vendor unavailable for a week earned no credit and does not
  return with a week of debt to repay.
- **Unknown capacity is excluded from `spread`, not scored** (`src/daemon/quota.ts:1624-1634`):
  *"AUTO excludes unreadable capacity, while an explicit choice may still run it."*

Its cost is deliberate: it does not optimize consumption near a reset. Quota gates
prevent unsafe work; distribution declines to pretend incompatible meters form one market.

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
(2026-07-13 11:20) deleted the constant *and every cross-provider headroom sort*.
The fix was not a better guess at the number — it was **removing the axis on which
a guess was required at all.** When a design demands a value nobody can measure,
that is evidence the design is wrong, not that the value needs tuning.

Two adjacent constants died with it and are recorded here so they are not rebuilt:
`SPREAD_DEADBAND = 0.05` (headroom two pools could differ by and still count as
"even") existed only to stop the headroom sort from flip-flopping between
near-equal pools — a symptom of the sort, not a feature.
`HEADROOM_PRESERVING_CATEGORIES` survives (`src/daemon/quota.ts:56-62`): light work leaves a
reserve floor untouched so heavy work still has somewhere to land.

## Effort

Five-valued in policy (`src/schemas/routing-policy.ts:49-55`), resolved per chain link
(`src/daemon/spawner-impl.ts:1519-1565`). An explicit `request.effort` outranks the link.
`exact` is validated against the model's own record; `none` means the vendor stated
there is no effort axis; `never-configured` refuses.

**`provider-controlled`** omits the link-level flag unless the model row carries a
standing exact or Hive-decides choice (`src/daemon/spawner-impl.ts:1549-1564`). Otherwise the
launch gate uses the vendor's honest default (`src/daemon/spawner-impl.ts:1636-1668`): Claude
passes no flag; Grok and Codex take
their *discovered* default; Codex's CLI requires a flag, so it last-resorts to
`"medium"` — the one remaining invented value, scoped to a CLI that will not start
without one.

**`hive-decides`** is built (`src/daemon/effort.ts:63-110`) and is *not* the same
thing: it picks an exact advertised level and records it. Hive orders the model's
**advertised** levels using `PROVED_EFFORT_ORDER` — per-provider ordering semantics
proved from vendor documentation, not model knowledge — then picks by the category's
coding tier (simple → lowest, complex → highest). An advertised level whose ordering
is unproved makes AUTO **refuse**: array position is never silently promoted into
meaning. (The live Grok cache returns `high, medium, low`, proving raw array order is
not a portable ordering contract.)

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

`src/cli/model-control.ts:72-83` classifies all three providers as `"metered"`;
`src/daemon/quota-sources.ts:920-945` reads the gauge while keeping the money rails in
the schema *specifically so parsers cannot confuse them with it*. Deeper wire facts live
in [../providers/quota-surfaces.md](../providers/quota-surfaces.md).

## Proposals and open questions (NOT built)

Much of the retired routing-distribution proposal *did* land in `1483ae7`: the
three-state selection intent, `standard_coding`, weighted fair dispatch, and
Hive-decides effort are all real. These parts did **not**, and are recorded as intent,
not description:

- **`SelectionIntent<T>` as a generic type** — the three-state *idea* landed as
  `SelectionModeSchema`; the generic does not exist.
- **`WindowMetering` as a union** (`METERED | NOT_METERED | READ_FAILED` as a
  first-class type carrying positive wire evidence). The distinction is real and
  load-bearing — a gauge Hive *expected* and could not read is not the same as a vendor
  that has none — but today it is only implicit.
- **User-authored provider scheduling weights / opportunity credits.** Fair dispatch runs
  with implicit equal weight per eligible provider; there is no weight field and no user
  surface for one. The design's honesty argument is worth keeping: *a scheduling weight
  claims only desired work share, never capacity* — which is why it beat asking the user
  to declare a capacity percentage for an unmetered vendor.
- **A "why this agent?" decision record.** Quota returns a `reason` string and warnings,
  but nothing persists the candidates considered and the stage each was refused at.
  *"A user should not need logs to discover that another model was considered or why one
  disappeared."*

## See Also

- [routing-policy.md](routing-policy.md) — the chains and the gate quota is downstream of
- [model-control-center.md](model-control-center.md) — how a meter may and may not be rendered
- [rejected-approaches.md](rejected-approaches.md) — headroom sorting, and why it lost
- [../providers/quota-surfaces.md](../providers/quota-surfaces.md) — the vendor wire contracts
- [../providers/grok.md](../providers/grok.md) — the vendor, end to end
