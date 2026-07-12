# Grok routing fit — when Hive routes work to Grok, and how it decides

**Status: DESIGN, 2026-07-12.** Companion to the Grok discovery findings (2026-07-12,
bernard + bella). This document answers one question in the repo's own routing
vocabulary: how does the dynamic router **discover** Grok's models, **fit** them to
tiers, and decide **when** Grok is the right route — automatically, and still
correctly when xAI ships a new model next week. It obeys the standing rulings in
`docs/benchmark-fit-policy-proposal.md`, `docs/model-selection.md`, and
`docs/research/provider-quota-surfaces.md`; nothing here is a manual routing table.

Evidence discipline: every factual claim below is marked **measured** (verified on
this machine, 2026-07-12, against `grok 0.2.93 (f00f96316d4b) [stable]`),
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
`onDemandCap.val: 0` on the `x.ai/billing` wire). The pool's remaining level is
**unmeasurable** on every surface that exists today (measured: the only billing
surface, ACP ext_method `_x.ai/billing`, carries no allowance/remaining/percent and
is byte-identical before and after a completed turn). The weekly window is a
rolling 7 days anchored to the subscribe instant; its end
(`config.currentPeriod.end`) **is** measurable and free to read.

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

## 3. The unmeasurable pool — quota policy

This is the crux. Claude and Codex have session-free, non-billable, percent-
denominated pool readings (`docs/research/provider-quota-surfaces.md`). Grok has a
weekly pool that **exists** but publishes **no level**: the only billing surface,
ACP ext_method `_x.ai/billing` over `grok agent stdio` (underscore prefix
mandatory; bare name → -32601; measured), returns period boundaries, on-demand/
prepaid money rails, and tier — and is byte-identical before and after real spend
(measured, spend-delta test). A router choosing between a vendor whose remaining
capacity it can read and one it cannot see must have this spelled out:

### 3.1 What the pool record honestly contains

Register one Grok pool ("the weekly pool" — product-level; **nothing per-model**,
so both Grok models share it and there is no same-vendor downshift escape when it
closes). Its record carries:

- **Window**: `config.currentPeriod.start/end` from `_x.ai/billing` — UTC,
  rolling 7 days anchored to the subscribe instant (measured; corroborated
  independently by the paywall poll flipping six seconds after
  `billingPeriodStart`). The reset boundary is real, free, and re-readable.
- **Level**: none. Confidence is **`missing`** — the schema's word
  (`QuotaConfidenceSchema`, `src/schemas/quota.ts`; there is no `unknown` member,
  and `missing` is the honest one: no reading exists). The inspection surfaces
  print "unmeasurable — vendor publishes no level", the window end, and the
  evidence basis. **Never a number.** Hive's own ledger of Grok turns may be kept
  as telemetry, but a consumption estimate against an unknown denominator is not
  a level and is never rendered as one (accurate-numbers rule; the 12%-
  `authoritative` failure in `provider-quota-surfaces.md` §"What a usage number
  means" is the standing warning).
- **Money rails**: `onDemandCap.val`, `onDemandUsed.val`, `prepaidBalance.val` —
  the payload's one load-bearing gift. While `onDemandCap.val == 0`, exhaustion
  blocks and cannot bill (measured). **If any rail ever goes nonzero, the safety
  premise of this whole section is void**: Grok drops out of automatic routing
  the same turn, an alert names the rail, and re-admission requires explicit user
  consent — this is the spend guard applied, not a new mechanism.

Neither empty nor infinite, structurally: the pool exists (so Grok is never the
phantom "unconstrained, most attractive route" that
`provider-quota-surfaces.md` §"Binding a pool" warns about), and it has no level
(so nothing can rank it as having headroom it was never measured to have).

### 3.2 Exhaustion is detected at the point of use, and only there

There is no reading to watch, so exhaustion announces itself as a **blocked
call**: a Grok spawn or turn failing with a limit-shaped error. The exact error
shape in headless output is **UNKNOWN** — never yet observed. The binary carries
`credit_limit_hit` and `rate_limit_error` telemetry identifiers (measured,
strings), so the CLI distinguishes these states internally; the first observed
failure pins the real shape and must be logged **verbatim** (§5) — it is the most
valuable single log line this design will ever produce.

On a limit-shaped failure:

1. Read `_x.ai/billing` (free) for a fresh `currentPeriod.end`.
2. Mark the Grok pool **exhausted until that boundary**. Grok drops from every
   eligible list via the existing availability filter — the same rule as "a
   model whose own metered pool is spent, with credits off, stops being a
   candidate" (`docs/model-selection.md` §Layer 1).
3. The failed task **fails over by re-derivation**: the tier resolves again
   without Grok and the spawn retries on the result. A mid-task block is a
   handoff like any other death; Grok sessions persist and resume
   (`--resume <id>`, measured), so a post-reset resume is possible but is an
   operator convenience, not the recovery path.
4. Alert the orchestrator/user the same turn: pool closed, boundary, what failed
   over. Silence is the failure mode being designed against.

**Misclassification is the named risk**: until the error shape is pinned, a
non-limit failure that pattern-matches could close the pool for up to seven days
on a false signal. Mitigations, all mandatory: the closing error is logged
verbatim with the decision; the pool state is manually clearable (the
`hive_quota_reconcile` surface class); and closure is never inferred from
anything but an actual failed Grok call — never from time, never from Hive's own
spend ledger.

### 3.3 Re-arming

At `currentPeriod.end` the pool returns to **eligible with level `missing`** —
not "full", which would be an invented number. The boundary is re-read from
`_x.ai/billing` rather than computed from the stale record (the window is
anchored to a subscription event and re-anchors if the subscription changes —
measured today: the anchor moved when the user subscribed mid-window). The first
successful Grok turn after re-arm is the positive control that the vendor agrees.

### 3.4 The wanted falsification

If `creditUsagePercent` (or `monthlyLimit`/`includedUsed`/`totalUsed` — fields
that exist, unpopulated, in the CLI's own response DTO; measured) ever appears on
the wire, the pool has become measurable and §3 collapses into the ordinary
measured-pool machinery. The billing parser therefore treats any newly populated
key as a **loud, wanted signal** surfaced for re-derivation — logged and alerted,
never silently ignored and never auto-parsed into a level without the semantics
being established first (the unit is still UNKNOWN even then).

## 4. Spreading load — three vendors under pressure

The user's words: "I want to spread more work out to more capable agents." With a
third vendor, quota tie-breaking — the last stage of the pipeline — has more room
to act, and the asymmetry of Grok's costs is what makes the policy safe to state:

**Grok is the pressure valve.** Under normal conditions Grok is eligible where
§2's evidence and the user's floors allow, preferred where the user says so, and
otherwise sits in the ordering where its placement basis puts it. When Claude and
Codex pools show measured pressure (their headroom below the standing
thresholds), quota tie-breaking prefers the vendor whose failure is cheap:

- Routing to Grok when it is secretly near-exhausted costs **one failed spawn and
  a same-turn failover** — bounded, visible, and free (`onDemandCap == 0`,
  measured: it blocks, it cannot bill).
- *Not* routing to Grok preserves nothing: the weekly allowance does not
  observably carry over past `currentPeriod.end` (rollover behavior:
  **UNKNOWN**; the FAQ describes a weekly reset — documented:
  https://docs.x.ai/grok/faq), while the Claude/Codex capacity it would have
  saved is measured and real.

Per the standing rule — name what each direction of error costs before calling
one safe (`provider-quota-surfaces.md` §"'Conservative' was the bug, twice") —
the direction that risks a visible bounced spawn is cheaper than the one that
burns measurable pools to protect an unmeasurable one. That, and only that, is
why an invisible pool may be leaned on under pressure.

**Where this goes wrong, plainly:**

1. **Mid-task exhaustion.** The valve routes work in; the pool closes mid-task;
   the agent's turn blocks and the task is stranded until failover re-derives.
   Under known pressure, prefer Grok for *bounded* work over long-running deep
   tasks — a preference the classifier already expresses through tiers.
2. **The shared-pool coupling.** The weekly pool spans every Grok product the
   user touches (Chat, Imagine, Voice, Build, API — documented:
   https://docs.x.ai/grok/faq). The user's own chat evening drains Hive's
   routing capacity invisibly, and Hive's Build load shortens the user's chat
   week. Hive cannot see either side. This is disclosed, not solved: it is the
   price of an unmeasurable shared pool.
3. **Quality dumping under pressure.** The valve engages precisely when work is
   being displaced, so provisional-fit Grok inherits load at the worst time. The
   floors hold (pressure never overrides a capability floor — the floor is
   checked before quota ever ranks), and §5's escalation telemetry is the tripwire.
4. **No intra-vendor escape.** Both Grok models drain one pool; when it closes,
   the whole vendor closes. The failover target is always another vendor.
5. **Misclassified exhaustion** (§3.2) parks the valve for up to a week — the
   verbatim-log and manual-clear mitigations exist for exactly this.

## 5. What would falsify this design, and what Hive logs to see it

| # | Observation | What it falsifies | Where it must be visible |
|---|---|---|---|
| 1 | Grok escalation rate per model × tier materially above Claude/Codex peers at the same tier | the §2.2 provisional fit (vendor tiering overstated the class) | existing escalation counters on the routing inspection surfaces; per-vendor comparison view |
| 2 | A pool marked exhausted while a subsequent manual Grok call succeeds | the §3.2 exhaustion detector (error shape misclassified) | the verbatim closing error logged beside the pool state; manual clear leaves an audit row |
| 3 | Any money rail nonzero (`onDemandCap`, `onDemandUsed`, `prepaidBalance` moves) | the §3/§4 no-money-risk premise — the valve is no longer free to lean on | same-turn alert; Grok auto-routing suspended pending consent |
| 4 | `creditUsagePercent` (or siblings) populated on the `_x.ai/billing` wire | §3's premise that the pool is unmeasurable — wanted; triggers redesign into a measured pool | billing parser's new-key alert (drift guard) |
| 5 | Billing payload schema drift or `grok --version` change breaking any parser | the binding assumptions of §1/§3 wholesale | drift-guard alert; affected readings degrade to `stale`/`missing`, loudly |
| 6 | A spawn carrying an effort Grok rejects | the per-model effort trust of §1.3 | spawn failure reason names the effort and the record it came from |
| 7 | LiveBench (or a future registered source) publishes Grok rows that *contradict* vendor tiering (e.g. grok-4.5 scoring below the cheap-class line) | §2.2's fallback placement — measurement wins automatically, but the delta is worth an alert because it means vendor claims misled the interim | benchmark overlay telemetry: basis flip from `vendor-tiering` to `measured` recorded with both values |

Required log lines (all stamped with `grok --version` and, where relevant, the
models-cache `etag`): every Grok route decision with its placement-basis label;
every `_x.ai/billing` read (raw payload — it is tiny); every Grok spawn/turn
failure verbatim; every pool state transition (open → exhausted → re-armed) with
its evidence.

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
