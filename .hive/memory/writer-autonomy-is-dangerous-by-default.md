---
title: Writer autonomy is dangerous-by-default; per-CLI mechanics
date: 2026-07-10
tags: [autonomy, permissions, spawn, claude, codex, channels, trust]
---

Hive writer agents launch fully autonomous by default: config `autonomy = "dangerous"` (src/schemas/config.ts). Landed 378460b. `autonomy = "sandboxed"` restores the old approval queue. See SPEC §4 (rewritten) and docs/model-selection.md.

Per-CLI mechanics, verified 2026-07-10 on claude 2.1.206 / codex-cli 0.144.0.

Claude opens a fresh agent worktree on THREE separate blocking dialogs. All were measured by driving the real CLI in a pty/tmux with an isolated HOME (src/daemon/launch-watch.test.ts reproduces it):

1. Folder trust ("Do you trust the files in this folder?"). Suppress by seeding `projects["<worktree realpath>"].hasTrustDialogAccepted = true` in ~/.claude.json before launch. Key on the worktree's OWN realpath: trust resolves by walking up from cwd, so the worktree key alone works and the repo root is never touched. (Accepting the dialog by hand instead records it against the MAIN repo path for a linked worktree — do not copy that behaviour.) `/tmp` and `/var` are symlinks on macOS, so resolve the path or the key silently never matches. Trust is not just the dialog: an untrusted workspace makes the CLI DISCARD project-scoped hooks and permission rules from .claude/settings.local.json — Hive would lose its event stream and a read-only agent would lose its deny list.

2. Bypass-permissions disclaimer. CORRECTION to the earlier version of this fact: `permissions.defaultMode = "bypassPermissions"` in settings.local.json DOES raise the dialog — the CLI keys it on the mode, not on how the mode arrived. What clears it is `skipDangerousModePermissionPrompt: true`, honoured from any settings source including the worktree's own settings.local.json. The earlier "no dialog" observation was an artifact: Scott has `skipDangerousModePermissionPrompt: true` in ~/.claude/settings.json, masking it. Still DO NOT pass `--dangerously-skip-permissions` (`--allow-dangerously-skip-permissions` does not suppress it either, and accepting does not persist).

3. Development-channels warning ("I am using this for local development"). UNSUPPRESSABLE. Hive's channel-bridge is a `server:` channel, which loads only behind `--dangerously-load-development-channels`, and that flag always raises the dialog. Accepting persists NOTHING — no flag, no settings key — so there is nothing to pre-seed. Plain `--channels server:hive-channel` skips the dialog but the CLI then refuses to register the channel (silent no-op). The only allowlist, `allowedChannelPlugins`, reads exclusively from enterprise managed settings (/Library/Application Support/ClaudeCode/managed-settings.json, root-owned, machine-wide) and covers plugin channels only, never `server:` entries. Therefore: spawned agents NEVER launch with Channels (they use the tmux fallback); only the attended orchestrator does, because a human can answer once. Landed in the fix for this.

Note the dialog only fires when Channels are actually enabled (`cachedGrowthBookFeatures.tengu_harbor`), auth is firstParty, and org policy does not block — so a test with a bare fake HOME will pass even if the flag comes back. launch-watch seeds tengu_harbor to keep the guard armed.

Codex: `-c approval_policy="never" -c sandbox_mode="danger-full-access"` (TUI renders "permissions: YOLO mode"). Directory-trust prompt is separately suppressed by the existing `projects."<path>".trust_level="trusted"` override.

Invariants that must hold in any refactor: read-only sessions (the orchestrator per SPEC §11, and the replacement process a critical control spawns per SPEC §1) pass readOnly, which short-circuits the autonomy branch in BOTH adapters — a revoked agent must never regain shell access via a config default. They still get the trust seed, because their deny list is a project-scoped rule the CLI would otherwise drop. Crash recovery (src/daemon/recovery.ts) resumes with the same autonomy AND re-seeds trust, or an unattended recovered agent silently stalls at a prompt.

Anything that cannot be scoped to a Hive worktree, Hive does not touch: `hasCompletedOnboarding` and auth are account-level. Tests that exercise the spawn path must override `Bun.env.HOME` — note `os.homedir()` ignores a reassigned HOME (it reads passwd), so the adapter resolves `process.env.HOME ?? homedir()`; without that the suite writes junk project entries into the operator's real ~/.claude.json.

Cost accepted: the sandbox no longer enforces decision 3's file scopes (honor system now); the resource watchdog (SPEC §12) is the only mechanical floor. Landing is still gated by red-tests-never-merge plus the capability epoch.
