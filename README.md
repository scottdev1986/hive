<p align="center">
  <img src="assets/hive_logo.png" alt="Hive — a bee and honeycomb logo" width="640">
</p>

[![release](https://github.com/scottdev1986/hive/actions/workflows/release.yml/badge.svg)](https://github.com/scottdev1986/hive/actions/workflows/release.yml)
[![latest](https://img.shields.io/github/v/release/scottdev1986/hive)](https://github.com/scottdev1986/hive/releases/latest)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Hive coordinates Claude Code, Codex, and Grok agents in a native macOS Workspace. A read-only orchestrator delegates work; each worker gets an isolated git worktree, branch, capability, and tmux session. The daemon owns process lifecycle and merges completed branches into `main` through a serialized fast-forward gate.

Hive is currently a 0.0.x project. Its command and storage contracts may change between releases.

## Workspace

Run `hive` in an initialized repository to open one Workspace window for that Hive instance. The orchestrator is the master pane and worker agents appear as SwiftTerm panes attached to their daemon-owned tmux sessions. The vendor TUI remains interactive: clicking a pane focuses it, and typing goes directly to that Claude Code, Codex, or Grok session.

Agent state comes from structured daemon events, not terminal scraping. Unknown or disconnected state is displayed as unknown rather than inferred from pane contents.

Closing an agent pane requests `hive kill` for that agent. The daemon preserves unlanded work and verifies that the tmux session and owned process tree are gone; a failed kill is reported and the pane returns. Closing the Workspace normally runs `hive stop`, which stops the instance's agents and daemon. An unexpected UI crash does not own the agent processes, so their tmux sessions remain recoverable.

## Requirements

- macOS on Apple Silicon or Intel
- git and tmux (`brew install tmux`)
- At least one signed-in agent CLI: [Claude Code](https://code.claude.com/docs), [Codex](https://developers.openai.com/codex), or [Grok](https://docs.x.ai/build/overview)

The release includes the CLI and Workspace app. Bun, Swift, Python, and `uv` are not required to use an installed release.

## Installation

```sh
curl -fsSL https://raw.githubusercontent.com/scottdev1986/hive/main/install.sh | sh
```

The installer supports macOS only. It requires non-empty Hive manifest signature material, downloads the CLI and Workspace app, checks both SHA-256 digests against the release manifest, runs the candidate CLI and verifies its reported version, then atomically updates `~/.local/bin/hive`. If `~/.local/bin` is not on `PATH`, it prints the required change.

Portable shell does not verify the manifest's Ed25519 signature; presence is required, but first-install authenticity still rests on TLS and GitHub Release hosting. The installer stores the exact manifest and signature so Hive can verify them before a future rollback. Native `hive update` is stricter: it requires a valid signature from an embedded release key, checks artifact hashes, and probes the candidate before activation. See [distribution](docs/release/distribution.md) for the complete trust boundary.

## Quick start

From a git repository:

```sh
cd /path/to/repository
hive init
hive
```

`hive init` profiles the repository, installs the agent skills used by the CLIs present on the machine, offers the optional local Graphify integration, and starts an instance daemon on an ephemeral loopback port. It is safe to run again; use `--refresh` only when you want to force the repository profile to be rebuilt. Use `hive init --no-graphify` to skip the Graphify prompt.

Bare `hive` opens the Workspace with Claude as the default orchestrator. To choose another installed vendor explicitly, run `hive codex` or `hive grok`; `hive claude` is the explicit Claude spelling.

## Commands

| Command | Purpose |
| --- | --- |
| `hive` | Start or reuse this instance and open its Workspace |
| `hive init [--refresh]` | Profile the repository, install agent skills, seed memory, and start the daemon |
| `hive claude`, `hive codex`, `hive grok` | Open the Workspace with that read-only orchestrator |
| `hive status` | Show agent name, tool, model, state, context use, task, and failure |
| `hive kill <agent>` | Stop one agent and preserve any unlanded work |
| `hive recover [name]` | Resume one or all recoverable crashed sessions |
| `hive stop` | Stop the instance's live agents and daemon |
| `hive autonomy [sandboxed\|dangerous]` | Read or change writer-agent autonomy |
| `hive routing ...` | Read and edit provider, model, effort, selection, and fallback-chain policy |
| `hive quota` | Show provider capacity, reservations, provenance, and reset times |
| `hive memory ...` | Search, read, write, delete, or reindex durable memory articles |
| `hive graphify enable\|disable\|status` | Manage the optional local code graph for this repository |
| `hive update [version]` | Install the latest or an exact release |
| `hive update check\|status\|rollback\|skip` | Check, inspect, roll back, or skip an offered release |
| `hive uninstall [--repo]` | Remove the machine installation, or only this repository's Hive state |
| `hive instances` | List the default and named Hive instances |

Run `hive <command> --help` for the complete options. Hook, bridge, credential, daemon, and statusline commands also appear in `hive --help`; they are process-integration surfaces rather than normal interactive workflow commands.

## Isolation and multiple instances

The default instance stores state under `~/.hive`. A named instance uses its own home under `~/.hive/instances/<name>`:

```sh
hive --instance client-a init
hive --instance client-a
hive instances
```

Instances have separate identity, daemon lock, ephemeral port, handshake, database, credentials, tmux namespace, worktrees, and owned branches. Repository landing is serialized across instances. Provider quota is deliberately machine-wide because it belongs to the signed-in vendor account, not to one Hive instance.

Machine-wide update, rollback, and uninstall operations refuse while any instance has a live or unobservable team. Repository uninstall removes only state and branches owned by the selected instance.

## Autonomy and routing

Writer agents default to `sandboxed`: vendor permission controls remain active and risky operations enter Hive's approval path. `hive autonomy dangerous` removes those prompts for future spawns and resumes; it is equivalent to granting the underlying agent CLI broad access, so use it deliberately. Orchestrators remain read-only in either mode.

Routing is explicit policy, not a compiled model ranking. The Model Control Center and `hive routing` keep provider consent, model consent, effort, automatic selection, exact selection, and ordered fallback chains as separate values. Hive uses provider quota readings when available and prints `unknown` when a meter cannot be read; it does not turn missing telemetry into zero.

## Optional configuration

No configuration file is required.

- `~/.hive/config.toml` controls writer autonomy, the Codex driver, Claude Channels, resource limits, and idle-agent reaping. The Workspace Agents menu and `hive autonomy` persist the autonomy value here.
- Routing policy is stored in Hive's SQLite control store and edited through the Model Control Center or `hive routing`.
- `~/.hive/quota.toml` can overlay planning estimates, reserves, warning thresholds, refresh cadence, and account/model-specific limits on provider discovery.

Hive rejects unknown configuration keys instead of silently ignoring misspellings.

## Updates and rollback

`hive update` downloads and verifies the safe half before it tries to activate anything. Activation then holds the machine mutation lease and repeats an all-instance liveness check. If any team is live or cannot be observed, the release stays staged and the command explains what must stop.

`hive update rollback` works offline but is not an unsigned shortcut: it re-verifies the retained version's signed manifest and CLI hash before changing `current`. A legacy release without rollback verification material must be reinstalled first.

Set `HIVE_NO_UPDATE_CHECK=1` to disable passive update checks, or `HIVE_DISABLE_UPDATES=1` to disable both checks and manual self-update.

## Development

The CLI and daemon are TypeScript on Bun; the Workspace is Swift/AppKit. From a checkout:

```sh
bun install
bun test
bun run typecheck
```

Issues and focused pull requests are welcome.

## License

[MIT](LICENSE)
