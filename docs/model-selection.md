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

This exact pin was applied on 2026-07-10 and verified end to end: `resolveRoute("deep")` now returns `claude/claude-opus-4-8`, so a deep Claude spawn opens a 4.8 terminal. Swap the value to `"best"` or `"claude-fable-5"` to send deep work to Fable instead — explicit pins keep working after the cutoff; only the *default* stops auto-selecting Fable (`FABLE_AUTO_ROUTING_CUTOFF`, `src/schemas/routing.ts:77`).

Two rules govern what value to write. **Pins should be concrete IDs, not aliases**: `resolveConcreteModel` (`src/adapters/tools/models.ts:59-74`) maps only `best` and `default` to concrete models — any other alias (`opus`, `sonnet`) passes through verbatim and becomes the agent's recorded execution identity, so `hive_status` and terminal titles would say "opus" while telling you nothing about what a control restart would actually relaunch. Aliases are the right choice only for *shipped defaults*, where entitlement-adaptivity matters more than identity precision (SPEC §6). **The route must survive a tool override**: every tier carries both a `claude` and a `codex` entry precisely because the orchestrator can spawn "use a Claude agent for this" against a Codex-preferred tier — pin both columns if you care about both.

Explicit selection: `hive_spawn` takes an optional `model` (`src/daemon/spawner.ts`), reserved for user directives — "open an Opus 4.8 terminal" becomes `model: "claude-opus-4-8"`. It launches verbatim (no alias resolution — pass concrete IDs), binds the spawn to its vendor for quota routing, and is never silently substituted: under quota pressure the spawn fails with the capacity report rather than switching models, and the Fable→Opus release valve does not apply to it. The orchestrator is briefed to use it only when the user names a model; its own model knowledge is frozen at training time (SPEC §6), so routine spawns stay on the table. Quota pressure itself selects models only through the release valve (`src/daemon/spawner-impl.ts`), which is inert until `~/.hive/quota.toml` defines pools — see R1 in the research doc.

## Layer 2: Claude CLI (verified against claude 2.1.206, Claude Max)

**Launch-time selection is `--model <value>`.** All of the following were launched interactively in tmux and confirmed by the session header:

| `--model` value | Opens | Note |
|---|---|---|
| `claude-opus-4-8` | Opus 4.8, high effort | bare concrete ID works; the CLI may self-report `claude-opus-4-8[1m]` on Max/Team/Enterprise (1M-context upgrade, appended by the CLI — never pass `[1m]` from Hive) |
| `opus` | Opus 4.8 | alias, entitlement-adaptive |
| `opus[1m]` | Opus 4.8 (1M context) | explicit 1M variant; quote the brackets in a shell |
| `best` | Fable 5 | still resolves despite being absent from the account's model menu |
| `sonnet` | Sonnet 5 | |
| `haiku` | Haiku 4.5 | |

**Effort is `--effort <low|medium|high|xhigh|max>`** — a real launch flag in 2.1.206 ("Effort level for the current session"), defaulting to `high`. This is the verified mechanism for the research doc's R3 (per-tier Claude effort routing).

**Discovery must be the control protocol, never a guessed subcommand.** The account's authoritative model menu comes back zero-cost, before any model call:

```sh
echo '{"type":"control_request","request_id":"1","request":{"subtype":"initialize"}}' \
  | claude -p --verbose --input-format stream-json --output-format stream-json
```

The `control_response` carries an `account` block and a `models` array — each entry with `value`, `resolvedModel`, `displayName`, `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`, `supportsFastMode`. On this account it enumerates `default` → `claude-opus-4-8[1m]`, `opus[1m]`, `claude-fable-5[1m]`, `sonnet` → `claude-sonnet-5`, `haiku` → `claude-haiku-4-5-20251001`. Two sharp edges: the menu is not exhaustive (bare `claude-opus-4-8` and `best` are accepted but unlisted, so treat the menu as "what exists," not "what parses"), and probing by typing `claude models` runs a **billable prompt** — Claude Code treats unknown subcommands as prompts (`.hive/memory` lesson, and `research/cross-vendor-architecture-review.md` §"What I verified").

## Layer 3: Codex CLI (verified against codex-cli 0.144.0)

**Launch-time selection is `-m/--model <MODEL>`**, or the config override form `-c model="..."`; **effort is config-only**: `-c model_reasoning_effort=<minimal|low|medium|high|xhigh>` — this is the form Hive already passes per tier. With no flag, the CLI reads `model` from `~/.codex/config.toml` — on this machine `gpt-5.6-sol` at `xhigh`, which is why Hive's `"default"` Codex routes land on the premium frontier model (the research doc's central cost finding). The current lineup is `gpt-5.6-sol` ($5/$30), `gpt-5.6-terra` ($2.50/$15), `gpt-5.6-luna` ($1/$6) (developers.openai.com/api/docs/models, fetched 2026-07-10).

The standing caveat that shaped Hive's defaults: **naming a concrete Codex model assumes the account is entitled to it** — a ChatGPT-plan account rejects unentitled models at launch ("model not supported", SPEC §6), which is why the shipped Codex column says `"default"`. Pin a concrete Codex model in `routing.toml` only for a plan you know carries it; there is no known zero-cost Codex equivalent of Claude's initialize enumeration.

## The checklist when a model "won't open"

1. Is it on a route? `bun -e 'import {resolveRoute} from "./src/config/load"; console.log(await resolveRoute("deep"))'` — if the model isn't in the output, no tier-routed spawn reaches it: edit `~/.hive/routing.toml` for a standing route, or have the user name it so the orchestrator passes `model` explicitly for a one-off.
2. Does the CLI accept it directly? Launch it by hand (`claude --model <id>` / `codex -m <id>`) and read the session header — this separates entitlement and CLI problems from Hive problems in one step.
3. Is the value concrete? Aliases other than `best`/`default` pass through unresolved into the execution identity and forfeit safe control restarts.
4. Did the spawn fail for a non-model reason? `hive_status` records `failureReason` with the pane's last lines; the 2026-07-10 morning failures ("tmux session exited") were the Channels argument bug fixed in 8ec5441, not model selection.
