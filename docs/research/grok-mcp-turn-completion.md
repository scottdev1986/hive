# Grok: can an MCP-using turn complete on Hive's launch path?

**Verdict: YES on every launch path, provided permissions are pre-authorized. The
feature is alive.** The `stop_reason="cancelled"` failures that prompted this
investigation were not an MCP problem and not a headless-mode problem per se:
they were the headless permission system instantly cancelling any tool
execution that would have required an interactive approval. `--always-approve`
(the grok analog of the `bypassPermissions` mode Hive already uses for Claude
writers) eliminates the failure on every path.

Measured 2026-07-12 on grok 0.2.93 (f00f96316d4b), model
`grok-composer-2.5-fast`, with the live graphify MCP server declared in a
project-scope `.grok/config.toml`:

```toml
[mcp_servers.graphify]
url = "http://127.0.0.1:57184/mcp"
enabled = true
```

Five model prompts were spent (budget was ten). Every result below was
verified from the session artifacts on disk under
`~/.grok/sessions/<urlencoded-cwd>/<session-uuid>/` — `events.jsonl`,
`updates.jsonl`, `signals.json` — never from stdout or the screen.

## The diagnosed cause: `permission_cancelled`

The prior agent's failing sessions (bella's, sessions
`019f57c1-d78a…` on composer-fast and `019f57c6-649c…` on grok-4.5) carry the
cause verbatim in `events.jsonl`:

```
{"type":"permission_resolved","tool_name":"Shell","decision":"cancelled","wait_ms":3}
{"type":"turn_ended","outcome":"cancelled","cancellation_category":"permission_cancelled"}
```

`wait_ms` of 0–3 means nobody was ever going to be asked: in headless `-p`
with the default permission mode, a tool call that needs approval is resolved
as "cancelled" immediately, the tool result becomes
`"User cancelled the execution for tool …"`, and the whole turn ends
`stop_reason="cancelled"` without writing `signals.json`. The process still
exits 0 — exit code proves nothing.

Which tools need approval is profile-dependent: on the default composer
profile ("cursor"), read-only tools (Glob, Read, GrepSearch) and
`CallMcpTool` are auto-allowed, and `Shell` needs approval; on grok-4.5's
"grok-build-plan" profile even the MCP `use_tool` wrapper needed approval.
So an MCP-only turn can complete headless by luck of the profile, and die on
another profile — bella saw both.

## Reproduction and fix (headless `-p`)

| Run | Invocation | Result |
|---|---|---|
| P1 | `grok -m grok-composer-2.5-fast --output-format json -p "<call graph_stats>"` | `CallMcpTool(graphify.graph_stats)` completed, `stop_reason="end_turn"`, signals.json written, correct answer (877, matched live graph) |
| P2 | same, prompt forces a `Shell` echo | `permission_resolved decision=cancelled wait_ms=0` → `turn_ended outcome=cancelled category=permission_cancelled`; exit 0 |
| P3 | P2's prompt + MCP call, with `--always-approve` | all four tools (`Shell`, `Glob`, `Read`, `CallMcpTool`) `decision="allow"`, `turn_ended outcome="completed"`, `stopReason="EndTurn"`, signals.json written, both answers correct (880 nodes, matched live graph) |

## TTY path (the way Hive launches agents) — PASS

P4: `grok -m grok-composer-2.5-fast --always-approve "<prompt>"` launched
inside a detached tmux pane (`tmux new-session -d -c <cwd> '…'`), prompt
forcing both the graphify MCP call and a Shell command. Session
`019f57ce-568d…` artifacts:

```
"type":"permission_resolved","tool_name":"CallMcpTool","decision":"allow","wait_ms":0
"turn_ended","outcome":"completed"          (events.jsonl)
"stop_reason":"end_turn"                    (updates.jsonl turn_completed)
signals.json written
```

Answer content exactly matched the live graph (880 nodes / 192 edges / 726
communities) and the echo output.

## ACP path (`grok agent stdio`) — PASS, and the strongest option

P5: newline-delimited JSON-RPC over
`grok agent -m grok-composer-2.5-fast stdio` (note: `-m` belongs to
`grok agent`, not to `stdio` — `grok agent stdio -m …` is a usage error that
exits 2 with nothing on stdout). Sequence: `initialize` (protocolVersion 1) →
`session/new` (cwd = project dir, `mcpServers: []`) → `session/prompt`.

- The project-scope `.grok/config.toml` MCP server was picked up even with an
  empty `mcpServers` list in `session/new`.
- `CallMcpTool(graphify.graph_stats)` ran with no permission round-trip.
- The `Shell` call surfaced as a `session/request_permission` request **to the
  client**; answering `{"outcome":{"outcome":"selected","optionId":"allow-once"}}`
  let execution proceed. On ACP, Hive owns permission policy per call instead
  of a blanket bypass.
- Turn ended `stopReason:"end_turn"` with token accounting in `_meta`
  (`totalTokens`, `inputTokens`, `outputTokens`, `cachedReadTokens`) — a
  telemetry surface the TUI path does not hand back.

## What Hive should do

For the tmux/TTY launch (mirrors the Claude writer spawn, which uses
`bypassPermissions`):

```
grok -m <model> --always-approve "<spawn prompt>"
```

launched in the agent's tmux pane with cwd = the worktree, and the MCP servers
declared in `<worktree>/.grok/config.toml`. For read-only agents, grok has
`--allow <RULE>` / `--deny <RULE>` and
`--permission-mode <default|acceptEdits|auto|dontAsk|bypassPermissions|plan>`
for finer policy (untested here; `--always-approve` is the measured-good
flag).

If Hive drives Grok over ACP instead, `grok agent -m <model> stdio` is fully
viable and strictly richer: per-call permission decisions, structured
`session/update` streaming, per-turn token counts, and
`session/request_permission` instead of a blanket bypass.

Telemetry/liveness surfaces for either path, all under
`~/.grok/sessions/<urlencoded-cwd>/<uuidv7>/`:

- `events.jsonl` — `permission_resolved`, `turn_ended` with
  `outcome`/`cancellation_category`
- `updates.jsonl` — append-only ACP-shaped stream, `turn_completed` carries
  `stop_reason`
- `signals.json` — written only on clean turn end (its absence is itself a
  cancellation signal)
