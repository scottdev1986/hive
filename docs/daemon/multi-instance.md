# Multiple concurrent instances

**Status:** shipped, covered by a two-process live test, and exercised with three concurrent native Workspaces on 2026-07-14. The complete release gate still requires visible GUI-input and composer tests; a run driven through tmux is diagnostic evidence, not acceptance.

## Summary

A Hive instance is a `HIVE_HOME`. The default instance remains `~/.hive`; `hive --instance <name>` selects `~/.hive/instances/<name>`. Each instance has its own identity, daemon lock, ephemeral port, handshake, database, local control-plane capabilities, runtime files, tmux sessions, and project state. Instances may operate on the same repository without sharing control-plane state. A named instance's empty or untouched provisional Model Control policy inherits a one-time copy of the default instance's user-authored policy, so opening a second window does not require re-enabling every model; later edits remain local to that instance. Provider authentication is outside Hive: it uses the vendor CLIs' existing signed-in sessions and never reads or writes provider passwords, API keys, session secrets, or keychain entries.

Workspace launch is order-independent. A named instance always gets its own
macOS process. When the default instance starts after a named one, the launcher
detects the foreign `--instance-id` and requests a new process instead of
letting LaunchServices activate the wrong window and discard the new arguments.

Three resources cannot be isolated by instance and are coordinated instead:

- A repository's worktrees, branches, and Git index are shared. Hive assigns branch ownership and serializes landing.
- Provider quota belongs to the logged-in vendor account. Hive therefore keeps one machine-wide quota ledger.
- Installed releases and the `current` activation pointer are machine-wide. Update, rollback, and machine uninstall run under one mutation lease and refuse while another instance is active or unobservable.

The automated live test starts two real daemon processes on one repository, spawns one agent through each, rejects cross-instance routing, keeps the inboxes separate, lands through the shared repository, and proves that stopping one daemon leaves the other daemon, worktree, lock, and messaging path healthy (`src/daemon/multi-instance.live.test.ts:116-262`). A separate native diagnostic run opened Claude Code, Codex, and Grok Workspaces together from this repository, exercised every orchestrator-to-agent pairing and simultaneous identifier routing, stopped one agent and then one instance, and relaunched that instance without cross-attachment. Because macOS Accessibility permission was unavailable and its prompts were submitted through tmux, that run verifies the instance boundary but does not satisfy the visible-input release gate in [Pre-release acceptance testing](../release/acceptance-testing.md).

## Instance identity and discovery

`hiveInstanceSuffix()` is the first ten hexadecimal characters of SHA-256 over the resolved `HIVE_HOME`. That stable value scopes tmux sessions and other runtime names (`src/daemon/tmux-sessions.ts:9-29`).

The global `--instance <name>` option selects a named home before a command runs (`src/cli.ts:231-238`, `src/daemon/instances.ts:30-54`). The instances directory is the registry: Hive discovers the default home plus directories below `~/.hive/instances`, reads their lifecycle files, and accepts a running instance only when its handshake reports the expected instance id (`src/daemon/instances.ts:76-112`). There is no shared mutable registry file.

Each home permits one daemon:

1. The daemon atomically creates `$HIVE_HOME/daemon.lock` with its PID, instance id, and start time.
2. The listener defaults to port `0`, so the operating system chooses a free port. An explicit `HIVE_PORT` is still honored.
3. The daemon writes the bound port to `$HIVE_HOME/daemon.port`.
4. Clients read that port and verify the daemon handshake before treating it as their control plane.

The lock and ephemeral port are one design unit. An ephemeral port alone would let two daemons start against one home and overwrite each other's lifecycle files. The lock is acquired with exclusive creation before daemon state is opened; a matching live handshake or a recently started live owner protects it (`src/daemon/lifecycle.ts:21-25`, `:121-159`, `:182-188`).

The handshake binds instance identity together with build, wire protocol, schema epoch, and project identity. A client given the wrong port refuses it instead of silently routing to a sibling (`src/daemon/handshake.ts:70-82`, `:89-115`, `:131-150`). Long-lived helper commands receive both `--port` and `--instance-id`; the port is an address, while the handshake is proof of which daemon answered.

Liveness is deliberately three-valued:

- `live`: the lock owner is alive and the daemon on the recorded port returns the matching handshake;
- `dead`: the lock is absent or its owner is positively dead;
- `unknown`: the lock is malformed, the identity differs, the live owner is unreachable, or the handshake does not match.

A live PID is not ownership proof because PIDs are reused. Unknown state preserves work and blocks destructive operations (`src/daemon/lifecycle.ts:48-83`).

## Per-instance and shared state

| Scope | State | Coordination |
|---|---|---|
| Instance | `hive.db`, config, local control-plane capability files, project registry and derived project state (including agent-authored project profiles under `projects/<uuid>/profile/{current.json,state.json}`), runtime files, instance memory | Located below `HIVE_HOME`; named instances may independently profile the same Git project |
| Preference bootstrap | Model Control chains, enablement consent, selection, and effort | One-time copy from the default policy into an empty/untouched named policy; never overwrites a named-instance edit |
| Instance | daemon lock/PID/port, tmux sessions, provider session sockets | Instance suffix plus handshake identity |
| Repository | `.hive/worktrees/*`, `hive/*` branches, Git common directory, repository memory and generated config | Ownership refs and file/landing locks |
| Machine | `~/.hive/quota.db` | SQLite WAL plus transactional admission and instance-owned reservations |
| Machine | installed version directories, the `current` pointer, and the CLI link | Machine mutation lease plus final all-instance liveness gate |

The default home remains compatible with pre-instance state. Legacy unsuffixed tmux sessions are recognized only for the default home, so a named instance cannot adopt them (`src/daemon/tmux-sessions.ts:31-47`). Policy inheritance reads the default database through SQLite's read-only WAL-aware connection and writes a normal audited `import-default-policy` revision into the named database (`src/daemon/instance-settings.ts`, `src/daemon/routing-policy-store.ts`). It does not copy the database file, share a writer, import a provisional no-consent policy, or overwrite a named policy after its own first edit.

## One repository, multiple instances

The repository is the common arbiter for names and work:

- Before allocating an agent name, Hive reads existing worktrees and `hive/*` branches. `git worktree add` remains the atomic backstop when two instances race for the same name (`src/adapters/worktrees.ts:306-351`, `:403-429`).
- Creating a writer branch also writes `refs/hive-owner/<instanceId>/<branch>`. Branch deletion clears that ownership ref (`src/adapters/worktrees.ts:88-143`, `:306-351`).
- Stranded-work reconciliation skips an unpreserved branch owned by a live sibling. It never deletes stranded work itself (`src/daemon/server.ts:2142-2195`).
- Landing holds `hive-landing.lock` in the Git common directory across the complete fast-forward-only landing operation. Release is token-scoped, so one process cannot remove a successor's lease (`src/daemon/landing.ts:115-152`, `:476-482`).
- `hive uninstall --repo` stops only the selected instance and removes only worktrees and branches owned by that instance. The default instance may claim legacy branches that predate ownership refs; named instances may not (`src/cli/uninstall.ts:195-273`, `:275-332`).

These mechanisms are separate on purpose. Ownership prevents one instance from treating a sibling's branch as abandoned; the landing lease serializes mutations even when both branches are valid and ready.

## Quota is one machine-wide unit

The provider account is machine-wide. Partitioning the ledger per instance would be double-spending, not isolation: two instances could each reserve capacity that the other cannot see.

**Decision: one machine-wide quota ledger,** `~/.hive/quota.db`. The ledger moves as a unit; only quota configuration and routing policy stay per-instance. Quota is a property of the logged-in vendor account, not of a Hive instance, so usage, observations, reservations, provider catalogs, and their integrity state all describe one machine-wide resource.

Splitting only reservations and observations would break the current transactional invariants. Reservation reconciliation, usage sequencing, integrity triggers, and observation watermarks form one atomic system. The shared database uses WAL, a five-second busy timeout, and `BEGIN IMMEDIATE` transactions so concurrent daemons serialize check-and-reserve (`src/daemon/quota-ledger.ts:29-44`, `:930-932`, `:1167-1195`).

Every reservation records `instanceId` and `instanceHome`. This prevents same-named agents in sibling instances from aliasing and gives reclamation an owner to check (`src/daemon/quota-ledger.ts:145-165`, `:1594-1617`). Reclamation follows lock-and-handshake liveness, never elapsed time:

- a positively dead owner makes its active reservations reclaimable;
- a live owner keeps its reservations;
- an unknown owner is preserved.

An instance between lock acquisition and handshake publication is therefore protected (`src/daemon/quota-ledger.ts:1600-1617`). The default instance's legacy quota tables are copied once into the shared ledger without deleting the old rows (`src/daemon/quota-ledger.ts:65-144`).

`hive.db` remains a per-instance, single-process database. `quota.db` is the deliberate multi-process exception; see [Database resilience](database-resilience.md).

## Machine-wide mutation gates

Update, rollback, and native machine uninstall mutate global installation state. They acquire a machine mutation lease after any confirmation or safe staging work, then repeat the all-instance blocker check while holding it. Agent spawn and landing register operations in the same coordinator, so neither side can win a time-of-check/time-of-use race (`src/daemon/mutation-lease.ts:13-29`, `:162-255`, `:258-305`).

The lease lives in a private per-user operating-system runtime directory, outside `HIVE_HOME`, because machine uninstall removes Hive's home before releasing the lease (`src/daemon/mutation-lease.ts:59-79`). Release is idempotent and token-scoped.

The final gate enumerates every instance:

- a live daemon blocks when it reports any live agent;
- a live daemon whose team cannot be read is reported as unknown and blocks;
- a starting, unreachable, or otherwise unobservable instance blocks;
- only positively dead instances are ignored.

The refusal names the instance and the observed agents or unknown marker (`src/daemon/instances.ts:115-143`, `src/cli/update.ts:224-231`).

Update may download, verify, and stage bytes while teams are working, because staging does not change `current`. Activation holds the lease, repeats the blocker check, and only then changes the active version (`src/cli/update.ts:291-365`). Rollback follows the same lease and final check (`src/cli/update.ts:199-221`).

Machine uninstall also checks before its prompt, acquires the lease after confirmation, checks again, and stops every idle daemon before removing machine state. If a daemon will not stop, uninstall refuses instead of deleting the binary underneath it (`src/cli/uninstall.ts:335-410`). Repository uninstall does not acquire the machine lease because it does not mutate the global `current` pointer.

## Failure rules

- A lifecycle file records an act, not liveness. The matching lock, process identity, and handshake establish state.
- A wrong instance id, project identity, build, schema epoch, or wire contract is a refusal, never a best-effort reuse.
- Unknown ownership preserves reservations, branches, worktrees, sessions, and installation state.
- A branch ownership ref is evidence of ownership, not permission to destroy unlanded work. Ordinary teardown still preserves stranded work.
- Successful staging is not successful activation. CLI messages distinguish the two.

## See Also

- [Database resilience](database-resilience.md) — the per-instance database and shared quota exception
- [Agent teardown](agent-teardown.md) — instance-scoped process containment and preservation
- [Update experience](../release/update-experience.md) — signed staging, activation, and rollback
- [Distribution](../release/distribution.md) — installed version directories and the `current` pointer
