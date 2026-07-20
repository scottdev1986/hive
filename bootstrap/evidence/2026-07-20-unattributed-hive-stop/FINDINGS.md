# The 2026-07-20 fleet kills: attribution and root causes (#70)

Instance: `/tmp/hv-a27e3d322a`. All timestamps UTC (the instance DB is UTC;
the macOS unified log is local — converted where used).

## What happened

Two fleet-kill waves, each audited as an operator-privileged `hive stop`:

| Wave | UTC | ppid (gone) | Killed | Audit reason |
|---|---|---|---|---|
| 1 | 21:30:44.686–.705 | 30723 | liam, lucas | `hive stop ppid=30723 argv=[]` |
| 2 | 21:41:39.907–.949 | 59066 | lucas, ava, ethan, henry | `hive stop ppid=59066 argv=[]` |

Each wave killed every then-live agent, the daemon and Workspace survived,
and lucas's row read `status=working` afterwards (it still does in the
incident DB). The operator ran neither.

## Attribution: positively identified mechanism, with a working reproduction

**The killer was `stopHive()` running inside a `bun test` process whose
environment had inherited the live instance's `HIVE_HOME`.**
`src/cli/control.test.ts` (pre-fix) contained two tests — "does not report
success or remove lifecycle evidence while the daemon is live" and "reports
success only after liveness proves the daemon dead" — that called `stopHive`
with `liveness`, `kill` and `cleanup` mocked but `readAgents`,
`readSessiondBinding` and, fatally, `stopSessiond` left to their defaults.
Those defaults reach through the ambient environment: the real instance
database (live agent list with exact session locators), the real
`daemon.port`, and the real operator credential. The mocked `kill` meant the
daemon was never SIGTERMed, and the mocked `liveness` (forever "live") made
the test *pass* while the fleet died.

Every observed fact matches, and nothing else does:

- **`argv=[]`** — `process.argv.slice(2)` under `bun test` is `[]` (verified
  empirically; a shell `hive stop` records `["stop"]`, a compiled binary the
  same). Only an in-process library call produces `[]`.
- **Ephemeral ppid** — the parent of the `bun test` process is the agent's
  transient tool shell, gone minutes later.
- **The kill sets** — wave 1 killed exactly the two agents whose rows were
  live at 21:30 (liam, lucas); wave 2 exactly the four rows live at 21:41
  (lucas-still-`working`, ava, ethan, henry), in agent-row order — the
  signature of `stopHive`'s default `readAgents` enumerating the instance DB
  and fanning out via `Promise.allSettled`.
- **Daemon survived** — `kill` was a test mock; SIGTERM never happened.
- **Origin string** — `hive stop ppid=N argv=[]` is built only at
  `killOrigin("stop")` inside `stopHive`'s default `stopSessiond`.

**Reproduction** (`src/cli/stop-ambient-fleet-kill.test.ts`): a scratch
`HIVE_HOME` with a live sessiond agent row, terminal-host binding, operator
credential and a `daemon.port` aimed at a capture server; `stopHive` invoked
with exactly the incident's partial dependencies from inside `bun test`.
Against the pre-fix code the capture server records
`POST /agents/maya/kill origin="hive stop ppid=85280 argv=[]"` — the incident
signature byte-for-byte. Post-fix, the same call refuses before any HTTP.

**Who ran it:** wave 1 coincides with liam implementing the #68 slice, whose
brief required the full test suite; wave 2 with ava (who had just committed
the rescue at 21:35:25Z and carried the same full-suite instruction) and/or
henry (writing red tests for this very incident). Both wave-2 candidates were
themselves killed by the wave. The runner identity is high-confidence
circumstantial; the mechanism is proven. Note the self-kill: the runner's own
agent row was in the fleet it enumerated, so the `bun test` process killed
itself mid-run — which is why no failure report ever surfaced.

### Hypotheses refuted

- **`make clean` → `hive stop`** (the issue's leading hypothesis): refuted.
  `clean` signals processes directly (`kill "$p"`), never shells out to
  `hive stop`, and its ancestor-exclusion protects the invoking chain. It
  also cannot produce `argv=[]`.
- **Workspace quit path**: `AppDelegate.swift` runs the hive binary with
  `arguments = ["stop"]` → `argv=["stop"]`, and the Workspace survived both
  waves.
- **launchd/cron/another session/second daemon**: none produce `argv=[]`
  with the observed DB-enumeration kill sets; no scheduled job invoking hive
  exists in the repo.
- **e2e suites (`e2e-real`, b22 harness)**: both isolate `HIVE_HOME` to
  scratch homes and/or run the CLI as a subprocess (`argv=["stop"]`), and
  the opt-in gates (`HIVE_E2E=1`) were not set.

## The four defects and their fixes (one branch)

1. **Authorization — any shell was "operator."** The CLI granted fleet-kill
   to whoever could read the credential file, including agent worktree
   shells and test runners. Fixed in `stopHive` (src/cli/control.ts): an
   agent-worktree invoker (cwd path-prefix check, `src/cli/invoker.ts`) is
   refused outright; a test-runner process (`NODE_ENV=test`) is refused
   unless the stop transport is explicitly injected (`invokedViaCli` exempts
   the real CLI subprocess); and the daemon re-checks the invoker cwd
   against its own worktree root and agent worktree paths (403, audited
   deny). Client-reported identity is accident prevention, not a security
   boundary — a same-UID process can read the operator credential
   (`credentials.ts` says the same).

2. **Atomicity — agents died under a stop that never completed.** The CLI
   fanned out per-agent kills and only then SIGTERMed the daemon; any
   failure (guaranteed when the runner kills itself) left partial kills
   under a live daemon. Fixed by moving the stop into the daemon:
   `POST /stop` (src/daemon/server.ts) evaluates every gate — operator
   auth, invoker, #65 binding verification (now server-side), unlanded
   work — before anything dies, then commits and drives every kill and its
   own exit (`initiateShutdown` → SIGTERM self) to completion regardless of
   the client's fate. A teardown failure reports `stop-failed` and leaves
   the daemon up (exiting over survivors would strand them). Red tests:
   refusal paths kill nothing; a vanished client does not abort a committed
   stop; concurrent stop answers `already-stopping`.

3. **Attribution — a bare ephemeral ppid.** `killOrigin` now records the
   full invoker identity (`src/cli/invoker.ts`): pid, ppid chain with
   process names, argv, cwd, agent-worktree flag — carried in the `/stop`
   request and written to every per-agent allow audit row.

4. **Truthfulness — `hive_status` reported audited-dead lucas as
   `working`.** Root cause: `killAgentTeardown` marks the row dead only
   after `stopAgentProcesses` returns; lucas's sessiond termination
   readback failed *after* his processes were gone, the teardown threw, and
   the row stayed `working` forever (both waves; still visible in the
   incident DB). Fixed: a teardown failure now re-inspects the tree; a
   provably-exited tree (sessiond presence `exited` / tmux session lost)
   still completes the teardown and marks the row dead. Absence that cannot
   be proved keeps the failure — unreachable is not dead. Red test plus
   fail-closed positive control in server.test.ts.

**Corroboration from the fix itself:** the new test-runner guard immediately
caught a second in-repo instance of the same pattern —
`native/sessiond/test/ts-live-create.ts` called `stopHive` from inside
`bun test` (correctly isolated to a scratch `HIVE_HOME`, but structurally one
env-leak away from the incident). It now injects its stop transport
explicitly.

## `hive stop` semantics after the fix

- Unlanded work refuses the stop, names each agent with its branch, dirty
  file count and unmerged commits, and requires a TTY confirmation or
  `hive stop --force`.
- An agent worktree shell can no longer stop the fleet, with or without
  `--force`, client-side and daemon-side.
- The `#65` "no unverifiable sessiond teardown" invariant moved into the
  daemon, where it gates the same request that kills.

## Residual risks

- Invoker identity is client-reported; a malicious same-UID process can
  still read the operator credential and lie. Out of scope here (and of any
  same-UID design); the fix targets accidental fleet-kills, which is what
  both waves were.
- A dead-daemon `hive stop` still sweeps tmux sessions directly (unchanged
  fallback); sessiond agents without a daemon cannot be killed through it.
- If an audited kill fails and the tree's absence cannot be positively read
  (e.g. broker unreachable for inspection), the row deliberately stays as it
  was and the error surfaces — status may still say `working` in that
  narrow, honest-uncertainty case.
