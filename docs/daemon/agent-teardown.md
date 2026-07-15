# Agent teardown

**Updated:** 2026-07-14

## Summary

Killing an agent's tmux session is not killing the agent. Teardown was one line — `tmux killSession` — and the processes that mattered walked away from it: anything the agent backgrounded, and the Codex app-server host, which is a child of the *daemon* and was never in the pane at all. Closing a pane, or quitting the app, left those running forever, holding model sessions open and spending against the account, reparented to init and invisible to Hive.

So teardown now kills the **process tree**, and then it **looks again**. One path serves the pane's X, `hive_kill`, the idle reaper, and daemon shutdown, so none of them can quietly stop reaping something.

## The rule

**A signal delivered is an act. A process gone is a state.** Teardown reports what it *measured*, not what it *sent* — a process still standing after SIGKILL is reported as a survivor, never rounded down to a clean kill.

For acceptance, a recorded act is also not proof of ownership: resolve the full manifest-owned development identity before signaling, and treat a missing or mismatched target as unknown rather than falling back to another Hive.

## What was actually leaking

Measured on 2026-07-13 against a throwaway `HIVE_HOME`, with a staged agent whose shape matches a real one: pane shell → vendor CLI → MCP stdio child, plus a `nohup`ed background command, plus a Codex host.

`tmux kill-session` sends SIGHUP to the pane's foreground process group. That is enough for the well-behaved half of the tree — the vendor CLI and its MCP child did die. Two things did not:

1. **Anything the agent backgrounded.** SPEC §12 records that agents "background their own hung commands" routinely. A `nohup`ed process ignores the SIGHUP, survives, and is **reparented to init**. Observed: `87468 1 sleep 9333` — still running, ppid 1, attributable to nobody.
2. **The Codex app-server host.** The daemon spawns it, so it is the *daemon's* child. No signal aimed at a pane can ever reach it. It survived by construction.

## Reparenting is why capture must come first

The fix is not "walk the tree and kill it". That version was written, it passed every unit test, and **it did not work** — measured, it reported `1 process reaped` and left the `nohup`ed child alive.

The reason is the whole design constraint. If you capture only the *root* pids before the kill and walk the tree *after*, the walk finds nothing: the pane is gone, and the detached child's ppid is now 1, so it is no longer a descendant of anything you know. **Reparenting destroys the very links the walk depends on.**

So the tree is **captured while those links still exist** (`captureProcessTree`, before `killSession`), and the captured pid list — a snapshot, not a live query — is what gets SIGKILLed afterwards (`reapCapturedTree`). Every unit test passed against the broken version because a fake process table does not reparent anything. Only `ps` did.

After the fix, the same staged agent: `killed testagent — 5 process(es) reaped`, and `ps` showed all five gone.

## The order, and what each step destroys

`killAgentTeardown` (`src/daemon/server.ts:1735-1913`):

1. **Capture the process tree** — pane pids (`tmux list-panes`) *and* the Codex host pid, read from the pidfile beside its socket. Must precede everything: the pane pids die with the session.
2. **Kill the tmux session.**
3. **SIGKILL the captured tree, then verify.** A zombie counts as dead — it is an exit nobody reaped.
4. **Mark dead, settle the quota reservation.**
5. **Preserve unlanded work** — if the agent holds unmerged commits or uncommitted files, its branch is written to `refs/hive-preserved/<branch>` before step 7 can remove the worktree it lives in.
6. **Tell the orchestrator** what was preserved and where, and what would not die.
7. **Remove the worktree** only when asked. Stranded work refuses removal unless the caller explicitly passes `discardWork`.

SIGKILL, not SIGTERM: this path is only reached once the user has decided. The X and the app quit both mean *now*, and a vendor CLI that traps SIGTERM to flush a transcript would turn "immediate" into "eventually". The graceful shutdown of the agent's *conversation* is the database's job and has already happened.

Spawner cleanup uses the same capture-kill-readback primitive through `verifiedAgentStop`, including failed launches, failed critical restarts, and replacement of a failed Codex app-server host. If readback is unavailable or any process survives, Hive records the agent as `stuck`, revokes writes, preserves the worktree, and leaves its quota reservation active. It does not launch a fallback over an unverified predecessor or direct-kill around the verifier. Only a positively verified stop permits quota cancellation and failed-spawn cleanup (`src/daemon/teardown.ts:260-282`, `src/daemon/spawner-impl.ts:2267-2359`).

An external acceptance cleanup follows the same ordering: capture the manifest-owned development tree before tmux/session destruction, then verify absence. It never signals an installed or unknown tree.

## Immediate is a UX constraint, not permission to destroy

The agent dies at once — no confirmation, no blocking prompt. Nobody is asked whether the work mattered, which is exactly why nobody may decide it did not:

- Unlanded commits or uncommitted files ⇒ **the branch is preserved as a git ref** and the orchestrator is told what was saved and where.
- Worktree removal still **refuses** to delete stranded work unless the caller passes `discardWork`.
- A preserve that *fails* says so in the result rather than proceeding quietly.

`discardWork` is the deliberately destructive exception, not another name for cleanup. When the caller asks both to remove the worktree and to discard stranded work, Hive removes tracked and untracked changes, deletes the branch, removes the preservation ref it just created, and reports that deletion (`src/daemon/server.ts:1868-1897`). A preserved ref left behind would still retain every commit and would make “discard” a rename rather than a discard.

## Quitting stops the machine, not just the process

`stop()` used to kill the orchestrator's tmux session and exit, leaving every agent running with nothing alive to supervise, message, meter, or reap them. Quitting the app is the ordinary way a session ends, so that was the ordinary way Hive orphaned processes.

Shutdown now closes **every live agent through the same kill path**, before the timers stop (teardown needs delivery and quota alive), and then reaps the orchestrator's own pane tree — the orchestrator has no agents row, so nothing else would have.

That breadth is why an acceptance harness must resolve the full instance tuple before calling stop or closing a Workspace. It may quit only the temporary development app whose home, instance id, daemon/app PIDs and start times, executables, port/handshake, tmux namespace, and window match its ownership manifest. The already-running installed Hive is never a teardown target; unknown identity fails and is preserved. See [Pre-release acceptance testing](../release/acceptance-testing.md).

### How long it takes, and why the app's quit wait is not a deadline

Measured end to end, SIGTERM to daemon exit, with every agent carrying a full tree (pane shell → vendor CLI → MCP child, a `nohup`ed background command, and a Codex host):

| Team | Duration | Left behind |
| --- | --- | --- |
| 2 agents + orchestrator | 0.97s | nothing |
| 6 agents + orchestrator | 2.22s | nothing (29 pane processes + 6 Codex hosts reaped) |

`killAllAgents` is a sequential loop, so this is **~0.3s per agent**, with a hard floor of the 250ms post-SIGKILL verify-settle each. Extrapolated, a team of ~16 crosses five seconds.

Both rows are single runs, and they are not held equally firmly. The 0.97s figure is the measurement recorded when the shutdown fix landed. The 6-agent row is **one observation by its author, not independently reproduced** — confirming it costs a real six-agent teardown, so it stands as recorded, not as established fact. What it has going for it is arithmetic: the ~0.3s/agent slope sits just above the 250ms floor the code actually sets, so it is at least consistent with the mechanism. Argue from the slope; do not quote the second row as a spec.

**That is not a correctness bound, and the Workspace must not treat it as one.** The daemon is a *detached* process, not a child of the app: the SIGTERM handler runs `stop()` to completion whether or not the app is still alive to watch it. So the app's quit wait buys **observability, not correctness**, and a wait that expires means "we stopped watching", never "the teardown was truncated". Render an expired wait as such — not as a failure.

Parallelising `killAllAgents` to shrink the number was deliberately **rejected**: it is a speculative change to a kill path, for a latency problem with no correctness consequence.

## The surface the Workspace calls

`POST /agents/<name>/kill` (capability `agent:kill`), and `hive kill <agent> --port <n>` over it — the pattern the app already uses for `hive autonomy`. It is a thin authorization shell over `killAgentTeardown` and holds no policy of its own, because a second kill path is how one of them stops reaping something.

**Idempotent, because a UI cannot be.** The feed publishes an agent row before its tmux session exists, so the X is clickable on a pane whose backing resource does not exist yet; and a pane can be closed twice. Both exit 0. A kill that genuinely failed exits non-zero, and survivors are an error — the command will not report success over a process it could not kill.

The app does **not** loop over panes on quit: it runs `hive stop` once, and shutdown does the rest. Two teardown paths racing is the bug this design exists to prevent.

## The orphan reaper never fired

The maintenance-tick sweep that reaps Codex hosts whose own host process died had **two independent bugs, either one of which was fatal**. Both are fixed; neither had anything to do with multi-instance, and orphan Codex hosts leaked on every single run.

1. **It listed the wrong directory.** `CODEX_SOCKET_DIR` was the literal `"/tmp"`, while `codexAgentSocketPath` binds into `tmpdir()` — the per-user temp dir, deliberately, so no other local user can pre-bind the name. Measured on the live daemon: `TMPDIR=/var/folders/4v/.../T/`. The reaper was scanning a directory the pidfiles were never in, so it found nothing to act on.
2. **It could not parse the names it would have found.** The pidfile is `hive-codex-<instanceSuffix>-<agentId>.sock.pid`. The pattern `/^hive-codex-(.+)\.sock\.pid$/` captured `<instanceSuffix>-<agentId>` in one greedy group and handed *that* to a lookup by agent id, which could only ever answer `unknown` — and `unknown` is skipped. Anchoring on this instance's own suffix also makes the "an unknown id may belong to another hive instance" guard real, rather than a comment describing something the code did not do.

Its test was green throughout, because the fixture hand-typed `hive-codex-dead-agent.sock.pid` — a filename nothing in Hive has ever written. The old greedy regex matched the fake perfectly. The fixture is now **generated by the production writer** (`codexAgentHostPidfile`), so the test can never again pass on a name production does not produce.

The recycled-PID guard matches process identity at the start of argv, not text anywhere in the command line: `basename(argv[0])` must be `codex` and `argv[1]` must be `app-server`. A prompt containing the words “codex app-server” can never satisfy that check (`src/adapters/tools/codex-app-server.ts:934-938`).

**Verified on a real tick, not just in a unit test.** A unit test over production-generated filenames proves the *name* parses; it does not prove the timer fires, finds the file, resolves the agent, verifies argv, and kills the host. So: a genuinely orphaned process whose argv begins `codex app-server --listen unix://…`, a dead agent row, the pidfile at its production path, and then nothing but waiting. The maintenance tick is **30 seconds**. The host died, the socket and pidfile were removed, and the orchestrator was told. Run twice, because the first orphan died one second into the poll — which proves it *fired*, not that a *timer* drove it; the second, staged with clean phase, was reaped 8s later. Both inside one tick window.

That distinction is the article's own rule turned on its author: a reap observed is an act, and only the delay proves the timer is the thing that caused it.

## See Also

- [Database resilience](database-resilience.md) — absence must refuse, preserve, and say so
- [Multiple concurrent instances](multi-instance.md) — the instance suffix that scopes tmux sessions and Codex sockets
- SPEC §3 (work is merged, preserved, or surfaced — never silently lost), §9 (viewers are closed by recorded identity), §12 (the resource sweep)
