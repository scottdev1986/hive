# Slice-3 verification evidence for review HEAD 105df8d

Frozen review: **105df8d7eefada1e0fc3264d7b58ab487d2e40b9** vs base **37285795796a942bd7ba629c3f94956c704d29da**.
No rerun for this message — logs below are the measured runs.

---

## A. Typecheck + full suite at rebased HEAD (105df8d lineage)

### Commands (post-rebase onto main including 37285795)

```bash
cd /Users/scottkellar/Projects/hive/.hive/worktrees/liam
git rev-parse HEAD   # 105df8d7eefada1e0fc3264d7b58ab487d2e40b9
bun run typecheck
bun test 2>&1 | tee /tmp/liam-full-after-foreman-rebase.log
```

### Results

| Check | Result |
|-------|--------|
| `bun run typecheck` | exit 0, `$ tsc --noEmit` clean (no errors) |
| `bun test` | **1632 pass / 10 skip / 2 fail** |
| expect() calls | 5992 |
| files | 1644 tests across 120 files, ~130.86s |

### Exact full-suite reds (only)

1. `Claude spawn launch watch > a fresh writer worktree reaches its first turn with no interactive prompt` (~40260ms)
2. `Claude spawn launch watch > a fresh read-only worktree reaches its first turn with no interactive prompt` (~40442ms)

Failure mode: `src/daemon/launch-watch.test.ts:182` — `expect(reachedTurn).toBe(true)` Received `false`.

### Durable log

`/tmp/liam-full-after-foreman-rebase.log`  
(mtime Jul 15 19:23; tail confirms 1632/10/2)

Related earlier full-suite logs (same 1632/10/2 class, earlier HEADs):  
`/tmp/liam-full-rebased.log`, `/tmp/liam-full-n5.log`

---

## B. Main-side launch-watch baseline proof (unmodified main scratch)

### Commands

```bash
# Detached scratch at then-current main tip (measured: 980897269b2b014f89b208f60c965925f6a0f056)
# Note: 37285795 is docs-only after 9808972; launch-watch is identical for suite purposes.
cd /Users/scottkellar/Projects/hive/.hive/worktrees/liam
SCRATCH=/tmp/liam-main-lw-baseline-$$
git worktree add --detach "$SCRATCH" main
cd "$SCRATCH"
# HEAD was 980897269b2b014f89b208f60c965925f6a0f056
bun install   # if needed
export HIVE_HOME=/Users/scottkellar/.hive/instances/run-25157d00-25b8-4d06-9ca1-872a631c6492
set -o pipefail
bun test src/daemon/launch-watch.test.ts 2>&1 | tee /tmp/liam-lw-main-final.log
# main_exit=1
```

### Environment fingerprint (shared main + branch runs)

- bun 1.3.14 (`/opt/homebrew/bin/bun`)
- tmux 3.7b
- claude: `/opt/homebrew/bin/claude`
- HIVE_HOME: `/Users/scottkellar/.hive/instances/run-25157d00-25b8-4d06-9ca1-872a631c6492`

### Results (main)

| Check | Result |
|-------|--------|
| Exact tests | same two full names as suite reds |
| Outcome | **0 pass / 2 fail** |
| Exit | **1** |
| Assertion | `launch-watch.test.ts:182` `reachedTurn` false @ ~40s both roles |

### Durable logs

| Path | Content |
|------|---------|
| `/tmp/liam-lw-main-final.log` | Main scratch run @ 9808972, exit 1, both fails |
| `/tmp/liam-launch-watch-main.log` | Earlier main scratch @ 0681f8a, same 0/2 |
| `/tmp/liam-launch-watch-main-rerun.log` | Main re-run pipefail exit 1 |
| `/tmp/liam-launch-watch-branch.log` | Branch same tests, identical assertion |

### Narrative index (worktree, untracked)

`/Users/scottkellar/Projects/hive/.hive/worktrees/liam/.hive-tmp-reviews/launch-watch-baseline-evidence.md`

### Verdict recorded

Identical failure on unmodified main and branch → pre-existing baseline, not a 105df8d regression.

---

## C. Typecheck alone (same session as full suite)

Command: `bun run typecheck` → `$ tsc --noEmit` with no diagnostics (captured immediately before the full-suite run that produced `/tmp/liam-full-after-foreman-rebase.log`).
