# 🐝 hive

**Run a team of AI coding agents from one terminal — and watch them work.**

Type `hive claude` in any project folder. A terminal opens with an AI orchestrator that you talk to like a tech lead: *"build this feature,"* *"find out why the tests are flaky,"* *"have a second model review the auth code."* The orchestrator doesn't write code itself — it breaks the work down, picks the right AI tool and model for each piece (Claude Code or Codex, powerful models for hard problems, cheap ones for simple tasks), and spawns agents that each appear in their own terminal window so you can watch them work in real time. Agents coordinate with each other, work is merged safely when it's done, and anything risky comes back to you for a yes/no first.

> **Status: in active development — not yet released.** Star or watch the repo to be notified when the first version ships. The full design is public in [SPEC.md](SPEC.md).

## What it looks like

```
$ cd my-project
$ hive claude

🐝 hive orchestrator ready.

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

Each agent works in its own window. Close a window any time — the agent keeps working in the background, and you can reopen its view whenever you like.

## Why people use it

- **One conversation, many agents.** You talk to a single orchestrator; it manages the team.
- **The right model for the job.** Complex work goes to powerful models, simple work to fast cheap ones — automatically, so you're not overpaying for changelogs or under-powering refactors.
- **Mixed tools on one team.** Claude Code and Codex agents work side by side and can even talk to each other — including having one vendor's model review the other's code.
- **Safe by default.** Every agent is sandboxed to its own isolated copy of your project. Anything irreversible — publishing, pushing, spending — comes to you for approval in one place.
- **Watchable.** Every agent gets its own live terminal window. No black boxes.

## Requirements

- **macOS** (Apple Silicon or Intel) — hive is macOS-only for now
- **A terminal**: iTerm2 or the built-in Terminal app
- **tmux** (`brew install tmux`)
- **git**
- At least one AI coding CLI, installed and signed in:
  - [Claude Code](https://code.claude.com/docs) (Anthropic) — and/or
  - [Codex CLI](https://developers.openai.com/codex) (OpenAI)

hive uses your existing Claude / OpenAI subscriptions or API keys. It adds no fees of its own.

## Installation

*Coming with the first release:*

```
brew install hive
```

Until then, this repository contains the project's design and documentation.

## Quick start (once installed)

1. `cd` into any project folder (a git repository).
2. Run `hive claude` (or `hive codex` to use a Codex orchestrator).
3. Tell the orchestrator what you want done, in plain English.
4. Watch the agent windows, and answer the occasional approval prompt in the orchestrator window.

Useful commands:

| Command | What it does |
|---|---|
| `hive claude` / `hive codex` | Start an orchestrator in the current folder |
| `hive status` | Show all running agents and what they're doing |
| `hive watch <name>` | Reopen a closed agent window (e.g. `hive watch maya`) |
| `hive stop` | Wind down all agents cleanly |

## FAQ

**Is it safe to let agents run on my machine?**
Agents run sandboxed: each one can only write inside its own isolated working copy of your project. Anything beyond that — publishing packages, pushing to remotes, installing outside the sandbox — is blocked until you approve it. You review one approval queue, in one window.

**What does it cost?**
Whatever your Claude / OpenAI plans already cost. hive routes easy tasks to cheaper models specifically to keep your usage down.

**Do I need both Claude Code and Codex?**
No — one is enough. With both installed, hive can mix them on one team and route each task to whichever fits best.

**Can I close agent windows?**
Yes. Windows are just live views — closing one never stops the agent. `hive watch <name>` brings the view back.

**What happens to my code?**
Agents work on isolated branches and the work is merged step by step, so your main branch is never edited by multiple agents at once. Everything stays local to your machine except the AI API calls your CLIs already make.

**Why is it macOS-only?**
The first version targets the terminals we can integrate with best (iTerm2, Terminal.app). The core design isn't Mac-specific, so other platforms can follow.

## Documentation

- [SPEC.md](SPEC.md) — the full design: what hive is, every architecture decision and why, the roadmap, and the open questions.

## License

[MIT](LICENSE)
