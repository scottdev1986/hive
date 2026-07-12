# Benchmark threshold / fit policy — ADOPTED, live

**Status: ADOPTED 2026-07-12.** The user approved the 5-point band and then
ordered direct live activation — verbatim: "I do not want shadow at all i
want the real thing live no parrallell path we go live with the real thing."
The three-rule policy below orders real candidate selection in
`deriveRouting`; the shadow/counterfactual apparatus this document once
staged its rollout through is removed by that ruling. Routing telemetry
records the real decision and its evidence basis — what was chosen and why,
never a hypothetical.

## The question this answers

Hive fetches dated, machine-readable benchmark scores from eligible
external sources (today: LiveBench, the sole registered source). The
question this policy answers: **when data exists, how does a score move a
placement decision among candidates that already cleared every other bar?**

## Hard constraints (not proposals — standing rulings this policy must obey)

1. **Absence of benchmark data never excludes.** User ruling, verbatim: "in no
   way do i accept that we have a model or an effort level availible to use
   and no way to use it we need to reconcile that." A model live discovery
   shows as available and entitled, and every effort level it advertises, is
   routable. Unknowns route by vendor facts + user policy (tier→effort
   defaults, capability floors, pins); benchmarks overlay only when present.
   This is structural: benchmark data reaches `deriveRouting` as an
   **ordering-only** input — it reorders an eligible list produced without
   it and has no code path by which to add, remove, or veto a candidate or
   an advertised effort level.
2. **Capability is a hard floor and benchmarks sit above it, not beside it.**
   The floor (codingCapable for coding/review work, the user's standing model
   directives) filters candidates before this policy ever sees them. A score,
   however bad, never pushes a route below the floor; a score, however good,
   never lifts an incapable model over it.
3. **Fit beats rank.** The proper agent for a task is not always the
   highest-rated model; an easier task goes to a cheaper agent capable of
   handling it. This policy must be able to place a *lower*-scoring capable
   model on purpose.
4. **No invented numbers.** Every threshold below is a knob for the user to
   set, with a proposed default named as judgment, not measurement. Hive
   never averages sources or grades their disagreement without an approved
   materiality rule — this document proposes that rule.
5. **Effort is chosen, not defaulted, and only from advertised levels.**
   Benchmark rows may inform the choice among advertised levels; a missing
   row for an advertised level never removes it.

## Where the overlay acts

One named step, in one place. For a tier×kind, the derivation pipeline
already produces an ordered eligible list: pins win, then the capability
floor and entitlement facts, then user policy order. The policy inserts a
single reordering step **after that list exists and before quota
tie-breaking**:

```
pins → capability floor → policy order → [benchmark reorder] → quota headroom
```

The step reorders; it cannot add, remove, or change effort to a level the
vendor does not advertise. Quota pressure still ranks the reordered chain,
and the floor already bounded everything quota can see.

## The mapping, concretely

- **Match rule.** A candidate matches a benchmark row only on exact
  (source, model, effort). No alias guessing beyond the discovery record's
  own alias list, no cross-source averaging, no cross-model inference.
  Within one model, unmeasured effort levels take an *ordinal* position from
  measured ones — user-ruled, spelled out under "Effort and placement
  semantics" below — and an exact-match score always beats an inferred rank
  where both exist.
- **Score column per task kind.** User-visible policy, not compiled:
  coding/review kinds read the source's coding column (LiveBench:
  `code_generation`); if a kind has no mapped column, the overlay is inert
  for that kind. Proposed initial mapping: coding → `code_generation`,
  everything else → unmapped (inert) until the user maps it.
- **Materiality band.** Two matched candidates whose scores differ by less
  than **B points on the source's own scale** are tied; the overlay does not
  reorder ties. Proposed default: **B = 5** (judgment, not measurement — the
  user sets it). Within a tie, the pre-existing policy order stands.
- **Material difference.** When two matched candidates differ by ≥ B, the
  higher-scoring one moves ahead of the lower **within the eligible list**.
  For `cheap`/easy tiers, fit inverts the preference: the *cheapest candidate
  within B of the best matched score* leads — that is "fit beats rank" made
  mechanical.
- **Unknowns hold position — as the last rung.** A candidate with no
  matched row is first offered the weaker evidence ladder of rule 3 below
  (stale measurement, vendor tiering, user pin, in that order); only a
  candidate with none of those keeps its policy-derived position
  unmoved. It never rises on a guess, and every non-measured placement is
  labeled with its basis. The inventory keeps showing benchmark coverage as
  "unknown" either way — placement evidence is not measurement.
- **Staleness.** Only rows from a source whose status is `current` or
  `last-good` participate in score-vs-score reordering. An `unavailable`
  source contributes nothing and the overlay quietly degrades to inert —
  the route always still resolves. Older releases of a qualifying source
  are not discarded, though: they remain admissible, marked stale, for the
  coarse placement of otherwise-uncovered models (rule 3 below).
- **Multiple sources (future).** Today LiveBench is alone. When a second
  eligible source registers, rows stay per-source; a reorder requires the
  sources that cover both candidates to *agree on direction* for the pair.
  Disagreement means tie — shown, not averaged.

## Effort and placement semantics — three user-ruled rules

All three are rulings, not knobs: they hold in this policy and in its live
implementation.

1. **Monotone-effort ordinal inference.** Within a single model, an
   unmeasured lower effort level ranks below that model's measured
   higher-effort variants: if high/xhigh/max are placed, that model's medium
   and low sit below them — and they are still used. The inference is
   **ordinal only**: it produces a position in the ordering overlay, never a
   synthesized numeric score (the accurate-numbers rule holds; no invented
   numbers). Every inferred rank is marked as inferred with its basis —
   e.g. "below claude-fable-5 high, LiveBench 2026-06-25" — in routing
   telemetry and the inventory, so inference is visible and never dressed as
   measurement. An exact-match score beats an inferred rank where both
   exist. Cross-model inference stays forbidden: this is within-model
   ordering only, justified by the vendor's own effort semantics.
2. **Effort economy.** Among candidates that clear the capability floor and
   fit the task's classified needs, prefer the **lowest sufficient effort**
   — unneeded high effort is waste (tokens, resources, quota). This
   generalizes "fit beats rank" to the effort axis: cheap/standard tiers
   should land on lower efforts of capable models rather than idling
   flagship efforts on easy work. Tier→effort policy defaults remain the
   starting point; the benchmark overlay and this rule refine within them.
3. **Uncovered-model placement.** A benchmark-absent model that clears the
   capability floor still routes — coverage-never-gates stands — but its
   position in the ordering comes from **admissible non-benchmark evidence
   of its class**, and a lower-class model gets only the simplest work,
   never hard tasks. Admissible evidence, in priority order (the
   no-judgment line holds: every input is vendor-published or measured,
   never Hive's opinion or training memory):
   1. **Stale measurements** — older releases of qualifying sources (e.g.
      an earlier LiveBench release that did score a haiku variant): real
      dated numbers, marked stale, usable for coarse placement.
   2. **Vendor's own tiering** — the vendor's published positioning,
      pricing, and release data as they appear in discovery and source cost
      files. The vendor calling a model its small/fast/cheap tier is the
      vendor's claim, not ours.
   3. **User policy** — an explicit placement pin the user can set.

   The overall evidence hierarchy for any placement:
   **current measurement > stale measurement (dated) > within-model effort
   inference > vendor-tier placement > unknown-holds-policy-position.**
   Every non-measured placement is labeled with its basis in the inventory
   and routing telemetry — the same visibility discipline as effort
   inference.
   Net effect: haiku-class models live at the bottom of the ordering doing
   the simplest tasks, frontier models never waste effort on trivial work,
   and nothing capable sits unusable.

## What this does today, honestly

LiveBench publishes rows only at xhigh/max-like efforts and covers a subset
of the discovered catalog (at the last live probe: 12/12 models discovered,
LiveBench release 2026-06-25 current, uncovered canonical ids haiku,
auto-review, spark). So on this machine the overlay's real effect at
activation is narrow: it can reorder deep-tier candidates where both sides
have a current matched row at the routed effort; via monotone-effort
inference, place a measured model's unmeasured lower efforts below its
measured ones; and via uncovered-model placement, put the three uncovered
ids where stale LiveBench rows or vendor tiering say their class sits —
haiku at the bottom taking the simplest work. Everywhere else it is inert.
That is the intended shape — sparse data influencing exactly as far as it,
the vendor's own effort semantics, and vendor-published class claims reach,
and not one candidate further.

## Why LiveBench is alone (source survey rationale, not code)

Every surveyed alternative failed the eligibility gate or the evidence
model, and the reasons are worth keeping because they will recur:

- **LiveCodeBench** — 0/12 coverage of the live-discovered catalog, and its
  dates are problem-set dates, not evaluation dates; an undated score is
  "unknown" by the gate.
- **SWE-bench family** — scores a model+agent-harness identity, not
  model×effort; importing those as base-model scores would misattribute the
  evidence this policy acts on.
- **OpenRouter** — requires an API key (fails the no-auth gate) and
  republishes other parties' data, so it also fails original provenance.
- **Artificial Analysis** — removed entirely by user ruling; it is not a
  candidate.

The gate itself stays source-agnostic and fail-closed; any future source
that clears it registers the same way LiveBench did.

## Rollout — what happened

This document originally proposed a three-stage rollout (shadow-annotate →
review measured pairs → activate). On 2026-07-12 the user approved
shadow-annotation and the 5-point band, then superseded the staging
entirely: direct live activation, no shadow, no parallel path — "old path
removed it is dead." The reorder step therefore runs in real route
derivation, the shadow/counterfactual machinery is deleted, and
`benchmarks.mode` remains the hard off switch. Non-shadow freight the
parallel path used to carry — the escalation-count baseline, telemetry
about real decisions and their evidence bases — is kept and rehomed;
counterfactual comparison is not.

## The knobs, as decided

| knob | value | nature |
|---|---|---|
| band width B | 5 points (source scale) | APPROVED (2026-07-12, user) |
| kind → score column | coding → `code_generation`, others unmapped | policy; user-editable |
| cheap-tier fit rule | cheapest within B of best leads | policy |
| staleness | `current` and `last-good` rows only | policy |
| multi-source rule | agreement-in-direction or tie | policy (dormant today) |
| effort inference | within-model ordinal only, labeled inferred with basis | user ruling (decided) |
| effort economy | lowest sufficient effort among floor-clearing candidates | user ruling (decided) |
| uncovered-model placement | stale measurement > vendor tiering > user pin, labeled; lower-class models get only the simplest work | user ruling (decided) |
| activation | LIVE — user ordered direct activation (2026-07-12); shadow stage removed by ruling | user ruling (decided) |

## What the policy explicitly excludes

- No gating: benchmarks never enter candidate *eligibility*, only order.
- No averaging or single blended score across sources.
- No effort invention: no level a model does not advertise, ever.
- No synthesized scores: an unmeasured effort gets a labeled ordinal
  position within its own model, never a number.
- No training-memory placement: every placement input is vendor-published
  or measured; Hive's own opinion of a model is never evidence.
- No self-benchmarking: Hive consumes published rows; it never produces them.
