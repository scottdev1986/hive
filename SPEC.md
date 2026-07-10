# hive

## What this is

You `cd` into a project and type `hive claude`. A terminal opens with an AI orchestrator in it, scoped to that folder. You talk to it like a tech lead: "build this feature," "figure out why the tests are flaky," "have Codex take a second look at the auth code." It doesn't write the code itself. It decomposes the work, spawns agents — Claude Code here, Codex there, big model for the hard part, cheap model for the changelog — and each agent appears in its own terminal window where you can watch it work. Agents talk to each other when they need to, regardless of vendor. When the work is done, it gets merged, and the windows go away.

Why build this when 2026 is drowning in agent orchestrators? Because everything that exists is one of two things. Human-driven multi-tool: Conductor, Vibe Kanban — they'll run Claude and Codex side by side, but *you* are the orchestrator, dragging cards and assigning tasks. Or AI-driven mono-tool: Claude Code's agent teams — an AI lead that decomposes and delegates, but only ever to other Claude sessions. Nobody ships the intersection: **an AI orchestrator that routes work across vendors, picks the right tool and model per task, and lets its agents message each other across the vendor line.** That intersection is hive. Everything else in this document — worktrees, tmux, sandboxes, windows — is table stakes we build because we must. The cross-vendor brain and the cross-vendor nervous system are the product.

One honest strategic note before the architecture: we're building in the gap between Anthropic and OpenAI, and either could close it — agent teams adding non-Claude members would hurt. Our defensible ground is vendor neutrality, so the roadmap leans into adding a third tool early rather than polishing a two-tool duopoly. Speed matters. macOS only, by choice, for now.

## How it works

The design fell out of twelve questions, each of which had a way to go wrong. Walking them in order, because each answer constrains the next.

### 1. How agents talk to each other

The problem nobody states out loud: Claude Code and Codex are turn-based loops. They act, then stop and wait for input. Nothing interrupts them mid-task, and nothing polls while they sit idle. So "agents can message each other" needs two mechanisms, not one — a place for messages to live, and a way to *wake the recipient*.

The place to live: both tools speak MCP (Codex via `config.toml`, stdio or HTTP), and MCP is the only API surface identical across vendors. So hive runs a small local daemon that owns a SQLite message store and exposes itself to every agent as an MCP server: `hive_send`, `hive_inbox`, `hive_list_agents`. Same send path whether you're Claude or Codex.

The wake-up: tmux. If the recipient is idle at its prompt, the daemon injects "📨 message from maya: …" via `tmux send-keys` (two-step — literal text, then Enter, or the keystroke gets swallowed). If the recipient is mid-task, the message queues, and a turn-boundary hook drains the inbox. This is the pattern the tmux-orchestrator ecosystem converged on, and it's event-driven — no polling anywhere.

Alternatives we rejected: a pure file inbox ("agents check for messages") fails exactly when it matters, because an idle agent never checks. Routing everything through the orchestrator as a relay makes it a bottleneck and fills its context with traffic. What we give up: agents must run inside tmux. Which turns out to be a gift, not a cost — see below.

### 2. How the orchestrator knows anything

An agent in another terminal is an opaque process. The spec-fantasy version — "the orchestrator knows when agents are done, stuck, or running out of context" — needs real signals. They exist:

- Claude Code has lifecycle hooks: `Stop` fires on every turn end with the session's transcript path; `Notification` fires when the agent is *waiting on an approval* (that's the stuck-at-a-prompt signal); `SessionStart` announces birth.
- Codex has `notify` (fires a program on `agent-turn-complete` with JSON) and, as of this year, a broader hooks system. One sharp edge learned the hard way: Codex ignores `notify` in project-local `.codex/config.toml` and skips project config entirely for untrusted directories — so hive passes `notify` as a spawn-time `-c` override and pre-trusts each worktree the same way, rather than writing config into the worktree and hoping.
- Context usage is readable from disk: both tools write per-message token usage to their transcript/rollout files. No guessing.

So: at spawn, hive writes hook configs into each agent. Agents self-report into the daemon; the daemon maintains a live table — agent, status, last event, context %. A slow `tmux capture-pane` heartbeat (~60s) is the fallback stuck-detector for whatever hooks miss (hung tool call, dead process). The orchestrator gets exactly one tool, `hive_status()`, and never scrapes a terminal. The alternative — orchestrator eyeballing capture-pane dumps — burns its context on screenshots and turns the conductor into a babysitter.

One known wart: Claude Code's Stop-hook `transcript_path` can go stale (anthropics/claude-code#8564); the daemon reads the most-recently-modified `.jsonl` in the project dir instead of trusting it.

Identity rides on this table too, and agents get **human first names** — maya, david, sam — drawn from a pool at spawn, never numbers. Everything keys off the name: tmux session `hive-maya`, worktree `.hive/worktrees/maya`, branch `hive/maya-auth-api`, the status row, message envelopes. The reason is that the user's entire interface is conversation with the orchestrator, and conversation wants names: "tell maya to reuse the middleware" and "what's david doing?" work; "message agent-3" forces the user to keep a mental numbering table the tool should be keeping for them. Numbered agents were the obvious default and lost for exactly that reason. Task-derived names ("auth-api") lost too: two agents can share a feature, and a name describing the task goes stale the moment the agent is respawned onto follow-up work — the worker's identity should outlive any one assignment. The cost is some whimsy in professional logs and a pool large enough to never collide within a session; both trivial.

### 3. How agents avoid destroying each other's work

Three agents editing one checkout doesn't produce merge conflicts — it produces silent overwrites, agents reading half-written files, and everyone fighting over `.git/index.lock`. The industry answer is unanimous and we take it: **worktree per writing agent.** Each writer gets its own branch and checkout (`.hive/worktrees/maya`, branch `hive/maya-auth-api`) sharing one object store. Read-only agents (research, review) share the main checkout free of charge.

But isolation is the floor, not the strategy. The real conflict-avoidance is planning, which is exactly the orchestrator's job: land shared interfaces on the base branch *before* fanning out, and give every agent an explicit file scope ("you own `lib/auth/`"). Merges happen serially — maya lands, then david merges against a world that includes maya's work — done by a spawned integrator agent (the orchestrator can't write; see decision 11).

The "david needs maya's work-in-progress" case gets a real mechanism instead of a hand-wave: maya commits to her branch and messages david "pull `hive/maya-auth-api` at abc123." Shared object store makes it instant. Uncommitted state is never shared; that way lies madness.

Consequences accepted: hive requires a git repo (we `git init` or degrade to single-writer if there isn't one), and practitioner consensus says 2–4 parallel writers is where coordination overhead starts eating the parallelism gains — "as many agents as it needs" has a soft ceiling and the orchestrator should know it.

### 4. Who answers the permission prompts

N agents in N windows each stopping for "allow this command?" gives you a fork: babysit every window (autonomy dies) or blanket `--dangerously-skip-permissions` (N unattended agents with shell access on your real laptop). Both tools now offer a third way, and hive builds on it:

**Sandboxed autonomy, one escalation queue.** Codex agents run `sandbox_mode = "workspace-write"` scoped to their worktree with `approval_policy = "on-request"`. Claude agents run auto mode (or `acceptEdits` plus a hive-maintained allowlist in the worktree's settings). Inside their box, agents never prompt. The rare escalation flows through the daemon — Claude's `Notification` hook, Codex's approval events — and surfaces in exactly one place: the orchestrator window. "maya wants to run `npm publish` — approve?" You supervise one window. The agent windows are for *watching*, not controlling.

The orchestrator can auto-resolve escalations by a policy you set at spawn ("network installs fine, nothing outside the repo, never push"), but anything irreversible or outward-facing — publish, push, deploy, spend — always reaches you. And there's a pleasant unification here: the sandbox boundary *is* the scope enforcement from decision 3. An agent physically cannot write outside its worktree, so "assigned file scopes" stops being an honor system.

### 5. What "memory" actually means

The original spec said "cross-platform memory" once and "keep every context as small as possible" twice, without noticing they fight: unbounded shared memory dumped into every prompt is how contexts bloat. The fix is realizing "memory" was three different things wearing one name:

- **Conventions** — how this codebase works, style, commands. Lives in a committed `AGENTS.md`. Both tools load it natively; zero hive machinery. If every agent always needs it, it goes here and nowhere else.
- **Run state** — who's building what right now, task assignments, "david finished the API." Lives in the daemon's SQLite and dies with the hive session. Calling this "memory" was the conflation to kill.
- **Durable knowledge** — gotchas discovered, decisions made, "the flaky test is X." Markdown facts, one per file, plus a short index. Two scopes: **per-repo** (`.hive/memory/`, committed, travels with the clone) and **global** (`~/.hive/memory/`, where cross-project lessons accumulate so the tool improves with every project). Exposed via daemon MCP as `memory_search` / `memory_write`; the daemon serializes writes; every fact carries a date; the orchestrator prunes stale ones as housekeeping. Promoting a repo lesson to global is a file move plus re-index.

The context-budget rule that reconciles memory with small contexts: agents are injected with the merged **index only** — a few hundred tokens — and pull full facts on demand from whichever scope owns them. The store never gets dumped into a prompt. Build-vs-buy note: open-source local memory servers (agent-memory, agentmemory) are close enough to this design that we may adopt one for the durable layer rather than build; the daemon integration is the only custom part either way.

### 6. Who picks the model

The trap: "the orchestrator is smart enough to know which model." No, it isn't — an LLM's pricing and capability knowledge froze at its training cutoff, and model lineups turned over twice in the last year. An orchestrator routing from memory confidently picks superseded models forever.

The split that works: **the orchestrator classifies; a table resolves.** The orchestrator's judgment call is "this subtask is `deep` / `standard` / `cheap`" — a thing LLMs are genuinely good at and that never goes stale. A routing table maps tiers to concrete invocations — `deep` → Claude Opus, high effort; `standard` → gpt-5-codex or Sonnet; `cheap` → Haiku or codex-mini, low effort. Mechanically this is just spawn flags: `claude --model …`, `codex -c model=… -c model_reasoning_effort=…`.

The table auto-updates so new releases aren't missed: hive fetches a **curated routing manifest** published with hive releases (provider model-list APIs give you names, not judgment — curation is the value), and your local `~/.hive/routing.toml` overrides always win. Escape hatches: pin a vendor for a session; bump a tier automatically when an agent fails or stalls — retry-with-a-bigger-model is cheap and effective. And because we're multi-vendor, the table can encode a genuinely novel policy: route *review* to the other vendor from whoever wrote the code.

### 7. What happens when a context fills up

Sensing was solved in decision 2; this is the actuator. Field evidence says quality dies long before the window fills — models start repeating themselves and contradicting locked-in decisions around ~140K tokens, well inside technical limits. So the trigger is a quality line (~65%), not "almost full."

First, prevention, which is the real mechanism: the orchestrator sizes subtasks to finish inside one healthy context, and agents spawn with a minimal briefing — task, file scope, memory index — never repo dumps. Most agents should retire at task end without ever seeing the ceiling.

When one does cross the line: the daemon notifies the orchestrator, which injects "finish your current step, commit WIP to your branch, write a handoff." The handoff is structured and machine-targeted — goal, done/remaining, decisions made, **failed approaches** — stored in run state. Hive kills the session and respawns the same agent identity in the same worktree with the handoff preloaded. Fresh window, continuous work.

We explicitly do not rely on `/compact` for anything that matters — lossy self-summarization drops constraints and failed-approach history, which are the two things a successor most needs. What we give up: warm-agent speed. A warmed-up agent that never re-reads the repo iterates fast, so we recycle at the quality line, not eagerly. Bonus loop: failed approaches from handoffs are prime candidates for the durable memory layer — that's how "the tool gets smarter" stops being a slogan.

### 8. Skills, and when to build one

The tailwind that makes this feature possible: Agent Skills became an open standard (agentskills.io, Dec 2025) and OpenAI shipped Codex support within 48 hours. One `SKILL.md` folder serves every agent in the hive regardless of vendor, and progressive disclosure means a large library costs agents almost nothing until a skill is actually used.

Storage mirrors the memory scopes: per-repo skills in `.hive/skills/` and global skills in `~/.hive/skills/`, linked at spawn into each tool's native discovery path. Write once, every vendor reads it.

The hole in the original spec was *detection* — "the orchestrator knows when a skill should be built" requires memory of past runs, which a single session doesn't have. The daemon does: it logs every task descriptor. At session end the orchestrator reviews history with a **rule of three** — same task shape done ~3 times across runs → propose a skill. Propose, not create: "I've formatted release notes three times; want a skill for it?" On yes, a cheap-tier agent authors the SKILL.md from those transcripts. Silent skill accumulation is how you get sprawl nobody audits, so creation is human-gated and skills get the same pruning policy as memory — unused for N runs, propose deletion. At spawn time, the orchestrator names the relevant skills in the briefing rather than hoping agents discover them.

### 9. Windows are viewers, not containers

The original framing — "each agent runs in a terminal window" — hides a failure mode: if the process lives in the window, closing david's window kills david mid-task. Invert it: **agents live in detached tmux sessions owned by the daemon; windows are disposable viewers.** Spawning a window means telling iTerm2 or Terminal.app (via osascript) to run `tmux attach -t hive-maya`. Closing it detaches; the agent keeps working headless; `hive watch maya` reopens the lens.

This costs nothing — decision 1 already made tmux the substrate for message injection and capture-pane monitoring — and it buys robustness plus a free `--headless` mode (SSH, CI). macOS only means two emulator adapters, auto-detected, overridable in config. Nothing in the tmux+daemon core is macOS-specific except these adapters, so the platform door stays open without a rewrite.

### 10. The orchestrator physically cannot code

"The orchestrator does no coding" is load-bearing: an orchestrator that helpfully edits files is an unsandboxed writer in the main checkout (breaking decision 3), burning its own context on diffs (breaking decision 7), outside the approval flow (breaking decision 4). And both CLIs *will* drift into coding if merely asked nicely. A system prompt is a suggestion; permissions are a constraint.

So it's mechanical: a Codex orchestrator launches with `--sandbox read-only`; a Claude orchestrator gets deny rules on Edit/Write/NotebookEdit and read-only Bash. Its only actuators are the hive MCP tools — spawn, send, status, approve, memory. Reading is encouraged (good decomposition requires browsing the code); writing is impossible. The prompt explains the role and the reflex: you want to fix that typo → spawn a cheap agent. No small-edit carve-outs — carve-outs are how invariants erode. A side benefit: a read-only orchestrator triggers almost no approvals, so its window stays clean for the two streams that matter — your conversation and the escalation queue.

### 11. The name for all of this

Stepping back, the twelve decisions compress into one architecture:

- **The daemon** is the keystone: message bus, status table, approval router, memory store, run history. Everything speaks to it over MCP, which is what makes hive vendor-neutral.
- **tmux** is the substrate: sessions are where agents live, send-keys is how they're woken, capture-pane is the fallback sensor, windows are optional lenses.
- **The orchestrator** is a read-only classifier: it decomposes, scopes, tiers, and spawns; it never touches files.
- **Agents** are sandboxed, worktree-isolated, hook-instrumented, and disposable — recycled at the context quality line via handoffs.

## Tech stack

One language for the whole system: **TypeScript on Bun, compiled to a single binary.** The decisive constraint is MCP — the daemon *is* an MCP server, and the official TypeScript SDK is the reference implementation: most mature, first to get spec features, runs on Bun. Bun buys the three things a CLI-plus-daemon needs: fast cold start, built-in SQLite (`bun:sqlite`, no native-module pain), and `bun build --compile` for a single distributable binary — `brew install hive`, not "have the right Node version." Everything hive does is process-glue and JSON, not compute, so a systems language buys nothing here.

Alternatives considered: Go is the right shape (static binary, daemon ergonomics) and would win if the MCP TS SDK didn't exist, but its SDK is younger and we'd write more code for the same result in a TS-heavy ecosystem. Rust pays systems-language tax on a scripting-language problem. Python has a miserable CLI distribution story.

The concrete choices:

- **Daemon MCP transport:** Streamable HTTP on localhost — one daemon, one endpoint, N agents. Both Claude Code and Codex configure HTTP MCP servers natively; stdio would mean a process per agent.
- **Storage:** SQLite via `bun:sqlite` — inboxes, status table, run history, one file under `~/.hive/`.
- **tmux / git / osascript:** shell out via `Bun.spawn`. No wrapper libraries; the CLIs are the API.
- **Hook glue:** the hive binary itself — Claude hooks and Codex `notify` invoke `hive event …`, which POSTs to the daemon. One code path, no curl scripts.
- **Daemon lifecycle:** on-demand spawn with a pidfile; first `hive` command starts it. launchd is v2 polish, not v1 plumbing.
- **Schemas:** Zod, shared across messages, handoffs, and the routing table (the MCP SDK is Zod-native). CLI parsing via Commander; tests via `bun test`, with the interesting coverage being integration tests driving real tmux sessions.

One deliberate boundary: emulator adapters (osascript for iTerm2/Terminal) and tool adapters (spawn flags + hook-config writers for Claude/Codex) live behind small interfaces from day one. Those are the only two places vendor and platform specifics are allowed, and they're exactly where v2 grows (new terminals, Gemini CLI).

## Roadmap: the dogfooding arc

The sequencing principle: nothing in v1 learns. Learning features compound on top of a working loop and are wasted effort if the loop isn't proven. So: build the core loop until it's usable, then **use hive to build hive**, then add the learning layer with the tool's own help.

**v1 — prove the thesis.** Daemon (SQLite, MCP: spawn/status/send/inbox, send-keys delivery). `hive claude` / `hive codex` launching a read-only orchestrator with hive MCP attached. Agent spawning: named agents (human first names from a pool), worktree + branch per writer, sandboxed, tmux session + iTerm2/Terminal viewer window. Hooks wiring both directions; context % from transcripts, warn at 65% (no auto-respawn yet). Static routing table. Committed `AGENTS.md`. Single approval queue. Integrator agent for merges. Done means: you can sit in one window, ask for a feature, watch a Claude agent and a Codex agent build it in parallel, approve one escalation, and see it merged.

**v1.1 — make it durable (built by hive).** Handoff-and-respawn automation. The two-scope memory store with index injection. `hive watch` and reattach polish. Stuck-detection heartbeat escalations. This phase is the dogfood gate: if hive can't comfortably build these features itself, that's the most important bug report we'll ever get.

**v2 — make it self-improving.** Skills rule-of-three proposals and authoring. Auto-updating routing manifest. Cross-vendor review routing. Third tool (Grok) to cement vendor neutrality.

## Open questions and deferred bets

Named honestly, not papered over:

- **Codex-side signal fidelity, the remaining half.** The delivery mechanics are settled (spawn-time `-c` overrides for `notify` and trust — see decision 2), but detecting "Codex agent awaiting approval" and measuring Codex context usage from rollout files is still assumed, not proven.
- **Send-keys fragility.** Injecting text into a TUI is inherently timing-sensitive (the ecosystem's two-step workaround exists because the naive way corrupts input). If either CLI ships a real programmatic input channel, we take it immediately.
- **Task-shape similarity** for the skills rule-of-three is undefined — embedding similarity? Orchestrator judgment over descriptors? Deferred to v2 with the feature.
- **Build-vs-buy on durable memory.** The three-layer design is settled; whether layer three is built or adopted from agent-memory/agentmemory is a v1.1 decision.
- **The parallelism ceiling.** We accept the 2–4 writer consensus but haven't tested where hive's coordination actually breaks. The orchestrator should learn to say "this task doesn't parallelize."
- **The existential bet.** Agent teams going multi-vendor, or Conductor growing an AI orchestrator, both compress our gap. The counter is speed and neutrality — being the layer neither vendor can be. If that stops being true, hive is a very nice personal tool and that's the honest floor.
