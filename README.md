```
       \       /        ██   ██ ███████ ███████
        \ .-. /         ██   ██ ██      ██
     .---(   )---.       ███████ █████   █████
  .-'  _  \_/  _  `-.    ██   ██ ██      ██
 /   .-==|===|==- .  \   ██   ██ ███████ ███████
 \__/  ==|===|==  \__/   ~  ~  ~
    `---._|_.---'       ~  ~  ~
```

**Run a team of AI coding agents from one terminal — and watch them work.**

Type `hive claude` in any project folder. A terminal opens with an AI orchestrator that you talk to like a tech lead: *"build this feature,"* *"find out why the tests are flaky,"* *"have a second model review the auth code."* The orchestrator doesn't write code itself — it breaks the work down, picks the right AI tool and model for each piece (Claude Code or Codex, powerful models for hard problems, cheap ones for simple tasks), and spawns agents that each appear in their own terminal window so you can watch them work in real time. Agents coordinate with each other, work is merged safely when it's done, and anything risky comes back to you for a yes/no first.

> **Status: in active development — not yet released.** Star or watch the repo to be notified when the first version ships. The full design is public in [SPEC.md](SPEC.md).

The repository also contains a runnable foundation for Hive Workspace, the native macOS surface described by the design. It is a Swift 6.3/AppKit SwiftPM package in [`workspace/`](workspace/): it multiplexes project windows, tiles master and satellite panes deterministically with promotion and spatial focus, follows macOS-native HIG styling, models status and attention, and includes a native transcript prototype driven by a mock event source. It has no daemon integration yet. Smoke-run it with:

```sh
cd workspace
swift run HiveWorkspace --smoke
```

The authenticated-XPC prototype lives in [`prototypes/authenticated-xpc/`](prototypes/authenticated-xpc/). The daemon also preserves failed-command panes for inspection and delivers orchestrator envelopes without clobbering an in-progress composer. These are implementation foundations; the design and architecture remain documented in [SPEC.md](SPEC.md) and the [Hive Workspace blueprint](docs/architecture/hive-workspace-blueprint.md).

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

Each agent works in its own window, and hive keeps the window wall tidy for you: the orchestrator sits front and center as the largest window, agent windows tile around it in even columns, and everything reflows automatically as agents join and finish. Close a window any time — the agent keeps working in the background, and you can reopen its view whenever you like.

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

```
curl -fsSL https://raw.githubusercontent.com/scottdev1986/hive/main/install.sh | sh
```

This installs the compiled `hive` binary and the Hive Workspace application into `~/.local/share/hive`, and links `~/.local/bin/hive`. Read [install.sh](install.sh) before you run it; it is short on purpose.

`hive start` checks for a newer release and prints one line if there is one. `hive update` installs it — staging and verifying immediately, activating only when no agents are live. `HIVE_NO_UPDATE_CHECK=1` silences the check; `HIVE_DISABLE_UPDATES=1` disables self-update entirely. Homebrew will be a secondary channel, and Hive will tell you to run `brew upgrade hive` rather than rewrite an install Homebrew owns.

Releases are **not yet signed or notarized**, so macOS will quarantine the binary on first run. `hive update` verifies every artifact's SHA-256 against the release manifest and tells you plainly that the release carries no Hive signature. See [docs/versioning-and-release.md](docs/versioning-and-release.md).

## Quick start (once installed)

1. `cd` into any project folder (a git repository).
2. Run `hive start`. It brings up this project's daemon and tells you if a newer Hive exists.
3. Run `hive` to open the Workspace, or `hive claude` (or `hive codex`) for a terminal orchestrator.
4. Tell the orchestrator what you want done, in plain English.
5. Watch the agent windows, and answer the occasional approval prompt in the orchestrator window.

### Quota-aware routing

Hive reserves capacity before launching an agent, then reconciles it when the turn ends. Automatic routing considers the task tier, each concrete model's five-hour and weekly headroom, in-flight reservations, and configurable reserves for deep work. A safe explicit Claude or Codex choice is honored. An unsafe explicit choice fails before launch with the remaining capacity, reset estimate, and a recommended fallback; it is never silently changed. Reviews can name the tool that authored the work so Hive prefers the other vendor when both have capacity.

**There is nothing to configure.** Hive reads your real limits from the providers themselves, at every start and periodically thereafter. Codex answers `account/rateLimits/read` over its app-server; Claude Code answers a `get_usage` control request. Neither call starts a model turn, so neither costs a token. Both report the *percentage* of each window consumed and the moment it resets, so Hive discovers your pools, denominates them in percent, and reserves against measured headroom:

```
$ hive quota
claude/default/subscription (max) [discovered, fresh]
  5h: 91.0% of 100.0% remaining, 8.0% reserved (est), reset 2026-07-10T19:00:00Z [reported from provider]
  week: 57.0% of 100.0% remaining, 1.5% reserved (est), reset 2026-07-11T19:00:00Z [reported from provider]
codex/default/codex (prolite) [discovered, fresh]
  5h: 41.0% of 100.0% remaining, 0.0% reserved (est), reset 2026-07-10T18:25:18Z [authoritative from provider]
  week: 59.0% of 100.0% remaining, 0.0% reserved (est), reset 2026-07-16T22:11:53Z [authoritative from provider]
```

Accurate numbers only. A window Hive has not measured prints `unknown`, never a zero — and a reading whose reset has passed is discarded rather than carried forward, because you spend these accounts outside Hive too. The one number Hive authors itself is the reservation, its guess at what a run will consume, and it is labelled `(est)` wherever it appears. Codex's stable rate-limit method is `authoritative`; Claude's `get_usage`, which the CLI marks experimental, is `reported`; Hive's own ledger is `estimated`; anything absent or aged out says so. Hive does not scrape either CLI's terminal display, and it does not call Anthropic's undocumented usage endpoint directly.

When a provider cannot answer — not signed in, probe failed — Hive says which provider and why, keeps routing on the legacy path, and adopts real numbers the moment the provider answers. It never invents an allowance, because allowances decide when spawns are *refused*, and a wrong number there stops work rather than merely misleading a dashboard.

Model-scoped caps (a premium model with its own weekly ceiling) are discovered and displayed, but Hive will not route on them: providers name them `"Fable"` or `"GPT-5.3-Codex-Spark"` without a concrete model id, and guessing which model that means could refuse a spawn for the wrong reason.

Optionally, `~/.hive/quota.toml` can override a discovered pool with your own planning units and thresholds. It is never required, and Hive maps the provider's percentages onto whatever allowance you declare:

```toml
warningRemainingPct = 0.25
criticalRemainingPct = 0.10
refreshIntervalMinutes = 15

# Hive's own estimate of what one run costs, as a percent of each window.
[estimatesPct.deep]
fiveHour = 8
weekly = 1.5

[[limits]]
provider = "codex"
account = "default"
pool = "codex"           # must match the discovered pool to override it
models = ["*"]
fiveHourAllowance = 100
weeklyAllowance = 500
weeklyWindow = "calendar"
timezone = "America/New_York"
resetWeekday = 1 # Sunday=0, Monday=1
resetHour = 0
```

Rolling windows include usage exactly on the cutoff and expire it immediately after. Calendar weeks use the configured IANA timezone; a reset minute skipped by daylight saving moves to the first valid local minute after the gap. Stale observations remain visible and are combined conservatively with newer ledger entries.

Record a dashboard reading by hand, if you ever need to:

```sh
hive quota reconcile --provider codex --account default \
  --pool codex --five-hour-used 62 --weekly-used 180 \
  --five-hour-reset-at 2026-07-09T18:00:00-04:00
```

Warning and critical alerts travel through the same durable orchestrator inbox as agent reports. Each pool/window alert fires on a threshold crossing, escalates once from warning to critical, and rearms only after the reset changes or capacity recovers past the threshold plus hysteresis. `hive quota` shows confidence, freshness, reservations, and known reset times without exposing raw SQLite state. See [SPEC.md](SPEC.md#6-who-picks-the-model) for the policy and limitations.

Read-only processes started to acknowledge critical controls are accounted for too. Hive settles the interrupted run, then creates a separate reservation for the acknowledgement process on the agent's recorded provider and concrete model. It never re-resolves `routing.toml` or substitutes another model. The control reservation settles on acknowledgement, completion, death, kill, reconciliation, launch failure, daemon recovery, or timeout; a timed-out process is stopped so it cannot continue outside a reservation.

Useful commands:

| Command | What it does |
|---|---|
| `hive claude` / `hive codex` | Start an orchestrator in the current folder |
| `hive status` | Show all running agents and what they're doing |
| `hive quota` | Show quota headroom, reservations, reset estimates, and telemetry confidence |
| `hive quota reconcile …` | Record a provider-dashboard usage observation |
| `hive watch <name>` | Reopen a closed agent window (e.g. `hive watch maya`) |
| `hive stop` | Wind down all agents cleanly |

### Changing direction while an agent works

Hive distinguishes ordinary coordination from controls that reduce an agent's authority. Normal messages wait for the next turn boundary. Urgent directions interrupt at the next safe boundary and require acknowledgement. Critical controls—pause, stop, cancel, or do-not-modify—revoke the agent's write and landing capability first, preserve its worktree, stop only its process, and restart it read-only with the instruction already in context. The restart is pinned to the exact provider, model, and immutable launch settings recorded at the original spawn; editing the route table while an agent runs cannot change it.

The orchestrator sends these as structured `hive_send` requests with `priority` and `intent`; those fields are preferred over prose. Send results report `queued`, `injected`, `agent-acknowledged`, or `applied`. A queued result means exactly that: the agent has not seen it yet. Missed urgent or critical acknowledgement deadlines wake the orchestrator once without polling. For compatibility, a small set of unambiguous commands such as “stop now” and “pause before coding” are promoted to critical, but operators should rely on structured intent.

If the recorded model is no longer available, the row predates recorded execution identities, or there is not enough quota to reserve the acknowledgement process, Hive fails closed. It never re-enables writes and never switches models: the process remains stopped, landing stays revoked, the worktree and queued control remain durable, and the orchestrator receives an actionable alert. The stale viewer closes and the remaining Hive windows re-layout; a successful retry opens a fresh viewer on the same tmux identity. Legacy rows may therefore require the operator to finish the paused work from a newly spawned agent after reviewing the alert.

## FAQ

**Is it safe to let agents run on my machine?**
Agents run sandboxed: each one can only write inside its own isolated working copy of your project. Anything beyond that — publishing packages, pushing to remotes, installing outside the sandbox — is blocked until you approve it. You review one approval queue, in one window.

**What does it cost?**
Whatever your Claude / OpenAI plans already cost. hive routes easy tasks to cheaper models specifically to keep your usage down.

**Do I need both Claude Code and Codex?**
No — one is enough. With both installed, hive can mix them on one team and route each task to whichever fits best.

**Can I close agent windows?**
Yes. Windows are just live views — closing one never stops the agent. `hive watch <name>` brings the view back.

**Can I stop hive from moving my windows?**
Yes. hive only ever arranges its own windows — the orchestrator and agent viewers — and never touches anything else you have open. To keep hive's windows where you put them, set `layout = "off"` in `~/.hive/config.toml`.

**What happens to my code?**
Agents work on isolated branches and the work is merged step by step, so your main branch is never edited by multiple agents at once. Everything stays local to your machine except the AI API calls your CLIs already make.

**Why is it macOS-only?**
The first version targets the terminals we can integrate with best (iTerm2, Terminal.app). The core design isn't Mac-specific, so other platforms can follow.

## Documentation

- [SPEC.md](SPEC.md) — the full design: what hive is, every architecture decision and why, the roadmap, and the open questions.
- [Hive Workspace blueprint](docs/architecture/hive-workspace-blueprint.md) — the canonical Swift/AppKit destination architecture, safety gates, and open prototypes.
- [Hive Workspace foundation](workspace/README.md) — how to build and smoke-run the landed native UI prototype.
- [Authenticated-XPC prototype](prototypes/authenticated-xpc/README.md) — the runnable capability and peer-authentication prototype.
- [Restart handoff](docs/architecture/restart-handoff.md) — the ordered, restart-safe continuation checklist and Phase 0 boundary.
- [Model routing and token efficiency](docs/research/model-routing-and-token-efficiency.md) — the companion provider-choice, escalation, and cost policy.
- [Cross-vendor architecture review](research/cross-vendor-architecture-review.md) — driven Claude/Codex and macOS evidence behind the flagship corrections.

## License

[MIT](LICENSE)
