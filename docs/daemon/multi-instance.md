# Multiple concurrent instances

**Status:** design, approved for review — not implemented. No code in this plan has been written.

## Summary

Hive is far closer to multi-instance than it looks, because `HIVE_HOME` is *already* the instance key. The tmux session names, the Codex root socket, the per-agent Codex sockets, the credentials directory, the orchestrator's MCP config root, `hive.db`, `daemon.pid` and `daemon.port` are all keyed on it, and two of those sites carry comments explaining that the key exists to disambiguate *instances*. The isolation is roughly 90% built and it stops, precisely and completely, at the listener.

So this is not a new architecture. It is finishing one, plus four places where the shared world — one git repo, one provider account, one `~/.claude.json`, one `current` symlink — genuinely cannot be partitioned and must be *shared safely* instead.

The one thing that must not be missed: **the fixed port is currently an accidental mutex.** Two daemons on one `HIVE_HOME` are prevented today only because the second `Bun.serve` fails to bind 4483. Moving to ephemeral ports removes that protection, so the explicit per-instance daemon lock is not a follow-up — it must land in the same change. **This was measured, and the measurement corrected the reason** (see [§8, the T1 experiment](#8-the-t1-experiment-measured-2026-07-13)): the harm is not database corruption, which WAL prevents cleanly. It is an *invisible, accumulating daemon*.

## 1. What an instance is

**An instance is a `HIVE_HOME` directory.** Its identity is `hiveInstanceSuffix()` = `sha256(resolve(HIVE_HOME)).slice(0, 10)` — a function that already exists (`src/daemon/tmux-sessions.ts:13-21`) and is already used to name tmux sessions and Codex sockets.

- **Default instance:** `~/.hive`, exactly as today. Zero migration.
- **Named instances:** `~/.hive/instances/<name>`, created on demand by `hive --instance <name>`.
- **Discovery:** the instances directory *is* the registry. Enumerate `~/.hive/instances/*/`, read each `daemon.port`/`daemon.pid`, probe `GET /handshake`. There is deliberately **no shared mutable registry file**, because a shared registry needs a lock and a lock needs an owner; a directory listing needs neither, and a dead instance's stale `daemon.port` is already handled by the existing liveness probe (`isRunning`, `src/daemon/lifecycle.ts:41-60`).

An instance is *not* keyed by project. A project may host several instances, and — once the daemon stops refusing it (§3, T2) — an instance may host several projects, which is what the existing `project-registry.json` and `hiveUuid` machinery was always built for.

### How a Claude Code orchestrator binds to the right daemon

This is the sharpest existing defect, and it is a "measure, don't infer" failure. The daemon's port travels **argv** — `hive` → Workspace app (`--port`, `src/cli/workspace.ts:110-111`) → back into `hive workspace-orchestrator --port N` (`src/cli.ts:789`) — while `HIVE_HOME` is resolved independently from each subprocess's **environment** (`src/daemon/db.ts:160-162`). Nothing cross-checks the pair, and `runWorkspaceOrchestrator` performs no handshake. The two halves of an instance's identity come from two different sources.

Today that is survivable because there is only one daemon. With two, instance A's orchestrator can post events and MCP calls to **instance B's daemon** (whoever now owns the port) while reading **instance A's credential file** — and if B's daemon restarts onto A's old port, it silently *works*.

**The fix: bind on identity, not on a port.** Add `instanceId` to `DaemonHandshake` (`src/daemon/handshake.ts:17-27`, `handshakeMismatch` at `:113`), pass `--instance <id>` alongside every `--port`, and have each entry point verify that the daemon answering that port reports the expected instance before it does anything else. A port is an integer somebody passed us; the handshake is the daemon telling us who it is. Wrong-daemon then becomes a loud refusal instead of silent misrouting.

### Alternatives rejected

| Model | Why it lost |
|---|---|
| **One daemon per project** | Directly violates the requirement: two instances on the *same* project become impossible. |
| **One machine-wide daemon, multiplexed by an instance column in one DB** | Violates "killing one must not disturb another" — quitting one instance would take the shared daemon, and every other instance, with it. It also converts the single-writer SQLite topology (`docs/daemon/database-resilience.md:31-35`) into a contended one for *all* state, not just the state that is genuinely shared. |
| **Instance = a random UUID minted per launch** | Nothing on disk would be derivable from it. `hiveInstanceSuffix` already exists, is already load-bearing for tmux and sockets, and is *stable across restarts* — which a per-launch UUID is not, so recovery and reattach would break. |
| **Instance keyed by project root** | Same-project instances collide, and it discards the existing `HIVE_HOME` scoping for nothing. |
| **A quota "broker" daemon owning the provider account** | Creates a cross-instance liveness dependency: kill the broker and every instance loses quota routing. The requirement forbids exactly this. A shared *file* with TTL'd rows (§4) gets the same sharing with no owner to kill. |

## 2. The shared/singleton resource table

Scoping legend: **I** = per-instance, **P** = per-project, **G** = genuinely global and safe to share.

### Already correct — no work

| Resource | Site | Scoping |
|---|---|---|
| tmux session names | `tmux-sessions.ts:20-31` (`hive-<agent>-<suffix>`) | I ✅ |
| Codex root socket | `cli/orchestrator.ts:36-51` | I ✅ |
| Codex per-agent sockets | `tools/codex-app-server.ts:333-350` | I ✅ |
| `hive.db` + identity marker | `db.ts:164-172` | I ✅ |
| `daemon.pid` / `daemon.port` *files* | `lifecycle.ts:12-18` | I ✅ |
| Credentials (`credentials/*.cap`) | `daemon/credentials.ts:27-42` | I ✅ |
| `config.toml`, `runtime/`, `projects/<uuid>/` | `config/autonomy.ts:76`, `launch-prompt.ts:26`, `profile.ts:112` | I ✅ |
| Orchestrator MCP config root | `cli/orchestrator.ts:116-118` (`$HIVE_HOME/runtime/orchestrator`) | I ✅ |
| Per-agent `.mcp.json` / vendor configs | `spawner-impl.ts:709-712`, `tools/claude.ts:458`, `codex.ts:338`, `grok.ts:190` | I ✅ — each carries its **owning daemon's real port** |
| Inbox, approvals, orchestrator wake path | rows in `hive.db`; MCP is served *by* the daemon, not a separate process (`database-resilience.md:33`) | I ✅ — per-instance by construction |
| Cross-instance daemon *killing* | `update/daemon.ts:105-110` — identity checked before version | I ✅ — already refuses |
| Graphify tool bundles, global skills | `adapters/graphify.ts:47`, `skills.ts:66` | G ✅ — content-addressed / read-mostly |

### Broken — must fix

| Resource | Current scoping | Required | Collision today |
|---|---|---|---|
| **Listening port** | Global constant `4483` (`lifecycle.ts:34`) | I | Second daemon gets `EADDRINUSE`; the detached child dies with `stderr: "ignore"` (`lifecycle.ts:150`), so the user sees only `"Hive daemon failed to start"`. No collision detection or retry anywhere. |
| **Daemon-per-instance mutex** | *Implicit*, via the fixed-port bind failure | I | **None exists.** Once ports are ephemeral, both daemons bind successfully (measured, §8). `hive.db` survives — but `daemon.port`/`daemon.pid` name only the *last* writer, so the first daemon becomes live, healthy, and **invisible to Hive's own discovery**, and every subsequent start stacks another one on top of it. |
| **`ensureStarted` reuse gate** | Refuses any non-matching project outright (`lifecycle.ts:134-139`) | I | *"Refusing to reuse live Hive daemon... Stop the existing daemon before starting this project."* This is today's explicit single-instance enforcement. |
| **Agent name allocation** | First-fit over `NAME_POOL`, arbitrated by a row in the instance's **own** DB (`spawner-impl.ts:400`, `db.ts:1065`) | P | **Guaranteed, not probabilistic:** two fresh instances both deterministically pick `maya`, then `david`. |
| **Worktree path** `.hive/worktrees/<name>` | Agent name + repo root, **no existence check** (`adapters/worktrees.ts:172-182`) | P | Instance B's first spawn hard-fails on a raw git error (`fatal: '...worktrees/maya' already exists`). No fallback to the next name. |
| **`hive/*` branch namespace** | Agent name + task slug | P | Shared namespace; every glob-based sweep is instance-blind. |
| **Landing** | No lock at all (`landing.ts:367-413`); `index.lock` is only TOCTOU-*detected* (`:243`) | P | The **landing lease is named but unimplemented** — `project-identity-core/git.ts:117-122` documents `repoFamilyKey` as *"the landing-lease key... they must serialize rebase → retest → fast-forward"*, and nothing consumes it as a lock. |
| **Stranded-branch sweep** | Derived from **git refs**, owners matched against the instance's own DB (`server.ts:1904-1930`) | P | Instance B sees A's live branch, finds no owner row, and tells **its orchestrator to "land or discard"** a sibling's in-flight work. It never deletes — but it instructs an LLM to. |
| **`hive uninstall --repo`** | Repo root; force-removes *every* `.hive/worktrees/*` and `git branch -D`s every `hive/*` (`uninstall.ts:134-167`) | P | Destroys a live sibling's unlanded work. `--force`/`-D` bypass the stranded-work guard that protects `hive_kill`. |
| **`hive uninstall` (machine)** | `rm -rf installRoot()` + `binLink()` (`uninstall.ts:242-243`) | G | Deletes the binary out from under every other instance, whose daemons keep running on an open image — a live daemon with no CLI. |
| **`hive update` activation** | Flips the global `current` symlink after consulting **one** daemon's quiescence (`update/daemon.ts`) | G | Bricks every *other* instance mid-team (§5). |
| **Repo memory** `.hive/memory` | Repo root; writes serialized by an **in-process** promise chain only (`server.ts:1016-1020`) | P | Two daemons = two chains, no mutual exclusion. Article writes are plain `writeFile` (`memory.ts:413`) — last writer wins, silently. |
| **`~/.claude.json` trust seeding** | Machine-global (vendor-owned), guarded by a **process-local** queue (`tools/claude.ts:374-377`) | G | Read-modify-rename; two daemons drop each other's `projects[...]` entries → an agent wakes on a blocking trust dialog, or a read-only agent silently loses its deny list. |
| **`.git/info/exclude`** | Shared git common dir, unlocked read-modify-write (`adapters/graphify.ts:1015`) | P | Concurrent appends lose lines. |
| **`project-config-cleanup`** | Regex matches **any** port: `/^http:\/\/127\.0\.0\.1:\d+\/mcp$/` (`project-config-cleanup.ts:31-34`) | P | Instance B's boot-time repair strips config entries belonging to instance A. Cross-instance *by construction*. |
| **Grok orchestrator config** | Written to `<repo-root>/.grok/config.toml` (`cli/orchestrator.ts:178-183`) | I | The only orchestrator config that is **not** instance-scoped; two same-repo instances clobber each other's port and token. |
| **Codex telemetry / token usage** | Discovered by **worktree path**, newest-mtime (`token-usage.ts:204-212`, `tool-telemetry.ts:184-186`) | I | Same repo ⇒ identical worktree paths ⇒ instance A can adopt instance B's **live** rollout. See §4. |
| **Workspace app** | One process; windows keyed by **project**; `open -a` reuses the running instance (`cli/workspace.ts:83-92`) | I | A second instance's `--port` is delivered to the already-running app process. Two same-project instances collapse into one window. |
| **Quota ledger** | Reservations live in the instance's own `hive.db` (`quota-ledger.ts:294`) | **G** | Two ledgers, one provider account → up to **2× overshoot**. See §4. |

### Deliberate decisions to ratify

- **Global memory** (`$HIVE_HOME/memory`, `memory.ts:47-49`) follows `HIVE_HOME`, so instances get *separate* global memory. Recommend: keep per-instance for now (it is what the code already does), and revisit — a user's global knowledge arguably wants sharing, but sharing it re-opens the same unlocked-write problem as repo memory.
- **`hiveUuid` is `randomUUID()` per registry** (`project-identity-core/registry.ts:112`), so the same repo carries a *different* uuid in each instance. This cuts both ways: it is why cross-instance daemon killing is already refused (each reads the other as `foreign`), and it is why instance B thinks an already-inited repo is un-inited (`initStampPath` → `$HIVE_HOME/projects/<uuid>/initialized`, `init.ts:200-202`). Recommend: **leave it.** The refusal is worth more than the duplicate init prompt, and init is idempotent.

## 3. Non-obvious hazards

These are the four findings that would not survive a naive implementation, listed because each one converts a "safe" change into an unsafe one.

1. **Ephemeral ports remove an accidental mutex.** Covered above. The per-instance lock and the port change are one atomic piece of work.
2. **Telemetry aliasing becomes *concurrent*, not merely temporal.** The known bug class ("path-keyed reads alias across respawns") is documented in-file at `tool-telemetry.ts:406-410`. Today a Codex reader can inherit a *dead* predecessor's rollout. With two instances on one repo, `.hive/worktrees/<name>` is the same string on disk, so `findLatestCodexRollout(worktreePath)` can adopt a sibling's **live** agent's rollout. The existing "changed-path reset" (`:310-312`) does not bound this — two readers can ping-pong between two live rollouts. And this feeds quota: telemetry drives `reconcileAgentModel` and statusline ingestion, which write `quota_observations` and `quota_usage` (`quota.ts:2001-2044`). Fix by threading `toolSessionId` through the Codex path exactly as Claude already does (`tool-telemetry.ts:167`).
3. **The orphan Codex reaper is safe by accident, and therefore leaking.** It guards against killing another instance's hosts (`codex-app-server.ts:913-917`, and SPEC §12 says *"an unknown id may belong to another hive instance"*) — but the key it extracts from `/^hive-codex-(.+)\.sock\.pid$/` (`:900`, `:929`) is `<instanceSuffix>-<agentId>`, not a bare agent id, so the lookup at `server.ts:1562` always reads `unknown` and the reaper effectively **never fires**. Orphan hosts leak today. Fix the key when making it instance-aware.
4. **The `workspace-feed --port 4483` ambiguity already cost us once.** `AppDelegate.swift:152` carries a cautionary comment about an agent running `pkill -9 -f "workspace-feed --port 4483"` and killing *the user's real feed*, because two processes shared an identical command line (`docs/workspace/blueprint.md:38`). That is the multi-instance ambiguity, already observed, with only one instance running. N instances make identical command lines the norm; every long-lived child must carry its instance id in argv.

## 4. Quota: the one thing that must be shared, not partitioned

The provider account is machine-wide. Partitioning the ledger per instance is not isolation — it is double-spending.

**What already self-heals.** Provider-observed usage is shared truth: all three probes read the logged-in account over the vendor's own credentials (`quota-sources.ts:268`, `:741`, `:1022`), and all three are session-free and non-billable. `supplemental()` (`quota.ts:1437-1459`) computes `provider-observed used − own ledger used`, so once a sibling's spend lands in the provider's meter, both instances converge on the true `used`.

**What cannot heal.** Reservations. `quota-sources.ts:44-46` states it exactly: *"The one thing a provider cannot tell us is how much of a window a future run will consume."* The admission test is `used + reservedLocally + estimate <= allowance − floor` (`quota-ledger.ts:870-883`), and `totals.reserved` is `SUM(...) WHERE status='active'` **from this DB only** (`:823-829`). Instance B sees `reserved = 0` for work instance A has already committed. Both can independently fill the pool to the allowance, and the deep-work floors (`reserveFiveHourPct`, `quota.ts:761-765`) are not protected at all. Up to 2× overshoot, and the repo's standing rule is *accurate numbers only*.

**Decision: one machine-wide reservations database,** `~/.hive/quota.db`, holding `quota_reservations` and `quota_observations` keyed by `(provider, account, pool)`. Everything else in the quota schema stays per-instance.

This is the *only* place a shared writable database is justified, and the justification is that the resource being metered is itself shared. It is affordable because the mechanics already exist: WAL and `busy_timeout = 5000` are set on every connection (`db.ts:379`, `:401`), which is exactly the multi-process case WAL is for.

Two constraints make it satisfy "killing one instance must not disturb another":

- **No owner.** It is a file, not a broker process. Nothing to kill.
- **A dead instance's reservations must expire.** TTL sweeping already exists (`quota-ledger.ts:1463-1467`, `quota.ts:1986`) but only reaps *its own* rows. It must reap any expired row, whichever instance wrote it — otherwise a killed instance wedges the pool for its siblings, which is precisely the disturbance the requirement forbids.

**This contradicts a published doc.** `docs/daemon/database-resilience.md:31` says Hive is *"a single-writer, single-process database."* That stays true of `hive.db`; it becomes false of `quota.db`. The doc must be amended in the same change — an unamended doc is how the next agent "proves" the multi-writer path is a bug.

Also note `account` is hardcoded `"default"` everywhere (`quota-sources.ts:274`, `:747`, `quota.ts:989`). For one logged-in account per machine that is honest, and it is what makes the shared scope key work. It becomes wrong the day two instances authenticate as two different accounts — out of scope here, but it is the seam where that would land.

## 5. Migration, compat, and the `current` pointer

**An existing single-instance install changes nothing and notices nothing.** `HIVE_HOME` still defaults to `~/.hive`; that home is still a valid instance home; its `hive.db`, credentials, and config stay where they are. The only visible change is that the daemon binds an ephemeral port instead of 4483 — and every consumer already discovers the port through `$HIVE_HOME/daemon.port` (`lifecycle.ts:29-31`), which the server already writes with the **actually bound** port (`server.ts:933-943`). `HIVE_PORT=4483` remains honored for anyone who pinned it.

The one-time migration is the shared quota ledger: copy `quota_reservations` + `quota_observations` from the default instance's `hive.db` into a newly created `~/.hive/quota.db`, leaving the originals in place (never delete state on a migration; `database-resilience.md` is unambiguous that absence must refuse and preserve). If `quota.db` cannot be created, the daemon must refuse to route on quota rather than fall back to a private ledger — fail-open on money is the sharpest form of this repo's central bug class.

**The `current` pointer and activation.** `installRoot()` and `currentLink()` are global and *not* keyed by `HIVE_HOME` (`update/paths.ts:25-33`). Activation is one `rename(2)` over `current` (`install.ts:309-315`). Per `docs/release/distribution.md:85`, a Unix process keeps executing its already-open image after a symlink changes, so **activation does not update a running daemon** — download, activation, and daemon restart are three separate events, and the handshake is what refuses to attach a new CLI to an old daemon.

That contract is sound and it is what breaks under multi-instance, because quiescence is consulted for exactly one daemon:

1. `hive update` from instance A flips the global `current` while instance B's daemon is mid-flight with a live team. B is never consulted — the `busy` guard (`update/daemon.ts:112-118`) protects only the invoking instance.
2. B's daemon keeps running the old image. B's next **CLI** call resolves through `~/.local/bin/hive → current/hive` = the *new* binary → `buildHash` mismatch → `ensureStarted` throws *"Refusing to reuse live Hive daemon... Stop the existing daemon"* (`lifecycle.ts:134-139`). **Instance B is bricked mid-team** until manually restarted.

The version skew is already *detected* correctly (`handshake.ts:117-118`); what is missing is multi-instance-aware **quiescence**. `inspectDaemonForUpdate` must enumerate every instance (§1's directory listing), and activation must refuse — naming the instance and its live agents — while any instance has a live team. The same enumeration fixes `hive uninstall`: it must refuse to remove `installRoot()`/`binLink()` while another instance is live, rather than deleting the binary out from under a running daemon.

`hive update` keeping the version pinned per-instance was rejected: it would mean two daemons on two builds writing one shared `quota.db`, and the schema-epoch guarantee (`handshake.ts:13`) exists precisely to prevent that.

## 6. Ordered implementation plan

Tasks are grouped into waves. Within a wave, tasks touch disjoint files and can go to separate agents. **T1 is a hard barrier: nothing else is safe until it lands.**

### Wave 0 — the mutex and the port (one agent, indivisible)

**T1. Ephemeral port + explicit per-instance daemon lock.**
Files: `src/daemon/lifecycle.ts`, `src/daemon/server.ts`, `src/cli/daemon.ts`.
- Default `readConfiguredPort()` to `0` (`lifecycle.ts:34`). `HIVE_PORT=0` is *already* legal and the bind path already records the bound port, so the substrate exists.
- Add an O_EXCL lock at `$HIVE_HOME/daemon.lock` holding `{pid, instanceId, startedAt}`, acquired **before** `Bun.serve` and released on exit. Stale locks are detected by pid liveness (the existing `probeDaemonReuse` handshake is the positive control — do not trust the pid alone).
- Close the `ensureStarted` TOCTOU (`lifecycle.ts:127-143`): a loser on the lock waits and re-probes rather than spawning.
- Verify: a test that races two `ensureStarted` calls against one `HIVE_HOME` and asserts exactly one daemon and one `hive.db` writer. **This test must fail before T1 and pass after** — it is the whole point of the wave.

### Wave 1 — instance identity (parallel)

**T2. Instance identity on the wire.** Files: `src/daemon/handshake.ts`, `src/daemon/lifecycle.ts` (⚠️ conflicts with T1 — sequence after it).
Add `instanceId` to `DaemonHandshake` and `handshakeMismatch`. Rework the `ensureStarted` reuse gate so a *different project* is no longer a refusal — it is a second daemon.

**T3. Instance selection + discovery.** Files: `src/cli.ts`, `src/cli/start.ts`, new `src/daemon/instances.ts`.
`--instance <name>` → `HIVE_HOME=~/.hive/instances/<name>`; `listInstances()` by directory enumeration + handshake probe; `hive instances` to print them.

**T4. Bind-on-identity for every argv consumer.** Files: `src/cli.ts` (`--instance` alongside every `--port`), `src/cli/orchestrator-supervisor.ts`, `src/cli/event.ts`, `src/cli/statusline.ts`, `src/cli/workspace-feed.ts`, `src/cli/channel-bridge.ts`.
Each verifies the daemon at `--port` reports the expected `instanceId` before acting. ⚠️ Conflicts with T3 on `src/cli.ts` — same agent, or T3 first.

### Wave 2 — same-repo git contention (parallel; T5/T6 are independent of T7)

**T5. Repo-aware name allocation.** Files: `src/daemon/spawner-impl.ts`, `src/adapters/worktrees.ts`.
`selectAgentName` **already accepts an `unavailable` set** (`spawner-impl.ts:395-403`) — populate it from the repo itself: existing `.hive/worktrees/*` directories and existing `hive/*` branch prefixes. The repo is the only arbiter both instances can see, and `git worktree add` is already an atomic CAS, so keep it as the backstop and retry the next name on failure.
*Rejected:* namespacing worktrees as `.hive/worktrees/<suffix>/<name>`. It churns every path, every munged Claude transcript dir, the uninstall globs, and SPEC's own `hive/maya-auth-api` example, to buy what a two-line `unavailable` feed already buys.

**T6. Branch ownership refs.** Files: `src/adapters/worktrees.ts`, `src/daemon/server.ts` (`reconcileStrandedBranches`, `:1904-1940`).
Mark each branch `refs/hive-owner/<instanceSuffix>/<branch>` — reusing the established `refs/hive-preserved/<branch>` pattern (`worktrees.ts:75-101`). The stranded sweep then skips branches owned by a *live* sibling instead of telling its orchestrator to land or discard them. ⚠️ Conflicts with T5 on `worktrees.ts`.

**T7. The landing lease.** Files: `src/daemon/landing.ts`, `src/daemon/project-identity-core/git.ts`.
Implement the lease `repoFamilyKeyOf` already documents (`git.ts:117-122`): a cross-process lock keyed on the git **common dir**, serializing rebase → retest → ff-merge. ff-only already makes the *loser* safe (it is rejected and retries), so the lease is about eliminating the `index.lock` TOCTOU (`landing.ts:243`) and the thrash, not about correctness of the merge itself. Also fix `:243`, which hardcodes `.git/index.lock` — wrong for a linked worktree.

### Wave 3 — shared-world writes (parallel, fully disjoint files)

**T8. Lock `~/.claude.json` trust seeding.** File: `src/adapters/tools/claude.ts:374-377,401-438`. Replace the process-local queue with a real cross-process lock around read-modify-rename.
**T9. Lock `.git/info/exclude`.** File: `src/adapters/graphify.ts:986-1019`.
**T10. Scope `project-config-cleanup` to its own instance.** File: `src/cli/project-config-cleanup.ts:28-34` — the port-agnostic regex must not strip a sibling's entries.
**T11. Move the grok orchestrator config out of the repo root.** File: `src/cli/orchestrator.ts:178-183` → write under `orchestratorConfigRoot()` like Claude's.
**T12. De-alias Codex telemetry.** Files: `src/daemon/tool-telemetry.ts:184-186`, `src/daemon/token-usage.ts:204-212` — key on `toolSessionId`, not worktree path. Fix the orphan-reaper key (`codex-app-server.ts:900,929`) in the same pass.

### Wave 4 — shared quota (one agent; touches the money)

**T13. Machine-wide `quota.db`.** Files: `src/daemon/quota-ledger.ts`, `src/daemon/quota.ts`, `src/daemon/db.ts`, `docs/daemon/database-resilience.md`.
Move `quota_reservations` + `quota_observations` to `~/.hive/quota.db`; make TTL expiry reap *any* instance's expired rows; migrate the default instance's rows; amend the single-writer doc. Verify with two daemons reserving concurrently against one pool and asserting the admission test refuses the overshoot.

### Wave 5 — surfaces

**T14. Workspace app: key windows on instance.** Files: `workspace/Sources/HiveWorkspace/LaunchConfig.swift`, `AppDelegate.swift`, `ProjectWindowController.swift`, `src/cli/workspace.ts`. Accept `--instance`, open one window per instance (not per project), and put the instance id in every child's argv (`workspace-feed`, per hazard 4).
**T15. Instance-aware update + uninstall.** Files: `src/update/daemon.ts`, `src/cli/update.ts`, `src/cli/uninstall.ts`. Enumerate instances; refuse activation or binary removal while any sibling has a live team; scope `--repo` teardown to the instance's own worktrees and branches.

### File-conflict summary

| File | Tasks |
|---|---|
| `src/daemon/lifecycle.ts` | T1, T2 — **sequence** |
| `src/cli.ts` | T3, T4 — **sequence or same agent** |
| `src/adapters/worktrees.ts` | T5, T6 — **sequence or same agent** |
| `src/daemon/server.ts` | T1, T6 — different regions, but coordinate |
| Everything in Wave 3 | disjoint — safe to fan out |

## 7. Riskiest unknowns, and the cheapest experiment for each

| # | Unknown | Cheapest experiment |
|---|---|---|
| 1 | ~~**Do two daemons on one ephemeral-port config actually both bind and corrupt `hive.db`?**~~ | **SETTLED — see §8.** Both bind. `hive.db` is *not* corrupted. T1 remains a barrier, for a different reason. |
| 2 | **Does WAL genuinely give safe multi-process writes for `quota.db` under our access pattern?** WAL supports it in general; our reservation path does read-then-insert, which is a lost-update shape unless it is one transaction. | Two processes, 500 interleaved `tryReserve` calls each against one pool, assert `SUM(estimatedUnits) <= allowance`. If it fails, the fix is `BEGIN IMMEDIATE`, not a redesign. |
| 3 | **Will the vendor CLIs tolerate double probing?** `quota.ts:956-957` already warns that Claude's usage endpoint *"rate-limits under polling"*, and two instances cannot dedupe each other's probes. | Run the existing `ClaudeQuotaProbe` on two concurrent loops at the production interval for an hour; watch for 429s. If it rate-limits, the shared `quota.db` becomes the natural probe cache too — which is an argument *for* T13, not against. |
| 4 | **Does `open -a` let one app process hold two instances' windows, or do we need `open -n`?** LaunchServices reuses the running instance by design (`workspace.ts:83-92`). | Launch the installed app twice with different `--args` and observe whether the second argv is delivered at all. This decides whether T14 is a windowing change or a process-model change — a much larger fork. |
| 5 | **Is `hiveInstanceSuffix` stable enough to key ownership refs?** It hashes `resolve(HIVE_HOME)`. A moved or symlinked home changes the id and orphans every `refs/hive-owner/*`. | Grep for whether any existing consumer already survives a home move; if not, accept it and say so — the same fragility already governs tmux and socket names, so this adds no new class of failure. |

## 8. The T1 experiment (measured, 2026-07-13)

Run against a throwaway `HIVE_HOME` and a throwaway git repo in a temp dir. The live install was never touched (verified before and after: same pid, same port, uninterrupted uptime).

**Control — the fixed port really is a mutex.** Two daemons, one `HIVE_HOME`, both on a fixed port: the second dies with `hive: Failed to start server. Is port 4599 in use?`. Exactly one daemon survives. The protection we currently rely on is real, and it is entirely accidental.

**Treatment — ephemeral ports.** Two daemons, one `HIVE_HOME`, `HIVE_PORT=0`. **Both bound. Both reported `{"ok":true}` on `/health`.** Two live daemons, one database.

**The database is fine, and I was wrong to say otherwise.** 1,000 authenticated writes fired concurrently at both daemons: **1,000 accepted, 0 rejected, 0 rows lost** (500 via A, 500 via B, all present). `PRAGMA quick_check` → `ok`. `PRAGMA integrity_check` → `ok`. WAL and `busy_timeout` do precisely what they are documented to do, across processes as well as within one.

Two further defences turned out to hold, both for the same structural reason — **the guard lives in SQL, so it serialises across processes for free**:
- Message delivery cannot double-inject: `claimUndeliveredMessages` claims with `UPDATE ... WHERE id = ? AND deliveredAt IS NULL` and tests `changes === 1` (`db.ts:1369-1386`).
- Agent-name allocation still arbitrates correctly, because the reservation is an `INSERT OR IGNORE` against the one shared table (`db.ts:1065`).
- The shared credential table even makes the *overwritten* `operator.cap` authenticate against both daemons.

**What actually breaks is discovery, and it is worse than corruption would have been.** `writeLifecycleFiles` is a blind overwrite (`lifecycle.ts:92-99`), so `daemon.port` and `daemon.pid` name only the **last** daemon to start. The first is orphaned: alive, healthy, holding the database, running its maintenance tick, sweeping resources, probing provider quota — and unnamed anywhere on disk.

Then the second daemon exits normally. `cleanupLifecycleFiles` checks that the recorded pid is its own (`lifecycle.ts:101-108`), sees that it *is*, and **removes `daemon.port` and `daemon.pid`** — while the first daemon is still running. Measured, at that moment:

```
A (:53087) /health  -> {"ok":true, ...}     # alive, serving, spending
readDaemonPort()    -> null
isRunning()         -> false
```

A live daemon that Hive believes does not exist. `hive stop` cannot find it. And `ensureStarted` — seeing `isRunning() === false` — cheerfully starts another one: `hive init` printed `ready — ... (daemon port 54006)` while the orphan was still serving on 53087. **Two daemons alive, one known to Hive, and the count grows by one on every start.** Each orphan holds a database handle, runs maintenance, and spends real money against the shared provider account, with no supported way to see or stop it.

This is the house bug class exactly: the pid file records an **act** (somebody wrote it), never a **state** (who is alive). The fixed port was the only thing keeping the act and the state in agreement.

**Verdict: T1 is a hard barrier.** Not because ephemeral ports corrupt the database — they demonstrably do not — but because ephemeral ports *without a lock* convert a loud, safe failure (`Failed to start server`) into a silent, accumulating leak of invisible daemons. Ship the lock in the same change, and make `writeLifecycleFiles` refuse to overwrite lifecycle files belonging to a live daemon rather than clobbering them.

**Wave ordering is unchanged.** T1 stays the barrier; everything downstream is unaffected. Two corrections to the plan's *reasoning*, both recorded above: the single-writer risk to `hive.db` was overstated (SQL-level guards and WAL cover it), and the real hazard — orphaned undiscoverable daemons — was one I had not identified before measuring.

## See Also

- [Database resilience](database-resilience.md) — the single-writer topology this plan amends for `quota.db` only
- [Orchestrator status](orchestrator-status.md) — the root has no agents row; its status is per-instance by construction
- [Launch mechanics](../providers/launch-mechanics.md) — how agents reach tmux, and why launch identity is immutable
- [Distribution](../release/distribution.md) — activation is a `rename(2)`; a daemon restart is a product event
- SPEC §3 (worktree per writer, ff-only landing), §12 (*"an unknown id may belong to another hive instance"*)
