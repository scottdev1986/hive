# Model Control Center — Settings UI Design Spec

| Field | Value |
| --- | --- |
| Status | Design spec (not started). **Subordinate to** `docs/architecture/router-redesign-recommended.md` |
| Authors | cesar (first draft, e2d38fb) · clifford (rewrite against the settled architecture) |
| Date | 2026-07-12 (rewritten) |
| Product surface | Hive Workspace app (`workspace/`) — **AppKit, Swift** |
| Quality bar | macOS system-settings polish: calm hierarchy, system materials, no inventing numbers |

**Read this first.** The version that landed as e2d38fb was written before the
Workspace stack was known and before the router scope was settled. It assumed a
web-shaped UI, treated settled questions as open, and modelled `long_context` as
a task role. Those parts are **gone**, not hedged. What remains is what survived
review: the honesty rules, the percent-only meter, the unmetered-provider panel,
the ordered-chain UI, and the HIG structure.

Where this document and `router-redesign-recommended.md` disagree, **that one
wins and this one is a bug.**

---

## 1. Overview

The Model Control Center is a settings surface inside the Hive Workspace app
where a human turns providers and models on or off, sets per-model effort, and
assigns models to **task categories** as **ordered fallback chains**. It also
shows honest capacity and billing state: what Hive measured, and what Hive does
not know.

The hard product rule — already law in `src/schemas/quota.ts`,
`docs/research/provider-quota-surfaces.md`, and
`docs/architecture/grok-integration-spec.md` §10 — is:

> **Measure or say unknown. Never invent a number. Never render zero where the
> truth is "we cannot tell."**

An implementer who ships a pretty empty bar labeled "0% used" for Grok, or
"X of Y requests remaining" when no vendor publishes an absolute allowance at
all, has failed this design even if every pixel is right.

---

## 2. The four constraints an implementer must not get wrong

These come first because getting any one of them wrong makes the screen lie, and
a confident lie about capacity is worse than no screen.

### 2.1 No vendor publishes an absolute allowance. Percent is the only honest meter.

Not Claude, not Codex, not Grok. Every metered surface reports a **fraction
consumed**, or nothing at all. There is no denominator on the wire.

- **"128 of 500 requests" is fiction for every provider that exists.** This is
  not a Claude gap or a Codex gap — it is universal.
- The only honest meter is a **percent bar + a reset timestamp**.
- Discovered pools are percent-denominated by construction
  (`QuotaWindowStatus.unit = "percent"`, allowance 100 when known). Manual
  `quota.toml` pools use operator-declared units; this screen renders discovered
  percent meters and neither edits nor invents operator units.

### 2.2 Claude's usage feed is EXPERIMENTAL and goes silent. Design the silence.

Claude's `get_usage` is **vendor-described as experimental**
(`src/daemon/quota-sources.ts:614`, `:753` — "marked experimental by the CLI").
It is not a stable contract, and it does not fail loudly — it goes quiet. **It
went silent twice on 2026-07-12 alone.**

The UI needs a first-class **unavailable / stale** state for a normally-metered
provider:

- **A silent feed must never render as a zeroed bar.** A determinate bar at 0% is
  a claim of measured emptiness. The truth is "we asked and heard nothing."
- Stale readings keep the last percent **only with a visible age and a Stale
  badge**. A six-hour-old "12% used" is not current headroom.
- **A dropped feed is not an outage.** Claude may be perfectly spawnable while
  its usage surface says nothing. Do not disable the card or grey out the models.
- The silence is *expected*, not exceptional. It should read as a known condition
  with a known name — not as an error demanding action.

### 2.3 Grok has no gauge at all — and that state must look deliberate.

Grok exposes **no capacity surface**. `_x.ai/billing` is a **money guard, not a
gauge**: `onDemandUsed` / `onDemandCap` / `prepaidBalance` say whether Hive is
about to spend, and nothing about how full any plan is.

- Grok gets a **warning badge and the unmetered panel** (§7.5), never a meter.
- **Rendering Grok's money-rail zeros as a capacity gauge is forbidden.** Those
  zeros read as "full tank." They mean "no on-demand spend has occurred."
- The panel must look **deliberate, not broken**: same card chrome, same mark
  weight, an `info.circle`, a muted inset. No hollow track, no error red, no bare
  `N/A`. "Hive cannot measure this" is a designed state; "the component failed to
  load" is not.

### 2.4 Effort is THREE-valued. Conflating two of the values is a lie the UI renders.

| Value | Meaning | UI |
| --- | --- | --- |
| `known(values[])` | The vendor listed effort levels | Picker with exactly those strings, in vendor order |
| `known-none` | The vendor **stated** there is no effort axis (Grok's `supports_reasoning_effort: false`) | **No picker.** Caption: *This model has no effort setting.* |
| `unknown(reason)` | Surface silent / field absent / malformed — we could not read it | **No picker.** Caption: *Effort options unknown* + the measured reason |

"This model has no effort axis" and "we could not read this model's effort axis"
are different facts. One greyed-out control for both claims knowledge we do not
have.

**Blocking dependency:** today's `buildModelInventory` is **two**-valued — it
exposes `effortLevels` as known/unknown and **drops `supportsEffort` entirely**
(`src/daemon/model-inventory.ts:300`), even though `CapabilityRecord` keeps the
two fields separate (`src/schemas/capability.ts`). A UI reading only the
inventory **cannot** tell `known-none` from empty-`known` from `unknown`.
**Inventory must go three-valued before any effort picker ships** (governing doc
§4.2.3, PR2).

---

## 3. Ground truth the UI must absorb

### 3.1 Providers Hive knows today

Canonical enum: `claude` | `codex` | `grok` (`src/schemas/capability.ts`).

| Provider id | Card title | Vendor mark |
| --- | --- | --- |
| `claude` | Claude Code | Anthropic official mark |
| `codex` | Codex | OpenAI official mark |
| `grok` | Grok | xAI official mark |

The UI is keyed by `CapabilityProvider` and built through the single legal
enumerator (`CAPABILITY_PROVIDERS` / `forEachProvider`) — never a hardcoded
three-card layout, never an ad-hoc `["claude", "codex"]` literal. That literal is
exactly how Grok became invisible in `buildModelInventory` and `cli/routing.ts`
while being fully discovered underneath (governing doc §2.2). The MCC must pass
the **fourth-provider test**: a vendor Hive has never seen, with a novel model
and an effort level named `overdrive`, appears on this screen with no UI change.

### 3.2 Usage data is heterogeneous

| Provider | Short window | Long window | Absolute counts | Notes |
| --- | --- | --- | --- | --- |
| Claude Code | `utilization` 0–100 via `get_usage` | `seven_day` | **No** | Confidence `reported`. **Experimental; goes silent — §2.2** |
| Codex | shorter window (~300 min) | longer window (~10080 min) | **No** | Can be `authoritative` — `account/rateLimits/read` is stable protocol |
| Grok | **None** | **None** — only a `currentPeriod.end` reset boundary | **No** | Money guard only — §2.3 |

### 3.3 Unknown is a first-class value

From `QuotaWindowStatus` (`src/schemas/quota.ts`):

- `used`, `remaining`, `remainingPct`, `allowance` may each be `null`
- `null` means **unknown** — not 0, not 100
- Hive-local ledger spend on an unconfigured provider is **local recorded
  spend**, never account usage. If shown, label it Hive-only; it must not look
  like a quota meter.

Confidence: `authoritative` | `reported` | `estimated` | `missing` | `stale`.

Near-limit thresholds exist in config as fractions of **remaining**, not used:

- warning when `remainingPct ≤ warningRemainingPct` (default **0.25**)
- critical when `remainingPct ≤ criticalRemainingPct` (default **0.1**)

Styling follows those live config values, not a hardcoded "80% used."

### 3.4 Billing ≠ capacity

`spendRisk` (`src/daemon/usage-credits.ts`) answers **"would this spend
money?"**, not "how full is the bar."

- Plan headroom + credits off → free
- Exhausted + credits on → would-spend (consent)
- Exhausted + credits unknown (Codex auto-top-up) → ask, with uncertainty copy
- Grok: rails zero → paid overflow off; any positive rail → loud money-state
  change; **the unit of `val` is UNKNOWN** — show the raw change, invent no
  currency label

When paid overflow is off, do **not** nag "may spend money." The wallet is safe;
a plan limit is a wall, not a bill.

### 3.5 The router this screen drives (settled)

The four tiers (`deep` | `standard` | `cheap` | `review`) and the hardcoded
tier→vendor preference (`TIER_PREFERRED_TOOL`) are **being deleted**. **Task
categories replace them.** There is no mapping to display, no aliasing to
disclose, and no "currently applied as routing tier: deep" caption. The old
draft's nine-roles-vs-four-tiers mismatch is not an open question — it is a
migration that ends with the tiers gone (governing doc §3.2, §5).

---

## 4. Settled decisions this screen encodes

The first draft listed these as open. They are closed. An implementer who
reopens them is building the wrong screen.

| Question | Ruling (governing doc) |
| --- | --- |
| Empty category → refuse, or fall back? | **Fall back, within consent.** Never "any enabled model." |
| Fall back to *what*? | The **`default` chain** — user-authored, ordered policy. |
| Does the user confirm it first? | **No.** It **ships provisional-and-ACTIVE** with researched exact targets, labeled provisional, editable. No confirmation prompt; no per-spawn approval beyond `spendGuard`. |
| Nine roles vs four tiers? | **Categories replace tiers.** Tiers and `TIER_PREFERRED_TOOL` are deleted. |
| Is `long_context` a role? | **No.** It is a **requirement modifier** (`minContextTokens`) cutting across every category. |
| Where does policy persist? | **SQLite in `hive.db`** — daemon sole writer, CAS revision + audit, deterministic export. |
| How does the app reach it? | The `hive` **CLI as a subprocess** (§10). |

**"Fall back within consent" is not "any enabled model."** Consent answers *may
this vendor charge me?* It does not answer *which of six enabled models should do
code review?* An ordering is required, and if Hive invents one, that invention
becomes the real router — the exact defect this redesign exists to kill. The
ordering is the user's `default` chain. The UI must never suggest otherwise.

**Empty ≠ exhausted.** An *empty* category walks the `default` chain. A category
with a *deliberate* chain whose every link gated out **refuses by default**;
widening to the global chain requires that category's explicit
`exhaustion_behavior: use_global_fallback`. That is a per-category control on
this screen (§8.2).

---

## 5. Goals and non-goals

### Goals

1. Every discovered provider and model is visible and controllable — including a
   vendor Hive learned about after this screen shipped.
2. Usage and billing shown **honestly** under percent-only, silent, stale, and
   money-guard-only data.
3. Assign models to categories as **ordered fallback chains**, never ensembles.
4. Provider-off override is visually undeniable on every model row beneath it.
5. Effort is three-valued and never fabricated.
6. Warn on degenerate policy: no providers enabled; a chain whose every model is
   ineffective; an emptied `default` chain.

### Non-goals

- Re-implementing vendor TUIs, billing portals, or account management.
- Fabricating absolute request/token allowances (§2.1 — impossible for all).
- Parallel / ensemble multi-model execution.
- Per-turn cost prediction (a known false-negative gap in `spendRisk` — the UI
  does not close it and must not pretend to).
- Editing `quota.toml` manual unit pools.
- Logo artwork production — the implementer sources official marks.

---

## 6. Information architecture

```
Settings
└── Model Control Center
    ├── Page header + global warnings + provisional-defaults banner
    ├── Provider list (cards)
    │   ├── Provider card (collapsed summary)
    │   └── Provider card expanded
    │       └── Model rows
    ├── Task categories (ordered chains) + Default chain
    └── Footer: last refreshed, confidence legend
```

**Two binding axes**, both primary:

1. **Provider → models** — discovery, enablement, effort, usage/billing.
2. **Task category → ordered chain** — the routing policy the human owns.

Enablement on axis 1 feeds eligibility on axis 2. A model disabled (by itself or
by its provider) must never appear as an active chain member without ineffective
chrome (§7.4).

---

## 7. Layout, states, and components

### 7.1 Desktop (≥ 900 pt content width)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Model Control Center                                                    │
│  Choose which tools Hive may use, and which models handle each kind of   │
│  work. Usage numbers are what the provider reported — never estimates    │
│  dressed as measurements.                                                │
│                                                                          │
│  ℹ Provisional Hive suggestions — edit anytime; no outcome data yet.     │  ← until edited
│  ⚠ No providers enabled — Hive cannot spawn agents until at least one    │
│    provider is turned on.                                                │  ← conditional
├────────────────────────────────────────────┬─────────────────────────────┤
│  PROVIDERS                                 │  TASK CATEGORIES            │
│                                            │                             │
│  ┌──────────────────────────────────────┐  │  Complex coding             │
│  │ [Anthropic] Claude Code        [on] │  │  1. claude · Opus 4.8 · high │
│  │ Max plan · Paid overflow off        │  │  2. codex  · …      · med    │
│  │ 5h  ████████░░  63% used            │  │  [+ Add model]  ⋮⋮ drag     │
│  │ 7d  ████░░░░░░  42% used            │  │  If all unavailable: Refuse ▾│
│  │ Resets 5h in 2h 14m · 7d in 3d      │  │                             │
│  │ ▾ 4 models                          │  │  Summarization              │
│  └──────────────────────────────────────┘  │  (no models)                │
│  ┌──────────────────────────────────────┐  │  ⚠ Uses your Default chain. │
│  │ [OpenAI] Codex                 [on] │  │                             │
│  │ …                                   │  │  ─────────────────────────  │
│  └──────────────────────────────────────┘  │  Default (global fallback)  │
│  ┌──────────────────────────────────────┐  │  Used when a category has   │
│  │ [xAI] Grok                     [on] │  │  no chain of its own.       │
│  │ SuperGrok · Paid overflow off       │  │  1. …                       │
│  │ ⚠ Usage limits cannot be tracked    │  │  2. …                       │
│  │   for this provider                 │  │                             │
│  │ Next weekly reset: Tue 19:00 UTC    │  │                             │
│  │ (reset time only — no capacity)     │  │                             │
│  └──────────────────────────────────────┘  │                             │
├────────────────────────────────────────────┴─────────────────────────────┤
│  Last refreshed 12s ago · Confidence legend · Measure or say unknown     │
└──────────────────────────────────────────────────────────────────────────┘
```

- Two-column split: providers ~55–60%, categories ~40–45%.
- Cards use grouped inset style over system materials (`NSVisualEffectView`).
- Expanded model rows nest indented under the card.
- Below ~900 pt a segmented control switches Providers / Task categories. Do not
  shrink two columns until illegible. Controls stay ≥ 28 pt.

### 7.2 Visual hierarchy

| Layer | Treatment |
| --- | --- |
| Page title | System title2 / 22 pt semibold |
| Section label | 11–12 pt secondary, title case + tracking |
| Provider name | 15 pt semibold |
| Card meta (plan, billing) | 12 pt secondary |
| Meter label + value | 11–12 pt; monospaced digits for the percent |
| Model display name | 13 pt |
| Model id | 11 pt tertiary, monospaced |
| Badges | 10–11 pt medium; capsule |
| Warnings | 12 pt; orange or red semantic — never pure gray for an important unknown |

Hyprland inspires the Workspace's **tiling behavior**, never this settings
chrome. Settings is standard macOS settings density.

### 7.3 Component inventory

| Component | Responsibility |
| --- | --- |
| `ModelControlCenterView` | Page shell, refresh, global banners |
| `ProviderCard` | Mark, title, master toggle, billing strip, meters **or** unmetered panel, disclosure |
| `UsageMeter` | One window: percent, unknown, stale, near-limit, healthy |
| `UnmeteredUsagePanel` | Grok (and any vendor with no capacity surface) — §7.5 |
| `BillingStatusChip` | Credits / paid overflow / unknown money state |
| `ModelRow` | Enable toggle, name + id, effort control, override chrome, availability |
| `EffortControl` | Three-valued: picker \| "no effort setting" \| "options unknown (reason)" |
| `CategorySection` | Category header + ordered chain + exhaustion control |
| `DefaultChainSection` | The global fallback chain; visually distinct, never deletable |
| `FallbackChainList` | Drag reorder, rank labels, remove |
| `ChainEntryPicker` | Add an **exact** model, or the labeled **vendor-default** mode (§8.3) |
| `WarningBadge` | Capsule badge with SF Symbol + copy |
| `ConfidenceLegend` | Footer popover explaining each confidence value |
| `ProviderMarkImage` | Official vendor mark, light/dark safe |

### 7.4 State matrices

**Provider card**

| State | When | Visual |
| --- | --- | --- |
| `enabled` | Master on, CLI present, discovery OK | Full opacity; meters or unmetered panel |
| `disabled` | Master off | Content ≈0.55 opacity; badge **Off — Hive will not invoke this CLI**; still expandable |
| `unavailable` | CLI absent / not signed in / probe failed closed | Dashed border; badge **Not available**; master locked; measured probe error in detail |
| `usage-healthy` | Windows known, above warning remaining | Neutral fill |
| `usage-near-limit` | Any window remaining ≤ warning | Amber fill + **Near limit** on that window |
| `usage-critical` | Any window remaining ≤ critical | Red fill + **Critically low** |
| `usage-silent` | **Normally metered vendor, no reading** — Claude's experimental feed went quiet | **No determinate track.** Hatched/absent bar + **Usage unknown** + measured reason. Provider stays enabled and spawnable |
| `usage-stale` | Reading aged past freshness | Last percent, desaturated, **Stale reading** + age. Refresh action |
| `usage-unmetered` | Vendor publishes no capacity at all (Grok) | `UnmeteredUsagePanel` — never a meter |
| `billing-off` | Paid overflow known off | Chip **Paid overflow off** (calm) |
| `billing-on` | Credits known on | Chip **Credits available** |
| `billing-unknown` | Overflow switch unreadable | Chip **Billing state unknown** |
| `billing-would-spend` | Exhausted plan + live overflow path | Chip **May spend money** (amber) |

`usage-silent` and `usage-unmetered` are **different states with different
copy**. One is "the vendor has nothing to report, by design." The other is "the
vendor normally reports and did not." They must not share a component.

**Model row**

| State | When | Chrome |
| --- | --- | --- |
| `enabled` | Self on, provider on, in live catalog | Full strength |
| `disabled-by-self` | Self off, provider on | Tertiary labels; caption **Disabled** |
| `disabled-by-provider` | Provider master off | Dimmed; caption **Off because {Provider} is off**; the stored preference is shown but **non-authoritative** — never a green "enabled" while the provider is off |
| `unavailable` | Not in the live catalog / not entitled | Badge **Unavailable**; toggle disabled |
| `pool-exhausted` | Measured pool exhausted, no free path | Badge **Plan limit reached**; still settable as a preference — the spawn path gates it |

**Override rule (non-negotiable):**
`effectiveEnabled = providerEnabled && modelSelfEnabled && modelAvailable`.
When effective and preference differ, the UI shows **both**.

**Meter**

| State | Render | Forbidden |
| --- | --- | --- |
| Percent known | Track filled to `usedPercent`; **{n}% used**; reset caption when known | Any absolute count — **no vendor has a denominator** |
| Only `remainingPct` known | Fill = `1 - remainingPct`; label **remaining** | Mixing an invented "used" with a known "remaining" |
| Measured zero | **0% used** — that is the truth | — |
| Unknown / silent | **No determinate track.** Hatch or no bar; **Usage unknown** + reason | An empty bar (reads as 0% used); a gray full bar; the string "0%" |
| Stale | Last percent, reduced contrast, **Stale reading** + age | Presenting stale as fresh |
| Estimated (Hive added unreported spend) | Percent + badge **Includes Hive estimate** | Badging it `authoritative` |
| Unmetered vendor | **Do not mount this component at all** | Drawing money rails as a gauge |

**Chain**

| State | Visual |
| --- | --- |
| ≥1 effective model | Numbered list; "Primary", "If unavailable…" — never "Ensemble" or "Also run" |
| All links ineffective | Struck list; **Every model in this chain is off or unavailable** + what the category will actually do |
| Empty chain | **Uses your Default chain** — informational, not an error |
| Empty `default` chain | **Warning.** This is the one chain that must not be empty |
| Reordering | Drag handle; live renumber; Primary is index 0 |

### 7.5 The unmetered panel (Grok) — deliberate, not broken

```
┌─────────────────────────────────────────────────────────────┐
│ [xAI] Grok                                        ● ON      │
│ SuperGrok · Paid overflow off                               │
│                                                             │
│  ┌─ muted inset ─────────────────────────────────────────┐  │
│  │  ℹ  Usage limits cannot be tracked for this provider  │  │
│  │                                                       │  │
│  │  xAI does not report plan capacity to Hive. Money     │  │
│  │  rails are monitored so Hive does not silently spend  │  │
│  │  on-demand balance; they are not a usage gauge.       │  │
│  │                                                       │  │
│  │  Next weekly reset boundary: 2026-07-15 19:00 UTC     │  │
│  │  (reset time only — not remaining quota)              │  │
│  └───────────────────────────────────────────────────────┘  │
│ ▸ 2 models                                                  │
└─────────────────────────────────────────────────────────────┘
```

- Same card chrome, padding, and mark weight as Claude and Codex. Grok is a
  first-class vendor with an unmeasurable surface, not a broken card.
- Inset uses **secondary grouped fill**, not error red.
- Icon `info.circle` — **not** `xmark.octagon`.
- **No hollow meter track.** A hollow track reads as an empty tank.
- If the Grok probe fails entirely (no tier, no reset boundary): **Billing and
  usage unknown** with the measured error — still no fake meter.

### 7.6 The meter

```
  5 hour window
  [████████████░░░░░░░░]  63% used
  Resets in 2 hours

  7 day window
  [████████████████████]  100% used · Plan limit reached
  Resets Wed 19:00

  (silent / unknown)
  [· · · · · · · · · · ·]  Usage unknown
  Claude Code reported no usage data (experimental surface)
```

1. Fill = `used / 100`, only when `used` is a known percent.
2. `used == 0` with a real reading → **"0% used"**. Data absent → **never** 0%.
3. Confidence is available as secondary detail: "Reported by Claude Code · 12s ago."
4. Two meters side-by-side only above ~320 pt of meter block; otherwise stack.

---

## 8. Task categories and chains

### 8.1 The categories

Stable snake_case ids for persistence:

| id | Label |
| --- | --- |
| `light_research` | Light research |
| `heavy_research` | Heavy research / synthesis |
| `simple_coding` | Simple coding |
| `complex_coding` | Complex coding |
| `code_review` | Code review |
| `planning` | Planning |
| `debugging` | Debugging |
| `summarization` | Summarization |
| `default` | **Default (global fallback)** — used when a category has no chain |

`long_context` is **not on this list.** It was a role in the first draft; it is a
**requirement modifier** (§8.4).

### 8.2 Chain section

```
  Complex coding
  Hive tries models in order. Only one runs — not an ensemble.

  ⋮⋮  1  Primary   Claude Code · Opus 4.8 · high                     [−]
  ⋮⋮  2  Fallback  Codex · vendor default (currently gpt-x) · medium [−]
  ⋮⋮  3  Fallback  Grok · grok-4.5 · (no effort setting)             [−]

  [ + Add model ]

  If every model above is unavailable:  ( • ) Refuse   (   ) Use Default chain
```

- Section subtitle, fixed: **"Ordered fallback — one model at a time. Not an
  ensemble."**
- Rank labels **Primary**, **2nd**, **3rd**… Never an icon implying parallelism.
- The **exhaustion control** is per-category and defaults to **Refuse** (governing
  doc §2.7). It is a different concept from an *empty* chain and the UI must not
  let the two blur: an empty chain quietly uses `default`; an exhausted deliberate
  chain refuses unless the user opted in right here.
- Effort is **per chain link**, not only per model row. The same model may sit at
  `high` in complex coding and `medium` in summarization.

### 8.3 Chain entries are exact — with one labeled exception

```
ChainEntry =
  | { mode: "exact";          provider; model; variant?; effort }
  | { mode: "vendor-default"; provider;                  effort }
```

- **`exact`** is what almost every UI edit produces: a concrete model id.
- **`vendor-default`** is the user saying *"keep me on this vendor's current
  default."* It is **opt-in**, rendered as **volatile** ("vendor default —
  currently *X*"), re-resolved from live discovery at every spawn, and **never
  cached as an identity** in the policy row. Vendors move their defaults under us
  without notice; a cached resolution would be a stale lie.
- There is **no bare `"default"` string** that a reader could mistake for a model
  id. That token is how a quiet system default sneaks back in.

### 8.4 Requirement modifiers, not more categories

A spawn may carry requirements that cut **across** every category:

| Modifier | Meaning | UI |
| --- | --- | --- |
| `minContextTokens` | This job needs a big window | A context-demand control on **any** category — not a category of its own |
| `codingRequired` | Model must be able to write code | Capability floor |
| `independentOfProvider` | Review must not reuse the producer's vendor | Capability floor |
| `requiredTools` | Named tools must be available | Capability floor |

**Context size is not a discovered field across vendors today.** The UI must not
show a per-model context window it does not have. Where context is unknown the
gate **fails closed** — an unknown window does not satisfy a minimum. Say that
where the control lives; do not invent a number to fill a column.

**Floors are not enablement.** A capability floor blocks a model **even when the
user pinned it explicitly.** Enablement is user policy; floors are capability
truth. The UI must not present a floor refusal as "you disabled this."

### 8.5 The provisional default chain

The `default` chain **ships pre-filled and ACTIVE** with researched exact targets
resolved against the **live discovery catalog** at migration — not from training
memory, not from a table frozen in the binary. It is not a draft, there is no
confirmation dialog, and spawns work on day one.

- Persistent banner until the user edits: **"Provisional Hive suggestions — edit
  anytime; no outcome data yet."**
- Each entry carries `confidence: documented | assumed`. Nothing claims
  `measured` until outcome telemetry exists.
- **Hive never auto-reorders a chain from telemetry.** It may show evidence and
  propose; the user re-ranks. Fallback traffic is selection-biased and the UI must
  say so wherever it shows outcome data.
- If a cited model is absent from the signed-in account, that link is skipped at
  migration and the reason recorded — never silently swapped.

---

## 9. Data model (UI contract)

The daemon owns the store: **SQLite in `hive.db`**, CAS revision, audit trail,
deterministic export. The UI never writes files under `~/.hive/`.

```ts
// Contract shape, not shipped code.
type ProviderId = CapabilityProvider;   // CLOSED enum: claude | codex | grok.
                                        // NOT `| string` — an open union is how a
                                        // vendor becomes invisible. Extend by schema
                                        // version + driver registration.

interface ModelControlPolicy {
  revision: number;                     // CAS: the UI sends the revision it read;
                                        // stale → daemon rejects, UI reloads
  providers: Record<ProviderId, {
    enabled: boolean;                   // master — off = no CLI invoke
    models: Record<string /* canonical model id */, {
      enabled: boolean;                 // preference; provider-off overrides
      effort: EffortTarget;
    }>;
  }>;
  categories: Record<CategoryId, {
    chain: ChainEntry[];                // ordered; only one link ever runs
    exhaustionBehavior: "refuse" | "use_global_fallback";
  }>;
  defaultChain: ChainEntry[];           // never empty; provisional-and-active
}

type EffortTarget =
  | { mode: "exact"; value: string }    // must be advertised by the model
  | { mode: "none" }                    // model stated it has no effort axis
  | { mode: "provider-controlled" };    // omit the flag; do NOT claim to know
                                        // the vendor's default
```

- **Provider-off overrides every descendant.** Effective state dominates chrome.
- **Absent model policy inherits the provider state** — a newly discovered model
  is reachable, but does not silently enter anyone's chain.
- **Orphaned chain targets** (the model left the catalog) stay in policy, are
  marked **unresolvable** in the UI, and are never silently dropped and never
  launched.
- Validation, enforced daemon-side and mirrored in the UI: no duplicate chain
  targets; an `exact` effort must be advertised; an effort on a `known-none` model
  is rejected; an unknown effort surface may only be `provider-controlled`.

Read models this screen consumes (never writes): the capability catalog + effort
records, `QuotaPoolStatus` / `QuotaUnconfiguredStatus`, `AccountBilling` /
spend risk, and the provider install/sign-in probe.

---

## 10. How the app talks to the daemon

**The Workspace is a native macOS AppKit app in Swift.** 3,331 lines, `NSView` +
Auto Layout, `NSAppearance` theming, semantic colors in `Theme.swift`. There is
**no SwiftUI, no HTML/CSS/JS, no design system, no component library, no token
file, and no existing settings screen.** This is the first one.

**The app does not speak HTTP to the daemon.** It **shells out to the `hive` CLI
as a subprocess and reads NDJSON from stdout** — see `FeedClient.swift`, which
runs `hive workspace-feed --port <n>` as a long-lived `Process` and parses
newline-delimited JSON. `hive autonomy` follows the same pattern.

| Item | Spec |
| --- | --- |
| Stack | AppKit. `NSView` subclasses + Auto Layout. Build new views the way `PaneView.swift` and `ProjectSwitcher.swift` build theirs |
| Theming | `NSAppearance` + system semantic colors via `Theme.swift`. Extend `Theme` for meter tokens; do not fork it |
| Transport | `Process` → `hive models` / `hive routing …` / the approvals CLI; NDJSON on stdout. **Never** a direct HTTP call, **never** a direct write to `~/.hive/` |
| Writes | UI intent → daemon validates against the live registry → one transaction, revision bumped, audit row written. The UI sends `expectedRevision`; stale is rejected, not merged |
| Optimism | **None.** The UI does not mutate local policy ahead of the daemon, and does not decrement meters locally when a spawn starts |
| Consent | Inline approve routes through the **existing approvals queue**, not a second store |
| Previews | Fixture-driven. Fixtures must include: three-valued effort, a silent Claude feed, a stale reading, and the Grok unmetered panel |
| Entry | `Hive → Settings…`, section **Models** |

A design that assumes the AppKit app speaks HTTP is wrong. A design that assumes
it writes `~/.hive/*.json` itself is also wrong.

---

## 11. Light and dark

Both first-class. No inverted-light dark mode.

| Token | Light | Dark |
| --- | --- | --- |
| Page background | `windowBackgroundColor` | same semantic |
| Card fill | `controlBackgroundColor` / secondary grouped | same semantic |
| Primary / secondary label | `labelColor` / `secondaryLabelColor` | same semantic |
| Separator | `separatorColor` | `separatorColor` |
| Meter track | black @ 8–12% | white @ 10–14% |
| Meter fill healthy | accent / `systemBlue` | same (system adapts) |
| Meter fill warning / critical | `systemOrange` / `systemRed` | same |
| Meter unknown hatch | `secondaryLabelColor` @ 40% | same |
| Warning badge fill | orange @ 12% | orange @ 18% |
| Unmetered info badge | blue @ 10% | blue @ 16% |
| Disabled row | label @ 45–55% | label @ 45–55% |
| Focus ring | system focus | system focus |

Respect **Increase Contrast** and **Reduce Transparency** (solid fills instead of
thin materials), and **Reduce Motion** (instant disclosure, no expand spring —
`Theme.reduceMotion` already reads this). Do not hardcode hex that only works in
one appearance.

---

## 12. Vendor marks

| Provider | Source requirement |
| --- | --- |
| Claude Code | Official Anthropic brand assets only |
| Codex | Official OpenAI brand assets only |
| Grok | Official xAI brand assets only |

Do not invent SVG paths and do not hotlink third-party PNGs.

| Rule | Spec |
| --- | --- |
| Size | 20×20 pt in the card header; 16×16 in chain rows |
| Shape | Contain in square, preserve aspect; no circle crop that clips a trademark |
| Color vs mono | Prefer single-color template images tinted to `labelColor`; use official color marks only where brand guidelines require **and** contrast ≥ WCAG AA on the card fill |
| Dark mode | Dark-safe asset or template tint; never a black mark on a dark fill |
| Missing asset | SF Symbol fallback **plus** the text name — never a broken image frame |
| Spacing | 8 pt between mark and title |

---

## 13. Copy catalog

Exact strings. Do not rephrase in ways that soften "unknown."

### Badges

| id | Copy |
| --- | --- |
| `badge.usage_untracked` | Usage limits cannot be tracked for this provider |
| `badge.usage_unknown` | Usage unknown |
| `badge.usage_stale` | Stale reading |
| `badge.near_limit` | Near limit |
| `badge.critical` | Critically low |
| `badge.plan_limit` | Plan limit reached |
| `badge.provider_off` | Off — Hive will not invoke this CLI |
| `badge.not_available` | Not available |
| `badge.unavailable_model` | Unavailable |
| `badge.paid_overflow_off` | Paid overflow off |
| `badge.credits_available` | Credits available |
| `badge.billing_unknown` | Billing state unknown |
| `badge.may_spend` | May spend money |
| `badge.includes_estimate` | Includes Hive estimate |
| `badge.provisional` | Provisional |
| `badge.unresolvable` | Model no longer offered by this provider |

### Meters and the silent feed

| id | Copy |
| --- | --- |
| `meter.used_pct` | {n}% used |
| `meter.remaining_pct` | {n}% remaining |
| `meter.window_5h` | 5 hour window |
| `meter.window_7d` | 7 day window |
| `meter.resets_in` | Resets in {relative} |
| `meter.resets_at` | Resets {absolute} |
| `meter.unknown_body` | Hive has no reading for this window |
| `meter.silent_feed` | {ProviderTitle} reported no usage data. This surface is experimental and sometimes goes quiet — {ProviderTitle} itself is still available. |
| `meter.stale_age` | Last read {relative} ago |
| `meter.estimated_footnote` | Part of this figure is Hive's estimate of spend since the last provider reading |

### Unmetered provider

| id | Copy |
| --- | --- |
| `unmetered.title` | Usage limits cannot be tracked for this provider |
| `unmetered.body` | xAI does not report plan capacity to Hive. Money rails are monitored so Hive does not silently spend on-demand balance; they are not a usage gauge. |
| `unmetered.reset` | Next weekly reset boundary: {absolute} |
| `unmetered.reset_footnote` | Reset time only — not remaining quota |
| `unmetered.money_changed` | Paid capacity rails changed (raw values shown; unit unknown) |

### Effort

| id | Copy |
| --- | --- |
| `effort.none` | This model has no effort setting. |
| `effort.unknown` | Effort options unknown — {reason} |
| `effort.provider_controlled` | Vendor default (Hive sends no effort flag) |

`effort.none` and `effort.unknown` are **not interchangeable** (§2.4).

### Models, chains, warnings

| id | Copy |
| --- | --- |
| `model.overridden_by_provider` | Off because {ProviderTitle} is off |
| `model.preference_on_overridden` | Your preference: on (not effective) |
| `model.disabled_self` | Disabled |
| `model.pool_exhausted` | Plan capacity exhausted for this model |
| `subtitle.fallback` | Ordered fallback — one model at a time. Not an ensemble. |
| `chain.vendor_default` | Vendor default — currently {ModelDisplayName} |
| `chain.vendor_default_note` | Tracks this vendor's current default. It can change without notice. |
| `chain.empty_uses_default` | No chain of its own — uses your Default chain. |
| `chain.all_ineffective` | Every model in this chain is off or unavailable. |
| `chain.exhaustion_refuse` | If every model here is unavailable, spawns for this category will fail. |
| `chain.exhaustion_widen` | If every model here is unavailable, Hive will use your Default chain. |
| `warn.no_providers` | No providers enabled — Hive cannot spawn agents until at least one provider is turned on. |
| `warn.default_chain_empty` | Your Default chain is empty. Categories with no chain of their own have nowhere to go. |
| `banner.provisional` | Provisional Hive suggestions — edit anytime; no outcome data yet. |
| `footer.honesty` | Measure or say unknown. Zero means measured zero; blank means Hive cannot tell. |

There is **no** "Hive will fall back to any enabled model" string. That behavior
does not exist and must not be promised.

### Accessibility

| id | Copy |
| --- | --- |
| `a11y.provider_toggle` | Enable {ProviderTitle} |
| `a11y.model_toggle` | Enable {ModelDisplayName} |
| `a11y.model_toggle_overridden` | {ModelDisplayName}, off because {ProviderTitle} is off |
| `a11y.meter` | {WindowLabel}: {n} percent used |
| `a11y.meter_unknown` | {WindowLabel}: usage unknown |
| `a11y.chain_rank` | {ModelDisplayName}, fallback position {n} of {total} |

---

## 14. Interaction

| Action | Behavior |
| --- | --- |
| Toggle provider | Write preference; every child row flips to override chrome immediately |
| Toggle model | Write preference; if the provider is off, the override caption persists |
| Change effort | Validated against the live advertised set on save **and** again at spawn |
| Drag reorder | Updates order; Primary is index 0; persisted as an ordered list |
| Add to chain | Picker offers **effective** models first; a disabled model may be added, with a warning badge on the row |
| Change exhaustion behavior | Per-category; default **Refuse** |
| Refresh | Re-probe capabilities, billing, quota. **If a value that was known becomes unknown, the meter must change state** — never leave a stale number wearing a fresh label |
| Stale write | Daemon rejects on revision mismatch; the UI reloads and says so rather than merging blind |

---

## 15. Places this design would MISLEAD if built carelessly

Review gates. Each is a way to ship a confident lie.

1. **Grok money rails as a meter.** `onDemandUsed` / `prepaidBalance` drawn as
   remaining quota. The zeros read as a full tank. **Forbidden.**
2. **Unknown as an empty bar.** A determinate bar at 0 says "measured, nearly
   nothing used." The user green-lights heavy work on a number that does not exist.
3. **A silent Claude feed rendered as a zeroed meter.** The most likely instance
   of (2), because that feed is experimental and **actually goes quiet** (§2.2).
4. **Absolute counts.** "128 of 500" is fiction for **every** provider. Nobody
   publishes a denominator.
5. **`known-none` effort shown as unknown**, or unknown shown as "no effort axis."
   Two different facts; one greyed-out control for both is a lie.
6. **"Falls back to any enabled model."** It does not. Empty → the user's
   `default` chain. Anything else is Hive inventing an order and becoming the
   router again.
7. **Blurring empty and exhausted.** Empty walks the default chain; an exhausted
   deliberate chain refuses unless the user opted in.
8. **A floor refusal shown as "you disabled this."** Floors bind even an explicit
   pin. That is capability truth, not user policy.
9. **Provider off but the model toggle still looks on.** Effective state must
   dominate chrome.
10. **Hive's estimate wearing a provider's badge.** A figure that includes
    post-reading ledger spend is **Includes Hive estimate** — never `authoritative`.
11. **Stale numbers without an age.** A six-hour-old 12% is not headroom.
12. **Local ledger spend as account quota.** `fiveHourRecorded` is Hive-only.
    Label it or omit it.
13. **Ensemble language.** "Also use," "team of models," an unordered multi-select
    — all imply parallel execution Hive does not do.
14. **A billing-off nag.** Paid overflow off means the wallet is safe. Do not warn
    about spending.
15. **An open `ProviderId` union.** `"claude" | "codex" | "grok" | string` reopens
    the Grok-class hole at the UI contract. Closed enum only.

---

## 16. Security and privacy

- The screen shows plan type, utilization percent, reset times, and money-rail raw
  values — all already available to the local user through the same CLIs. No new
  network call originates in the UI.
- No account email unless it is already shown elsewhere and necessary; prefer the
  plan tier.
- No prompts or transcripts on this screen.
- Policy writes are logged with a timestamp and no secrets. Refresh failures
  surface the **measured** error string, in the UI and in the daemon log.
- Do not poll vendor endpoints more aggressively than the daemon's existing
  refresh interval (`refreshIntervalMinutes`, default 15).

---

## 17. Build order

This screen is **PR6 in the governing sequence** and depends on the policy store
(PR4). Building it earlier means building against a contract that does not exist.

| Step | Ship | Acceptance |
| --- | --- | --- |
| **1. Read-only shell** | AppKit settings scene; provider cards; percent meters; silent/stale states; Grok unmetered panel; model list; light + dark; fixture previews | Unknown never renders as 0%. Grok has no determinate bar. A silent Claude feed does not read as an empty tank. |
| **2. Read API** | `hive` CLI subcommands returning providers, models, **three-valued** effort, quota windows, billing chips | Positive controls in tests for: claude percent, claude silence, codex percent, grok null capacity, `known-none` effort, `unknown` effort |
| **3. Enablement + effort writes** | Policy writes through the daemon with CAS; spawn honors `effectiveEnabled` | Provider off blocks every spawn on that CLI. An unadvertised effort is rejected at save **and** at spawn. |
| **4. Category chains + default chain** | Chain editor, per-category exhaustion control, provisional-active default chain | Order is visible and reorderable. No ensemble language. Empty vs exhausted behave differently and say so. |
| **5. Edge honesty** | Stale treatment, estimate badges, unresolvable chain targets, a11y audit, marks | Every item in §15 fails closed under review. |

**Do not wire chain writes before the gatekeeper (`AuthorizedLaunch`) is on
main.** Populating chains against today's ungated quota candidate path is how
Hive spends money without consent (governing doc §1, §5).

---

## 18. Success criteria

- [ ] Claude and Codex cards show percent meters with **no absolute fiction**
- [ ] A silent Claude usage feed renders as unknown-with-a-reason, **not** 0%, and
      does not disable the provider
- [ ] Grok shows the warning badge and the unmetered panel — **zero** money-rail
      gauges — and looks deliberate, not broken
- [ ] `known-none` effort, `unknown` effort, and a real picker are three visibly
      different things
- [ ] Provider off paints every model beneath it as overridden, never enabled
- [ ] `disabled-by-self` ≠ `disabled-by-provider` ≠ `unavailable` (three looks)
- [ ] An empty category says it uses the Default chain; an exhausted chain says
      what it will actually do
- [ ] No string anywhere promises "any enabled model"
- [ ] `long_context` appears **nowhere** as a category
- [ ] The `ProviderId` in the UI contract is the closed `CapabilityProvider` enum
- [ ] Light and dark both pass contrast on meters and badges
- [ ] Chain copy forbids an ensemble reading
- [ ] No SwiftUI, no HTTP, no direct writes to `~/.hive/`

---

## 19. Still open

Genuinely undecided, and small. Everything the first draft called open in its
§21 is **settled** — see §4.

1. **Per-model pools as row badges.** Card-level pools are the v1 story;
   model-scoped pools (where a vendor exposes one) could be a row badge later.
2. **Codex reset grants.** "You have N full resets" is real, useful, and surfaced
   by no CLI today. A secondary chip, if the product wants it.

---

## 20. References

- `docs/architecture/router-redesign-recommended.md` — **the governing
  architecture.** Categories, chains, gates, policy store, PR order
- `docs/research/provider-quota-surfaces.md` — wire shapes; percent-only;
  estimate vs measurement
- `docs/architecture/grok-integration-spec.md` §10 — Grok money guard, null capacity
- `docs/architecture/hive-workspace-blueprint.md` — Workspace visual language
- `src/schemas/quota.ts` — `QuotaWindowStatus`, confidence, null usage
- `src/schemas/capability.ts` — provider enum, `Discovered<T>`, effort records
- `src/daemon/quota-sources.ts` — Claude's experimental `get_usage`; Codex's
  authoritative `account/rateLimits/read`
- `src/daemon/model-inventory.ts` — the two-valued effort surface §2.4 requires be
  fixed first
- `src/daemon/usage-credits.ts` — `AccountBilling`, `spendRisk`
- `workspace/Sources/HiveWorkspace/Theme.swift` — semantic colors and fonts
- `workspace/Sources/HiveWorkspace/FeedClient.swift` — the CLI-subprocess + NDJSON
  transport this screen uses
