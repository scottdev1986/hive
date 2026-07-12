# Selecting a model, per CLI

## What this is and why

"Open me an Opus 4.8 terminal" failed on 2026-07-10, and the failure had nothing to do with the CLI: `claude --model claude-opus-4-8` opens fine. It failed because model selection in Hive then had exactly one knob — the routing table — and nobody had turned it: before the 2026-07-12 cutoff the default deep route resolves `best` → Fable 5, and with `~/.hive/routing.toml` empty, Opus 4.8 was on no route at all. The incident produced two fixes: a deep-tier routing pin, and a second knob — `hive_spawn` now takes an optional `model` for explicit user directives, launched verbatim. This document records the correct, verified way to select a model at every layer — Hive, the Claude CLI, and the Codex CLI — so the next "why can't I get model X" is a config edit, not an investigation. Every claim below was verified on this machine on 2026-07-10 against claude 2.1.206 (Claude Max) and codex-cli 0.144.0; the model *lineups* will drift, the *mechanisms* are the durable content. The per-tier reasoning about which model deserves which job lives in `docs/research/model-routing-and-token-efficiency.md`; this document is only the mechanics.

## Layer 1: Hive — a table for routine work, a pass-through for user directives

Routine selection: the orchestrator classifies (`deep`/`standard`/`cheap`/`review`), and `~/.hive/routing.toml` resolves — overrides merge over `defaultRoutingTable(now)` per tier and per tool, and always win (`src/config/load.ts:70-111`). To make a model reachable by tier, put it on a route:

```toml
# ~/.hive/routing.toml — pin the deep tier's Claude column to Opus 4.8
[deep.claude]
model = "claude-opus-4-8"
```

Pinning all four tiers across both vendors gives every model this account can reach a standing path:

| Model | Path (tier × tool), once pinned |
|---|---|
| `claude-opus-4-8` | `deep` × claude |
| `claude-sonnet-5` | `standard` × claude, `review` × claude |
| `claude-haiku-4-5` | `cheap` × claude |
| `claude-fable-5` | explicit `model` on `hive_spawn`; or swap the `deep.claude` pin |
| `gpt-5.6-sol` | `deep` × codex (effort `xhigh`) |
| `gpt-5.6-terra` | `standard` × codex, `review` × codex (effort `medium`) |
| `gpt-5.6-luna` | `cheap` × codex (effort `low`) |

Since the orchestrator can override the tool at spawn ("use a Claude agent for this"), pinning both columns of every tier is what makes the override meaningful — a route that discards its model under a tool override is a suggestion, not a route.

**No `~/.hive/routing.toml` exists on this machine, so the defaults govern** — checked 2026-07-11, and the file is simply absent, not empty. That matters more than it sounds: until `FABLE_AUTO_ROUTING_CUTOFF` (`2026-07-12T00:00:00Z`, `src/schemas/routing.ts`) the default deep route is `best`, and `best` resolves to `claude-fable-5` (`CLAUDE_BEST_MODEL`, `src/adapters/tools/models.ts`). So a deep-tier Claude spawn goes to Fable 5 today, by default, with nothing written down anywhere saying so. Write the pin above if you want Opus sooner; after the cutoff the default deep Claude route becomes `claude-opus-4-8` on its own.

Fable 5 is deliberately not the standing deep default past that date: it moves to usage-only billing off the subscription. It stays fully reachable — pass `model: "claude-fable-5"` for one agent, or change the `deep.claude` pin to make it the default. Explicit selection keeps working forever, before or after the cutoff; only *auto*-selection narrows.

The cutoff is a billing date, not a safety mechanism, and it is worth being clear about what it does **not** do. It does not stop a spawn from landing on a model whose quota is spent — that is the quota gate's job, and the gate now binds each pool to the models it actually meters, so an exhausted per-model cap (Fable's weekly pool at 99%) refuses the spawn and names the pool that blocked it. See [`docs/research/provider-quota-surfaces.md`](research/provider-quota-surfaces.md). A perfect routing table still needs a working gate: the two failures are independent, and on 2026-07-11 both were live at once.

Two rules govern what value to write. **Pins should be concrete IDs, not aliases**: `resolveConcreteModel` (`src/adapters/tools/models.ts:59-74`) maps only `best` and `default` to concrete models — any other alias (`opus`, `sonnet`) passes through verbatim and becomes the agent's recorded execution identity, so `hive_status` and terminal titles would say "opus" while telling you nothing about what a control restart would actually relaunch. Aliases are the right choice only for *shipped defaults*, where entitlement-adaptivity matters more than identity precision (SPEC §6). **The route must survive a tool override**: every tier carries both a `claude` and a `codex` entry precisely because the orchestrator can spawn "use a Claude agent for this" against a Codex-preferred tier — pin both columns if you care about both.

Explicit selection: `hive_spawn` takes an optional `model` (`src/daemon/spawner.ts`), reserved for user directives — "open an Opus 4.8 terminal" becomes `model: "claude-opus-4-8"`. It launches verbatim (no alias resolution — pass concrete IDs), binds the spawn to its vendor for quota routing, and is never silently substituted: under quota pressure the spawn fails with the capacity report rather than switching models, and the Fable→Opus release valve does not apply to it. The orchestrator is briefed to use it only when the user names a model; its own model knowledge is frozen at training time (SPEC §6), so routine spawns stay on the table. Quota pressure itself selects models only through the release valve (`src/daemon/spawner-impl.ts`), which is live by default (`quota.enabled` defaults to `true`, `src/schemas/quota.ts`): it scores candidates against Hive's own live-discovered headroom (SPEC §6) and needs no `~/.hive/quota.toml` to fire. That file remains what SPEC §6 always meant it to be — an optional manual override layered on top of discovery, never a prerequisite for it; R1 in the research doc predates live discovery and describes the older, now-superseded design where an absent `quota.toml` discarded provider-reported usage outright.

## Layer 2: Claude CLI (verified against claude 2.1.206, Claude Max)

**Launch-time selection is `--model <value>`.** All of the following were launched interactively in tmux and confirmed by the session header:

| `--model` value | Opens | Note |
|---|---|---|
| `claude-opus-4-8` | Opus 4.8, high effort | bare concrete ID works; the CLI may self-report `claude-opus-4-8[1m]` on Max/Team/Enterprise (1M-context upgrade, appended by the CLI — never pass `[1m]` from Hive) |
| `opus` | Opus 4.8 | alias, entitlement-adaptive |
| `opus[1m]` | Opus 4.8 (1M context) | explicit 1M variant; quote the brackets in a shell |
| `claude-fable-5` | Fable 5, high effort | bare concrete ID works |
| `best` | Fable 5 | still resolves despite being absent from the account's model menu |
| `claude-sonnet-5` / `sonnet` | Sonnet 5 | |
| `claude-haiku-4-5` / `haiku` | Haiku 4.5 | |

**Effort is `--effort <low|medium|high|xhigh|max>`** — a real launch flag in 2.1.206 ("Effort level for the current session"), defaulting to `high`. This is the verified mechanism for the research doc's R3 (per-tier Claude effort routing).

**Discovery must be the control protocol, never a guessed subcommand.** The account's authoritative model menu comes back zero-cost, before any model call:

```sh
echo '{"type":"control_request","request_id":"1","request":{"subtype":"initialize"}}' \
  | claude -p --verbose --input-format stream-json --output-format stream-json
```

The `control_response` carries an `account` block and a `models` array — each entry with `value`, `resolvedModel`, `displayName`, `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`, `supportsFastMode`. On this account it enumerates `default` → `claude-opus-4-8[1m]`, `opus[1m]`, `claude-fable-5[1m]`, `sonnet` → `claude-sonnet-5`, `haiku` → `claude-haiku-4-5-20251001`. Two sharp edges: the menu is not exhaustive (bare `claude-opus-4-8` and `best` are accepted but unlisted, so treat the menu as "what exists," not "what parses"), and probing by typing `claude models` runs a **billable prompt** — Claude Code treats unknown subcommands as prompts (`.hive/memory` lesson, and `research/cross-vendor-architecture-review.md` §"What I verified").

## Layer 3: Codex CLI (verified against codex-cli 0.144.0)

**Launch-time selection is `-m/--model <MODEL>`**, or the config override form `-c model="..."`; **effort is config-only**: `-c model_reasoning_effort=<minimal|low|medium|high|xhigh>` — this is the form Hive already passes per tier. All three current models were launched on this account and confirmed by the TUI header (`model: gpt-5.6-terra medium`): `gpt-5.6-sol` ($5/$30), `gpt-5.6-terra` ($2.50/$15), `gpt-5.6-luna` ($1/$6) (developers.openai.com/api/docs/models, fetched 2026-07-10). With no flag, the CLI reads `model` from `~/.codex/config.toml` — on this machine `gpt-5.6-sol` at `xhigh`, which is why Hive's `"default"` Codex routes landed on the premium frontier model before the routing table pinned each tier (the research doc's central cost finding).

The standing caveat that shaped Hive's *shipped* defaults: **naming a concrete Codex model assumes the account is entitled to it** — a ChatGPT-plan account rejects unentitled models at launch ("model not supported", SPEC §6), which is why the shipped Codex column says `"default"`. Pinning concrete Codex models in `routing.toml` is correct precisely because that file is the user's own and its entitlement is verifiable by launching each once; there is no known zero-cost Codex equivalent of Claude's initialize enumeration.

## Autonomy: spawning without a human

Writers launch sandboxed by default (SPEC §4, flipped 2026-07-11); `autonomy = "dangerous"` — set from the Workspace's Agents menu or `hive autonomy dangerous`, both persisting to `~/.hive/config.toml` — launches them fully autonomous. The per-CLI mechanics of dangerous mode, both verified on this machine:

- **Claude** — set `permissions.defaultMode = "bypassPermissions"` in the worktree's `.claude/settings.local.json`. The session starts in bypass mode with no dialog. **Do not use `--dangerously-skip-permissions`**: it raises a blocking acceptance dialog on every launch that an unattended spawn cannot answer, `--allow-dangerously-skip-permissions` does not suppress it, and accepting it does not persist (nothing is written to `~/.claude.json`).
- **Codex** — `-c approval_policy="never" -c sandbox_mode="danger-full-access"`, which the TUI renders as `permissions: YOLO mode`. The directory-trust prompt is separately suppressed by the `projects."<path>".trust_level="trusted"` override Hive already passes.

`autonomy = "sandboxed"` (the default) keeps the approval queue. Read-only sessions — the orchestrator, and the replacement process a critical control spawns — ignore autonomy entirely in both adapters.

## The checklist when a model "won't open"

1. Is it on a route? `bun -e 'import {resolveRoute} from "./src/config/load"; console.log(await resolveRoute("deep"))'` — if the model isn't in the output, no tier-routed spawn reaches it: edit `~/.hive/routing.toml` for a standing route, or have the user name it so the orchestrator passes `model` explicitly for a one-off.
2. Does the CLI accept it directly? Launch it by hand (`claude --model <id>` / `codex -m <id>`) and read the session header — this separates entitlement and CLI problems from Hive problems in one step.
3. Is the value concrete? Aliases other than `best`/`default` pass through unresolved into the execution identity and forfeit safe control restarts.
4. Did the spawn fail for a non-model reason? `hive_status` records `failureReason` with the pane's last lines; the 2026-07-10 morning failures ("tmux session exited") were the Channels argument bug fixed in 8ec5441, not model selection.
5. Is the agent alive but idle at a prompt? Check the pane for an acceptance or trust dialog — that means the autonomy posture above did not reach it (a stale daemon running pre-`autonomy` code is the usual cause; restart it).
