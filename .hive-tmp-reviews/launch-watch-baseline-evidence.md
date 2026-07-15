# Claude launch-watch baseline evidence

Measured by liam under steer 1326870e-3d6e-4ec6-8f11-02563d4efc57 (2026-07-15).

## Exact failing tests (full names)

1. `Claude spawn launch watch > a fresh writer worktree reaches its first turn with no interactive prompt`
2. `Claude spawn launch watch > a fresh read-only worktree reaches its first turn with no interactive prompt`

Source: `src/daemon/launch-watch.test.ts` suite `"Claude spawn launch watch"`, CASES `writer`/`read-only`.

## Shared environment fingerprint

- bun: `/opt/homebrew/bin/bun` **1.3.14**
- claude: `/opt/homebrew/bin/claude` (present)
- tmux: `/opt/homebrew/bin/tmux` **3.7b**
- HIVE_HOME: `/Users/scottkellar/.hive/instances/run-25157d00-25b8-4d06-9ca1-872a631c6492`
- HOME: `/Users/scottkellar`
- command (both trees): `bun test src/daemon/launch-watch.test.ts`

## Main baseline (unmodified current main)

- method: `git worktree add --detach /tmp/liam-main-launch-watch-10600 main`
- HEAD: **`0681f8adf4a59060879c5ab13bc6ba7a9888aa23`** (identical to `main`)
- `bun install` fresh in scratch (99 packages)
- **run 1:** 0 pass / 2 fail; both `expect(reachedTurn).toBe(true)` Received `false` @ ~40400ms / ~40423ms (`launch-watch.test.ts:182`)
- **run 2 (pipefail):** same 0/2 fail @ ~40333ms / ~40345ms; **exit code 1**
- logs: `/tmp/liam-launch-watch-main.log`, `/tmp/liam-launch-watch-main-rerun.log`

## Branch (hive/liam-take-ownership-of-leo-s-unmerg)

- worktree: `/Users/scottkellar/Projects/hive/.hive/worktrees/liam`
- HEAD: **`2653a69d659422676551c95dbecac65e86a5fce1`**
- same HIVE_HOME / bun / command
- **run:** 0 pass / 2 fail; both `expect(reachedTurn).toBe(true)` Received `false` @ ~40236ms / ~40310ms (`launch-watch.test.ts:182`); **exit code 1**
- log: `/tmp/liam-launch-watch-branch.log`

## Failure mode (identical)

Primary assertion: `reachedTurn` never becomes true within the 40s poll loop (hook log never contains `turn-start`). Same line, same expect, same timeout class on main and branch. Not a Codex-containment regression.

## Verdict

**Pre-existing on unmodified main.** Branch blockers: none for these two tests. Full-suite red for launch-watch is baseline, not introduced by this branch.
