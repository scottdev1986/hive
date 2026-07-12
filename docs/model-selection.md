# Selecting a model, per CLI

## What this is and why

"Open me an Opus 4.8 terminal" failed on 2026-07-10, and the failure had nothing to do with the CLI: `claude --model claude-opus-4-8` opens fine. It failed because model selection in Hive then had exactly one knob — a compiled-in routing table — and nobody had turned it. The fixes that incident produced (routing pins, an explicit `model` on `hive_spawn`) survive below, but the machinery around them has been rebuilt twice since, the second time by the user's standing directive (2026-07-12): **the binary ships with no model knowledge.** No compiled routing table, no candidate manifest, no alias constants — Hive learns the catalog from the vendors at runtime, and routes derive from that plus the user's own policy. This document records the correct, verified way to select a model at every layer — Hive, the Claude CLI, and the Codex CLI — so the next "why can't I get model X" is a config edit, not an investigation. The CLI mechanics in Layers 2 and 3 were verified on this machine on 2026-07-10 against claude 2.1.206 (Claude Max) and codex-cli 0.144.0, and the discovery surfaces on 2026-07-11 against claude 2.1.207 and codex-cli 0.144.1; the model *lineups* will drift, the *mechanisms* are the durable content.

Two earlier revisions of this document are worth naming as history. One described `FABLE_AUTO_ROUTING_CUTOFF`, a date on which deep-tier auto-routing would abandon Fable 5 — deleted, because the date was a proxy for a billing belief that driving the live surface falsified; cost is now *measured* (`src/daemon/usage-credits.ts`). The other listed `gpt-5.6-terra` and `gpt-5.6-luna` as Hive routes; they never were — they are real vendor models this account can launch (verified 2026-07-10), reachable like any model is: pin one, or name it explicitly.

## Layer 1: Hive — derived from the account, governed by your policy

Routine selection: the orchestrator classifies (`deep`/`standard`/`cheap`/`review`), and the derivation engine resolves — per field, through three layers and a refusal (`src/schemas/routing-derivation.ts`):

1. **Your pin** (`~/.hive/routing.toml`, same format as ever). A standing user directive; it always wins, and is never silently overridden *or* silently obeyed — every way it disagrees with what Hive knows is named on the spawn. A misspelled tier name is rejected loudly rather than silently pinning nothing.
2. **The derived route**: the account's own **effective default** — what an unflagged launch actually runs, read live off the vendor's surface (`config/read` for Codex, the menu's `default` entry for Claude) and vouched by a fresh capability record. This is the one vendor-declared rank Hive passes through: the vendor's judgment about the account, reported rather than formed. It still clears the availability filter (a model whose own metered pool is spent, with credits off, stops being a candidate) and the spend guard (a model that would cost real money is never auto-routed without consent — see `docs/research/provider-quota-surfaces.md`).
3. **The last-known-good derivation**, loudly: a per-cell snapshot of what the engine last derived, replayed at its true age when discovery is down. A provider outage must not erase what the last healthy run learned.
4. **Refusal.** Where none of those can author a cell, the spawn FAILS with a reason naming what Hive needs ("install or sign in to the claude CLI, or pin routing.toml [deep.claude]"). There is no baked-in list to fall to — on a fresh install with no vendor CLIs, Hive refuses and says which CLIs it needs, and on the first healthy discovery you can watch the catalog populate from nothing (`hive_models`, `hive routing`).

What DOES ship is **policy that names no model**: which vendor a tier prefers (deep/review→claude, standard/cheap→codex) and what effort a tier reasons at — both compiled as `TIER_PREFERRED_TOOL` / `TIER_EFFORT_POLICY` in `src/schemas/routing-derivation.ts`, both overridable per cell in `routing.toml`. The old escape hatches (`router = "shipped"`, `routingManifest = "off"`) still parse but revert to nothing; the escape from a bad derivation is a pin.

**Effort is chosen, not defaulted.** The tier policy names the choice — deep=`high`, standard/review=`medium`, cheap=`low` — and the engine passes it only when the resolved model's live record advertises that exact level. A level the record doesn't advertise (or a record that publishes no levels, like Haiku's) is refused with a named note and no flag is passed; the vendor's own per-model default informs a human editing the policy but never silently governs a derived cell. Pinned efforts are honoured and conflicts reported; a pinned model with no pinned effort takes its own advertised default; last-known-good replays keep the effort that was derived *with* their model.

**Tier differentiation is deliberately thin right now.** With no manifest and no activated benchmark surface, every tier's unpinned cell derives the same account default and differs by effort (and vendor preference) only, and coding cells carry an explicit "no capability evidence" note — the capability floor has no declarer until the benchmark surface or your policy supplies one. That is the directed state, not a bug: the user placed model judgment outside the binary. Benchmarks fill it in: **LiveBench, the sole registered source (user-ruled 2026-07-12; sources requiring an API key or terms-of-service acceptance were ruled out)** — benchmark-driven placement goes live in the real derivation once the user-approved threshold/fit policy lands (his ruling, verbatim: *"I do not want shadow at all i want the real thing live no parrallell path"*), and the source set itself is user-changeable policy, never code.

There is no downshift chain today either: the manifest's ordered candidate lists died with it, so quota pressure chooses between the two vendors' cells rather than down a same-vendor list — except the measurement-driven release valve, which offers the account's own default beside a separately-metered primary when the provider's live reading shows one (`src/daemon/spawner-impl.ts`, `releaseValveAlternative`). With no live reading there is no valve: nothing is invented.

**Inspection surfaces.** `hive routing` prints the derived table with per-field provenance (value, layer, reason, age) and every warning; tier escalations are counted per model × tier and surfaced on the routing inspection surfaces. The orchestrator's runtime surface is the `hive_models` MCP tool: every model discovered from both vendors — including hidden and unrouted ones — with effort levels, plan status, routing roles, and when Hive would use each. (The shadow/counterfactual apparatus is being removed per the user's ruling — no parallel path; what stays is telemetry about real decisions.)

**Explicit selection**: `hive_spawn` takes an optional `model` (`src/daemon/spawner.ts`), reserved for user directives — "open an Opus 4.8 terminal" becomes `model: "claude-opus-4-8"`. It launches verbatim (no alias resolution — pass concrete IDs), binds the spawn to its vendor for quota routing, refuses an explicitly conflicting tool, and is never silently substituted: under quota pressure the spawn fails with the capacity report rather than switching models. The orchestrator is briefed to use it only when the user names a model; its own model knowledge is frozen at training time (SPEC §6), so routine spawns stay on the tiers. `hive_spawn` also takes an optional `effort`, validated against the resolved model's record.

**Self-escalation**: an agent that hits a genuine capability wall mid-task — at least two distinct approaches tried and failed, not a scope surprise — commits its WIP and calls `hive_escalate` once, with the evidence and a handoff (goal, done, remaining, decisions). The daemon records the escalation per model × tier (measured, reviewable, never blocked) and delivers the handoff to the orchestrator, which either respawns the task at a higher tier — never a named model; the tier resolves it — and kills the escalated agent after the replacement confirms pickup, or declines with direction. Mid-session model change is deliberately impossible: `model` is the immutable launch identity (SPEC §6), so re-routing is always a handoff.

Two rules govern what value to write in a pin. **Pins should be concrete IDs, not aliases**: `resolveConcreteModel` (`src/adapters/tools/models.ts`) maps only `best` and `default` to concrete models — any other alias passes through verbatim and becomes the agent's recorded execution identity, telling you nothing about what a control restart would relaunch. **The route must survive a tool override**: every tier carries both a `claude` and a `codex` entry precisely because the orchestrator can spawn "use a Claude agent for this" against a Codex-preferred tier — pin both columns if you care about both.

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

**Effort is `--effort <low|medium|high|xhigh|max>`** — a real launch flag in 2.1.206 ("Effort level for the current session"), defaulting to `high`. Hive passes a tier's chosen effort only when the model's discovered record advertises the level; Haiku's menu entry advertises none, so cheap-tier Claude spawns carry no flag.

**Discovery must be the control protocol, never a guessed subcommand.** The account's authoritative model menu comes back zero-cost, before any model call:

```sh
echo '{"type":"control_request","request_id":"1","request":{"subtype":"initialize"}}' \
  | claude -p --verbose --input-format stream-json --output-format stream-json
```

The `control_response` carries an `account` block and a `models` array — each entry with `value`, `resolvedModel`, `displayName`, `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`, `supportsFastMode`. This is exactly what `src/daemon/capability-discovery.ts` reads. Two sharp edges: the menu is not exhaustive (bare `claude-opus-4-8` and `best` are accepted but unlisted, so treat the menu as "what exists," not "what parses"), and probing by typing `claude models` runs a **billable prompt** — Claude Code treats unknown subcommands as prompts (`.hive/memory` lesson, and `research/cross-vendor-architecture-review.md` §"What I verified").

## Layer 3: Codex CLI (verified against codex-cli 0.144.0)

**Launch-time selection is `-m/--model <MODEL>`**, or the config override form `-c model="..."`; **effort is config-only**: `-c model_reasoning_effort=<minimal|low|medium|high|xhigh>` — this is the form Hive passes. All three current models were launched on this account and confirmed by the TUI header (`model: gpt-5.6-terra medium`): `gpt-5.6-sol` ($5/$30), `gpt-5.6-terra` ($2.50/$15), `gpt-5.6-luna` ($1/$6) (developers.openai.com/api/docs/models, fetched 2026-07-10). With no flag, the CLI reads `model` from `~/.codex/config.toml` — on this machine `gpt-5.6-sol` at `xhigh`, which is why an unflagged Codex launch is expensive by default and why the ladder's provider-default rung reads `config/read` rather than guessing.

The standing caveat that shaped the *compiled-in* defaults: **naming a concrete Codex model assumes the account is entitled to it** — a ChatGPT-plan account rejects unentitled models at launch ("model not supported", SPEC §6), which is why the shipped table's Codex column says `"default"`. The derived router does not share the problem: its candidates are intersected with `model/list`, which enumerates exactly what this account may launch (`codex app-server`, zero-cost, after the mandatory `initialize`/`initialized` handshake — the "no zero-cost Codex enumeration" claim in earlier revisions of this document was wrong and is withdrawn). Pinning concrete Codex models in `routing.toml` remains correct because that file is the user's own.

## Autonomy: spawning without a human

Writers launch sandboxed by default (SPEC §4, flipped 2026-07-11); `autonomy = "dangerous"` — set from the Workspace's Agents menu or `hive autonomy dangerous`, both persisting to `~/.hive/config.toml` — launches them fully autonomous. The per-CLI mechanics of dangerous mode, both verified on this machine:

- **Claude** — set `permissions.defaultMode = "bypassPermissions"` in the worktree's `.claude/settings.local.json`. The session starts in bypass mode with no dialog. **Do not use `--dangerously-skip-permissions`**: it raises a blocking acceptance dialog on every launch that an unattended spawn cannot answer, `--allow-dangerously-skip-permissions` does not suppress it, and accepting it does not persist (nothing is written to `~/.claude.json`).
- **Codex** — `-c approval_policy="never" -c sandbox_mode="danger-full-access"`, which the TUI renders as `permissions: YOLO mode`. The directory-trust prompt is separately suppressed by the `projects."<path>".trust_level="trusted"` override Hive already passes.

`autonomy = "sandboxed"` (the default) keeps the approval queue. Read-only sessions — the orchestrator, and the replacement process a critical control spawns — ignore autonomy entirely in both adapters.

## The checklist when a model "won't open"

1. Is it on a route? Run `hive routing` — it prints what every tier resolves to and where each value came from. If the model is in no cell and no chain, no tier-routed spawn reaches it: pin it in `~/.hive/routing.toml` for a standing route, or have the user name it so the orchestrator passes `model` explicitly for a one-off. `hive_models` answers the same question for the orchestrator at runtime.
2. Does the CLI accept it directly? Launch it by hand (`claude --model <id>` / `codex -m <id>`) and read the session header — this separates entitlement and CLI problems from Hive problems in one step.
3. Is the value concrete? Aliases other than `best`/`default` pass through unresolved into the execution identity and forfeit safe control restarts.
4. Is a pool or the wallet in the way? `hive quota` shows measured headroom per pool; an exhausted per-model pool refuses the spawn and names the pool that blocked it, and a spawn that would spend real money waits on the approvals queue, not on luck.
5. Did the spawn fail for a non-model reason? `hive_status` records `failureReason` with the pane's last lines; the 2026-07-10 morning failures ("tmux session exited") were the Channels argument bug fixed in 8ec5441, not model selection.
6. Is the agent alive but idle at a prompt? Check the pane for an acceptance or trust dialog — that means the autonomy posture above did not reach it (a stale daemon running pre-`autonomy` code is the usual cause; restart it).
