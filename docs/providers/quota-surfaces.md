# Quota surfaces

Updated: 2026-07-13
Sources: Hive source tree, 2026-07-13; docs/research/provider-quota-surfaces.md
Raw: [Grok spend-sensitivity experiment](../../raw/grok/grok-spend-sensitivity-experiment.md) · [billing BEFORE](../../raw/grok/grok-billing-BEFORE.json) / [AFTER1](../../raw/grok/grok-billing-AFTER1.json) / [AFTER3](../../raw/grok/grok-billing-AFTER3.json) · [live quota verification](../../raw/grok/grok-quota-live-verification.txt) · [model-control snapshot](../../raw/grok/grok-model-control-verification.json)

## Summary

All three vendors will report the **fraction of a rolling window consumed** — for free, with no model turn — and **none** of them reports the window's absolute size. Every number below came off the wire; most of it is absent from the vendors' prose docs. This article records what the surfaces say, and the reasoning rules that keep a guess from being published under a provider's name.

Versions, stated exactly: the Codex and Claude surfaces were driven against **codex-cli 0.144.1** and **claude 2.1.207**, re-checked 2026-07-11. The Grok surface was added later and driven against **grok 0.2.99** on 2026-07-13. Re-verify before trusting any of it against a newer CLI — these are protocol surfaces, not published contracts.

## The shape of the problem

There is no API on any of the three that answers *"how many tokens does my plan include."* Any absolute allowance in Hive is therefore either an operator's planning fiction or an invention — which is why discovered pools are denominated in **percent, with an allowance of exactly 100 by construction**.

All three surfaces are readable **without starting a turn**, so Hive probes them at startup for free. And two of the three meter some models **twice**: once against an account-wide pool every model spends from, and again against a cap belonging to that model alone. A quota number is only useful once you know *which models it governs*.

## Codex — `account/rateLimits/read`

`codex app-server` speaks JSON-RPC 2.0 over stdio. **`initialize` followed by an `initialized` notification is mandatory**; any method sent before the handshake completes is rejected with `"Not initialized"` (`src/daemon/quota-sources.ts:18-19`, `:318`). Then `account/rateLimits/read` (no params) returns the account's limits. No `thread/start`, no `turn/start`, no prompt. It is part of the **stable, non-experimental** protocol, which is why Hive stamps its readings `authoritative`.

The authoritative schema is not in the docs — the binary generates it: `codex app-server generate-json-schema --experimental --out DIR`.

Wire format is **camelCase**. `resetsAt` is **unix epoch seconds**. `usedPercent` is an integer 0–100.

```jsonc
{
  "rateLimits": {                      // the routable, single-bucket view
    "limitId": "codex", "planType": "prolite",
    "primary":   { "usedPercent": 57, "windowDurationMins": 300,   "resetsAt": 1783707918 },
    "secondary": { "usedPercent": 40, "windowDurationMins": 10080, "resetsAt": 1784247113 }
  },
  "rateLimitsByLimitId": {             // metered sub-limits, keyed by an opaque limitId
    "codex_bengalfox": { "limitName": "GPT-5.3-Codex-Spark", "primary": null, "secondary": {…} }
  },
  "rateLimitResetCredits": { "availableCount": 4, "credits": [ … ] }
}
```

**`primary`/`secondary` are positional names, not semantic ones.** Hive sorts by `windowDurationMins` (`quota-sources.ts:142-162`) so a snapshot that lists its weekly bucket first cannot invert the two. A window sorted by a *guessed* duration lands in the wrong bucket silently.

A **null slot in this authoritative response is a positive statement** that the plan has no second meter — but a slot that was non-null and failed to parse is `unknown`, never confident absence. That distinction is one comparison in the code (`quota-sources.ts:204-208`: `reported > parsed ? "unknown" : "not-metered"`). It is not decoration: the live prolite account reports **no five-hour window at all** ([raw verification](../../raw/grok/grok-quota-live-verification.txt) — `codex … 5h: not metered`). Rendering that absence as a *failure* is a bug this exact rule prevents.

`rateLimitResetCredits` is real headroom Hive deliberately does **not** count: the live account carries unspent full-reset grants, redeemable via `account/rateLimitResetCredit/consume`. Burning a human's finite reset grant to admit a spawn is a decision a human should make.

## Claude — the `get_usage` control request, and its statusline twin

`claude -p --input-format stream-json --output-format stream-json` speaks a bidirectional control protocol. Send `control_request` subtype `initialize`, then `get_usage`, and close stdin **without ever sending a user message**: the account's plan usage comes back at `total_cost_usd: 0`. The CLI's own schema calls `get_usage` *"Experimental — the response shape may change"*, which is why Hive records its readings as **`reported`**, not `authoritative` (`quota-sources.ts:617-669`).

```jsonc
{
  "subscription_type": "max",
  "rate_limits_available": true,       // false for API-key, Bedrock, Vertex
  "rate_limits": {
    "five_hour": { "utilization": 6,  "resets_at": "2026-07-10T19:00:00.053408+00:00" },
    "seven_day": { "utilization": 42, "resets_at": "…" },
    "model_scoped": [ { "display_name": "Fable", "utilization": 71, "resets_at": "…" } ],
    "extra_usage": { "is_enabled": false, … }
  }
}
```

**The statusline surface describes the same facts in different words and is parsed SEPARATELY.** `get_usage` says `utilization` with an **ISO-8601** `resets_at`; the statusLine hook input says **`used_percentage`** with `resets_at` in **unix seconds** (`src/cli/statusline.ts:52-68`). Both are 0–100. Both parsers exist, deliberately, in different files. A single parser that assumed one spelling would read the other as absent — which, per the [capability-discovery](capability-discovery.md) rule, is exactly how a guessed key becomes a silent zero.

`model_scoped[]` carries a `display_name` and, in every reading observed, a **null model id** — `rate_limits.limits[]` says so outright: `scope.model: { "id": null, "display_name": "Fable" }`. The pool names its model and withholds its identifier.

Hive calls the control request rather than the `api.anthropic.com/api/oauth/usage` endpoint the CLI itself proxies: the endpoint is undocumented, rate-limits aggressively under polling, and would break silently.

## Grok — ACP `_x.ai/billing` (gauge + guard)

`grok agent stdio` speaks ACP JSON-RPC. After the same free `initialize` + `initialized`, the extension method **`_x.ai/billing` with params `{}`** returns the SuperGrok account's weekly usage (`quota-sources.ts:1100-1106`). **No session, no prompt, no turn** — the probe is spend-insensitive, confirmed by a three-run probe-only control that never moved the number ([spend-sensitivity experiment](../../raw/grok/grok-spend-sensitivity-experiment.md)).

**The leading underscore is mandatory.** Bare `x.ai/billing` returns `-32601 Method not found`.

```jsonc
{
  "config": {
    "creditUsagePercent": 8.0,          // GAUGE: 0–100 used of the weekly pool
    "currentPeriod": {
      "type": "USAGE_PERIOD_TYPE_WEEKLY",
      "start": "…", "end": "…"          // rolling reset, not a calendar week
    },
    "onDemandCap":    { "val": 0 },     // GUARD: money rails, not capacity
    "onDemandUsed":   { "val": 0 },
    "prepaidBalance": { "val": 0 }
  },
  "subscription_tier": "SuperGrok"
}
```

### Gauge vs guard

**`config.creditUsagePercent` is a real usage meter.** It is not inferred: across a measured burn it moved 2 → 3 → 4 → 7 → **8** while the money rails sat flat at zero, and a probe-only control run three times did not move it at all ([BEFORE](../../raw/grok/grok-billing-BEFORE.json) / [AFTER1](../../raw/grok/grok-billing-AFTER1.json) / [AFTER3](../../raw/grok/grok-billing-AFTER3.json)). Two caveats came out of the same experiment and are properties of the surface: **multi-minute lag** (a burn showed up ~5 minutes later) and **coarse integer percent**.

`onDemandCap` / `onDemandUsed` / `prepaidBalance` are **money guards**, never capacity. Their zeros mean *paid overflow is off* — never *empty tank*.

> **Never render a guard as a meter.** A money-rail zero displayed as remaining quota is a fabricated gauge, and it is the mistake this surface most invites.

### Five-hour is a positive `not-metered`

No five-hour field has ever been observed on `_x.ai/billing`. That is **absence by design**, and Hive records `fiveHourMeterState: "not-metered"` (`quota-sources.ts:976-978`) — a positive statement.

But: **a missing percent on a *recognized* surface is `unknown`, never `not-metered`** (`quota-sources.ts:979-982`). The vendor *does* meter the weekly pool; a payload that parses but carries no usable number means Hive failed to read it, not that the vendor said "unlimited." The two states are one line apart in the code and they mean opposite things. (`weeklyMeterState: weekly === null ? "unknown" : "metered"`.)

Grok's weekly pool binds account-wide as `models: ["*"]` (`quota-sources.ts:975`), so **it needs no display-name join** — unlike the two below.

## Binding a pool to the models it meters

Neither Claude's nor Codex's quota payload carries a model id. Codex keys a sub-pool by an **opaque codename** (`codex_bengalfox`) and *names* it `"GPT-5.3-Codex-Spark"`. Claude reports a `display_name` next to an explicit `id: null`. Both name the model exactly the way **their own model catalog** names it, and both publish that catalog for free — so the binding is *discovered* by joining the pool's provider-given name against the provider's own display names. See [capability-discovery.md](capability-discovery.md).

Three consequences, and they are the whole point:

> **A model is gated by every pool that meters it, and the tightest one governs.**

Checking only the *first* matching pool is what put two deep-tier agents onto a model whose own weekly pool sat at **99%**: the general pool had 39% of its week left and said yes, while the model's dedicated pool had 1% and was never asked. A run that spends from two meters holds a reservation in **each**, reserved atomically only after every pool fits (`src/daemon/quota-ledger.ts:1178-1215`).

**A model with no cap of its own is metered by the general pool — never by nothing.** Minting a phantom per-model pool for it and reporting "usage unknown, routing unconstrained" invents a meter *and* does the worst possible thing with it: an unconstrained model is the most attractive route there is, so the phantom actively pulls traffic toward itself.

**Every id form of a model binds to the same meter.** One model reaches Hive as a bare id, a `[1m]` variant, an alias, and the literal `default`. One meter. Otherwise a spawn could dodge an exhausted pool by pinning the same model under a different one of its own names.

## What a usage number means, and what it may be called

**A measurement beats an estimate.** The provider's reading already counts everything spent before it was taken — Hive's own runs included. The only spend it cannot know about is what happened *after* it, and that, and only that, is what Hive adds:

    used = reportedUsed + (ledger spend recorded after that reading)

> **"After" is a position in the ledger's commit sequence, not a wall-clock time.**

Every spend row carries the sequence number it was committed at; every reading stores the last spend it could already have counted. The obvious alternative — compare the spend's `occurredAt` to the reading's `observedAt` — **cannot work**, because a wall clock is not a happens-before relation. Two events sharing a millisecond have no order in it at all. A strict `occurredAt > observedAt` silently *drops* a spend landing in the reading's own millisecond: not in the provider's snapshot, not in the spend-since, gone. Widening to `>=` moves the same failure to the other side and double-counts. A sequence has the ordering the clock never had. At the boundary the tie goes to counting, deliberately: over-counting refuses a spawn that would have fit and the next reading takes it back; under-counting spends quota the user does not have and nothing downstream corrects it.

> **The label describes the number published, not the reading it was built from.**

The most embarrassing failure in this system's history: `hive quota` reported 12% of the Codex week consumed, stamped `source: provider, confidence: authoritative`, while the provider's payload said `usedPercent: 0` and the user could see 100% available on his own screen. Every one of those 12 points was Hive's own per-tier estimate, written to the ledger at `confidence: "estimated"` and then **published under the provider's badge**. If any part of a figure is Hive's estimate, the figure is `estimated`. `authoritative` is reserved for a number the provider alone produced.

### "Conservative" was the bug, twice

Both of the failures above were *defended in comments as the safe direction*.

- The **`max()` quota floor**: usage was `max(Hive's entire ledger for the window, reading + spend since)` so that "an optimistic provider number can never free capacity Hive knows it spent." Every word of that holds except **knows**. Hive never knew — it guessed, from a static per-tier table. The floor let the guess outrank the measurement, and once the guess won the `max()` it *inherited the measurement's provenance*. That is how an invented number came to wear the word `authoritative`.
- The **200k context denominator**: pinned so an inflated percentage "errs toward recycling early rather than silently degrading." It clamped live agents at a fake 100% full and had the orchestrator burning quota re-briefing agents it should have kept (`src/cli/statusline.ts:125-133`).

The rule is not "never be conservative." It is: **name what each direction of error actually costs before calling one of them safe.** A confidently wrong number is worse than an admitted unknown, because the unknown invites a question and the wrong number closes it.

## The model-vendor / pool-provider guard

A spend belongs to the vendor whose model produced it. The ledger holds one row that disagrees — a Claude model's usage billed to the Codex meter, written when routing chose `tool=codex` while the caller had pinned a Claude model. The guard now lives at the **write** (`src/daemon/quota-ledger.ts:1041-1103`), and its states are kept carefully apart:

- **claimed** by a catalog, and the vendor disagrees with the pool → **throw**.
- **unclaimed** — every vendor's catalog was read and *none* lists the model → **throw**. That is a measurement.
- **no catalog read at all** → absence of evidence, which may not be converted into a yes *or* a no. Hive falls back to the name's shape, which can still prove a contradiction but can never *grant* permission.

The predecessor asked a regex (`modelVendor()`) and treated its null — "I cannot place this name" — as **permission**. Unknown read as yes, in the one guard whose entire purpose is to refuse. The bad row stays in the ledger, visible: a misattributed past that can be seen is better than a smoothed one that cannot.

## Probing safely

**Both CLIs treat an unrecognized subcommand as a prompt and will run a billable session.** `claude models` is not a subcommand; it bills, and exits 0. This is why the Grok default-model probe uses only the real `grok models` subcommand, and why the Grok capability probe additionally demands a **liveness signal** rather than trusting exit 0 (see [capability-discovery.md](capability-discovery.md)). Confirm every argument against `--help`; prefer the declared control/RPC surfaces over argv.

## See Also

- [Capability discovery](capability-discovery.md) — the catalog side of the pool→model join
- [Grok](grok.md) — the vendor whose only quota surface is `_x.ai/billing`
- [Launch mechanics](launch-mechanics.md)
- [Quota and headroom](../routing/quota-and-headroom.md) · [Routing policy](../routing/routing-policy.md) · [SPEC §6](../../SPEC.md#6-who-picks-the-model)
