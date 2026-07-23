# Sessiond-only runtime unwire handoff

Status: implementation handoff for the final #112 increment. The baseline is
`b26f4f59` plus the restart-proof series through `8d209a43`. Line numbers below
name that baseline and will move as the edits land.

## Required outcome

At the next restart, production constructs only sessiond terminal hosts for
agents and the queen. A sessiond launch failure is terminal and typed; it never
falls back to tmux. The tmux implementation stays in the tree as dead code for
#1/#2, and explicitly injected legacy fixtures may still exercise it. The
production composition, Workspace launch, ordinary stop, agent spawn, agent
recovery, queen launch, and delivery paths must not construct or select tmux.

The landing commit must disclose all three facts: production composition
constructs no tmux host; sessiond launch failure is terminal and typed; tmux is
dead code pending #1/#2. It must also name the crash-recovery fix: a recovered
sessiond agent preserves host kind and engine identity instead of being
downgraded to tmux.

## Seven live seams

1. Production daemon composition — `src/cli/daemon.ts:244-245,264-342`.
   Delete the `TmuxSessionHost` and `BunTmuxSender` construction and imports.
   Construct one `SessiondHost`, pass the sessiond admission seam to
   `HiveSpawner`, use sessiond teardown in `stopSpawnSession`, and pass no tmux
   host/sender to `HiveDaemon`. Extract the small terminal-composition factory
   described below so a test drives this exact production path.

2. Daemon policy and lifecycle — `src/daemon/server.ts:796-844,852-855,
   916-930,948-991,1021-1024`, plus the remaining `this.tmux` and
   `orchestratorHost` branches reported by
   `rg -n 'this\.tmux|orchestratorHost' src/daemon/server.ts`. Defaults must be
   sessiond-only: no default `TmuxSessionHost`, coexistence sender, root tmux
   delivery, tmux wake check, or tmux shutdown. Keep optional explicit legacy
   dependencies only for dead-path tests. Critical-control survivor reuse must
   inspect the sessiond locator through `terminalHost`, and `hive_mark_dead`
   must inspect the sessiond binding rather than the tmux compatibility name.
   `/orchestrator-session` and `/orchestrator-status` report one literal
   sessiond host; remove the runtime selector conditions. A legacy row met by a
   production daemon fails loudly/unknown rather than causing a hidden tmux
   construction.

3. Agent spawning — `src/daemon/spawner-impl.ts:776-825,827-948,
   2181-2197`. Keep the explicit tmux dependency usable by legacy unit
   fixtures, but when a `sessiond` dependency is present, `prepare`/`admit`
   returning null must throw `SpawnFailedError` with layer `transport` and
   outcome `failed`; it must never mint a tmux locator. Move agent-id minting
   and sessiond availability preparation before worktree creation so this
   refusal leaves no row, worktree, assignment, quota hold, or name hold. Make
   the existing session creation operation a narrow public/internal recovery
   seam so production recovery reuses the exact sessiond admission and create
   path instead of rebuilding transport policy.

4. Queen launch and supervision — `src/cli/orchestrator.ts:147-185,
   435-590` and `src/cli/orchestrator-supervisor.ts:181-203`. Remove the host
   option, environment selection, default `new TmuxSessionHost`, fresh-tmux
   preparation, and runtime branch from the live `launchOrchestrator` entry.
   Always submit `OrchestratorSessiondLaunchSchema` through the daemon control.
   Introduce `OrchestratorLaunchFailedError` (or the equivalent existing typed
   error if one lands first) for a refused/failed sessiond snapshot. The
   supervisor may report and retry according to its existing recovery policy,
   but it may not call the tmux process-spawn adapter.

5. Workspace launch — `src/cli/workspace.ts:46-49,72-80,143-177`.
   Remove the `TmuxSessionHost` dependency and the `--orchestrator-session` /
   `--tmux-socket` arguments. The Workspace already receives project, port,
   instance id/home, Hive binary, and optional orchestrator; its feed carries
   the root locator. Update `test/cli/workspace.test.ts:94-155` to assert the
   exact tmux-free argv. Swift may keep parsing the old flags as dead
   compatibility code until #1/#2.

6. Ordinary stop — `src/cli/control.ts:117-123,585-709`. `stopHive()` must not
   default-construct a tmux host and must not run the residual tmux sweep.
   `stopAgentSessions()` may remain only as an explicitly injected legacy
   helper for #1/#2 tests. Production stop relies on daemon-side exact
   sessiond agent/root teardown and then lifecycle cleanup. Update output tests
   so a normal live or already-dead stop never enumerates tmux.

7. Delivery construction — `src/daemon/delivery.ts:262-319` and
   `src/daemon/server.ts:840-844`. Remove `BunSessionSender`'s default
   `new TmuxSessionHost`. Preserve it only with an explicit legacy host.
   Production `MessageDelivery` receives a sessiond-only sender/guard; actual
   sessiond delivery continues through `SessiondViewerAgentInput` and marks
   injected only after the `INPUT_SUBMIT` receipt. A tmux locator reaching the
   production sender is an explicit error, never a compatibility fallback.

## Crash-recovery downgrade fix

`src/daemon/recovery.ts:203-209,594-607,718-739` currently constructs a tmux
host, replaces every successor locator with `nextAgentSessionLocator()` (tmux),
and creates the recovered process through tmux. Add a narrow `createSession`
dependency supplied by the production `HiveSpawner` seam. Derive the successor
from `nextAgentSessionLocator`, but when the predecessor is sessiond overwrite
`hostKind` with `sessiond` and retain the predecessor's `engineBuildId`; only
generation/session id advance. Call the injected create seam after the second
authorization check. Explicit legacy tests may omit it and use their injected
tmux host, but production must always supply it. A production attempt to resume
a legacy tmux row is terminal/loud, not a live tmux construction.

Regression name: `sessiond crash recovery advances generation without
downgrading or constructing tmux`. It goes red if host kind changes, engine id
changes, generation does not increment, the sessiond create seam is not called,
or the tmux adapter records any construction/create call.

## Production-composition pin

Extract `createProductionTerminalComposition` (name may follow local style)
from `runDaemon` in `src/cli/daemon.ts`. It accepts a constructor bundle whose
sessiond constructor is the real default and whose legacy-tmux constructor is
present only as a test probe; the returned production composition contains the
sessiond host and no tmux host/sender. `runDaemon` must use this function, not a
parallel hand-built composition.

Regression name: `production terminal composition constructs sessiond and no
tmux host`. Build the real production composition with constructor probes,
assert one sessiond construction and zero tmux constructions, then assert the
spawner and daemon receive no tmux dependency. It goes red if a convenience
fallback calls the tmux constructor. This is a construction probe, not a grep
or source-text assertion.

## Other mandatory regressions

- `sessiond admission refusal is atomic and never falls back to tmux`: fake
  `prepare` returns null while a legacy tmux fake is available. Expect
  `SpawnFailedError`/`SPAWN_FAILED`, zero tmux creates, no agent row, no
  worktree, no assignment, and quota/name counts back at baseline. Mutating
  null back to the old tmux locator must make it red.
- `queen sessiond launch failure is typed and never spawns tmux`: return a
  refused/failed sessiond launch response and expect
  `OrchestratorLaunchFailedError`; the process-spawn fake and tmux probe stay at
  zero. Mutating in a fallback must make it red.
- `Workspace session launch carries no tmux endpoint`: assert the exact argv
  lacks both legacy flags. Reintroducing either flag is red.
- `stopHive performs no residual tmux sweep without explicit legacy
  dependencies`: the daemon reaches dead, cleanup runs, and a tmux probe is
  untouched. Reintroducing the default constructor/sweep is red.
- `BunSessionSender requires an explicit legacy host`: construction without a
  host is a type error or a direct runtime refusal in the compatibility test;
  no production caller exists.
- Server regressions must cover sessiond-only root wake/status/stop,
  critical-control survivor inspection, and `hive_mark_dead` for present,
  stopped, and never-bound sessiond generations. Deleting the sessiond inspect
  or restoring a tmux branch must make at least one test red.

## Deliberate dead-path skips

In `test/daemon/launch-watch.test.ts:155-170`, mark both generated cases skipped
with this in-test rationale:

> Skipped after #112: this fixture launches Claude directly inside tmux, which
> is no longer a production terminal path. #1/#2 own deletion or replacement
> under the zero-living-references acceptance.

The two exact skipped names remain:

- `Claude spawn launch watch > a fresh writer worktree reaches its first turn
  with no interactive prompt`
- `Claude spawn launch watch > a fresh read-only worktree reaches its first
  turn with no interactive prompt`

In `native/sessiond/test/ts-live-create.ts:596-611`, remove the Theo block from
the active real-host case and add a named skipped case:

> `legacy tmux spawner backend (dead after #112; deletion belongs to #1/#2)`

The rationale must state that sessiond-only production no longer exercises the
fallback. Do not weaken the surrounding real sessiond create/input/stop proof.

## Restart transition preflight text

Replace the proof document's opt-in/environment setup with this invariant:

1. Build and identify one immutable candidate. From the primary checkout,
   stop the currently serving pre-flip binary through its ordinary `hive stop`
   path and wait for its exact daemon PID to exit. Do not force-kill or skip
   that stop: only the old binary still owns the tmux namespace cleanup.
2. Before launching the candidate, inspect the old instance-scoped tmux socket
   and the global `hive-*` inventory. Both must contain no Hive session. Any
   surviving queen/agent session is a finding; clean that exact proven-owned
   session and repeat preflight. Starting the new binary while it remains is
   forbidden.
3. Launch exactly one manifest-owned Workspace on the candidate with no
   `HIVE_ORCHESTRATOR_HOST` setting. The default queen must report
   `host=sessiond`; every agent locator must also be sessiond. The candidate
   never sweeps tmux, so a force-killed old binary cannot be repaired by the
   new one.

Update `docs/daemon/sessiond-queen-restart-proof.md`: remove the launchctl
environment section and its watcher because there is no selector; retain the
single-Workspace manifest/process watcher. Change the #112/#1/#2 ledger and
decision text: the default and live unwire are code-closed by #112, live matrix
execution is post-restart acceptance evidence rather than a prerequisite, and
tmux implementation deletion/zero living references remains #1/#2.

## Gates and landing

Run `bun run typecheck`, full `bun test --timeout 10000`, and
`native/sessiond/test.sh` while capturing the script's own exit code. The final
Bun suite must be green: the two #111 cases and the named live-create legacy
case are deliberate skips, not tolerated reds. Run the focused Workspace Swift
tests covering root renderer/keyboard/feed behavior with the staged artifact,
and `git diff --check`. Send the exact tip to Omar; land through `hive_land`
only on a SHA-bound approval.
