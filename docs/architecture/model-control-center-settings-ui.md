# Model Control Center — Settings UI Design Spec

| Field | Value |
| --- | --- |
| Status | Design discovery (read-only) |
| Author | cesar (Hive writer) |
| Date | 2026-07-12 |
| Product surface | Hive Workspace app (`workspace/`) settings |
| Quality bar | ChatGPT / Claude settings polish: calm hierarchy, system materials, no inventing numbers |
| Implementation | **Not started** — this document is specification only |

---

## 1. Overview

The Model Control Center is a settings screen inside the Hive Workspace app where a human turns providers and models on or off, sets per-model effort, and assigns models to task roles as **ordered fallback chains**. It also shows honest capacity and billing state: what Hive measured, and what Hive does not know.

This is not a marketing dashboard. The hard product rule — already law in `src/schemas/quota.ts`, `docs/research/provider-quota-surfaces.md`, and `docs/architecture/grok-integration-spec.md` §10 — is:

> **Measure or say unknown. Never invent a number. Never render zero where the truth is “we cannot tell.”**

An implementer who ships a pretty empty bar labeled “0% used” for Grok, or “X of Y remaining” when the wire only carries percent, has failed this design even if every layout pixel is perfect.

---

## 2. Ground truth the UI must absorb

These are measured facts in this repo, not aspirations. Design **for** them.

### 2.1 Providers Hive knows today

Canonical enum: `claude` | `codex` | `grok` (`src/schemas/capability.ts`). Display names:

| Provider id | Card title | Vendor mark |
| --- | --- | --- |
| `claude` | Claude Code | Anthropic official mark |
| `codex` | Codex | OpenAI official mark |
| `grok` | Grok | xAI official mark |

More providers later: the component inventory is keyed by `CapabilityProvider`, not by a hard-coded three-card layout.

### 2.2 Usage data is heterogeneous

| Provider | 5-hour window | 7-day / weekly window | Absolute counts | Notes |
| --- | --- | --- | --- | --- |
| Claude Code | Yes — `utilization` 0–100 via `get_usage` | Yes — `seven_day` | **No** | Confidence typically `reported` (experimental control frame) |
| Codex | Yes — shorter window sorted by `windowDurationMins` (~300) | Yes — longer window (~10080) | **No** | Confidence can be `authoritative` on `account/rateLimits/read` |
| Grok | **None measured** | **No capacity %** — only `currentPeriod.end` reset boundary | **No** | `_x.ai/billing` is a **money guard**, not a gauge. `onDemand*` / `prepaidBalance` must **never** be drawn as remaining quota |

Discovered pools are percent-denominated by construction (`QuotaWindowStatus.unit = "percent"`, allowance 100 when known). Manual `quota.toml` pools use operator units; this settings UI **defaults to discovered percent meters** and must not invent absolute denominators.

### 2.3 Unknown is a first-class value

From `QuotaWindowStatus` (`src/schemas/quota.ts`):

- `used`, `remaining`, `remainingPct`, `allowance` may each be `null`
- `null` means **unknown**, not 0, not 100
- Hive-local ledger spend on an unconfigured provider is **local recorded spend**, never account usage — if shown at all, it must be labeled as Hive-only and must not look like a quota meter

Confidence values: `authoritative` | `reported` | `estimated` | `missing` | `stale`.

Near-limit thresholds already exist in config (fractions of **remaining**, not used):

- warning when `remainingPct ≤ warningRemainingPct` (default **0.25** → ≤25% remaining ≈ ≥75% used)
- critical when `remainingPct ≤ criticalRemainingPct` (default **0.1**)

UI near-limit styling must follow these measured remaining thresholds (or the live config values), not a hard-coded “80% used” guess.

### 2.4 Billing ≠ capacity

Spend risk (`spendRisk` in `src/daemon/usage-credits.ts`) answers **“would this spend money?”**, not “how full is the bar.”

- Plan headroom + credits off → free (no spend)
- Exhausted + credits on → would-spend (consent)
- Exhausted + credits unknown (Codex auto-top-up) → ask, with uncertainty copy
- Grok: money rails zero → paid overflow off; any positive rail → loud money-state change; **unit of `val` is UNKNOWN** — show raw change without inventing a currency label unless a later measurement binds one

### 2.5 Routing today vs this screen’s IA

**Loud mismatch — do not paper over it.**

| This UI (requested IA) | Live Hive today (`docs/model-selection.md`, `src/schemas/routing.ts`) |
| --- | --- |
| Nine **task roles** (light research, heavy research, simple coding, …) | Four **routing tiers**: `deep`, `standard`, `cheap`, `review` |
| Per-role **ordered multi-model fallback chain** | No downshift chain; derivation is pin → account default → last-known-good → refuse; quota chooses between vendor cells, not a same-role ladder |
| Model enable/disable master controls | Floors + pins + spend/availability filters; no per-model “enabled” boolean in a settings store yet |
| Empty role “falls back to any enabled model” | Unresolved cell **refuses** with a reason — it does not silently pick a random enabled model |

**Design stance (required):**

1. The **settings surface** ships the requested nine-role IA as the human-facing policy model.
2. The **daemon contract** that persists and applies that policy is a separate implementation PR and must be explicit — see §12 and Open Questions.
3. Until the daemon implements ordered fallback chains, the UI **must not** claim “Hive will try secondary if primary fails” as live behavior. Ship either:
   - **A (recommended for honesty):** UI editable, with a visible “Policy not yet applied by router” banner until the router lands; or
   - **B:** Land router + UI together; settings screen is dark until then.

This document specifies the UI as if the persistence model in §11 exists. It flags every place where today’s router would make the UI a lie if shipped alone.

### 2.6 Effort is vendor-advertised strings

Effort is **not** a fixed Hive enum at ingestion (`EffortLevelSchema` = raw vendor strings). Per-model supported efforts come from live capability records. A model that advertises no levels (e.g. some Haiku / some Grok composer entries) shows no effort control — not a disabled fake dropdown of `low|medium|high`.

---

## 3. Goals and non-goals

### Goals

1. Let a human see every discovered provider and model, and control whether Hive may spawn them.
2. Show usage and billing **honestly** under percent-only, missing, and money-guard-only data.
3. Assign models to task roles as **ordered fallback chains** (primary → secondary → …), never as ensembles.
4. Make provider-off override visually undeniable on every model row under that provider.
5. Match Workspace visual language: macOS HIG, system materials, light **and** dark first-class (`docs/architecture/hive-workspace-blueprint.md`).
6. Warn on degenerate policy: no providers enabled; role with no enabled model while routing still has a soft fallback rule.

### Non-goals

- Re-implementing vendor TUIs, billing portals, or account management.
- Fabricating absolute request/token allowances.
- Parallel / ensemble multi-model execution UI.
- Per-turn cost prediction (explicit false-negative gap in `spendRisk` docs — do not pretend the UI closes it).
- Editing `quota.toml` manual unit pools in v1 (advanced; link-out only if useful later).
- Logo artwork production — implementer sources official vendor marks under their license terms.

---

## 4. Information architecture

```
Settings
└── Model Control Center          ← this screen (full page or settings pane)
    ├── Page header + global warnings
    ├── Provider list (cards)
    │   ├── Provider card (collapsed summary)
    │   └── Provider card expanded
    │       └── Model rows
    ├── Task role chains (second major section)
    └── Footer: last refreshed, confidence legend
```

**Two binding axes** (both visible; neither is hidden inside the other only):

1. **Provider → models** — discovery, enablement, effort, usage/billing.
2. **Task role → ordered model chain** — routing policy the human wants.

Enablement on axis 1 feeds eligibility on axis 2. A model disabled (self or provider override) must not appear as an active chain member without a strike-through / “inactive” treatment — see §7.

---

## 5. Layout

### 5.1 Desktop (≥ 900 pt content width)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Model Control Center                                                    │
│  Choose which tools Hive may use, and which models handle each kind of   │
│  work. Usage numbers are what the provider reported — never estimates     │
│  dressed as measurements.                                                │
│                                                                          │
│  ⚠ No providers enabled — Hive cannot spawn agents until at least one    │
│    provider is turned on.                                                │  ← conditional
├────────────────────────────────────────────┬─────────────────────────────┤
│  PROVIDERS                                 │  TASK ROLES                  │
│  (scroll)                                  │  (scroll, sticky header)    │
│                                            │                             │
│  ┌──────────────────────────────────────┐  │  Light research             │
│  │ [Anthropic] Claude Code        [on] │  │  1. claude · Sonnet · high  │
│  │ Plan · Max   Credits off            │  │  2. codex  · …     · med    │
│  │ 5h  ████████░░  63% used            │  │  [+ Add model]  ⋮⋮ drag     │
│  │ 7d  ████░░░░░░  42% used            │  │                             │
│  │ Resets 5h in 2h 14m · 7d in 3d      │  │  Complex coding             │
│  │ ▾ 4 models                          │  │  1. …                       │
│  └──────────────────────────────────────┘  │                             │
│  ┌──────────────────────────────────────┐  │  ⚠ Summarization has no     │
│  │ [OpenAI] Codex                 [on] │  │    enabled model assigned.  │
│  │ …                                   │  │    Hive will fall back to    │
│  └──────────────────────────────────────┘  │    any enabled model.       │
│  ┌──────────────────────────────────────┐  │                             │
│  │ [xAI] Grok                     [on] │  │                             │
│  │ SuperGrok · Paid overflow off       │  │                             │
│  │ ⚠ Usage limits cannot be tracked    │  │                             │
│  │   for this provider                 │  │                             │
│  │ Next weekly reset: Tue 19:00 UTC    │  │                             │
│  │ (no capacity meter — by design)     │  │                             │
│  └──────────────────────────────────────┘  │                             │
└────────────────────────────────────────────┴─────────────────────────────┘
│  Last refreshed 12s ago · Confidence legend · Measure or say unknown     │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Two-column split**: providers ~55–60%, task roles ~40–45%.
- Cards use grouped inset list style (system `NSVisualEffectView` / secondary grouped background).
- Expanded model rows nest indented under the card, full width of the left column.

### 5.2 Narrow (< 900 pt, including compact window / future split)

```
┌────────────────────────────────────┐
│ Model Control Center               │
│ [Providers] [Task roles]   ← segmented control
├────────────────────────────────────┤
│ (active segment full width)        │
│                                    │
│ Provider cards stack vertically;   │
│ meters stack under title, not      │
│ side-by-side with toggle.          │
│                                    │
│ Model rows: effort and role chips  │
│ wrap to second line.               │
└────────────────────────────────────┘
```

- Segmented control switches major sections; do not shrink two columns until illegible.
- Provider toggle stays top-right of card header at all widths.
- Touch targets ≥ 28 pt (AppKit control sizing).

### 5.3 Visual hierarchy (size / weight)

| Layer | Treatment |
| --- | --- |
| Page title | System title2 / 22pt semibold |
| Section label | 11–12pt secondary label, uppercase optional (prefer title case + tracking for HIG) |
| Provider name | 15pt semibold body |
| Card meta (plan, billing) | 12pt secondary |
| Meter label + value | 11–12pt; value uses monospaced digits where percent shown |
| Model display name | 13pt regular/semibold |
| Model id (secondary) | 11pt tertiary, monospaced optional |
| Badges | 10–11pt medium; capsule |
| Warnings | 12pt; orange or red semantic — never pure gray for “important unknown” |

Hyprland inspires **tiling behavior of the Workspace**, not this settings chrome. Settings = standard macOS settings density.

---

## 6. Component inventory

| Component | Responsibility |
| --- | --- |
| `ModelControlCenterView` | Page shell, refresh, global banners |
| `ProviderCard` | Logo, title, master toggle, billing strip, meters or unknown panel, expand chevron |
| `UsageMeter` | One window (5h or 7d): percent-only, unknown, near-limit, healthy |
| `BillingStatusChip` | Credits / paid overflow / unknown money state |
| `WarningBadge` | Capsule badge with SF Symbol + copy |
| `ModelRow` | Enable toggle, name, effort control, override chrome, availability |
| `EffortPicker` | Vendor-advertised levels only; or “Vendor default” when levels known but unset; or hidden when none |
| `TaskRoleSection` | One role header + ordered chain |
| `FallbackChainList` | Drag reorder, rank labels Primary / 2 / 3…, remove |
| `ChainModelPicker` | Add model to chain from enabled+available models |
| `EmptyRoleWarning` | Per-role soft-fallback warning |
| `GlobalNoProviderBanner` | All masters off |
| `ConfidenceLegend` | Footer popover: what authoritative/reported/estimated/missing/stale mean |
| `LastRefreshedLabel` | Age of probe; stale treatment |
| `ProviderMarkImage` | Official vendor mark with light/dark treatment |

---

## 7. State matrix

### 7.1 Provider card states

| State id | When | Visual | Interaction |
| --- | --- | --- | --- |
| `provider.enabled` | Master on, CLI present, discovery OK | Full opacity; meters or unknown panel as data allows | Expand, toggle off |
| `provider.disabled` | Master off | Card dimmed (≈0.55 opacity content); toggle off; badge **Off — Hive will not invoke this CLI** | Expand still allowed (inspect models); toggles on models show override |
| `provider.unavailable` | CLI not installed / not signed in / probe failed closed | Dashed border or tertiary fill; badge **Not available**; master toggle disabled or off+locked | Tooltip/detail with measured probe error; link to install docs if we have one |
| `provider.usage-healthy` | Both windows known and above warning remaining | Green/neutral fill meters | — |
| `provider.usage-near-limit` | Any window remaining ≤ warning threshold | Amber meter fill + **Near limit** chip on that window | — |
| `provider.usage-critical` | Any window remaining ≤ critical | Red/orange meter + **Critically low** | — |
| `provider.usage-unknown` | No capacity numbers (Grok by design, or probe missing) | **No meter track that could read as 0%**; warning badge + optional reset time | — |
| `provider.billing-off` | Credits/paid overflow known off | Chip **Paid overflow off** (secondary, calm) | — |
| `provider.billing-on` | Credits known on | Chip **Credits available** (not scary by itself) | — |
| `provider.billing-unknown` | Cannot determine overflow switch | Chip **Billing state unknown** + detail | — |
| `provider.billing-would-spend` | Exhausted plan + overflow path live | Chip **May spend money** (amber) | — |
| `provider.stale` | Confidence stale / observation aged out | Clock badge **Stale reading**; meters desaturated | Refresh action |

### 7.2 Model row states

| State id | When | Visual | Toggle |
| --- | --- | --- | --- |
| `model.enabled` | Self on, provider on, entitled, not hidden-from-routing if policy excludes | Full strength row | On |
| `model.disabled-by-self` | Self off, provider on | Row tertiary labels; strike or “Disabled” caption | Off (user chose) |
| `model.disabled-by-provider` | Provider master off | Row dimmed; **toggle shows user’s remembered preference but is non-authoritative**; overlay caption **Off because Claude Code is off** (provider name varies); optional lock icon on toggle | Toggle may still edit stored preference, but **effective state is off** and UI must say so — never show green “enabled” while provider is off |
| `model.unavailable` | Not in live catalog / not entitled / hidden vendor entry excluded | Badge **Unavailable**; toggle disabled | — |
| `model.not-installed-provider` | Parent provider unavailable | Same as unavailable; inherit provider reason | — |
| `model.pool-exhausted` | Measured pool exhausted and no free path | Badge **Plan limit reached** (or would-spend) | Still enable-able as preference; spawn path still gated by spend/availability |
| `model.no-effort-surface` | Record advertises no effort levels | Effort control **omitted**, caption **Uses vendor default effort** | — |

**Override rule (non-negotiable):**  
`effectiveEnabled = providerEnabled && modelSelfEnabled && modelAvailable`.  
UI always shows both **effective** and **preference** when they differ.

### 7.3 Meter component states

| State | Render | Forbidden |
| --- | --- | --- |
| **Percent known** | Track with fill = `usedPercent` (0–100); label **“{n}% used”**; optional **“{100-n}% remaining”** only if remaining is also known; reset caption if `resetsAt` known | “{used} of {allowance} requests”; fake absolute counts; fill based on Hive estimates without `estimated` labeling |
| **Percent-only** (always, for discovered pools) | Same as above — **percent is the native unit** | Inventing “of 500 requests” |
| **Unknown / missing** | Hollow track with **hatch or dashed empty** pattern OR no track — prefer **no fill bar**; centered label **“Usage unknown”**; sublabel reason | Empty bar that looks like 0% used; gray full bar; “0%” |
| **Stale** | Last known percent if we still hold one, with **Stale** badge and reduced contrast; if policy drops stale numbers, fall back to unknown | Presenting stale as fresh |
| **Estimated** (Hive added unreported spend) | Percent + badge **Includes Hive estimate** | Badge `authoritative` |
| **Near limit / critical** | Fill color amber/red per §5 thresholds; label may add **Near limit** | Only color change with no text |
| **Grok / unmetered provider** | **Do not mount `UsageMeter` at all** for capacity; use `UnmeteredUsagePanel` (§8.3) | Drawing `onDemandUsed` as a gauge |

### 7.4 Task-role chain states

| State | Visual |
| --- | --- |
| Ordered chain with ≥1 **effective** model | Numbered list; “Primary”, “If unavailable…”, never “Ensemble” or “Also run” |
| Chain has models but all ineffective | List shown struck; warning **No enabled model in this chain** |
| Empty chain | Warning per §10 copy; soft-fallback note if product rule is soft fallback |
| Reordering | Drag handle; live rank renumber |

---

## 8. Detailed component specs

### 8.1 Provider card (collapsed)

```
┌─────────────────────────────────────────────────────────────┐
│ [LOGO 20×20]  Claude Code                    ◎────● ON      │
│               Max plan · Paid overflow off                  │
│               5 hour   ████████░░  63% used                 │
│               7 day    ████░░░░░░  42% used                 │
│               ▸ 4 models                                    │
└─────────────────────────────────────────────────────────────┘
```

- Logo: 20×20 logical pt (@2x assets); 4pt corner radius if mark is square; optical alignment with title baseline.
- Master toggle: standard AppKit/SwiftUI `Toggle`; accessible label “Enable Claude Code”.
- Expand control: chevron or whole-card disclosure (except toggle hit target).

### 8.2 Provider card (expanded) + model rows

```
┌─────────────────────────────────────────────────────────────┐
│ [LOGO] Claude Code                               ● ON       │
│ … meters …                                                  │
│ ▾ Models                                                    │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ ●  Sonnet 5                              effort ▾   │   │
│   │    claude-sonnet-5 · plan                           │   │
│   ├─────────────────────────────────────────────────────┤   │
│   │ ○  Opus 4.8  (disabled)                  effort ▾   │   │
│   │    claude-opus-4-8                                  │   │
│   ├─────────────────────────────────────────────────────┤   │
│   │ ⊘  Haiku 4.5   Off because Claude Code is off       │   │
│   │    (your preference: on)  effort locked             │   │
│   └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

Model row columns (desktop):  
`[effective toggle] [name + id stack] …spacer… [effort]`.

Narrow: effort drops under name.

### 8.3 Unmetered / Grok usage panel (deliberate, not broken)

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

**Why this must look intentional:**

- Same card chrome, padding, and logo weight as Claude/Codex.
- Inset panel uses **secondary grouped fill**, not error red.
- Icon is `info.circle` or custom “unmetered” — **not** `xmark.octagon` (broken).
- No hollow meter tracks. Hollow tracks read as “empty tank.”
- Optional small positive label: **“By design”** is acceptable in caption; do not use “N/A” alone (reads like a bug).

If Grok probe fails entirely (no tier, no reset): show **Billing and usage unknown** with measured error string; still no fake meters.

### 8.4 `UsageMeter` — percent-only honesty

```
  5 hour window
  [████████████░░░░░░░░]  63% used
  Resets in 2 hours

  7 day window
  [████████████████████]  100% used · Plan limit reached
  Resets Wed 19:00

  (unknown)
  [· · · · · · · · · · ·]  Usage unknown
  Hive has no reading for this window
```

Rules:

1. Fill width = `used / 100` only when `used` is a known percent.
2. If only `remainingPct` is known, fill = `1 - remainingPct` (and label remaining, not used) — prefer one consistent story; **do not mix invented used with known remaining**.
3. If `used == 0` and confidence is real → show **“0% used”** (truth). If data absent → **never** show 0%.
4. Caption may show `confidence` as secondary text on hover/detail: e.g. “Reported by Claude Code · 12s ago”.
5. Two meters side-by-side only when width ≥ ~320pt for the meter block; otherwise stack.

### 8.5 Effort picker

- Options = exact strings from `supportedEffortLevels` on the live capability record, in vendor order.
- Plus optional first item **“Vendor default”** (clear pin / omit flag) when product allows unset.
- If levels unknown/empty: hide picker; show static caption **“Uses vendor default effort”**.
- Never list Hive’s historical enum (`minimal`, etc.) unless the model advertises it.

### 8.6 Task role fallback chain

```
  Complex coding
  Hive tries models in order. Only one runs — not an ensemble.

  ⋮⋮  1  Primary     Claude Code · Opus 4.8 · high      [−]
  ⋮⋮  2  Fallback    Codex · (account default) · medium [−]
  ⋮⋮  3  Fallback    Grok · … · low                     [−]

  [ + Add model ]

  ⚠ If every model above is off or unavailable, Hive falls back
    to any enabled model (not a failure). Assign at least one
    enabled model to keep routing predictable.
```

**Copy and chrome that prevent ensemble misunderstanding:**

- Section subtitle fixed: **“Ordered fallback — one model at a time.”**
- Rank labels: **Primary**, **2nd**, **3rd**… or **Fallback**.
- Forbid icons that imply parallel (no stacked play triangles without order).
- Drag reorder updates order immediately in UI; persist as ordered list.

### 8.7 Task roles (requested set)

Exact role ids for persistence (stable snake_case) and display labels:

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
| `long_context` | Long-context work |

**Pushback (must surface in implementation planning):**  
Today’s router only has `deep | standard | cheap | review`. Mapping nine roles onto four tiers without a new policy table **will mislead**. Recommended mapping is an explicit new policy document/schema, not silent aliasing (e.g. “complex coding = deep”) without user-visible explanation. If temporary aliasing is required for v1, show under each role: **“Currently applied as routing tier: deep”** until full role support lands.

---

## 9. Light and dark mode

Both are first-class; no “dark is inverted light dump.”

| Token | Light | Dark |
| --- | --- | --- |
| Page background | `windowBackgroundColor` | same semantic |
| Card fill | `controlBackgroundColor` / secondary grouped | same semantic |
| Primary label | `labelColor` | `labelColor` |
| Secondary | `secondaryLabelColor` | `secondaryLabelColor` |
| Separator | `separatorColor` | `separatorColor` |
| Meter track | black @ 8–12% | white @ 10–14% |
| Meter fill healthy | accent / systemBlue | same (system adapts) |
| Meter fill warning | systemOrange | systemOrange |
| Meter fill critical | systemRed | systemRed |
| Meter unknown hatch | secondaryLabel @ 40% | secondaryLabel @ 40% |
| Warning badge fill | orange @ 12% | orange @ 18% |
| Info (unmetered) badge | blue @ 10% | blue @ 16% |
| Disabled row | label @ 45–55% | label @ 45–55% |
| Provider override banner | tertiary fill + secondary label | same |
| Focus ring | system focus | system focus |

Respect **Increase Contrast** and **Reduce Transparency**: solid fills instead of ultra-thin materials when those settings are on. Respect **Reduce Motion**: no card expand spring; instant disclosure.

Do **not** hard-code hex that only works in one appearance.

---

## 10. Vendor logos

### Requirements (implementer sources assets)

| Provider | Mark | Source requirement |
| --- | --- | --- |
| Claude Code | Anthropic mark | Official Anthropic brand assets / press kit only |
| Codex | OpenAI mark | Official OpenAI brand assets only |
| Grok | xAI mark | Official xAI brand assets only |

**Do not** invent SVG paths or hotlink random third-party PNGs from this doc.

### Treatment

| Rule | Spec |
| --- | --- |
| Size | 20×20 pt in card header; 16×16 in compact chain rows |
| Shape | Contain in square; preserve aspect; no forced circle crop that clips trademark |
| Color vs mono | Prefer **single-color template** images that tint to `labelColor` for quiet settings chrome; if official color marks are required by brand guidelines, use color in both appearances **only if contrast ≥ WCAG AA** on card fill — otherwise use the official monochrome variant |
| Dark mode | Provide dark-safe asset or template tint; never ship a black mark on dark fill |
| Missing asset | Fallback SF Symbol `cpu` / `chevron.left.forwardslash.chevron.right` **plus** text name — never a broken image frame |
| Spacing | 8 pt between mark and title |

---

## 11. Data model (settings persistence — UI contract)

This is the shape the UI assumes. Exact file format is an implementation choice; fields must exist.

```ts
// Conceptual — not shipped code
type ProviderId = "claude" | "codex" | "grok" | string;

interface ModelControlPolicy {
  providers: Record<ProviderId, {
    enabled: boolean;                 // master — off = no CLI invoke
    models: Record<string /* launch id */, {
      enabled: boolean;               // preference; overridden by provider
      effort: string | null;          // null = vendor default / omit flag
    }>;
  }>;
  /** Ordered fallback chains; only one model runs. */
  taskRoles: Record<TaskRoleId, Array<{
    provider: ProviderId;
    model: string;                    // concrete id or "default"
  }>>;
}
```

**Effective enablement** computed client-side for display and server-side for spawn:

```
effective = provider.enabled && model.enabled && available(model)
```

**Soft fallback when chain empty / all ineffective** (product rule from brief):

> Router may use **any effective model** rather than hard-fail.

UI **must** warn (never silent). When daemon still hard-refuses (today’s behavior), UI must not claim soft fallback — see Open Questions.

Live read models (not written by this screen except via refresh):

- Capability catalog + effort lists
- `QuotaPoolStatus` / `QuotaUnconfiguredStatus`
- `AccountBilling` / spend risk
- Provider install/sign-in probe

---

## 12. Copy catalog (exact strings)

Use these strings unless localization lands. Implementer should not rephrase in ways that soften “unknown.”

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
| `badge.by_design_unmetered` | Capacity not reported |

### Override / model captions

| id | Copy |
| --- | --- |
| `model.overridden_by_provider` | Off because {ProviderTitle} is off |
| `model.preference_on_overridden` | Your preference: on (not effective) |
| `model.disabled_self` | Disabled |
| `model.vendor_default_effort` | Uses vendor default effort |
| `model.pool_exhausted` | Plan capacity exhausted for this model |

### Meters

| id | Copy |
| --- | --- |
| `meter.used_pct` | {n}% used |
| `meter.remaining_pct` | {n}% remaining |
| `meter.window_5h` | 5 hour window |
| `meter.window_7d` | 7 day window |
| `meter.resets_in` | Resets in {relative} |
| `meter.resets_at` | Resets {absolute} |
| `meter.unknown_body` | Hive has no reading for this window |
| `meter.estimated_footnote` | Part of this figure is Hive’s estimate of spend since the last provider reading |

### Grok / unmetered panel

| id | Copy |
| --- | --- |
| `unmetered.title` | Usage limits cannot be tracked for this provider |
| `unmetered.body` | xAI does not report plan capacity to Hive. Money rails are monitored so Hive does not silently spend on-demand balance; they are not a usage gauge. |
| `unmetered.reset` | Next weekly reset boundary: {absolute} |
| `unmetered.reset_footnote` | Reset time only — not remaining quota |
| `unmetered.money_changed` | Paid capacity rails changed (raw values shown; unit unknown) |

### Global / role warnings

| id | Copy |
| --- | --- |
| `warn.no_providers` | No providers enabled — Hive cannot spawn agents until at least one provider is turned on. |
| `warn.empty_role` | {RoleLabel} has no enabled model assigned. Hive will fall back to any enabled model rather than failing. Assign at least one enabled model to keep routing predictable. |
| `warn.empty_role_hard_fail_if_configured` | {RoleLabel} has no enabled model assigned. Spawns for this role will fail until you assign one. |
| `warn.chain_all_ineffective` | Every model in this chain is off or unavailable. |
| `warn.policy_not_wired` | These task-role chains are saved, but the router does not apply ordered fallbacks yet. Hive still uses its current tier derivation until that lands. |
| `subtitle.fallback` | Ordered fallback — one model at a time. Not an ensemble. |
| `footer.honesty` | Measure or say unknown. Zero means measured zero; blank means Hive cannot tell. |

### Accessibility labels

| id | Copy |
| --- | --- |
| `a11y.provider_toggle` | Enable {ProviderTitle} |
| `a11y.model_toggle` | Enable {ModelDisplayName} |
| `a11y.model_toggle_overridden` | {ModelDisplayName}, off because {ProviderTitle} is off |
| `a11y.meter` | {WindowLabel}: {n} percent used |
| `a11y.meter_unknown` | {WindowLabel}: usage unknown |

---

## 13. Interaction details

| Action | Behavior |
| --- | --- |
| Toggle provider off | Immediate preference write; all child rows flip to override chrome; no spawn from that CLI |
| Toggle provider on | Restores children to their stored preferences + availability |
| Toggle model | Writes preference; if provider off, show override caption still |
| Change effort | Writes per-model effort; validate against live advertised set on save and on spawn |
| Expand/collapse | Local UI state; remember last expanded set in `UserDefaults` optional |
| Drag reorder chain | Updates order; Primary is index 0 |
| Add to chain | Sheet/popover of **effective** models first; allow adding disabled with warning badge on row |
| Refresh | Re-probe capabilities + billing + quota; show spinner on footer; never leave previous numbers unlabeled if replaced by unknown |
| First open | Expand first provider with a warning; scroll to global banners |

**No optimistic capacity:** UI does not decrement meters locally when a spawn starts. Meters follow daemon readings + labeled estimates only.

---

## 14. ASCII state gallery (implementer checklist)

### Enabled + healthy (Claude)

```
[Anthropic] Claude Code                          [ON]
Max · Paid overflow off
5 hour  ████░░░░░░  28% used · Resets in 4h
7 day   ███░░░░░░░  31% used · Resets in 5d
```

### Near limit

```
5 hour  ████████████████░░░░  82% used  [Near limit]
```

### Unknown window (probe miss on a normally metered vendor)

```
5 hour  ··········  Usage unknown
        Hive has no reading for this window
```

### Provider off → model override

```
[Anthropic] Claude Code                          [OFF]
Off — Hive will not invoke this CLI
  ⊘ Sonnet 5   Off because Claude Code is off
               Your preference: on
```

### Unavailable provider

```
[OpenAI] Codex                                   [—]
Not available · codex CLI not signed in
(probe: … measured error …)
```

### Empty role

```
Summarization
  (no models)
  ⚠ Summarization has no enabled model assigned. Hive will fall
    back to any enabled model rather than failing. …
```

### All providers off

```
⚠ No providers enabled — Hive cannot spawn agents until at least
  one provider is turned on.
```

---

## 15. Places this design would MISLEAD if built carelessly

**These are the highest-value traps. Treat as review gates.**

1. **Grok money rails as meters** — Drawing `onDemandUsed` / `onDemandCap` / `prepaidBalance` as “remaining quota” is a direct contradiction of `grok-integration-spec.md` §10. Zeros look like “full allowance.” **Forbidden.**

2. **Unknown as empty bar** — A blank `NSProgressIndicator` at 0 reads as 0% used. Users will green-light heavy work. Unknown must use hatch/copy, not an empty determinate bar.

3. **Absolute counts** — Neither Claude nor Codex publish absolute window sizes on the free probes. “128 of 500” is fiction. Percent only.

4. **Hive estimates wearing provider badges** — If the figure includes post-reading ledger spend, badge **Includes Hive estimate**. Never `authoritative` for that composite (`provider-quota-surfaces.md`).

5. **Soft fallback silent success** — If the product rule is “empty role → any enabled model,” the UI must warn every time. Silent surprise is a routing lie.

6. **UI-only fallback chains** — Showing Primary/Secondary while the daemon still has no chain **trains false confidence**. Ship `warn.policy_not_wired` or land router first.

7. **Nine roles silently aliased to four tiers** — Users will believe “debugging” is distinct from “simple coding.” If both map to `standard`, say so in the UI until roles are real.

8. **Provider off but model toggle still looks on** — Classic settings bug. Effective state must dominate chrome.

9. **Effort menu of levels the model does not advertise** — Spawn will refuse or drop flags; UI promised a lie.

10. **Stale numbers without age** — A 6-hour-old 12% used is not “current headroom.”

11. **Local ledger spend as account quota** — `QuotaUnconfiguredStatus.fiveHourRecorded` is Hive-only. If shown, label **“Recorded by this Hive only — not account usage.”**

12. **Ensemble language** — “Also use,” “team of models,” multi-select without order → implies parallel execution Hive does not do.

13. **Billing-off nag** — When paid overflow is off, do not warn “may spend money.” The wallet is safe; plan limit is a wall (`spendRisk` docs).

14. **Mid-run credit cross** — UI cannot promise a spawn that starts free stays free. Do not add copy that claims otherwise.

---

## 16. Workspace integration

| Item | Spec |
| --- | --- |
| Entry | Settings window or `Hive → Settings…` / toolbar gear; section **Models** |
| Process | Workspace UI sends intents to daemon; **no optimistic policy mutation that spawn ignores** |
| Theme | Reuse `Theme` fonts (`bodyFont`, `captionFont`, …) and system colors; extend only for meter-specific tokens |
| Terminal panes | Unaffected; this is settings chrome, not pane UI |
| Autonomy | Out of scope for this screen (already Agents menu / config) |

---

## 17. Alternatives considered

| Alternative | Why rejected / deferred |
| --- | --- |
| Single combined table (all models flat) | Loses provider master semantics and per-vendor billing honesty |
| Hide Grok card until meters exist | Makes Grok second-class; contradicts first-class vendor work |
| Fake 100% allowance for Grok | Explicitly forbidden by Grok quota design |
| Ensemble multi-select | Not Hive’s execution model |
| Only four tier dropdowns (match today) | Cleaner vs current router, but brief requires task-role chains; keep honesty banner if mapping |
| CLI-only `routing.toml` editor | Fails ChatGPT/Claude settings quality bar; power users still have the file |

---

## 18. Security and privacy

- Settings show **plan type, utilization percent, reset times, money-rail raw values** already available to the local user via the same CLIs — no new cloud call from the UI beyond daemon probes.
- Do not display full account email in the card unless already shown elsewhere and necessary; prefer plan tier.
- No prompts or transcripts on this screen.
- Vendor logos: comply with trademark guidelines; no modification that creates confusion.

---

## 19. Observability

- Log policy writes (provider/model enable, effort, chain edits) with timestamp — no secrets.
- Refresh failures surface probe errors in UI (measured string) and daemon logs.
- Do not metrics-scrape vendor endpoints more aggressively than existing daemon refresh interval (`refreshIntervalMinutes`, default 15).

---

## 20. Rollout

1. **UI shell + read-only live data** (providers, meters, Grok panel, model list) — pure honesty win.
2. **Enable toggles** wired to daemon policy.
3. **Effort picks** wired.
4. **Task role chains** + router support (same release train preferred).
5. Soft-fallback warnings only when router implements soft fallback; else hard-fail copy.

Feature flag optional: `workspace.modelControlCenter`.

---

## 21. Open questions

1. **Soft vs hard empty-role behavior** — Brief says soft fallback to any enabled model; today’s derivation **refuses**. Product must pick one; UI copy has both strings ready.
2. **Nine roles vs four tiers** — New schema vs explicit temporary mapping with disclosure?
3. **Where policy persists** — `~/.hive/routing.toml` extension vs new `models.toml` vs daemon DB?
4. **Per-model vs per-pool meters on the card** — Card-level general pool is v1; model-scoped pools (Fable-style) as row badges in v1.1?
5. **Whether disabled models stay visible in chains** — Spec says yes, with ineffective chrome; confirm.
6. **Reset-credit grants (Codex)** — Surfacing “you have N full resets” is valuable and not yet done in CLI; include as secondary chip in v1?

---

## 22. Key decisions

1. **Honesty over symmetry** — Grok’s unmetered panel is a first-class design, not a missing feature.
2. **Percent-native meters** — No absolute denominators on discovered pools.
3. **Unknown ≠ zero** — Distinct visual language mandatory.
4. **Effective vs preference** — Provider override always visible.
5. **Fallback chains, not ensembles** — Ordering + copy enforce single-runner semantics.
6. **Two-axis IA** — Provider cards and task-role chains are both primary; narrow width uses segments.
7. **HIG settings chrome** — System materials/colors; light and dark equal.
8. **Do not ship lying chains** — Router wiring or explicit “not applied” banner.
9. **Effort from live catalog only** — No invented level lists.
10. **Official marks only** — Spec requires; does not bundle artwork URLs.

---

## 23. References

- `docs/research/provider-quota-surfaces.md` — wire shapes, percent-only, estimate vs measurement
- `docs/architecture/grok-integration-spec.md` §10 — Grok money guard, null capacity
- `docs/architecture/hive-workspace-blueprint.md` — HIG visual language
- `docs/model-selection.md` — live routing derivation (4 tiers, no downshift chain)
- `src/schemas/quota.ts` — `QuotaWindowStatus`, confidence, null usage
- `src/schemas/capability.ts` — providers, `Discovered<T>`, effort strings
- `src/daemon/usage-credits.ts` — `AccountBilling`, `spendRisk`
- `workspace/Sources/HiveWorkspace/Theme.swift` — existing semantic colors/fonts

---

## 24. PR Plan

### PR 1 — Read-only Model Control Center shell
- **Files:** new SwiftUI/AppKit settings scene under `workspace/Sources/HiveWorkspace/`; Theme meter tokens; fixture-driven previews
- **Depends on:** none
- **Ship:** Provider cards, meters (percent + unknown), Grok unmetered panel, model list without writes; light/dark; state gallery from fixtures
- **Acceptance:** Unknown never renders as 0%; Grok has no determinate capacity bar

### PR 2 — Daemon policy read API for settings
- **Files:** daemon HTTP/XPC snapshot: providers, models, efforts, quota windows, billing chips
- **Depends on:** existing capability + quota + billing readers
- **Acceptance:** Positive controls for claude/codex percent and grok null capacity in tests

### PR 3 — Enablement + effort writes
- **Files:** policy persistence; spawn path honors `effectiveEnabled`; Workspace toggles/effort pickers
- **Depends on:** PR1–2
- **Acceptance:** Provider off blocks all spawns for that CLI; override chrome tested

### PR 4 — Task-role chains + router
- **Files:** schema for nine roles + ordered lists; derivation uses chain; UI chain editor; soft or hard empty-role behavior per product decision
- **Depends on:** PR3 + product answer to Open Questions 1–2
- **Acceptance:** Order visible and reorderable; no ensemble language; empty-role warning matches actual router behavior

### PR 5 — Polish and edge honesty
- **Files:** stale treatment, estimate badges, model-scoped pool badges, Codex reset grants chip (if approved), a11y audit, logo assets
- **Depends on:** PR1–4
- **Acceptance:** Checklist in §15 all fail-closed under review

---

## 25. Success criteria (for implementers and reviewers)

- [ ] Claude and Codex cards show 5h + 7d **percent** meters with no absolute fiction
- [ ] Grok card shows warning badge + unmetered panel + optional reset; **zero money-rail gauges**
- [ ] Unknown window cannot be mistaken for 0% used (screenshot test)
- [ ] Provider off paints every model as overridden, not enabled
- [ ] Disabled-by-self ≠ disabled-by-provider ≠ unavailable (three distinct looks)
- [ ] Light and dark both pass contrast on meters and badges
- [ ] Fallback chain copy forbids ensemble reading
- [ ] Empty-role and no-provider warnings use exact product semantics
- [ ] Effort options ⊆ live advertised levels
- [ ] No PR claims router fallback until PR4 lands (or banner present)

---

*End of design spec. Discovery only — no implementation in this change set beyond this document.*
