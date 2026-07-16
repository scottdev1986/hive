# Capability discovery

Updated: 2026-07-16
Sources: Hive source tree, 2026-07-16; [cross-vendor architecture review](../../raw/reviews/cross-vendor-architecture-review.md)
Raw: [Cross-vendor architecture review](../../raw/reviews/cross-vendor-architecture-review.md) · [Codex 0.144.4 hidden-bootstrap verification](../../raw/codex/codex-0.144.4-hidden-bootstrap-verification.txt)

## Summary

Every vendor CLI Hive drives will tell you, for free and without buying an inference, which models the signed-in account can launch and which effort levels each accepts. None of them will tell you which model is *good*. This article records what the wire actually says, what it conspicuously does not, and the reading discipline that keeps an absent field from becoming a fabricated `false`.

Catalog wire behavior was verified 2026-07-11 against claude 2.1.207 and codex-cli 0.144.1; the Codex compatibility/schema surface was verified 2026-07-16 against codex-cli 0.144.4; the Grok surface was most recently verified 2026-07-14 against grok 0.2.101. Model ids below are **examples observed on those dates**, never a shipped catalog: exact ids come from discovery. A legacy name-shape helper can recognize Claude- and Codex-shaped names but carries no concrete catalog (`src/adapters/tools/models.ts:1-15`). Observed ids rot. The mechanisms do not.

## The probe matrix

"Free" means: no user message, no thread, no turn, no inference. It does not mean stable.

| Surface | Cost | What it yields |
|---|---|---|
| Claude control `initialize` (stream-json, stdin closed) | **free** | account identity + a model menu: `value`, `resolvedModel`, `displayName`, `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`, `supportsFastMode` |
| Claude `statusLine` stdin payload | **free**, runtime-only | the live session's effective `effort.level` and `model.id`; tracks `/effort` and mid-session model switches |
| Claude control `get_usage` | **free**, experimental | see [quota-surfaces.md](quota-surfaces.md) |
| Codex app-server `model/list` (`{}`, `includeHidden: true`) | **free**, documented | `id`, `model`, display name, `hidden`, `isDefault`, `defaultReasoningEffort`, `supportedReasoningEfforts`, modalities, service tiers |
| Codex app-server `config/read` | **free** | the effective layered model + effort an *unflagged* launch on this machine will use |
| Codex app-server `account/read` | **free** | auth mode, plan type (e.g. `chatgpt`/`prolite`). No per-model grants. Do not log the email it carries. |
| Codex `app-server generate-json-schema` without `--experimental` | **free** | the standard generated bundle for the installed binary — version-local, not account truth; the generator command itself is help-labeled experimental |
| Grok `grok models` + `~/.grok/models_cache.json` | **free**, two-step | `id`, `name`, `hidden`, `supports_reasoning_effort`, `reasoning_efforts[]` |
| `<cli> --version` | **free** | the CLI identity — **carried by no catalog**; it must be read separately. Codex launches require `>= 0.144.4` |
| Trial launch / tiny prompt | **BILLABLE** | not a discovery primitive |

**Probing by guessing a CLI subcommand is BILLABLE on both CLIs.** `claude models` is not a subcommand; Claude Code treats the unrecognized word as a *prompt*, runs a session, spends quota, and exits 0. Codex behaves the same way. Exit 0 is not evidence of anything. Confirm every argument against `--help`, and prefer the declared control/RPC surfaces over argv. This single fact is why the Grok probe uses only the real `grok models` subcommand and why it additionally demands a liveness signal (below) rather than trusting the exit code.

## Codex compatibility is a launch gate, not catalog discovery

Hive accepts only a strict stable `codex-cli MAJOR.MINOR.PATCH` identity at or
above 0.144.4; malformed output, prereleases at the floor, and older versions fail
closed. The floor is Hive's product decision for hidden session bootstrap, not an
OpenAI support claim. It is checked before model resolution, quota reservation,
worktree allocation, root teardown, capability issuance, or process launch.

An explicit Codex request is never substituted after a compatibility refusal. An
ordered routed request may continue to the next enabled provider, and its route
audit retains the Codex refusal. One routing decision memoizes one version read
across several Codex links; the final process adapter revalidates before launch so
a downgrade during setup cannot slip through. Crash recovery and critical restart
re-enter the same full gate and preserve the recorded provider rather than
switching it. Claude-only and Grok-only decisions do not invoke `codex --version`.

The locally generated non-`--experimental` 0.144.4 schema contains
`developerInstructions` in both `ThreadStartParams` and `ThreadResumeParams`; this
is empirical installed-binary evidence, not public-prose evidence. No thread or
turn was created to obtain it. See the linked raw record for the command boundary,
field excerpts, and hashes.

### Reader compatibility is not writer permission

The `>= 0.144.4` floor above answers exactly one question: can this build be
bootstrapped with hidden developer instructions instead of a visible user
prompt. It says nothing about whether a Codex writer is safe, and it must never
be read that way. A `>=` comparison is a claim about the past — a newer build
can regress the mutation broker, drop a field the gate reads, or change an
approval's scope, and the comparison would keep saying yes.

So writer admission takes **no version input at all**: no `codex --version`, no
build hash, no schema hash, no allowlist. It gates on the *driver* only (see
[launch-mechanics](./launch-mechanics.md)), and writer safety comes structurally
from the runtime boundary — a read-only sandbox plus a per-mutation identity
gate. On a build whose app-server cannot supply fresh applied identity or
one-shot approvals, the writer is not refused at launch; its mutations are
simply all denied at runtime. A useless writer is an acceptable outcome. An
ungated one is not.

That split is why the two compatibility questions live in different places: the
version floor is a *bootstrap* gate checked before launch, and writer safety is
a *runtime* gate checked before every single mutation.

## `isDefault` is not the effective default

Codex's `model/list` flags exactly one catalog entry `isDefault`. On 2026-07-11 that flag sat on `gpt-5.5` — while `config/read` reported that an unflagged launch on this very machine would run `gpt-5.6-sol` at `xhigh`. Both readings were correct. They answer different questions: `isDefault` is the *vendor's catalog recommendation*; the effective default is what the *layered local config* actually resolves to.

> **A router that reads the catalog flag and calls it "the default" is describing a different machine than the one it is about to spawn on.**

So the effective default is read from `config/read` on Codex, from the menu's `default` entry on Claude, and from the `* <id> (default)` line of `grok models` stdout on Grok (`src/daemon/capability-discovery.ts:769-775`). Never from `isDefault`.

## A guessed field name does not error — it reads as "no"

The most transferable lesson in this corpus, and it cost a nearly-shipped wrong record.

While building the capability records, a probe read Codex's hidden flag under the guessed key **`isHidden`**. It returned `null` for **every model in the catalog — including the one entry that is genuinely hidden.** Nothing errored. Nothing warned. The column was uniformly empty, which is *indistinguishable* from a vendor that simply does not publish the field. The near-miss was a `hidden`-is-`surface-silent` record for a provider that in fact sends `hidden` on every single entry. The real key is `hidden`.

Two rules follow, and both are cheap:

1. **Field names come off the live wire, never from memory or from the shape of a sibling API.** Dump the raw frame and read the keys that are there.
2. **Prove every field with a positive control** — one entry that *must* come back non-null if the key is right. The genuinely-hidden catalog entry is the control for `hidden`: any read of that flag returning null *for it* is a wrong key, not a quiet vendor.

> **An all-null column is a bug hypothesis, not a finding.**

The corollary is why the unknown taxonomy below exists at all: a guessed JSON key is indistinguishable from an honest absence, and only a discipline that refuses to turn absence into `false` stops that indistinguishability from silently becoming a shipped judgment.

### A related shape trap

`supportedReasoningEfforts` is a list of **objects** — `{reasoningEffort, description}` — not a list of strings. A consumer that expects strings reads nothing, gets an empty effort set, and concludes the model supports no effort at all. Claude's `supportedEffortLevels`, on the other surface, *is* a list of strings. The two surfaces do not agree on shape, and neither is wrong.

## The two surfaces are not symmetric

| Fact | Claude control `initialize` | Codex `model/list` |
|---|---|---|
| effort supported | `supportsEffort` (bool per model) — **absent on the haiku-class entry** | **sent for no model** |
| effort levels | `supportedEffortLevels` — list of **strings** | `supportedReasoningEfforts` — list of **objects** |
| recommended effort | **sent for no model** | `defaultReasoningEffort`, per model |
| vendor-internal | **sent for no model** | `hidden`, boolean per model |
| entitlement | **sent by neither** — presence in the account-scoped catalog is the whole of the evidence | |
| CLI version | **carried by neither catalog** — read from `<cli> --version` | |

So `defaultEffort` is Codex-only, `supportsEffort` is Claude-only, `hidden` is Codex-only, and `entitled` is nobody's. Hive records `entitled: known(true)` for a model it *saw* in the account's catalog (`src/daemon/capability-discovery.ts:148`, `:347`, `:810`) — presence is positive evidence. No vendor will ever send `entitled: false`; unusable models are simply **absent**.

Four traps, each a plausible mistake:

- Defaulting a Claude model's recommended effort to `medium` invents a vendor claim. Claude recommends nothing.
- Reconstructing Codex's `supportsEffort` from its non-empty effort list fabricates a boolean the vendor never sent — and it *looks* right, which is what makes it dangerous.
- Reading a Claude model's `hidden` as `false` is a guess. Claude has no hidden flag; the honest value is unknown.
- Waiting for `entitled: false` is waiting for something no vendor will send.

**Claude's model menu is not exhaustive.** Models launch that the menu never lists — bare concrete ids and the `best` alias were accepted at launch while absent from the 2.1.207 menu. Absence from the menu is not proof a model cannot launch. Treat the menu as *"what exists"*, never as *"what parses"*.

## Discovery is not validation: the three-state trust ladder

The sharpest limit on everything above. **`--model totally-bogus-model-xyz` is ACCEPTED at launch.** Claude's `initialize` takes it, and `system/init` echoes the garbage back verbatim as the effective model. Only the **first turn** fails — `is_error: true`, `total_cost_usd: 0`, *"There's an issue with the selected model … It may not exist or you may not have access to it."*

> **The vendor accepting a model argument is not validation.** A launch that looks valid to the CLI can still fail on its first turn.

So a model id has **three** states, and conflating any two of them is a bug:

| state | earned by | strength |
|---|---|---|
| `catalogued` | some provider catalog names it | weakest — says nothing about *this account* |
| `providerReportedSelectable` | an authenticated, account-scoped call offers it (Claude's `initialize.models[]`, Codex's `model/list`, Grok's `models_cache.json`) | **what every surface in this article yields** |
| `launchValidated` | a real session accepted it and a real turn came back | proof — and it costs a turn |

Everything discovery gives you is the **middle** state. It is stronger than anything a public catalog offers and it is *weaker than first-turn proof*. Hive still uses that evidence to fail closed before creating a tmux session: the launch gate requires a readable catalog record for the exact model and explicit enablement (`src/daemon/spawner-impl.ts:1571-1605`). That prevents guessed or quietly substituted pins, but it cannot turn the catalog into proof that the vendor will complete a turn. See [../routing/routing-policy.md](../routing/routing-policy.md).

Hive records this honestly today: a discovered model carries `entitled: known(true)` because it was *seen in the account's catalog* — that is the middle rung asserted as exactly what it is, not as launch proof.

## Two protocol facts worth keeping

**Claude's `initialize` control_request is genuinely zero-cost** and returns both the account block and `models[]` in one frame — no prompt, no turn, no thread. It is the same frame Hive already awaits for the pool→model display-name join ([quota-surfaces.md](quota-surfaces.md)), so the catalog costs no extra round trip.

**Re-sending `initialize` to a live Claude session returns `pending_permission_requests`** — an array of the exact `control_request`s the session is still blocked on. That is the vendor's own answer to approval-replay-on-reconnect: reconnect, re-read, re-answer, without duplicating an approval. (It resolves the *approval* leg only; no vendor offers turn-level idempotency keys, so a turn interrupted mid-flight remains an honest `UNKNOWN_OUTCOME`.) **Hive does not consume this field yet** — recorded here as available vendor surface, not as shipped behavior.

**The Codex app-server has no protocol-version field.** Its `initialize` carries `clientInfo` and capability flags and nothing to negotiate against (`src/adapters/tools/codex-app-server.ts:137-142` sends exactly that), so a version assumption **cannot be checked on the wire** — versioning is by build-pinned generated schemas, and `--help` calls the whole surface experimental. The contrast is instructive: Grok's ACP `initialize` *does* send `protocolVersion: 1` (`src/daemon/quota-sources.ts:1091`), and Claude sends a `capabilities[]` array. Codex, the surface most often treated as the protocol benchmark here, is the one that cannot tell you what protocol it speaks.

## The three-way unknown

Three different things look identical at a call site, and collapsing them into one `null` is how a guess acquires a vendor's badge. The taxonomy survived research into the type system at `src/schemas/capability.ts:129-148`:

- **`field-absent`** — the surface answered *for this model* and omitted the field. (The haiku-class entry carries no effort fields at all.) Omission may mean unsupported, rollout-gated, or missing from this protocol version. The record must not choose on the vendor's behalf.
- **`surface-silent`** — the surface carries the field for *no* model, so its absence says nothing about this one. (Claude has no `hidden` at all; Codex has no `supportsEffort` at all.)
- **`malformed`** — present but not the documented shape. A payload we cannot parse is not a payload that said `false`.

Every discovered fact is a `Discovered<T>` (`src/schemas/capability.ts:159-172`): a discriminated union of `{state:"known", value, surface, observedAt}` and `{state:"unknown", reason, surface, observedAt}`. A consumer *must* branch on `state` to read a value, which makes the guess impossible rather than merely discouraged. `valueOr()` exists (`:205`) but takes the fallback at the call site — there is no default hidden inside the reader.

> **An absent field is `unknown(surface-silent)`, never `false`. Anything that turns silence into a boolean — a schema default, a `?? false`, a `?? "medium"` — is a Hive guess wearing a vendor's badge.**

Effort levels are stored as the **raw vendor strings**, never a Hive enum (`src/schemas/capability.ts:209-217`). A strict enum at the ingestion boundary recreates exactly the release dependency dynamic discovery exists to remove — and a level Hive drops at ingestion is a level a critical restart cannot replay.

## Grok's catalog: two steps, and exit 0 is not evidence

Grok publishes no app-server metadata RPC. Its catalog is read in two steps (`src/daemon/capability-discovery.ts:691-745`):

1. run `grok models` (a **real** subcommand — see the billable-subcommand warning above),
2. then parse the file it refreshes, `~/.grok/models_cache.json` (or `$GROK_HOME`).

The cache entries the code consumes are `id`, `name`, `hidden`, `supports_reasoning_effort`, and `reasoning_efforts[]` (each `{value, default?}`) — schema at `src/daemon/capability-discovery.ts:661-677`. The schemas are `passthrough`, so unknown vendor keys do not invalidate the payload; a `context_window` field is **not** among the ones Hive records today.

The code is **stricter than the research docs were**, in three ways that are all load-bearing:

- **Liveness, not exit code.** `grok models` run offline prints the *cached* catalog and exits 0. So the transport runs it with `--debug --debug-file <tmp>` and requires a measured settings-fetch success line in that debug log before it will trust anything (`grokModelsProvedLive`, `src/daemon/capability-discovery.ts:754-758`, gated at `:736`). Exit 0 is explicitly not accepted as evidence of a live read — the same discipline the billable-subcommand rule teaches, applied to a subcommand that is real.
- **Runtime behavioral trust.** A new Grok version is not refused merely for being new. Every probe must prove a live remote fetch, parse the expected cache schema, match the cache's `grok_version` to the running CLI, keep every model map key equal to `info.id`, keep effort declarations internally coherent, produce at least one usable record, and name a default that exists in that record set (`src/daemon/capability-discovery.ts`). A protocol-changing update therefore fails closed on the changed behavior, while a routine compatible update needs no Hive release. The CLI identity still comes from a `grok --version` parse whose regex is pinned verbatim in the adapter (`src/adapters/tools/grok.ts:59`). The latest compatible-version measurement is preserved in [the raw verification](../../raw/grok/grok-0.2.101-catalog-verification.txt).
- **Cache/CLI coherence.** A cache whose `grok_version` does not equal the CLI's own version yields *no records at all* (`src/daemon/capability-discovery.ts:783-787`), and an entry whose `info.id` disagrees with its map key is dropped (`:795`). A stale cache is not a catalog.

Grok's `defaultEffort` is `known` only when some entry in `reasoning_efforts[]` carries `default: true`; otherwise it is `unknown("field-absent")` (`src/daemon/capability-discovery.ts:817-820`) — never `"medium"`.

## What no free surface gives you

No vendor returns a task-quality score, a cross-vendor capability scale, expected tokens or subscription percent for a future task, or a trustworthy mapping from API dollars to subscription capacity. Codex does not publish per-model price or context size in `model/list`. Public model/pricing pages are *enrichment* — they describe the API plane, not a CLI subscription's entitlement — and a web page failing must never make spawning impossible.

Those facts must remain unknown, user-configured, or learned from explicit evals. Inventing them only makes a router confidently wrong. What model judgment Hive *does* apply is user policy, not vendor truth: see [../routing/routing-policy.md](../routing/routing-policy.md) and `../../SPEC.md` §6.

## See Also

- [Launch mechanics](launch-mechanics.md) — what to do with a discovered model id
- [Quota surfaces](quota-surfaces.md) — the other free wire read, and the pool→model join
- [Grok](grok.md) — the vendor whose catalog needs a liveness proof
- [Routing policy](../routing/routing-policy.md)
