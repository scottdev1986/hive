# Model Control Center — the honesty contract

Updated: 2026-07-14
Source: Hive source tree, 2026-07-14

## Summary

The MCC is the settings surface that makes the user the router: it edits the
routing policy document and renders every provider's measured capacity. Its
governing rule is not a layout rule — it is an honesty rule, and most of this
article exists to keep an implementer from shipping a confident lie about money.

## The one rule

> **Measure or say unknown. Never invent a number. Never render zero where the truth
> is "we cannot tell."**

An implementer who ships a pretty empty bar labeled "0% used", or "128 of 500 requests
remaining", has failed this design even if every pixel is right. **A confident lie about
capacity is worse than no screen.**

## No vendor publishes an absolute allowance

Not Claude, not Codex, not Grok. Every metered surface reports a **fraction consumed**,
or nothing at all. **There is no denominator on the wire.**

> **"128 of 500 requests" is fiction for every provider that exists.**

This is not a Claude gap or a Codex gap — it is universal. The only honest meter is a
**percent bar plus a reset timestamp**. Near-limit styling follows live config
thresholds on *remaining* (warning ≤ 25%, critical ≤ 10%), never a hardcoded "80% used".

## Design the silence

**Claude's `get_usage` is vendor-marked EXPERIMENTAL, and it does not fail loudly — it
goes quiet. It went silent twice on 2026-07-12 alone.** This demands a first-class
state, not an error path:

- **A silent feed must never render as a zeroed bar.** A determinate bar at 0% claims
  *measured emptiness*. The truth is "we asked and heard nothing."
- **A dropped feed is not an outage.** Claude may be perfectly spawnable while its usage
  surface says nothing. Do not disable the card or grey out the models.
- Stale readings keep the last percent **only** with a visible age and a Stale badge. A
  six-hour-old "12% used" is not current headroom.
- The silence is *expected*. It should read as a known condition with a known name.

`usage-silent` ("normally reports, and did not") and `usage-unmetered` ("has nothing to
report, by design") are **different states with different copy** and **must not share a
component**.

## Grok IS metered — three sections of the old spec were wrong

The design spec said "Grok has no gauge at all" and gave it the unmetered panel, never a
meter. **That was already false when this article was written.** The 2026-07-13
controlled-spend experiment established `config.creditUsagePercent` as a real weekly gauge:

- `src/daemon/quota-sources.ts:923-945` reads it as the gauge.
- `src/cli/model-control.ts:72-83` returns `"metered"` for **all three** providers,
  and its switch **fails closed** on a vendor nobody classified — a new provider
  will not silently render as metered-and-empty.

What survives from that section, and survives *hard*: the **money rails**
(`onDemandUsed`, `onDemandCap`, `prepaidBalance`) are a **guard, not a gauge**.
Rendering their zeros as capacity is forbidden — those zeros read as "full tank",
and they mean "no on-demand spend has occurred." Grok now has a real meter *and*
money rails, and they answer different questions. See
[quota-and-headroom.md](quota-and-headroom.md).

Two further sections of that spec were wrong, and the UI must not build them:

- **The `vendor-default` chain mode and its `ChainEntryPicker`.** Deleted from the schema
  (commit `0dc25c0`; `src/schemas/routing-policy.ts:68-81`). A UI offering it builds a form the daemon
  will reject.
- **Per-category `exhaustion_behavior`.** No such field exists. (The
  `chain.exhaustion_refuse` / `chain.exhaustion_widen` copy strings below therefore have
  nothing to bind to — they are kept only in case the gap is closed.)

And the spec's one stated **blocking dependency is fixed**: `buildModelInventory` is no
longer two-valued. `src/daemon/model-inventory.ts:212-222` emits `known-none` with a
detail, and `:301-305` renders all three states. Effort pickers are unblocked.

## Effort is three-valued

Conflating two of the values is a lie the UI renders.

| Value | Meaning | UI |
|---|---|---|
| `known(values[])` | The vendor listed effort levels | Picker with exactly those strings, **in vendor order** |
| `known-none` | The vendor **stated** there is no effort axis | **No picker.** *"This model has no effort setting."* |
| `unknown(reason)` | We could not read it | **No picker.** *"Effort options unknown — {reason}"* |

> "This model has no effort axis" and "we could not read this model's effort axis" are
> different facts. **One greyed-out control for both claims knowledge we do not have.**

The policy schema is richer (`src/schemas/routing-policy.ts:49-55`): `never-configured`,
`hive-decides`, `exact`, `none`, `provider-controlled`. The last two are *not*
interchangeable with the first two — `provider-controlled` omits the flag and does not
claim to know the vendor's default, while `hive-decides` picks an exact advertised level
and records it. "Let Hive decide" is a **value, not a missing value**, and must be a
real menu item — never placeholder text, never an empty selection.

## Unknown never renders as zero or healthy

`QuotaWindowStatus` fields may each be `null`. **`null` means unknown — not 0, not 100.**
A real measured zero is still 0%; absence is never drawn as zero. Hive-local ledger spend
is *local recorded spend*, never account usage. A figure mixing a provider reading with
Hive's post-reading estimate is `Includes Hive estimate`, never `authoritative`.

**If a value that was known becomes unknown, the meter must change state** — never leave
a stale number wearing a fresh label.

## The 15 ways to ship a confident lie

The review gate. Each is a way to make the screen lie about money.

1. **Grok money rails as a meter.** The zeros read as a full tank. Forbidden.
2. **Unknown as an empty bar.** A determinate bar at 0 says "measured, nearly
   nothing used." The user green-lights heavy work on a number that does not exist.
3. **A silent Claude feed rendered as a zeroed meter.** The most likely instance of
   (2), because that feed *actually goes quiet*.
4. **Absolute counts.** "128 of 500" is fiction for every provider.
5. **`known-none` effort shown as unknown**, or unknown shown as "no effort axis."
6. **"The authored chain is the outer boundary."** It is preference order, not
   the outer boundary. Under `choice`, an exhausted category chain walks the Default
   chain; if every authored link is refused, Hive spreads across the remaining
   enabled models as a last resort. The user's enablement set is the boundary.
7. **Blurring empty and exhausted.** A category with no chain uses Default, but if
   both are empty Hive refuses outright. A non-empty authored search space whose
   links were all refused is exhausted and earns the enabled-model fallback.
8. **A floor refusal shown as "you disabled this."** Capability truth is not user
   policy.
9. **Provider off but the model toggle still looks on.** Effective state must
   dominate chrome: `effective = providerEnabled && modelEnabled && modelAvailable`.
   When effective and preference differ, show **both**.
10. **Hive's estimate wearing a provider's badge.**
11. **Stale numbers without an age.**
12. **Local ledger spend as account quota.**
13. **Ensemble language.** "Also use", "team of models", an unordered multi-select —
    all imply parallel execution Hive does not do. It is an **ordered fallback; only
    one model runs.**
14. **A billing-off nag.** Paid overflow off means the wallet is safe.
15. **An open `ProviderId` union.** `"claude" | "codex" | "grok" | string` reopens
    the Grok-class hole at the UI contract. Closed enum only.

## The copy catalog (excerpt — do not soften "unknown")

| id | Copy |
|---|---|
| `badge.usage_unknown` | Usage unknown |
| `badge.usage_stale` | Stale reading |
| `badge.provider_off` | Off — Hive will not invoke this CLI |
| `badge.includes_estimate` | Includes Hive estimate |
| `badge.provisional` | Provisional |
| `badge.unresolvable` | Model no longer offered by this provider |
| `meter.unknown_body` | Hive has no reading for this window |
| `meter.silent_feed` | {ProviderTitle} reported no usage data. This surface is experimental and sometimes goes quiet — {ProviderTitle} itself is still available. |
| `meter.estimated_footnote` | Part of this figure is Hive's estimate of spend since the last provider reading |
| `effort.none` | This model has no effort setting. |
| `effort.unknown` | Effort options unknown — {reason} |
| `effort.provider_controlled` | Vendor default (Hive sends no effort flag) |
| `model.overridden_by_provider` | Off because {ProviderTitle} is off |
| `subtitle.fallback` | Ordered fallback — one model at a time. Not an ensemble. |
| `chain.empty_uses_default` | No chain of its own — uses your Default chain. |
| `banner.provisional` | Provisional Hive suggestions — edit anytime; no outcome data yet. |
| `footer.honesty` | Measure or say unknown. Zero means measured zero; blank means Hive cannot tell. |

`effort.none` and `effort.unknown` are **not interchangeable**. Rank labels are
Primary / 2nd / 3rd — never an icon implying parallelism.

## The real wire shape

The spec's §9 contract was **wrong**; a UI built to it will not parse the live document.
The truth is `RoutingPolicySchema` (`src/schemas/routing-policy.ts:133-152`):

- `providers` is a **partial record** of `"enabled" | "disabled"` — absence is a third
  state, `unconfigured`, and it is not permission.
- `models` is a **flat array** of `ModelPolicy` rows, not a nested map under providers.
- `chains` is a partial record of category → ordered `ChainEntry[]`.
- `selection` carries the `never-configured | auto | choice` intent, global and per-category.
- `revision` + `provisional` at the top; writers present the revision they read (CAS).

Also contra the spec: an absent model row does **not** inherit provider enablement
(`modelPolicyState`, :306-320). Provider-on is a master switch, not consent for every
model discovered tomorrow. `ProviderId` stays a **closed enum**.

## Transport: the app is a CLI subprocess, not an HTTP client

The Workspace is AppKit (no SwiftUI) and **shells out to the `hive` binary**, reading
stdout. It never speaks HTTP to the daemon and never writes under `~/.hive/`. The daemon
is the sole writer.

- **Read:** `hive model-control-snapshot` (`src/cli/model-control.ts`) — live catalogs
  with per-field provenance, billing, `usageSurfaces`, quota. **`quota: null` means the
  daemon could not be asked** — not an empty list, and never rendered as 0%.
- **Write:** `hive routing policy | set-provider | set-model | set-effort |
  set-selection | set-chain | export` (`src/cli/routing-policy.ts`, dispatched from
  `src/cli.ts:357-501`).

The Settings controller keeps one data source while the window exists, but `show()` refreshes the model-control snapshot every time the window is shown before restoring the selected page (`workspace/Sources/HiveWorkspace/Settings/SettingsWindowController.swift:90-112`). Reopening Settings therefore cannot present the process's launch-time catalog or quota as if it were current; the in-window Refresh control is an additional explicit refresh, not the only one.

## Status: partly built, not "not started"

The spec header said "Design spec (not started)" to the end. Shipped: eight AppKit files
under `workspace/Sources/HiveWorkspace/Settings/` (`ProviderCardView`, `ModelRowView`,
`ChainEditorView`, `EffortControlView`, `ModelControlDataSource`,
`SettingsPageController`, `SettingsWindowController`, `UsageSettingsController`, plus
`MCCCopy`), the read surface, and the full write surface. Rendering conventions come
from [../workspace/ui-design-system.md](../workspace/ui-design-system.md).

**Routing boundary:** under `choice`, authored category and Default chains express
preference order inside the enabled-model set. If those non-empty chains are exhausted,
Hive spreads across the remaining enabled models; if both chains are empty, it refuses
without widening. Empty and exhausted are intentionally different (`src/daemon/spawner-impl.ts:1811-1849`; `src/cli/spawner-impl.test.ts:3505-3674`). Under `auto`, the enabled models that fit the category are the candidate set directly.

## See Also

- [routing-policy.md](routing-policy.md) — the document this screen edits
- [quota-and-headroom.md](quota-and-headroom.md) — what the meters mean
- [rejected-approaches.md](rejected-approaches.md) — the `vendor-default` picker, and why it is gone
- [../providers/quota-surfaces.md](../providers/quota-surfaces.md) — the wire contracts behind every meter
- [../providers/capability-discovery.md](../providers/capability-discovery.md) — where the effort tri-state comes from
- [../workspace/ui-design-system.md](../workspace/ui-design-system.md) — the rendering system
