```
░██     ░██ ░██████░██    ░██ ░██████████ 
░██     ░██   ░██  ░██    ░██ ░██         
░██     ░██   ░██  ░██    ░██ ░██         
░██████████   ░██  ░██    ░██ ░█████████  
░██     ░██   ░██   ░██  ░██  ░██         
░██     ░██   ░██    ░██░██   ░██         
░██     ░██ ░██████   ░███    ░██████████ 
                                          
```

**Run a team of AI coding agents from one terminal, and watch them work.**

[![release](https://github.com/scottdev1986/hive/actions/workflows/release.yml/badge.svg)](https://github.com/scottdev1986/hive/actions/workflows/release.yml)
[![latest](https://img.shields.io/github/v/release/scottdev1986/hive)](https://github.com/scottdev1986/hive/releases/latest)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Hive is a macOS command-line tool that turns the AI coding CLIs you already have — [Claude Code](https://code.claude.com/docs) and [Codex](https://developers.openai.com/codex) — into a coordinated team. You talk to one orchestrator like you'd talk to a tech lead: *"build this feature"*, *"find out why the tests are flaky"*, *"have a second model review the auth code"*. The orchestrator doesn't write code itself. It splits the work, picks a tool and model for each piece (capable models for hard problems, cheap ones for chores), and spawns agents that each get their own live terminal window. Agents work in isolated copies of your repo, the results are merged step by step, and anything irreversible comes back to you for a yes/no first.

> Hive is young. Releases are 0.0.x and things will change between versions; if you hit something broken, an issue report is genuinely useful right now.

## What it looks like

```
$ cd my-project
$ hive claude

hive orchestrator ready.

you  > add rate limiting to the public API, and have the docs updated too

hive > Splitting this into 3 tasks:
       • maya  (Claude Opus)  — rate-limit middleware      [window opened]
       • david (Codex)        — apply it to the routes     [window opened]
       • sam   (Haiku, cheap) — update the API docs        [window opened]

you  > what's david doing?

hive > david finished the routes and is waiting; maya is mid-way
       through the middleware. Merging david's work…

hive > ⚠️  sam wants to run `npm install express-rate-limit` — allow? (y/n)
```

Each agent runs in its own window, and Hive keeps the wall tidy: the orchestrator sits front and center, agent windows tile around it, and the layout reflows as agents join and finish. Closing a window never stops an agent — it keeps working in the background, and `hive watch <name>` brings the view back.

## Features

- **One conversation, many agents.** You talk to a single orchestrator; it manages the team.
- **The right model for the job.** Hard problems go to capable models, chores go to fast cheap ones, so a changelog update doesn't burn the same budget as a refactor.
- **Mixed vendors on one team.** Claude Code and Codex agents work side by side, and one vendor's model can review the other's code.
- **Quota-aware.** Hive reads your real usage limits from the providers themselves and routes around whichever pool is running low. There is nothing to configure, and it never invents a number: a window it hasn't measured prints `unknown`.
- **Sandboxed by default.** Each agent can only write inside its own isolated working copy. Publishing, pushing, installing outside the sandbox — all of it waits in one approval queue until you say yes.
- **Steerable mid-flight.** Redirect an agent, or pause and stop it, while it works. A stopped agent's work is preserved, never half-merged.
- **No black boxes.** Every agent is a live terminal you can watch, scroll, and reopen.

## Requirements

- macOS (Apple Silicon or Intel)
- iTerm2 or the built-in Terminal app
- tmux (`brew install tmux`) and git
- At least one AI coding CLI, installed and signed in: [Claude Code](https://code.claude.com/docs) and/or [Codex](https://developers.openai.com/codex)

Hive uses your existing Claude / OpenAI subscriptions or API keys and adds no fees of its own.

## Installation

```sh
curl -fsSL https://raw.githubusercontent.com/scottdev1986/hive/main/install.sh | sh
```

The script downloads the latest release, verifies every artifact's SHA-256 against the release manifest, checks that the binary runs, and only then links `~/.local/bin/hive`. It's [short enough to read first](install.sh), and you should. Binaries are signed with a Developer ID and notarized by Apple, so macOS runs them without a Gatekeeper prompt.

To update later, run `hive update`. Hive also checks for new versions on `hive start` and prints one line if there is one; set `HIVE_NO_UPDATE_CHECK=1` to silence the check or `HIVE_DISABLE_UPDATES=1` to turn self-update off entirely.

## Quick start

1. `cd` into any project folder (a git repository).
2. Run `hive`. It brings up the project's daemon and opens the Workspace: one window, the orchestrator front and center, and every agent as a live terminal pane running the real Claude Code or Codex interface.
3. Tell the orchestrator what you want done, in plain English.
4. Watch the agent panes, and answer the occasional approval prompt in the orchestrator pane. Typing into any pane talks directly to that agent's own interface.

Prefer plain terminals? `hive claude` / `hive codex` run the same orchestrator in the terminal you're in, with agents in their own windows.

## Commands

| Command | What it does |
|---|---|
| `hive` | Open the project's Workspace — daemon, orchestrator, and agent panes in one window |
| `hive start` | Bring up the project's daemon without opening a window |
| `hive claude` / `hive codex` | Start a terminal orchestrator in the current folder |
| `hive status` | Show all running agents and what they're doing |
| `hive quota` | Show remaining capacity per provider, with reset times |
| `hive watch <name>` | Reopen a closed agent window |
| `hive update` | Install the latest release |
| `hive stop` | Wind down all agents cleanly |

`hive quota` shows what routing sees — how much of each provider's five-hour and weekly window is left, read from the providers directly:

```
$ hive quota
claude/default/subscription (max) [discovered, fresh]
  5h: 91.0% remaining, reset 2026-07-10T19:00:00Z
  week: 57.0% remaining, reset 2026-07-11T19:00:00Z
codex/default/codex (prolite) [discovered, fresh]
  5h: 41.0% remaining, reset 2026-07-10T18:25:18Z
  week: 59.0% remaining, reset 2026-07-16T22:11:53Z
```

## Configuration

None required. If you want to change the defaults, Hive reads `~/.hive/config.toml`:

- `layout = "off"` stops Hive from arranging its windows. It only ever moves its own windows either way, never anything else you have open.
- `~/.hive/quota.toml` can optionally overlay your own planning allowances and warning thresholds on top of the limits Hive discovers from the providers.

## FAQ

**Is it safe to let agents run on my machine?**
Each agent can only write inside its own isolated working copy of your project. Anything beyond that — publishing packages, pushing to remotes, installing outside the sandbox — is blocked until you approve it, and you review one approval queue in one window.

**What does it cost?**
Whatever your Claude / OpenAI plans already cost. Hive routes easy tasks to cheaper models specifically to keep your usage down.

**Do I need both Claude Code and Codex?**
No, one is enough. With both installed, Hive can mix them on one team and route each task to whichever fits best.

**What happens to my code?**
Agents work on isolated branches and the work is merged step by step, so your main branch is never edited by multiple agents at once. Everything stays on your machine except the AI API calls your CLIs already make.

**Why is it macOS-only?**
The first version targets the terminals it can integrate with best (iTerm2, Terminal.app). The core design isn't Mac-specific, so other platforms can follow.

## Contributing

Issues and pull requests are welcome. The CLI is TypeScript on [Bun](https://bun.sh); the Workspace app is Swift/AppKit.

```sh
bun install
bun test
bun run typecheck
```

## License

[MIT](LICENSE)
