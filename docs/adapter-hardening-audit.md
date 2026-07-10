# Adapter hardening audit

The adapter layer already follows the Workspace model: tmux owns the sessions, while native windows are viewers and recovery surfaces. The audit therefore removes no adapters. It keeps the existing design and makes external commands stop predictably and reject malformed output instead of guessing.

## Findings

- **Retained — verified live legacy-looking adapters.** `terminal-app.ts`, `iterm2.ts`, and `osascript.ts` still back terminal selection, closing, and layout at `src/adapters/terminal.ts:20`; CLI recovery also identifies an already-running orchestrator window through them at `src/cli/orchestrator.ts:241`. `screen.ts` supplies the daemon layout coordinator at `src/daemon/layout.ts:6`. Removing these would break explicit recovery and external-terminal compatibility, even though the normal Workspace path does not open them.
- **Fixed — tmux commands could wait forever.** Every production tmux invocation now has a 10-second hard timeout at `src/adapters/tmux.ts:63`. Arguments remain argv-based, session names remain validated, and message text continues to travel through stdin-backed tmux buffers rather than shell interpolation.
- **Fixed — malformed tmux PIDs were partially accepted.** `Number.parseInt("12oops", 10)` produced a plausible PID. Pane PID parsing now accepts only complete positive decimal strings and safe integers at `src/adapters/tmux.ts:203`, covered by `src/adapters/tmux.test.ts:224`.
- **Fixed — worktree Git commands could wait forever.** The async worktree boundary now has a 30-second hard timeout at `src/adapters/worktrees.ts:33`. Profile Git probes, which are deliberately best-effort, have a 5-second timeout at `src/adapters/profile.ts:217`.
- **Fixed — malformed Git output could become state.** Worktree records without a path are discarded at `src/adapters/worktrees.ts:121`. Unmerged commit counts must be complete non-negative decimal safe integers at `src/adapters/worktrees.ts:182`; profile staleness likewise rejects unsafe or negative counts at `src/adapters/profile.ts:244`.
- **Fixed — provider capability probes could wait forever.** Claude version probes are bounded to five seconds at `src/adapters/tools/claude.ts:69`, and the Codex app-server availability probe is bounded to five seconds at `src/adapters/tools/codex-app-server.ts:344`. Both retain their existing fail-closed behavior.
- **Fixed before this audit — AppleScript execution and parsing.** `runOsascript` already passes scripts as argv, captures stderr, translates macOS permission failures, and kills calls after five seconds at `src/adapters/osascript.ts:31`. Terminal handles and screen JSON already validate their complete shapes at `src/adapters/terminal-app.ts:167` and `src/adapters/screen.ts:28`. No change was needed.
- **Deferred — the external-terminal recovery surface.** SPEC sections 9 and 10 make Workspace the ordinary viewer, but the CLI still exposes explicit Terminal/iTerm2 recovery. Whether that compatibility surface should disappear is a product decision spanning CLI flags, schemas, stored handles, and daemon layout; it is not an adapter-only hardening change.
- **Out of scope — long-lived provider sessions.** The Codex app-server host and agent TUIs are intentionally long-running processes, so applying short probe-style timeouts to them would break their contract. Their lifecycle belongs to daemon/host supervision rather than this subprocess audit.

## Verification

The pre-change baseline was 860 passing tests, 11 explicitly skipped integration tests, zero failures, and a clean `bun run typecheck`. After the changes, `bun test src/adapters` passed 209 tests and typecheck remained clean. The landing gate also runs the complete suite and typecheck after rebasing onto `main`.
