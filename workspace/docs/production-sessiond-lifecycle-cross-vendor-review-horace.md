# Production sessiond lifecycle cross-vendor review

- Pin reviewed: `fdfc36174b3a8be2b6458d5dfc82d527bc97ef77` on
  `hive/helena-production-sessiond-lifecycle`.
- Author: Helena (Grok). Reviewer: Horace (Codex).
- Baseline comparison: issue #37 and landed teardown fix
  `16908cc14093ea61c7a35e8d10ed7aaed3ea9834`.
- Method: the pin was materialized detached and verified clean before and after
  all probes. Mutations were temporary, produced the expected RED result, and
  were restored before the final green runs.

## Verdict: **NO-LAND**

The build, staging, ordinary ownership, crash recovery, restart bound, clean
teardown, and architecture mappings all reproduce successfully. Two production
blockers remain: the exact pin reverses landed teardown semantics, and an orphan
holding `broker.lock` lets daemon startup report success before supervision
fails asynchronously.

## Blocking findings

### B1. The pin reverses landed `16908cc1` teardown semantics

The pin's parent is `552a62414bdc35e995ca5c35d7a9f98b22b82c98`, and its
merge-base with `16908cc1` is also `552a6241`. A direct comparison of the exact
trees shows both parts of Heidi's landed fix removed:

- `stopSessiondAgentSession` once again lets
  `SessiondBrokerUnavailableError` escape, instead of treating an unreachable
  broker with no surviving captured processes as an already-dead session.
- `HiveDaemon.stop()` once again throws directly from `killAllAgents()` and
  skips daemon-resource cleanup, instead of retaining the refusal, cleaning up,
  and rethrowing it after the daemon is inert.

Helena's new ordering at `src/daemon/server.ts:2081-2097` is correct on the
success path: agents are killed before the broker. It does not preserve the
landed refusal path. If agent teardown refuses, the broker stop and daemon
cleanup in `HiveDaemon.stop()` are skipped. The CLI's `finally` stops the broker,
but the rejected signal handler never reaches database closure or `process.exit`,
and its `stopping` guard ignores later signals. This recreates the wedged quit
that `16908cc1` fixed.

Required fix: rebase or replay the lifecycle change on `16908cc1` or newer,
retain cleanup-on-refusal and unreachable-broker semantics, then add a
regression that exercises managed shutdown with the production broker wiring.

### B2. An orphan broker does not fail daemon startup

The module comment claims an orphan holding `broker.lock` "fails startup
visibly" (`src/daemon/sessiond-broker.ts:13-17`), but readiness is only
`existsSync(broker.sock)` (`:195-223`). A socket created by the orphan therefore
makes the newly spawned child look ready before that child reports
`BrokerAlreadyRunning`.

Real staged-binary reproduction, using a private short `HIVE_HOME`:

1. Start `.dev/root/current/hive-sessiond serve` as the orphan and wait for its
   real broker socket.
2. Start `.dev/root/current/hive daemon` against the same home.
3. Measure the daemon lifecycle files, processes, and captured stderr.

Observed:

```text
orphan broker pid: 23388
daemon pid: 23395
daemon.port present: yes
daemon alive after startup: yes
surviving broker count: 1 (the orphan only)
four child starts: error: BrokerAlreadyRunning
supervisor: gave up after 3 restarts in 60000ms
onFatal log: sessiond broker supervision failed fatally
daemon exit after SIGTERM: 0
```

Single ownership is not violated—no second broker survives—but startup itself
succeeds and advertises a live daemon before the supervisor fails. The
`onFatal` callback in `src/cli/daemon.ts:82-88` only logs; it does not turn this
already-completed startup into a nonzero failure.

Required fix: startup readiness must prove that the owned child, not a
pre-existing socket, became the live broker. Add a real-binary orphan-lock test
that requires the daemon to remain unadvertised and exit nonzero.

## #37 checklist

### 1. Single ownership — **FAIL (B2), with duplicate prevention confirmed**

- `runDaemon()` acquires `daemon.lock` before resolving and starting sessiond
  (`src/cli/daemon.ts:69-89`).
- A second staged daemon against one live home exited 1 with
  `Hive daemon ... is already starting or running`, while process readback
  showed the same single broker before and after the attempt.
- The orphan probe also retained exactly one broker, but daemon startup did not
  fail as required.

### 2. Crash recovery — **PASS**

- Default policy is three restarts in a 60-second sliding window
  (`src/daemon/sessiond-broker.ts:29-30, 243-280`), followed by state `failed`,
  visible stderr, and one `onFatal` call.
- Unit suite: 6 pass / 0 fail, exit 0.
- Unit mutation: changing the effective budget from 2 to 12 made the bounded
  test fail at `expected failed, received running`, exit 1. Restored run passed.
- Real-binary suite: unit plus live, 8 pass / 0 fail, exit 0. The live test sent
  SIGKILL, observed a different PID, and completed a real HELLO engine query.
- Live mutation: forcing the first crash to exhaust the budget made the
  SIGKILL-to-HELLO test fail at `expected running, received failed`, exit 1.
  Restored run passed.
- Restart begins only from the old child's resolved `exited` promise. In the
  staged proof PID 24614 was replaced by 24680; direct `ps -p 24614` returned 1,
  proving the old process was dead. No broker remained after teardown.

### 3. Teardown ordering — **FAIL (B1)**

The success path orders `killAllAgents()` before broker stop. The exact pin
nevertheless removes both landed `16908cc1` protections and can wedge on a
refusal before daemon cleanup.

### 4. Install and staging — **PASS**

- `src/release/build.ts` emits `hive-sessiond-darwin-arm64` and
  `hive-sessiond-darwin-x64`, with Zig targets `aarch64` and `x86_64`.
- Sessiond uses `-Doptimize=ReleaseFast`, matching both GhosttyKit and
  `libghostty-vt` release builds in `scripts/build-ghosttykit.sh`; the engine
  fence therefore compares the same optimization mode.
- `install.sh` maps `arm64 -> arm64` and `x86_64 -> x64`, downloads, verifies,
  and stages sibling `hive-sessiond`. `src/update/install.ts` selects sessiond
  by the same manifest architecture and re-proves its digest on reuse.
- Makefile mappings were evaluated in both directions with exit 0:

```text
arm64|hive-darwin-arm64|hive-sessiond-darwin-arm64|aarch64|arm64
x86_64|hive-darwin-x64|hive-sessiond-darwin-x64|x86_64|x86_64
```

- Install/update/manifest suites: 69 pass / 0 fail, exit 0.
- This proof used Helena's pinned Makefile and sessiond staging. Hank's separate
  `0dd1862c` entrypoint pin was not folded into the reviewed tree and does not
  supply the sessiond install step.

### 5. Adoption carve-out — **PASS**

There is no half-adoption branch in the supervisor: every daemon start spawns a
fresh child. The carve-out and its missing peer/PID proof are documented at the
top of `src/daemon/sessiond-broker.ts`; issue #37 remains open. The actual fresh
broker story is blocked only by B2's readiness bug, not by an implicit adoption
path.

### 6. Independently rerun proofs

| Check | Result |
|---|---|
| exact materialized HEAD | `fdfc36174b3a8be2b6458d5dfc82d527bc97ef77`, clean |
| native provenance | Ghostty `73534c46...`, Zig ARM SHA `3cc2bab3...`, patch series `ddeaf792...`; preserved lock byte-identical |
| `make build` | exit 0 |
| staged `hive` | executable arm64 Mach-O |
| staged `hive-sessiond` | executable arm64 Mach-O |
| staged `HiveWorkspace.app` | universal arm64 + x86_64 Mach-O |
| `bun scripts/sessiond-lifecycle-staged-proof.ts` | PASS, exit 0 |
| staged ownership | daemon-owned broker, `harnessSpawnedBroker: false` |
| staged crash recovery | PID 24614 -> 24680; old PID absent |
| staged teardown | no broker remained; daemon exit 0 |
| `bun run typecheck` | exit 0 |

No command under review was piped through a truncating command; the recorded
statuses are the real process exit codes.

## Delta re-review: Helga `ec6866fb` — **NO-LAND**

- Pin: `ec6866fbaaf5cb6f82e217356fb2b81d1c5f7da3` on
  `hive/helga-fix-two-review-blockers-on-the`.
- Base: `539a7782ecae0ab255502762be38e857bf00edca` is an ancestor and
  the merge-base. The replay commit carries the reviewed lifecycle onto that
  base; the follow-up changes only `sessiond-broker.ts` and its unit/live tests.

### B1 delta — PASS

The replay leaves `teardown.ts` and its tests byte-identical to `539a7782`.
`HiveDaemon.stop()` retains the teardown refusal, stops the broker after
`killAllAgents()` but outside that refusal catch, cleans the timer/socket/db,
then rethrows. Heidi's teardown/server matrix passed 92/92; typecheck passed.

### B2 delta — still blocking

The exact normal-load staged probe now behaves correctly:

```text
orphan pid: 34613 (the only surviving broker)
daemon exit: 1
daemon.port advertised: no
daemon alive after startup: no
stderr: ... before becoming the live broker: broker.lock held by pid 34613
```

However, readiness still does not positively measure ownership. When a socket
predates spawn, `spawnAndWaitReady()` accepts the child merely for remaining
alive through `OWNERSHIP_SETTLE_MS = 250`. A child delayed by scheduling,
dynamic loading, or resource pressure can remain alive for that interval before
reaching the broker lock and losing it.

Mutation proof: in the new orphan unit test, change only the losing child's
`exitAfterMs` from 40 to 400. The socket still predates spawn and the child still
exits 1, but `supervisor.start()` resolves after about 259 ms. The test goes RED
at its intended assertion:

```text
Expected promise that rejects
Received promise that resolved
```

This is the original advertise-then-fail race with a 250 ms timing threshold.
The mutation was restored and the exact pin returned green. Startup must use
positive evidence that the owned child holds `broker.lock` (or equivalent
non-temporal ownership evidence), not elapsed liveness.

### Delta proofs

| Check | Result |
|---|---|
| supervisor + Heidi teardown/server suites | 99 pass / 0 fail (7 + 92), exit 0 |
| real-binary broker live suite | 3 pass / 0 fail, exit 0 |
| `make build` | exit 0; staged version reports `ec6866fb` |
| exact staged orphan probe | correct fail-loud result, exit 0 |
| staged lifecycle proof | PASS; broker 36270 -> 36294; clean teardown |
| `bun run typecheck` | exit 0 |
