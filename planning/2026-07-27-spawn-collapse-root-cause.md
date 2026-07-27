# Root cause: the 2026-07-27 20:35 sixteen-spawn collapse

**Date:** 2026-07-27
**Status:** findings only — no fix shipped (per assignment)
**Author:** lucas (writer), instance adc6ff7499, HIVE_HOME `/tmp/hv-a27e3d322a`
**Probe:** `native/sessiond/test/spawn-ceiling.zig` (real broker serve loop, real
sockets, real fork/exec hosts, real `/handshake` fetch; daemon-side 10 s read
timeout reproduced client-side)

## TL;DR

All sixteen hosts were launched successfully by the broker and then **killed
themselves**, one by one, exactly 15 s (+ 4 s graceful bound) after their
individual creation, with `failureCode: VISIBILITY_EXPIRED`. Nobody renewed
their visibility leases in time, because the two single-threaded event loops
that renewal has to cross — the daemon's Bun loop and sessiond's serialized
accept loop — were both saturated by the burst itself, and each one makes the
other slower. The fixed budgets (10 s per-RPC timeout, 15 s initial lease) do
not scale with in-flight spawns. One agent alone (maya) fit inside both
budgets trivially; sixteen did not.

The four failure groups in the kill records are **one bug observed at four
points** of the same path, not four bugs.

## The kill chain, with evidence

### 1. The broker is a strictly serial server, and launching holds the loop

`broker.serve`'s accept loop (`native/sessiond/src/broker.zig:2305-2346`)
accepts **one** connection and serves it to completion — HELLO, then all
frames — before polling again. A CREATE_COMMIT runs the entire launch inline:
fork/exec of the host (`ProductionHostLauncher.launchOne`,
`native/sessiond/src/host_runtime.zig:514-632`), the READY handshake over fd 3
(`launchFreshChild`, `native/sessiond/src/host_registration.zig:308-354`),
connect + neutral-control enable + HOST_ADOPT on host.sock
(`finalizeOne`, `host_runtime.zig:643-698`). No other connection is even
*accepted* while this runs.

Every daemon→sessiond operation — create, the readiness INSPECT polls,
VISIBILITY_RENEW, TERMINATE, attach grants — opens a **fresh** broker
connection and pays a full HELLO each time (`SessiondHost.create/inspect/
terminate/renewVisibility`, `src/daemon/session-host/sessiond-host.ts:680-736,
1049-1100`). There is no pooling or multiplexing anywhere.

Each HELLO costs the broker a **blocking HTTP `GET /handshake` against the
daemon** per connection (`loadDaemonHandshake`, `broker.zig:189-220`, called
from `serveDaemonConnection`, `broker.zig:1697`), plus `daemon.lock` and peer
verification. So the broker's per-connection service time is bounded below by
the daemon's HTTP responsiveness — the two loops are coupled.

### 2. Measured: 16 creates in 5.1 s, every host dead at its own lease +15 s

From `runtime/sessiond/hosts/*/record.json` in the incident home:

- first create admitted 20:35:12.914Z, last 20:35:18.061Z — **16 launches
  serialized in 5.15 s, ≈320 ms each** (vs ≈15–45 ms for the same launch with
  a trivial `/bin/sh` provider on an idle machine — the gap is 16 real vendor
  CLIs + 16 VT engines booting at once).
- every one of the 16 `final.json`: `"failureCode":"VISIBILITY_EXPIRED"`,
  `exitCode: 1`. The lease was created in state `attaching` with
  `expiresAt = createdAt + 15 s` and was never renewed once.
- death order matches creation order; the +4 s `host_graceful_stop_bound_ms`
  tail matches the 2026-07-21 fleet-expiry incident's mechanics exactly
  (`docs/incidents/2026-07-21-fleet-visibility-expiry.md` — same enforcement,
  different trigger).

So the brokers' queue absorbed the creates (~5 s < 10 s timeout): **the burst
of creates alone did not kill the spawns.** What killed them is that no
renewal landed within 15 s of each create.

### 3. Why no renewal landed

Renewal has to cross both loops: the workspace-feed publishes the inventory to
the daemon over HTTP; the daemon fans out `renewVisibility` per terminal
(`src/daemon/server.ts:3931-3971`, 5 s interval, 15 s lease — "Far tighter
than the 30s reconciliation: the lease it defends is 15s",
`server.ts:1478-1488`); each of those is another serialized broker connection
whose HELLO fetches `/handshake` from the daemon again.

Measured in the incident:

- `workspace.log` 20:35:18.436Z: `workspace-feed error: status poll timed out
  after 5000ms` — the daemon's HTTP surface stalled **>5 s during the burst**,
  exactly while the 16 creates were in flight. (16 spawn flows on one Bun
  loop: synchronous sqlite, 16 `git worktree add`s, brief/graph assembly.)
- The first publish the daemon actually processed for the 16 landed at
  20:35:47Z and returned HTTP 409 (renewals attempted, hosts already dead);
  the next at 20:35:52Z timed out. First host expired 20:35:27.9Z. The renewal
  path lost the race by ~20 s.
- From 20:35:45Z onward the Workspace retried viewer attach for all 16 panes
  and got `sessiond NOT_READY: not_ready` — **907 refusals** through 20:39+,
  each one another broker connection keeping the loop busy during the
  recovery window.
- The two auto-resume retries (david gen 2 created 20:36:21Z, liam gen 2
  20:38:50Z) died the same death at their own +15 s — during the attach storm
  the system could not save even a single new spawn. (Additionally the
  Workspace kept the *old generation* in its inventory: `Hive refused to
  attach david: its session generation changed
  [session-locator-mismatch]` from 20:36:17Z on — so the renewal loop, which
  only renews terminals in the accepted workspace inventory, had no path to
  the gen-2 locators at all. Recovery cannot currently produce a renewable
  session; see Open questions.)
- maya (20:29:47Z, alone) had her lease renewed for ten minutes straight —
  the renewal mechanism itself was healthy when the loops were idle.

### 4. What each failure string actually meant

- **Group B ("terminal session exited")** — readiness's `hasSession` (a broker
  INSPECT) answered truthfully: presence absent, because the host had already
  self-terminated VISIBILITY_EXPIRED. Correct observation.
- **Group A ("sessiond HELLO request timed out")** — fired by the fixed 10 s
  per-request timer (`TERMINAL_LIMITS.controlRpcTimeoutMilliseconds`,
  `src/schemas/session-protocol.ts:57`) on a **post-create** RPC: every one of
  the 16 has `createEvidenceJson` set and a `provider_runs` row, so create()
  and the identity inspect loop succeeded for all of them. The 10 s queue
  delay is the coupled stall from §1/§3: once the daemon's HTTP loop stalls,
  *every* broker connection pays seconds for its `/handshake` fetch, and the
  serial queue converts that into >10 s waits for whoever is behind ~16
  connections.
- **"Process-tree probe did not contain root pid N"
  (`src/daemon/teardown.ts:114`)** — the probe is **right**, and the pid is
  the right pid. Every probed N is that agent's own hostPid from its
  record.json (sam 85925, john 86921, leo 88007, emma 88583, nina 87232,
  anna 87583, omar 88921, lena 87332, noah 87462, david gen 2 99935 — all
  match). The host and its tree were genuinely gone (self-terminated 4 s
  after lease expiry; teardown ran minutes later). This is **not** the
  interactive-zsh pgid leak resurfacing: the probe only asks "is this root
  pid in `ps`", and it was not. The error class is misleading, not the
  measurement: teardown reports "could not be verified" for a tree that was
  *already correctly dead*, which buries the primary failure and records
  agents as `stuck` instead of cleanly failed.
- **Group D ("lost", no failureReason)** — alex, james, priya, zoe, liam,
  sarah passed readiness and were *working* (hook events 20:35:14–28Z:
  session-start, turn-start, tool-start) when their hosts expired underneath
  them at ~20:35:31–37Z. Same bug, observed after the spawn monitor had
  exited.
- **Group E ("worktree is missing; session not resumable")** — recovery-side
  consequence; see Open questions.

### 5. The measured ceiling (harness: `spawn-ceiling.zig`)

Real broker child per tier (`broker.serve` + `ProductionHostLauncher`),
private short HIVE_HOME, daemon-role HELLO authenticated by real
`daemon.lock` + a real HTTP `/handshake` stub, real fork/exec hosts, client
read timeout = the daemon's 10 s. Controls: sequential tiers measure the
per-op service time that the burst tiers then queue on; a 1-spawn tier at
every delay level is the positive control (it always survives — the maya
case).

Broker-only (idle-machine, `/bin/sh` provider, instant /handshake):

| tier | result |
|---|---|
| seq create ×6 | ~15–45 ms per create (service time, no queue) |
| seq HELLO ×6 | ~3–7 ms per connection |
| burst create ×1…32 | strictly linear: last WELCOME at N × ~40 ms (×16 → 630 ms; ×32 → 1313 ms); **zero failures** |
| burst create ×48 | 32 created, **16 × typed `CAPACITY_EXCEEDED`** — the registry holds 32 host slots; the refusal is graceful |
| HELLO storm ×64 | fine (27 ms worst) |
| HELLO storm ×256 | 129 served, **127 × `ConnectionRefused`** — the listen backlog is ~128; excess connects fail fast at connect time, also graceful |
| mix 16 creates + 128 HELLOs | 3 × ConnectionRefused (144 > 128 backlog); everything accepted succeeded |

With the daemon-side `/handshake` fetch delayed by D (emulating the measured
daemon HTTP stall; the broker pays D **per accepted connection** on the
serial loop). Client timeout = the daemon's 10 s, so a "timeout" row is a
recorded `sessiond HELLO request timed out`:

| tier | result |
|---|---|
| create ×1, D=4000 ms | **OK** — WELCOME at 4003 ms, CREATED at 4053 ms. One spawn survives a 4 s stall (the maya case). |
| create ×16, D=250 ms | 16/16 OK (last WELCOME 4.78 s) |
| create ×16, D=1000 ms | **7/16 HELLO timeouts** (last good WELCOME 9.43 s) |
| create ×16, D=2000 ms | **12/16 HELLO timeouts** |
| create ×16, D=4000 ms | **14/16 HELLO timeouts** |
| HELLO ×16, D=2000 ms | 12/16 timeouts — non-create RPCs (renewals, inspects) die identically |

The failure counts track the serial-queue model `k-th connection served at
k × (D + service)` vs the 10 s budget almost exactly: failures begin at
k ≈ 10 s / (D + service) — 10, 5, and 3 for D = 1, 2, 4 s respectively.

(Full CSV: `/tmp/spawn-ceiling-matrix.csv`. Regenerate:
`zig build spawn-ceiling -Doptimize=ReleaseFast`, then the binary takes
`<mode> <creates> <hellos> <delay_ms>`.)

**The ceiling is not a fixed N; it is a budget formula.** The silent-death
collapse begins when `N × (per-create time + per-connection handshake cost)`
exceeds the fixed budgets — 10 s per daemon request, 15 s per new host's
lease. Broker-only on an idle machine that ceiling is ~250 concurrent
creates (40 ms × 250 = 10 s) — far above the other two limits, which fail
*gracefully*: 32 live hosts (typed CAPACITY_EXCEEDED) and ~128 queued
connections (fast ConnectionRefused). The killer is the coupled term: once
the daemon's loop stalls, every broker connection pays that stall for its
`/handshake` fetch, and at the incident's measured D (multi-second HTTP
stall) the ceiling falls to **2–8 concurrent spawns**. The incident admitted
16.

## Answers to the brief's questions

1. **Mechanism** — not fd/socket/process-limit exhaustion, not sqlite, not
   the accept backlog, not a shared temp path. The resource that ran out is
   *time inside two fixed budgets*, spent by a strictly serial broker loop
   whose per-connection cost includes a blocking HTTP fetch to a daemon
   whose own single loop was stalled by the same burst. The hosts then
   executed their designed fail-closed behavior: VISIBILITY_EXPIRED.
2. **Ceiling** — measured, and it is a formula, not a number: failure begins
   at `N × (per-create + per-connection cost) > 10 s` (RPC timeout) or
   `> 15 s` (first lease). Broker-only on this machine: ~40 ms/create
   serialized → ~250 concurrent creates; the graceful limits bind first (32
   host slots → typed CAPACITY_EXCEEDED; ~128-connection listen backlog →
   fast ConnectionRefused). With the daemon loop stalled (measured >5 s HTTP
   stall in the incident), each connection pays that stall and the ceiling
   drops to **2–8 concurrent spawns** (measured: 7/16 fail at D=1 s, 12/16
   at D=2 s, 14/16 at D=4 s; a single spawn survives D=4 s).
3. **"Process-tree probe did not contain root pid N"** — teardown genuinely
   found the pid absent, and the pid was the correct host pid. The probe is
   right; the *interpretation* ("teardown could not be verified" → `stuck`)
   is wrong for an already-dead tree, and it is what turned a clean failure
   into a stuck agent with a misleading reason.
4. **One bug or two** — one. Groups A, B, D are the same queue/lease
   collapse observed at three points of the spawn lifecycle; the probe error
   is the teardown echo of all three. (The gen-2 recovery deaths share the
   mechanism but add a genuinely separate defect: the workspace inventory
   pins the old session generation, so a recovered session is structurally
   unrenewable — worth its own fix.)
5. **Recommended fix** — see below.

## Recommended fix

**Admission control at the daemon's spawn entry, sized to the budgets — not
a bigger timeout.** Concretely: bound in-flight sessiond creates to a small
number (the data says 4 is comfortable, 8 is the edge under load) and queue
the rest *before* any broker connection is opened, with the queue position
visible in the spawn status. Rationale over the alternatives:

- *Scaled handshake timeout*: treats the symptom. The binding constraint is
  the 15 s visibility lease, not the 10 s RPC timeout — stretching the RPC
  timeout lets creates finish while their hosts still expire underneath
  them, converting Group A into Group B. You would have to scale the lease
  too, and the lease is a crash-safety invariant (its whole point is dying
  fast when the workspace is gone; the 2026-07-21 incident is what happens
  when it doesn't fire).
- *Serialised spawn queue in the daemon*: equivalent to admission control
  with N=1 — safe but needlessly slow (16 spawns × ~2–5 s of daemon-side
  work each, fully serial). A small concurrency bound keeps the throughput
  the broker demonstrably absorbs.
- *Parallelise the broker accept loop*: the real end-state, but the backend
  is written single-threaded (one global `CreateTransaction` slot,
  `ProductionBackend.create`, `broker.zig:1809`) and the launch path mutates
  shared registry state; making it concurrent is a redesign, not a fix.

Two supporting changes worth doing regardless of the admission bound:

- **Renew before/while attaching, not after the whole spawn flow.** A new
  host's 15 s `attaching` lease currently gets its first renewal only after
  create + identity + readiness + the next inventory publish. Renewing the
  lease as soon as create() returns (the daemon already holds the evidence)
  removes the long pole that killed all 16 — even a congested queue then has
  a full renewal cadence to work with. This is cheap and directly targets
  the measured death.
- **Make teardown idempotent-success on a positively-absent root.** When the
  probe shows the root pid gone *and* the broker confirms the host exited,
  that is a completed teardown, not an unverifiable one. Today it records
  `stuck` and masks the primary failure (all 16 failureReasons ended in the
  probe error). The pgid-leak concern the code defends against is about
  *survivors*, which the reap readback already checks separately.

## Open questions / not determined

- **What exactly stalled the daemon's Bun loop >5 s** (the 20:35:18Z status
  poll timeout). Candidates: synchronous sqlite across 16 spawn flows, 16
  concurrent `git worktree add`, brief/graph assembly. The daemon has no
  request-latency instrumentation; needs an event-loop-lag probe to
  decompose. The mechanism conclusion does not depend on which one it is.
- **Why gen-2 worktrees were "missing" at recovery** (sarah, alex, james,
  priya). Their gen-1 spawns got far enough to have provider runs and hook
  events, so worktrees existed; something later removed them without the
  recovery path noticing. Not chased — peripheral to the collapse.
- Whether any renewal RPC *attempted* for the 16 before their expiry and
  timed out, versus never attempted because no accepted inventory contained
  them yet. The evidence (no publish processed until 20:35:47Z) favors
  "never attempted", but the daemon's renewal-loop logging is too thin to
  prove it.

## Sources used

- Incident artifacts: `/tmp/hv-a27e3d322a/hive.db` (agents, events,
  provider_runs, terminal_host_bindings, messages),
  `/tmp/hv-a27e3d322a/runtime/sessiond/hosts/*/record.json` + `final.json`
  (16 hosts + 2 retries + maya + queen), `/tmp/hv-a27e3d322a/workspace.log`
  (907 attach refusals, feed stalls, 409s), `logs/daemon.log`.
- Code: `native/sessiond/src/broker.zig` (accept loop 2305-2346,
  serveDaemonConnection 1630-1756, launchHost 1120-, ProductionBackend),
  `host_runtime.zig` (launchOne/finalizeOne), `host_registration.zig`
  (launchFreshChild), `broker_transport.zig` (FrameDeadlineReader),
  `daemon_identity.zig` (verifyDaemonPeer/Hello); `src/daemon/session-host/
  sessiond-host.ts` (connect per op, 10 s timeout), `src/daemon/teardown.ts`
  (captureProcessTree), `src/daemon/spawner-impl.ts` (createSession,
  failSpawn path), `src/daemon/readiness.ts` ("terminal session exited"),
  `src/daemon/server.ts` (renewal loop 1479-1488, 3931-3971),
  `src/schemas/session-protocol.ts:57` (10 s), `native/sessiond/test/
  real-host-golden.zig` (harness model).
- Prior art: `docs/incidents/2026-07-21-fleet-visibility-expiry.md` (same
  enforcement, publish-stall trigger), `docs/daemon/agent-teardown.md`
  (capture-then-kill rationale), `planning/2026-07-25-sessiond-capacity-
  exhaustion.md` (distinct slot-leak issue, not this one),
  `docs/incidents/2026-07-20-workspace-death.md` (false-death reading
  discipline), `docs/daemon/database-resilience.md` (sqlite ruled out as a
  candidate: the daemon DB showed no lock contention; all rows written).
