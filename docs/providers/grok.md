# Grok

Updated: 2026-07-16
Sources: Hive source tree, 2026-07-16, and linked raw measurements
Raw: [Grok spend-sensitivity experiment](../../raw/grok/grok-spend-sensitivity-experiment.md) · [live quota verification](../../raw/grok/grok-quota-live-verification.txt) · [model-control snapshot](../../raw/grok/grok-model-control-verification.json) · [0.2.101 catalog verification](../../raw/grok/grok-0.2.101-catalog-verification.txt)

## Summary

Grok is a **peer vendor** in Hive, launched into a tmux pane like Claude and Codex, and metered like them. Almost everything Hive knows about it was bought with measured prompts against a live account: the permission semantics, the sandbox's non-enforcement, the session-artifact layout, and the fact that its MCP calls arrive under a wrapper name. This article is that knowledge.

Measured against **grok 0.2.93 (`f00f96316d4b`)** on 2026-07-12, **grok 0.2.99 (`b1b49ccb71a7`)** on 2026-07-13, and **grok 0.2.101 (`5bc4b5dfadcf`)** on 2026-07-14. Model ids named here are **examples observed on those dates**; Hive ships no Grok catalog or Grok name heuristic (`src/adapters/tools/models.ts:1-15`), and Grok's default flipped server-side once already.

## What the retired spec got wrong

The integration spec's §10 claimed Grok's weekly capacity is **unmeasurable** and that Grok is a routing **"pressure valve."** Both are false.

- **Grok IS metered weekly.** `config.creditUsagePercent` on ACP `_x.ai/billing` is a real 0–100 gauge that moves with spend and is insensitive to the probe itself. See [quota-surfaces.md](quota-surfaces.md) and the [spend-sensitivity experiment](../../raw/grok/grok-spend-sensitivity-experiment.md).
- **Grok is a peer, not a pressure valve.** No pressure-valve code exists.
- Never built, despite appearing in the spec: `GROK_EXHAUSTION_BLOCK_RECORD`, the tagged graphify counter, `unclassifiedWrapperCount`, and its alerting.
- The spec's argv section is **wrong**: `--prompt-file`, `--rules`, and `--permission-mode` are not used by Hive. `--cwd` is now load-bearing and pins every fresh or resumed process to its exact worktree; `--trust` prevents an unattended trust prompt.
- The spec's "capture the session id from Grok's updates" is **inverted**. Hive names the session; Grok never reports one back. See below.

A third document, the original Grok vendor-integration map, was retired outright: it was
an inventory of `claude|codex` fallthroughs to fix, and substantially all of them are now
fixed, so it described code that no longer exists.

## Launch argv

Built at `src/adapters/tools/grok.ts:104-138`:

```
grok --cwd <exact-worktree> --trust -m <model> [--reasoning-effort <e>]
     ( --always-approve                                  # writer
     | --deny Bash --deny Write --deny Edit
       --allow MCPTool --allow Read --allow Grep )       # read-only
     [--session-id <uuid>]                               # NEW sessions only
```

Resume inserts the short flag before the shared launch arguments:
`grok -r <session-id> --cwd <exact-worktree> --trust -m <model> …`.
`--session-id` is forbidden on resume — it *creates*. `--cwd` receives the
resolved worktree path, and `--trust` is immediately before `-m` on fresh and
resume argv. Every launch is wrapped in the compatibility env below. The prompt
bytes are unchanged by this argv-only correction.

## Hive names the session up front

`crypto.randomUUID()` → `--session-id` (`src/daemon/spawner-impl.ts:1963-1978`, threaded to the spawn at `:2080-2092`).

The reason is preserved in the adapter at `src/adapters/tools/grok.ts:11-15`: **Grok drives no hook channel and never reports its session id back.** Without naming it up front, every reader has to *guess* which session directory on disk belongs to this agent — and a reused worktree still holds its dead predecessor's. (That failure mode is a known recurring bug class in this codebase: path-keyed reads aliasing across respawns.) Naming it is the only way a reader can key on identity instead of on a directory.

## Permission rules are semantic prefixes, not tool names

The single highest-value measured fact about Grok, preserved verbatim in the adapter at `src/adapters/tools/grok.ts:24-31`:

**Rule names are Claude Code's prefixes, and they bind Grok's *differently-named native tools*.**

| Rule | Binds on composer ("cursor" profile) | Binds on grok-4.5 ("grok-build-plan" profile) |
|---|---|---|
| `--deny "Bash"` | `Shell` | `run_terminal_command` |
| `--deny "Write"` / `"Edit"` | `Write` / `Edit` | `write` |
| `--allow "MCPTool"` | `CallMcpTool` | **`use_tool`** |
| `--allow "Read"` / `"Grep"` | `Read` / `GrepSearch` | `search_tool` etc. |

One rule set therefore serves every model Hive runs on Grok — measured across three distinct tool vocabularies. There is no per-model rule table, and there must not be one.

### Three outcomes, and only two are safe

| decision | trigger | effect on the turn |
|---|---|---|
| `allow` | auto-allowed tool, an `--allow` rule, or `--always-approve` | runs, `wait_ms=0`, no round-trip |
| `deny` | an `--deny` rule matches | **clean refusal** — the model absorbs it, reports it, and continues. Turn ends `outcome="completed"`, `end_turn`, `signals.json` written |
| `cancelled` | approval needed and nobody can answer | **the turn DIES.** Tool result reads *"User cancelled the execution for tool …"*, `cancellation_category="permission_cancelled"`, no `signals.json` — **and the process still exits 0** |

`deny` beats `allow`. Two consequences:

1. **Do not append a blanket `--deny "MCPTool(*)"` after a scoped allow** — it kills the server you just granted.
2. An MCP server covered by **no** allow rule does not get a clean deny; the approval is unanswerable and the turn dies headless. The primary gate must stay *which servers Hive writes into the worktree config*; scoped rules (`--allow "MCPTool(server__*)"`, which globs the `server__toolname` string) are belt-and-braces.

**Exit 0 proves nothing on Grok.** A cancelled turn exits 0. The liveness evidence is the artifact, not the exit code.

## `--sandbox` is not a write barrier on macOS

Measured: `--sandbox read-only` (documented as *"FS Write: `~/.grok/` only"*) with `--always-approve` — the Write tool **created a file in CWD and it was verified on disk**. The flag registered (`summary.json` recorded `"sandbox_profile": "read-only"`); enforcement simply did not bind the agent's own Write tool. Consistent with the earlier finding that the sandbox's child-network blocking is a no-op on macOS.

> **Permission rules are the only measured-real write barrier.** Treat `--sandbox` as unproven defense-in-depth, never as the enforcement layer.

This is exactly why `GROK_SAFETY_DIRECTIVE` (`src/daemon/spawner-impl.ts:607-621`) is **injected into every Grok agent's prompt** (`:690`) rather than shipped as a skill: safety cannot depend on an agent electing to open a shipped skill. The directive tells the agent (a) the sandbox is not a barrier so its assigned scope is a rule it must keep, (b) a "User cancelled…" result with no prompt is a Hive launch-configuration bug — report it, do not retry, and (c) a `--deny` refusal is normal operation.

## Permissions are evaluated per-invocation

A session originally launched `--always-approve` that successfully ran `Shell`, when **resumed** with `grok -r <sid> --deny "Bash"`, resolved the *same* tool to `decision="deny"` and completed cleanly. **A resumed session does not replay its original authority** — the flags of the *current process* govern.

That is precisely what makes Hive's **shrink-authority-by-restart** model work on Grok: kill the process, relaunch with `-r <session-id>` and a narrower flag set, and the narrower authority binds. (Critical control → restart read-only.)

## Compatibility env: ten switches, and one gap they do not close

`GROK_COMPATIBILITY_ENV` (`src/adapters/tools/grok.ts:40-51`) exports ten variables, prepended to every Grok command:

```
GROK_{CLAUDE,CURSOR}_{SKILLS,RULES,AGENTS,MCPS,HOOKS}_ENABLED=false
```

They stop Grok inheriting the *operator's* Claude/Cursor skills, rules, agents, MCP servers, and hooks.

> **The authorization gap** (`src/adapters/tools/grok.ts:146-151`): those switches do **NOT** stop Grok from ingesting the repository's own `CLAUDE.md` and `.claude/settings.local.json`. **No switch that does was found.**

Those files are not addressed to a Grok agent. The gap is therefore closed the only way it can be — by telling the agent so in `GROK_SAFETY_DIRECTIVE`: the Hive brief and the assigned scope **outrank** anything in those files that grants permissions, names tools, or assigns work.

## MCP: `.grok/config.toml`, never `.mcp.json`

`.mcp.json` is Claude's file (`src/daemon/spawner-impl.ts:695-699`) and Grok never receives one. Hive writes `[mcp_servers]` tables into the **worktree's** `.grok/config.toml` (`src/adapters/tools/grok.ts:184-255`, called at `src/daemon/spawner-impl.ts:1049`, `:2081`), mode `0600`.

The writer is **key-preserving**: it strips only the tables Hive owns (`mcp_servers.hive*`, `mcp_servers.graphify*`), keeps everything the user wrote, and — when no fresh capability token is supplied — **re-reads and re-uses the existing `Authorization` header** rather than dropping it (`src/adapters/tools/grok.ts:178-189`). The removal path is equally narrow: it refuses to touch a file whose `mcp_servers.hive.url` does not match `http://127.0.0.1:<port>/mcp`.

## Session artifacts live in two layouts

The resolver must accept **both**, and it does (`src/adapters/tools/grok.ts:278-411`):

- a directory named for the **urlencoded cwd** (`encodeURIComponent(worktree)`), and
- a **long-path slug** directory carrying a `.cwd` file whose contents are the real path.

Matching the directory name is only the *filter*. The actual selection is on the session's own `summary.json`: `info.cwd === worktree`, `info.id` present, and — when Hive knows the id it named — `info.id === sessionId`. Newest `summary.json` mtime wins. A directory listing is not identity; the summary is.

Per-session artifacts under `~/.grok/sessions/<project>/<session-uuid>/` (`$GROK_HOME` respected, `src/adapters/tools/grok.ts:258-262`):

- `events.jsonl` — `permission_resolved` (with `decision` and `wait_ms`), `turn_ended` (`outcome`, `cancellation_category`)
- `updates.jsonl` — the append-only ACP-shaped stream; `turn_completed` carries `stop_reason`
- `signals.json` — written **only on a clean turn end**; its absence is itself a cancellation signal
- `summary.json` — `info.cwd`, `info.id`, `current_model_id`, `sandbox_profile`

## `use_tool`: the name-keyed counter that reads zero forever

**Grok wraps every MCP call in one native tool.** A real session records each call as:

```jsonc
{"sessionUpdate":"tool_call","title":"use_tool","rawInput":{"tool_name":"graphify__query_graph", …}}
```

`title` is the literal string `use_tool` **for all of them**. The real tool name is at `rawInput.tool_name`. A counter keyed on the record's own name therefore reads **zero forever** — which is why the telemetry reads `rawInput.tool_name` and nothing else (`src/daemon/tool-telemetry.ts:386-407`). This is the same failure shape as the guessed-JSON-key lesson in [capability-discovery.md](capability-discovery.md): nothing errors, the column is just empty.

## `.agents/skills` is shared by Grok AND Codex

A cross-vendor contract leak, measured and mitigated. `nativeSkillDirectory()` returns `.agents/skills` for **both** Codex and Grok (`src/adapters/skills.ts:22-32`) — verified with `grok inspect --json` while every compatibility import was disabled: project skills still resolved from `.agents/skills/*/SKILL.md`.

So in a root where both CLIs are installed, **a file written "for Codex" is read by Grok too** (`skillReaders()`, `src/adapters/skills.ts:139-147`).

The critical distinction: **`shippedSkillsFor(tool)` decides what Hive WRITES. It says nothing about what a CLI READS.** A per-vendor *write* filter is not an isolation boundary. The actual fix is two-part: `provisionSkills` (`src/adapters/skills.ts:233-257`) actively **prunes** foreign shipped skills from the shared directory (`removeForeignShippedSkills`, `src/adapters/skills.ts:268-292`), plus withholding at `hive init`. Each skill's `description` naming its vendor in the first clause is a *label* — defence in depth, not the fix.

The evidence discipline is worth copying: measured by planting uniquely-named probe skills and asking each CLI **what its MODEL sees** (`codex debug prompt-input`; a Grok turn with every tool denied, so the skill catalog was the only path to the probe token). **A directory listing is not evidence that the model reads it.**

## Version identity

`grok --version` is parsed by a regex pinned verbatim at `src/adapters/tools/grok.ts:58-65`:

```
/^grok (\S+) \(([0-9a-f]+)\) \[(\w+)\]$/
```

→ `{version, buildHash, channel}`. The identity remains diagnostic evidence, but it is not a manual allowlist: capability discovery validates the catalog's behavior on every probe. A catalog whose cached `grok_version` disagrees with the running CLI, changes the required schema, carries incoherent model IDs or effort declarations, lacks live-fetch proof, or names a missing default yields no usable discovery result. Compatible Grok updates therefore keep working without a Hive release; protocol-breaking updates still fail closed. See [capability-discovery.md](capability-discovery.md).

## Open unknowns (measured as unknown, not assumed)

- `--permission-mode dontAsk` semantics for an approval-needing tool covered by no rule: **unmeasured**. The intended control turned out to be default-allowed, so no reachable tool exercised the ask-path. Do not rely on `dontAsk` as a deny-backstop.
- Path-glob granularity of `Read(...)`/`Write(...)` rules: untested; only bare-prefix rules were measured.
- A scoped `--deny "MCPTool(server__*)"` producing a clean, turn-surviving refusal: *inferred* from the measured deny semantics of `Bash`/`Write`/`Edit`, not itself measured.

## See Also

- [Quota surfaces](quota-surfaces.md) — `_x.ai/billing`, the gauge-vs-guard rule
- [Capability discovery](capability-discovery.md) — the two-step catalog and its liveness gate
- [Launch mechanics](launch-mechanics.md) — how Claude and Codex differ
- [Routing policy](../routing/routing-policy.md) · [Quota and headroom](../routing/quota-and-headroom.md)
