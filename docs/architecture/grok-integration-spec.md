# Grok as a first-class Hive vendor: implementation specification

## 1. What is being built

Hive adds `grok` beside `claude` and `codex` as a complete vendor, not as a third string accepted by the existing two-vendor code. A Grok agent must use Grok's own command, configuration, session identity, telemetry, model catalog, quota state, delivery semantics, skill, recovery path, and Workspace representation. If any one of those paths is not implemented, Hive must reject or report that missing operation. It must never borrow the Claude or Codex path because a binary conditional happened to have an `else` branch.

That distinction is the thesis of this specification. A third enum member can compile, launch, and still be dangerously wrong: the process may receive Codex configuration, the quota reader may query Claude, the context reader may return `null`, or the Graphify counter may return zero forever. First-class support means every vendor decision is exhaustive and every observation preserves the difference between zero and unknown.

The Grok facts in this document are bound to the measured `grok 0.2.93 (f00f96316d4b) [stable]` reports named in the task. The CLI ships breaking releases several times a day, and both its ACP extensions and session files are undocumented. They are evidence for an adapter with a drift guard, not a permanent API promise. Facts the reports leave `UNKNOWN` remain `UNKNOWN` here.

The top open risk is potentially fatal: both measured headless runs that invoked MCP tools—one on each reachable model—executed the tool successfully and then ended with `stop_reason: "cancelled"`; the no-tool run ended with `end_turn`. Hive agents depend on MCP for delivery, landing, and Graphify. The adapter is not shippable until the exact interactive launch path Hive will use completes an MCP-using turn with `stop_reason == "end_turn"`. A dedicated acceptance test for that fact is a prerequisite, not a telemetry follow-up.

The existing Hive integration map is the structural baseline. The foundation refactor has already made several two-vendor decisions exhaustive through `unknownVendor` and `forEachProvider`; implementers complete that conversion rather than reintroducing binary branches. The highest-risk integration sites are `src/adapters/tools/models.ts:81`, `src/cli/daemon.ts:122`, `src/daemon/recovery.ts:336`, `src/daemon/spawner-impl.ts:943`, `src/daemon/server.ts:1033`, `src/daemon/tool-telemetry.ts:237`, `src/daemon/usage-credits.ts:552`, `src/daemon/model-inventory.ts:130`, `src/daemon/quota.ts:1404`, `src/daemon/routing-resolve.ts:92`, and `workspace/Sources/HiveWorkspace/LaunchConfig.swift:55`.

## 2. The adapter boundary comes before the enum

The implementation begins by replacing every two-way vendor choice with an exhaustive dispatch. The dispatch accepts the canonical provider union and returns a vendor adapter; a default branch is forbidden. An `assertNever`-style terminal branch may throw, but `else`, `provider !== "claude"`, and fallback-to-Claude behavior may not choose a vendor implementation. Closed provider lists must be derived from the canonical registry or explicitly contain all three values with a test that fails when the union grows.

The adapter is one typed record with these required operations:

1. discover the installed CLI version and model catalog;
2. build initial interactive argv and environment;
3. write worktree-local vendor configuration;
4. build resume argv for an exact durable session id;
5. resolve a session artifact from a worktree when no id was captured;
6. translate Hive autonomy into vendor permission flags;
7. attach Hive and Graphify MCP servers with the per-agent credential;
8. deliver ordinary input, cancel urgent input, and prove the next turn boundary;
9. read live activity, context, model, turn completion, and Graphify calls;
10. read the billing/reset surface and classify vendor exhaustion;
11. install and remove the vendor-native skill; and
12. clean up only the worktree-local files Hive created.

Claude and Codex must implement the same interface before the Grok adapter is admitted to the registry. This costs a focused refactor up front, but it makes an omitted lifecycle operation a type error instead of an accidental Codex call. The rejected alternative is adding Grok branches directly at every current call site; that would duplicate the implicit contract and preserve the exact silent-fallthrough failure this work is meant to remove.

The parallel implementations that establish the current contract are `src/adapters/tools/claude.ts:22`, `src/adapters/tools/claude.ts:245`, `src/adapters/tools/claude.ts:296`, `src/adapters/tools/claude.ts:434`, `src/adapters/tools/codex.ts:17`, `src/adapters/tools/codex.ts:77`, `src/adapters/tools/codex.ts:209`, `src/adapters/tools/codex.ts:213`, and `src/adapters/tools/codex.ts:329`. Runtime consumers to move behind the adapter are `src/daemon/spawner-impl.ts:1067`, `src/daemon/spawner-impl.ts:1880`, `src/daemon/recovery.ts:336`, `src/daemon/server.ts:1033`, and `src/daemon/delivery.ts:210`.

## 3. Canonical types, schemas, and persistence

After exhaustive dispatch exists, widen the canonical provider to `"claude" | "codex" | "grok"`. Add Grok-specific capability surfaces for the exact sources Hive reads: `grok.models` for stdout/default discovery, `grok.models_cache` for structured per-model facts, `grok._x.ai/billing`, `grok.updates.jsonl`, and, if the live ACP telemetry path is implemented, `grok._x.ai/session/info`. Do not invent a surface for an unmeasured endpoint or merge the command and cache provenance.

Add a Grok execution identity rather than reusing the Codex member:

```ts
{
  tool: "grok";
  model: string;
  effort?: string;
  cliVersion: string;
  cliBuildHash: string;
}
```

`effort` is absent for a model whose live catalog says reasoning effort is unsupported. It is never filled with `medium`. The CLI version and build hash are part of the identity because resume and artifact parsing depend on an undocumented, rapidly changing binary. Persisting them lets recovery decide whether it is parsing the same wire contract that created the session.

Add `GrokRouteSchema` with `model` and optional `effort`, then carry `grok` without coercion through spawn requests, route pins, floors, derivation cells and snapshots, quota scopes and records, agent rows, skill tool values, CLI arguments, and Workspace launch state. Existing SQLite provider/tool columns are open `TEXT`, so no migration is needed merely to store the string. Zod read boundaries are the effective enum and must round-trip an old Claude/Codex row and a new Grok row.

The main schema and persistence sites are `src/schemas/capability.ts:30`, `src/schemas/capability.ts:72`, `src/schemas/agent.ts:29`, `src/schemas/agent.ts:60`, `src/schemas/routing.ts:35`, `src/schemas/routing.ts:51`, `src/daemon/spawner.ts:8`, `src/schemas/routing-derivation.ts:120`, `src/schemas/routing-derivation.ts:352`, `src/schemas/routing-derivation.ts:1005`, `src/schemas/quota.ts:33`, `src/schemas/quota.ts:151`, `src/schemas/quota.ts:213`, `src/daemon/quota-ledger.ts:230`, `src/daemon/quota-ledger.ts:283`, `src/daemon/db.ts:207`, `src/daemon/db.ts:695`, `src/adapters/skills.ts:15`, and `src/cli/orchestrator.ts:23`.

## 4. Launch, configuration, permissions, and MCP

The Grok adapter launches the interactive CLI in the shared tmux/worktree pipeline. It consumes the existing Hive prompt file; it does not put the brief itself in a shell command. The initial command builder uses Grok's measured `--prompt-file <path>`, `--cwd <worktree>`, `-m <catalog model id>`, permission flags, and `--rules <Hive operating contract>`. It passes `--reasoning-effort <catalog value>` only when the selected model's live catalog advertises that value. The implementation must run an interactive launch fixture proving that this argv both starts a resumable session and consumes the prompt file; the report measured each flag but did not establish the complete Hive tmux composition as one end-to-end launch.

The builder never expresses an operation as a bare positional token or an assumed subcommand. Grok treats a bare unknown word as a prompt, may make it billable under a TTY, and can still exit zero. Readiness and command discovery therefore require the expected artifact/protocol effect, not process exit alone.

Model and effort always travel on argv. A project `.grok/config.toml` silently ignores `[models]`; a test with a conflicting project default must prove the launched model still equals the `-m` value. User-global `~/.grok/config.toml` is never edited.

For every initial launch and resume, set all ten compatibility variables to the string `false`:

```text
GROK_CLAUDE_SKILLS_ENABLED
GROK_CLAUDE_RULES_ENABLED
GROK_CLAUDE_AGENTS_ENABLED
GROK_CLAUDE_MCPS_ENABLED
GROK_CLAUDE_HOOKS_ENABLED
GROK_CURSOR_SKILLS_ENABLED
GROK_CURSOR_RULES_ENABLED
GROK_CURSOR_AGENTS_ENABLED
GROK_CURSOR_MCPS_ENABLED
GROK_CURSOR_HOOKS_ENABLED
```

Hive writes its own servers into `<worktree>/.grok/config.toml` under `[mcp_servers]`. The file contains the Hive and Graphify endpoints and the per-agent authorization material in the Grok-native transport fields. It must preserve unrelated user-owned project config keys if the file already exists, and cleanup must remove only Hive-owned entries. The positive control is `grok mcp list` or `grok inspect` run in the worktree: both servers must be reported as coming from project config with compatibility MCPs disabled. `.mcp.json` inheritance is forbidden because its loading depends on a user-level Claude import marker; a dismissed prompt otherwise removes every Hive tool without an error.

Translate Hive's reader/writer and autonomy policy to explicit `--permission-mode`, `--allow`, and `--deny` arguments on both initial and resumed commands. Do not treat Grok's default sandbox as enforcement: it defaults off, and child-process network blocking is a documented no-op on macOS. The per-agent Hive capability remains the authoritative server-side gate.

There is a known authorization gap. The ten compatibility switches do not stop Grok from ingesting the repository's `CLAUDE.md` or `.claude/settings.local.json` permissions, and no switch that does so was found. Hive will not hide, rename, or delete repository files to work around it. Explicit permission flags mitigate the inherited permission rules, and the Hive capability gate still prevents an unauthorized landing, but Grok may interpret repository instructions or permissions Hive did not intend to grant. That residual risk remains unresolved and must be shown in Grok readiness/status output until a measured disable mechanism exists.

The shared launch and authorization pipeline is at `src/daemon/launch-prompt.ts:25`, `src/daemon/spawner-impl.ts:431`, `src/daemon/spawner-impl.ts:497`, `src/daemon/spawner-impl.ts:659`, `src/daemon/spawner-impl.ts:1766`, `src/daemon/spawner-impl.ts:2008`, `src/daemon/capabilities.ts:19`, and `src/daemon/capabilities.ts:87`. The existing config/MCP translations to replace with the adapter operation are at `src/adapters/tools/claude.ts:458`, `src/adapters/tools/claude.ts:563`, `src/adapters/tools/codex.ts:94`, `src/adapters/tools/codex.ts:102`, and `src/adapters/tools/codex.ts:171`.

## 5. Session identity, resume, recovery, and delivery

Grok sessions live under `GROK_HOME` or `~/.grok/sessions/<encoded-cwd>/<session-id>/`; session ids are UUIDv7. The artifact resolver must support both the URL-encoded cwd directory and the measured long-path slug-plus-hash directory whose `.cwd` file records the real cwd. It selects a session only when `summary.json.info.cwd` equals the worktree and returns `summary.json.info.id`; newest-file guessing without the cwd positive control is forbidden.

Capture the live session id continuously from Grok updates and store it in the existing agent session field. Recovery first uses that stored id, then the cwd-verified disk resolver. Resume uses `grok --resume <session-id>` with the same explicit model/effort, permission, rules, compatibility environment, cwd, and MCP configuration as the original identity. `--session-id` creates a new session and must never be used as resume. Recovery does not silently choose “most recent” by omitting the id.

Initial spawn, control restart, crash recovery, and manual recovery all call the same adapter builders. After resume, Hive uses the ordinary proof-of-life watch and requires an advancing Grok artifact, event timestamp, or verified screen redraw. A successful process spawn is not a successful recovery. Grok needs no separate host reaper unless implementation introduces `grok agent serve`, a leader, or another long-lived process; the specified tmux CLI path does not introduce one.

Durable delivery continues to use Hive's shared message state machine. A Grok turn boundary is proven only by an `updates.jsonl` record with `method == "_x.ai/session/update"`, `params.update.sessionUpdate == "turn_completed"`, and a `prompt_id` correlated to the active prompt. A successful turn additionally requires `params.update.stop_reason == "end_turn"`. A boundary with `stop_reason == "cancelled"` proves only that the turn ended; it must never acknowledge the prompt as successfully completed. The similar plain `session/update` method is not the turn boundary. Turn start has no record of its own; it is `_meta.turnStartMs` on update chunks.

The discovery reports did not measure a Grok native input RPC, nor a complete tmux cancel/paste sequence. Therefore the primary ordinary-delivery actuator and urgent cancel keystrokes are `UNKNOWN` until a fixture proves them. The implementation may use tmux only after a test shows: the message entered the intended session, urgent input ended the old prompt with a correlated cancelled boundary, a new prompt started, and that new prompt reached a correlated `turn_completed` with `stop_reason == "end_turn"`. A zero exit from `tmux send-keys` is never acknowledgement, and a cancelled boundary is never successful delivery. Critical delivery revokes the current capability first, terminates the Grok process through the shared control path, and resumes the exact session with a newly issued credential; it must not replay a Codex argv.

The lifecycle sites are `src/daemon/recovery.ts:46`, `src/daemon/recovery.ts:142`, `src/daemon/recovery.ts:336`, `src/daemon/recovery.ts:380`, `src/daemon/recovery.ts:411`, `src/daemon/spawner-impl.ts:1067`, `src/daemon/spawner-impl.ts:1168`, `src/daemon/delivery.ts:210`, `src/daemon/delivery.ts:236`, `src/daemon/delivery.ts:341`, `src/daemon/delivery.ts:629`, `src/daemon/delivery.ts:718`, and `src/adapters/tmux.ts:151`.

## 6. Parsers bind to artifacts, not concepts

Grok has three measured spellings for similar facts. They must have three separate parsers with separate fixture directories:

1. the headless JSON parser reads `stopReason: "EndTurn"`, `sessionId`, `requestId`, and checks `type == "error"` before reading text;
2. the `updates.jsonl` parser reads `stop_reason: "end_turn"`, `prompt_id`, underscore-prefixed extension methods, and nested `params.update` / `params._meta` fields; and
3. the `_x.ai/billing` wire parser reads top-level `subscription_tier`, while a log-only parser, if one is ever needed, would read `subscriptionTier` from `unified.jsonl`.

Parser helpers may share generic JSONL iteration and byte cursors, but not schemas, field aliases, normalization maps, or fallback key lists. In particular, no parser accepts both `stopReason` and `stop_reason`, and the billing reader never reads `unified.jsonl`. Accepting alternate spellings would turn schema drift into a plausible stale value.

`signals.json` has its own successful-turn parser for `contextTokensUsed`, `contextWindowTokens`, `contextWindowUsage`, `primaryModelId`, `modelsUsed`, `toolCallCount`, and `toolsUsed`. The nonexistent strings `tokens_used` and `context_window` are forbidden. That parser is a convenience and positive cross-check only: measured cancelled and in-flight turns write no `signals.json`; it is written only for `stop_reason == "end_turn"`. Absence is therefore `UNKNOWN`, never zero and never “no tools used.”

All parse results carry `{ cliVersion, cliBuildHash, artifactKind, schemaState }`, where `schemaState` is `recognized | drifted | absent`. `drifted` and `absent` are distinct because a file that does not yet exist is not malformed. Consumers may render a measured zero only from `recognized` data.

The common telemetry output and current artifact-specific parsers are at `src/daemon/tool-telemetry.ts:17`, `src/daemon/tool-telemetry.ts:100`, `src/daemon/tool-telemetry.ts:179`, `src/daemon/tool-telemetry.ts:223`, `src/daemon/live-model.ts:24`, and `src/daemon/live-model.ts:95`. Runtime reader injection and dispatch are at `src/daemon/server.ts:422`, `src/daemon/server.ts:1033`, and `src/daemon/server.ts:1120`.

## 7. Version and schema drift are observable failures

Before model, billing, telemetry, or recovery artifact reads, execute `grok --version` and parse exactly:

```text
^grok (\S+) \(([0-9a-f]+)\) \[(\w+)\]$
```

The measured value is version `0.2.93`, build hash `f00f96316d4b`, channel `stable`. Hive records the installed version and build hash with every Grok capability, billing, quota-reset, and telemetry reading. It does not require the measured version forever; it requires schemas from a version to pass the assertions below before their values become trusted.

Each undocumented surface has a fixture-backed schema assertion tied to a verified CLI version and build hash. A different installed version or build hash is schema drift even when its JSON happens to parse; it remains `UNKNOWN` until a fixture from that exact build passes review and is added to the verified binding. Any version mismatch, assertion failure, unknown agent profile, new field that changes meaning, `-32601`, timeout, process failure, or unparsable output marks the affected reading `UNKNOWN` and emits one loud alert naming the version, build hash, surface, and rejected invariant. Hive never silently serves a remembered telemetry value. A remembered billing fact may follow the existing bounded billing-memory policy only before its own reset boundary; it may never supply capacity, and it expires at `currentPeriod.end` even if the generic memory TTL would be longer.

For `_x.ai/billing`, require a top-level object with `config` and string `subscription_tier`; a weekly `currentPeriod`; RFC3339 start/end with `end > start > now - 8 days`; equal billing-period and current-period boundaries; and money rails, when present, shaped as `{ val: finite nonnegative number }`. Missing rails are unknown, not zero. Any new key, especially `creditUsagePercent`, `monthlyLimit`, `includedUsed`, `totalUsed`, or `history`, is a wanted drift signal: alert and leave capacity unknown until discovery binds its semantics.

For session artifacts, assert the nested update discriminator and profile-specific tool-call shapes described in §8. If the installed binary writes a third shape, the parser reports that profile as unrecognized. A future model is not evidence that Graphify calls dropped to zero.

The installed-version analogue and schema/provenance types belong beside current CLI detection and discovered facts at `src/adapters/tools/claude.ts:100`, `src/schemas/capability.ts:72`, and `src/schemas/capability.ts:100`. Quota/billing failure and memory behavior live at `src/daemon/quota-sources.ts:93`, `src/daemon/usage-credits.ts:447`, `src/daemon/usage-credits.ts:496`, and `src/daemon/quota.ts:1526`.

## 8. Live telemetry and the Graphify counter

`updates.jsonl` is authoritative for live Grok telemetry because it is append-only and survives cancellation. The reader tails it with a byte offset plus the last accepted event id, tolerates a final partial JSON line, and advances the durable cursor only after a complete recognized record. File truncation or replacement resets the byte cursor and deduplicates by event id; it does not retain an offset into a different inode as if nothing changed.

Context occupancy comes from update chunks' `_meta.totalTokens` divided by the selected live model's catalog context window. A zero or missing denominator yields unknown. The reader may prefer live, free ACP `_x.ai/session/info` when a connected session exists, using `context.used`, `context.total`, and `context.usagePct`, but it cross-checks these against updates and never changes field spellings. `signals.json.contextWindowUsage` may validate a completed turn; it is not the live source.

The live model is `primaryModelId` / `modelsUsed[]` in completed-turn `signals.json`, `summary.json.current_model_id` for session recovery, and `_meta.modelId` on the relevant update record when present. The update stream wins for the turn it identifies; `modelsUsed[]` preserves evidence of mid-session changes. Hive never substitutes the launch model when live model is absent, because `AgentRecord.model` is intention and `liveModel` is observation.

The Grok Graphify-call counter parses `updates.jsonl` `tool_call` records with this measured matcher:

```ts
update.sessionUpdate === "tool_call" && (
  rawInput.server === "graphify" ||
  String(rawInput.tool_name ?? "").startsWith("graphify__") ||
  String(rawInput.toolName ?? "").startsWith("graphify__")
)
```

For the measured `cursor` profile, the generic wrapper is tool name `CallMcpTool`, namespace `cursor`; server and tool are discrete in `rawInput.server` and `rawInput.toolName`. For the measured `grok-build-plan` profile, the generic wrapper is tool name `use_tool`, namespace `grok_build`; the fused MCP id is in snake-case `rawInput.tool_name`, for example `graphify__graph_stats`, with arguments in `rawInput.tool_input`. In both profiles `graphify` appears in neither the wrapper tool name nor namespace, so matching either wrapper identity would return zero on both models. The camel-case fused arm is defensive schema tolerance; the two positive measured arms are `rawInput.server` for `cursor` and `rawInput.tool_name` for `grok-build-plan`.

The counter counts each unique `toolCallId` once. It also counts tool-call records whose wrapper/profile shape it cannot classify. A recognized `cursor` `CallMcpTool` with a string `rawInput.server` and a recognized `grok_build` `use_tool` with a string `rawInput.tool_name` are classifiable even when they target a different server; a missing required discriminator, an unknown wrapper/profile combination, or a new agent profile is unclassified. Hive alerts whenever `graphifyCount == 0 && unclassifiedWrapperCount > 0`. It returns known zero only when every tool-call record was classifiable and none matched Graphify. It must not count tool results, retries with the same id, aggregate `signals.json.toolCallCount`, or the substring `graphify` in arguments.

The counter returns a tagged result, not a bare number: `known(count)` only if the session's `summary.json.agent_name` is a recognized profile and every observed `tool_call` record matches a known record schema; `unknown("unrecognized-profile-or-tool-shape")` otherwise. The guard is profile-dependent, not model-dependent: a model change or rename of `grok-build-plan` can introduce a fourth shape even if the model id looks familiar. This positive control prevents that shape from silently looking like “Grok never uses the graph.”

Graphify MCP attachment is deterministic through `.grok/config.toml`. Grok does expose `PreToolUse`, but the discovery reports did not measure its matcher and response JSON as an end-to-end Hive hook. Do not install the existing Claude/Codex hook response under `.grok` until a deny/allow fixture proves Grok accepts it. MCP access and call telemetry may ship before pre-tool interception, but status must label hook interception unavailable rather than imply parity.

The existing cursor/counting seams are `src/daemon/tool-telemetry.ts:213`, `src/daemon/tool-telemetry.ts:223`, `src/daemon/tool-telemetry.ts:237`, `src/daemon/tool-telemetry.ts:275`, and `src/daemon/tool-telemetry.ts:301`. Graphify hook paths and response generation are at `src/adapters/tools/graphify-hook.ts:6`, `src/adapters/tools/graphify-hook.ts:16`, `src/adapters/tools/graphify-hook.ts:24`, and `src/adapters/tools/graphify-hook.ts:47`; current vendor registration is at `src/adapters/tools/claude.ts:522` and `src/adapters/tools/codex.ts:171`.

## 9. Model discovery and routing

Run `grok models` for every model-catalog refresh. It is free and session-free, and it refreshes `~/.grok/models_cache.json`. Parse the effective default and require at least one model from command stdout as a positive control, then parse the structured cache for each model's `id`, `context_window`, `hidden`, `reasoning_efforts`, and `supports_reasoning_effort`. Require the cache `fetched_at` to postdate the command invocation and record its `etag` and `grok_version`; otherwise the read is stale even if an older cache parses. Never hardcode `grok-4.5`, `grok-composer-2.5-fast`, or any future model name into Hive product code, routing defaults, tests outside fixtures, or docs shown as current truth.

The measured subscription proxy exposed two entries: `grok-4.5`, 500,000 tokens, efforts `low | medium | high`; and `grok-composer-2.5-fast`, 200,000 tokens, no effort. Those values seed fixtures and acceptance expectations for the measured version only. `xhigh` and `max` validity for `grok-4.5` is `UNKNOWN`; Hive trusts the per-model list and rejects an effort absent from that list. A no-effort model is launched without `--reasoning-effort`.

Model catalog membership establishes launchability, not routing quality. Grok participates in the same capability-floor, livebench, pin, and routing-derivation system as the other vendors. The implementation adds Grok candidates from the live catalog and benchmark facts; it does not infer coding ability, tier, or pool membership from a `grok-` prefix. An explicit user model pin remains verbatim and is validated against the live catalog unless the existing explicit-pin semantics intentionally permit a launch attempt with a loud warning.

Review routing can no longer mean “the other vendor.” Replace the binary inversion with a ranked candidate set excluding the reviewed provider, then apply the ordinary capability, health, money, and capacity rules. If more than one capable alternate remains, use the normal derived ranking; if none remains, fail with the excluded provider and reasons. Do not give Grok a privileged or disadvantaged review position merely because it was added third.

The model and routing sites are `src/adapters/tools/models.ts:18`, `src/adapters/tools/models.ts:81`, `src/daemon/model-inventory.ts:43`, `src/daemon/model-inventory.ts:80`, `src/daemon/model-inventory.ts:130`, `src/daemon/model-inventory.ts:283`, `src/daemon/livebench.ts:365`, `src/daemon/routing-resolve.ts:92`, `src/daemon/routing-resolve.ts:143`, `src/schemas/routing-derivation.ts:730`, and `src/daemon/quota.ts:1404`.

## 10. Quota, billing, exhaustion, and reset recovery

Grok's SuperGrok weekly capacity is unmeasurable. `_x.ai/billing` is the only reachable noninteractive billing surface, and it reports the pay-as-you-go rails rather than subscription usage. A completed turn did not change `onDemandUsed.val`, and the payload contains no allowance, consumption, remaining value, percent, or per-model meter. Hive must never render `onDemandCap.val`, `onDemandUsed.val`, or `prepaidBalance.val` as remaining quota, and it must never invent a 100-percent allowance around them.

The probe runs `grok agent stdio`, performs ACP initialize, and calls `_x.ai/billing` with `{}`. The bare `x.ai/billing` name is wrong and returns `-32601`. From a recognized wire response Hive takes exactly two subscription facts: display-only `subscription_tier`, and the weekly reset boundary `config.currentPeriod.end`. The window is rolling and anchored to the subscription activation instant; it is not a calendar-week calculation. The tier string does not gate routing because another xAI endpoint was measured using different tier vocabulary for the same account.

Represent the Grok subscription pool as a routable account-wide pool bound to the current Grok catalog, with weekly `allowance`, `used`, `remaining`, and `remainingPct` all `null`, confidence `missing`, source `provider`, and `resetsAt` set to the recognized `currentPeriod.end`. Do not force it through the current “discovered percent pool means allowance 100” invariant. The quota types/persistence need a reset-only observation that stores a known boundary independently of a usage observation; a placeholder numeric `fiveHourUsed` or `weeklyUsed` is forbidden. No five-hour Grok window was measured, so the five-hour status is entirely unknown.

Capacity and billing are separate decisions:

- Capacity is unknown, so Grok remains auto-routable in compatibility mode with an explicitly unbounded estimated reservation and warning.
- Billing is known safe only while the recognized money rails show `onDemandCap.val == 0`, `onDemandUsed.val == 0`, and `prepaidBalance.val == 0`. In that state the router records paid overflow as off: exhaustion blocks instead of billing, so Grok requires no cost-consent prompt.
- Any positive `onDemandCap` or `onDemandUsed`, any change in `prepaidBalance`, or any absent/malformed rail is a loud money-state change. The current reading becomes unknown or would-spend as appropriate; automatic routing follows the existing spend guard and may require consent. The unit of `val` is `UNKNOWN`, so Hive displays the raw change without a currency label.

Because no remaining-capacity number exists, exhaustion is learned from a vendor refusal. The exact structured Grok exhaustion discriminator is `UNKNOWN`: neither report captured a real exhausted request, and binary strings such as `credit_limit_hit` or `rate_limit_error` are leads, not wire evidence. Implementation must not key on those strings or free-form error text. Define a typed `GrokExhaustionEvidence` parser and a named unresolved fixture `GROK_EXHAUSTION_BLOCK_RECORD`; until a real blocked-turn artifact fills it, an error is a generic launch/turn failure and must not quarantine the whole weekly pool as exhausted.

Once that fixture is measured, recognition is exact: only the fixture-bound structured code/status at the documented artifact location, correlated to the session and active prompt, produces `blocked-by-capacity`. Exit status, a missing `turn_completed`, HTTP status alone, or a message containing “limit” does not. On recognition Hive:

1. logs the structured refusal verbatim, re-reads `_x.ai/billing`, and marks the Grok account pool exhausted through that fresh `currentPeriod.end`;
2. releases or reconciles the failed reservation without recording fabricated provider usage;
3. marks the attempted route as capacity-blocked, not launch-broken;
4. retries the next eligible non-Grok route under ordinary routing rules;
5. tells the orchestrator/user that capacity is unknown, the vendor blocked this prompt, paid overflow is off, and the retry time is the measured reset;
6. refuses automatic Grok selections until that boundary, while preserving an explicit user pin as an explicit attempt with the same warning; and
7. at the reset boundary, clears the exhaustion state, refreshes `_x.ai/billing`, and admits one probe launch. A successful completed turn clears the block; another recognized exhaustion re-arms it to the newly read boundary.

The capacity block is manually clearable through the existing quota-reconciliation class of operator action, because a false-positive classifier must not park a vendor for seven days with no escape. Manual clear returns the pool to eligible with level missing; it does not mark the pool full.

If billing drift removes the reset boundary, the block has no invented expiry. It stays an unknown-capacity block and asks for operator action rather than calculating next Sunday. A last good boundary may be used only if it is still in the future and belongs to the current recognized window; never after `currentPeriod.end`.

Grok is also the pressure valve when Claude and Codex report measured pressure: after capability floors, pins, money safety, and route health are applied, quota tie-breaking prefers eligible Grok for bounded work rather than spending a measurable pool to protect an invisible one. The chosen error direction is explicit: an unseen Grok limit costs one visible, free blocked attempt and same-turn re-derivation while zero on-demand cap prevents billing. Pressure never overrides a capability floor, does not pretend Grok has headroom, and does not downshift between Grok models because both share the same account-wide pool. Long-running deep work remains less attractive than bounded work because mid-task exhaustion strands a turn before cross-vendor handoff.

Quota and billing code affected is `src/schemas/quota.ts:4`, `src/schemas/quota.ts:151`, `src/schemas/quota.ts:213`, `src/schemas/quota.ts:227`, `src/daemon/quota-sources.ts:41`, `src/daemon/quota-sources.ts:47`, `src/daemon/quota-ledger.ts:54`, `src/daemon/quota-ledger.ts:283`, `src/daemon/quota.ts:291`, `src/daemon/quota.ts:417`, `src/daemon/quota.ts:512`, `src/daemon/quota.ts:1390`, `src/daemon/quota.ts:1526`, `src/daemon/usage-credits.ts:92`, `src/daemon/usage-credits.ts:283`, `src/daemon/usage-credits.ts:397`, `src/daemon/usage-credits.ts:496`, and `src/schemas/routing-derivation.ts:751`.

## 11. Skills, CLI, Workspace, capability continuity, and cleanup

Ship a Grok-native Hive skill in the directory Grok actually scans at project scope, and provision it per worktree. The skill teaches the same Hive protocol and landing gate without claiming that skill ingestion enforces authorization. Init installs it only when the Grok CLI is present; spawn provisions it for a selected Grok agent; uninstall and project cleanup remove only Hive's copy and Hive-owned `.grok/config.toml` entries. A manifest-only test is insufficient: a positive `grok inspect` fixture must show the skill loaded from the intended worktree.

Add Grok to public provider validation, explicit `hive grok` or equivalent launch selection where the current product exposes vendor roots, routing display/refresh, quota refresh, status labels, Workspace launch serialization/parsing, icons, filters, and agent feed tests. An unknown fourth string must be rejected, not ignored. Generic status/feed code may remain generic when a Grok fixture proves it already preserves the string.

The existing capability token is vendor-neutral. Put the per-agent token only in Grok's Hive MCP configuration/environment, never in user-global config or the prompt. Initial launch, resume, and critical restart must all send the currently issued token. Reader Grok agents remain unable to land even if repository instructions tell them to; writers can land only their branch and current capability epoch. Vendor permissions provide defense in depth but do not replace the daemon check.

The product surfaces are `src/adapters/skills.ts:15`, `src/adapters/skills.ts:134`, `src/adapters/skills.ts:200`, `src/skills/shipped.ts:25`, `src/skills/shipped.ts:48`, `src/cli/init.ts:64`, `src/cli/init.ts:345`, `src/cli/uninstall.ts:168`, `src/cli/uninstall.ts:190`, `src/cli/project-config-cleanup.ts:161`, `src/cli.ts:304`, `src/cli.ts:344`, `src/cli/routing.ts:142`, `src/cli/routing.ts:257`, `src/cli/status.ts:14`, `workspace/Sources/HiveWorkspace/LaunchConfig.swift:16`, `workspace/Sources/HiveWorkspace/LaunchConfig.swift:55`, and `workspace/Sources/WorkspaceCore/AgentFeed.swift:8`. Capability enforcement is at `src/daemon/capabilities.ts:87` and `src/daemon/capabilities.ts:125`.

## 12. Verification contract

Every track supplies recorded fixtures with positive and negative controls. Unit tests may redact ids and credentials, but they preserve exact key spelling and nesting. No test constructs an idealized payload from the TypeScript type it is testing.

Adapter tests prove initial argv, no-effort argv, invalid-effort refusal, resume argv, all ten compatibility flags, project MCP config, existing-config preservation, capability injection, long-path session resolution, and user-global config non-mutation. Lifecycle tests prove initial spawn, control restart, crash recovery, manual recovery, reader/writer rights, and exact session continuity.

Parser tests use separate headless, updates, signals, summary, and billing fixtures. They prove `EndTurn` does not parse as the update-stream `end_turn`, `subscriptionTier` does not parse on the wire, `tokens_used` does not supply context, missing signals is unknown, a final partial JSONL line does not advance the cursor, and a version/schema change becomes a loud unknown.

Routing tests prove live catalog discovery, context windows, supported/unsupported effort, no hardcoded fallback model, three-vendor review selection, unknown capacity routing, money-safe routing at zero cap, consent behavior after a positive/unknown money rail, recognized exhaustion fallback, reset-bound retry, and no calendar-week calculation.

The first end-to-end gate uses the exact interactive launch argv Hive will ship, invokes at least one Hive MCP tool and one Graphify MCP tool, observes successful tool results, and then requires the correlated turn boundary to carry `stop_reason == "end_turn"` on both reachable models. The two measured headless MCP runs ended `cancelled`, so success on a no-tool prompt or successful tool output is insufficient. Failure of this test blocks the entire adapter because an agent that cannot finish an MCP-using turn cannot reliably send, land, or use the graph.

After that gate, end-to-end acceptance requires both a reader and writer Grok agent to spawn, receive ordinary delivery, survive urgent preemption, report live context/model during a turn, make and count a Graphify call, resume the same session after process loss, participate in model-aware routing with unknown capacity, and—only for the writer—land. The pre-tool Graphify hook and exact exhaustion classifier remain release blockers for claims of full parity until their named `UNKNOWN` fixtures are measured; product status must name any intentionally unavailable sub-capability.

The main test homes are `src/adapters/tools/claude.test.ts:65`, `src/adapters/tools/codex.test.ts:140`, `src/daemon/tool-telemetry.test.ts:33`, `src/daemon/tool-telemetry.test.ts:199`, `src/daemon/recovery.test.ts:356`, `src/daemon/delivery.test.ts:171`, `src/daemon/channel-delivery.test.ts:78`, `src/daemon/quota-discovery.test.ts:181`, `src/daemon/quota-discovery.test.ts:1251`, `src/daemon/capability-discovery.test.ts:177`, `src/schemas/routing-derivation.test.ts:132`, `src/daemon/routing-resolve.test.ts:120`, `src/cli/spawner-impl.test.ts:1064`, `src/cli/spawner-impl.test.ts:3990`, `src/skills/shipped.test.ts:29`, `src/cli/init.test.ts:227`, `src/daemon/model-inventory.test.ts:90`, `src/cli/workspace.test.ts:138`, and `workspace/Tests/WorkspaceCoreTests/ProjectStateTests.swift:94`.

## 13. Every way Grok can silently half-work

This is the regression checklist. Each row names a feature that can compile, run, and return a plausible wrong or null answer instead of throwing.

| Silent half-work | Required test |
|---|---|
| Grok takes a Codex/Claude `else` branch. | Add an unknown fourth provider to each dispatcher test and require a throw; run Grok fixtures through every operation and spy that only the Grok adapter ran. |
| Capability discovery sends Grok to the Codex probe. | Request Grok discovery and assert only `grok models`/Grok surfaces run; a Codex-shaped positive fixture must be rejected as the wrong provider. |
| Normal spawn writes Codex config or builds Codex argv. | Spy on config writers and command builders for all three providers; the Grok case must call only the Grok operations and contain no Codex config flags. |
| Control restart or crash recovery resolves a Codex rollout. | Give Grok and Codex artifacts for the same cwd; Grok recovery must select the cwd-verified Grok UUIDv7 session and Grok resume argv. |
| Recovery rewrites Claude/Codex config or guesses effort. | Resume both Grok catalog fixtures; assert Grok project MCP/permissions are rebuilt and the no-effort model still omits effort. |
| Runtime telemetry dispatch reads a Codex rollout for Grok. | Put conflicting positive values in Grok and Codex artifacts; assert context, live model, turn result, and cursor come only from Grok updates. |
| Graphify artifact lookup/counting silently uses the Codex parser. | Put one Grok wrapper call and zero Codex calls in parallel fixtures; assert Grok count is one and its cursor identifies the Grok updates file. |
| Grok billing silently queries Claude because it is “not Codex.” | Make the Claude transport return a plausible positive bill and Grok return the measured wire; assert only `_x.ai/billing` is called and the Claude value cannot enter Grok state. |
| Model inventory silently uses the Codex capability probe. | Return disjoint catalogs from `grok models` and Codex `model/list`; assert only Grok ids become Grok inventory rows. |
| A missing resolved tool silently defaults to Claude. | Remove the tool from a derived route and require a loud invariant failure; no Claude candidate may be synthesized. |
| Workspace receives `grok` but ignores it as an unknown launch string. | Round-trip a Grok launch through Swift parsing/serialization and assert the selected provider changes; an unknown fourth string must error. |
| Grok disappears from a closed benchmark/model/quota refresh list. | Table-drive the canonical registry and require exactly one livebench, model refresh, and quota refresh attempt per provider. |
| A schema accepts Grok but a persisted row is coerced or rejected on read. | Round-trip one Grok agent, route snapshot, quota pool, reservation, catalog entry, and route-health row through SQLite and Zod. |
| Grok identity receives guessed `medium` effort. | Select the no-effort composer fixture and assert argv and persisted identity omit effort. |
| Project `[models]` appears configured but is ignored. | Put a conflicting default in `.grok/config.toml`; assert explicit `-m` wins and observed live model matches it. |
| `xhigh`/`max` is accepted from a generic effort list. | Catalog fixture advertises only low/medium/high; assert every other value is rejected before spawn. |
| `.mcp.json` happens to load on one machine, hiding missing deterministic MCP config. | Set the import marker/dismissed state, disable all compat MCPs, and prove Hive/Graphify still load from project `.grok/config.toml`. |
| Hive overwrites a user's `.grok/config.toml`. | Seed unrelated project keys, provision and clean up, and assert byte-equivalent preservation outside Hive-owned server entries. |
| Compat flags are assumed to disable repository Claude instructions/permissions. | `grok inspect` fixture with all ten false must still expose the measured residual; readiness reports the authorization gap and argv contains explicit permission flags. |
| Resume creates or chooses the wrong session. | Create two cwd sessions plus a long-path `.cwd` session; assert exact stored-id resume and cwd-verified fallback, never bare `--resume` or `--session-id`. |
| An MCP tool succeeds but the Grok turn cancels afterward. | On Hive's exact interactive launch path, invoke Hive and Graphify MCP tools on both reachable models; require successful results followed by correlated `turn_completed` with `stop_reason: end_turn`. Any `cancelled` result blocks the adapter. |
| A successful tmux write is treated as delivery. | Make the actuator return success without an update; delivery remains sent/unacknowledged until a correlated successful `turn_completed`. |
| A cancelled `turn_completed` is treated as success. | Feed correlated boundaries with `cancelled` and `end_turn`; both end the turn, but only `end_turn` acknowledges successful completion. |
| Plain `session/update` is mistaken for the turn boundary. | Feed identical completion payloads under plain and underscore methods; only `_x.ai/session/update` completes the turn. |
| Headless and updates parsers share stop-reason aliases. | Swap `EndTurn` and `end_turn` fixtures; each artifact parser rejects the other's spelling. |
| Billing parser binds to `unified.jsonl` camelCase. | Feed wire `subscription_tier` and log `subscriptionTier` separately; the wire reader accepts only the former. |
| Context parser uses nonexistent `tokens_used/context_window`. | Feed only those guessed keys and assert unknown; feed real update `_meta.totalTokens` plus catalog window and assert a positive percentage. |
| `signals.json` absence becomes zero context or zero calls on an in-flight/cancelled turn. | Cancel a fixture after update chunks with no signals file; live context remains measured from updates and calls remain known/unknown from updates, never reset to zero. |
| Graphify counter looks for a fused name on the `cursor` profile. | Feed `title: CallMcpTool` with `rawInput.server: graphify`; assert one call although `graphify` appears in no tool name or namespace. |
| Graphify counter keys on `signals.json.toolsUsed[]`. | Feed a cancelled turn with a Graphify update and no signals file; assert the call is counted. |
| Grok-4.5 counter looks at wrapper name/namespace instead of fused raw input. | Feed `name: use_tool`, namespace `grok_build`, and `rawInput.tool_name: graphify__graph_stats`; assert one call although neither wrapper field contains `graphify`. |
| A wrapper is unclassified but Graphify renders as known zero. | Feed a new wrapper/profile with a tool call; assert `unclassifiedWrapperCount > 0`, tagged unknown, and an alert when Graphify count is zero. |
| A future third agent profile silently reads zero Graphify calls. | Feed a valid `tool_call` with an unknown `summary.json.agent_name`/shape; assert `unknown("unrecognized-profile-or-tool-shape")` and an alert. |
| Graphify result/retry double-counts. | Feed call, result, and duplicate id; assert one unique call. |
| `signals.json` completed-turn aggregates are treated as live truth. | Feed updates that advance after an older signals file; assert context/model/calls follow updates and signals is only a cross-check. |
| A new CLI build is trusted because old JSON still parses. | Replay a byte-identical payload under an unverified build hash, then add a new billing key or mutate an update invariant; every case stays unknown until the exact build fixture is verified, and the alert names version/surface. |
| Billing zeros render as weekly remaining quota. | Feed the measured all-zero money rails; assert quota allowance/used/remaining remain null while tier/reset render separately. |
| Rolling reset is rounded to a calendar week. | Use a Sunday subscription instant with microseconds; assert the exact `currentPeriod.end` survives and no weekday calculation runs. |
| Unknown capacity blocks routing despite no money risk. | Feed zero cap plus no utilization; assert Grok routes in compatibility mode with a warning/unbounded estimate. |
| Zero cap is treated as unknown billing and prompts for cost consent. | Feed the recognized zero rails; assert `no-spend` and no approval request. |
| A positive or missing money rail is treated as free. | Feed positive cap/used and then an absent cap; assert loud money-state change and consent/unknown behavior, never no-spend. |
| Generic “rate limit” text poisons Grok until reset. | Feed an unstructured error message; assert generic failure and no capacity block. Only the future `GROK_EXHAUSTION_BLOCK_RECORD` may arm it. |
| A real exhaustion block is recorded as launch-broken. | Feed the measured structured block fixture; assert capacity-blocked state, alternate routing, and no launch-health quarantine. |
| Exhaustion block expires at an invented Sunday. | Arm with an irregular rolling boundary; assert no Grok auto-route before the exact instant and one probe afterward. |
| Stale billing memory crosses its reset. | Advance past `currentPeriod.end` with the live probe down; assert tier/money/reset become unknown and no stale capacity or boundary is served. |
| Static model names outlive the provider catalog. | Remove a fixture model and add a new one; refresh candidates and UI from `grok models`, with no old name retained as fallback. |
| Binary review inversion always selects Claude for Grok. | Review each of three providers with different capability/health facts; assert selection excludes the reviewed tool then uses normal ranking. |
| Grok disappears from a closed refresh/init/uninstall/UI list. | Table-drive all canonical providers through model/quota refresh, skill init/provision/uninstall, CLI parsing, Workspace serialization, filters, and labels. |
| A reader lands because Grok received writer-like native permissions. | Spawn reader and writer fixtures with their own credentials; reader landing is denied by capability gate, writer landing succeeds only on its branch/epoch. |
| A typoed Grok subcommand becomes a prompt and exits zero. | Build every adapter argv from structured tokens, reject bare operation words, and make readiness fail when exit is zero but no expected session/protocol artifact appears. |

The code under this audit is concentrated at `src/adapters/tools/models.ts:81`, `src/cli/daemon.ts:122`, `src/daemon/recovery.ts:336`, `src/daemon/spawner-impl.ts:943`, `src/daemon/spawner-impl.ts:1749`, `src/daemon/server.ts:1047`, `src/daemon/tool-telemetry.ts:237`, `src/daemon/usage-credits.ts:552`, `src/daemon/model-inventory.ts:130`, `src/daemon/quota.ts:1300`, `src/daemon/quota.ts:1404`, `src/daemon/routing-resolve.ts:143`, `src/cli/uninstall.ts:190`, and `workspace/Sources/HiveWorkspace/LaunchConfig.swift:55`.

## 14. Ordered build plan and parallel tracks

The labels separate exhaustive plumbing from choices that depend on vendor behavior. A track may start only when its named dependencies are complete.

1. **[MECHANICAL, serial prerequisite] Complete the exhaustive vendor registry.** Preserve the landed `unknownVendor`/`forEachProvider` foundation, replace the remaining binary vendor fallthroughs and closed lists, migrate Claude/Codex behind the adapter interface, and extend the unknown-fourth-vendor negative controls. Verify no Grok enum exists yet, so every unimplemented operation is visible. Changes center on `src/schemas/capability.ts:33`, `src/daemon/spawner-impl.ts:943`, `src/daemon/recovery.ts:336`, `src/daemon/server.ts:1033`, `src/daemon/usage-credits.ts:552`, and `src/daemon/model-inventory.ts:130`.
2. **[MECHANICAL, depends on 1] Schema and persistence widening.** Add Grok provider, route, identity, quota, ledger, skill, CLI, and Workspace values with round-trip tests. Changes center on `src/schemas/capability.ts:30`, `src/schemas/agent.ts:29`, `src/schemas/routing.ts:51`, `src/schemas/quota.ts:33`, and `src/daemon/spawner.ts:8`.
3. **[REAL DESIGN, depends on 1–2] Freeze fixture contracts.** Check in redacted measured fixtures for version, models, billing wire, summary, successful/cancelled updates, successful signals, and both measured MCP wrapper profiles. Leave `GROK_EXHAUSTION_BLOCK_RECORD`, hook response, and delivery actuator explicitly unresolved until measured. Changes center on new Grok adapter tests plus `src/daemon/tool-telemetry.test.ts:199` and `src/daemon/quota-discovery.test.ts:181`.

After step 3, four tracks run in parallel:

- **Track A — [REAL DESIGN] Runtime/config/auth.** Build version/model discovery, initial/resume argv, worktree config merge, MCP credential injection, compatibility environment, permission flags, session resolution, and capability continuity. Depends on 1–3. Changes center on new `src/adapters/tools/grok.ts`, `src/daemon/spawner-impl.ts:1766`, and `src/daemon/recovery.ts:336`.
- **Track B — [REAL DESIGN] Telemetry/Graphify.** Build artifact-specific parsers, append-only update cursor, live context/model/turn result, both measured wrapper shapes, unclassified-wrapper guard, drift reporting, and signals cross-check. Depends on 1–3. Changes center on `src/daemon/tool-telemetry.ts:17`, `src/daemon/live-model.ts:95`, and `src/daemon/server.ts:1033`.
- **Track C — [REAL DESIGN] Quota/billing/routing.** Build `_x.ai/billing`, reset-only unknown-capacity persistence, money-rail guard, compatibility routing, three-vendor review policy, and reset recovery. Depends on 1–3; exhaustion classification cannot complete until its named block fixture lands. Changes center on `src/daemon/quota-sources.ts:41`, `src/daemon/quota-ledger.ts:283`, `src/daemon/quota.ts:1404`, `src/daemon/usage-credits.ts:480`, and `src/schemas/routing-derivation.ts:751`.
- **Track D — [MECHANICAL with measured vendor paths] Skill/product surfaces.** Add the Grok skill, init/provision/uninstall/cleanup, public CLI, refresh displays, and Workspace surfaces. Depends on 1–3 and consumes Track A's confirmed skill/config locations. Changes center on `src/adapters/skills.ts:134`, `src/skills/shipped.ts:48`, `src/cli/init.ts:345`, `src/cli/uninstall.ts:168`, and `workspace/Sources/HiveWorkspace/LaunchConfig.swift:55`.

4. **[REAL DESIGN, depends on Tracks A and B] Delivery and control.** Measure or consume the measured ordinary input and urgent cancel actuator, require correlated update proof, and wire critical restart to exact resume/capability rotation. Changes center on `src/daemon/delivery.ts:210`, `src/daemon/delivery.ts:629`, `src/adapters/tmux.ts:151`, and `src/daemon/spawner-impl.ts:1067`.
5. **[MECHANICAL, depends on A–D and 4] Lifecycle closure.** Wire normal spawn, control restart, crash/manual recovery, cleanup, model/quota refresh, and UI serialization through the registry; remove every temporary “unsupported Grok” throw only when its operation has a positive test. Changes center on `src/daemon/recovery.ts:142`, `src/daemon/spawner-impl.ts:1880`, `src/daemon/server.ts:1257`, and `src/cli/project-config-cleanup.ts:172`.
6. **[REAL DESIGN, depends on A–C measurements] Close the named unknowns and fatal launch gate.** Prove an MCP-using turn reaches `end_turn` on Hive's exact launch path, then land the exhaustion block record, Grok hook request/response, and delivery actuator. If any remains unknown, the corresponding status stays unavailable and first-class parity is not claimed; if MCP completion fails, the adapter does not ship at all. Changes center on the named parser fixtures and `src/adapters/tools/graphify-hook.ts:16`.
7. **[MECHANICAL verification, depends on all prior] Full matrix.** Run TypeScript unit/integration tests, typecheck, workspace Swift tests, and live redacted smoke tests for both measured models and both Hive roles. Exercise every silent-half-work row in §13.
8. **[RELEASE GATE, REAL DESIGN] First-class proof.** Demonstrate the §12 end-to-end acceptance under the installed version and record the version/build hash. Any unknown capacity is acceptable because it is honest and routed; any unknown delivery, hook, exhaustion discriminator, parser shape, or authorization state is displayed as unavailable rather than parity.

## 15. Known unknowns and non-goals

The remaining unknowns are intentional gates, not invitations to improvise:

- **Top risk:** whether Hive's exact interactive Grok launch can finish an MCP-using turn with `stop_reason == "end_turn"` is `UNKNOWN`; both measured headless models instead cancelled after successful MCP calls, and the adapter cannot ship until this is proven;
- the exact structured exhaustion-block record is `UNKNOWN` until an actual blocked request is captured;
- the Grok `PreToolUse` matcher/request/response effect for Hive's hook is `UNKNOWN` until a deny/allow fixture exists;
- the native or tmux ordinary-input and urgent-cancel actuator is `UNKNOWN` until effect is measured;
- a switch disabling project-root `CLAUDE.md` and `.claude/settings.local.json` ingestion is `UNKNOWN`; none was found;
- `xhigh` and `max` validity for `grok-4.5` is `UNKNOWN`; the live per-model list wins;
- weekly allowance, consumed capacity, remaining capacity, and money-rail `val` units are `UNKNOWN`;
- any alternate upstream billing format or TUI-only usage percentage is `UNKNOWN` and outside this implementation until separately measured.

Hive will not probe undocumented upstream HTTP endpoints, invent an allowance, hardcode a model, mutate user-global Grok state, remove repository instruction files, equate a transport write with delivery, or share parsers across artifacts. The cost is that some Grok sub-capabilities may remain visibly unavailable while xAI changes the CLI. That is preferable to a third vendor which appears healthy because every missing fact was converted to zero, `null`, or another vendor's answer.

These open gates map to `src/adapters/tools/graphify-hook.ts:16`, `src/daemon/tool-telemetry.ts:237`, `src/daemon/delivery.ts:210`, `src/daemon/quota-sources.ts:93`, `src/daemon/usage-credits.ts:552`, `src/daemon/recovery.ts:336`, and `src/daemon/spawner-impl.ts:1880`.
