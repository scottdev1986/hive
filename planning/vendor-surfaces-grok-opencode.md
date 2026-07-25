# Vendor surfaces: Grok CLI and OpenCode

Verified reference for the C2 · Observation implementers. Cite this instead of re-researching.

**Research date: 2026-07-24.** Versions measured: `grok 0.2.112 (9bbd559437aa) [stable]`,
`opencode 1.18.5` with `@opencode-ai/plugin` + `@opencode-ai/sdk` **1.17.18**.
Spec being satisfied: `docs/design/hive-communication.html` §10 (Provider capability contract) and §13 (C2 row).

## How to read the verification tags

Every claim below carries one:

| Tag | Meaning |
|---|---|
| **[LIVE]** | I ran it on this machine on 2026-07-24 and observed the result. Trustworthy. |
| **[SHIPPED-DOC]** | Read from vendor documentation shipped *inside the installed build* (so it is version-matched to 0.2.112), but not executed. |
| **[SDK-TYPE]** | Read from the installed vendor TypeScript declarations. Authoritative for shape, not for runtime behavior. |
| **[WEB-DOC]** | From the vendor's public web docs. Version drift is possible. |
| **[UNVERIFIED]** | Inference, or blocked by quota. **Do not implement as fact without confirming.** |

Grok's quota pool is drained until 2026-07-26T17:18Z, so **no Grok model turn was executed.** Everything
Grok-side is `--help` output, shipped docs, on-disk transcripts from *earlier* sessions, or config-discovery
commands that need no API call. Each Grok hook-firing claim is explicitly tagged.

---

# A. Grok CLI

## A1. Where hooks live

**[SHIPPED-DOC]** `~/.grok/docs/user-guide/10-hooks.md` (shipped with 0.2.112, read 2026-07-24). All sources merge:

| Scope | Path | Trusted? |
|---|---|---|
| Global | `~/.grok/hooks/*.json` | Always |
| Global (compat) | `~/.claude/settings.json`, `~/.cursor/hooks.json` | Always |
| **Project** | **`<project>/.grok/hooks/*.json`** | **Requires folder trust** |
| Project (compat) | `<project>/.claude/settings.json`, `<project>/.cursor/hooks.json` | Requires trust |
| Config | `~/.grok/config.toml`, `managed_config.toml`, `requirements.toml` | Always |
| Plugin | bundled in an installed plugin | Per-plugin |

The spec's expectation of `.grok/hooks/` is **correct**. Config is **per-project**; there is also a global
tier, which Hive must not write.

**Compat scanning is a real hazard.** Grok scans `~/.claude/settings.json` and the project's
`.claude/settings.json` for hooks *by default* **[SHIPPED-DOC]**. In any repo that has Claude Code hooks —
including a Hive worktree that carries `.claude/` — those fire under Grok too. Disable per vendor with
`[compat.claude] hooks = false` / `[compat.cursor] hooks = false`. That setting lives in `~/.grok/config.toml`
(global) **[SHIPPED-DOC]**, so Hive **cannot** turn it off without a global write — see A6. §10's
"without importing unrelated user or Claude hooks" requirement therefore cannot be met by configuration
alone on the TUI path; it is met on the ACP path (A6, Option 1) or must be accepted as a known deviation.

## A2. Hook events (the exact set in 0.2.112)

**[SHIPPED-DOC]**, all 14, verbatim from the shipped table:

| Event | Fires when | Blocking |
|---|---|---|
| `SessionStart` | a session starts | no |
| `UserPromptSubmit` | you submit a prompt | no |
| `PreToolUse` | a tool is about to run | **yes — can deny** |
| `PostToolUse` | a tool completes successfully | no |
| `PostToolUseFailure` | a tool fails | no |
| `PermissionDenied` | the permission system denies a tool call | no |
| `Stop` | an agent turn ends on a genuine completion (**not** on user interrupt) | **yes — can block** |
| `StopFailure` | a turn ends because of an API error | no |
| `Notification` | the agent sends a notification | no |
| `SubagentStart` | a subagent starts | no |
| `SubagentStop` | a subagent's turn ends | **yes — can block** |
| `PreCompact` | compaction is about to run | no |
| `PostCompact` | compaction completes | no |
| `SessionEnd` | the session ends | no |

`SubagentEnd` is an accepted alias for `SubagentStop`.

> **Correction to third-party sources.** Public blog/gist write-ups of Grok hooks list `TaskCreated` and
> `TaskCompleted` **[WEB-DOC]**. Those are **not** in the shipped 0.2.112 event table. Treat them as
> **[UNVERIFIED]** and do not register them — unrecognized event names are silently skipped, so a hook
> bound to them would look installed and never fire.

## A3. Hook payload

**[SHIPPED-DOC]** Event JSON arrives on **stdin**. Keys are **camelCase** (Claude Code uses snake_case —
a ported script must be rewritten).

Common to every event: `hookEventName`, `sessionId`, `cwd`, `workspaceRoot`, `timestamp`,
`permissionMode` (`default` | `auto` | `plan` | `bypassPermissions`).

Event-specific highlights:

- tool events add `toolName`, `toolInput`, and always `toolUseId` + `toolInputTruncated`.
  `PostToolUse` output is **`toolResult`** (not Claude's `tool_response`).
- `Stop` adds `reason`, `stopHookActive`, `lastAssistantMessage`, `backgroundTasks[]`, `sessionCrons[]`.
  **`reason == "end_turn"` is the genuine turn end**; a second observe-only `Stop` also fires at session end
  with `reason` `channel_closed` or `shutdown`. Hive must filter on `end_turn` or it will double-count turn-idle.
- `StopFailure` adds `error` (one of `rate_limit`, `authentication_failed`, `invalid_request`, `server_error`,
  `max_output_tokens`, `unknown`), `errorDetails`, `lastAssistantMessage`. `billing_error` is **never emitted**.

Environment injected into **every** hook process **[SHIPPED-DOC]**:

| Variable | Value |
|---|---|
| `GROK_HOOK_EVENT` | event name, snake_case (`pre_tool_use`, `stop`, …) |
| `GROK_HOOK_NAME` | configured hook name |
| `GROK_SESSION_ID` | current session id |
| `GROK_WORKSPACE_ROOT` | workspace root |
| `CLAUDE_PROJECT_DIR` | alias of the above |

These five are **reserved**: values supplied via a hook's `env` map are stripped at load time and the runner
injects the real ones. Hive cannot shadow them.

### Can a hook payload bind an event to one exact provider run?

This is the load-bearing question for Hive, so precisely:

- **Session id: YES.** `sessionId` in the payload and `GROK_SESSION_ID` in the environment **[SHIPPED-DOC]**.
- **Per-run identifier: NO, not natively — and Hive does not need one from the vendor.** There is no
  per-run field. **Hive supplies it itself**, because Hive writes the hook file: bake the run id into the
  hook's own `command` (e.g. `hive-hook --run-id=<id>`) or its `env` map. Both are per-hook-file, so a
  per-worktree hook file yields per-run binding. `env` cannot collide with the five reserved keys above.
  This is the smallest mechanism that satisfies §10 and requires building nothing parallel.
- **Conversation id: NO separate field.** Grok exposes **one** id (`sessionId`) at the hook boundary.
  Map `ProviderEvent.conversationId` to `sessionId` and accept that Grok's session *is* its conversation,
  or set it `null`. There is no distinct conversation id to read. A per-turn id **does** exist, but only on
  the transcript stream, not in hook payloads (A4).

**Binding recipe (recommended):** run id from Hive-injected `env`/argv; conversation id and vendor-session
correlation from `sessionId`; the daemon accepts the event only if that run id is the active ProviderRun,
per §10's ingestion rules.

## A4. Trust and approval

**[SHIPPED-DOC]** Project hooks are **silently skipped** until the folder is trusted. Trust is granted by
`/hooks-trust` in-session or the `--trust` launch flag, and recorded in the **unified folder-trust store
`~/.grok/trusted_folders.toml`** — the same gate governing repo-local MCP and LSP. A grant covers
**MCP + LSP + hooks together** and **cascades to subdirectories**. Global folder-trust can be disabled
entirely with `GROK_FOLDER_TRUST=0` or `[folder_trust] enabled = false`.

**[LIVE] Trust gating confirmed in both directions**, with a positive control as required (an absent hook
could otherwise mean "bad JSON" rather than "untrusted"):

```
# scratch project containing .grok/hooks/hive.json (one SessionStart hook)
$ grok inspect                      # untrusted
  └ Project trusted: no
  Hooks (1)
  └ file  plugin: codex             # ← our project hook absent

$ GROK_HOME=<throwaway> grok inspect  # same dir, trusted_folders.toml pre-seeded
  └ Project trusted: yes
  Hooks (2)
  └ command  project                # ← our project hook now discovered
  └ file     plugin: codex
```

So: discovery of `.grok/hooks/*.json` and its trust gate are **live-verified**. `grok inspect` is a
zero-quota way for Hive (or a test) to assert both. I used a throwaway `GROK_HOME` so the user's real
config was never modified.

**[LIVE]** `--trust` is a **real but hidden** top-level flag on the TUI in 0.2.112 — it is absent from
`grok --help`, so verify by behavior, not by help text. Negative control included:

```
$ grok --definitely-not-a-flag --help   → error: unexpected argument
$ grok --trust --help                   → prints help (accepted)
$ grok --trust=maybe --help             → error: unexpected value 'maybe' for '--trust'
                                          Usage: grok --trust [PROMPT]
```

The third line proves clap knows `--trust` as a boolean flag.

**[SHIPPED-DOC] / [UNVERIFIED] behavior:** the docs say a `--trust` grant *is recorded* in
`trusted_folders.toml`, i.e. it **persists globally**. I could not execute it (that launches an
interactive session needing quota), so "`--trust` writes the global store" is **[UNVERIFIED]** in
0.2.112 — but assume it does, since the doc states it and the safe assumption is the restrictive one.

**Hook firing itself is [UNVERIFIED].** No Grok turn ran, so "a trusted `.grok/hooks/` hook actually
executes and delivers the payload in A3" is documentation-only. **This is the single most important thing
to confirm live once quota returns** (2026-07-26T17:18Z). A `SessionStart` hook appending to a file is a
sufficient check.

## A5. Session update / transcript telemetry — the strongest Grok surface

**[SHIPPED-DOC]** Per-session directory `~/.grok/sessions/<url-encoded-cwd>/<session-id>/`
(`GROK_HOME` relocates the base; note the base is `sessions/`, **not** the `projects/` directory that also
exists under `~/.grok`). Contents: `summary.json`, **`updates.jsonl`** (the authoritative ACP session-update
stream that drives `/resume`), `chat_history.jsonl`, `plan.json`, `signals.json`, `rewind_points.jsonl`,
`compaction_checkpoints/`, `subagents/`.

**[LIVE]** I swept the on-disk corpus — **101 `updates.jsonl` files, 41,350 events** (sessions written by
earlier Grok runs on this machine). Measured vocabulary, complete:

| Method | count |
|---|---|
| `session/update` | 40,339 |
| `_x.ai/session/update` | 1,011 |

| `update.sessionUpdate` | count |
|---|---|
| `tool_call_update` | 26,681 |
| `tool_call` | 7,761 |
| `agent_thought_chunk` | 4,114 |
| `agent_message_chunk` | 1,245 |
| `user_message_chunk` | 413 |
| `turn_completed` | 398 |
| `task_backgrounded` | 298 |
| `task_completed` | 296 |
| `plan` | 125 |
| `retry_state` | 10 |
| `auto_compact_started` | 3 |
| `auto_compact_completed` | 3 |
| `compaction_checkpoint` | 3 |

Tool statuses observed: `Pending` → `in_progress`/`InProgress` → `Completed` (7,642) or `Failed` (110).
`turn_completed.stop_reason`: `end_turn` 393, `error` 3, **`cancelled` 2**.

**[LIVE] `params._meta` carries the identifiers Hive needs**, on every streaming event:

```json
{"totalTokens":18592,
 "eventId":"56d25d34-…-dfdf-59",
 "agentTimestampMs":1783894098582,
 "promptId":"348c03b3-fa7f-478f-9fb3-5b57094cff60",
 "streamStartMs":1783894097024,
 "turnStartMs":1783894096338,
 "updateType":"ToolCall",
 "updateParams":{"toolCallId":"call-1c8f…-0","title":"read_file","kind":"Other","status":"Pending"}}
```

- **`sessionId`** on `params` of every line.
- **`promptId`** — a **per-turn** UUID, present on 28,737 of 41,350 events. `turn_completed` repeats it as
  `prompt_id`. This is a genuine per-turn identifier, which the hook payloads do **not** expose.
- **`eventId`** — `<sessionId>-<monotonic-n>`. Ideal for `ProviderEvent.eventId`, and for
  dedup/resume-after-gap when tailing.
- **`toolCallId`** — stable across `tool_call` → `tool_call_update`, giving exact tool pairing.
- `update._meta["x.ai/tool"]` gives `name`, `kind`, `namespace`, `label`, `read_only`, and `input` —
  enough for `toolName` and `inputDigest` without capturing raw output.

**Turn and tool boundaries exposed:** turn start via `user_message_chunk` (with `update._meta.promptIndex`)
and `_meta.turnStartMs`/first-`promptId`-appearance; turn end via `turn_completed` + `stop_reason`; tool
start via `tool_call`; tool end via `tool_call_update` reaching `Completed`/`Failed`. There is **no explicit
`turn_started` event** — derive it. **No approval/permission event appears in the corpus**: in ACP a
permission request is a *request* (`session/request_permission`), not a session update, so it is absent from
`updates.jsonl` by design. `approval-waiting` is therefore **not sourceable from the transcript**.

**[SHIPPED-DOC]** The separate headless `--output-format streaming-json` stream is much thinner — only
`text`, `thought`, `end`, `error`, plus `max_turns_reached` and `auto_compact_*`, and the doc says treat the
list as non-exhaustive. **It has no tool events.** Do not use it for tool boundaries; use `updates.jsonl`.

## A6. Integration options, smallest first

**Option 1 — ACP with injected plugin dir (cleanest; no global write, no trust prompt).**
**[SHIPPED-DOC]** plugin discovery, in priority order:

| Location | Scope | Trust |
|---|---|---|
| `_meta.pluginDirs` on `session/new` / `session/load` | that session only | **automatic** |
| `--plugin-dir` (flag on `grok agent … stdio`) | that process only | **automatic** |
| `.grok/plugins/` | project | requires trust |
| `~/.grok/plugins/` | user | automatic |

**[LIVE]** `grok agent --help` documents `--plugin-dir <DIR>`: *"Load a plugin from this directory for this
process only (repeatable). Highest-priority plugin scope; always trusted — hooks and MCP servers activate
without a prompt. Used by the Agent SDKs to inject per-connection plugins."* A plugin directory supplies
hooks as `hooks/hooks.json` **[SHIPPED-DOC]**.

This satisfies §10 with **zero** global config writes, **zero** trust persistence, and no chance of touching
unrelated user hooks — the vendor built it for exactly this. **[SHIPPED-DOC]** caveat: `--plugin-dir` is
*ignored in leader mode*, so pass `--no-leader`. It requires Hive to drive Grok over ACP
(`grok agent … stdio`) rather than the interactive TUI.

**[LIVE]** `--plugin-dir` is **rejected by the TUI**: `grok --plugin-dir /tmp/x` → *error: unexpected
argument '--plugin-dir' found*. So Option 1 is unavailable on the TUI path.

**Option 2 — TUI with project hooks (what §10 describes).** Write `.grok/hooks/hive.json` into the
worktree and establish folder trust with the hidden `--trust` flag at launch.

- Never overwrites unrelated hooks: all sources **merge**, and hooks are per-file in `.grok/hooks/*.json`.
  Use a distinct filename (`hive.json`) and Hive owns only that file.
- **Conflict with the standing rule, stated plainly:** trust is recorded in
  **`~/.grok/trusted_folders.toml`, a global vendor file**. Grok offers **no** per-launch,
  non-persistent trust for the TUI. So on the TUI path, §10's "no global vendor config" line **cannot be
  held**. The write is narrow — one additive `[folders."<worktree>"]` entry keyed by absolute path, which
  cannot clobber unrelated hooks or another folder's decision — but it *is* global state, and it grants
  MCP + LSP + hooks together, which is broader than hooks alone. **This is a decision for queen, not for an
  implementer to make silently.** Recorded as an open question in §Open questions.
- Trust **cascades to subdirectories**, so a worktree under an already-trusted repo root inherits trust and
  needs no new write. Hive should **check `grok inspect` first** and only grant when actually untrusted —
  that keeps the global write off the common path. **[LIVE]** `grok inspect` prints `Project trusted: yes|no`.

**Recommendation:** prefer Option 1 (ACP + `--plugin-dir --no-leader`) wherever Hive controls the launch;
it is strictly cleaner and is the only option that also sidesteps the `.claude` compat-scanning problem in
A1. Fall back to Option 2 for the interactive TUI, gated on an `inspect` trust check.

**Do not use** `grok plugin install` — **[SHIPPED-DOC]** it installs into the user's global plugin set
(`~/.grok/installed-plugins`, present **[LIVE]** on this machine) and is exactly the global mutation §10 forbids.

## A7. Grok → Hive `ProviderEvent.kind` mapping

Hooks column is **[SHIPPED-DOC]** (firing unverified); transcript column is **[LIVE]**.

| Hive `kind` | From hook | From `updates.jsonl` |
|---|---|---|
| `run-started` | `SessionStart` | — (session dir creation only) |
| `turn-started` | `UserPromptSubmit` | `user_message_chunk`; first `_meta.promptId` / `turnStartMs` |
| `tool-started` | `PreToolUse` | `tool_call` (status `Pending`) |
| `tool-finished` | `PostToolUse`, `PostToolUseFailure` | `tool_call_update` → `Completed` / `Failed` |
| `approval-waiting` | **no source** (see below) | **no source** (ACP request, not an update) |
| `turn-idle` | `Stop` with `reason == "end_turn"` | `turn_completed` `stop_reason=end_turn` |
| `turn-failed` | `StopFailure` | `turn_completed` `stop_reason=error`; `retry_state` |
| `interrupted` | **no source** — docs state interrupted/refused/max-turns turns **skip `Stop` entirely** | **`turn_completed` `stop_reason=cancelled`** ← only source |
| `compacted` | `PreCompact`, `PostCompact` | `auto_compact_started`/`_completed`, `compaction_checkpoint` |
| `run-ended` | `SessionEnd` | — |

**Hive kinds Grok cannot source:**

- **`approval-waiting` — genuinely absent from both surfaces.** `PreToolUse` fires *before* the tool runs
  but does not indicate that a prompt is now blocking; `PermissionDenied` fires only on the *denial*, after
  the fact. There is no "waiting for approval" event anywhere. **Must come from terminal observation.**
  This is the one Hive kind with no structured Grok source and it should be called out in the descriptor tests.
- **`interrupted` — absent from hooks**, available only from the transcript. A hooks-only Grok integration
  will silently never emit `interrupted`. Either tail `updates.jsonl` or take it from terminal/process evidence.
- `run-started`/`run-ended` are hook-only; a transcript-only integration lacks them.

**Grok events with no Hive home:** `Notification`, `SubagentStart`, `SubagentStop`/`SubagentEnd`,
`PermissionDenied` (a *denial*, not any of the ten kinds), and transcript `task_backgrounded`,
`task_completed`, `plan`, `agent_message_chunk`, `agent_thought_chunk`. Drop them, or extend the union —
do not force-fit them. Note `SubagentStop` fires **inside the subagent**, so mapping it to `turn-idle`
would corrupt the main run's turn state; that mis-mapping is the trap worth naming.

## A8. Grok `ProviderCommunicationCapabilities`

Two honest descriptors, because the two launch paths genuinely differ. Do not average them.

```ts
// Path 1 — ACP: grok agent --no-leader --plugin-dir <hive-plugin> stdio
{ provider: "grok", eventSource: "hooks", nativeDelivery: true,   // session/prompt  [SHIPPED-DOC]
  toolBoundaryEvents: true, turnBoundaryEvents: true, transcriptReader: true,
  nativeCancel: true,          // ACP session/cancel  [SHIPPED-DOC, UNVERIFIED live]
  conversationResume: true }   // [LIVE] --resume / --continue

// Path 2 — interactive TUI + .grok/hooks/ (+ folder trust)
{ provider: "grok", eventSource: "hooks", nativeDelivery: false,  // terminal submission only
  toolBoundaryEvents: true, turnBoundaryEvents: true, transcriptReader: true,
  nativeCancel: false,         // Esc / Ctrl+C is terminal input, not a native API
  conversationResume: true }   // [LIVE]
```

If trust is not established, Path 2 degrades to `eventSource: "transcript"` with
`toolBoundaryEvents: true`, `turnBoundaryEvents: true` (from `updates.jsonl`), `nativeCancel: false`.

- **`conversationResume: true` — [LIVE]**, from `grok --help`: `-r, --resume [<SESSION_ID_OR_TITLE>]`,
  `-c, --continue`, `--fork-session`, `-s, --session-id <UUID>` for a *new* session.
  **Hive can pre-assign the session id** with `--session-id`, which is a clean second binding anchor.
- **`nativeCancel`** — ACP defines `session/cancel` and Grok implements ACP **[SHIPPED-DOC]**; I did not
  execute it, so **[UNVERIFIED]**. On the TUI there is no native cancel — only terminal keystrokes.
- **`nativeDelivery`** on Path 1 is ACP `session/prompt` **[SHIPPED-DOC, UNVERIFIED live]**. Grok also has a
  leader socket (`~/.grok/leader.sock`) and a WebSocket relay **[LIVE]** in `--help`; both are unexplored
  and are **not** needed for §10.

## A9. Grok terminal-output fallback must cover

- **`approval-waiting`** — the only source, structured or otherwise. Non-negotiable.
- **`interrupted`**, if not tailing `updates.jsonl`.
- Everything, whenever the folder is untrusted (project hooks are *silently* skipped — no error surfaces,
  so absence of events is indistinguishable from an idle agent without the `inspect` check).
- Everything, when the daemon is down: §10 requires hooks to exit successfully and fail open, so a
  Hive-hook outage is invisible to Grok and produces silence, not failure.
- Liveness in general: hooks fail open on timeout/crash **[SHIPPED-DOC]** (5s default; 600s for
  `Stop`/`SubagentStop`), so a slow hook drops the event without a trace.

---

# B. OpenCode

Far better verified than Grok: I ran a **real turn with a real tool call** and captured the event stream.

## B1. Installing and loading a project-scoped plugin

**[LIVE] — the decisive result.** I placed an identical probe plugin in **both** candidate directories of a
scratch project and ran `opencode debug config` (no model call). **Both loaded:**

```
/tmp/oc-loaded-plugin.txt   {"dir":"plugin", …}
/tmp/oc-loaded-plugins.txt  {"dir":"plugins", …}
```

So in 1.18.5 **both `.opencode/plugin/` and `.opencode/plugins/` are auto-loaded**, singular and plural.
Both string literals exist in the binary **[LIVE]**, and the binary's own help text reads
``.opencode/plugin/` or `.opencode/plugins/``. Public docs mention only the plural **[WEB-DOC]**;
the singular is the more commonly used form in the wild. **Recommendation: use `.opencode/plugin/` and
create the directory if absent** — but never assume the other is unused, since a user's plugin may live there.

Properties that matter, all **[LIVE]**:

- **Loaded by dropping in a file. No config edit, no trust prompt, no install command.**
- **A named export is invoked** — my export was `HiveProbe`, not `default`, and it ran. Hive should use a
  distinctive named export.
- `process.env` is readable from the plugin: `HIVE_RUN_ID=run-abc123` came through as
  `{"env":"run-abc123"}`. **This is the per-run binding mechanism.**
- `input.directory` and `input.worktree` both resolved to the project dir.

**How to install without overwriting a user's plugins — [LIVE] + [SDK-TYPE]:**
write exactly one uniquely-named file, `.opencode/plugin/hive.js`. Every file in the directory is loaded
independently, so an added file cannot disturb sibling plugins. **Do not** use `opencode plugin <module>`:
**[LIVE]** its help is *"install plugin and update config"*, it takes an **npm module name**, has
`-g, --global` and `-f, --force` (*"replace existing plugin version"*), and it **edits the `plugin` array in
config** — the array-rewrite path that can clobber a user's list. The drop-in file avoids config entirely
and is the smallest thing that satisfies §10.

**[LIVE] Load-order** **[WEB-DOC]** is global config → project config → global plugins → project plugins.

**Hazard — [LIVE]:** the global flag **`--pure`** ("run without external plugins") appears on every
`opencode` subcommand. If anything launches OpenCode with `--pure`, the Hive plugin **does not load** and no
events arrive. Hive must never pass it, and should treat total event silence as possible `--pure`.

## B2. The plugin API

**[SDK-TYPE]** `~/.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts`, version **1.17.18**.

> **Version skew, flagged:** the binary is **1.18.5** but the installed plugin/SDK packages are **1.17.18**.
> The declarations are therefore one minor behind the runtime — and B4 shows the runtime **does** emit events
> absent from the 1.17.18 types. Trust the live observations over the types where they disagree.

```ts
type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>   // full server API, incl. session abort
  project: Project; directory: string; worktree: string
  serverUrl: URL; $: BunShell
  experimental_workspace: { register(type, adapter): void }
}
type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>
```

Directly-callable hooks in `Hooks` (all optional, all `async`), the Hive-relevant ones:

| Hook | Input | Output |
|---|---|---|
| `event` | `{ event: Event }` | — (catch-all bus) |
| `chat.message` | `{ sessionID, agent?, model?, messageID?, variant? }` | `{ message: UserMessage, parts: Part[] }` |
| `tool.execute.before` | `{ tool, sessionID, callID }` | `{ args }` |
| `tool.execute.after` | `{ tool, sessionID, callID, args }` | `{ title, output, metadata }` |
| `permission.ask` | `Permission` | `{ status: "ask" \| "deny" \| "allow" }` |
| `experimental.session.compacting` | `{ sessionID }` | `{ context: string[], prompt? }` |
| `experimental.compaction.autocontinue` | `{ sessionID, agent, model, provider, message, overflow }` | `{ enabled }` |
| `dispose` | — | — (**use for `run-ended`**) |
| `chat.params`, `chat.headers`, `tool.definition`, `command.execute.before`, `shell.env`, `config`, `tool`, `auth`, `provider` | | not needed for §10 |

`permission.ask` is **mutating** — writing `output.status` decides the permission. Hive must emit
`approval-waiting` and **leave `output.status` untouched**, or it will silently auto-answer the user's
prompts. Highest-risk footgun in the OpenCode integration.

**[SDK-TYPE]** `Event` union — 32 variants: `EventServerInstanceDisposed`, `EventInstallationUpdated`,
`EventInstallationUpdateAvailable`, `EventLspClientDiagnostics`, `EventLspUpdated`, `EventMessageUpdated`,
`EventMessageRemoved`, `EventMessagePartUpdated`, `EventMessagePartRemoved`, `EventPermissionUpdated`,
`EventPermissionReplied`, `EventSessionStatus`, `EventSessionIdle`, `EventSessionCompacted`,
`EventFileEdited`, `EventTodoUpdated`, `EventCommandExecuted`, `EventSessionCreated`, `EventSessionUpdated`,
`EventSessionDeleted`, `EventSessionDiff`, `EventSessionError`, `EventFileWatcherUpdated`,
`EventVcsBranchUpdated`, `EventTuiPromptAppend`, `EventTuiCommandExecute`, `EventTuiToastShow`,
`EventPtyCreated`, `EventPtyUpdated`, `EventPtyExited`, `EventPtyDeleted`, `EventServerConnected`.

> **Correction to public docs.** The web docs list a **`permission.asked`** event **[WEB-DOC]**. The real
> type literal is **`permission.updated`** **[SDK-TYPE]**, alongside `permission.replied`. Subscribing to
> `permission.asked` yields nothing, silently. (The *hook* is `permission.ask`; the *event* is
> `permission.updated`. Easy and costly to conflate.)

## B3. Event payloads

**[SDK-TYPE]**, verbatim:

```ts
EventSessionIdle       { type:"session.idle";      properties:{ sessionID } }
EventSessionStatus     { type:"session.status";    properties:{ sessionID, status: SessionStatus } }
EventSessionCreated    { type:"session.created";   properties:{ info: Session } }
EventSessionUpdated    { type:"session.updated";   properties:{ info: Session } }
EventSessionCompacted  { type:"session.compacted"; properties:{ sessionID } }
EventSessionDeleted    { type:"session.deleted";   properties:{ info: Session } }
EventSessionError      { type:"session.error";     properties:{ sessionID?, error?: ProviderAuthError
                           | UnknownError | MessageOutputLengthError | MessageAbortedError | ApiError } }
EventPermissionUpdated { type:"permission.updated"; properties: Permission }
EventPermissionReplied { type:"permission.replied"; properties:{ sessionID, permissionID, response } }
EventMessageUpdated    { type:"message.updated";    properties:{ info: Message } }
EventMessagePartUpdated{ type:"message.part.updated"; properties:{ part: Part, delta? } }
EventCommandExecuted   { type:"command.executed";  properties:{ name, sessionID, arguments, messageID } }

SessionStatus = { type:"idle" } | { type:"retry"; attempt; message; next } | { type:"busy" }
Permission = { id, type, pattern?, sessionID, messageID, callID?, title, metadata, time:{created} }
MessageAbortedError = { name:"MessageAbortedError"; data:{ message } }
Session = { id, projectID, directory, parentID?, title, version, time:{created,updated,compacting?},
            summary?, share?, revert? }
```

Note `Session.parentID` — sub-sessions/subagents are distinguishable, so Hive can avoid attributing a
child session's turn boundaries to the parent run.

## B4. Live-measured event stream

**[LIVE]** One real turn (`opencode run --auto "Use the bash tool to run exactly: echo hive-probe-ok …"`,
model `gpt-5.6-terra-fast`), plugin logging every hook. 94 records. Ordered essentials:

```
init                 runId=run-abc123  directory=…/octest
event  session.created        props=[sessionID, info]   sessionID=ses_069577188ffe0Z1XP6gU6yJ3Ti
event  session.updated        props=[sessionID, info]
chat.message                  sessionID=ses_…  role=user
event  message.updated        props=[sessionID, info]
event  message.part.updated   props=[sessionID, part, time]
event  session.status         status={"type":"busy"}          ← turn start
event  session.diff           props=[sessionID, diff]
event  plugin.added ×45, catalog.updated ×2, reference.updated, integration.updated
tool.execute.before   tool=bash  callID=call_jua1GZQxWxQ34jk5LxOGYQrO   ← tool start
tool.execute.after    tool=bash  callID=call_jua1…  title="echo hive-probe-ok"  ← tool end
event  message.part.delta     props=[sessionID, messageID, partID, field, delta]
event  session.status         status={"type":"idle"}          ← turn end
event  session.idle           props=[sessionID]               ← turn end (definitive)
event  session.updated / session.diff
```

Three findings that **contradict the installed types** — implement against these:

1. **Every event carried `sessionID` directly in `properties`**, including `session.created`,
   `session.updated`, and `message.updated`, whose 1.17.18 declarations list only `info`. Binding is
   easier than the types suggest. **Read `properties.sessionID` with a fallback to `properties.info.id`** —
   that is correct under both versions.
2. **Runtime emits events absent from the 1.17.18 `Event` union:** `plugin.added`, `catalog.updated`,
   `reference.updated`, `integration.updated`, `message.part.delta`, `session.diff`. The union is
   **not exhaustive** against the 1.18.5 runtime. **Switch on `event.type` with a default branch**; an
   exhaustive `switch` over the typed union will throw or silently mis-handle in production.
3. `message.part.delta` (`{sessionID, messageID, partID, field, delta}`) is the streaming-text channel and
   is **high-volume** — ignore it for §10; §10 wants metadata and digests, not token streams.

**Not exercised, therefore [UNVERIFIED]:** `permission.ask` / `permission.updated` (suppressed by
`--auto` — Hive must not pass `--auto` if it wants approval events), `session.error`,
`MessageAbortedError`, `session.compacted`, and the **tool-failure** path (whether
`tool.execute.after` fires on a failed tool, or only `session.error` does — **this gap matters for
`tool-finished`; confirm before relying on it**).

## B5. Binding an event to one run

- **Session id: YES — [LIVE]** on every event, plus in `tool.execute.*`, `chat.message`, `permission.ask`.
- **Per-run id: YES, via Hive's own launch env — [LIVE]** (`process.env.HIVE_RUN_ID` read inside the
  plugin). Same shape as Grok: Hive owns the plugin file, so it owns the binding. Capture it once in the
  plugin factory and stamp every event.
- **Conversation id: YES** — the OpenCode session id, with `Session.parentID` distinguishing children.
- **Tool call id: YES — [LIVE]** `callID`, identical across `before`/`after`.
- **Message id:** `messageID` on `chat.message`, `command.executed`, `message.part.delta`.

OpenCode binds more cleanly than Grok: one id space, present on every event, and `parentID` for sub-sessions.

## B6. OpenCode → Hive `ProviderEvent.kind` mapping

| Hive `kind` | Source | Verified |
|---|---|---|
| `run-started` | plugin factory invocation, or `session.created` | **[LIVE]** |
| `turn-started` | `session.status` → `{type:"busy"}` (edge from idle), or `chat.message` | **[LIVE]** |
| `tool-started` | `tool.execute.before` | **[LIVE]** |
| `tool-finished` | `tool.execute.after` | **[LIVE]** (success only; failure path **[UNVERIFIED]**) |
| `approval-waiting` | `permission.ask` hook, or `permission.updated` event | **[SDK-TYPE]**, [UNVERIFIED] |
| `turn-idle` | `session.idle` (and `session.status` → `idle`) | **[LIVE]** |
| `turn-failed` | `session.error` | **[SDK-TYPE]**, [UNVERIFIED] |
| `interrupted` | `session.error` with `error.name === "MessageAbortedError"` | **[SDK-TYPE]**, [UNVERIFIED] |
| `compacted` | `session.compacted`; `experimental.session.compacting` for the leading edge | **[SDK-TYPE]**, [UNVERIFIED] |
| `run-ended` | `dispose` hook (also `server.instance.disposed`) | **[SDK-TYPE]**, [UNVERIFIED] |

**All ten Hive kinds have an OpenCode source** — unlike Grok, nothing is structurally missing. Caveats:

- `turn-started` needs **edge detection**: **[LIVE]** `session.status {busy}` fired **5 times in one turn**,
  not once. Emit on the idle→busy transition only, or Hive will report five turns where there was one.
  Same discipline for `session.idle`.
- `SessionStatus` also has `{type:"retry", attempt, message, next}` — a retry, not a new turn and not a
  failure. It has no §10 home; do not map it to `turn-failed`.
- `turn-failed` vs `interrupted` both arrive as `session.error`; discriminate on `error.name`
  (`MessageAbortedError` → `interrupted`, everything else → `turn-failed`).

**OpenCode events with no Hive home:** `file.edited`, `file.watcher.updated`, `todo.updated`,
`command.executed`, `message.updated`, `message.removed`, `message.part.updated`, `message.part.delta`,
`message.part.removed`, `session.updated`, `session.deleted`, `session.diff`, `permission.replied`,
`lsp.*`, `installation.*`, `tui.*`, `pty.*`, `vcs.branch.updated`, `server.connected`, and the
live-only `plugin.added` / `catalog.updated` / `reference.updated` / `integration.updated`. Ignore them;
`session.diff` and `todo.updated` are tempting for progress reporting but §10 does not ask for it.

## B7. OpenCode `ProviderCommunicationCapabilities`

```ts
{ provider: "opencode",
  eventSource: "hooks",        // Hive-managed plugin callbacks
  nativeDelivery: true,        // POST /session/{id}/prompt_async via PluginInput.client  [SDK-TYPE]
  toolBoundaryEvents: true,    // [LIVE] tool.execute.before/after + callID
  turnBoundaryEvents: true,    // [LIVE] session.status busy/idle + session.idle
  transcriptReader: true,      // opencode export <sessionID>  [LIVE in --help]
  nativeCancel: true,          // POST /session/{id}/abort  [SDK-TYPE]
  conversationResume: true }   // [LIVE] --continue / --session <id> / --fork
```

- **`eventSource`** — `"hooks"` is the right value: these are Hive-registered callbacks, matching how §10
  uses the term for Claude and Grok. `"native"` is arguable; pick `"hooks"` and be consistent, since §10
  says delivery and recovery branch on the descriptor.
- **`nativeCancel` / `nativeDelivery` — [SDK-TYPE]**, from routes in the installed SDK. **[LIVE]** I
  confirmed the route table contains `/session/{id}/abort`, `/session/{id}/prompt_async`,
  `/session/{id}/message`, `/session/{id}/permissions`, `/session/{id}/fork`, `/session/{id}/summarize`,
  `/session/{id}/revert`. The plugin receives `client` **and** `serverUrl`, so the plugin itself can cancel
  and deliver — **no separate transport needed**. Neither call was executed: **[UNVERIFIED]**.
- **`conversationResume` — [LIVE]** from `opencode --help`: `-c, --continue`, `-s, --session <id>`,
  `--fork`. Also `opencode attach <url>`, `serve`, and `export`/`import`.
- **`transcriptReader`** — **[LIVE]** `opencode export [sessionID]` exists; its output shape is **[UNVERIFIED]**.

## B8. OpenCode terminal-output fallback must cover

- Total plugin non-load: `--pure`, a plugin syntax error, or a wrong directory. All are **silent** — no
  events and no complaint. Terminal/process evidence is the only detector.
- `turn-failed` / `interrupted` / `approval-waiting` until B4's unverified paths are confirmed live.
- Tool failure, until it is known whether `tool.execute.after` fires on a failing tool.
- Liveness whenever the daemon is unreachable, per §10's fail-open rule.

---

# C. Cross-vendor summary

| | Grok (TUI + `.grok/hooks/`) | Grok (ACP + `--plugin-dir`) | OpenCode |
|---|---|---|---|
| Install artifact | `.grok/hooks/hive.json` in worktree | Hive plugin dir passed at launch | `.opencode/plugin/hive.js` in worktree |
| Needs vendor trust step | **yes** — global `trusted_folders.toml` | **no** (auto-trusted) | **no** |
| Touches global vendor config | **yes** (trust store) | **no** | **no** |
| Can clobber user hooks/plugins | no (per-file merge) | no | no (per-file) |
| Per-run binding | Hive-injected `env`/argv | same | Hive-injected env **[LIVE]** |
| Vendor session id at boundary | `sessionId` | `sessionId` | `sessionID` **[LIVE]** |
| Per-turn id | transcript `promptId` only **[LIVE]** | same | derive from status edges |
| All 10 Hive kinds sourceable | **no** (`approval-waiting`; `interrupted` needs transcript) | same | **yes** (3 unverified) |
| Hook/plugin firing verified live | **no** (quota) | **no** (quota) | **yes** |

**Smallest integration satisfying §10, per vendor:**

- **OpenCode** — write one file, `.opencode/plugin/hive.js`, exporting one named plugin function; read the
  run id from `process.env`; subscribe to `event` plus `tool.execute.before/after`, `permission.ask`
  (read-only), and `dispose`. No config, no install command, no trust. Nothing further should be built:
  the vendor already provides delivery (`prompt_async`) and cancel (`abort`) through the `client` the plugin
  is handed, so Hive must **not** add a parallel transport.
- **Grok** — prefer ACP `grok agent --no-leader --plugin-dir <dir> stdio`: no global write, no trust
  prompt, and it also sidesteps `.claude` compat hook scanning. On the TUI, write
  `.grok/hooks/hive.json` and grant trust only after `grok inspect` reports `Project trusted: no`.
  Tail `updates.jsonl` for `interrupted` and per-turn `promptId` — it is already written by the vendor, so
  do not build a second telemetry channel.

## Open questions for queen

1. **Grok TUI folder trust writes `~/.grok/trusted_folders.toml`, a global vendor file.** §10 forbids
   global vendor config writes (the Kimi ruling). Grok offers no non-persistent trust for the TUI. Options:
   (a) adopt the ACP `--plugin-dir` path and hold the rule; (b) permit this one narrow additive write;
   (c) accept transcript-only observation on the TUI. **Needs a decision — I did not assume one.**
2. **`.claude` compat hook scanning is on by default** and can only be disabled in global config, so a Hive
   worktree carrying `.claude/settings.json` will fire those hooks under Grok. Directly touches §10's
   "without importing unrelated user or Claude hooks". Clean only on the ACP path.

## Must be confirmed live before implementation

**Grok (blocked until quota returns 2026-07-26T17:18Z):**
1. A trusted `.grok/hooks/` hook actually fires and its stdin payload matches A3. *Highest priority.*
2. `--trust` at launch does grant trust, and whether it persists to the global store.
3. `--plugin-dir` on `grok agent … stdio` activates a plugin's `hooks/hooks.json` untrusted-prompt-free.
4. ACP `session/cancel` and `session/prompt`.
5. `_meta.pluginDirs` on `session/new` as the per-session alternative.

**OpenCode (not blocked; just not yet run):**
6. Whether `tool.execute.after` fires when a tool **fails**. Affects `tool-finished`.
7. `permission.ask` / `permission.updated` payload without `--auto` — and that reading them does not
   auto-answer the prompt.
8. `session.error` shapes for `turn-failed` vs `MessageAbortedError` → `interrupted`.
9. `session.compacted` firing.
10. `/session/{id}/abort` and `/session/{id}/prompt_async` from inside the plugin's `client`.

## Reproduction commands

```sh
# Grok — all zero-quota
grok --help; grok agent --help; grok plugin --help; grok inspect
grok --trust=maybe --help                      # proves the hidden --trust flag
ls ~/.grok/docs/user-guide/                    # version-matched shipped docs
cat ~/.grok/docs/user-guide/10-hooks.md        # hook events + payload + trust
cat ~/.grok/trusted_folders.toml               # folder-trust store
find ~/.grok/sessions -name updates.jsonl      # ACP transcripts (101 here, 41,350 events)

# Grok — trust gating, both directions, without touching real config
mkdir -p /tmp/gt/.grok/hooks && cd /tmp/gt && git init -q
printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"true"}]}]}}' > .grok/hooks/h.json
grok inspect                                   # Project trusted: no  → hook NOT listed
mkdir -p /tmp/gh && printf '[folders."/tmp/gt"]\ntrusted = true\ndecided_at = 1784188440\n' > /tmp/gh/trusted_folders.toml
GROK_HOME=/tmp/gh grok inspect                 # Project trusted: yes → "command  project" listed

# OpenCode
opencode --help; opencode plugin --help; opencode debug --help
cat ~/.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts      # Hooks interface
grep 'export type Event = ' ~/.opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts
mkdir -p /tmp/oc/.opencode/plugin && cd /tmp/oc                       # drop-in load, no config
# plugin writing process.env.HIVE_RUN_ID to a file, then:
HIVE_RUN_ID=x opencode debug config            # loads plugins without a model call
```
