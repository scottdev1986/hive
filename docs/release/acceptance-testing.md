# Pre-release acceptance testing

Updated: 2026-07-15
Source: Hive source tree and human acceptance-isolation requirement, verified 2026-07-15

## Summary

This is the release gate for a development build while the already-running installed Hive remains continuously running and healthy. The development release runs in parallel on the same machine and provider account from a temporary native layout; a dedicated host or account is not required. Acceptance is deliberately not a unit-test recipe, a daemon-only simulation, a copied Hive repository, a separate worktree, or the Workspace's internal `--smoke` diagnostic. It verifies the public command lifecycle against the dedicated empty repository at `/Users/scottkellar/Projects/hive-test-project`, then launches three visible Workspace processes from the actual Hive repository and drives the real Claude Code, Codex, and Grok TUIs.

A run is complete only when the 3×3 orchestrator-to-agent matrix, simultaneous routing, status, Graphify, composer protection, lifecycle isolation, repository no-op checks, and cleanup all pass **and** the installed Hive still matches its baseline and passes its final health sentinel. An unexecuted cell is not a pass. The repository does not currently ship a complete runner for this contract: a formal pass requires an external or future checked-in runner that enforces and preserves the controls named below. A manual or prompt-only run has reduced assurance and cannot make the strict attestation.

## Non-negotiable boundaries

- Treat the installed Hive as foreign, compare-only production state. Never close, stop, restart, signal, replace, repoint, activate over, upgrade, roll back, uninstall, or auto-repair it. Never aim a lifecycle or UI action at a PID, home, port, socket, tmux server, app window, binary, or install path unless the ownership manifest proves it belongs to this development run.
- Give every run a unique `RUN_ID`, a private temporary root, an ownership marker, an enforced command/target allowlist, an append-only ownership manifest and action journal, and a filesystem-mutation trace before creating any other artifact. Install idempotent `EXIT`, `INT`, `TERM`, and `HUP` cleanup traps before the first test process starts. Production rows are labelled `protected` and are comparison inputs, never cleanup targets; only rows labelled with this `RUN_ID` are test-owned.
- Run the provider matrix with the actual Hive checkout under test as its working directory. Resolve and record that Git toplevel at run time; do not use a copied repository, temporary repository, or separate worktree for a matrix root.
- Run the command-lifecycle cases only in `/Users/scottkellar/Projects/hive-test-project`. It is the durable empty external Git repository for this purpose, not a copy or worktree of Hive. Record its own toplevel and clean baseline before the run; do not add Hive source or fixtures to it.
- Use a fresh temporary native installation. The command-lifecycle group gets a test-owned `HOME` and leaves `HIVE_HOME` unset only for its initial public launches; after each launch, every operation binds the captured runtime home and identity. The provider matrix retains the account's `HOME` for existing provider sign-in but gets test-owned `HIVE_HOME` and `TMPDIR` values. Invoke the temporary release binary by absolute path with `HIVE_INSTALL_ROOT` and `HIVE_BIN_LINK` inside the test root, `HIVE_PORT=0`, `HIVE_DISABLE_UPDATES=1`, and `HIVE_NO_UPDATE_CHECK=1`. Do not pass `--instance`: source maps that flag to the user's `~/.hive/instances/<name>`, while an explicit temporary `HIVE_HOME` stays inside the run.
- Before testing any newly built artifact, close every **test-owned** Workspace created by the prior build, run only its manifest-verified instance-scoped stop path, and prove its daemon, root, agents, tmux server, app-server sockets, and Workspace process are gone. Evidence from a fleet that spans builds is invalid. The installed Workspace stays open.
- Do not run `install.sh`, activation helpers, `hive update` (other than the read-only `hive update status`), `hive update rollback`, `hive uninstall`, a global package operation, or any ambiguous `hive` resolved from `PATH`. Do not create a persistent launch service. A raw filesystem edit of the installed `current`, CLI link, version directory, or state file is equally forbidden.
- `HIVE_DISABLE_UPDATES=1` enforces the product's update/rollback refusal in a process that actually receives it, but it cannot block `install.sh`, uninstall, raw filesystem commands, or an incorrectly targeted UI/lifecycle action. Shell variables do not automatically cross LaunchServices, Workspace, root, or UI execution boundaries: source forwards `PATH`/`TMPDIR` through `open -n` and explicitly adds `HIVE_HOME` plus the absolute Hive path only on known child paths. Treat `HIVE_INSTALL_ROOT`, `HIVE_BIN_LINK`, `HIVE_DISABLE_UPDATES`, and `HIVE_NO_UPDATE_CHECK` as absent beyond a boundary unless process evidence proves they arrived. The runner's allowlist, action journal, filesystem trace, and complete identity checks—not environment variables—must enforce the boundary.
- Launch only through `hive claude`, `hive codex`, and `hive grok`. Private helper commands are implementation details, and `--smoke` is not acceptance.
- Provider authentication belongs to the provider CLIs. The acceptance run may rely on their existing signed-in sessions, but it must not query, create, import, copy, inspect, or modify passwords, API keys, session secrets, or keychain entries. Hive's local `.cap` files authorize calls to Hive's own daemon; they are not provider credentials.
- Every task executed by an orchestrator or spawned agent is read-only. It may report unique identifiers, `pwd`, Git toplevel/common-dir facts, status output, and Graphify query results. It may not edit files, Git state, configuration, installed software, user data, or system state.
- Human input and transport input are separate owners. GUI automation must type the prompt, wait, send Enter as a second event, and verify that a provider turn actually begins. A typed-but-unsubmitted prompt is a failure.
- Preflight the GUI driver's macOS Accessibility permission before building or launching the fleet. A driver that cannot focus the Workspace and generate real key events cannot execute the visible-input, pane-close, or composer tests. Record that permission failure as an external blocker; do not fall back to tmux input and do not spend provider turns on a run that can never pass.

## Establish the source and machine baseline

Create the run boundary before building. The harness must first define the idempotent cleanup in the final section and install `EXIT`, `INT`, `TERM`, and `HUP` traps that tolerate an unset or partially written manifest. Then use a full UUID for evidence and a short derived tag for socket-safe paths:

```sh
umask 077
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(uuidgen | tr '[:upper:]' '[:lower:]')"
RUN_TAG="$(printf %s "$RUN_ID" | shasum -a 256 | cut -c1-12)"
TEST_ROOT="/private/tmp/hive-a-$RUN_TAG"
mkdir "$TEST_ROOT"
printf '%s\n' "$RUN_ID" > "$TEST_ROOT/.hive-acceptance-owner"
MANIFEST="$TEST_ROOT/ownership.tsv"
printf 'owner\tkind\tidentity\tdisposition\n%s\troot\t%s\tdelete\n' \
  "$RUN_ID" "$TEST_ROOT" > "$MANIFEST"
```

Append every allowed repository root, test path, process tuple, port, socket, tmux session, window, and evidence file to the manifest as it is created; absence from the manifest means no authority to mutate or delete it. Before each shell, LaunchServices, root, or UI action, append the absolute executable, complete resolved target tuple, decision, and result to the action journal. The runner must preserve that journal, its enforced allowlist, the traps, watcher records, and a trace of filesystem mutations; prose instructions or terminal history are not equivalent controls.

Capture a production baseline `B0` before the first build or test action:

1. source branch, `HEAD`, full `git status --porcelain=v1`, a digest of the status plus tracked diff, Git common directory, index state, and both allowed repository toplevels;
2. the installed CLI and app as absolute paths; `command -v hive`, each link's raw `readlink` text and `realpath`, the install root's `current` and `state.json`, `hive --version`, and content/metadata digests of the selected version without following a link during hashing;
3. the installed instance's resolved `HIVE_HOME`, instance id, app/daemon/root PIDs, process start times, executable paths, daemon lock contents, port, tmux socket and sessions, provider/app-server sockets, and the `/handshake` document (product/build, wire range, schema epoch, capabilities, instance id, and project identity);
4. stable config files and values plus `HIVE_HOME="$PROD_HOME" HIVE_DISABLE_UPDATES=1 HIVE_NO_UPDATE_CHECK=1 "$PROD_HIVE" routing export --port "$PROD_PORT"`, including its revision; hash the outputs for comparison;
5. one bounded `GET http://127.0.0.1:$PROD_PORT/health` returning HTTP 200 with `ok: true` and `database.status: ok`, followed by a matching handshake. `/health` runs SQLite `PRAGMA quick_check`, so it is a checkpoint sentinel, not the continuous poll; do not overlap requests or use a write endpoint;
6. provider CLI absolute paths and `--version` output only—never provider auth material—and all matching Workspace, Hive daemon/helper, vendor child, tmux server, and app-server processes and sockets.

The initial tree may be dirty. The baseline is evidence, not a demand to discard the user's work.

Start a cheap watcher before launching development Hive. At a measured and reported cadence (one second unless the report states another value), compare the installed app, daemon, and root PIDs, start times, and executables; lock, port, socket, and tmux identities; and the matching `/handshake` with `B0`. Do **not** call `/health` in this loop. Run one bounded, non-overlapping `/health` request at preflight, immediately before and after each named development-launch, lifecycle, UI, teardown, Workspace-close, and cleanup phase, and for the final sentinel. Re-run the full install/config/routing comparison at those same boundaries. The first missing or late watcher sample, watcher exit, missing process, changed identity/start time/executable, handshake/endpoint mismatch, unhealthy checkpoint, or install/config/routing deviation fails acceptance and enters cleanup. The watcher must never signal or auto-repair production; cleanup may target only manifest-owned development identities.

## Build and install the development release

The production builder is the source of truth (`src/release/build.ts`). Before constructing the candidate, run the repository's declared validation gates:

```sh
bun test
bun run typecheck
(cd workspace && swift test)
```

From the unchanged repository root, choose an unused three-component test version and the recorded commit, then run:

```sh
bun run src/release/build.ts \
  --version "$TEST_VERSION" \
  --commit "$TEST_COMMIT" \
  --out "$TEST_ROOT/build"
```

The builder produces two compiled CLI slices, one universal `HiveWorkspace.tar.gz`, and `hive-release.json`. For the host architecture, create exactly the native layout implemented by `src/update/paths.ts`, entirely below the marked test root:

```text
$TEST_ROOT/install/
  versions/$TEST_VERSION/
    hive
    HiveWorkspace.app/
  current -> versions/$TEST_VERSION
```

Copy the matching `hive-darwin-arm64` or `hive-darwin-x64` slice to `versions/$TEST_VERSION/hive`, preserve executable mode, extract `HiveWorkspace.tar.gz` into that same version directory, and create the **test-owned** `current` as a relative symlink. Create it once before launch; do not invoke the installer or any activation primitive. No machine-wide binary link is needed. Record the temporary link's raw and resolved targets plus hashes of the manifest, CLI, and app contents in the ownership manifest, then forbid overwriting or rebuilding that candidate. The complete acceptance procedure must exercise this exact immutable candidate. If its bytes or the source tree change, clean the development fleet, construct a new candidate, and restart acceptance from preflight.

Set the common development environment and absolute binary:

```sh
HIVE_INSTALL_ROOT="$TEST_ROOT/install"
HIVE_BIN_LINK="$TEST_ROOT/bin/hive"
HIVE="$HIVE_INSTALL_ROOT/current/hive"
export HIVE_INSTALL_ROOT HIVE_BIN_LINK
export HIVE_DISABLE_UPDATES=1 HIVE_NO_UPDATE_CHECK=1
test "$(realpath "$HIVE")" = \
  "$(realpath "$HIVE_INSTALL_ROOT/versions/$TEST_VERSION/hive")"
```

Prove the installation rather than assuming it:

- the CLI's real path is inside the temporary `versions/$TEST_VERSION` tree;
- `"$HIVE" --version` reports the test version and commit;
- `"$HIVE" update status` reports a release build, `install: native`, and updates disabled;
- `HiveWorkspace.app` resolved through `current` is the bundle the CLI opens;
- process command lines for the GUI feed, supervisor, daemon, hooks, and spawned agents name this exact temporary binary, not another `hive` on `PATH`;
- `B0` and the live production sentinel still match before the first development launch.

An unsigned local artifact is acceptable for development acceptance because it was built from the working tree rather than downloaded. Signing/notarization remain separate packaging gates and must not be falsely reported as exercised when local signing material is absent.

## Public command lifecycle in the empty test repository

The dedicated lifecycle repository is:

```text
/Users/scottkellar/Projects/hive-test-project
```

It must already be a Git repository and must contain no application code. This section is a required acceptance procedure, but documenting or changing it does not authorize running it; execute it only as part of an explicitly requested acceptance run and only after the immutable candidate above exists. Give the whole group a fresh temporary `HOME`, common temporary `TMPDIR`/`HIVE_INSTALL_ROOT`/`HIVE_BIN_LINK`, both update-disable variables, and no `HIVE_HOME`; bind those values on each initial `init` or bare launch invocation. This preserves the public unqualified-command semantics while isolating every write from the user's installation.

First launch one development Hive from the actual Hive source repository and record its project identity, instance home/id, daemon PID/port, tmux socket, and Workspace PID. Keep it running as the run-owned foreign-project sentinel. Then, from the lifecycle repository, use the temporary binary by absolute path and prove these contracts:

1. `"$HIVE" init --no-graphify` completes repository setup but creates no daemon lock, PID file, port file, tmux server/session, or Workspace process. The foreign-project sentinel remains byte-for-byte the same process and continues answering its handshake.
2. The first bare absolute-path `"$HIVE"` creates a new `$HOME/.hive/instances/run-<uuid>` home, daemon, ephemeral port, database, tmux namespace, instance id, and Workspace process for `hive-test-project`.
3. A second bare absolute-path `"$HIVE"` from the same directory creates another distinct set of all seven resources. It must not focus, reuse, replace, or stop the first test-repository instance.
4. Immediately after each bare launch, run `HOME="$LIFECYCLE_HOME" "$HIVE" instances`, capture that launch's absolute home as `FIRST_HOME` or `SECOND_HOME`, and record its instance id, port, lock, and process tuple. Then use `HIVE_HOME="$FIRST_HOME" "$HIVE" status` and `HIVE_HOME="$SECOND_HOME" "$HIVE" status`; query each handshake only on its recorded port and require its recorded instance id. These bound checks prove both test-repository instances remain distinct and that the foreign-project sentinel retains the same tuple throughout. Uninstall is deliberately not an acceptance command.
5. Cleanup closes only the two test-repository Workspaces and their instances. The run-owned sentinel is stopped separately through its own manifest-verified instance path. The installed production Hive remains outside this fleet and must continue matching `B0`.

Capture process tables, `HOME="$LIFECYCLE_HOME" "$HIVE" instances`, lifecycle files, and daemon handshakes before and after every command. After discovery, every status, handshake, UI, and cleanup action must bind and reverify the exact recorded home, instance id, port, process identities/start times/executables, and window; never rely on the parent shell's `HIVE_HOME`. A new port alone is not proof of a new instance, and a surviving PID alone is not proof that another instance remained usable.

## Prepare three isolated instances

Create three disjoint instance roots and private temporary directories beneath `TEST_ROOT`, labelled with the run id, such as `CLAUDE-I1`, `CODEX-I2`, and `GROK-I3`. For every launch command bind that instance's recorded `HIVE_HOME` and `TMPDIR`, `HIVE_PORT=0`, the common temporary `HIVE_INSTALL_ROOT`/`HIVE_BIN_LINK`, and both update-disable variables on the same invocation. Retain the account's existing `HOME` and `PATH` so signed-in provider CLIs and tmux remain discoverable; do not inspect or copy their credentials. Invoke Hive itself only as `"$HIVE"`. After launch, bind every instance operation to the recorded home and, where the command supports it, the recorded port; verify the handshake instance id before any lifecycle or UI mutation.

Do not pass `--instance`. Compute and record the source-defined instance id as the first ten hexadecimal characters of SHA-256 over `realpath(HIVE_HOME)`:

```sh
INSTANCE_ID="$(printf %s "$(realpath "$HIVE_HOME")" | shasum -a 256 | cut -c1-10)"
TMUX_SOCKET="hive-$INSTANCE_ID"
```

After launch, record the ephemeral port from `$HIVE_HOME/daemon.port`, the PID/start time/instance id from `$HIVE_HOME/daemon.lock` and process readback, the `hive-<agent>-$INSTANCE_ID` and `hive-orchestrator-$INSTANCE_ID` sessions, app-server sockets, Workspace PID/window, and every test evidence-log path. Hive launches the app with `open -n` and the daemon with ignored stdout/stderr; it defines no persistent service label or daemon log path, so record the service label as `none` and keep harness evidence logs below `TEST_ROOT` rather than inventing product settings.

From the actual repository directory, initialize each instance with Graphify explicitly enabled. Init must leave that instance without daemon lifecycle files; the following public launch is what creates them:

```sh
HIVE_HOME="$I_HOME" TMPDIR="$I_TMP" HIVE_PORT=0 \
  HIVE_INSTALL_ROOT="$HIVE_INSTALL_ROOT" HIVE_BIN_LINK="$HIVE_BIN_LINK" \
  HIVE_DISABLE_UPDATES=1 HIVE_NO_UPDATE_CHECK=1 "$HIVE" init --graphify
HIVE_HOME="$I_HOME" TMPDIR="$I_TMP" \
  HIVE_INSTALL_ROOT="$HIVE_INSTALL_ROOT" HIVE_BIN_LINK="$HIVE_BIN_LINK" \
  HIVE_DISABLE_UPDATES=1 HIVE_NO_UPDATE_CHECK=1 "$HIVE" graphify status
```

Graphify passes only when each enabled instance reports the pinned local bundle healthy, its graph current, and a real root/agent `graph_locate` call returns a relevant repository result. A missing graph that correctly degrades is valid normal operation but does not satisfy this enabled-Graphify acceptance criterion.

Launch all three visible workspaces concurrently from the same shell working directory:

```sh
HIVE_HOME="$CLAUDE_HOME" TMPDIR="$CLAUDE_TMP" HIVE_PORT=0 \
  HIVE_INSTALL_ROOT="$HIVE_INSTALL_ROOT" HIVE_BIN_LINK="$HIVE_BIN_LINK" \
  HIVE_DISABLE_UPDATES=1 HIVE_NO_UPDATE_CHECK=1 "$HIVE" claude
HIVE_HOME="$CODEX_HOME" TMPDIR="$CODEX_TMP" HIVE_PORT=0 \
  HIVE_INSTALL_ROOT="$HIVE_INSTALL_ROOT" HIVE_BIN_LINK="$HIVE_BIN_LINK" \
  HIVE_DISABLE_UPDATES=1 HIVE_NO_UPDATE_CHECK=1 "$HIVE" codex
HIVE_HOME="$GROK_HOME" TMPDIR="$GROK_TMP" HIVE_PORT=0 \
  HIVE_INSTALL_ROOT="$HIVE_INSTALL_ROOT" HIVE_BIN_LINK="$HIVE_BIN_LINK" \
  HIVE_DISABLE_UPDATES=1 HIVE_NO_UPDATE_CHECK=1 "$HIVE" grok
```

Do not assume the environment on those invocations crosses the Workspace boundary. Verify three separate application PIDs, windows, instance ids, daemon locks, ports, databases, capability directories, runtime markers, tmux socket names, sessions, evidence logs, and provider session artifacts. At the LaunchServices, Workspace, feed, root, hook, and spawned-agent boundaries, inspect the actual arguments, environment, and executable: require the recorded absolute `--hive`, `--instance-home`, `--instance-id`, `--port`, and `--tmux-socket` values where applicable. All three project arguments and root PTYs must resolve to the actual repository. Bracket each launch and GUI phase with the production sentinel.

In each Workspace, select **Agents → Full Autonomy (No Permission Prompts)**. Verify the menu checkmark only after the feed confirms `dangerous`, confirm the same value with `HIVE_HOME="$I_HOME" "$HIVE" autonomy --port "$I_PORT"`, and inspect each spawned agent's recorded launch configuration. A Codex reader that raises an approval prompt or requires a person to continue fails acceptance, but its filesystem sandbox must remain read-only. The read-only Codex root must also call Hive's own orchestration MCP without prompting; its narrow Hive-server preapproval is independent of the writer-autonomy dial.

## Visible prompt-driving contract

Every root prompt is sent through the visible Workspace terminal:

1. activate the intended Workspace process and focus queen's pane;
2. type or paste the complete prompt as one editing action;
3. confirm the instance's root composer typing marker exists (`runtime/composers/queen.typing` preferred; `runtime/composers/orchestrator.typing` still accepted during compatibility);
4. wait outside the TUI's paste-coalescing interval;
5. send Enter as a separate input event;
6. confirm the composer marker clears only after its grace interval and that the structured root status moves to `working`;
7. wait for the structured terminal boundary and require the status to return to `idle`.

Do not use tmux injection to impersonate human root input. Tmux capture may be used as read-only evidence after a visible interaction, never as the launch or submit mechanism.

## The 3×3 compatibility matrix

Use unique instance, agent, task, and correlation identifiers in every cell. Each root must use Hive's normal orchestration tools to spawn exactly one Claude Code agent, one Codex agent, and one Grok agent. Spawn Claude and Grok writers (`readOnly=false`) so those cells exercise the selected full-autonomy posture; the assignment itself remains strictly read-only. Spawn Codex only as a reader (`readOnly=true`): every Codex writer path is contained and must refuse before creating a worktree or process. The Codex cell proves no-prompt read access without weakening the read-only sandbox; it is not evidence of a Codex writer posture. Separately attempt one Codex writer request and record the containment refusal and absence of a worktree/process. The no-op task template is:

When the installed Codex exposes `app-server`, configure at least one Codex reader cell with `codex.driver = "app-server"`. Require its host and child process environments to carry `HIVE_CAPABILITY_TOKEN` from the cell's `0600` credential without exposing the value in argv, then prove that reader can call authenticated `hive_status` and acknowledge a critical control with `hive_ack_message`. The same cell must retain every writer-host and mutation-approval refusal.

```text
READ-ONLY HIVE ACCEPTANCE TASK <task-id>, correlation <correlation-id>.
Do not modify files, the worktree/index, configuration, installed software,
user data, or system state. Return the exact identifiers, `pwd`,
`git rev-parse --show-toplevel`, `git rev-parse --git-common-dir`, and a
read-only `git status --porcelain=v1` summary. Call graph_locate once for the
composer lease implementation and report the top relevant Hive source path.
Reply only to queen (your originating orchestrator; `orchestrator` still works as a recipient) and identify your agent/provider.
Finish the response and return to the provider's normal input prompt. Do not
call an inbox, status, wait, or polling tool merely to remain alive.
```

The last two lines are load-bearing. An agent that keeps a turn open in a wait
primitive has not reached the normal-message delivery boundary; a correctly
queued follow-up can then appear stuck even though routing is healthy.

For every cell, prove:

1. the requested provider starts with the expected model/autonomy configuration and no blocking dialog (Codex remains a reader);
2. its database row, tmux session, worktree ownership, local capability, and UI pane belong to the correct instance;
3. it receives the exact task and correlation identifiers;
4. its response returns to the originating root and is attributed to the correct agent;
5. neither identifier occurs in either sibling instance's message store, pane, inbox, or logs;
6. a second uniquely identified read-only follow-up reaches the same agent and returns correctly;
7. status is always a known measured state while the process is live—`working`, `idle`, or a measured attention state, never a fabricated healthy value and never unexplained `unknown`;
8. closing the agent pane stops and reaps that agent cleanly without changing sibling agents or instances.

Record all nine cells explicitly:

| Orchestrator | Claude Code agent | Codex agent | Grok agent |
| --- | --- | --- | --- |
| Claude Code | required | required | required |
| Codex | required | required | required |
| Grok | required | required | required |

## Composer non-interruption acceptance

The implementation guard is common, but acceptance must exercise each provider transport visibly.

For a live Claude agent pane, Codex agent pane, Grok agent pane, and at least one root pane:

1. arrange a delayed, uniquely identified normal Hive message from its originating root or agent;
2. focus the target pane and type a unique partial draft without submitting it;
3. prove the target's `.typing` marker exists before the message is sent;
4. wait until the message is durably queued;
5. verify byte-for-byte that the visible draft remains present, unchanged, and unsubmitted, and that no new turn starts;
6. cancel the draft with a real TUI cancellation input or submit it deliberately;
7. verify the queued message is delivered exactly once only after the lease clears.

Repeat one case with critical intent. Authority must revoke immediately in durable state, but process interruption must wait until the human draft leaves the composer. A normal, native, urgent, steer, critical, or root path that types over, submits, cancels, or interrupts the human draft fails the release.

## Simultaneous routing and lifecycle isolation

With all three roots and all nine agents alive, submit three distinct follow-ups at nearly the same time through the three visible roots. Require every response to return only to its originating instance. Compare all instance message stores by identifiers, not by visual impression.

Then:

1. close one agent pane and verify only that agent's tmux session/process tree disappears;
2. continue a follow-up exchange with agents in both other instances;
3. close one complete Workspace and verify its app, root, agents, daemon, tmux server, sockets, and feed exit while the other two stay live;
4. continue a follow-up exchange in both survivors;
5. relaunch the stopped provider through its public Hive command from the repository root;
6. verify it gets its own fresh root conversation and attaches only to its own retained instance state, never either survivor's state;
7. re-run one unique message in the restarted instance and check cross-instance absence again.

## Repository no-op proof

Capture a repository and worktree baseline after Hive has created the expected agent worktrees/configuration but immediately before model work begins. After every task wave, compare:

- primary worktree `git status --porcelain=v1 -z` and tracked diff digest;
- index tree and branch/reference inventory;
- every agent worktree's tracked and untracked status;
- project documentation and generated Graphify paths.

Hive's own setup and teardown may create and remove its documented worktrees, ownership refs, graph output, or generated runtime config. The orchestrators and agents may not introduce an additional change. Attribute changes by time and path; do not hide a delta by resetting it.

Repository cleanup uses the same ownership rule as process cleanup. Remove only a path or ref created by this run whose marker/ownership ref and real identity match the manifest. Preserve and report pre-existing, foreign, stranded, or unknown state; never reset, clean, or delete it to make the comparison pass.

## Final validation, cleanup, and evidence

After the acceptance behavior is green, close the **development** fleet. The installed Hive remains running. The repository validation gates ran before the immutable candidate was constructed; at final validation, re-hash the candidate and require byte-for-byte equality with the manifest. Do not build a fresh artifact after the run and describe it as accepted. No separate formatter, linter, or documentation-check script is declared in `package.json`; do not invent one. Documentation validation is the wiki audit: verify every referenced source path/command against the tree, check all internal Markdown links, ensure `docs/index.md` contains the article, append the material change to `docs/log.md`, and search for removed/superseded terminology.

Cleanup is idempotent and follows this order on success, failure, or interruption:

1. stop new test actions and capture each development process tree, executable, start time, window, tmux socket/session, socket, and lock **before** destroying tmux state;
2. close only manifest-owned development windows, then run `HIVE_HOME="$I_HOME" "$HIVE" stop` only after the recorded home, instance id, daemon PID/start time/executable, port/handshake, and app PID all match the manifest; never fall back to a production or unknown target;
3. poll until every owned daemon, root, agent, feed, app-server host, tmux server/session, socket, lock, and Workspace process is measured absent; a missing owned item is idempotent success, while a surviving, changed, or unknown identity is retained and fails the run;
4. let normal instance teardown settle active shared-quota reservations. Do not delete machine-wide quota/audit rows, provider records, or provider usage; they are retained shared evidence, not disposable local artifacts;
5. remove repository artifacts only with matching ownership evidence, preserving unlanded work and all pre-existing or unknown state;
6. transfer declared evidence to a path outside the run root with an explicit ownership record, then delete every remaining allowlisted test-owned home, build, temporary install, log, and artifact. For every deletion, require the exact `RUN_ID` marker, compare `realpath` with the manifest and a `/private/tmp/hive-a-*` or other explicitly recorded test prefix, refuse symlink escapes or wrong owners, and remove without following symlinks.

Acceptance passes only when both conditions are true:

- every run-owned process, home, socket, lock, build, temporary install, log, and other disposable artifact is absent. Only explicitly transferred evidence, retained shared quota/provider audit records, and preservation-required work may remain; inventory those exceptions, and treat any retained run-owned runtime or unknown state as incomplete cleanup and a failed run; and
- the installed CLI/app/current/config/routing and process identity/start-time/executable tuple equals `B0`, every cheap watcher sample matched, and every bounded checkpoint plus the final read-only sentinel succeeds after cleanup.

The report must name the tested source/commit, `RUN_ID` and manifest, temporary installation proof, watcher cadence and samples, all three root results, all nine matrix cells, simultaneous routing and composer-protection evidence, Graphify result, defects/fixes, validation commands, ownership-guarded cleanup, final repository status, and final commit hash. It must disclose shared quota/audit rows, provider usage, UI focus changes, and transient host resources as residual effects; those fail acceptance only when they violate `B0`, breach an ownership boundary, or make production unhealthy. Exact external-service or permission blockers are recorded by cell with sanitized evidence; they are never converted into passes.

The exact attestation is permitted only when the runner actually enforced and preserved the ownership manifest, command/target allowlist, traps, cheap watcher and bounded health checkpoints, action journal across every shell/LaunchServices/root/UI boundary, and filesystem-mutation trace. This repository currently supplies the contract, not that runner. A manual or prompt-only run must report reduced assurance, is ineligible for a formal acceptance pass, and must not claim or paraphrase that production was “never targeted.” When the enforcement evidence exists, include this attestation exactly:

> The installed Hive process remained continuously running and responsive, was never targeted by lifecycle or activation operations, its installed target/config remained unchanged, and it remained functional after cleanup.

## See Also

- [Multiple concurrent instances](../daemon/multi-instance.md) — the instance boundary and shared-machine exceptions
- [Orchestrator status](../daemon/orchestrator-status.md) — measured root state and honest unknown
- [Workspace blueprint](../workspace/blueprint.md) — visible product surface and composer leases
- [Graphify integration](../graphify/integration.md) — enabled graph behavior and degradation rules
- [Versioning and release](versioning-and-release.md) — native artifact and activation contract
