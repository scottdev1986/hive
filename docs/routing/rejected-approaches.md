# Rejected Approaches — where the dead routers are buried

Updated: 2026-07-13
Sources: Hive source tree, 2026-07-13; `docs/benchmark-fit-policy-proposal.md`; `docs/research/dynamic-model-router.md`; `docs/research/dynamic-router-adoption.md`; `docs/model-selection.md` (Layer 1); `docs/research/model-routing-and-token-efficiency.md`

## Summary

Six routing designs were adopted and then killed. This article records what each was,
why it was adopted, and why it died, so nobody rebuilds one.

The source documents were retired with the designs they described. Several of them
asserted in the present tense that machinery was live which had already been ripped out
— one was still marked "ADOPTED, live" the day after its code was deleted. If one
resurfaces from git history, **treat this article as the correction.**

## 1. Tiers (`deep` / `standard` / `cheap` / `review`)

**What it was.** Four tiers, a compiled `TIER_PREFERRED_TOOL` table (deep/review →
claude, standard/cheap → codex), a `TIER_EFFORT_POLICY` ladder, and `deriveRouting`
producing a route per tier×vendor.

**Why it died — the founding incident, 2026-07-10.** Every Codex tier's model column said
`"default"`. `resolveConcreteModel` read that from `~/.codex/config.toml` — the file
naming whatever the human last picked for their own interactive use. For most of that day
it named the frontier model. So **every Codex agent ran the frontier model at every
tier.** The receipts survive in `agents.executionIdentity`: cheap-tier agents launched as
`{"tool":"codex","model":"gpt-5.6-sol","effort":"low"}`. Standard-tier frontier work took
18 turns across 8 agents; cheap-tier another 4 across 4 — routine work, on the most
expensive model available.

Claude never had this problem, and **the asymmetry is the whole story**: Claude's column
named concrete aliases that resolved per tier; Codex's said `"default"` and inherited a
human's preference.

> **A tier system that lowers the effort flag but not the model is not a tier system.**

This is the origin of the entire no-quiet-defaults rule, and why `ExactModelIdSchema`
(`routing-policy.ts:60-66`) now refuses the literal string `"default"` as a model id.

**Replaced by** nine categories plus a user-authored `default` chain. Note the diagnosis:
the failure was **never "four tiers is too few"** — it was *the values behind the tiers*.
More tiers would have failed identically.

**Do not rebuild:** a compiled vendor-preference table, a tier→effort ladder, or any route
source that resolves a model id through a file the user edits for other reasons.

## 2. External benchmark ranking (LiveBench)

**What it was.** A benchmark overlay that reordered eligible candidates by published
scores, inserted at one point: `pins → capability floor → policy order →
[benchmark reorder] → quota headroom`.

**Why it was adopted.** `benchmark-fit-policy-proposal.md` was titled *"Benchmark
threshold / fit policy — ADOPTED, live"*, stated **"Status: ADOPTED 2026-07-12"**, and
recorded the user ordering direct live activation with no shadow path.

**Why it died.** The router redesign's PR1 — *"Delete the external ranker (LiveBench)
entirely"* — landed **one day later** (commit `5ea3a5d`). `deriveRouting` does not
exist. `benchmarkFit` does not exist. There is no benchmark source registry.

It was **the most dangerous document in the repo**: marked ADOPTED and LIVE, describing
machinery deleted the following day. That one-day gap is the cautionary tale — a status
header is the first thing to go stale and the last thing anyone updates. The sole code
vestige is `src/schemas/config.ts:59-66`, where `benchmarks.mode` is explicitly marked
**VESTIGIAL** — *"Nothing reads this value."*

**What is durable and must survive.** The **source survey** — because these failure
modes recur every time someone proposes an external ranker:

| Source | Verdict | Why |
|---|---|---|
| **LiveBench** | Passed | Dated, machine-readable, no auth, original provenance |
| **LiveCodeBench** | Failed | 0/12 coverage of the live catalog, and its dates are **problem-set dates, not evaluation dates** — an undated score is "unknown" by the gate |
| **SWE-bench** family | Failed | Scores a **model+agent-harness identity, not model×effort**; importing them as base-model scores misattributes the evidence |
| **OpenRouter** | Failed twice | Requires an API key (**fails the no-auth gate**) and republishes others' data (**fails original provenance**) |
| **Artificial Analysis** | Excluded | Removed by user ruling; not a candidate |

And these principles, which outlived the machinery:

- **Fit beats rank.** "The proper agent for a task is not always the highest-rated
  model; an easier task goes to a cheaper agent capable of handling it." A policy must
  be able to place a *lower*-scoring capable model **on purpose**. This survives today
  as `hive-decides` effort choosing the *lowest sufficient* level
  (`src/daemon/effort.ts:100-110`).
- **No gating, only ordering.** "Absence of benchmark data never excludes." User
  ruling: *"in no way do i accept that we have a model or an effort level available to
  use and no way to use it."* Capability is a hard floor; a score never lifts an
  incapable model over it, and never pushes a capable one below it.
- **Hive consumes benchmarks, never produces them.** No self-benchmarking. And its
  companion: **"Hive's own opinion of a model is never evidence."**
- The evidence hierarchy: *current measurement > stale measurement > within-model
  effort inference > vendor-tier placement > unknown-holds-policy-position.*

**Why the whole thing still lost:** even correct, it made Hive the ranker. The
redesign's answer is that *the user is the router* — fit is **authored**
(`modelCategoryFit`), not scored.

## 3. The signed candidate manifest

**What it was.** A fetched, cryptographically signed manifest of candidate model
lists, with a signing pipeline, a kill switch, a shadow mode, and a
`routing-shadow.jsonl` counterfactual log. Designed to let route data ship without a
binary release.

**Why it died.** The user's directive (2026-07-12) removed *all* compiled model
knowledge as a route source, and then the redesign removed derivation itself — leaving
nothing for a manifest to feed. The user also rejected the parallel path outright:
*"I do not want shadow at all i want the real thing live no parallel path"* and
*"old path removed it is dead."*

**Vestiges:** `src/schemas/config.ts:57-58` still parses `routingManifest` and `router`
as **no-ops**. The comment is explicit — both were escape hatches back to the
compiled-in table and the manifest, "**both of which were removed as route sources**…
setting them changes nothing."

**Durable principle:** shadow modes and dual routers are a permanent tax. The redesign
banned them by name — *"a per-spawn 'new failed → old' is a money and consent bug"*,
and **"No permanent dual-router flag."** See
[routing-policy.md](routing-policy.md) — *never fall back from the new path to the old.*

## 4. `{mode: 'vendor-default'}` chain entries

**What it was.** A second legal chain-entry form meaning "whatever this vendor
currently calls its default", re-resolved from live discovery at every spawn and
rendered in the UI as volatile.

**Why it was adopted.** It looked like it preserved a legitimate user intent — *"keep
me on this vendor's current default"* — without a compiled model id.

**Why it died.** User ruling, 2026-07-13:

> "we are specific on the models that we choose"

Commit `0dc25c0` removed it. `ChainEntrySchema` (`routing-policy.ts:77-81`) now has
**only** the exact form. The schema comment records the reasoning: **a vendor default
is a quiet default, and quiet defaults are the defect this store exists to delete.**
Vendors also move their defaults server-side mid-session (repo memory:
*vendor-default-model-moves-under-you*) — *an indirection that cannot be written cannot
bite.*

Note the surviving cousin: `provider-controlled` **effort** is still legal. It omits the
flag and explicitly *does not claim to know* what the vendor will pick. Choosing not to
send a value is honest; recording a moving pointer as if it were a choice is not.

## 5. The five-dimension model rubric

**What it was.** Replacing tiers with a dimension vector — risk, complexity,
uncertainty, context load, tool intensity — passed through the spawn API.

**Why it died — rejected twice.** The decisive argument came from the dynamic-router
research itself: its own rubric **collapses
the five dimensions to a tier by a max rule *before* routing.** The dimensions are how
the orchestrator should **think**, not what the machine needs to **receive**. Passing
them through the API adds "five judgment surfaces to misjudge, five fields to validate,
and zero routing power the tier doesn't already carry."

The rubric itself survives — as *guidance for the classifier*, not as a wire format.
See the max-risk rule in [quota-and-headroom.md](quota-and-headroom.md#the-task-rubric).

**Permanently rejected in the same breath:** letting the orchestrator name models
outright. The founding reason — **an LLM's model knowledge froze at training**
(SPEC §6). Exact ids therefore come from discovery; the remaining helper only
recognizes Claude- and Codex-shaped names (`src/adapters/tools/models.ts:1-15`).

## 6. Inferring capability from the vendor catalog

**What it was.** Reading each vendor's model list and placing models into categories
automatically from what the catalog says.

**Why it died — the durable finding.** **Neither vendor declares capability.** There is
no `codingCapable` field, no tier, no rank, no strength score in any catalog Hive reads.
The only strength-adjacent field is **marketing prose in `description`**.

Parsing that prose to place a model is inference-from-names with extra steps — the same
failure as `modelVendor`'s regex, dressed up. It would make Hive the ranker again while
looking like measurement.

**What the catalog *is* good for**, and is used for: exact model ids, aliases, advertised
effort levels, `supportsEffort`, entitlement-by-presence, hidden flags, and Claude's
advertised context variant — all
**facts the vendor publishes about itself**. That is `identifyModelVendor` and
`CapabilityRecord`. See
[../providers/capability-discovery.md](../providers/capability-discovery.md).

**The line:** a vendor is authoritative about *what it offers*. It is not authoritative
about *how good it is*, and neither is Hive. Only the user is, and their chain
placements are the record of it.

## The measured token facts that justify the scoped brief

Measured 2026-07-10 (recorded in the retired token-efficiency research doc, by
differencing two `claude -p` runs), preserved because they set the priority order for
every future context optimization:

| Approach | Input tokens |
|---|---|
| `SPEC.md` embedded whole | **18,726** |
| A scoped brief naming a section (`SPEC §6`) | **1,882** |
| An outline-only brief | **421** |

> **The document lever is two orders of magnitude bigger than the other three
> combined.**

A single naive `SPEC.md` read costs more than the entire spawn prompt, the entire MCP
surface, and the memory index put together — roughly thirty times over — and it was
paid by *every design-touching agent, on every spawn*. Everything else on the
optimization list is worth doing because it is **free, not because it is large**.

Read the table for its shape, not its digits. It is the whole reason the scoped brief
exists — see [../agents/briefing.md](../agents/briefing.md).

## The rejected-alternatives principle

The rule that decided several of the calls above, and should decide the next one:

> **Automatic in the safe direction (removal, degradation). Ask in the risky direction
> (adoption, promotion).**

Hive may automatically *demote* a model, drop a stale reading to unknown, or refuse a
launch. It may **not** automatically promote, enable, reorder from telemetry, or widen
a pool. The MCC shows evidence; the user re-ranks. *"Hive proposes reorders; it never
applies them."*

## See Also

- [routing-policy.md](routing-policy.md) — what replaced all of this
- [quota-and-headroom.md](quota-and-headroom.md) — including the headroom-sort that also lost
- [model-control-center.md](model-control-center.md) — the surface where the user does the ranking
- [../agents/briefing.md](../agents/briefing.md) — the scoped brief the token table justifies
- [../providers/capability-discovery.md](../providers/capability-discovery.md) — what a catalog can and cannot tell you
- [../../SPEC.md](../../SPEC.md) §6 — the orchestrator classifies; discovered policy resolves
