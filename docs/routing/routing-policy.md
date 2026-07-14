# Routing Policy — the user is the router

Updated: 2026-07-14
Source: Hive source tree, 2026-07-14

## Summary

Hive no longer derives routes. The user's routing policy — a revisioned consent
document in `hive.db` holding per-category ordered chains of **exact** (provider,
model, effort) targets — is the router's only source of standing preference, and
every link is minted into an `AuthorizedLaunch` by an unconditional gate before
anything can spawn.

## Why the tier ladder died

The router has been rebuilt twice. The founding incident is the 2026-07-10 burn: every
Codex tier named model `"default"`, which resolved through `~/.codex/config.toml` to
the frontier model — so *every* Codex agent ran the frontier model at *every* tier.

> **A tier system that lowers the effort flag but not the model is not a tier system.**

That lesson is the axiom this schema enforces: **a default that quietly wins is not a
convenience, it is the defect.** Everything below is downstream of it. Full incident
and the rest of the graveyard: [rejected-approaches.md](rejected-approaches.md).

## What the policy document is

`src/schemas/routing-policy.ts` — `schemaVersion: 2`. Ten categories
(:24-35): nine task kinds plus `default`, the user-authored global fallback chain.
`long_context` is deliberately **not** a category — it returns as
`minContextTokens`, a requirement *modifier*, because a context requirement
composes with every kind of work rather than replacing it. `hive_spawn` requires
`category` (`src/daemon/spawner.ts:13-15`); there is no `tier` param and no compat
mapping.

### Chains name exact models, and nothing else

`ChainEntrySchema` (:77-81) is `{ provider, model, effort }`, and the model id is
refused outright if it is the string `"default"` (:60-66). There is deliberately
**no other form** — no `{mode:'vendor-default'}`, no moving pointer of any kind. An
earlier draft specified a `vendor-default` mode; the user reversed it on 2026-07-13:

> "we are specific on the models that we choose"

**A vendor default is a quiet default, and quiet defaults are what this redesign
exists to kill.** Vendors also move their defaults server-side mid-session (repo
memory: *vendor-default-model-moves-under-you*). An indirection that cannot be
*written* cannot bite. Commit `0dc25c0` removed it.

### Absence is never permission

The fail-closed reading every consumer inherits (:283-322): an absent provider or
model row means **not configured**, and not-configured never means allowed.
`providerPolicyState` and `modelPolicyState` are the single implementation of that
rule — a consumer that re-derives it by hand is how a null becomes permission again.
Provider enablement is a master switch, not consent for every model the vendor may
discover tomorrow: an absent model row stays unconfigured even under an enabled
provider.

**Enablement is consent.** With approval prompts retired (user directive
2026-07-12), a model enabled here *is* the user's standing authorization to spend on
it. Every write path in the store is therefore a safety surface.

## Selection: never-configured | auto | choice

`SelectionModeSchema` (:115-119) is three-valued, per-category with a global
default (`selectionModeFor`, :183-189):

- **`never-configured`** — the user has not answered. The spawn **refuses**
  (`spawner-impl.ts:1734-1741`). Absence does not acquire an automatic meaning.
- **`choice`** — the category's exact chain is the user's ordered preference,
  walked in rank order.
- **`auto`** — Hive considers every explicitly enabled model whose *policy-authored*
  fit clears the category, then distributes across the capable providers.

This corrects two earlier claims. The governing doc said "quota may only veto or
reserve in user order; it never reorders" — true only under `choice`. Under `auto`,
quota **does** choose among eligible candidates by weighted-fair deficit. And a
schema revision that used `spread | strict` as the *policy* vocabulary is gone;
those words survive only as the quota layer's dispatch mode, mapped at
`spawner-impl.ts:1779-1794` (`auto`→`spread`, `choice`→`strict`). See
[quota-and-headroom.md](quota-and-headroom.md).

### Fit is authored, never inferred

`modelCategoryFit` (:196-239) answers "may this model do this category's work?"
purely from the user's own chain placements. Coding tiers are monotonic — a model
placed in `complex_coding` is proven for `standard_coding` and `simple_coding`;
`standard_coding` proves `simple_coding`. Every other category requires exact
membership.

**Hive does not infer strength from a model name, a provider, or a vendor's
marketing prose.** A chain placement is the user's positive evidence and the only
evidence there is — which is why `auto` is not a licence to guess: it distributes
among models the user already vouched for.

## The launch gate

`src/daemon/authorized-launch.ts`. `AuthorizedLaunch` has a **private constructor**
(:49) and one mint, `AuthorizedLaunch.gate` (:57). Five guards run in a fixed order
for every primary and every chain link: `resolution` → `enablement` → `availability`
→ `capability-floor` → `effort`.

The private constructor is not ceremony (governing doc :121-128):

> **A castable TypeScript brand is theatre.** `as GatedCandidate` defeats any brand
> that is not module-private. The only real bar is a class with a private constructor.

`requireAuthorizedLaunch` (:83-88) is the runtime half at the adapter boundary —
`spawner-impl.ts:1099, 1109, 1151, 2133, 2139, 2157` — so a structural impostor
throws rather than launching.

### The invariant that must never be forgotten

> **THE SOLE NET IS THE SPAWNER, AND IT IS UNCONDITIONAL — replace before you remove.**

Mutation-proven at PR3 (governing doc :598-616): forcing the enablement refusal off
let a **disabled Grok model reach `tmux.newSession`** with a concrete `grok -m …`
command. Restoring the refusal stopped the process before any session existed.
Derivation never blocked a launch, *by design*; the spawner is what refuses. Anyone
restructuring this path who deletes the spawner guards expecting some upstream layer
to catch the fall **will ship a live money leak.** There is no moment where neither
net is holding — and it is dangerous precisely because *the code it replaces looks
redundant from inside derivation.*

Two companion rulings:

> **Consent is not an ordering.** Consent answers *may this vendor charge me?* It
> does not answer *which of six enabled models should do code review?* Registry
> order, lexical id, vendor order, cheapest-first are all hidden routers. An
> ordering is required, and **whatever Hive invents becomes the real router.**
> The enabled set is the consent filter; the default chain is the order.

> **Never fall back from the new path to the old.** A per-spawn "new failed → old"
> is a money and consent bug. No permanent dual-router flag.

## The store

`src/daemon/routing-policy-store.ts`. **One revisioned JSON document in one row**
(`routing_policy`) plus an append-only `routing_policy_events` audit table (:66-82).
The multi-table schema the governing doc proposed (`provider_policy`, `model_policy`,
`category_policy`, `category_chain`, `global_fallback_chain`) was **not built,
deliberately** (:20-40): every reader and writer handles the whole policy, and a
whole-document schema parse on every read is what makes corruption LOUD instead of
permissive. There is no `route_outcomes` table.

- **CAS.** Every mutation carries `expectedRevision`; a concurrent write loses loudly
  with `RoutingPolicyConflictError` rather than clobbering (:208-228).
- **Fail-closed.** No row → the empty revision-0 document. A row that exists but does
  not parse **throws** `RoutingPolicyCorruptError` (:54-62). *"I could not read your
  policy"* and *"you have no policy"* are different facts, and only one may be
  answered with defaults.
- **Canonical serialization** (:478-517) makes two exports diff cleanly — the
  inspectability half of the SQLite ruling. Inspectability is export, not a second
  writer; the daemon is the sole writer.
- **`~/.hive/routing.toml` is dead as a policy source.** Renamed aside at daemon
  start, never deleted and never interpreted (`retireLegacyRoutingToml`, :560-572;
  called from `src/cli/daemon.ts:54`). Dropping a routing preference was the user's
  call; destroying his file is not ours.

### The provisional baseline

`seedProvisionalBaseline` (:254-271) runs on first boot only. It writes suggested
chain **order** — and **no enablement at all**. Enablement is consent; only the
user's own click can grant it. Every entry names an exact model id read live from
that vendor's catalog at seed time and frozen; a vendor whose catalog could not be
read is *skipped, not invented* (`provisionalBaselineChains`, :440-470). **The binary
ships the ORDER only.** It ships provisional-*and-active* — a router that refuses
until confirmed fails "ready to use" — and any accepted mutation clears the
`provisional` flag permanently. Hive **proposes** reorders; it never applies them.

## What survived the derivation era

`src/schemas/routing-derivation.ts` is now ~96 lines holding exactly one thing:
`identifyModelVendor`. A model's vendor is a **fact the vendor publishes**, read from
the discovered catalog, never inferred from spelling. Its verdict is three-valued on
purpose — `claimed` / `unclaimed` / `unreadable` — because "nobody claims it" (a
measurement, grounds to refuse) and "I could not read the catalogs" (no evidence
either way) must never collapse into each other, and neither may become a quiet yes.
Two vendors claiming one name returns `unreadable`, not a first-match win. The
predecessor answered by regex over spelling and returned null for anything it could
not place — and **both callers read that null as PERMISSION.**

## Selection boundary

The user's enablement set is the outer boundary; authored chains are preference order
inside it. Under `choice`, Hive tries the category chain, then Default. If those
non-empty authored chains are exhausted because every link is refused, it spreads the
last-resort attempt across the remaining enabled models. A disabled or unconfigured
model never enters that fallback. If both category and Default are empty, Hive refuses
before constructing the fallback: **empty is not exhausted** (`src/daemon/spawner-impl.ts:1811-1849`; `src/cli/spawner-impl.test.ts:3505-3674`, `:3794-3804`). Under `auto`, enabled models that fit the category form the candidate set directly.

## Known gaps (real, and unimplemented)

- **There is no coding-capability floor of any kind.** The only floor is
  `minContextTokens` (`spawner-impl.ts:1625-1634`), which fails closed on an unmeasured
  window. The invariant "a capability floor blocks even a pin" has nothing to enforce.
- **Identity-from-name-shape survives, in one place.** When `identifyModelVendor`
  returns `unreadable`, `spawner-impl.ts:1470-1487` falls back to the name-shape regex
  `modelVendor()` — which (`src/adapters/tools/models.ts:3-15`) knows only `claude`
  and `codex`, **not Grok**. This is exactly the inference the design forbids. Live hole.

## See Also

- [quota-and-headroom.md](quota-and-headroom.md) — how `auto` distributes, and what a meter honestly says
- [model-control-center.md](model-control-center.md) — the UI that edits this document
- [rejected-approaches.md](rejected-approaches.md) — tiers, benchmark ranking, signed manifests, and why each died
- [../providers/capability-discovery.md](../providers/capability-discovery.md) — where exact model ids and effort axes come from
- [../providers/quota-surfaces.md](../providers/quota-surfaces.md) — the vendor wire facts
- [../../SPEC.md](../../SPEC.md) §6 — the orchestrator classifies; discovered policy resolves
