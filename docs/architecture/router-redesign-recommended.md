# Router Redesign — Recommended Architecture (chiara, reconciler)

| Field | Value |
| --- | --- |
| Status | **GOVERNING** — this is the architecture the router rebuild follows |
| Landed on main | 2026-07-12 (clifford) |
| Authority | Supersedes any earlier routing design. Where another document disagrees with this one, this one wins and the other document is wrong. |
| Implementation | PR1–PR3 implemented; policy storage and chains remain later work. |

Downstream docs that must obey this one: `docs/architecture/model-control-center-settings-ui.md`
(the settings UI for the policy this document defines).

**Landing corrections (clifford, 2026-07-12 — not chiara).** Two things in the
reconciled text were wrong on the facts. They are corrected in place rather than
laundered onto main; chiara's *design rulings* are unaltered.

1. **A pin settles routing, never enablement.** The launch gate reads the exact
   pinned model's policy row independently; false, missing, or unreadable policy
   refuses. **§4.2.2 carries what is load-bearing:** the spawner is the sole
   unconditional net, and PR3 replaces it before removing the legacy guard.
2. **§6 says "SwiftUI settings scene."** The Workspace is 3,331 lines of
   **AppKit** with **zero** SwiftUI imports (`workspace/Sources/HiveWorkspace/`,
   verified): `NSView` + Auto Layout, `NSAppearance` theming, `Theme.swift`
   semantic colors. Read every "SwiftUI" in §6 as "AppKit `NSView`" — adopting
   SwiftUI would be a new stack decision, not an implementation detail. The MCC
   spec is written against AppKit.

Status: **JUDGMENT / DESIGN ONLY.** Nothing here is implemented. This document
adjudicates two independent architect proposals:

- **chad** (Claude): `docs/architecture/router-redesign-chad.md` @ `03470cf`
- **chandra** (Codex): `docs/architecture/router-redesign-chandra.md` @ `1e504e18`

Those two source documents are deliberately **left on their branches**
(`hive/chad-architect-design-the-optimal-r`, `hive/chandra-architect-design-the-optimal-r`)
and are **not on main**. Half of each was overruled below; on main they would be
briefing material for future agents, and a superseded design read as fact is the
exact failure this reconciliation exists to prevent. Read them via `git show`
for provenance, never as instructions.

It also says what survives and what dies in the landed UI artifact
`docs/architecture/model-control-center-settings-ui.md` (e2d38fb).

**Governing acceptance test (user):** every model a vendor advertises, at every
effort it advertises, must be *reachable*. Unreachability may come only from
user policy (disabled or unreadable) or an honest gate (exhausted quota,
capability floor) — never from a hardcode, an omission, or a default that
quietly wins. The old system is gone. Hive should use more models across more
tasks rather than defaulting to one.

**Settled product decisions (non-negotiable unless explicitly argued):**

1. Task categories replace tiers. The four tiers and hardcoded tier→vendor
   preference are deleted.
2. Multiple models per category = ordered fallback chain (primary, then
   secondary). Never parallel, never ensemble.
3. Empty category → fall back only through enabled models that pass
   availability and the capability floor. Enablement is consent; spawning never
   opens a spend-approval prompt.
4. A settings UI makes the user the router.

---

## 0. Verdict in one paragraph

Build **chandra's launch boundary and constraint model**, **chad's category
vocabulary continuity with the MCC**, a **mandatory user-authored global
fallback chain that ships provisional-and-active** (not refuse-until-confirmed),
and **SQLite policy with deterministic export** as the store. Kill
`"default"` as a silent chain token; if the user wants "track the vendor's
current default," that is an explicit, labeled chain-entry mode that re-resolves
at every spawn and is never cached as identity. Close the money hazard *before*
any chain is populated by making `AuthorizedLaunch` unforgeable (private
constructor in a gatekeeper module, not a castable brand). Fix the Grok-class
bug by making `CAPABILITY_PROVIDERS` / driver registration the *only* legal
enumerator, with a fourth-provider CI test that fails if inventory, UI, or
policy drop a vendor.

Neither design is taken whole. Both are right about the core mechanism and both
have real holes.

---

## 1. Convergence that is real (branded launch value)

Both independently invent the same safety idea: a branded/authorized type that
is the only value a launcher may accept, so an ungated candidate is
unrepresentable rather than merely unlikely.

### Source verification of the hazard they both close

Verified in this worktree (`src/daemon/spawner-impl.ts` ~1767–1803):

- When `governing !== null` and no explicit model, candidates for quota are
  built as `{ tool, model }` from column primaries **plus**
  `governing.chain.<provider>` strings mapped raw into `QuotaRouteCandidate[]`.
- That path does **not** re-run `spendGuard` / `availabilityRefusal` / the
  capability floor on chain remainders.
- Today the chain is always empty (`src/schemas/routing-derivation.ts:532`
  `chain: []`), so the money hazard is latent, not live. Populating chains
  without fixing this is how you spend without consent.

Also verified: `TIER_PREFERRED_TOOL` still hardcodes deep/review→claude,
standard/cheap→codex (`routing-derivation.ts:79–84`). LiveBench/`benchmarkFit`
only touches effort on a one-item candidate list (`:531–532`, `:546+`). The
architects' diagnosis of the real router is correct.

### Brand airtightness — which design actually closes it

| Property | chad `GatedCandidate` | chandra `AuthorizedLaunch` |
| --- | --- | --- |
| Type-level brand | yes (`& Brand`) | yes (unique symbol or private ctor) |
| Only factory is the gatekeeper | stated | stated **and** module-private construction |
| Carries gate evidence | yes (`GateTrace`) | yes |
| Carries policy revision + registry snapshot ids | no | **yes** |
| Carries reservation + expiry | no | **yes** |
| Final revalidation at adapter (TOCTOU) | no | **yes** |
| Runtime schema at MCP/persistence boundaries | not specified | **yes** |
| Lint/architecture test forbidding raw adapter exports | weak (tripwire for provider literals only) | **yes** |
| Castability | TypeScript `as GatedCandidate` works unless the brand is module-private and the type is opaque | private constructor + non-exported brand symbol is the real bar |

**Ruling: chandra's version is the one to build.** Chad's idea is the same idea
and is necessary, but a castable brand is theatre. In TypeScript the only
airtight pattern is:

1. Gatekeeper module owns a non-exported `unique symbol` brand **or** a class
   with a private constructor.
2. Public type is an opaque interface; no public constructor fields.
3. `ProviderDriver.launch` / `resume` accept only that type.
4. Process-spawn helpers are not exported from the driver package.
5. Serialized wire values cannot rehydrate the brand — only `gatekeeper.evaluate`
   can mint one; recovery re-authorizes rather than replaying a stored brand.
6. A CI test greps for exports of raw spawn helpers and for
   `as AuthorizedLaunch` / brand casts outside the gatekeeper module.

**Take chad's ordering insight:** run *every* chain link through the full gate
pipeline *before* quota sees the list, and change quota's candidate type to the
pre-authorized shape so the current string-map at `spawner-impl.ts:1785–1803`
becomes a type error. Delete `GoverningRoute.chain` rather than repurposing it.

**Recommended type (name from chandra, construction discipline from both):**

```text
RawCandidate  -- Gatekeeper.evaluateAndReserve() -->  AuthorizedLaunch
AuthorizedLaunch  -- ProviderDriver.launch() -->  Process
```

Quota may only veto/reserve in user order; it never reorders. The Fable→Opus
release valve (`spawner-impl.ts` releaseValveAlternative) dies as silent
substitution; headroom becomes evidence, not ranking.

---

## 2. The recommended architecture (build this)

### 2.1 Registry (facts, not rankings)

**Mostly chandra's framing + chad's preservation of existing discovery assets.**

- The registry is the hardened union of per-vendor capability discovery
  (claude initialize, codex model/list + config/read, grok models + cache).
  It is not a new product surface; it is a renamed, total enumeration of what
  already exists.
- Keep `Discovered<T>` and the unknown taxonomy
  (`field-absent` / `surface-silent` / `malformed`) from
  `src/schemas/capability.ts` — never collapse them.
- **Effort is three-valued at the inventory/UI edge** (both architects get this
  right; today's inventory does not fully):
  - `known(values[])` — vendor listed levels
  - `known-none` — vendor *stated* there is no effort axis
    (`supports_reasoning_effort: false` on Grok → this, **not** unknown)
  - `unknown(reason)` — surface silent / field absent / malformed
  - Policy/spawn effort target modes (chandra): `exact(value)` | `none` |
    `provider-controlled` (omit flag; never claim you know the vendor default)
- **Identity is never inferred from name shape** for routed launches. Explicit
  `model=` keeps `identifyModelVendor` with unclaimed→throw and
  unreadable≠blessing (`spawner-impl.ts` ~1658–1692, verified).
- Vendor effective defaults are diagnostics only. Policy never stores their
  *resolution* as a frozen preferred model without saying so (memory:
  vendor-default-model-moves-under-you; live routing.toml comments already pin
  grok-4.5 for this reason).
- Refresh: daemon start, Control Center open, manual refresh, CLI version /
  account fingerprint change, pre-spawn when stale, periodic jitter. Atomic
  per-provider snapshot; silent/failed probes do not wipe last-good catalog;
  billing silence → unknown availability, never free/exhausted. Spend consent is
  model enablement policy, not a spawn-time question.
- **Context size:** not currently a first-class catalog field across vendors
  (runtime statusline/context telemetry exists; Claude's `[1m]` variant is an
  entitlement tag). Chandra's `minContextTokens` modifier is correct in design
  and implementable only where evidence exists; **unknown context fails the
  minimum-context gate** (do not invent windows).

### 2.2 Provider enumeration — making the Grok-class bug uncompilable

**Verified defect:** `buildModelInventory` iterates
`(["claude","codex"] as const)` and casts the providers record
(`model-inventory.ts:287,336,343,397`). Same pattern in `cli/routing.ts:145,263`.
Grok is discovered by probes and present in derivation columns, but inventory
and CLI routing surfaces drop it so it *appears not to exist*.

**Structural fix (both, with chandra's CI bar winning):**

1. **One legal enumerator:** `CAPABILITY_PROVIDERS` / `forEachProvider` (already
   in `capability.ts:35–63`) plus a `providerMap` constructor. Every
   `Record<CapabilityProvider, T>` is built through it. Ad-hoc
   `["claude","codex"]` becomes a tripwire test failure outside capability.ts.
2. **ProviderDriver registration** (chandra): discover / billing / quota /
   launch / resume behind one interface. Built-ins are a total
   `Record<CapabilityProvider, Driver>` with `assertNever` / `unknownVendor`.
3. **Completeness assertion at the inventory edge** (chad): missing provider →
   `complete: false` naming the missing vendor; unavailable ≠ absent.
4. **Synthetic fourth-provider contract test** (chandra): novel model, no-effort
   model, effort named `overdrive` appear in registry, policy round-trip, MCC
   read model, gatekeeper, dry-run adapter. This is the single best test of the
   governing principle.

New vendor cost: one driver + one enum entry. New model/effort from an existing
vendor: zero code. Do not promise "zero code for a new vendor" — both architects
correctly refuse that lie.

### 2.3 Policy store

**Ruling: revisioned SQLite in `hive.db` (chandra), with mandatory deterministic
JSON/TOML export (chad's inspectability without chad's write path).**

Why SQLite wins here, given the real writer topology:

- Workspace is a **separate AppKit process** that today shells out to the `hive`
  CLI (`FeedClient`, `hive autonomy`, etc.) — verified in
  `workspace/Sources/HiveWorkspace/`. It does **not** write policy files
  itself. The daemon is the sole writer either way.
- Concurrent mutations (UI, CLI, migration, approvals side-effects) need
  transactional CAS + audit. Hive already runs SQLite (`src/daemon/db.ts`,
  `~/.hive/hive.db` with messages, approvals, escalations, audit_log).
- Atomic rename of a JSON blob cannot combine CAS revision + multi-row chain
  edit + audit event without inventing a lock protocol — an improvised DB
  beside a real one.

Why not pure JSON (chad): human hand-edit and corruption recovery are real
advantages, but they become **export/import + backup-on-write**, not a second
writer. Hand-editing the live policy file while the UI also saves is how you
get silent clobber.

Schema (logical, chandra-shaped, simplified):

```text
routing_policy_meta(schema_version, revision, updated_at)
provider_policy(provider_id, state: inherit|enabled|disabled)
model_policy(provider_id, canonical_model_id, variant, state: inherit|enabled|disabled)
category_policy(category, enabled, requirements_json,
                exhaustion_behavior: refuse | use_global_fallback)
category_chain(category, ordinal, provider_id, canonical_model_id, variant,
               effort_mode, effort_value)
global_fallback_chain(ordinal, provider_id, canonical_model_id, variant,
                      effort_mode, effort_value)
policy_events(revision, actor, operation, before_json, after_json, created_at)
```

Rules:

- Provider-off overrides every descendant.
- Absent model policy inherits provider state (new models are reachable without
  silently entering automatic chains).
- Orphaned chain targets (model disappeared) stay in policy, marked
  unresolvable, never silently dropped, never launched.
- Validation: no duplicate chain targets; exact efforts must be advertised;
  effort on `known-none` models rejected; unknown effort only as
  `provider-controlled`.
- `quota.toml` stays separate (capacity, not preference); retarget estimates
  from tier → category.
- `routing.toml` migrates once into a draft-or-provisional policy, then is
  renamed `routing.toml.migrated-<date>` and ignored. Never dual-authority.

Writes: CLI / Workspace intent → daemon validates against live registry →
single transaction increments revision + audit. Clients send
`expectedRevision`; stale → reject + reload.

Export: `hive routing export` writes a deterministic, human-readable snapshot
for inspection and support. Import is validated and transactional, never a
second live writer racing the UI.

### 2.4 Categories and requirement modifiers

**Vocabulary: keep MCC's settled snake_case ids (chad), minus long_context as a
category (chandra).**

| id | Label | Notes |
| --- | --- | --- |
| `light_research` | Light research | |
| `heavy_research` | Heavy research / synthesis | |
| `simple_coding` | Simple coding | |
| `complex_coding` | Complex coding | |
| `code_review` | Code review | |
| `planning` | Planning | |
| `debugging` | Debugging | may share chain with complex_coding; keep distinct for telemetry |
| `summarization` | Summarization | |
| *(deleted as category)* `long_context` | — | becomes a requirement modifier |
| `default` | Global fallback | mandatory user-authored chain (see §3.2) |

Chandra's alternate vocabulary (`lookup`, `codebase-change`, `transformation`,
`writing`, …) is better *linguistically* but **wrong to ship**: the MCC already
landed role ids, and a second rename costs the user twice. If we ever rename,
do it once with a migration table — not as part of this cutover.

**Requirement modifiers (chandra is right; extend the spawn contract):**

```text
requirements?: {
  minContextTokens?      // fail closed on unknown context
  codingRequired?        // preserves kindRequiresCodingCapability seam
  independentOfProvider? // cross-vendor review; replaces ad-hoc review exclusion
  requiredTools?: string[]
}
```

Other modifiers that deserve the same treatment (not new categories):

- `codingRequired` — already implicit in floors/kind; keep as explicit floor
- `independentOfProvider` — review must not reuse the producer's vendor
- `minContextTokens` — long jobs of any category
- Future only if measured need: `latencyClass`, `maxCostClass` — **do not ship
  speculative modifiers**

Capability floors bind automatic chains **and** exact overrides (hard ground
truth: floor blocks even a pin). Chad folds floors into enablement and lets
interactive `model=` bypass — **that is a violation; reject it.** Enablement is
user policy; floors/requirements are capability constraints. They are not the
same axis.

### 2.5 Gate pipeline (one path, fail-closed)

For ordinary spawn (`category` + optional requirements):

```text
1. Resolve chain: nonempty category_chain
   else if empty → global_fallback_chain
   else refuse with "configure a chain or default"
2. If category chain was nonempty but every link gated out:
   if category.exhaustion_behavior == use_global_fallback → append global chain
   else refuse with per-link reasons
3. For each RawCandidate in user order, independently:
   G1 Identity   — catalog claims model; no name-shape blessing
   G2 Policy     — provider+model enabled; provider-off wins
   G3 Availability — exhausted → skip; UNKNOWN is not exhausted
   G4 Capability — requirements + floors; binds pins and exact overrides too
   G5 Effort     — exact advertised | none | provider-controlled; never invent
   G6 Mint AuthorizedLaunch (or skip with reason)
   G7 Quota reserve — veto only, never reorder
4. First surviving AuthorizedLaunch → final revalidation at adapter → launch
5. None → throw model:null-shaped error listing every link and gate reason
```

Explicit `model=` / provider override: single candidate, same gates, **no
substitution** on failure. Naming or pinning a model does not enable it. A false,
missing, unreadable, or throwing policy query refuses with the model name and a
Model Control Center remedy; there is no approval-queue escape hatch.

Recovery/restart: reauthorize the stored exact execution identity through the
same gatekeeper; never raw-launch from a stored model string.

### 2.6 Chain contents — exact targets, optional explicit track-default

**Ruling: reject bare `"default"` tokens that look like model ids (chad's
baseline shape). Accept chandra's exact provider/model/effort targets as the
normal case. Add one explicit, labeled mode for "follow vendor default" so the
user's intent is representable without quietly winning.**

```text
ChainEntry =
  | { mode: "exact"; provider; model; variant?; effort }
  | { mode: "vendor-default"; provider; effort }
```

- `exact` is unambiguous and is what almost all UI edits produce.
- `vendor-default` is **opt-in, visible in the UI as volatile**, resolved at
  every spawn from live discovery (or loud LKG), never cached as identity in
  the policy row. It is not a Hive preference; it is a user instruction to
  track a moving pointer.
- UI affordance "Use vendor's current default" either (a) freezes `exact` at
  edit time with provenance "was default at T", or (b) inserts
  `vendor-default` with a live "currently X" subtitle. Never a silent string
  `"default"` that readers mistake for a model id.
- Baseline table (§2.8) ships `exact` ids resolved at first migration against
  live discovery + cited vendor positioning — not `"default"` tokens and not
  invented training-memory ids.

This kills the thing the user wants dead (quiet system defaults) without
erasing the legitimate user intent "keep me on this vendor's current default,"
which is exactly why their routing.toml already pins grok-4.5.

### 2.7 Empty-category fallback (decision-grade for the user)

**Steelman of chandra's "global fallback must itself be user-confirmed":**

Enablement answers "may this model run, including paid execution?" It does not answer "which of six
enabled free models should do architecture review?" Any "fall back within
consent" still needs an ordering. Registry order, lexical id, vendor order,
cheapest-first, strongest-first are all hidden routers. Enabling a Grok model
does not rank it above Claude for every empty
category. Therefore a **user-authored ordered global fallback** is the only
honest implementation of the user's own rule. Requiring that chain to exist
and be deliberate is not belt-and-braces theatre; it is the definition of
"user is the router" when a category is empty.

**What actually goes wrong under pure consent-only filtering with no ordered
default:** Hive must invent an order. Whatever it invents becomes the real
router for every empty category — the defect this redesign exists to kill,
reintroduced under a softer name.

**What does not go wrong if the default chain is pre-filled and active:** the
user already has an order; gates still enforce consent/enablement/availability/
floors; empty category does not mean "random free model."

**Ruling (reconciles user rule + chandra's steelman + "ready to use"):**

1. There is always a `default` / `global_fallback_chain` in policy.
2. It is **user-authored policy**, not "any consented model."
3. It **ships provisional-and-active** with researched exact targets (§2.8),
   labeled provisional in the UI, fully editable. No per-spawn confirmation.
4. **Do not** refuse all empty-category spawns until a separate confirmation
   dialog (chandra's draft-only activation fails "ship ready to use").
5. **Do** take chandra's distinction for *exhaustion*: a nonempty category
   chain that gates out entirely **refuses by default**; widening to global
   requires `exhaustion_behavior: use_global_fallback` on that category.
   Empty ≠ exhausted.
6. First-run onboarding shows the provisional default chain and the category
   matrix; dismissing settings after edit-or-accept is enough. No extra
   "confirm fallback" modal if the chain is visible policy.

The enabled set is the consent filter; the default chain is the order. Both are
required, and neither creates a spawn-time approval flow.

### 2.8 Baseline table — honest and ready

**Neither pure position wins.**

- Chad ships `"default"` tokens only → binary names no model, but reintroduces
  mutable vendor defaults as the day-one router under a soft label.
- Chandra ships draft-only until confirmation → honest, empty router on day
  one, fails "researched defaults that ship ready to use."

**Recommended:**

1. At migration / first policy create, resolve a **provisional exact matrix**
   against the **live discovery catalog** (not training memory). If a cited
   model is absent from the signed-in account, skip that link and record why.
2. Each row carries `confidence: documented | assumed` and a short citation
   string (vendor positioning doc URL or "assumed order — no Hive outcome
   data"). Nothing is `measured` until `route_outcomes` has N.
3. Matrix is **active** as provisional policy so day-one spawns work, with a
   persistent MCC banner: "Provisional Hive suggestions — edit anytime; no
   outcome data yet."
4. Never auto-reorder from telemetry. MCC shows evidence; user re-ranks.
5. Spread work across vendors (both matrices already try). Prefer concrete
   researched positioning over replaying `TIER_PREFERRED_TOOL`.

Illustrative starting order (exact ids filled at ship/migration from live
catalog — do not freeze these strings in the binary):

| Category | Intent of chain order | Confidence |
| --- | --- | --- |
| complex_coding | strongest coding/reasoning → secondary coding → third | assumed order; documented capabilities |
| debugging | coding specialists first (evidence split from complex_coding is why the category exists) | assumed |
| code_review | prefer independent vendor from typical producer; high effort | assumed |
| simple_coding | faster coding models first | assumed |
| planning | strong reasoning first | assumed |
| light_research | cheap/fast general first (spread off coding pools) | assumed |
| heavy_research | strong reasoning / research-capable first | assumed |
| summarization | cheapest competent first | assumed |
| default | mid-effort diversified across vendors | assumed (carried "standard" spirit, not the old hardcode) |

`long_context` is **not** a row; long jobs set `minContextTokens`.

### 2.9 Evidence

Take both: `route_outcomes` (chad name) with chandra's richer fields.

Per decision: category, requirements, policy revision, registry snapshot ids,
full ordered raw chain, every gate result/reason, enablement state,
selected index, quota observations, source
(category | global_fallback | exact_override).

Per execution: provider, model, launch token, effort, CLI version, hashed
account fingerprint, timings, tokens where reported, exit reason.

Per outcome: landed (merge hash), escalated (typed reason), killed, died,
abandoned, tests/typecheck if known, optional user rating. No full prompts by
default.

Note: escalations table plumbing exists (`db.ts`); architects claim zero useful
routing signal — treat as "no per-task outcome telemetry usable for ranking,"
not "escalations table missing."

Hive **proposes** reorders after a month; never applies them. Fallback traffic
is selection-biased; UI must say so.

### 2.10 Spawn API

- `hive_spawn`: required `category` for orchestrator; optional `requirements`;
  optional exact `provider`/`model`/`effort` override.
- One compatibility release: accept exactly one of `tier` | `category`; map
  deep→complex_coding, review→code_review, standard→simple_coding,
  cheap→summarization with warning; record both.
- Human CLI without category → `default` chain only (user policy).
- Delete tier parsing after the window. No permanent dual-router flag.

---

## 3. Rulings on the five disagreements

### 3.1 Policy store: JSON vs SQLite

**SQLite (chandra), export for humans (chad).**

Daemon sole writer; Workspace shells to `hive` CLI; concurrent CAS + audit need
transactions; `hive.db` already exists. JSON as the live store loses atomicity
across multi-row edits. Inspectability is export, not a second writer.
Migration from routing.toml is a one-shot importer into a transaction; source
file renamed, not deleted.

### 3.2 Empty-category fallback

**User-authored global fallback chain, provisional-and-active, consent gates
only (no per-spawn extra confirmation). Exhausted deliberate chain refuses
unless category opts into `use_global_fallback`.**

Chandra's steelman is correct about ordering; her refuse-until-confirmed
activation is rejected as failing ready-to-use. Chad's "default as 10th role"
is the right shape. Pure "any consented model" without order is forbidden.

### 3.3 Long-context

**Chandra wins: requirement modifier, not a task category.**

Chad keeps `long_context` as a v1 role for MCC continuity and flags future
migration — that continuity is the only argument, and it is weaker than
correctness. MCC must drop the role id and add a context-demand control on any
category. Context windows are only partially discoverable today; gate
fail-closed on unknown. Other modifiers: `codingRequired`,
`independentOfProvider`, `requiredTools` — same mechanism, not new categories.

### 3.4 Chain contents: `"default"` token vs exact targets

**Exact targets as normal form; optional explicit `vendor-default` mode that is
labeled and re-resolved every spawn. No bare `"default"` string in chains.**

Chad preserves legitimate "follow vendor default" intent and the
vendor-default-moves fact. Chandra preserves unambiguity. The hybrid above is
the only design that kills quiet defaults without lying about user intent. A
`"default"` token that looks like a model id is how quiet wins return.

### 3.5 Baseline table

**Provisional exact matrix, active, cited, live-resolved at migration — not
draft-only emptiness and not default-token fog.**

User asked for researched defaults ready to use; honesty forbids inventing ids
or claiming measured quality. Live discovery + vendor-position citations +
provisional banner reconciles both. Escalation/outcome telemetry later upgrades
confidence; never auto-reroutes.

---

## 4. Defects — highest value findings

### 4.1 Caught by one design, missed or weakened by the other

| Defect | Who caught it cleanly | Notes |
| --- | --- | --- |
| Ungated chain → quota money hazard | both | Verified real; latent while `chain: []` |
| Castable brand is theatre | **chandra** (private ctor + revalidation + lint) | Chad's brand alone is insufficient |
| TOCTOU between gate and process start | **chandra** | Chad has no final revalidation |
| Consent ≠ routing order (empty fallback) | **chandra** | Chad's default chain is the fix shape |
| long_context is a modifier | **chandra** | Chad defers |
| Floor/requirement must bind pins and exact overrides | **chandra** | Chad weakens this — **violates hard ground truth** |
| Recovery must reauthorize | **chandra** | Chad under-specified |
| Grok inventory omission structural fix | both | Chandra's 4th-provider test is stronger |
| Effort known-none vs unknown | both state it | Today's inventory is only two-state (see 4.2) |
| Quota must stop ranking by headroom | both | Release valve is live substitution today |
| `"default"` token reintroduces quiet wins | **chandra** pressure | Chad underestimates the product risk |
| Draft-only baseline fails ready-to-use | **chad** pressure | Chandra underestimates day-one usability |
| MCC role id continuity | **chad** | Chandra's rename is unnecessary churn |
| Per-link effort vs model-row effort | **chad** | Keep per-link override |

### 4.2 Neither design fully called out (verified in source)

1. **Pins settle the route; enablement settles consent.**

   A pin remains the user's exact routing directive, so the router does not
   substitute another model. It is not permission to bypass policy: the launch
   gate independently reads enablement for that exact provider/model. Enabled is
   the user's standing consent, while false, missing, unreadable, or throwing
   policy reads refuse and point to the Model Control Center. No case files a
   spend approval during a spawn. This keeps route and money separate without a
   vendor-keyed consent side channel.

2. **THE SOLE NET IS THE SPAWNER, AND IT IS UNCONDITIONAL — a hard build
   constraint for PR3.**

   `spawner-impl.ts:1932` (with the eligibility pass at `:1840`) is the line that
   decides a launch. **Derivation never blocks a launch, by design** — it settles
   the route and raises questions; the spawner is what refuses.

   Mutation-tested at PR3: forcing the enablement refusal off caused a disabled
   Grok model to reach `tmux.newSession` with a concrete `grok -m grok-4.5`
   command. Restoring the refusal stopped the process before any session existed.

   > **Therefore: in PR3, the spawner net must be REPLACED BEFORE IT IS REMOVED.**
   > Anyone restructuring that path who deletes the spawner guards expecting
   > derivation to catch the fall **will ship a live money leak.** `AuthorizedLaunch`
   > must be load-bearing at the spawn boundary before the legacy spend-approval
   > guard comes out. There is no moment where neither is holding.

   This is the single most dangerous step in §5, and it is dangerous precisely
   because the code it replaces looks redundant from inside derivation.

3. **Inventory effort is two-state while capability records are richer.**
   `CapabilityRecord` correctly keeps `supportsEffort` and
   `supportedEffortLevels` separate (`capability.ts:247–255`). Grok maps
   `supports_reasoning_effort` into `supportsEffort` and still stores
   `supportedEffortLevels: known(efforts)` (possibly empty)
   (`capability-discovery.ts:807–812`). `buildModelInventory` drops
   `supportsEffort` and exposes only known/unknown levels
   (`model-inventory.ts` effortLevels union). UI that only reads inventory
   cannot distinguish known-none from empty-known from unknown. Fix inventory
   to three-valued **before** MCC effort pickers ship.

4. **Workspace transport is CLI-subprocess today, not the MCC's "HTTP/XPC
   snapshot" alone.** Blueprint targets authenticated XPC; live Workspace uses
   `hive` binary + port (`FeedClient`, autonomy). Policy APIs must ship as
   `hive` CLI subcommands that talk to the daemon (and later the same shapes
   over XPC). A design that assumes the AppKit app speaks HTTP directly is
   wrong for v1; a design that assumes the app writes `~/.hive/*.json` is also
   wrong.

5. **Context window is not a catalog-wide discovered field.** Chandra's
   modifier is right but needs an explicit discovery plan: Claude variant
   `[1m]`, runtime statusline `context_window_size`, vendor docs — not a
   pretend per-model integer for every vendor on day one.

6. **Dual-router transition risk.** Both warn; neither hardens the cutover
   rule enough: **once a request enters the category path, it must never fall
   back to tier derivation.** A feature flag that routes some spawns old and
   some new is acceptable; a per-spawn "new failed → old" is a money and
   consent bug.

7. **`ProviderId = "claude"|"codex"|"grok"| string` in MCC §11** reopens the
   Grok-class hole at the UI contract. Policy schema must use the closed
   provider enum (extensible only by schema version + driver registration).

8. **Floors were tier-scoped; enablement is global.** Chad's fold loses
   "allow X only for cheap." Chandra keeps requirements/allowlists per
   category. Prefer per-category requirements over lossy global enablement
   for floor migration.

### 4.3 Hard ground truth checklist

| Invariant | Satisfied by recommended design? |
| --- | --- |
| model:null → throw | yes — empty AuthorizedLaunch list |
| missing/unreadable/false enablement → REFUSE never spend | yes — G2 every candidate |
| availabilityRefusal on exhausted; UNKNOWN ≠ exhausted | yes — G4 |
| capability floor blocks even a pin | yes — chandra rule, not chad fold |
| identifyModelVendor unclaimed ≠ unreadable | yes — explicit path unchanged |
| model pin ≠ model enablement | yes — exact route, independent policy gate (§4.2.1) |
| no absolute allowance invention | meters stay percent + reset; unknown ≠ zero |
| effort three-valued | yes at registry + inventory + policy |
| Grok-class omission structurally impossible | yes — enumerator + 4th-provider test |

---

## 5. PR sequence (money-safe order)

Nothing half-migrated may spend ungated. Each step independently green.

1. **Delete the external ranker (safe now).**  
   livebench/benchmarks/fit-policy/benchmarkFit wiring, inventory benchmark
   columns, config. Behaviorally inert today (`chain: []`). No flag.

2. **Provider enumeration hardening (fixes Grok invisibility immediately).**  
   Kill every `["claude","codex"]` literal; `providerMap` / tripwire;
   inventory completeness; synthetic fourth-provider test. Effort three-valued
   in inventory. No launch behavior change required.

3. **Gatekeeper + `AuthorizedLaunch` (closes the chain money hazard BEFORE chains exist).**  
   Rewire quota candidate build and all launch/resume entrypoints. Shadow mode
   optional for comparison logs; **no path may launch without authorization**.
   Delete release-valve silent substitution. Bind floors and enablement to pins and
   exact overrides.

   > **THE SPAWNER NET MUST BE REPLACED BEFORE IT IS REMOVED.** The adapter-boundary
   > authorization check is the unconditional thing standing between a disabled
   > model and a launch.
   > Derivation does not block launches and never did (§4.2.1, §4.2.2). Deleting
   > those guards on the assumption that derivation catches the fall is a **live
   > money leak** — mutation-proven: disable the policy refusal and a disabled
   > Grok spawn reaches tmux. `AuthorizedLaunch` must remain load-bearing at that
   > boundary. There is no frame in which neither net is holding.

4. **Policy store (SQLite) + CLI read/write + export + routing.toml import.**  
   Draft/provisional matrix active under flag `policy.mode =
   chains|tiers` default `tiers`. Daemon sole writer; CAS revision.

5. **Spawn API: `category` + requirements; tier compat mapping; orchestrator
   contract in the same change.**  
   Category path never falls back to tier derivation.

6. **MCC AppKit rewrite against this contract (see §6)** in parallel from PR4,
   read-only first, then writes.

7. **Cutover.** Flag default `chains`. Delete TIER_PREFERRED_TOOL,
   TIER_EFFORT_POLICY, tier ladder, GoverningRoute.chain, legacy static-table
   spawner path, routing.toml reader as authority. RoutingTier parse-only for
   one release, then gone.

8. **Evidence: `route_outcomes` + MCC read API.** Propose-only reorders.

**Do not** populate user chains (or enable the flag by default) before PR3 is
on main. That ordering is the load-bearing safety decision.

---

## 6. Landed MCC UI spec (e2d38fb) — survive vs rewrite

### Survives (keep; stack-independent product truth)

- Honesty rules: measure or unknown; never invent absolute allowances; unknown
  ≠ zero; percent-native meters; Grok unmetered panel as first-class design.
- Billing ≠ capacity; spend risk copy discipline.
- Provider master toggle overrides model rows; effective vs preference chrome.
- Ordered fallback chains, not ensembles.
- Effort from live catalog only; no fake `low|medium|high` for known-none.
- Near-limit thresholds from config remaining fractions.
- Copy catalog intent for badges, unknown meters, provider-off captions.
- HIG materials, light/dark, SF Symbols, ≥28pt targets (already AppKit-oriented
  in places).
- Goals: every discovered model visible and controllable.

### Must rewrite (foundation wrong or superseded)

| Area | Why |
| --- | --- |
| Soft fallback "any enabled model" (§11, warn.empty_role) | Forbidden. Empty → user default chain within consent; not "any." |
| `long_context` as a task role (§8.7) | Becomes `minContextTokens` modifier. |
| Persistence as conceptual JSON only (§11) | SQLite policy + export; revision/CAS/audit. |
| `"default"` as a legal model string in chains (§11) | Replace with exact \| vendor-default modes. |
| `ProviderId \| string` open union (§11) | Closed enum + driver registration. |
| Open Q soft vs hard empty-role (§21.1) | **Decided** in §3.2 of this doc. |
| Open Q nine roles vs four tiers (§21.2) | **Decided**: categories replace tiers; no silent alias without banner during compat only. |
| Open Q where policy persists (§21.3) | **Decided**: SQLite in hive.db. |
| PR2 "daemon HTTP/XPC snapshot" as sole transport | v1 = `hive` CLI subcommands (Workspace already shells out); XPC later per blueprint. |
| Tier mapping as long-term UI | Compat-only; delete after cutover. |
| Component tree assuming web layout metaphors without SwiftUI state | Rewrite as native SwiftUI/AppKit settings scene against daemon snapshots; no optimistic local policy mutation. |
| Nine-role editor without global default chain + exhaustion policy | Add Default chain section + per-category exhaustion control. |
| Per-model single effort only | Per-link effort override (chad amendment) + model default. |
| "Policy not yet applied" as a permanent state | Allowed only during PR1–3; cutover removes the banner. |

### AppKit-specific implementation notes for the rewrite

- Surface: SwiftUI settings scene inside the existing AppKit Workspace
  (`workspace/Sources/HiveWorkspace/`), system materials, `Theme.swift` tokens.
- Data path: `Process` → `hive models` / `hive routing …` / approvals CLI (same
  pattern as `hive autonomy` and `workspace-feed`), never direct file writes to
  `~/.hive/`.
- No React/DOM/CSS. No browser storage. Meters are AppKit/SwiftUI views with
  distinct unknown chrome (not empty ProgressView at 0).
- Previews: fixture-driven (already planned); include three-valued effort and
  Grok unmetered states.
- Consent: inline approve wired through the same approvals queue
  (`hive_approve` / CLI), not a second store.

---

## 7. Attribution map (what came from whom)

| Piece | Source |
| --- | --- |
| User is the only router; delete tiers + LiveBench | both (and user) |
| AuthorizedLaunch unforgeable launch boundary | **chandra** (airtight form) |
| Gate-before-quota; delete GoverningRoute.chain | **chad** emphasis + both |
| ProviderDriver + 4th-provider CI test | **chandra** |
| providerMap + inventory completeness tripwire | **chad** |
| SQLite policy + audit + CAS | **chandra** |
| Deterministic export / hand-inspect | **chad** need, chandra mechanism |
| MCC role id set (minus long_context) | **chad** / landed MCC |
| long_context as modifier; requirements on spawn | **chandra** |
| Global default chain as policy | both; activation **chad**/user |
| exhaustion_behavior refuse vs widen | **chandra** |
| Exact chain targets + labeled vendor-default mode | hybrid (neither alone) |
| Provisional active baseline with citations | hybrid |
| Per-link effort | **chad** |
| Final revalidation + recovery reauth | **chandra** |
| route_outcomes / no auto-reorder | both |
| Pin must not satisfy model enablement | user decision; exact route still passes the policy gate (§4.2.1) |
| Spawner is the sole unconditional net; replace before removing | **cindy** (mutation-tested); neither architect saw it (§4.2.2) |

---

## 8. What to tell the user (short)

The two architects independently invented the right safety kernel: an
authorized launch value so ungated models cannot reach a launcher. Chandra's
version of that kernel is the one that is actually airtight. Around it, keep
your task categories (with long-context demoted to a constraint), put policy in
SQLite with export, make empty categories walk a user-owned default chain that
ships ready-to-use and provisional, never invent "any free model," keep the rule
that a pin buys the route but does not enable the model (see §4.2.1),
and never let inventory omit a vendor again.

The old tier ladder and the empty-chain quota footgun go away in that order:
close the footgun first, then turn the chains on. And when the gatekeeper goes
in, it takes over from the spawner's guards **before** they come out — that
handoff is the one place in this plan where a mistake costs real money (§4.2.2).
