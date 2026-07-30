# Routing Policy — the user is the router

Updated: 2026-07-30
Source: Hive source tree, 2026-07-30

## Summary

Hive no longer derives routes, and it no longer walks ordered chains. The user's
routing policy — a revisioned consent document in `hive.db` holding **unordered
weighted sets** of exact (provider, model, effort) candidates — is the router's
only source of standing preference. `HiveRouter` (`src/daemon/router.ts`)
resolves one route, filters its candidates through factual gates, selects one
with smooth weighted round-robin, and records the exact decision. Facts filter;
weights distribute; nothing scores.

## Why the tier ladder died

The router has been rebuilt three times. The founding incident is the 2026-07-10 burn:
every Codex tier named model `"default"`, which resolved through `~/.codex/config.toml`
to the frontier model — so *every* Codex agent ran the frontier model at *every* tier.

> **A tier system that lowers the effort flag but not the model is not a tier system.**

That lesson is the axiom this schema enforces: **a default that quietly wins is not a
convenience, it is the defect.** Everything below is downstream of it. Full incident
and the rest of the graveyard: [rejected-approaches.md](rejected-approaches.md).

## What the policy document is

`src/schemas/routing-policy.ts` — `schemaVersion: 3`. Ten categories
(`ROUTING_CATEGORIES`): nine task kinds plus `default`, the category a spawn uses
when nothing more specific applies. Separately from the categories, the document
carries one `global` route — the answer for any category without a route of its
own. `long_context` is deliberately **not** a category — it arrives as
`minContextTokens`, a requirement *modifier*, because a context requirement
composes with every kind of work rather than replacing it. `hive_spawn` requires
`category` (`src/daemon/spawner.ts`); there is no `tier` param and no compat
mapping.

### A route is an unordered weighted set of exact candidates

`RoutePolicySchema` is `{ mode, candidates }`. Each `RouteCandidateSchema` entry
is `{ provider, model, effort, weight }`:

- **The model is exact.** `ExactModelIdSchema` refuses the literal string
  `"default"` outright. There is deliberately **no other form** — no
  `{mode:'vendor-default'}`, no moving pointer of any kind. The user reversed an
  earlier `vendor-default` draft on 2026-07-13: *"we are specific on the models
  that we choose."* **A vendor default is a quiet default, and quiet defaults are
  what this redesign exists to kill.**
- **Order carries no meaning.** There is no rank, no "first", no fallback ladder.
- **Weight is an integer 1–100, and weights are ratings, not percentages** —
  60/20/20 and 3/1/1 express the same distribution. **Zero is illegal**:
  disablement stays the explicit provider/model enablement control, never a
  weight.
- **Duplicate targets are rejected** — a route that names the same model twice is
  an editing bug, not a stronger preference.
- **A candidate always answers effort.** `CandidateEffortSchema` is four-valued
  (`hive-decides` | `exact` | `none` | `provider-controlled`); `never-configured`
  is a model-row state, not a launchable intent, so it cannot appear on a
  candidate.

### Two modes, one preference store

`RouterModeSchema` is `user-weighted | hive-equal`. In `user-weighted` the
effective weight is the stored integer; in `hive-equal` every eligible candidate
gets effective weight 1 **while the stored weights stay intact**, so switching
modes loses no preference information (`effectiveWeight`).

The selection unit is an exact model target, not a provider: a provider with
three candidates in a hive-equal route gets three aggregate shares. The router
never secretly normalizes by provider; the UI's job is to show the projected
provider share honestly.

### Provider consent is the permission boundary

An absent provider means **not configured**, and not-configured never means
allowed. `providerPolicyState` and `modelPolicyState` are the single
implementation of the reading: provider-off overrides everything under it; under
an **enabled** provider, an explicit model row answers next, and an absent model
state **inherits the provider** until the user explicitly disables that model.
`modelPolicyState` reports `source` (`provider` | `model` | `none`) so a UI can
show effective-vs-preference without re-deriving the rule.

**Provider enablement is consent.** With approval prompts retired (user directive
2026-07-12), an enabled provider is the user's standing authorization to spend on
its models. Every write path in the store is therefore a safety surface.

## Resolution: category, else global, else refuse

`resolveRoute` is the one resolution rule: the exact category route when
present, else `global`, else nothing. Three consequences, all deliberate:

- **A configured category never appends global after a refusal.** If every
  candidate of a category route is refused, the spawn refuses with each
  candidate's bounded reason — the category was an explicit boundary, not the
  first half of a hidden fallback chain.
- **Nothing configured refuses with `never-configured`** — absence does not
  acquire an automatic meaning. The remedy named in the refusal is the Model
  Control Center.
- **There is no third tier** — no "remaining enabled models" spread, no
  exhaustion widening. Those died with V2 (see
  [rejected-approaches.md](rejected-approaches.md)).

### Pins

An explicit `model` in the spawn request is a pin. It passes the same launch
gates as any candidate (a pin is a route, not a consent), bypasses weighted
selection, and never mutates balance. The spawner records it through
`HiveRouter.recordExplicitDecision` with `routeDigest: null` and reason
`"explicit"`, so even a pinned launch is attributable to a recorded decision.
Hive never substitutes another model for a pin.

## The router

`src/daemon/router.ts` — `HiveRouter.select`. One routed selection: resolve the
route, evaluate every candidate once, pick with smooth weighted round-robin
inside one transaction. Nothing in the module scores — no quota headroom, no
price, no inferred model strength, no outcome learning. A wrong choice is
recovered by the communication handoff, never predicted.

### Gates filter; they do not score

Each candidate's evaluation (`CandidateEvaluation`) records eligibility or one
bounded refusal `{ gate, detail, retryAt }`:

- **`reviewer-separation`** — a review candidate whose provider authored the
  work under review is refused (`request.requirements.reviewOfProvider`).
- **The per-spawn launch gate** (`CandidateGate`, built in
  `spawnReserved`) — effort resolution plus the complete `AuthorizedLaunch`
  mint: `resolution` → `enablement` → `availability` → `capability-floor` →
  `effort` (`src/daemon/authorized-launch.ts`). An explicitly requested `tool`
  narrows the route here rather than in policy.
- **`route-health`** — an active launch-failure cooldown for the exact route
  (`QuotaService.launchCooldown`), with `retryAt`.
- **`pool-exclusion`** — a quota pool governing the candidate is proven drained
  (`QuotaService.drainFor`), or was proven drained for this request
  (`request.excludedPoolIds`, a handoff's exclusion). Unknown or unmetered stays
  eligible — unknown is not exhaustion.

### Smooth weighted round-robin

`smoothSelect`: every eligible candidate earns its effective weight into a
per-route balance, the highest balance wins and pays back the round's total.
Deterministic, restart-safe, bounded — the requested ratio is followed without
random streaks. Only currently eligible candidates earn: an excluded candidate
accrues no catch-up credit while absent. Ties break on a stable candidate key.

Balance lives in the `routing_balance` table keyed by `routeDigest` — a digest
of the resolved route's mode, targets, efforts, and **effective** weights
(`routeDigest`). A real route change starts a fresh balance; edits elsewhere in
the policy do not.

### The decision ledger

Every selection (and every pin) inserts a row in `launch_decisions`:
`decisionId`, `requestId`, `policyRevision`, `routeDigest`, category, exact
provider/model/effort, reason (`explicit` | `user-weight` | `hive-equal`), and
later a `result` (`started` | `launch-failed`, via `recordLaunchResult`). The
spawner mints the agent id **before** routing and uses it as the router's
idempotent `requestId`: a retried spawn returns the existing decision instead of
consuming another fair-selection slot — unless that decision already failed to
launch, which frees the id for a fresh selection. The `decisionId` lands on the
agent record and rides into session creation as the `ProviderRun`
`launchGrantId`, so a run is always attributable to the decision that authored
it. Selection retries on a policy edit mid-evaluation: a decision is never
committed against a replaced document.

A model-layer launch failure records `launch-failed` on the decision and feeds
the route-health cooldown — unless it classifies as a vendor drain, which is an
empty meter, not a broken route (`failSpawnAndCleanup`,
`src/daemon/spawner-impl.ts`).

### Handoff rerouting

`replaceWithHandoff` (`src/daemon/server.ts`): a drained agent's work is frozen
and persisted as a durable handoff bundle **first**; only then does Hive spawn a
replacement, passing `excludedPoolIds` with the proven-drained pool so the work
cannot land back on the route that just demonstrated it cannot continue. A
refused route (no candidate) falls back to the durable orchestrator notice —
quota lifecycle and the human decide wait versus preserve; nothing busy-retries.

### The invariant that must never be forgotten

> **THE SOLE NET IS THE SPAWNER'S GATE, AND IT IS UNCONDITIONAL — replace before
> you remove.**

`AuthorizedLaunch` has a **private constructor** and one mint,
`AuthorizedLaunch.gate`; `requireAuthorizedLaunch` is the runtime half at the
adapter boundary, so a structural impostor throws rather than launching. A
castable TypeScript brand is theatre — the only real bar is a class with a
private constructor. Mutation-proven in the V2 era: forcing the enablement
refusal off let a disabled Grok model reach session creation. Anyone
restructuring this path who deletes the gate expecting some upstream layer to
catch the fall **will ship a live money leak.**

Two companion rulings survive unchanged:

> **Consent is not an ordering — and not a distribution either.** Consent
> answers *may this vendor charge me?* It does not answer *which of six enabled
> models should do code review?* Registry order, lexical id, vendor order,
> cheapest-first are all hidden routers. The enabled set is the consent filter;
> the route's weights are the distribution.

> **Never fall back from the new path to the old.** A per-spawn "new failed →
> old" is a money and consent bug. No permanent dual-router flag.

## The store

`src/daemon/routing-policy-store.ts`. **One revisioned JSON document in one row**
(`routing_policy`) plus an append-only `routing_policy_events` audit table.
Every reader and writer handles the whole policy, and a whole-document schema
parse on every read is what makes corruption LOUD instead of permissive.

- **CAS.** Every mutation carries `expectedRevision`; a concurrent write loses loudly
  with `RoutingPolicyConflictError` rather than clobbering.
- **Fail-closed.** No row → the empty revision-0 document. A row that exists but does
  not parse **throws** `RoutingPolicyCorruptError`. *"I could not read your
  policy"* and *"you have no policy"* are different facts, and only one may be
  answered with defaults. The spawner inherits this: a corrupt store throws out
  of `read()` and the spawn refuses.
- **Canonical serialization** (`canonicalRoutingPolicyJson`) makes two exports diff
  cleanly — fixed key order, sorted models, category order, candidates sorted by
  target. Inspectability is export, not a second writer; the daemon is the sole
  writer.
- **`~/.hive/routing.toml` is dead as a policy source.** Renamed aside at daemon
  start, never deleted and never interpreted (`retireLegacyRoutingToml`).
- **The machine selection preference is gone with the selection modes.** There is
  no `routing-selection.json` and no shared cross-instance overlay; the four
  mutations below are the entire write surface. Named instances still receive a
  one-time copy of the default instance's user-authored document on first boot
  (`importDefaultPolicy`), and `hive routing promote-default` copies this
  instance's document to the machine default (`promote`) — both refuse
  provisional or revision-0 sources.

### Mutations

`RoutingPolicyMutationSchema`, four ops, mapped 1:1 onto the CLI
(`src/cli/routing-policy.ts`): `set-provider`, `set-model`, `set-effort`, and
`set-route`. `set-chain` and `set-selection` no longer exist. `set-route`
replaces one scope's whole route (`global` or a category); `route: null` clears
the scope back to unconfigured. As a side effect, `set-route` upserts an
explicit `enabled` model row for each candidate (keeping any existing effort
intent) — the provider master switch remains the launch authority. Any accepted
mutation clears `provisional` permanently.

### The provisional baseline

`seedProvisionalBaseline` runs on first boot only, when NO policy row exists. It
writes **one provisional hive-equal global route** over each vendor's current
default model as read from its live catalog by the caller — frozen as a specific
id, never re-resolved, never a training-memory guess. A vendor whose catalog
could not be read is *skipped, not invented*; efforts seed
`provider-controlled`. No per-category routes are seeded: equal-weight sets are
identical per category, and a category without a route resolves to global. **The
seed writes no provider or model enablement at all** — it may suggest a
candidate set, but only the user's own click can make a provider launchable.

### Migration: V2 chains → V3 routes

`migrateStoredV2` runs once in the store constructor (event
`migrate-v2-weighted-routes`). Ordered V2 chains become unordered **hive-equal**
routes over the same exact candidates, weight 1 each; the V2 `default` chain
becomes the `global` route. **Rank order is dropped rather than converted —
Hive must not invent how much more "first" meant than "second."** Equal weight is
the only non-invented rating; the user assigns real weights through `set-route`
whenever they want `user-weighted` mode. A chain entry's `never-configured`
effort becomes `provider-controlled` (the vendor's own choice is the only
non-invented answer). Enablement copies through untouched — no new consent is
created — and anything that is not a V2 document is left alone for the
corrupt-row path. The pre-migration document survives verbatim in the event row.

## What survived the derivation era

`src/schemas/routing-derivation.ts` is now ~90 lines holding exactly one thing:
`identifyModelVendor`. A model's vendor is a **fact the vendor publishes**, read from
the discovered catalog, never inferred from spelling. Its verdict is three-valued on
purpose — `claimed` / `unclaimed` / `unreadable` — because "nobody claims it" (a
measurement, grounds to refuse) and "I could not read the catalogs" (no evidence
either way) must never collapse into each other, and neither may become a quiet yes.
Two vendors claiming one name returns `unreadable`, not a first-match win. The
predecessor answered by regex over spelling and returned null for anything it could
not place — and **both callers read that null as PERMISSION.**

## Known gaps (real, and unimplemented)

- **There is no coding-capability floor of any kind.** The only floor is
  `minContextTokens` (the `capabilityFloor` check in `spawnReserved`), which
  fails closed on an unmeasured window. The invariant "a capability floor blocks
  even a pin" has nothing else to enforce.
- **There is no `inspect` surface.** The design spec's read-only
  `RouterService.inspect` (resolved route, evaluations, balances, without
  selecting) is not built; `routeShares` (`src/daemon/router.ts`) computes the
  normalized share preview, but no CLI or UI calls it yet.

## See Also

- [quota-and-headroom.md](quota-and-headroom.md) — the facts quota feeds the router, and what a meter honestly says
- [model-control-center.md](model-control-center.md) — the UI that edits this document
- [rejected-approaches.md](rejected-approaches.md) — tiers, chains, strict/spread, quota-owned selection, and why each died
- [../design/hive-router.html](../design/hive-router.html) — the router design spec this implementation follows
- [../providers/capability-discovery.md](../providers/capability-discovery.md) — where exact model ids and effort axes come from
- [../providers/quota-surfaces.md](../providers/quota-surfaces.md) — the vendor wire facts
- [../../SPEC.md](../../SPEC.md) §6 — the orchestrator classifies; discovered policy resolves
