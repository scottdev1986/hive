# Grok routing fit — when Hive routes work to Grok, and how it decides

**Status: DESIGN.** Companion to the Grok discovery and quota findings. This
document answers one question in the repo's own routing
vocabulary: how does the dynamic router **discover** Grok's models, **fit** them to
tiers, and decide **when** Grok is the right route — automatically, and still
correctly when xAI ships a new model next week. It obeys the standing rulings in
`docs/benchmark-fit-policy-proposal.md`, `docs/model-selection.md`, and
`docs/research/provider-quota-surfaces.md`; nothing here is a manual routing table.

Evidence discipline: every factual claim below is marked **measured** (model and
catalog behavior verified against Grok 0.2.93; quota behavior verified against
Grok 0.2.99),
**documented** (an official xAI docs URL), or **UNKNOWN**. The Grok CLI ships
multiple releases per day including breaking changes (measured: 0.2.92 and 0.2.93
both dated 2026-07-08 in the shipped changelog), so every measured claim is
version-stamped and must be re-verified by the drift guard (§1.4), never trusted
across versions.

## 0. The vendor in one paragraph

Grok Build is xAI's official CLI (documented: https://docs.x.ai/build/overview).
Under the user's SuperGrok subscription it authenticates by grok.com session, calls
`https://cli-chat-proxy.grok.com/v1`, and exposes exactly **two** models (measured):
`grok-4.5` (context 500,000; reasoning efforts `low|medium|high`, default `high`)
and `grok-composer-2.5-fast` (context 200,000; no effort levels). CLI usage is
**plan-billed** against a shared weekly pool, not API credits; the account's
on-demand cap is 0, so pool exhaustion **blocks instead of billing** (measured:
`onDemandCap.val: 0` on the `_x.ai/billing` wire). ACP `_x.ai/billing` exposes
`config.creditUsagePercent`, a coarse 0–100 used gauge that moved after controlled
model spend while the money rails stayed zero. `config.currentPeriod` supplies
the weekly boundary. The surface contains no five-hour window, so weekly is
metered and five-hour is positively not metered.

## 1. Discovery — the catalog is the source of truth

Grok joins the same contract Claude and Codex already honor: **the binary ships
with no model knowledge** (user directive, `docs/model-selection.md` §"What this
is"). No Grok model name appears in code, ever. The catalog is read from the
vendor at runtime.

### 1.1 The surface

Two-step read, both free and non-billable (measured):

1. `grok models` — session-authenticated listing, completes non-interactively in
   ~0.6 s, and **refreshes** `~/.grok/models_cache.json` from
   `https://cli-chat-proxy.grok.com/v1/models` (measured: `fetched_at` advances on
   each run; the file records `origin`, `etag`, `grok_version`, `auth_method`).
   Its stdout also names the account's **default model** ("Default model:
   grok-4.5", measured) — this is Grok's equivalent of the "vendor's effective
   default" that the derivation ladder's *derived* rung reads for the other two
   vendors.
2. Parse `~/.grok/models_cache.json` for the structured record: per-model `id`,
   `context_window`, `hidden`, `reasoning_efforts` (each level with `id` and
   `default`), `supports_reasoning_effort`.

The command-then-file pair is deliberate: the command proves the read is live and
authenticated; the file carries the structure the command's stdout does not. The
`fetched_at` in the file must postdate the command's invocation, else the refresh
silently failed and the read is `stale`, not current. (Positive control per Hive
protocol: `grok models` stdout must list at least one model — an empty parse of
the cache with a non-empty stdout is a parser bug, not an empty vendor.)

**Never probe Grok by guessed argv.** Measured by bella during quota binding: a
bare positional argument is treated as a **prompt** and runs a billable turn that
exits 0 — the same trap `docs/research/provider-quota-surfaces.md` §"Probing
safely" records for Claude and Codex. Every Grok invocation Hive makes must be a
flag-confirmed subcommand (`grok models`, `grok --version`, `grok agent stdio`).

An ACP-native catalog surface (a `models/list`-equivalent over `grok agent
stdio`) may exist — the binary carries `x.ai/models/update` strings — but was not
probed: **UNKNOWN**. If one is later verified it can replace the file read; the
contract (live, free, structured, per-model efforts) stays the same.

### 1.2 Cadence

Same cadence class as the existing capability discovery for Claude and Codex: at
daemon startup, on the standing refresh interval, and on any Grok spawn failure
(a failed spawn is evidence the world changed). The read is sub-second and free;
there is no reason to cache it past the standing TTL.

### 1.3 When the catalog changes underneath us

Exactly the existing rules, no Grok exceptions:

- A model that **appears** becomes a candidate on the next derivation — nothing
  to edit, because nothing was compiled in.
- A model that **vanishes** stops being derivable; cells that resolved to it fall
  to `ladder:last-known-good` replayed at its true age, then to refusal
  (`src/schemas/routing-derivation.ts`, `ResolutionLayer`). A vanished model is
  never silently substituted.
- **Effort levels are per-model facts from the record, never assumptions.** The
  tier effort policy (deep=`high`, standard/review=`medium`, cheap=`low`) is
  passed only when the resolved model's record advertises that exact level —
  grok-4.5 advertises `low|medium|high` (measured), so all current tier defaults
  land; `grok-composer-2.5-fast` advertises none, so it takes no effort flag,
  exactly like Haiku. Whether Grok ever accepts `xhigh`/`max` is **UNKNOWN** —
  the API docs show `xhigh` only for a different model family on a different
  surface (documented: https://docs.x.ai/developers/model-capabilities/text/reasoning)
  — and the rule already covers it: trust the per-model list, pass nothing it
  does not advertise.
- The catalog read is **version-stamped**: record `grok --version` (parse
  `^grok (\S+) \(([0-9a-f]+)\) \[(\w+)\]$`, measured format) and the cache's
  `etag`/`grok_version` with every discovery record.

### 1.4 Drift guard

The Grok surfaces Hive binds to (models cache shape, `_x.ai/billing` payload,
headless flags) are **undocumented and fast-moving**. On any parse failure,
schema-shape mismatch, or CLI version change since the last verified read: the
affected reading degrades to its honest state (`stale` if replaying an old value,
refusal/`missing` if there is nothing to replay), and the failure is surfaced
loudly the same turn. Never a silent fallback, never an invented value — the
measure-or-say-unknown rule is not Grok-optional.

## 2. Fit — tier placement under the adopted benchmark policy

The question "is grok-4.5 deep or standard?" is not answered here, because under
`docs/benchmark-fit-policy-proposal.md` it is not a document's question to answer.
The pipeline answers it per tier×kind:

```
pins → capability floor → policy order → [benchmark reorder] → quota headroom
```

What this document specifies is only what evidence Grok's models bring to each
stage, and what happens while that evidence is thin.

### 2.1 What the evidence is today

- **Current benchmark rows:** whether LiveBench (the sole registered source)
  covers `grok-4.5` or `grok-composer-2.5-fast` at any effort is **UNKNOWN** —
  it is a question the source registry answers at fit time, live, and never this
  document. If matched rows exist, the overlay reorders on them exactly as it
  does for Claude and Codex; nothing Grok-specific is needed.
- **Vendor tiering** (the admissible fallback evidence class, rule 3 of the
  policy's uncovered-model placement): xAI positions `grok-4.5` as its frontier
  general/coding model — "For everything else, including code, use Grok 4.5. It
  is the most intelligent and fastest model we've built" (documented:
  https://docs.x.ai/developers/models) — and the subscription catalog's own
  record describes `grok-composer-2.5-fast` as a fast coding model with a `-fast`
  name, a smaller context, and no reasoning-effort control (measured,
  models_cache.json). Pricing for grok-4.5 is published ($2.00/$6.00 per 1M
  in/out, documented, same URL); composer's is absent from the API price list:
  **UNKNOWN**.

### 2.2 The provisional fit, labeled as such

Applying the policy's evidence ladder (current measurement > stale measurement >
within-model effort inference > vendor tiering > unknown-holds-position), with
only vendor tiering in hand:

- `grok-4.5` enters eligible lists as **frontier-class by vendor claim** — a
  candidate for `deep`/`standard`/`review` work *if the user's capability floor
  admits it* (floors are the user's allowlist; Hive never judges quality — the
  no-model-judgment ruling). Its placement basis is labeled
  `vendor-tiering (docs.x.ai/developers/models, 2026-07-12)` in the inventory and
  routing telemetry, exactly as the policy requires for every non-measured
  placement.
- `grok-composer-2.5-fast` enters as **fast/cheap-class by vendor claim** —
  bottom-of-ordering placement doing the simplest work, the same slot the policy
  gives haiku-class models. `cheap` is floor-exempt by design
  (`tierIsFloorBound`, `src/schemas/routing-derivation.ts`), so it is routable
  there immediately.
- **Coverage never gates**: both models are routable the moment discovery shows
  them entitled, benchmark row or not (standing ruling 1 of the fit policy).
  Absence of evidence moves nothing up; it only holds position.

An honest provisional fit labeled provisional beats a confident wrong one; this
one claims nothing beyond what the vendor published and says so on every spawn
that uses it.

### 2.3 What promotes the provisional fit to a real one

1. A `current` LiveBench row matching exact (source, model, effort) — the moment
   one exists, measurement outranks vendor tiering automatically; nothing to
   configure.
2. Hive's own **escalation counts per model × tier** (an existing surface,
   `docs/model-selection.md` §"Self-escalation"): these are measured operational
   evidence of fit, and §5 makes them this design's primary falsifier. They do
   not reorder candidates (Hive does not self-benchmark — standing exclusion),
   but they tell the *user* when to write a floor or a pin, which are the
   authorities that do move placement.

What is explicitly **not** done in the meantime: no compiled
`TIER_PREFERRED_TOOL` change to prefer grok anywhere. The shipped tier policy
names vendors, and adding a third vendor to it is a user-policy decision made in
`routing.toml` (or a future user ruling), not a default this document smuggles in.
Out of the box, Grok is *eligible everywhere its evidence class and the user's
floors allow, preferred nowhere* — the user's stated intent ("use grok when it is
appropriate") is enacted by eligibility plus the pressure policy of §4, and can be
strengthened any day with a one-line pin.

## 3. The measured weekly pool — quota policy

Grok's quota surface is ACP `_x.ai/billing` over `grok agent stdio` (underscore
prefix mandatory; the bare method returns -32601). `config.creditUsagePercent`
is a 0–100 used gauge of the shared SuperGrok weekly pool. A controlled
spend-sensitivity experiment moved it from 7% to 8% after model work while
`onDemandCap`, `onDemandUsed`, and `prepaidBalance` remained zero. Probe-only
controls did not move it. The reading is therefore quota usage, not a money
credit fraction.
The raw timeline and controls live in
`artifacts/grok-spend-sensitivity-experiment.md`; the wire contract is summarized
in `docs/research/provider-quota-surfaces.md` §“Grok — ACP `_x.ai/billing`.”

### 3.1 What the pool record honestly contains

Register one account-wide Grok subscription pool; all Grok models bind to it.
Its record carries:

- **Weekly level:** `creditUsagePercent`, used percent with `reported`
  provenance. The reading is coarse integer percent and may lag model spend by
  several minutes. Hive preserves that provenance and timestamp rather than
  upgrading it to an authoritative or instantaneous claim.
- **Weekly window:** `currentPeriod.start/end`, with the duration derived from
  those boundaries. The parser reads the payload rather than hardcoding seven
  days.
- **Five-hour window:** `not-metered`, based on positive absence from the
  recognized surface. Grok does not acquire a fictional short window.
- **Money rails:** `onDemandCap`, `onDemandUsed`, and `prepaidBalance`. These
  answer whether overflow can cost money, not how much weekly capacity remains.
  A nonzero rail triggers the existing spend-safety policy; it never becomes a
  quota percentage.

If a recognized weekly surface lacks a usable `creditUsagePercent`, the weekly
window is `unknown`/READ_FAILED. It is not `not-metered`, because positive
controls established that the vendor meters this window. AUTO routing excludes
the candidate after the last-known-good freshness allowance; an exact user
choice remains subject to the ordinary consent, capability, and money-safety
gates rather than being silently substituted.

The rejected design treated the weekly pool as unmeasurable and waited for a
limit-shaped model failure to infer exhaustion. That was faithful to earlier
captures in which the percentage was absent, but it no longer matches the wire.
It loses because controlled spend established a real gauge, and discarding that
reading would deliberately replace measurement with failure inference.

### 3.2 Exhaustion and reset

The ordinary measured-pool gate owns exhaustion. Before AUTO dispatch, Grok's
weekly used percentage, outstanding reservations, and task estimate must fit the
pool. At `currentPeriod.end`, Hive re-reads `_x.ai/billing`; it does not invent a
full tank from the clock alone. A limit-shaped call failure remains valuable
evidence of parser lag or provider drift and is logged verbatim, but it is no
longer the primary capacity detector.

The meter's coarse resolution and lag are the named costs. A task can begin
against a reading that has not caught up with recent work. Reservations and the
separate Hive assignment ledger reduce concurrent oversubscription; neither is
rendered as provider-reported usage. If observed failures show that the lag
exceeds the safety margin, policy can reserve more conservatively using measured
failure evidence rather than pretending the gauge is absent.

## 4. Spreading load — Grok is a peer, not a pressure valve

The user's words are: "I want to spread more work out to more capable agents."
Grok enters the same two-stage router as Claude and Codex. Consent, capability,
availability, weekly affordability, and money safety decide whether it is
eligible. Provider-level weighted fair dispatch over Hive-observed assignments
then decides which eligible provider receives the next AUTO task, as specified
in `routing-distribution-and-auto-selection.md`.

Quota percentages do not rank the three vendors against one another. A Grok
weekly percentage, a Codex plan-dependent window, and Claude's five-hour plus
weekly windows describe different constraints. Each provider's readings gate
that provider; Hive's assignment ledger supplies the common distribution
currency. Grok receives work because it is capable, consented, affordable, and
behind its earned share—not because another vendor's meter is low.

The rejected pressure-valve policy preferred Grok when Claude or Codex showed
pressure because an unseen Grok limit appeared cheaper to probe. Two facts
defeat it: Grok's weekly limit is visible, and capability-first fair dispatch
does not need a sacrificial vendor. Keeping the valve would slam Grok precisely
when other vendors are constrained, recreating the load-concentration bug this
router is meant to remove.

The remaining risks are narrower:

1. **Lagged weekly readings.** Integer percent can trail recent work, so
   reservations and active-assignment accounting remain necessary.
2. **Shared-pool coupling.** Other Grok products can consume the same weekly
   pool. The gauge observes the aggregate after its reporting lag but cannot
   attribute consumption to Hive.
3. **Quality dumping.** Distribution never overrides the capability floor.
   Escalation telemetry by model and tier remains the tripwire for provisional
   fit.
4. **No intra-vendor escape.** All Grok models drain the account-wide pool; an
   exhausted weekly pool removes the vendor, not merely one model.

## 5. What would falsify this design, and what Hive logs to see it

| # | Observation | What it falsifies | Where it must be visible |
|---|---|---|---|
| 1 | Grok escalation rate per model × tier materially above Claude/Codex peers at the same tier | the §2.2 provisional fit (vendor tiering overstated the class) | existing escalation counters on the routing inspection surfaces; per-vendor comparison view |
| 2 | A Grok limit failure while the fresh post-reservation weekly reading says the task fits | the §3.2 lag allowance or task estimate | verbatim failure beside the reading, reservation, estimate, and decision |
| 3 | Any money rail nonzero (`onDemandCap`, `onDemandUsed`, `prepaidBalance` moves) | the no-paid-overflow premise | same-turn alert; existing spend-safety policy decides AUTO eligibility |
| 4 | A recognized weekly surface repeatedly omits `creditUsagePercent` | the meter availability assumed by §3 | weekly state becomes READ_FAILED/unknown, never NOT_METERED; freshness and refusal are visible |
| 5 | Billing payload schema drift or a `grok --version` change breaking any parser | the binding assumptions of §1/§3 wholesale | drift-guard alert; affected readings degrade to stale/unknown loudly |
| 6 | A spawn carrying an effort Grok rejects | the per-model effort trust of §1.3 | spawn failure reason names the effort and the record it came from |
| 7 | LiveBench (or a future registered source) publishes Grok rows that *contradict* vendor tiering (e.g. grok-4.5 scoring below the cheap-class line) | §2.2's fallback placement — measurement wins automatically, but the delta is worth an alert because it means vendor claims misled the interim | benchmark overlay telemetry: basis flip from `vendor-tiering` to `measured` recorded with both values |

Required log lines (all stamped with `grok --version` and, where relevant, the
models-cache `etag`): every Grok route decision with its placement-basis label;
every `_x.ai/billing` reading and meter classification; every Grok spawn/turn
failure verbatim; every weekly fit, exhaustion, and reset transition with its
reading, reservation, and evidence.

## 6. Implementation inventory (for the implementing agent; not design)

Adding a third vendor crosses hard `["claude", "codex"]` walls that will not
bend silently — the type checker will name most of them. Known at writing:
`RoutingPinSchema.tool` / `RoutingFloorsSchema` / `SnapshotToolSchema`
(`src/schemas/routing-derivation.ts`), `QuotaLimitSchema.provider`
(`src/schemas/quota.ts`), the adapter layer (`src/adapters/tools/` gains a grok
adapter beside `claude.ts`/`codex.ts` — spawn flags are documented at
https://docs.x.ai/build/cli/headless-scripting and were verified against
`grok --help` 0.2.93), the spawner's vendor binding, and `CredentialIssuer`
(`src/daemon/spawner-impl.ts`). The headless invocation surface Hive would bind:
`-p/--single`, `--output-format json|streaming-json`, `--json-schema`,
`--permission-mode`, `--resume`, `--session-id`, `grok agent stdio` for the
billing read (all measured, 0.2.93). Grok's native subagents and worktrees
(`--agents`, `-w`) overlap Hive's own orchestration and must be disabled or
scoped deliberately at spawn.
