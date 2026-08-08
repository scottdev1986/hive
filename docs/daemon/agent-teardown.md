# Agent teardown

**Updated:** 2026-08-15

## Summary

Killing an agent's terminal session is not killing the agent. Teardown was one line — kill the session — and the processes that mattered walked away from it: anything the agent backgrounded, and the Codex app-server host, which is a child of the *daemon* and was never in the pane at all. Closing a pane, or quitting the app, left those running forever, holding model sessions open and spending against the account, reparented to init and invisible to Hive.

So teardown now kills the **process tree**, and then it **looks again**. One path serves the pane's X, `hive_kill`, the idle reaper, and daemon shutdown, so none of them can quietly stop reaping something.

## The rule

**A signal delivered is an act. A process gone is a state.** Teardown reports what it *measured*, not what it *sent* — a process still standing after SIGKILL is reported as a survivor, never rounded down to a clean kill.

For acceptance, a recorded act is also not proof of ownership: resolve the full manifest-owned development identity before signaling, and treat a missing or mismatched target as unknown rather than falling back to another Hive.

Teardown is not assignment adjudication. The kill closes the agent's session assignment row (`status_assignments`, `open` → `closed`); the row is a report binding and carries no outcome, and the last reported phase — descriptive only, never an approval — stays in the event stream exactly as reported. Nothing about a terminal process is ever translated into completed work.

## What was actually leaking

Measured on 2026-07-13 against a throwaway `HIVE_HOME`, with a staged agent whose shape matches a real one: pane shell → vendor CLI → MCP stdio child, plus a `nohup`ed background command, plus a Codex host.

`tmux kill-session` sends SIGHUP to the pane's foreground process group. That is enough for the well-behaved half of the tree — the vendor CLI and its MCP child did die. Two things did not:

1. **Anything the agent backgrounded.** Agents "background their own hung commands" routinely. A `nohup`ed process ignores the SIGHUP, survives, and is **reparented to init**. Observed: `87468 1 sleep 9333` — still running, ppid 1, attributable to nobody.
2. **The Codex app-server host.** The daemon spawns it, so it is the *daemon's* child. No signal aimed at a pane can ever reach it. It survived by construction.

## Reparenting is why capture must come first

The fix is not "walk the tree and kill it". That version was written, it passed every unit test, and **it did not work** — measured, it reported `1 process reaped` and left the `nohup`ed child alive.

The reason is the whole design constraint. If you capture only the *root* pids before the kill and walk the tree *after*, the walk finds nothing: the pane is gone, and the detached child's ppid is now 1, so it is no longer a descendant of anything you know. **Reparenting destroys the very links the walk depends on.**

So the tree is **captured while those links still exist** (`captureProcessTree`, before the session terminate), and the captured pid list — a snapshot, not a live query — is what gets SIGKILLed afterwards (`reapCapturedTree`). Every unit test passed against the broken version because a fake process table does not reparent anything. Only `ps` did.

After the fix, the same staged agent: `killed testagent — 5 process(es) reaped`, and `ps` showed all five gone.

## The order, and what each step destroys

`killAgentTeardown` (`src/daemon/server.ts: killAgentTeardown`):

1. **Capture the process tree** — the session host pid, read from the host itself. Must precede everything: the tree's links die with the session.
2. **Terminate the session.**
3. **SIGKILL the captured tree, then verify.** A zombie counts as dead — it is an exit nobody reaped.
4. **Mark dead, settle the quota reservation.**
5. **Preserve unlanded work** — unmerged commits get a preservation ref, and staged/unstaged/untracked bytes get a salvage ref before release is considered.
6. **Open or advance the settlement case** for the complete work bundle.
7. **Release only on a self-validating proof** — the service repeats identity, liveness, complete residue, and exact Git accounting under the target lock immediately before the proof-bound mutator runs. An unprovable case stays owned and due.

SIGKILL, not SIGTERM: this path is only reached once the user has decided. The X and the app quit both mean *now*, and a vendor CLI that traps SIGTERM to flush a transcript would turn "immediate" into "eventually". The graceful shutdown of the agent's *conversation* is the database's job and has already happened.

Spawner cleanup uses the same capture-kill-readback primitive, including failed launches, failed critical restarts, and replacement of a failed Codex app-server host. If readback is unavailable or any process survives, Hive records the agent as `stuck`, revokes writes, preserves the worktree, and leaves its quota reservation active. It does not launch a fallback over an unverified predecessor or direct-kill around the verifier. Only a positively verified stop permits quota cancellation and failed-spawn cleanup (`src/daemon/resource-management/teardown.ts`, `src/daemon/spawn/hive-spawner.ts`).

An external acceptance cleanup follows the same ordering: capture the manifest-owned development tree before session destruction, then verify absence. It never signals an installed or unknown tree.

## Immediate is a UX constraint, not permission to destroy

The agent dies at once — no confirmation, no blocking prompt. Nobody is asked whether the work mattered, which is exactly why nobody may decide it did not:

- Unlanded commits or uncommitted files ⇒ **the branch and WIP are preserved as Git refs** and named on the settlement case.
- Automatic release requires the same exact proof from teardown, reconciliation, failed-spawn cleanup, ref stewardship, and uninstall.
- A preserve that *fails* says so in the result rather than proceeding quietly.
- Settlement never translates process death into completion: the session assignment row closed at kill carries no outcome, and nothing downstream infers one.

The automatic proof cannot be waived. Deliberate discard uses a separate decision that only the user authorization boundary can mint. It names one case revision, evidence digest, worktree, branch and ref OIDs, reason, owner, and expiry. Queen may execute that decision, but any case, content, or OID drift invalidates it before mutation. `hive uninstall --yes` is not such a decision and leaves unsettled work protected.

## Quitting stops the machine, not just the process

`stop()` used to kill the orchestrator's tmux session and exit, leaving every agent running with nothing alive to supervise, message, meter, or reap them. Quitting the app is the ordinary way a session ends, so that was the ordinary way Hive orphaned processes.

Shutdown now closes **every live agent through the same kill path**, before the timers stop (teardown needs delivery and quota alive), and then reaps the orchestrator's own pane tree — the orchestrator has no agents row, so nothing else would have. `hive stop` first resolves the persisted sessiond locators. While the daemon's broker authority is still live, it submits every exact sessiond locator to the daemon and requires authoritative process-tree absence; only then may it signal daemon shutdown. A failed tree refuses the shutdown instead of becoming a successful quit message.

That breadth is why an acceptance harness must resolve the full instance tuple before calling stop or closing a Workspace. It may quit only the temporary development app whose home, instance id, daemon/app PIDs and start times, executables, port/handshake, session namespace, and window match its ownership manifest. The already-running installed Hive is never a teardown target; unknown identity fails and is preserved. See [Pre-release acceptance testing](../release/acceptance-testing.md).

### How long it takes, and why AppKit holds termination

Measured end to end, SIGTERM to daemon exit, with every agent carrying a full tree (pane shell → vendor CLI → MCP child, a `nohup`ed background command, and a Codex host):

| Team | Duration | Left behind |
| --- | --- | --- |
| 2 agents + orchestrator | 0.97s | nothing |
| 6 agents + orchestrator | 2.22s | nothing (29 pane processes + 6 Codex hosts reaped) |

`killAllAgents` is a sequential loop, so this is **~0.3s per agent**, with a hard floor of the 250ms post-SIGKILL verify-settle each. Extrapolated, a team of ~16 crosses five seconds.

Both rows are single runs, and they are not held equally firmly. The 0.97s figure is the measurement recorded when the shutdown fix landed. The 6-agent row is **one observation by its author, not independently reproduced** — confirming it costs a real six-agent teardown, so it stands as recorded, not as established fact. What it has going for it is arithmetic: the ~0.3s/agent slope sits just above the 250ms floor the code actually sets, so it is at least consistent with the mechanism. Argue from the slope; do not quote the second row as a spec.

**That is not a correctness bound, and the Workspace does not wait on it.**
AppKit always permits the UI to exit. It starts `hive stop --force` as a
best-effort request, while the daemon owns verified teardown independently.
The Workspace registers its exact PID and start token before terminal
inventory is accepted; owner death starts daemon shutdown, failure to register
within the startup grace period also shuts it down, and daemon shutdown has a
hard upper bound. The visibility lease remains an independent terminal-host
backstop.

Parallelising `killAllAgents` to shrink the number was deliberately **rejected**: it is a speculative change to a kill path, for a latency problem with no correctness consequence.

## The surface the Workspace calls

`POST /agents/<name>/kill` (capability `agent:kill`), and `hive kill <agent> --port <n>` over it — the pattern the app already uses for `hive autonomy`. The request carries the exact Hive-owned session locator held by the pane; the daemon compares it with the current record before teardown, so a stale generation receives a typed rejection and kills nothing. After that fence it is a thin authorization shell over `killAgentTeardown` and holds no second teardown policy.

**Idempotent, because a UI cannot be.** The feed publishes an agent row before its session exists, so the X is clickable on a pane whose backing resource does not exist yet; and a pane can be closed twice. Both exit 0. A kill that genuinely failed exits non-zero, and survivors are an error — the command will not report success over a process it could not kill.

The app does **not** loop over panes on quit: it runs `hive stop` once, and shutdown does the rest. Two teardown paths racing is the bug this design exists to prevent.

## See Also

- [Database resilience](database-resilience.md) — absence must refuse, preserve, and say so
- [Multiple concurrent instances](multi-instance.md) — the instance suffix that scopes terminal sessions and Codex sockets
- The rules this teardown implements: work is merged, preserved, or surfaced — never silently lost; viewers are closed by recorded identity; the resource sweep
