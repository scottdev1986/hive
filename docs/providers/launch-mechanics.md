# Launch mechanics

Updated: 2026-07-13
Sources: Hive source tree, 2026-07-13; docs/model-selection.md (Layers 2–3); docs/research/model-routing-and-token-efficiency.md; docs/adapter-hardening-audit.md; raw/reviews/cross-vendor-architecture-review.md (retired)
Raw: [Cross-vendor architecture review](../../raw/reviews/cross-vendor-architecture-review.md)

## Summary

Once a model id has been *discovered*, actually launching it is a per-CLI argv problem with sharp, measured edges: which flag carries effort, which knob grants autonomy without raising a dialog nobody can answer, and how to detach the human's inherited MCP servers without producing a config the CLI refuses to load. Every mechanic below was established by driving the binaries — claude 2.1.206/2.1.207, codex-cli 0.144.0/0.144.1, grok 0.2.93/0.2.99.

Model ids named anywhere here are **examples observed on a date**, not values the code depends on. The binary ships with no model knowledge (`src/adapters/tools/models.ts:6-11`); what a route resolves to is discovered at runtime. The *mechanisms* are the durable content.

## The three CLIs do not agree on anything

| | Claude | Codex | Grok |
|---|---|---|---|
| model | `--model <id>` | `-m/--model`, or `-c model="…"` (Hive uses `-c`) | `-m <id>` |
| effort | **flag**: `--effort <level>` | **config only**: `-c model_reasoning_effort=<level>` | **flag**: `--reasoning-effort <level>` |
| autonomy | `permissions.defaultMode` in `.claude/settings.local.json` | `-c approval_policy="never" -c sandbox_mode="danger-full-access"` | `--always-approve` |
| read-only | `--permission-mode default` | `--sandbox read-only` (`-c sandbox_mode` on resume) | `--deny`/`--allow` rules |
| MCP scoping | `--mcp-config <path> --strict-mcp-config` | `-c mcp_servers.<name>.enabled=false`, per inherited server | worktree `.grok/config.toml` |
| session id | reported by the CLI | reported by the CLI | **Hive must name it** (`--session-id`) |

Every cell that differs from its neighbours is a bug someone has already written. The effort row is the one that bites hardest: there is no `--effort` on Codex, and passing one runs a prompt.

## Claude

**Model** is `--model <value>`; **effort** is `--effort <low|medium|high|xhigh|max>` — a real launch flag, not a config override (`src/adapters/tools/claude.ts:245-255`). Hive omits `--model` entirely when the resolved value is the literal `default`, and omits `--effort` unless the model's discovered record actually advertises that level. A haiku-class menu entry advertises no effort levels at all, so cheap-tier Claude spawns carry no effort flag rather than a guessed one.

**The `[1m]` context variant is CLI-appended and must never be passed as a model id.** On Max/Team/Enterprise the CLI may self-report `claude-opus-4-8[1m]` for a launch of the bare id. `[1m]` names a **context-window entitlement of the plan**, not a distinct model, and it does not travel uniformly: `opus[1m]` resolves to `claude-opus-4-8[1m]` while `claude-fable-5[1m]` resolves to a bare `claude-fable-5` (`src/schemas/capability.ts:323-325`). The capability record therefore keeps the launch token, the canonical id, and the variant as **three separate facts** (`src/schemas/capability.ts:24-27`, `:237-238`) — the launch flag receives the launch token and never the variant.

**MCP scoping** is `--mcp-config <path> --strict-mcp-config`, in that order: `--mcp-config` is variadic in 2.1.206, so the non-variadic `--strict-mcp-config` must follow it to terminate the list (`claude.ts:266-276`). Measured: five inherited servers and 41 tool names collapse to one server and zero.

### A bad `--model` does not fail at spawn

**`--model totally-bogus-model-xyz` is ACCEPTED.** `initialize` takes it, `system/init` echoes the garbage back verbatim as the effective model, and the launch looks fine. It dies on the **first turn**: `is_error: true`, `total_cost_usd: 0`, *"There's an issue with the selected model … It may not exist or you may not have access to it."*

So **a model pin cannot fail closed at spawn.** Argv validation buys nothing here; the launch is not the proof. A session must be treated as `VALIDATING` until the first turn's outcome lands, and fail closed on mismatch. The three-state trust ladder this produces (`catalogued` / `providerReportedSelectable` / `launchValidated`) is in [capability-discovery.md](capability-discovery.md), and its consequence for chains and fallbacks is in [../routing/routing-policy.md](../routing/routing-policy.md): **a route entry that "launched" is not evidence the model exists.**

### `--fallback-model` must never be passed

It exists to **silently substitute a different model** when the requested one fails — which is exactly the quiet default the whole no-model-knowledge design exists to kill. A substituted model produces an execution identity nobody chose, a quota reservation booked against the wrong meter, and a critical restart that replays something other than what ran. Hive never passes it, and the flag appears nowhere in the source tree. A spawn that cannot get its model **fails, loudly, naming the model** — see the refusal path in [../routing/routing-policy.md](../routing/routing-policy.md).

## Codex

**Model** is `-m/--model <MODEL>` at the CLI, or the config-override form `-c model="…"`; Hive passes the override form (`src/adapters/tools/codex.ts:114-116`). **Effort is config-only** — `-c model_reasoning_effort=<level>`. There is no `--effort` flag on Codex. That asymmetry with Claude is the single most common launch bug in this area.

With no flag the CLI reads `model` from the layered config, which is why the effective default must be read from `config/read` rather than guessed (see [capability-discovery.md](capability-discovery.md)).

Directory trust is passed as an override rather than by editing the user's file: `-c projects."<abs path>".trust_level="trusted"` (`codex.ts:101-107`).

### `-c` semantics, established by experiment

Two facts about `-c` were found by running codex-cli 0.144.0 and are load-bearing (`src/adapters/tools/mcp-scope.ts:23-31`, `:103-109`):

1. **Dotted-path overrides deep-merge; they do not replace.** Neither `-c 'mcp_servers={}'` nor a replacement inline table detaches anything. The *only* override that detaches an inherited server is `-c mcp_servers.<name>.enabled=false`, after which `codex mcp list` reports it `disabled`.
2. **Dotted paths do not accept TOML-quoted segments.** `-c 'mcp_servers."a.b".enabled=false'` does not address the server named `a.b`. It splits on the dot and creates a *new*, transport-less server literally keyed `"a.b"`, and the CLI then refuses to start:

   ```
   Error: failed to load configuration
   Caused by: invalid transport in `mcp_servers."a.b"`
   ```

Hive therefore emits detach overrides only for bare-key-safe names (`/^[A-Za-z0-9_-]+$/`, `mcp-scope.ts:31-35`) and **leaves an unaddressable server attached** rather than risk a launch that cannot load its config. Hive's own servers are never detachable.

### The refuted hypothesis: the Codex MCP tax is unmeasurable

Worth recording precisely because it failed. OpenAI's pricing page states that *"Every MCP you add to Codex adds more context to your messages and uses more of your limit."* Measurement did not support it: a `codex exec` turn using no tools cost **11,073 input tokens with both inherited servers attached and 11,073 with both detached** — five of seven runs identical to the token — and attaching a third, known-connecting stdio server changed nothing. Codex 0.144.0 appears to expose MCP tools through a registry the model queries rather than by injecting definitions into every message.

That contradicts the vendor's own published pricing claim, so one of the two is wrong. Two caveats keep this honest: it is an *absence* of evidence, and it was measured on `codex exec` while Hive spawns the interactive TUI. The MCP scoping ships anyway — on the **reachable-authority** argument (a Codex agent with a server attached can name 39 of its tools, and zero once Hive detaches it), never on a token argument. Claude's tax is real but small: 590 cache-creation tokens, 41 of 71 tool names.

## Grok

Argv, permission rules, session naming, and the `.grok/config.toml` MCP path are all Grok-specific enough to have their own article: see [grok.md](grok.md). In brief: `-m <model>`, effort as `--reasoning-effort <e>`, permissions as `--always-approve` or `--deny`/`--allow` rules, and a Hive-named `--session-id`.

## Autonomy: spawning without a human at the keyboard

Writers launch sandboxed by default; `autonomy = "dangerous"` launches them fully autonomous. The per-CLI mechanics are not interchangeable, and one of them has a trap.

**Claude — set `permissions.defaultMode = "bypassPermissions"` in the worktree's `.claude/settings.local.json`** (`src/adapters/tools/claude.ts:440`, `:473`). The session starts in bypass mode with no dialog.

> **Do NOT use `--dangerously-skip-permissions`.** It raises a blocking acceptance dialog on *every* launch that an unattended spawn cannot answer; `--allow-dangerously-skip-permissions` does not suppress it; and accepting it does not persist. The rationale is preserved in the adapter at `claude.ts:31-33` precisely so nobody re-adds the flag.

**Codex — `-c approval_policy="never" -c sandbox_mode="danger-full-access"`** (`src/adapters/tools/codex.ts:126-133`), rendered by the TUI as `permissions: YOLO mode`. The non-dangerous writer path is `sandbox_mode="workspace-write"` + `approval_policy="on-request"` (`:135-141`).

**Read-only** is its own posture on both: Claude gets `--permission-mode default` (`claude.ts:256-258`), Codex gets `--sandbox read-only` — or `-c sandbox_mode="read-only"` on the resume path, because `codex resume` documents no `--sandbox` flag (`codex.ts:118-126`).

## Launch identity is immutable, and that is a design commitment

The model a spawn launches with is the agent's **recorded execution identity**. It is what a critical-control restart replays, and what the quota reservation is keyed to. Three mechanics fall out of that:

- **Pin concrete ids, not aliases.** An alias passes through verbatim into the record. `default` on Claude and `default` on Codex are *literal* values Hive omits the flag for — they mean "whatever this machine's layered config resolves to," which is precisely what a restart cannot reproduce if the config moved. A recorded `opus` tells you nothing about what will relaunch.
- **Raw vendor effort strings must survive persistence.** A shipped enum that rejects a level the vendor advertised is a level a critical restart cannot replay (`src/schemas/capability.ts:209-217`). Codex 0.144.1 already advertised levels Hive's old enums did not know.
- **Mid-session model change is impossible by design.** Re-routing is a handoff, not a mutation. But a *human* can switch models inside a session, which is invisible to the spawn-time record — the statusline payload's `model.id` is the live correction (see [quota-surfaces.md](quota-surfaces.md)).

## What the version probes are for

Neither vendor's catalog carries the CLI version it came from; it is read separately (`<cli> --version`, which prints and exits without opening a session). That matters because capability records are **version-stamped**, and Grok goes further: a catalog read is refused outright unless the running build is one whose behavior was actually measured (`src/daemon/capability-discovery.ts:761-766`). A vendor's wire format is a fact about a *build*, not about a product.

## Two invariants from the adapter hardening audit

These are not model facts; they are the two ways adapter code most reliably manufactures a plausible lie.

**1. `Number.parseInt("12oops", 10)` yields `12` — a perfectly plausible PID.** External numerics must be parsed as *complete decimal strings*, then range-checked, never leniently. Pane-PID parsing therefore matches `/^[1-9][0-9]*$/` before converting and then requires `Number.isSafeInteger(pid) && pid > 0` (`src/adapters/tmux.ts:255-266`). The same discipline is applied to unmerged-commit counts and profile staleness in the worktree/profile adapters. A malformed number that survives parsing is indistinguishable from a real one, and it anchors a process-tree walk.

**2. Long-lived provider sessions must be excluded from probe-style timeouts.** Short hard deadlines are correct for *probes* — 10s on every tmux invocation (`src/adapters/tmux.ts:27`), 5s on the Claude version probe (`src/adapters/tools/claude.ts:82`), 5s on the Codex app-server availability probe (`src/adapters/tools/codex-app-server.ts:371`), 5s on the Grok version probe (`src/adapters/tools/grok.ts:74`). They are *wrong* for the Codex app-server host and the agent TUIs, which are intentionally long-running. Their lifecycle belongs to daemon supervision, not a 5s deadline; applying probe timeouts to them breaks their contract. The line between "a subprocess I am asking a question" and "a process I am hosting" is the line the timeout policy follows.

## When a model "won't open"

1. **Is it on a route?** `hive routing` prints what every tier resolves to and where each value came from. A model in no cell is reachable only by an explicit `hive_spawn` `model`, or a pin in `~/.hive/routing.toml`.
2. **Does the CLI accept it directly?** `claude --model <id>` / `codex -m <id>` / `grok -m <id>`, and read the session header. This separates *entitlement* problems from *Hive* problems in one step.
3. **Is the value concrete?** Aliases pass through verbatim into the recorded execution identity, which tells you nothing about what a control restart would relaunch. Pin concrete ids.
4. **Is a pool in the way?** `hive quota` shows measured headroom per pool; an exhausted per-model pool refuses the spawn and *names* the pool that blocked it. See [quota-surfaces.md](quota-surfaces.md).
5. **Is the agent alive but idle at a prompt?** Check the pane for an acceptance or trust dialog — that means the autonomy posture above did not reach it.

## See Also

- [Capability discovery](capability-discovery.md) — where the model id and its legal effort levels come from
- [Quota surfaces](quota-surfaces.md) — what a launch spends and who says so
- [Grok](grok.md) — Grok's own argv, permission rules, and session naming
- [Routing policy](../routing/routing-policy.md) · [Quota and headroom](../routing/quota-and-headroom.md)
