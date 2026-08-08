# Model Control Center — the honesty contract

Updated: 2026-07-30
Source: Hive source tree, 2026-07-30

## Summary

The MCC is the settings surface that makes the user the router: it edits the
routing policy document — provider and model consent, effort intent, and the
weighted routes — and renders every provider's measured capacity. Its
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

The original MCC spec said "Grok has no gauge at all" and gave it the unmetered panel,
never a meter. **That was already false when this article was first written.** The
2026-07-13 controlled-spend experiment established `config.creditUsagePercent` as a
real weekly gauge:

- `src/usage-service/quota-sources.ts` reads it as the gauge.
- `usageSurface` in `src/cli/model-control.ts` returns `"metered"` for the
  metered providers, and its switch **fails closed** on a vendor nobody
  classified — a new provider will not silently render as metered-and-empty.

What survives from that section, and survives *hard*: the **money rails**
(`onDemandUsed`, `onDemandCap`, `prepaidBalance`) are a **guard, not a gauge**.
Rendering their zeros as capacity is forbidden — those zeros read as "full tank",
and they mean "no on-demand spend has occurred." Grok now has a real meter *and*
money rails, and they answer different questions. See
[quota-and-headroom.md](quota-and-headroom.md).

Two further sections of that spec were wrong, and the UI must not build them:

- **The `vendor-default` entry form and its picker.** Deleted from the schema
  (commit `0dc25c0`); a route candidate names an exact model, always. A UI
  offering "whatever the vendor picks" builds a form the daemon will reject.
- **Per-category `exhaustion_behavior`.** No such field exists, and V3 removed
  the concept entirely: a category route that refuses everything fails the
  spawn; it never widens.

And the spec's one stated **blocking dependency is fixed**: `buildModelInventory`
(`src/daemon/provider-capabilities/model-inventory.ts`) is no longer two-valued — it emits `known-none`
with a detail alongside `known` and `unknown`. Effort pickers are unblocked.

## The route editor

Chains are gone. `RouteEditorView.swift` (`RouteSectionView`) renders one
section per task category plus the **Global route** ("Used when a category has
no route of its own"), each editing an unordered weighted candidate set:

- **Membership.** The add picker's atom is a (model, effort) pair; each model
  opens a submenu of its advertised effort levels. Every candidate is an
  **exact** model — there is no vendor-default candidate and no `"default"`
  anywhere. Remove is per candidate; zero candidates clears the scope back to
  unconfigured.
- **Mode toggle.** "Split:" popup — *Weighted split* (`user-weighted`) or
  *Equal split* (`hive-equal`). The equal-split caption states the contract:
  your weights are kept and apply again if you switch back.
- **Weights.** Editable only in weighted mode, integer 1–100. The copy says
  what the schema means: *weights are ratings, not percentages — 3/1/1 and
  60/20/20 are the same split.*
- **Share preview.** Each candidate shows its normalized expected share
  (`expectedShare`, "≈N%"), computed the same way as the daemon's
  `routeShares` (`src/daemon/routing-service/router.ts`). When some provider holds more than
  one candidate, a per-provider share summary appears — the router never
  secretly normalizes by provider, so the UI must show the aggregate share
  honestly.
- **A category with no route** shows "No route of its own — uses your Global
  route." A configured route whose candidates are all off or unavailable warns
  that spawns routed here **will fail** — it does not pretend a fallback
  exists.
- **A stored route this build cannot fully spell is refused, not rewritten**
  (`ModelControlDataSource.setRoute`): respelling one candidate's effort would
  be a routing change the user never made. The write fails with
  `routeUnreadable` copy and nothing changes.

Writing a route mirrors the daemon's `set-route` side effect: naming a model in
a route keeps an explicit enabled row for it, while the provider master switch
remains the launch authority.

## Effort is three-valued

Conflating two of the values is a lie the UI renders.

| Value | Meaning | UI |
|---|---|---|
| `known(values[])` | The vendor listed effort levels | Picker with exactly those strings, **in vendor order** |
| `known-none` | The vendor **stated** there is no effort axis | **No picker.** *"This model has no effort setting."* |
| `unknown(reason)` | We could not read it | **No picker.** *"Effort options unknown — {reason}"* |

> "This model has no effort axis" and "we could not read this model's effort axis" are
> different facts. **One greyed-out control for both claims knowledge we do not have.**

The policy schema is richer (`EffortTargetSchema`): `never-configured`,
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
6. **"If this route fails, Global catches it."** It does not. A category route
   is an explicit boundary; when every candidate refuses, the spawn refuses.
   Only a category with **no route of its own** resolves to Global.
7. **Blurring unconfigured and ineffective.** "No route — uses Global" and
   "every model in this route is off or unavailable — spawns will fail" are
   different facts with different copy, and neither widens to "any enabled
   model."
8. **A floor refusal shown as "you disabled this."** Capability truth is not user
   policy.
9. **Provider off but the model toggle still looks on.** Effective state must
   dominate chrome, and it comes from `modelPolicyState` — provider-off
   overrides everything under it; under an enabled provider an absent model
   state inherits the provider. When effective and preference differ, show
   **both** ("Your preference: on (not effective)").
10. **Weights rendered as percentages.** Weights are ratings — 3/1/1 and
    60/20/20 are the same split. The normalized expected share is a separate,
    clearly derived figure ("≈N%"), never the stored value.
11. **Hive's estimate wearing a provider's badge.** And stale numbers without
    an age, and local ledger spend as account quota.
12. **Hiding a provider's aggregate share.** One provider with three candidates
    in an equal split holds three shares. The per-provider summary exists so
    that fact is visible, not smoothed away.
13. **Ensemble language.** "Also use", "team of models" — anything implying
    parallel execution. Weights split *spawns over time*; **each spawn runs on
    ONE model** (`routesSubtitle` says exactly this).
14. **A billing-off nag.** Paid overflow off means the wallet is safe.
15. **An open `ProviderId` union.** `"claude" | "codex" | "grok" | string` reopens
    the Grok-class hole at the UI contract. Closed enum only.

## The copy catalog (excerpt — do not soften "unknown")

From `MCCCopy.swift`; the ids are the Swift constants.

| Constant | Copy |
|---|---|
| `badgeUsageUnknown` | Usage unknown |
| `badgeUsageStale` | Stale reading |
| `badgeProviderOff` | Off — Hive will not invoke this CLI |
| `badgeProvisional` | Provisional |
| `badgeUnresolvable` | Model no longer offered by this provider |
| `meterUnknownBody` | Hive has no reading for this window |
| `effortNone` | This model has no effort setting. |
| `effortProviderControlled` | Vendor decides (Hive sends no effort flag) |
| `routeEmptyUsesGlobal` | No route of its own — uses your Global route. |
| `globalRouteSubtitle` | Used when a category has no route of its own. |
| `modeControlLabel` | Split: |
| `expectedShare(n)` | ≈n% |

`effortNone` and the unknown-effort copy are **not interchangeable**. There are
no rank labels and no order affordances anywhere — order carries no meaning in a
route.

## The real wire shape

The truth is `RoutingPolicySchema` (`src/schemas/routing-policy.ts`, `schemaVersion: 3`):

- `providers` is a **partial record** of `"enabled" | "disabled"` — absence is a third
  state, `unconfigured`, and it is not permission.
- `models` is a **flat array** of `ModelPolicy` rows, not a nested map under providers.
  Under an **enabled** provider, a model row's absent `state` **inherits the
  provider** until the user explicitly disables that model; an explicit row
  overrides the inheritance (`modelPolicyState`, with `source` naming which row
  answered).
- `global` is a nullable `RoutePolicy`; `categories` is a partial record of
  category → `RoutePolicy`. A `RoutePolicy` is `{ mode, candidates }` —
  unordered, weighted, exact. There is no `chains` field and no `selection`
  field.
- `revision` + `provisional` at the top; writers present the revision they read (CAS).

`ProviderId` stays a **closed enum**.

## Transport: the app is a CLI subprocess, not an HTTP client

The Workspace is AppKit (no SwiftUI) and **shells out to the `hive` binary**, reading
stdout. It never speaks HTTP to the daemon and never writes under `~/.hive/`. The daemon
is the sole writer.

- **Read:** `hive model-control-snapshot` (`src/cli/model-control.ts`) — live catalogs
  with per-field provenance, billing, `usageSurfaces`, quota. **`quota: null` means the
  daemon could not be asked** — not an empty list, and never rendered as 0%.
- **Write:** `hive routing policy | set-provider | set-model | set-effort |
  set-route | export` (`src/cli/routing-policy-command.ts`, dispatched from
  `src/cli.ts`). `set-selection` and `set-chain` no longer exist — the four
  mutations are the whole write surface, every one carrying
  `--expect-revision`. A route candidate on the wire is
  `provider/model[@LEVEL|@none|@hive-decides][=WEIGHT]`, weight an integer
  1–100 defaulting to 1.

There is no machine selection preference file anymore; `routing-selection.json`
died with the selection modes. Policy state lives in the daemon's store alone.

The Settings controller keeps one data source while the window exists, but
`SettingsWindowController.show()` refreshes the model-control snapshot every
time the window is shown before restoring the selected page. Reopening Settings
therefore cannot present the process's launch-time catalog or quota as if it
were current; the in-window Refresh control is an additional explicit refresh,
not the only one.

## Named instances inherit preferences, not runtime state

Opening `hive --instance <name>` creates an independent daemon and database, but a new
application window should not behave like a new user account. On startup, an empty
named policy — or Hive's still-untouched provisional suggestions — receives a one-time
copy of the default instance's user-authored Model Control document: provider switches,
exact model enablement, routes, and effort choices
(`inheritDefaultModelControlSettings`, `src/daemon/routing-service/instance-settings.ts`;
`RoutingPolicyStore.importDefaultPolicy`). That copy is an audited local revision. It
carries the user's existing spend consent on the same machine without coupling the
daemons.

The import never overwrites a policy the named instance has edited, never imports a
provisional source policy, and never synchronizes later edits. Agents, messages,
credentials, ports, process namespaces, and every other runtime resource remain
isolated. The reverse direction is explicit and user-initiated: `hive routing
promote-default` (`RoutingPolicyStore.promote`).

## Status: built, including the route editor

Shipped under `workspace/Sources/HiveWorkspace/Settings/`: `ProviderCardView`,
`ModelRowView`, `RouteEditorView`, `EffortControlView`, `ModelControlDataSource`,
`SettingsPageController`, `SettingsWindowController`, `UsageSettingsController`, plus
`MCCCopy` — the read surface and the full write surface. The chain editor
(`ChainEditorView`, move up/down, exhaustion popup) was deleted with the V2
schema; no UI describes preference as order or fallback. Rendering conventions
come from [../workspace/ui-design-system.md](../workspace/ui-design-system.md).

**Routing boundary:** the exact category route when present, else Global, else
refuse. A configured category route whose candidates all refuse fails the spawn
— empty and ineffective are intentionally different facts (`resolveRoute`,
`src/schemas/routing-policy.ts`; `HiveRouter.select`, `src/daemon/routing-service/router.ts`).

## See Also

- [routing-policy.md](routing-policy.md) — the document this screen edits
- [quota-and-headroom.md](quota-and-headroom.md) — what the meters mean
- [rejected-approaches.md](rejected-approaches.md) — the `vendor-default` picker and the chain editor, and why they are gone
- [../providers/quota-surfaces.md](../providers/quota-surfaces.md) — the wire contracts behind every meter
- [../providers/capability-discovery.md](../providers/capability-discovery.md) — where the effort tri-state comes from
- [../workspace/ui-design-system.md](../workspace/ui-design-system.md) — the rendering system
