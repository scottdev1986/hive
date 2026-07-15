# Pre-release acceptance testing

Updated: 2026-07-14
Source: Hive source tree and native Workspace acceptance, 2026-07-14

## Summary

This is the release gate for the installed Hive product. It is deliberately not a unit-test recipe, a daemon-only simulation, a copied repository, a separate worktree, or the Workspace's internal `--smoke` diagnostic. Acceptance builds the current working tree into Hive's native versioned layout, verifies the public command lifecycle against the dedicated empty repository at `/Users/scottkellar/Projects/hive-test-project`, then launches three visible Workspace processes from the actual Hive repository and drives the real Claude Code, Codex, and Grok TUIs.

A run is complete only when the 3×3 orchestrator-to-agent matrix, simultaneous routing, status, Graphify, composer protection, lifecycle isolation, repository no-op checks, and cleanup all pass. An unexecuted cell is not a pass.

## Non-negotiable boundaries

- Run the provider matrix with the actual Hive checkout under test as its working directory. Resolve and record that Git toplevel at run time; do not use a copied repository, temporary repository, or separate worktree for a matrix root.
- Run the command-lifecycle cases only in `/Users/scottkellar/Projects/hive-test-project`. It is the durable empty external Git repository for this purpose, not a copy or worktree of Hive. Record its own toplevel and clean baseline before the run; do not add Hive source or fixtures to it.
- Use a fresh temporary native installation and private temporary homes. The command-lifecycle group sets a fresh `HOME` and deliberately leaves `HIVE_HOME` unset so it exercises ordinary automatic instance selection without touching the user's real `~/.hive`; the provider matrix sets a distinct temporary `HIVE_HOME` and `TMPDIR` per controlled instance. Invoke the temporary release binary by absolute path. Never modify, upgrade, uninstall, or put a link in front of the user's existing Hive installation.
- Before testing any newly built artifact, close every Workspace created by the prior build, run its instance-scoped stop path, and prove its daemon, root, agents, tmux server, app-server sockets, and Workspace process are gone. Evidence from a fleet that spans builds is invalid.
- Launch only through `hive claude`, `hive codex`, and `hive grok`. Private helper commands are implementation details, and `--smoke` is not acceptance.
- Provider authentication belongs to the provider CLIs. The acceptance run may rely on their existing signed-in sessions, but it must not query, create, import, copy, inspect, or modify passwords, API keys, session secrets, or keychain entries. Hive's local `.cap` files authorize calls to Hive's own daemon; they are not provider credentials.
- Every task executed by an orchestrator or spawned agent is read-only. It may report unique identifiers, `pwd`, Git toplevel/common-dir facts, status output, and Graphify query results. It may not edit files, Git state, configuration, installed software, user data, or system state.
- Human input and transport input are separate owners. GUI automation must type the prompt, wait, send Enter as a second event, and verify that a provider turn actually begins. A typed-but-unsubmitted prompt is a failure.
- Preflight the GUI driver's macOS Accessibility permission before building or launching the fleet. A driver that cannot focus the Workspace and generate real key events cannot execute the visible-input, pane-close, or composer tests. Record that permission failure as an external blocker; do not fall back to tmux input and do not spend provider turns on a run that can never pass.

## Establish the source and machine baseline

Record before building:

1. current branch, `HEAD`, full `git status --porcelain=v1`, and a digest of the status plus tracked diff;
2. the existing Hive command resolution, if any, and a recursive metadata/content digest of its installation root without changing it;
3. provider CLI paths and `--version` output only—never provider auth material;
4. all matching Workspace, Hive daemon/helper, vendor child, tmux server, and app-server processes and sockets;
5. the Git common directory and the current worktree/index state.

The initial tree may be dirty. The baseline is evidence, not a demand to discard the user's work.

## Public command lifecycle in the empty test repository

The dedicated lifecycle repository is:

```text
/Users/scottkellar/Projects/hive-test-project
```

It must already be a Git repository and must contain no application code. This section is a required acceptance procedure, but documenting or changing it does not authorize running it; execute it only as part of an explicitly requested acceptance run. Give the whole group a fresh temporary `HOME`, common temporary `TMPDIR`/`HIVE_INSTALL_ROOT`, and no `HIVE_HOME`; this preserves the public unqualified-command semantics while isolating every write from the user's installation.

First launch one Hive from the actual Hive source repository and record its project identity, instance home/id, daemon PID/port, tmux socket, and Workspace PID. Keep it running as the foreign-project sentinel. Then, from the lifecycle repository, run the installed test binary by absolute path and prove these contracts:

1. `hive init --no-graphify` completes repository setup but creates no daemon lock, PID file, port file, tmux server/session, or Workspace process. The foreign-project sentinel remains byte-for-byte the same process and continues answering its handshake.
2. The first unqualified `hive` creates a new `~/.hive/instances/run-<uuid>` home, daemon, ephemeral port, database, tmux namespace, instance id, and Workspace process for `hive-test-project`.
3. A second unqualified `hive` from the same directory creates another distinct set of all seven resources. It must not focus, reuse, replace, or stop the first test-repository instance.
4. `hive uninstall --repo` from `hive-test-project` removes only Hive's footprint from that repository. Before signaling any selected daemon, its project handshake must match `hive-test-project`; the foreign-project sentinel must retain the same PID, port, instance id, agents, tmux namespace, and Workspace process throughout.
5. Cleanup closes only the two test-repository Workspaces and their instances. The sentinel is stopped separately through its own instance-scoped close path.

Capture process tables, `hive instances`, lifecycle files, and daemon handshakes before and after every command. A new port alone is not proof of a new instance, and a surviving PID alone is not proof that uninstall left the foreign Hive usable.

## Build and install the development release

The production builder is the source of truth (`src/release/build.ts`). From the repository root, choose an unused three-component test version and the recorded commit, then run:

```sh
bun run src/release/build.ts \
  --version "$TEST_VERSION" \
  --commit "$TEST_COMMIT" \
  --out "$TEST_ROOT/build"
```

The builder produces two compiled CLI slices, one universal `HiveWorkspace.tar.gz`, and `hive-release.json`. For the host architecture, create exactly the native layout implemented by `src/update/paths.ts`:

```text
$TEST_ROOT/install/
  versions/$TEST_VERSION/
    hive
    HiveWorkspace.app/
  current -> versions/$TEST_VERSION
```

Copy the matching `hive-darwin-arm64` or `hive-darwin-x64` slice to `versions/$TEST_VERSION/hive`, preserve executable mode, extract `HiveWorkspace.tar.gz` into that same version directory, and create `current` as a relative symlink. No machine-wide binary link is needed for acceptance.

Prove the installation rather than assuming it:

- the CLI's real path is inside the temporary `versions/$TEST_VERSION` tree;
- `HIVE_INSTALL_ROOT=$TEST_ROOT/install $TEST_ROOT/install/current/hive --version` reports the test version and commit;
- `hive update status` reports a release build and `install: native`;
- `HiveWorkspace.app` resolved through `current` is the bundle the CLI opens;
- process command lines for the GUI feed, supervisor, daemon, hooks, and spawned agents name this exact temporary binary, not another `hive` on `PATH`.

An unsigned local artifact is acceptable for development acceptance because it was built from the working tree rather than downloaded. Signing/notarization remain separate packaging gates and must not be falsely reported as exercised when local signing material is absent.

## Prepare three isolated instances

Create three disjoint instance roots and private temporary directories beneath `TEST_ROOT`, labelled with unique run identifiers such as `CLAUDE-I1`, `CODEX-I2`, and `GROK-I3`. For every command set that instance's `HIVE_HOME`, its `TMPDIR`, and the common temporary `HIVE_INSTALL_ROOT`; keep the caller's existing `PATH` so the real provider CLIs and tmux remain discoverable.

From the actual repository directory, initialize each instance with Graphify explicitly enabled. Init must leave that instance without daemon lifecycle files; the following public launch is what creates them:

```sh
"$HIVE" init --graphify
"$HIVE" graphify status
```

Graphify passes only when each enabled instance reports the pinned local bundle healthy, its graph current, and a real root/agent `graph_locate` call returns a relevant repository result. A missing graph that correctly degrades is valid normal operation but does not satisfy this enabled-Graphify acceptance criterion.

Launch all three visible workspaces concurrently from the same shell working directory:

```sh
"$HIVE" claude
"$HIVE" codex
"$HIVE" grok
```

Each line above runs under its own `HIVE_HOME`/`TMPDIR` environment. Verify three separate application PIDs, windows, instance ids, daemon locks, ports, databases, capability directories, runtime markers, tmux socket names, sessions, logs, and provider session artifacts. All three project arguments and root PTYs must resolve to the actual repository.

In each Workspace, select **Agents → Full Autonomy (No Permission Prompts)**. Verify the menu checkmark only after the feed confirms `dangerous`, confirm the same value through public `hive autonomy`, and inspect each spawned agent's recorded launch configuration. A Codex agent that raises an approval prompt or requires a person to continue fails acceptance. The read-only Codex root must also call Hive's own orchestration MCP without prompting; its narrow Hive-server preapproval is independent of the writer-autonomy dial.

## Visible prompt-driving contract

Every root prompt is sent through the visible Workspace terminal:

1. activate the intended Workspace process and focus its orchestrator pane;
2. type or paste the complete prompt as one editing action;
3. confirm the instance's `runtime/composers/orchestrator.typing` marker exists;
4. wait outside the TUI's paste-coalescing interval;
5. send Enter as a separate input event;
6. confirm the composer marker clears only after its grace interval and that the structured root status moves to `working`;
7. wait for the structured terminal boundary and require the status to return to `idle`.

Do not use tmux injection to impersonate human root input. Tmux capture may be used as read-only evidence after a visible interaction, never as the launch or submit mechanism.

## The 3×3 compatibility matrix

Use unique instance, agent, task, and correlation identifiers in every cell. Each root must use Hive's normal orchestration tools to spawn exactly one Claude Code agent, one Codex agent, and one Grok agent. Spawn writer agents (`readOnly=false`) so the run actually exercises the selected full-autonomy posture; the assignment itself remains strictly read-only. A capability-enforced reader can prove no-prompt read access, but it cannot prove that a writer received the selected autonomous launch configuration. The no-op task template is:

```text
READ-ONLY HIVE ACCEPTANCE TASK <task-id>, correlation <correlation-id>.
Do not modify files, the worktree/index, configuration, installed software,
user data, or system state. Return the exact identifiers, `pwd`,
`git rev-parse --show-toplevel`, `git rev-parse --git-common-dir`, and a
read-only `git status --porcelain=v1` summary. Call graph_locate once for the
composer lease implementation and report the top relevant Hive source path.
Reply only to your originating orchestrator and identify your agent/provider.
Finish the response and return to the provider's normal input prompt. Do not
call an inbox, status, wait, or polling tool merely to remain alive.
```

The last two lines are load-bearing. An agent that keeps a turn open in a wait
primitive has not reached the normal-message delivery boundary; a correctly
queued follow-up can then appear stuck even though routing is healthy.

For every cell, prove:

1. the requested provider starts with the expected model/autonomy configuration and no blocking dialog;
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

## Final validation, cleanup, and evidence

After the acceptance behavior is green, close the whole fleet before running or accepting another build. Run the repository's declared validation gates:

```sh
bun test
bun run typecheck
(cd workspace && swift test)
bun run src/release/build.ts --version "$TEST_VERSION" --commit "$TEST_COMMIT" --out "$FRESH_OUT"
```

No separate formatter, linter, or documentation-check script is declared in `package.json`; do not invent one. Documentation validation is the wiki audit: verify every referenced source path/command against the tree, check all internal Markdown links, ensure `docs/index.md` contains the article, append the material change to `docs/log.md`, and search for removed/superseded terminology.

The final acceptance run uses the fresh final build, not an earlier artifact. On success:

- close every test Workspace and run each instance's stop path;
- prove no test daemon, root, agent, feed, app-server host, tmux server/session, socket, lock, or Workspace process remains;
- remove only the temporary install, homes, temp directories, build output, logs, caches, and evidence created by the run;
- prove the user's pre-existing Hive resolution and installation digest are unchanged;
- prove no generated acceptance artifact remains in the repository;
- preserve the evidence summary outside the repository until the report is written;
- review and commit the final source, tests, and documentation changes without rewriting history or pushing.

The report must name the tested source/commit, temporary installation proof, all three root results, all nine matrix cells, simultaneous routing and composer-protection evidence, Graphify result, defects/fixes, validation commands, cleanup, final repository status, and final commit hash. Exact external-service or permission blockers are recorded by cell with sanitized evidence; they are never converted into passes.

## See Also

- [Multiple concurrent instances](../daemon/multi-instance.md) — the instance boundary and shared-machine exceptions
- [Orchestrator status](../daemon/orchestrator-status.md) — measured root state and honest unknown
- [Workspace blueprint](../workspace/blueprint.md) — visible product surface and composer leases
- [Graphify integration](../graphify/integration.md) — enabled graph behavior and degradation rules
- [Versioning and release](versioning-and-release.md) — native artifact and activation contract
