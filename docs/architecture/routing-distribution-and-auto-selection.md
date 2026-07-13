# Routing distribution and automatic selection

Hive should choose a model in two distinct steps: first prove which enabled
models are capable and safe for the task, then spread assignments among the
survivors. Quota is part of the proof that a candidate may run. It is not a
common currency for balancing vendors, because Claude's five-hour and weekly
percentages, Codex's plan-dependent windows, and Grok's absent capacity gauge do
not measure the same thing. Cross-vendor distribution therefore uses Hive's own
measured assignment history, never a made-up conversion between provider
windows.

The other half of this design is explicit intent. “Let Hive decide” is a value,
not a missing value. Model preference, effort, and coding tier each preserve
three states in SQLite and on every wire surface: the user has never answered,
the user explicitly chose automatic selection, or the user made an exact
choice. A missing field is corrupt or unreadable input. It never means AUTO.

This extends the current category-chain launch gate; it does not replace that
gate. Every candidate still passes identity, consent, availability, capability,
effort, and quota checks before the process adapter can receive an
`AuthorizedLaunch`. The relevant existing contracts are
`router-redesign-recommended.md` §2.3–§2.7 and §4.2, `model-selection.md`
“Layer 1,” `benchmark-fit-policy-proposal.md` “Hard constraints” and “Effort
and placement semantics,” and `capability-rights-matrix.md` “Authentication and
authorization are different problems.”

## Intent is data, including the intent to delegate

Each user control uses the same tagged shape. The exact choice type differs,
but the state tags do not:

```ts
type SelectionIntent<T> =
  | { state: "NEVER_CONFIGURED" }
  | { state: "AUTO" }
  | { state: "CHOICE"; value: T };

type EffortChoice =
  | { mode: "LEVEL"; value: string }
  | { mode: "VENDOR_CONTROLLED" };

type ModelPreference = SelectionIntent<readonly ExactModelTarget[]>;
type EffortPreference = SelectionIntent<EffortChoice>;
type CodingTierPreference = SelectionIntent<"simple" | "standard" | "complex">;
```

`ModelPreference` in CHOICE state carries a nonempty ordered list of exact
provider/model targets. A one-item list is a pin; later items are explicit
fallbacks. AUTO has no implicit first item. It allows the router to consider
all exact models that the user explicitly enabled and that clear the task's
capability floor. Existing chain order remains meaningful under CHOICE.

The three meanings are deliberately different:

| Stored state | Meaning | Runtime behavior |
| --- | --- | --- |
| `NEVER_CONFIGURED` | The user has not answered this control. | Refuse the automatic decision and name the control that needs an answer. Never widen a pool or choose a default. |
| `AUTO` | The user actively delegated this decision to Hive. | Run the automatic algorithm, within explicit consent and observed capability. |
| `CHOICE` | The user chose an exact model list, effort level, or coding tier. | Honor that choice. Validate it through the same gate; refuse rather than silently substitute or downgrade. |

These tags are required fields in the policy snapshot, mutation request, audit
event, and route-decision record. SQLite stores the tag and the choice payload
under check constraints. New policy documents contain explicit
`NEVER_CONFIGURED` controls and zero provider/model consent rows. Deleting a
choice writes `NEVER_CONFIGURED`; it does not delete the row. An absent column,
row, or JSON field is a schema/read failure and the launch refuses.

This is intentionally stricter than deriving `NEVER_CONFIGURED` from absence.
The latter looks compact, but it makes a partial read indistinguishable from a
valid unanswered control. It fails the absence test in
`database-resilience.md` §0: absent input must cause “refuse, preserve, and say
so,” not the convenient answer.

Migration follows the same rule. An existing exact chain becomes CHOICE. An
existing exact effort becomes CHOICE. An existing explicit simple or complex
coding category becomes the corresponding tier choice. Missing values become
NEVER_CONFIGURED, never AUTO. The existing `provider-controlled` effort mode
is preserved as an explicit legacy choice until the user changes it; it is not
renamed AUTO, because “let the vendor decide” and “let Hive choose an advertised
level” are different instructions.

Consent is separate from all three controls. AUTO may inspect only models with
positive, explicit consent provenance: the provider is enabled and the exact
model is enabled or appears in an explicitly accepted exact chain. A provider
master switch alone does not cause a newly discovered model to enter the AUTO
pool. Zero consent rows therefore means zero candidates, even when all three
selection controls say AUTO. The remedy is “enable a provider and model,” not a
provisional route.

## Capability comes before distribution

For a coding task, Hive resolves one of `simple_coding`, `standard_coding`, or
`complex_coding`. For every category, it then builds candidates in this order:

1. Apply the model-preference intent. NEVER_CONFIGURED refuses. CHOICE supplies
   only its exact ordered targets. AUTO enumerates only explicitly consented
   models.
2. Run the existing launch gate independently for every target: catalog
   identity, provider and model enablement, entitlement/visibility,
   availability, task requirements, and effort validation. Each refusal keeps
   its gate name and detail.
3. Apply the capability floor for the resolved category. Unknown capability is
   not sufficient capability. A benchmark may order or place candidates, but
   it cannot promote a model through the floor; this preserves
   `benchmark-fit-policy-proposal.md` “Hard constraints.”
4. Resolve effort and validate the selected level against that exact model's
   fresh capability record.
5. Prove affordability from each candidate's own quota and billing surfaces.
   Only candidates that survive become inputs to distribution.

The router never balances before this funnel. In particular, recent low use
cannot make a simple-only model eligible for standard or complex work. A
preference cannot enable a model. A model pin cannot bypass a capability floor.
The process adapter still accepts only the private `AuthorizedLaunch` minted by
the complete gate, as required by `router-redesign-recommended.md` §2.5 and
§4.2.

The current spawner already establishes useful seams to keep. It gates every
category and default-chain link, accumulates per-link refusal reasons, then
hands the eligible `AuthorizedLaunch` values to quota reservation. The cutover
changes candidate construction and final selection; it must not create a
second launch path or temporarily remove the spawner net.

## Load is two facts, not one synthetic score

“Load” has two meanings that must stay separate.

**Provider pressure** is the provider's report about its own pool. Hive evaluates
every reported window independently, after subtracting that window's task
estimate and outstanding reservations. Claude must fit both its five-hour and
weekly windows. A Codex account is evaluated against exactly the windows its
payload reports; this account reports one 10,080-minute weekly window, and Hive
must not manufacture a five-hour window. A window marked `not-metered` is not
checked. A window marked `read-failed` is an expected fact Hive could not read,
so AUTO cannot prove affordability and excludes the candidate with that reason.

There is no cross-provider arithmetic on these percentages. “18% five-hour
remaining” and “18% weekly remaining” are not equal supplies. The losing
alternative is the current minimum-headroom score: taking the minimum normalized
remainder is useful for finding a candidate's own binding constraint, but
sorting vendors by that minimum asserts equivalence between different time
horizons. No such equivalence was measured.

**Dispatch share** is what Hive itself assigned. It is measured in routed
assignments, independent of vendor quota. For each provider Hive records active
AUTO assignments and recently completed AUTO assignment opportunities in a
bounded rolling window. Explicit model choices and control restarts are recorded
for audit but do not create or repay fairness debt: direct user instructions
must not distort the next automatic choice.

Among providers that have candidates in the same sufficient capability band,
AUTO chooses the provider furthest below its earned share, with active
assignments counted first so concurrent spawns see one another. Each prior AUTO
decision gives every provider that was eligible for that decision an opportunity
credit of `1 / eligible_provider_count`, and charges the selected provider one
assignment. The rolling deficit is credits minus charges; the largest deficit
wins. A provider earns no credit for a task it could not perform, so a
simple-only provider does not accumulate a claim on later complex work. Ties go
to the least recently selected provider, then to stable provider order solely
for determinism. After choosing a provider, Hive chooses that provider's
lowest-sufficient capable model; benchmark fit breaks ties before recency does.

The rolling window and active charge prevent catch-up bursts. A vendor that was
unavailable for a week earned no opportunity credit and does not return with a
week of debt to repay. The fairness record contains eligible sets, counts, and
timestamps, not claimed quota capacity. If later evidence shows that equal
assignment count is too coarse for long complex work, category weights may be
proposed as scheduling policy, but v1 does not label guessed cost as measured
load.

CHOICE bypasses this fair-share step. Hive walks the user's exact list in order
and launches the first candidate that survives every gate. Distribution is the
meaning of AUTO; reordering an explicit preference for balance would make the
preference untrue.

We considered three alternatives:

- Round-robin across every enabled model distributes evenly but ignores both
  capability bands and provider aggregation. A vendor with four models would
  receive four times the work, and a weak model could receive a hard task.
- Headroom sorting reacts to real pressure within one pool but cannot compare
  unlike windows and has no honest Grok input.
- A user-authored Grok percentage is explicit, but it adds required setup to
  express “no preference” and still says nothing about actual capacity.

Provider-level fair share wins because it measures the thing it claims to
balance—Hive assignments—and only after capability and safety have settled
eligibility. Its cost is that it does not optimize consumption near a reset.
That is deliberate: quota gates prevent unsafe work, while distribution avoids
pretending that incompatible meters form one market.

## Grok: eligible without a fictional gauge

Grok's `_x.ai/billing` money guard is not a capacity gauge. Its unmeasurable
weekly pool therefore has an explicit `not-metered`/unmeasurable policy:

- Grok may enter AUTO only when its provider and exact model carry explicit
  consent, capability evidence clears the task tier, the billing probe proves
  the no-paid-spill guard required by `grok-routing-fit.md` §3, and the pool is
  not latched exhausted from a measured limit-shaped failure.
- Grok contributes no headroom number and receives no headroom rank. It
  competes through the same provider dispatch-share ledger as the measurable
  vendors. Equal default share bounds it from being slammed and prevents it
  from disappearing merely because its denominator is unknowable.
- A billing probe failure is `read-failed`, not unmeasurable-by-design. Grok is
  excluded from AUTO until the money guard is readable. A successful probe that
  proves the vendor publishes no capacity level remains `not-metered` and fully
  eligible under fair share.
- A measured limit-shaped failure closes the vendor until the reported period
  boundary, as specified in `grok-routing-fit.md` §3.2–§3.3. Re-arm returns it
  to eligible/unmeasurable, never “100% free.”

This replaces the “Grok as pressure valve” recommendation in
`grok-routing-fit.md` §4. Leaning on Grok whenever measured providers are low is
defensible as a bounded failure experiment, but it still systematically assigns
work from an unobserved shared pool at the moment the other pools become scarce.
Fair share is less opportunistic and more auditable. It gives up speculative
reset optimization in exchange for a hard bound on how much automatic work an
unmeasurable provider receives.

The distinction being landed in the quota parser is load-bearing:
`not-metered` says the provider/plan does not expose that window;
`read-failed` says Hive failed to obtain an expected fact. The router never
turns either into zero or full headroom, and never treats them as synonyms.

## Selection outcomes

The algorithm has explicit terminal cases:

- **One surviving candidate:** choose it. The decision says distribution had no
  alternative; no fairness claim is made.
- **No surviving candidates:** refuse. Return every considered target and its
  last gate refusal, including NEVER_CONFIGURED controls, missing consent,
  insufficient/unknown capability, unsupported effort, read-failed quota, and
  measured exhaustion. Do not consult a legacy router.
- **Measured and unmeasurable candidates together:** measured candidates must
  fit every real window; unmeasurable candidates must pass their spend guard and
  exhaustion latch. Then fair share chooses among their providers without a
  quota comparison.
- **A normally metered candidate with an unreadable feed:** exclude it from
  AUTO. A last-known reading may remain visible as stale evidence, but after its
  explicit freshness bound it cannot prove current affordability.
- **A user CHOICE that cannot pass:** refuse that choice, listing the exact
  reason. Automatic widening would turn “preference wins” into “preference is a
  suggestion.”

An explicit one-off user pin retains its existing no-substitution contract. It
still passes consent, capability, and billing gates. Any separately approved
operator override for unreadable capacity must remain a named, audited override;
AUTO never inherits it.

## The standard coding tier

`standard_coding` is a real routing category between `simple_coding` and
`complex_coding`, not an alias for one of them. The classification rubric is
about task demands, never model names:

- **Simple** is mechanical and local: the change is tightly specified, touches
  one small surface, has an obvious verification, and carries no cross-component
  invariant or meaningful design choice.
- **Standard** requires bounded engineering judgment: several related files or
  one subsystem may move, familiar interactions must be reasoned through, and
  tests need design, but the task has a clear boundary and no high-blast-radius
  invariant.
- **Complex** contains architecture, concurrency, security/authority, data
  migration, cross-subsystem state, substantial ambiguity, or a failure whose
  correctness argument cannot be localized.

Classification uses a maximum-risk rule. A task is simple only when every
dimension is simple. Any complex dimension makes it complex. Everything between
is standard. Uncertainty raises the tier; it never lowers it to find an
available model.

The orchestrator classifies because it sees the user's request, decomposition,
file scope, constraints, and expected proof before calling `hive_spawn`. The
daemon sees a task descriptor and should not grow a second, weaker classifier.
This follows SPEC §6: the orchestrator classifies; current discovered policy
resolves. Under tier AUTO, the orchestrator sends both the resolved tier and a
short rubric reason. Under tier CHOICE, it must transmit the user's exact tier
unchanged. Under NEVER_CONFIGURED, the spawn refuses and asks the user to choose
AUTO or an exact tier.

The daemon validates the enum and records the classifier, input intent, resolved
tier, and reason. It does not pretend it can prove the LLM's judgment. The
classifier may see task requirements; it must not see quota headroom or change a
tier to reach a less loaded vendor.

Per-vendor mapping remains live policy rather than a compiled model table:

| Resolved tier | Capability admitted | Per-vendor resolution |
| --- | --- | --- |
| simple | Models with measured simple-or-higher fit | Lowest-sufficient explicitly enabled model for that vendor |
| standard | Models with measured standard-or-complex fit | Lowest-sufficient explicitly enabled model for that vendor; simple-only models excluded |
| complex | Models with measured complex fit | Explicitly enabled complex-capable model; unknown or lower fit excluded |

“Measured fit” includes the adopted evidence hierarchy in
`benchmark-fit-policy-proposal.md`: current benchmark evidence, admissible
stale/vendor evidence, and explicit user placement, each labeled by provenance.
The table names no Claude, Codex, or Grok model because the binary is not a model
catalog. The MCC shows the current exact mapping for every vendor from live
discovery and policy. If no enabled model has sufficient evidence, that vendor
has no candidate and the reason says so.

Capability escalation remains a handoff, not an in-session model switch. An
AUTO-classified simple task may respawn as standard; standard may respawn as
complex. A complex escalation goes to the user because there is no higher tier.
An explicit tier CHOICE is not silently raised: the orchestrator reports the
capability conflict and requests direction.

Escalation telemetry is already stored by launch model and category. Adding
`standard_coding` creates a new bucket; historical simple/complex rows are not
re-labeled. Inspection must show counts and rates by schema/category epoch so a
new middle bucket does not create a fake improvement by changing denominators.
The escalation row should also gain the original tier intent, resolved tier,
and respawn lineage. High simple→standard rates indicate a rubric problem; high
standard→complex rates indicate either the standard floor or classification is
too weak. Telemetry informs a proposal and never silently rewrites policy.

## Hive-decides effort

Effort AUTO is not `provider-controlled`. Hive must choose one of the resolved
model's advertised available levels and record the exact level it chose.

The resolver first reads the model capability record:

- `supportsEffort: known(false)` makes the control unavailable. The resolution
  records `none` as a vendor fact; it does not store a fake user preference.
- An unknown support flag or unknown/malformed level list cannot satisfy AUTO
  or validate CHOICE, so the candidate refuses at the effort gate.
- A known nonempty list is the complete choice set. Hive never adds `medium`,
  copies a level from another model, or uses the vendor default unless that
  value appears in the list.

When the vendor publishes an ordered effort scale, simple selects the lowest
level, standard selects the vendor-advertised default when available and the
ordered middle otherwise, and complex selects the highest. An even-sized list
uses the upper middle for standard. A one-level model uses that level for all
tiers. If the vendor supplies levels without ordering semantics, AUTO refuses;
array position is not silently promoted into meaning.

This is a starting policy, not a quality measurement. It implements the adopted
“lowest sufficient effort” rule while biasing the new middle tier upward rather
than down. Benchmark evidence may refine sufficiency only for exact
model/effort pairs and may never select an unadvertised level. CHOICE always
wins: if the user selected an advertised exact level, Hive uses it for every
tier; if it is no longer available, the spawn refuses instead of falling back to
AUTO.

The route decision stores the full effort explanation: intent, advertised
levels and provenance, resolved exact level, rule used, and any refusal. A
critical restart reuses the recorded exact execution effort; it does not
recompute AUTO against a changed catalog.

## What the Model Control Center must reveal

The MCC needs three explicit controls, each with visible **Not configured**,
**Let Hive decide**, and **Choose…** states. “Let Hive decide” is a real radio
choice or menu item, never placeholder text and never an empty selection. Known
no-effort models render the effort control unavailable with the vendor fact, as
required by `model-control-center-settings-ui.md` §7.4. Unknown effort renders
read failure, not unavailable.

The provider cards retain the distinction in
`model-control-center-settings-ui.md` §7.4 and §7.6:

- **Not metered on this plan/provider** has no bar and participates under fair
  share if its money guard is safe.
- **Could not read usage** has no determinate bar and is excluded from AUTO,
  with the probe error and last-good age.
- A real measured zero is still 0%; absence is never drawn as zero.

Every spawn exposes a “Why this agent?” decision record in the MCC and CLI. It
shows, in order:

1. requested task category, tier intent, resolved tier, classifier, and rubric
   reason;
2. model-preference and effort intents, including whether each was AUTO or an
   exact user choice;
3. every candidate considered and the exact stage at which it survived or was
   refused;
4. capability evidence and provenance for the resolved tier;
5. each real quota window separately, including duration, meter state,
   freshness, post-reservation fit, and billing/spend guard—never a composite
   cross-vendor headroom number;
6. provider dispatch shares before the choice, active assignments, target
   shares, tie-breaks, and the selected provider;
7. exact provider, model, effort, reservation, and immutable execution identity;
8. warnings, explicit overrides, and later capability escalation lineage.

The summary sentence should be concrete: “Standard coding; AUTO; Claude and
Codex cleared capability and quota, Grok was excluded because its billing guard
could not be read; Codex had the largest earned AUTO-share deficit; selected
codex/model-x at high.” A user should not need logs to discover that another
model was considered or why one disappeared.

Decision records are append-only audit facts tied to the policy revision,
catalog observations, quota observation ids, and fairness snapshot used. The
MCC reads them through the daemon/CLI subprocess contract in
`model-control-center-settings-ui.md` §10. It never re-derives selection from a
newer snapshot and never writes SQLite directly.

## Implementation plan, highest risk first

Each phase is independently fail-closed. There is no “new router failed, try the
old router” path.

1. **Persist explicit intent before enabling AUTO.** Bump the routing-policy
   schema; add tagged policy rows, strict wire schemas, CAS mutations, audit
   events, migrations, and absence/corruption tests. Seed explicit
   NEVER_CONFIGURED controls and zero consent rows. Keep AUTO behavior disabled.
   This is first because collapsing absent into AUTO can spend on an
   unconsented model regardless of every later algorithm.
2. **Make consent provenance model-exact.** Separate provider master state from
   membership in the automatic model pool. Migrate accepted exact chains as
   explicit model consent; do not auto-consent newly discovered models. Test
   zero rows, disabled provider, absent model row, unreadable policy, and partial
   migration at the real process boundary.
3. **Ship the decision record and read-only MCC explanation.** Record candidate
   funnels, per-window meter states, and refusal reasons before changing which
   model wins. Add positive-control tests for both `not-metered` and
   `read-failed`; an all-empty explanation is a broken reader, not an empty
   world. This makes the behavioral cutover auditable from its first spawn.
4. **Add `standard_coding` and the classifier contract.** Extend every closed
   category enum, spawn schema, policy chain, quota estimate table, prompt,
   fixture, status surface, and escalation query. The orchestrator sends
   resolved tier plus reason; the daemon records it. Keep historical escalation
   categories unchanged and add lineage/rate denominators.
5. **Add exact AUTO effort resolution at the gate.** Extend capability evidence
   with ordering provenance; implement simple/standard/complex selection only
   for known ordered advertised levels. Preserve exact choices and critical
   restart identity. Mutation tests must prove an unavailable or invented level
   cannot reach any adapter.
6. **Replace cross-vendor headroom sort with atomic fair dispatch.** In one
   transaction, read active/recent AUTO assignment counts, choose the
   under-share eligible provider, reserve its quota, and append the decision.
   A concurrent spawn must see the reservation/assignment. Delete the fixed
   unknown-headroom score in the same cutover; do not leave dual selection
   semantics behind a fallback.
7. **Enable Grok AUTO only through the explicit unmeasurable policy.** Require
   readable no-paid-spill rails and the exhaustion latch; feed it into the same
   provider fair-share ledger with no capacity score. Test not-metered,
   read-failed, money-rail change, limit failure, reset re-arm, mixed pools, one
   candidate, and empty pool.
8. **Turn on the controls and watch measured outcomes.** MCC writes AUTO only
   after an affirmative user action. Compare assignment share, launch failure,
   first-attempt landing, and escalation rates by tier/model/provider. Evidence
   may produce a policy proposal; it never self-edits consent, capability floors,
   effort choices, or tier mappings.

The highest-risk review is phases 1–2, not the fairness arithmetic. A perfect
spreader over an ambiguous store is a fast consent bypass. The second review is
the phase 6 transaction: selection and reservation must be one decision so two
concurrent spawns cannot both observe the same provider as under-share.

## What must never happen

- Never route to a provider or exact model the user disabled, never enabled, or
  did not explicitly admit to AUTO. AUTO chooses within consent; it does not
  create consent.
- Never treat missing policy, a partial row, or a missing wire field as AUTO.
  NEVER_CONFIGURED, AUTO, and CHOICE remain distinct in the store, wire, audit,
  and UI.
- Never treat unknown quota as free quota, zero usage, full headroom, or a fixed
  synthetic percentage. Never treat a normally metered read failure as
  unmeasurable-by-design.
- Never compare a five-hour percentage with a weekly percentage to rank
  providers. Evaluate each real window as its own affordability gate.
- Never let distribution make an incapable or insufficiently evidenced model a
  candidate. A weak model cannot win because it is idle.
- Never let tier AUTO inspect quota and lower the tier to reach a provider.
- Never invent an effort level, infer support from a nonempty-looking field, or
  recompute AUTO on a critical restart.
- Never substitute after an exact model, effort, or tier choice fails. Refuse
  and show the reason.
- Never hide the candidates, refusals, meter states, fairness snapshot, or
  classifier reason that produced a route.
- Never fall back from this path to legacy category derivation or a raw process
  launch. Every winner remains an `AuthorizedLaunch` from the sole gate.

## Open risks

Assignment count is intentionally cruder than cost. A complex task can occupy a
provider longer than a simple one, so active assignment count may lag real
pressure after the task ends. The first response is measurement—duration,
turns, landings, and escalations—not silent category weights.

The orchestrator's tier judgment is not independently provable. The recorded
reason and escalation feedback make it inspectable, but a consistently bad
classifier remains a quality risk. Moving classification into the daemon would
duplicate the judgment with less context, not remove that risk.

Grok can still exhaust mid-task because no preflight can measure its pool. Fair
share bounds exposure; the spend guard prevents silent paid overflow; the
limit-failure latch and handoff contain recovery. None of those turn the pool
into measurable capacity, and the UI must never imply otherwise.
