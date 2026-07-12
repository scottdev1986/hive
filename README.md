<p align="center">
  <img src="assets/hive_logo.png" alt="Hive — a bee and honeycomb logo" width="640">
</p>

**Run a team of AI coding agents from one terminal, and watch them work.**

[![release](https://github.com/scottdev1986/hive/actions/workflows/release.yml/badge.svg)](https://github.com/scottdev1986/hive/actions/workflows/release.yml)
[![latest](https://img.shields.io/github/v/release/scottdev1986/hive)](https://github.com/scottdev1986/hive/releases/latest)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Hive is a macOS command-line tool that turns the AI coding CLIs you already have — [Claude Code](https://code.claude.com/docs) and [Codex](https://developers.openai.com/codex) — into a coordinated team. You talk to one orchestrator like you'd talk to a tech lead: *"build this feature"*, *"find out why the tests are flaky"*, *"have a second model review the auth code"*. The orchestrator doesn't write code itself. It splits the work, picks a tool and model for each piece (capable models for hard problems, cheap ones for chores), and spawns agents that each get their own live terminal. Agents work in isolated copies of your repo, and finished work is merged back one gate at a time.

> Hive is young. Releases are 0.0.x and things will change between versions; if you hit something broken, an issue report is genuinely useful right now.

## What it looks like

Running `hive` opens the Workspace: one window, the orchestrator front and center, and every agent as a live terminal pane running the real Claude Code, Codex, or Grok interface. In the orchestrator pane:

```
you  > add rate limiting to the public API, and have the docs updated too

hive > Splitting this into 3 tasks:
       • maya  (Claude, deep tier)  — rate-limit middleware      [pane opened]
       • david (Codex)              — apply it to the routes     [pane opened]
       • sam   (cheap tier)         — update the API docs        [pane opened]

you  > what's david doing?

hive > david finished the routes and is waiting; maya is mid-way
       through the middleware. Merging david's work…
```

Panes tile in as agents spawn and leave as they finish. Typing into a pane talks directly to that agent's own interface. The agents themselves live in background tmux sessions, so closing the window never stops one — running `hive` again reattaches the Workspace, and `hive watch <name>` opens a plain terminal window on a single agent.

### Status dot

Each agent pane's header shows a dot coloured by what that agent is actually doing right now, as reported by the daemon:

| Colour | Meaning |
| --- | --- |
| 🟢 Green | Working — actively running its task. |
| 🟡 Yellow | Idle — between turns; nothing needed from you. |
| 🔴 Red | **Needs you** — a pending approval, or paused/stuck waiting on your input. |
| 🔵 Blue | Spawning — still starting up. |
| 🟣 Purple | Done — finished its task (dims once you acknowledge it). |
| 🟠 Orange | Failed — the run ended in an error. |
| ⚪ Gray | Unknown — the agent is dead, the status feed is down, or the status isn't one this app recognizes. Also shown on the orchestrator pane, whose activity Hive doesn't track. |

Red is measured, never guessed: it appears only when the daemon records a pending approval or a genuine block on human input — an agent that is merely idle or quiet stays yellow. If a status can't be trusted, the dot goes gray rather than pretending.

## Features

- **One conversation, many agents.** You talk to a single orchestrator; it manages the team.
- **The right model for the job.** Tasks are tiered — cheap, standard, deep, review — and each tier maps to a tool and model, so a changelog update doesn't burn the same budget as a refactor.
- **Mixed vendors on one team.** Claude Code, Codex, and Grok agents work side by side, and one vendor's model can review another's code. Grok is eligible across the routing table but preferred nowhere by default; a user pin sets the preference.
- **Quota-aware.** Hive reads real usage limits from providers when they publish them and routes around whichever measurable pool is running low. There is nothing to configure, and it never invents a number: a window it cannot measure prints `unknown`.
- **Isolated working copies.** Each agent works in its own git worktree on its own branch, and finished work reaches your main branch only through Hive's merge gate, one fast-forward at a time — main is never edited by two agents at once.
- **Permission-gated by default, full autonomy one click away.** Out of the box, agents use their vendor's permission controls and anything risky — installs, pushes, writes outside their working copy — queues for your approval. When you'd rather walk away and let them run without prompts, flip the switch in the Workspace's Agents menu (or run `hive autonomy dangerous`); it persists until you flip it back.
- **Remembers your repo.** Facts agents learn about the codebase persist as durable memory, ride into every future agent's brief, and are yours to inspect with `hive memory`.
- **An optional code map for agents.** `hive graphify enable` builds a local, code-only knowledge graph of your repo ([graphify](https://github.com/Graphify-Labs/graphify)) that agents query over MCP instead of grep-sweeping, plus a task-scoped digest injected into every agent's brief. Strictly opt-in and repo-local: installed hash-verified into Hive's own tools directory, parsed entirely on your machine with zero LLM calls, kept out of git, gone with `hive graphify disable --purge`. Graph answers are treated as hints, never authority, and nothing in Hive ever waits on the graph.
- **Steerable mid-flight.** Redirect an agent, or pause and stop it, while it works. A stopped agent's work is preserved, never half-merged.
- **No black boxes.** Every agent is a live terminal you can watch, scroll, and reopen.

## Requirements

- macOS (Apple Silicon or Intel)
- tmux (`brew install tmux`) and git
- iTerm2 or the built-in Terminal app (for `hive watch` viewer windows)
- At least one AI coding CLI, installed and signed in: [Claude Code](https://code.claude.com/docs), [Codex](https://developers.openai.com/codex), and/or [Grok](https://docs.x.ai/build/overview)
- [uv](https://docs.astral.sh/uv/) — only if you opt into `hive graphify`; everything else works without it

Hive uses your existing Claude, OpenAI, or SuperGrok subscriptions or API keys and adds no fees of its own. Hive checks the Grok CLI's version, and on a version whose catalog it has not verified it declines to read the catalog rather than guess at its shape.

## Installation

```sh
curl -fsSL https://raw.githubusercontent.com/scottdev1986/hive/main/install.sh | sh
```

The script downloads the latest release, verifies every artifact's SHA-256 against the release manifest, checks that the binary runs and reports the right version, and only then links `~/.local/bin/hive`. It's [short enough to read first](install.sh), and you should. If `~/.local/bin` isn't on your PATH, the script says so. Binaries are signed with a Developer ID and notarized by Apple, so macOS runs them without a Gatekeeper prompt.

To update later, run `hive update` — it repeats those checks and additionally verifies the release manifest's Ed25519 signature against a key embedded in the binary. The new version is downloaded and staged immediately but activated only when no agents are mid-task; if you want it now, that's `hive stop && hive update`. `hive update status` shows what's active and what's retained, and `hive update rollback` reactivates the previous version. Hive also checks for new releases at session start and prints one dim line when there is one; set `HIVE_NO_UPDATE_CHECK=1` to silence the check or `HIVE_DISABLE_UPDATES=1` to turn self-update off entirely.

## Quick start

1. `cd` into any project folder (a git repository).

2. Run `hive init` once. It profiles the repo, installs Hive's agent skills for whichever CLIs you have, and brings up the project's daemon:

   ```
   $ hive init
   Profiled the repo: 1 briefable doc.
   Claude Code: installed hive-claude, hive-memory, karpathy-guidelines into .claude/skills/ (created)
   Codex: installed hive-memory, karpathy-guidelines into .agents/skills/ (created)
   Codex: left hive-codex out of .agents/skills/ — another installed CLI reads that directory too, and this skill is not addressed to it. Agents still get it in their own worktree.
   Grok: hive-memory, karpathy-guidelines already up to date; left alone.
   Grok: left hive-grok out of .agents/skills/ — another installed CLI reads that directory too, and this skill is not addressed to it. Agents still get it in their own worktree.
   ready — /Users/you/my-project (daemon port 4483)
   `hive` opens the Workspace; `hive claude` starts an orchestrator
   ```

3. Run `hive`. The Workspace opens: the orchestrator front and center, agents joining as live terminal panes.

4. Tell the orchestrator what you want done, in plain English. Watch the agent panes; type into any pane to talk to that agent directly. From any other terminal, `hive status` shows the team and `hive stop` winds it down.

`hive claude`, `hive codex`, and `hive grok` do the same as `hive`, but choose which vendor's CLI runs the orchestrator.

## Commands

| Command | What it does |
|---|---|
| `hive` | Bring up the project's daemon and open the Workspace |
| `hive init` | Profile the repo, install agent skills, seed memory, and bring up the daemon — no window (`--refresh` re-profiles only) |
| `hive claude` / `hive codex` / `hive grok` | Open the Workspace with that vendor's CLI as the orchestrator |
| `hive status` | Show all agents, their model, status, context use, and task |
| `hive autonomy [mode]` | Show or set writer autonomy: `sandboxed` (default) or `dangerous` |
| `hive quota` | Show remaining capacity per provider, with reservations and reset times |
| `hive graphify <enable\|disable\|status>` | Opt this repo into a local code knowledge graph agents can query (`disable --purge` removes every trace) |
| `hive watch <name>` | Open a terminal window viewing one agent |
| `hive recover [name]` | Resume crashed agent sessions |
| `hive memory <search\|read\|write\|delete\|reindex>` | Inspect and edit the durable facts Hive has learned about the repo |
| `hive stop` | Stop live agents and the daemon |
| `hive update` | Install the latest release (`check`, `status`, `rollback`, `skip`) |

`hive quota` shows what routing sees — the provider windows Hive can read, plus what's already reserved for running agents. A provider that does not publish a remaining level is shown as unknown:

```
$ hive quota
claude/default/subscription (max) [discovered, fresh]
  5h: 89.0% of 100.0% remaining, 8.0% reserved (est), reset 2026-07-12T04:20:00.000Z [reported from statusline]
  week: 91.5% of 100.0% remaining, 1.5% reserved (est), reset 2026-07-18T19:00:00.000Z [reported from statusline]
codex/default/codex (prolite) [discovered, fresh]
  5h: 44.0% of 100.0% remaining, 0.0% reserved (est), reset 2026-07-11T23:59:20.000Z [estimated from provider]
  week: 88.3% of 100.0% remaining, 0.0% reserved (est), reset 2026-07-18T13:59:08.000Z [estimated from provider]
grok/default/*: LIMITS UNKNOWN — Hive has not read live limits from grok yet; usage is unknown and routing is unconstrained
  hive-local estimate only: 0.0 reserved, 0.0 spent by hive in 5h, 0.0 spent by hive in week (not the account's usage)
```

Grok's remaining quota is not measurable: the only billing surface its CLI exposes reports pay-as-you-go rails rather than subscription usage, and those rails do not move when the subscription is used. So Hive never shows a Grok percentage — it reports Grok's capacity as unknown and says so, rather than inferring a number it cannot read. Hive discovers the models available to the signed-in account with the free, session-free `grok models` command rather than keeping a model list in the binary.

## Configuration

None required. If you want to change the defaults, Hive reads three optional files:

- `~/.hive/config.toml` — `autonomy = "dangerous"` runs agents without permission prompts (the default, `"sandboxed"`, queues risky actions for approval); the Workspace's Agents menu and `hive autonomy` set this for you. `layout = "off"` stops Hive from arranging its windows — it only ever moves its own windows either way, never anything else you have open. `terminal = "iterm2"` or `"terminal"` pins which app viewer windows open in.
- `~/.hive/routing.toml` — override which tool and model serve each task tier (`cheap`, `standard`, `deep`, `review`).
- `~/.hive/quota.toml` — overlay your own planning allowances and warning thresholds on top of the limits Hive discovers from the providers.

## FAQ

**Is it safe to let agents run on my machine?**
By default, yes, in the same sense as running the vendor CLIs yourself: each agent works in its own git worktree on its own branch, and anything beyond that — installs, pushes, publishing — waits in an approval queue until you say yes. Nothing reaches your main branch except a fast-forward merge through Hive's gate. If the prompts get in your way, the Agents menu (or `hive autonomy dangerous`) turns them off — that is the same trust as `claude --dangerously-skip-permissions`, so flip it knowingly.

**What does it cost?**
Whatever your Claude, OpenAI, or SuperGrok plans already cost. Hive routes easy tasks to cheaper models specifically to keep your usage down.

**Do I need Claude Code, Codex, and Grok?**
No, one is enough. With more than one installed, Hive can mix them on one team and route each task to whichever fits best.

**What happens to my code?**
Agents work on isolated branches and the work is merged step by step, so your main branch is never edited by multiple agents at once. Everything stays on your machine except the AI API calls your CLIs already make.

**Can I run two projects at once?**
Not yet — Hive runs one project's daemon at a time, and starting a second project tells you so. `hive stop` the first, then start the second.

**Why is it macOS-only?**
The first version targets the platform it can integrate with best. The core design isn't Mac-specific, so other platforms can follow.

## Contributing

Issues and pull requests are welcome. The CLI is TypeScript on [Bun](https://bun.sh); the Workspace app is Swift/AppKit.

```sh
bun install
bun test
bun run typecheck
```

## License

[MIT](LICENSE)
