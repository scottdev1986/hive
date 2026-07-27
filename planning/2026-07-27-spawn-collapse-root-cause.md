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
- david's auto-resume (gen 2, created 20:36:21Z) died the same death at
  its own +15 s (final.json: VISIBILITY_EXPIRED) — during the attach storm
  the system could not save even a single new spawn. The Workspace also
  kept the *old generation* in its inventory: `Hive refused to attach
  david: its session generation changed [session-locator-mismatch]` from
  20:36:17Z on — so the renewal loop, which only renews terminals in the
  accepted workspace inventory, had no path to his gen-2 locator. liam's
  gen 2 (20:38:50Z) fared differently: his lease WAS renewed (final.json
  shows SIGKILL, not VISIBILITY_EXPIRED, and hook events show him working
  at 20:38:52–20:39:00Z) — he then went `lost` a second time with his
  vendor dead and was killed. So recovery renewability is not uniformly
  broken, but the generation-pinned inventory demonstrably blocked it for
  david; see Open questions.
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
   is the teardown echo of all three. (david's gen-2 death shares the
   mechanism and adds a second, real-but-not-universal defect on top: the
   workspace inventory pinned his old session generation, so his recovered
   session had no renewal path. liam's gen-2 was renewed fine.)
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

## Appendix A — the harness, self-contained

Queen's scope ruling: the harness is not committed. Everything needed to
recreate it is here. Steps:

1. Save the source below as `native/sessiond/test/spawn-ceiling.zig`.
2. Apply the `build.zig` edit in Appendix B (`git apply`).
3. Build: `cd native/sessiond && zig build spawn-ceiling -Doptimize=ReleaseFast`
   (the step runs the binary once with no args; ignore the `MissingMode`
   failure — it is the run step, not the build).
4. Run tiers: `BIN=$(ls -t .zig-cache/o/*/sessiond-spawn-ceiling | head -1)` then
   `"$BIN" <mode> <creates> <hellos> <handshake_delay_ms>` per tier. Modes:
   `burst-create`, `hello-storm`, `mix`, `seq-create`, `seq-hello`.
   Exact tier list used for the numbers in this doc, in order:

   ```
   seq-create 6 0 0        seq-hello 0 6 0
   burst-create 1 0 0      burst-create 2 0 0      burst-create 4 0 0
   burst-create 8 0 0      burst-create 12 0 0     burst-create 16 0 0
   burst-create 24 0 0     burst-create 32 0 0     burst-create 48 0 0
   hello-storm 0 64 0      hello-storm 0 256 0
   mix 8 64 0              mix 16 128 0
   burst-create 1 0 4000   burst-create 4 0 1000   burst-create 16 0 250
   burst-create 16 0 1000  burst-create 16 0 2000  burst-create 16 0 4000
   hello-storm 0 16 2000
   ```

The harness boots a REAL broker child (`broker.serve` +
`ProductionHostLauncher`) per tier on a fresh short HIVE_HOME, writes a
`daemon.lock` naming its own process, serves real HTTP `/handshake` (the
`delay_ms` argument sleeps before answering, emulating the daemon's stalled
loop — the broker pays it per accepted connection), and drives N concurrent
daemon-role connections with the daemon's own 10 s read timeout. Client-side
10 s timeouts surface in the CSV as `outcome=timeout` or
`detail=WouldBlock`/`wire-failure-frame` (the readFrame wrapper maps the
SO_RCVTIMEO expiry to a failure frame before the raw probe read reports the
errno).

```zig
//! THROWAWAY PROBE (lucas, 2026-07-27): measures the sessiond broker's spawn
//! concurrency ceiling against the REAL serve loop, real sockets, real fork/exec
//! hosts — the same components the 20:35 sixteen-spawn collapse went through.
//!
//! Not a regression test: it boots a fresh broker per tier on a private short
//! HIVE_HOME, drives N concurrent daemon-role connections (HELLO [+ CREATE]),
//! and prints per-connection latencies as CSV. The client read timeout is the
//! daemon's own 10 s (`control_rpc_timeout_ms`), so a "timeout" row is exactly
//! what the daemon recorded as "sessiond HELLO request timed out".
//!
//! Modes:
//!   seq-create N   — N creates one at a time (baseline service time)
//!   burst-create N — N creates admitted simultaneously
//!   hello-storm N  — N simultaneous HELLO-only connections (per-RPC overhead)
//!   mix C H        — C creates + H HELLO-only connections simultaneously
const std = @import("std");
const broker = @import("broker");
const generated = @import("session_protocol_generated");
const process_inspector = @import("process_inspector");
const protocol = @import("protocol");
const session_host = @import("session_host");

const c = @cImport({
    @cInclude("fcntl.h");
    @cInclude("signal.h");
    @cInclude("stdlib.h");
    @cInclude("sys/socket.h");
    @cInclude("sys/wait.h");
    @cInclude("unistd.h");
});

const instance_id = "instance-a";
const daemon_hello_json =
    \\{"schemaVersion":1,"buildId":"daemon-build","instanceId":"instance-a","protocol":{"major":1,"minMinor":0,"maxMinor":0},"clientRole":"daemon","daemonControl":{"productVersion":"0.0.0-dev","buildHash":"daemon-build","wireProtocol":{"min":1,"max":1},"schemaEpoch":1,"instanceId":"instance-a","hiveUuid":"hive-a","identityKey":"project-a","repoFamilyKey":"family-a"}}
;
const daemon_handshake_json =
    \\{"productVersion":"0.0.0-dev","buildHash":"daemon-build","wireProtocol":{"min":1,"max":1},"schemaEpoch":1,"capabilities":["daemon-handshake-v1"],"instanceId":"instance-a","hiveUuid":"hive-a","identityKey":"project-a","repoFamilyKey":"family-a","generation":1}
;
const create_commit_json =
    \\{"schemaVersion":1,"totalLength":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}
;

const EmptyEnvironment = struct {};

const Outcome = enum { ok, timeout, wire_error, failure };

const Result = struct {
    index: usize = 0,
    is_create: bool = false,
    connect_ms: f64 = -1,
    welcome_ms: f64 = -1,
    op_ms: f64 = -1,
    outcome: Outcome = .failure,
    detail: [48]u8 = @splat(0),
    host_pid: i32 = 0,
    shell_pid: i32 = 0,
};

const HandshakeServer = struct {
    listener: std.net.Server,
    // Emulates the daemon's stalled HTTP surface: the broker fetches
    // GET /handshake on EVERY accepted connection, so this delay lands on
    // the serialized accept loop per connection.
    delay_ms: u64,

    fn run(self: *HandshakeServer) void {
        while (true) {
            var connection = self.listener.accept() catch return;
            defer connection.stream.close();
            var request_storage: [1024]u8 = undefined;
            _ = connection.stream.read(&request_storage) catch continue;
            if (self.delay_ms > 0) std.Thread.sleep(self.delay_ms * std.time.ns_per_ms);
            const response = std.fmt.allocPrint(
                std.heap.page_allocator,
                "HTTP/1.1 200 OK\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n{s}",
                .{ daemon_handshake_json.len, daemon_handshake_json },
            ) catch continue;
            defer std.heap.page_allocator.free(response);
            connection.stream.writeAll(response) catch continue;
        }
    }
};

fn nowMs(timer: *std.time.Timer) f64 {
    return @as(f64, @floatFromInt(timer.read())) / @as(f64, std.time.ns_per_ms);
}

fn setClientTimeout(fd: std.posix.fd_t) void {
    const millis = generated.limits.control_rpc_timeout_ms;
    const timeout: c.struct_timeval = .{
        .tv_sec = @intCast(millis / std.time.ms_per_s),
        .tv_usec = @intCast((millis % std.time.ms_per_s) * std.time.us_per_ms),
    };
    _ = c.setsockopt(fd, c.SOL_SOCKET, c.SO_RCVTIMEO, &timeout, @sizeOf(c.struct_timeval));
}

fn writeFrame(stream: std.net.Stream, type_code: u16, request_id: u64, payload: []const u8) !void {
    try protocol.writeFrame(stream, .{
        .minor = generated.protocol_minor,
        .type_code = type_code,
        .flags = 0,
        .payload_length = @intCast(payload.len),
        .request_id = request_id,
        .stream_seq = 0,
    }, payload);
}

const ReadOutcome = union(enum) {
    frame: protocol.Frame,
    timeout,
    failed: []const u8,
};

fn readResponseFrame(allocator: std.mem.Allocator, stream: std.net.Stream) ReadOutcome {
    const file: std.fs.File = .{ .handle = stream.handle };
    const result = protocol.readFrame(allocator, file.deprecatedReader()) catch |err| {
        if (err == error.WouldBlock or err == error.Timeout) return .timeout;
        return .{ .failed = @errorName(err) };
    };
    return switch (result) {
        .frame => |frame| .{ .frame = frame },
        .failure => blk: {
            // Diagnose the bare close: is there anything readable at all?
            var probe: [1]u8 = undefined;
            const n = std.posix.read(stream.handle, &probe) catch |err|
                break :blk .{ .failed = @errorName(err) };
            if (n == 0) break :blk .{ .failed = "eof" };
            break :blk .{ .failed = "wire-failure-frame" };
        },
        .ignored_optional => .{ .failed = "ignored-optional" },
    };
}

fn noteDetail(result: *Result, text: []const u8) void {
    const count = @min(text.len, result.detail.len);
    @memcpy(result.detail[0..count], text[0..count]);
}

const ClientJob = struct {
    sock_path: []const u8,
    spec_json: []const u8, // empty for HELLO-only
    gate: *std.atomic.Value(u32),
    timer: *std.time.Timer,
    result: *Result,
};

fn runClient(job: *const ClientJob) void {
    const allocator = std.heap.page_allocator;
    var result = job.result;
    while (job.gate.load(.acquire) == 0) std.Thread.yield() catch {};

    const stream = std.net.connectUnixSocket(job.sock_path) catch |err| {
        noteDetail(result, @errorName(err));
        return;
    };
    defer stream.close();
    result.connect_ms = nowMs(job.timer);
    setClientTimeout(stream.handle);

    writeFrame(stream, generated.frame_type.hello, 1, daemon_hello_json) catch |err| {
        noteDetail(result, @errorName(err));
        return;
    };
    switch (readResponseFrame(allocator, stream)) {
        .timeout => {
            result.welcome_ms = generated.limits.control_rpc_timeout_ms;
            result.outcome = .timeout;
            noteDetail(result, "HELLO timeout");
            return;
        },
        .failed => |why| {
            noteDetail(result, why);
            return;
        },
        .frame => |frame| {
            var owned = frame;
            defer owned.deinit(allocator);
            result.welcome_ms = nowMs(job.timer);
            if (owned.header.type_code == generated.frame_type.@"error") {
                result.outcome = .wire_error;
                noteDetail(result, owned.payload);
                return;
            }
            if (owned.header.type_code != generated.frame_type.welcome) {
                noteDetail(result, "unexpected frame after HELLO");
                return;
            }
        },
    }

    if (job.spec_json.len == 0) {
        // HELLO-only probe: the WELCOME round trip IS the operation.
        result.op_ms = result.welcome_ms;
        result.outcome = .ok;
        return;
    }

    writeFrame(stream, generated.frame_type.create_begin, 2, job.spec_json) catch |err| {
        noteDetail(result, @errorName(err));
        return;
    };
    writeFrame(stream, generated.frame_type.create_commit, 3, create_commit_json) catch |err| {
        noteDetail(result, @errorName(err));
        return;
    };
    switch (readResponseFrame(allocator, stream)) {
        .timeout => {
            result.op_ms = generated.limits.control_rpc_timeout_ms;
            result.outcome = .timeout;
            noteDetail(result, "CREATE_COMMIT timeout");
            return;
        },
        .failed => |why| {
            noteDetail(result, why);
            return;
        },
        .frame => |frame| {
            var owned = frame;
            defer owned.deinit(allocator);
            result.op_ms = nowMs(job.timer);
            if (owned.header.type_code == generated.frame_type.@"error") {
                result.outcome = .wire_error;
                noteDetail(result, owned.payload);
                return;
            }
            if (owned.header.type_code != generated.frame_type.created) {
                noteDetail(result, "unexpected frame after CREATE_COMMIT");
                return;
            }
            const Projection = struct {
                inspection: struct {
                    hostPid: i32,
                    shellRoot: struct { pid: i32 },
                },
            };
            var parsed = std.json.parseFromSlice(Projection, allocator, owned.payload, .{
                .ignore_unknown_fields = true,
            }) catch {
                noteDetail(result, "created payload unparsable");
                return;
            };
            defer parsed.deinit();
            result.host_pid = parsed.value.inspection.hostPid;
            result.shell_pid = parsed.value.inspection.shellRoot.pid;
            result.outcome = .ok;
        },
    }
}

fn buildSpec(allocator: std.mem.Allocator, root: []const u8, engine_build_id: []const u8, index: usize, workspace_token: []const u8) ![]u8 {
    var session_storage: [41]u8 = undefined;
    const session = try std.fmt.bufPrint(&session_storage, "ses_00000000-7000-7000-8000-{d:0>12}", .{index});
    var agent_storage: [16]u8 = undefined;
    const agent = try std.fmt.bufPrint(&agent_storage, "probe{d:0>4}", .{index});
    return std.json.Stringify.valueAlloc(allocator, .{
        .schemaVersion = @as(u8, 1),
        .locator = .{
            .schemaVersion = @as(u8, 1),
            .instanceId = instance_id,
            .subject = .{ .kind = "agent", .agentId = agent },
            .generation = @as(u64, 1),
            .sessionId = session,
            .hostKind = "sessiond",
            .engineBuildId = engine_build_id,
        },
        .provider = "codex",
        .toolSessionId = @as(?[]const u8, null),
        .cwd = root,
        .argv = [_][]const u8{ "/bin/sh", "-c", "sleep 30" },
        .environment = EmptyEnvironment{},
        .expectedExecutable = "/bin/sh",
        .readOnly = false,
        .capabilityEpoch = @as(u64, 0),
        .geometry = .{
            .columns = @as(u16, 80),
            .rows = @as(u16, 24),
            .widthPx = @as(u32, 800),
            .heightPx = @as(u32, 480),
            .cellWidthPx = @as(f64, 10),
            .cellHeightPx = @as(f64, 20),
        },
        .launchGrantId = "probe-launch-grant",
        .launchGrantRevision = @as(u64, 1),
        .visibility = .{
            .workspaceSessionId = "probe-workspace",
            .workspacePid = c.getpid(),
            .workspaceStartToken = workspace_token,
            .openTerminalRevision = "1",
        },
    }, .{});
}

/// Boots one real broker child on a fresh short home. Returns the child pid;
/// `sock_storage` receives broker.sock's path.
fn bootBroker(allocator: std.mem.Allocator, root: []const u8, sock_storage: []u8, delay_ms: u64) !struct { pid: i32, sock: []const u8 } {
    try std.fs.makeDirAbsolute(root);
    var home = try std.fs.openDirAbsolute(root, .{ .no_follow = true });
    try home.chmod(0o700);
    home.close();
    const root_z = try allocator.dupeZ(u8, root);
    defer allocator.free(root_z);
    if (c.setenv("HIVE_HOME", root_z.ptr, 1) != 0) return error.SetEnvironmentFailed;

    // daemon.lock must describe THIS process: the broker authenticates every
    // connection's kernel peer (pid + start token + executable) against it.
    const observed = process_inspector.observeProcessPresent(c.getpid()) orelse
        return error.OwnIdentityUnavailable;
    var token_storage: [64]u8 = undefined;
    const token = try observed.start_token.format(&token_storage);
    var exe_storage: [std.fs.max_path_bytes]u8 = undefined;
    const exe = try std.fs.selfExePath(&exe_storage);
    const lock_json = try std.fmt.allocPrint(allocator,
        \\{{"pid":{d},"instanceId":"{s}","startedAt":"2026-07-27T00:00:00Z","startToken":"{s}","executablePath":"{s}"}}
    , .{ c.getpid(), instance_id, token, exe });
    defer allocator.free(lock_json);
    var home_dir = try std.fs.openDirAbsolute(root, .{ .no_follow = true });
    defer home_dir.close();
    try home_dir.writeFile(.{ .sub_path = "daemon.lock", .data = lock_json });

    const address = try std.net.Address.parseIp("127.0.0.1", 0);
    // Heap, never stack: the detached thread outlives this stack frame, and a
    // frame-local server gets silently overwritten by later calls (measured:
    // a few spec builds reused the frame and the accept loop read garbage).
    const handshake_server = try allocator.create(HandshakeServer);
    handshake_server.* = .{ .listener = try address.listen(.{}), .delay_ms = delay_ms };
    const port = handshake_server.listener.listen_address.in.getPort();
    const port_text = try std.fmt.allocPrint(allocator, "{d}", .{port});
    defer allocator.free(port_text);
    try home_dir.writeFile(.{ .sub_path = "daemon.port", .data = port_text });
    const handshake_thread = try std.Thread.spawn(.{}, HandshakeServer.run, .{handshake_server});
    handshake_thread.detach();

    const child_pid = try std.posix.fork();
    if (child_pid == 0) {
        var launcher = session_host.ProductionHostLauncher.init(allocator, root) catch
            c._exit(90);
        broker.serve(allocator, root, launcher.launcher()) catch |err| {
            std.debug.print("broker child failed: {s}\n", .{@errorName(err)});
            c._exit(91);
        };
        c._exit(0);
    }

    const sock = try std.fmt.bufPrint(sock_storage, "{s}/runtime/sessiond/broker.sock", .{root});
    var waited_ms: usize = 0;
    while (waited_ms < 10_000) : (waited_ms += 5) {
        std.fs.accessAbsolute(sock, .{}) catch {
            std.Thread.sleep(5 * std.time.ns_per_ms);
            continue;
        };
        break;
    }
    if (waited_ms >= 10_000) return error.BrokerSocketNeverAppeared;
    return .{ .pid = child_pid, .sock = sock };
}

fn reapTier(broker_pid: i32, results: []const Result) void {
    _ = c.kill(broker_pid, c.SIGKILL);
    var status: c_int = 0;
    _ = c.waitpid(broker_pid, &status, 0);
    for (results) |result| {
        if (result.host_pid > 0) _ = c.kill(result.host_pid, c.SIGKILL);
        if (result.shell_pid > 0) _ = c.kill(result.shell_pid, c.SIGKILL);
    }
}

fn runTier(
    allocator: std.mem.Allocator,
    mode: []const u8,
    create_count: usize,
    hello_count: usize,
    engine_build_id: []const u8,
    workspace_token: []const u8,
    delay_ms: u64,
) !void {
    var root_storage: [64]u8 = undefined;
    const root = try std.fmt.bufPrint(&root_storage, "/tmp/c{x}", .{std.crypto.random.int(u32)});
    defer std.fs.deleteTreeAbsolute(root) catch {};

    var sock_storage: [256]u8 = undefined;
    const booted = try bootBroker(allocator, root, &sock_storage, delay_ms);
    const total = create_count + hello_count;
    const results = try allocator.alloc(Result, total);
    defer allocator.free(results);
    for (results, 0..) |*result, i| result.* = .{ .index = i, .is_create = i < create_count };
    defer reapTier(booted.pid, results);

    // Diagnostic seam: emulate the delay spec-building introduces between
    // broker boot and the first client connection.
    if (std.posix.getenv("CEILING_PRE_SLEEP_MS")) |text| {
        const ms = std.fmt.parseInt(u64, text, 10) catch 0;
        if (ms > 0) std.Thread.sleep(ms * std.time.ns_per_ms);
    }
    var timer = try std.time.Timer.start();
    var gate: std.atomic.Value(u32) = .init(0);
    const threads = try allocator.alloc(std.Thread, total);
    defer allocator.free(threads);
    const jobs = try allocator.alloc(ClientJob, total);
    defer allocator.free(jobs);
    const specs = try allocator.alloc(?[]u8, total);
    defer {
        for (specs) |maybe_spec| {
            if (maybe_spec) |spec| allocator.free(spec);
        }
        allocator.free(specs);
    }
    for (jobs, 0..) |*job, i| {
        specs[i] = if (i < create_count and std.posix.getenv("CEILING_SKIP_SPEC") == null)
            try buildSpec(allocator, root, engine_build_id, i, workspace_token)
        else
            null;
        job.* = .{
            .sock_path = booted.sock,
            .spec_json = specs[i] orelse "",
            .gate = &gate,
            .timer = &timer,
            .result = &results[i],
        };
    }

    if (std.mem.startsWith(u8, mode, "seq")) {
        // Baseline: one connection in flight at a time, no gate release race.
        for (jobs) |*job| {
            gate.store(0, .release);
            const thread = try std.Thread.spawn(.{}, runClient, .{job});
            gate.store(1, .release);
            thread.join();
        }
    } else {
        for (jobs, 0..) |*job, i| threads[i] = try std.Thread.spawn(.{}, runClient, .{job});
        gate.store(1, .release);
        for (threads) |thread| thread.join();
    }

    for (results) |result| {
        std.debug.print(
            "{s},creates={d},hellos={d},delay_ms={d},i={d},create={d},connect_ms={d:.1},welcome_ms={d:.1},op_ms={d:.1},outcome={s},host_pid={d},detail={s}\n",
            .{
                mode,
                create_count,
                hello_count,
                delay_ms,
                result.index,
                @intFromBool(result.is_create),
                result.connect_ms,
                result.welcome_ms,
                result.op_ms,
                @tagName(result.outcome),
                result.host_pid,
                std.mem.sliceTo(&result.detail, 0),
            },
        );
    }
}

pub fn main() !void {
    var debug_allocator: std.heap.DebugAllocator(.{}) = .init;
    defer _ = debug_allocator.deinit();
    const allocator = debug_allocator.allocator();

    var args = std.process.args();
    _ = args.next();
    const first = args.next() orelse return error.MissingMode;
    if (std.mem.eql(u8, first, "host")) {
        if (args.next() != null) return error.UnexpectedArgument;
        const hive_home = try std.process.getEnvVarOwned(allocator, "HIVE_HOME");
        defer allocator.free(hive_home);
        return session_host.runHostRole(allocator, hive_home);
    }

    // CLI: sessiond-spawn-ceiling <mode> <creates> <hellos> <delay_ms>
    // mode: burst-create | hello-storm | mix | seq-create | seq-hello
    const mode = first;
    const creates = try std.fmt.parseInt(usize, args.next() orelse "0", 10);
    const hellos = try std.fmt.parseInt(usize, args.next() orelse "0", 10);
    const delay_ms = try std.fmt.parseInt(u64, args.next() orelse "0", 10);
    if (args.next() != null) return error.UnexpectedArgument;

    const engine_digest = try session_host.RealVtEngine.engineBuildId();
    const engine_build_id = std.fmt.bytesToHex(engine_digest, .lower);
    const observed = process_inspector.observeProcessPresent(c.getpid()) orelse
        return error.OwnIdentityUnavailable;
    var token_storage: [64]u8 = undefined;
    const workspace_token = try observed.start_token.format(&token_storage);

    std.debug.print("mode,creates,hellos,delay_ms,i,is_create,connect_ms,welcome_ms,op_ms,outcome,host_pid,detail\n", .{});
    try runTier(allocator, mode, creates, hellos, &engine_build_id, workspace_token, delay_ms);
}
```

## Appendix B — the build.zig edit the harness needs

```diff
diff --git a/native/sessiond/build.zig b/native/sessiond/build.zig
index d498b8da..5915eea5 100644
--- a/native/sessiond/build.zig
+++ b/native/sessiond/build.zig
@@ -500,6 +500,27 @@ pub fn build(b: *std.Build) void {
     const run_real_host_golden = b.addRunArtifact(real_host_golden);
     test_step.dependOn(&run_real_host_golden.step);
 
+    // THROWAWAY PROBE (lucas): spawn-concurrency ceiling measurement. Not wired
+    // into test_step; build/run explicitly with -Doptimize=ReleaseFast.
+    const spawn_ceiling_module = b.createModule(.{
+        .root_source_file = b.path("test/spawn-ceiling.zig"),
+        .target = target,
+        .optimize = optimize,
+        .link_libc = true,
+    });
+    spawn_ceiling_module.addImport("broker", broker_module);
+    spawn_ceiling_module.addImport("session_protocol_generated", generated);
+    spawn_ceiling_module.addImport("process_inspector", process_inspector_module);
+    spawn_ceiling_module.addImport("protocol", test_module);
+    spawn_ceiling_module.addImport("session_host", session_host_module);
+    const spawn_ceiling = b.addExecutable(.{
+        .name = "sessiond-spawn-ceiling",
+        .root_module = spawn_ceiling_module,
+    });
+    spawn_ceiling.linkLibrary(ghostty_vt);
+    const spawn_ceiling_step = b.step("spawn-ceiling", "Run the spawn concurrency ceiling probe");
+    spawn_ceiling_step.dependOn(&b.addRunArtifact(spawn_ceiling).step);
+
     const stub_module = b.createModule(.{
         .root_source_file = b.path("test/stub_host.zig"),
         .target = target,
```

## Appendix C — raw measurement output (all tiers, verbatim)

Client-side 10 s timeout accounting: `outcome=timeout`, `detail=WouldBlock`,
and `detail=wire-failure-frame` are all the daemon-equivalent HELLO/CREATE
timeout; `detail=ConnectionRefused` is the listen-backlog overflow;
`CAPACITY_EXCEEDED` is the 32-slot registry gate. One row per connection.

```
seq-create,creates=6,hellos=0,delay_ms=0,i=0,create=1,connect_ms=0.1,welcome_ms=4.6,op_ms=55.4,outcome=ok,host_pid=37766,detail=
seq-create,creates=6,hellos=0,delay_ms=0,i=1,create=1,connect_ms=55.5,welcome_ms=56.0,op_ms=96.6,outcome=ok,host_pid=37775,detail=
seq-create,creates=6,hellos=0,delay_ms=0,i=2,create=1,connect_ms=96.7,welcome_ms=97.5,op_ms=136.7,outcome=ok,host_pid=37778,detail=
seq-create,creates=6,hellos=0,delay_ms=0,i=3,create=1,connect_ms=136.8,welcome_ms=137.7,op_ms=181.0,outcome=ok,host_pid=37780,detail=
seq-create,creates=6,hellos=0,delay_ms=0,i=4,create=1,connect_ms=181.1,welcome_ms=182.1,op_ms=223.4,outcome=ok,host_pid=37782,detail=
seq-create,creates=6,hellos=0,delay_ms=0,i=5,create=1,connect_ms=223.5,welcome_ms=224.3,op_ms=265.4,outcome=ok,host_pid=37793,detail=
seq-hello,creates=0,hellos=6,delay_ms=0,i=0,create=0,connect_ms=0.0,welcome_ms=2.4,op_ms=2.4,outcome=ok,host_pid=0,detail=
seq-hello,creates=0,hellos=6,delay_ms=0,i=1,create=0,connect_ms=2.5,welcome_ms=3.4,op_ms=3.4,outcome=ok,host_pid=0,detail=
seq-hello,creates=0,hellos=6,delay_ms=0,i=2,create=0,connect_ms=3.4,welcome_ms=4.2,op_ms=4.2,outcome=ok,host_pid=0,detail=
seq-hello,creates=0,hellos=6,delay_ms=0,i=3,create=0,connect_ms=4.2,welcome_ms=5.0,op_ms=5.0,outcome=ok,host_pid=0,detail=
seq-hello,creates=0,hellos=6,delay_ms=0,i=4,create=0,connect_ms=5.0,welcome_ms=5.7,op_ms=5.7,outcome=ok,host_pid=0,detail=
seq-hello,creates=0,hellos=6,delay_ms=0,i=5,create=0,connect_ms=5.8,welcome_ms=6.5,op_ms=6.5,outcome=ok,host_pid=0,detail=
burst-create,creates=1,hellos=0,delay_ms=0,i=0,create=1,connect_ms=0.1,welcome_ms=2.3,op_ms=41.0,outcome=ok,host_pid=37801,detail=
burst-create,creates=2,hellos=0,delay_ms=0,i=0,create=1,connect_ms=0.1,welcome_ms=41.1,op_ms=79.4,outcome=ok,host_pid=37808,detail=
burst-create,creates=2,hellos=0,delay_ms=0,i=1,create=1,connect_ms=0.1,welcome_ms=2.4,op_ms=40.5,outcome=ok,host_pid=37806,detail=
burst-create,creates=4,hellos=0,delay_ms=0,i=0,create=1,connect_ms=0.1,welcome_ms=81.3,op_ms=120.6,outcome=ok,host_pid=37825,detail=
burst-create,creates=4,hellos=0,delay_ms=0,i=1,create=1,connect_ms=0.1,welcome_ms=2.1,op_ms=40.1,outcome=ok,host_pid=37813,detail=
burst-create,creates=4,hellos=0,delay_ms=0,i=2,create=1,connect_ms=0.1,welcome_ms=40.8,op_ms=80.4,outcome=ok,host_pid=37815,detail=
burst-create,creates=4,hellos=0,delay_ms=0,i=3,create=1,connect_ms=0.1,welcome_ms=121.2,op_ms=161.2,outcome=ok,host_pid=37827,detail=
burst-create,creates=8,hellos=0,delay_ms=0,i=0,create=1,connect_ms=0.2,welcome_ms=204.2,op_ms=244.0,outcome=ok,host_pid=37850,detail=
burst-create,creates=8,hellos=0,delay_ms=0,i=1,create=1,connect_ms=0.3,welcome_ms=284.6,op_ms=324.8,outcome=ok,host_pid=37854,detail=
burst-create,creates=8,hellos=0,delay_ms=0,i=2,create=1,connect_ms=0.2,welcome_ms=122.8,op_ms=162.7,outcome=ok,host_pid=37846,detail=
burst-create,creates=8,hellos=0,delay_ms=0,i=3,create=1,connect_ms=0.2,welcome_ms=163.7,op_ms=203.4,outcome=ok,host_pid=37848,detail=
burst-create,creates=8,hellos=0,delay_ms=0,i=4,create=1,connect_ms=0.2,welcome_ms=244.9,op_ms=283.7,outcome=ok,host_pid=37852,detail=
burst-create,creates=8,hellos=0,delay_ms=0,i=5,create=1,connect_ms=0.2,welcome_ms=41.4,op_ms=81.6,outcome=ok,host_pid=37835,detail=
burst-create,creates=8,hellos=0,delay_ms=0,i=6,create=1,connect_ms=0.2,welcome_ms=2.4,op_ms=40.5,outcome=ok,host_pid=37832,detail=
burst-create,creates=8,hellos=0,delay_ms=0,i=7,create=1,connect_ms=0.2,welcome_ms=82.6,op_ms=121.9,outcome=ok,host_pid=37844,detail=
burst-create,creates=12,hellos=0,delay_ms=0,i=0,create=1,connect_ms=0.3,welcome_ms=330.7,op_ms=372.9,outcome=ok,host_pid=37908,detail=
burst-create,creates=12,hellos=0,delay_ms=0,i=1,create=1,connect_ms=0.3,welcome_ms=373.9,op_ms=414.6,outcome=ok,host_pid=37919,detail=
burst-create,creates=12,hellos=0,delay_ms=0,i=2,create=1,connect_ms=0.3,welcome_ms=415.4,op_ms=456.7,outcome=ok,host_pid=37932,detail=
burst-create,creates=12,hellos=0,delay_ms=0,i=3,create=1,connect_ms=0.2,welcome_ms=124.0,op_ms=163.3,outcome=ok,host_pid=37888,detail=
burst-create,creates=12,hellos=0,delay_ms=0,i=4,create=1,connect_ms=0.2,welcome_ms=2.5,op_ms=41.9,outcome=ok,host_pid=37862,detail=
burst-create,creates=12,hellos=0,delay_ms=0,i=5,create=1,connect_ms=0.3,welcome_ms=206.3,op_ms=246.9,outcome=ok,host_pid=37902,detail=
burst-create,creates=12,hellos=0,delay_ms=0,i=6,create=1,connect_ms=0.3,welcome_ms=289.8,op_ms=329.7,outcome=ok,host_pid=37906,detail=
burst-create,creates=12,hellos=0,delay_ms=0,i=7,create=1,connect_ms=0.2,welcome_ms=82.9,op_ms=123.1,outcome=ok,host_pid=37879,detail=
burst-create,creates=12,hellos=0,delay_ms=0,i=8,create=1,connect_ms=0.3,welcome_ms=458.1,op_ms=499.4,outcome=ok,host_pid=37942,detail=
burst-create,creates=12,hellos=0,delay_ms=0,i=9,create=1,connect_ms=0.2,welcome_ms=42.8,op_ms=82.0,outcome=ok,host_pid=37873,detail=
burst-create,creates=12,hellos=0,delay_ms=0,i=10,create=1,connect_ms=0.3,welcome_ms=247.9,op_ms=288.8,outcome=ok,host_pid=37904,detail=
burst-create,creates=12,hellos=0,delay_ms=0,i=11,create=1,connect_ms=0.2,welcome_ms=164.2,op_ms=205.4,outcome=ok,host_pid=37891,detail=
burst-create,creates=16,hellos=0,delay_ms=0,i=0,create=1,connect_ms=0.2,welcome_ms=169.7,op_ms=211.6,outcome=ok,host_pid=37995,detail=
burst-create,creates=16,hellos=0,delay_ms=0,i=1,create=1,connect_ms=0.3,welcome_ms=378.5,op_ms=420.0,outcome=ok,host_pid=38024,detail=
burst-create,creates=16,hellos=0,delay_ms=0,i=2,create=1,connect_ms=0.3,welcome_ms=421.1,op_ms=462.1,outcome=ok,host_pid=38026,detail=
burst-create,creates=16,hellos=0,delay_ms=0,i=3,create=1,connect_ms=0.3,welcome_ms=546.2,op_ms=587.4,outcome=ok,host_pid=38032,detail=
burst-create,creates=16,hellos=0,delay_ms=0,i=4,create=1,connect_ms=0.3,welcome_ms=630.4,op_ms=672.2,outcome=ok,host_pid=38036,detail=
burst-create,creates=16,hellos=0,delay_ms=0,i=5,create=1,connect_ms=0.2,welcome_ms=336.0,op_ms=377.3,outcome=ok,host_pid=38014,detail=
burst-create,creates=16,hellos=0,delay_ms=0,i=6,create=1,connect_ms=0.2,welcome_ms=127.3,op_ms=168.7,outcome=ok,host_pid=37986,detail=
burst-create,creates=16,hellos=0,delay_ms=0,i=7,create=1,connect_ms=0.2,welcome_ms=2.5,op_ms=42.4,outcome=ok,host_pid=37959,detail=
burst-create,creates=16,hellos=0,delay_ms=0,i=8,create=1,connect_ms=0.3,welcome_ms=588.3,op_ms=629.6,outcome=ok,host_pid=38034,detail=
burst-create,creates=16,hellos=0,delay_ms=0,i=9,create=1,connect_ms=0.2,welcome_ms=294.7,op_ms=335.0,outcome=ok,host_pid=38012,detail=
burst-create,creates=16,hellos=0,delay_ms=0,i=10,create=1,connect_ms=0.2,welcome_ms=254.0,op_ms=293.8,outcome=ok,host_pid=38010,detail=
burst-create,creates=16,hellos=0,delay_ms=0,i=11,create=1,connect_ms=0.2,welcome_ms=43.8,op_ms=84.0,outcome=ok,host_pid=37969,detail=
burst-create,creates=16,hellos=0,delay_ms=0,i=12,create=1,connect_ms=0.3,welcome_ms=463.3,op_ms=504.2,outcome=ok,host_pid=38028,detail=
burst-create,creates=16,hellos=0,delay_ms=0,i=13,create=1,connect_ms=0.2,welcome_ms=212.5,op_ms=253.1,outcome=ok,host_pid=38007,detail=
burst-create,creates=16,hellos=0,delay_ms=0,i=14,create=1,connect_ms=0.3,welcome_ms=505.1,op_ms=545.3,outcome=ok,host_pid=38030,detail=
burst-create,creates=16,hellos=0,delay_ms=0,i=15,create=1,connect_ms=0.2,welcome_ms=84.9,op_ms=126.1,outcome=ok,host_pid=37979,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=0,create=1,connect_ms=0.4,welcome_ms=365.0,op_ms=405.1,outcome=ok,host_pid=38075,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=1,create=1,connect_ms=0.3,welcome_ms=2.9,op_ms=41.3,outcome=ok,host_pid=38049,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=2,create=1,connect_ms=0.4,welcome_ms=915.4,op_ms=957.2,outcome=ok,host_pid=38149,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=3,create=1,connect_ms=0.4,welcome_ms=492.0,op_ms=534.0,outcome=ok,host_pid=38089,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=4,create=1,connect_ms=0.4,welcome_ms=664.8,op_ms=706.7,outcome=ok,host_pid=38126,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=5,create=1,connect_ms=0.4,welcome_ms=324.0,op_ms=364.1,outcome=ok,host_pid=38073,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=6,create=1,connect_ms=0.4,welcome_ms=81.4,op_ms=120.7,outcome=ok,host_pid=38053,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=7,create=1,connect_ms=0.4,welcome_ms=121.6,op_ms=161.5,outcome=ok,host_pid=38059,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=8,create=1,connect_ms=0.4,welcome_ms=449.2,op_ms=491.2,outcome=ok,host_pid=38087,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=9,create=1,connect_ms=0.4,welcome_ms=203.2,op_ms=241.5,outcome=ok,host_pid=38067,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=10,create=1,connect_ms=0.4,welcome_ms=791.6,op_ms=831.3,outcome=ok,host_pid=38143,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=11,create=1,connect_ms=0.4,welcome_ms=831.9,op_ms=872.8,outcome=ok,host_pid=38145,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=12,create=1,connect_ms=0.4,welcome_ms=535.0,op_ms=576.9,outcome=ok,host_pid=38091,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=13,create=1,connect_ms=0.4,welcome_ms=42.2,op_ms=80.5,outcome=ok,host_pid=38051,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=14,create=1,connect_ms=0.4,welcome_ms=750.7,op_ms=791.0,outcome=ok,host_pid=38141,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=15,create=1,connect_ms=0.4,welcome_ms=577.9,op_ms=619.7,outcome=ok,host_pid=38101,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=16,create=1,connect_ms=0.4,welcome_ms=282.9,op_ms=323.1,outcome=ok,host_pid=38071,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=17,create=1,connect_ms=0.4,welcome_ms=620.3,op_ms=663.8,outcome=ok,host_pid=38113,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=18,create=1,connect_ms=0.4,welcome_ms=162.4,op_ms=202.2,outcome=ok,host_pid=38065,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=19,create=1,connect_ms=0.4,welcome_ms=242.2,op_ms=282.2,outcome=ok,host_pid=38069,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=20,create=1,connect_ms=0.4,welcome_ms=707.6,op_ms=749.9,outcome=ok,host_pid=38137,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=21,create=1,connect_ms=0.4,welcome_ms=958.0,op_ms=1002.5,outcome=ok,host_pid=38157,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=22,create=1,connect_ms=0.4,welcome_ms=873.8,op_ms=914.7,outcome=ok,host_pid=38147,detail=
burst-create,creates=24,hellos=0,delay_ms=0,i=23,create=1,connect_ms=0.4,welcome_ms=406.0,op_ms=448.2,outcome=ok,host_pid=38078,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=0,create=1,connect_ms=0.4,welcome_ms=286.0,op_ms=326.2,outcome=ok,host_pid=38186,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=1,create=1,connect_ms=0.4,welcome_ms=368.5,op_ms=409.2,outcome=ok,host_pid=38190,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=2,create=1,connect_ms=0.4,welcome_ms=42.0,op_ms=80.7,outcome=ok,host_pid=38166,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=3,create=1,connect_ms=0.5,welcome_ms=1141.2,op_ms=1182.7,outcome=ok,host_pid=38312,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=4,create=1,connect_ms=0.5,welcome_ms=1269.7,op_ms=1312.3,outcome=ok,host_pid=38326,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=5,create=1,connect_ms=0.4,welcome_ms=204.8,op_ms=244.1,outcome=ok,host_pid=38182,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=6,create=1,connect_ms=0.4,welcome_ms=746.3,op_ms=788.8,outcome=ok,host_pid=38244,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=7,create=1,connect_ms=0.4,welcome_ms=244.9,op_ms=285.2,outcome=ok,host_pid=38184,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=8,create=1,connect_ms=0.4,welcome_ms=619.4,op_ms=661.2,outcome=ok,host_pid=38233,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=9,create=1,connect_ms=0.4,welcome_ms=452.9,op_ms=493.2,outcome=ok,host_pid=38202,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=10,create=1,connect_ms=0.4,welcome_ms=164.4,op_ms=204.1,outcome=ok,host_pid=38180,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=11,create=1,connect_ms=0.4,welcome_ms=410.0,op_ms=451.9,outcome=ok,host_pid=38196,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=12,create=1,connect_ms=0.4,welcome_ms=834.4,op_ms=877.5,outcome=ok,host_pid=38264,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=13,create=1,connect_ms=0.5,welcome_ms=969.0,op_ms=1012.1,outcome=ok,host_pid=38288,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=14,create=1,connect_ms=0.5,welcome_ms=878.1,op_ms=921.3,outcome=ok,host_pid=38275,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=15,create=1,connect_ms=0.5,welcome_ms=1227.1,op_ms=1269.0,outcome=ok,host_pid=38324,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=16,create=1,connect_ms=0.4,welcome_ms=662.0,op_ms=702.9,outcome=ok,host_pid=38235,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=17,create=1,connect_ms=0.5,welcome_ms=1013.2,op_ms=1055.9,outcome=ok,host_pid=38298,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=18,create=1,connect_ms=0.4,welcome_ms=536.0,op_ms=577.6,outcome=ok,host_pid=38216,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=19,create=1,connect_ms=0.4,welcome_ms=122.2,op_ms=163.4,outcome=ok,host_pid=38175,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=20,create=1,connect_ms=0.5,welcome_ms=1056.5,op_ms=1098.6,outcome=ok,host_pid=38308,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=21,create=1,connect_ms=0.4,welcome_ms=703.8,op_ms=745.6,outcome=ok,host_pid=38237,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=22,create=1,connect_ms=0.4,welcome_ms=789.9,op_ms=833.5,outcome=ok,host_pid=38253,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=23,create=1,connect_ms=0.4,welcome_ms=494.2,op_ms=535.1,outcome=ok,host_pid=38204,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=24,create=1,connect_ms=0.4,welcome_ms=81.5,op_ms=121.4,outcome=ok,host_pid=38168,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=25,create=1,connect_ms=0.4,welcome_ms=578.4,op_ms=618.8,outcome=ok,host_pid=38227,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=26,create=1,connect_ms=0.5,welcome_ms=922.3,op_ms=968.4,outcome=ok,host_pid=38283,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=27,create=1,connect_ms=0.5,welcome_ms=1183.3,op_ms=1226.3,outcome=ok,host_pid=38316,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=28,create=1,connect_ms=0.5,welcome_ms=1099.2,op_ms=1140.5,outcome=ok,host_pid=38310,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=29,create=1,connect_ms=0.5,welcome_ms=1313.0,op_ms=1354.8,outcome=ok,host_pid=38328,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=30,create=1,connect_ms=0.4,welcome_ms=2.6,op_ms=41.4,outcome=ok,host_pid=38164,detail=
burst-create,creates=32,hellos=0,delay_ms=0,i=31,create=1,connect_ms=0.4,welcome_ms=327.1,op_ms=367.6,outcome=ok,host_pid=38188,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=0,create=1,connect_ms=0.9,welcome_ms=203.0,op_ms=243.6,outcome=ok,host_pid=38351,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=1,create=1,connect_ms=0.9,welcome_ms=328.8,op_ms=369.2,outcome=ok,host_pid=38365,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=2,create=1,connect_ms=1.1,welcome_ms=1346.5,op_ms=1346.5,outcome=wire_error,host_pid=0,detail={"schemaVersion":1,"code":"CAPACITY_EXCEEDED","m
burst-create,creates=48,hellos=0,delay_ms=0,i=3,create=1,connect_ms=0.9,welcome_ms=496.1,op_ms=536.3,outcome=ok,host_pid=38373,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=4,create=1,connect_ms=0.9,welcome_ms=370.1,op_ms=410.4,outcome=ok,host_pid=38367,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=5,create=1,connect_ms=0.9,welcome_ms=453.1,op_ms=495.0,outcome=ok,host_pid=38371,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=6,create=1,connect_ms=0.9,welcome_ms=286.9,op_ms=328.1,outcome=ok,host_pid=38362,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=7,create=1,connect_ms=0.9,welcome_ms=411.5,op_ms=452.1,outcome=ok,host_pid=38369,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=8,create=1,connect_ms=1.0,welcome_ms=1085.1,op_ms=1126.5,outcome=ok,host_pid=38425,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=9,create=1,connect_ms=0.9,welcome_ms=244.5,op_ms=286.2,outcome=ok,host_pid=38353,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=10,create=1,connect_ms=1.1,welcome_ms=1347.9,op_ms=1348.0,outcome=wire_error,host_pid=0,detail={"schemaVersion":1,"code":"CAPACITY_EXCEEDED","m
burst-create,creates=48,hellos=0,delay_ms=0,i=11,create=1,connect_ms=0.9,welcome_ms=537.2,op_ms=577.1,outcome=ok,host_pid=38375,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=12,create=1,connect_ms=1.1,welcome_ms=1346.9,op_ms=1347.0,outcome=wire_error,host_pid=0,detail={"schemaVersion":1,"code":"CAPACITY_EXCEEDED","m
burst-create,creates=48,hellos=0,delay_ms=0,i=13,create=1,connect_ms=1.0,welcome_ms=1211.6,op_ms=1254.8,outcome=ok,host_pid=38439,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=14,create=1,connect_ms=0.9,welcome_ms=162.8,op_ms=202.1,outcome=ok,host_pid=38349,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=15,create=1,connect_ms=1.0,welcome_ms=998.7,op_ms=1041.7,outcome=ok,host_pid=38413,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=16,create=1,connect_ms=1.0,welcome_ms=1042.4,op_ms=1084.4,outcome=ok,host_pid=38423,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=17,create=1,connect_ms=1.0,welcome_ms=914.6,op_ms=955.8,outcome=ok,host_pid=38409,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=18,create=1,connect_ms=0.9,welcome_ms=41.8,op_ms=79.8,outcome=ok,host_pid=38335,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=19,create=1,connect_ms=1.0,welcome_ms=832.7,op_ms=872.2,outcome=ok,host_pid=38405,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=20,create=1,connect_ms=0.9,welcome_ms=120.5,op_ms=162.0,outcome=ok,host_pid=38346,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=21,create=1,connect_ms=1.1,welcome_ms=1345.0,op_ms=1345.0,outcome=wire_error,host_pid=0,detail={"schemaVersion":1,"code":"CAPACITY_EXCEEDED","m
burst-create,creates=48,hellos=0,delay_ms=0,i=22,create=1,connect_ms=0.9,welcome_ms=577.7,op_ms=618.6,outcome=ok,host_pid=38384,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=23,create=1,connect_ms=0.9,welcome_ms=747.0,op_ms=789.4,outcome=ok,host_pid=38401,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=24,create=1,connect_ms=1.0,welcome_ms=1299.1,op_ms=1341.6,outcome=ok,host_pid=38443,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=25,create=1,connect_ms=1.1,welcome_ms=1345.4,op_ms=1345.5,outcome=wire_error,host_pid=0,detail={"schemaVersion":1,"code":"CAPACITY_EXCEEDED","m
burst-create,creates=48,hellos=0,delay_ms=0,i=26,create=1,connect_ms=1.1,welcome_ms=1344.5,op_ms=1344.6,outcome=wire_error,host_pid=0,detail={"schemaVersion":1,"code":"CAPACITY_EXCEEDED","m
burst-create,creates=48,hellos=0,delay_ms=0,i=27,create=1,connect_ms=1.1,welcome_ms=1349.1,op_ms=1349.2,outcome=wire_error,host_pid=0,detail={"schemaVersion":1,"code":"CAPACITY_EXCEEDED","m
burst-create,creates=48,hellos=0,delay_ms=0,i=28,create=1,connect_ms=0.9,welcome_ms=661.7,op_ms=703.2,outcome=ok,host_pid=38389,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=29,create=1,connect_ms=1.0,welcome_ms=1255.8,op_ms=1298.4,outcome=ok,host_pid=38441,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=30,create=1,connect_ms=1.0,welcome_ms=956.6,op_ms=997.9,outcome=ok,host_pid=38411,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=31,create=1,connect_ms=1.0,welcome_ms=1342.3,op_ms=1342.4,outcome=wire_error,host_pid=0,detail={"schemaVersion":1,"code":"CAPACITY_EXCEEDED","m
burst-create,creates=48,hellos=0,delay_ms=0,i=32,create=1,connect_ms=1.1,welcome_ms=1344.1,op_ms=1344.1,outcome=wire_error,host_pid=0,detail={"schemaVersion":1,"code":"CAPACITY_EXCEEDED","m
burst-create,creates=48,hellos=0,delay_ms=0,i=33,create=1,connect_ms=1.1,welcome_ms=1348.5,op_ms=1348.6,outcome=wire_error,host_pid=0,detail={"schemaVersion":1,"code":"CAPACITY_EXCEEDED","m
burst-create,creates=48,hellos=0,delay_ms=0,i=34,create=1,connect_ms=1.1,welcome_ms=1350.2,op_ms=1350.2,outcome=wire_error,host_pid=0,detail={"schemaVersion":1,"code":"CAPACITY_EXCEEDED","m
burst-create,creates=48,hellos=0,delay_ms=0,i=35,create=1,connect_ms=0.9,welcome_ms=80.8,op_ms=119.6,outcome=ok,host_pid=38337,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=36,create=1,connect_ms=0.9,welcome_ms=619.6,op_ms=660.5,outcome=ok,host_pid=38387,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=37,create=1,connect_ms=1.0,welcome_ms=790.1,op_ms=831.7,outcome=ok,host_pid=38403,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=38,create=1,connect_ms=1.0,welcome_ms=872.9,op_ms=913.8,outcome=ok,host_pid=38407,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=39,create=1,connect_ms=1.0,welcome_ms=1127.1,op_ms=1167.1,outcome=ok,host_pid=38427,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=40,create=1,connect_ms=1.0,welcome_ms=1167.7,op_ms=1210.8,outcome=ok,host_pid=38430,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=41,create=1,connect_ms=1.0,welcome_ms=1342.9,op_ms=1343.0,outcome=wire_error,host_pid=0,detail={"schemaVersion":1,"code":"CAPACITY_EXCEEDED","m
burst-create,creates=48,hellos=0,delay_ms=0,i=42,create=1,connect_ms=1.0,welcome_ms=1343.6,op_ms=1343.6,outcome=wire_error,host_pid=0,detail={"schemaVersion":1,"code":"CAPACITY_EXCEEDED","m
burst-create,creates=48,hellos=0,delay_ms=0,i=43,create=1,connect_ms=1.1,welcome_ms=1345.9,op_ms=1346.0,outcome=wire_error,host_pid=0,detail={"schemaVersion":1,"code":"CAPACITY_EXCEEDED","m
burst-create,creates=48,hellos=0,delay_ms=0,i=44,create=1,connect_ms=1.1,welcome_ms=1347.5,op_ms=1347.5,outcome=wire_error,host_pid=0,detail={"schemaVersion":1,"code":"CAPACITY_EXCEEDED","m
burst-create,creates=48,hellos=0,delay_ms=0,i=45,create=1,connect_ms=1.1,welcome_ms=1349.6,op_ms=1349.7,outcome=wire_error,host_pid=0,detail={"schemaVersion":1,"code":"CAPACITY_EXCEEDED","m
burst-create,creates=48,hellos=0,delay_ms=0,i=46,create=1,connect_ms=0.8,welcome_ms=2.9,op_ms=40.9,outcome=ok,host_pid=38333,detail=
burst-create,creates=48,hellos=0,delay_ms=0,i=47,create=1,connect_ms=0.9,welcome_ms=704.0,op_ms=746.3,outcome=ok,host_pid=38391,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=0,create=0,connect_ms=0.7,welcome_ms=5.3,op_ms=5.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=1,create=0,connect_ms=0.7,welcome_ms=3.8,op_ms=3.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=2,create=0,connect_ms=0.7,welcome_ms=6.4,op_ms=6.4,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=3,create=0,connect_ms=0.8,welcome_ms=14.4,op_ms=14.4,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=4,create=0,connect_ms=1.0,welcome_ms=24.4,op_ms=24.4,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=5,create=0,connect_ms=0.7,welcome_ms=6.0,op_ms=6.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=6,create=0,connect_ms=0.7,welcome_ms=7.5,op_ms=7.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=7,create=0,connect_ms=0.9,welcome_ms=20.5,op_ms=20.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=8,create=0,connect_ms=0.8,welcome_ms=12.4,op_ms=12.4,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=9,create=0,connect_ms=0.9,welcome_ms=19.3,op_ms=19.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=10,create=0,connect_ms=0.7,welcome_ms=8.9,op_ms=8.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=11,create=0,connect_ms=0.7,welcome_ms=7.1,op_ms=7.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=12,create=0,connect_ms=0.9,welcome_ms=21.2,op_ms=21.2,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=13,create=0,connect_ms=0.9,welcome_ms=17.1,op_ms=17.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=14,create=0,connect_ms=1.0,welcome_ms=25.1,op_ms=25.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=15,create=0,connect_ms=0.7,welcome_ms=6.7,op_ms=6.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=16,create=0,connect_ms=0.7,welcome_ms=5.6,op_ms=5.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=17,create=0,connect_ms=0.9,welcome_ms=22.8,op_ms=22.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=18,create=0,connect_ms=0.8,welcome_ms=9.7,op_ms=9.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=19,create=0,connect_ms=0.9,welcome_ms=17.8,op_ms=17.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=20,create=0,connect_ms=0.8,welcome_ms=12.8,op_ms=12.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=21,create=0,connect_ms=0.8,welcome_ms=15.1,op_ms=15.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=22,create=0,connect_ms=0.9,welcome_ms=22.0,op_ms=22.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=23,create=0,connect_ms=1.0,welcome_ms=27.0,op_ms=27.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=24,create=0,connect_ms=0.7,welcome_ms=7.8,op_ms=7.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=25,create=0,connect_ms=0.8,welcome_ms=11.2,op_ms=11.2,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=26,create=0,connect_ms=0.8,welcome_ms=13.6,op_ms=13.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=27,create=0,connect_ms=0.8,welcome_ms=16.3,op_ms=16.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=28,create=0,connect_ms=0.9,welcome_ms=20.8,op_ms=20.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=29,create=0,connect_ms=1.0,welcome_ms=26.3,op_ms=26.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=30,create=0,connect_ms=0.7,welcome_ms=3.4,op_ms=3.4,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=31,create=0,connect_ms=0.8,welcome_ms=10.9,op_ms=10.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=32,create=0,connect_ms=0.8,welcome_ms=10.1,op_ms=10.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=33,create=0,connect_ms=0.8,welcome_ms=16.7,op_ms=16.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=34,create=0,connect_ms=0.9,welcome_ms=18.6,op_ms=18.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=35,create=0,connect_ms=0.9,welcome_ms=23.2,op_ms=23.2,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=36,create=0,connect_ms=0.9,welcome_ms=22.4,op_ms=22.4,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=37,create=0,connect_ms=1.0,welcome_ms=25.9,op_ms=25.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=38,create=0,connect_ms=0.7,welcome_ms=4.1,op_ms=4.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=39,create=0,connect_ms=0.7,welcome_ms=8.6,op_ms=8.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=40,create=0,connect_ms=0.8,welcome_ms=9.3,op_ms=9.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=41,create=0,connect_ms=0.8,welcome_ms=13.2,op_ms=13.2,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=42,create=0,connect_ms=0.8,welcome_ms=14.8,op_ms=14.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=43,create=0,connect_ms=0.8,welcome_ms=15.5,op_ms=15.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=44,create=0,connect_ms=0.9,welcome_ms=18.2,op_ms=18.2,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=45,create=0,connect_ms=0.9,welcome_ms=19.7,op_ms=19.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=46,create=0,connect_ms=1.0,welcome_ms=24.0,op_ms=24.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=47,create=0,connect_ms=1.0,welcome_ms=24.7,op_ms=24.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=48,create=0,connect_ms=0.7,welcome_ms=2.9,op_ms=2.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=49,create=0,connect_ms=0.7,welcome_ms=4.9,op_ms=4.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=50,create=0,connect_ms=0.7,welcome_ms=8.2,op_ms=8.2,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=51,create=0,connect_ms=0.8,welcome_ms=10.5,op_ms=10.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=52,create=0,connect_ms=0.8,welcome_ms=11.6,op_ms=11.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=53,create=0,connect_ms=0.8,welcome_ms=12.0,op_ms=12.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=54,create=0,connect_ms=0.8,welcome_ms=14.0,op_ms=14.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=55,create=0,connect_ms=0.8,welcome_ms=15.9,op_ms=15.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=56,create=0,connect_ms=0.9,welcome_ms=17.4,op_ms=17.4,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=57,create=0,connect_ms=0.9,welcome_ms=19.0,op_ms=19.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=58,create=0,connect_ms=0.9,welcome_ms=20.1,op_ms=20.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=59,create=0,connect_ms=0.9,welcome_ms=21.6,op_ms=21.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=60,create=0,connect_ms=1.0,welcome_ms=23.6,op_ms=23.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=61,create=0,connect_ms=1.0,welcome_ms=25.5,op_ms=25.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=62,create=0,connect_ms=1.0,welcome_ms=26.7,op_ms=26.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=64,delay_ms=0,i=63,create=0,connect_ms=0.7,welcome_ms=4.5,op_ms=4.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=0,create=0,connect_ms=2.1,welcome_ms=5.2,op_ms=5.2,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=1,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=2,create=0,connect_ms=2.4,welcome_ms=29.6,op_ms=29.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=3,create=0,connect_ms=2.3,welcome_ms=23.7,op_ms=23.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=4,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=5,create=0,connect_ms=2.4,welcome_ms=24.5,op_ms=24.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=6,create=0,connect_ms=2.5,welcome_ms=38.1,op_ms=38.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=7,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=8,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=9,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=10,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=11,create=0,connect_ms=2.3,welcome_ms=24.1,op_ms=24.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=12,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=13,create=0,connect_ms=2.1,welcome_ms=7.7,op_ms=7.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=14,create=0,connect_ms=2.4,welcome_ms=31.2,op_ms=31.2,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=15,create=0,connect_ms=2.5,welcome_ms=37.8,op_ms=37.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=16,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=17,create=0,connect_ms=2.5,welcome_ms=37.0,op_ms=37.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=18,create=0,connect_ms=2.4,welcome_ms=26.1,op_ms=26.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=19,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=20,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=21,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=22,create=0,connect_ms=2.1,welcome_ms=5.6,op_ms=5.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=23,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=24,create=0,connect_ms=2.4,welcome_ms=28.8,op_ms=28.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=25,create=0,connect_ms=2.7,welcome_ms=43.8,op_ms=43.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=26,create=0,connect_ms=2.3,welcome_ms=18.1,op_ms=18.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=27,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=28,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=29,create=0,connect_ms=2.4,welcome_ms=31.6,op_ms=31.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=30,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=31,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=32,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=33,create=0,connect_ms=2.7,welcome_ms=42.7,op_ms=42.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=34,create=0,connect_ms=2.7,welcome_ms=45.0,op_ms=45.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=35,create=0,connect_ms=2.7,welcome_ms=45.8,op_ms=45.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=36,create=0,connect_ms=2.2,welcome_ms=14.2,op_ms=14.2,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=37,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=38,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=39,create=0,connect_ms=2.2,welcome_ms=13.5,op_ms=13.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=40,create=0,connect_ms=2.2,welcome_ms=11.5,op_ms=11.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=41,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=42,create=0,connect_ms=2.7,welcome_ms=47.3,op_ms=47.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=43,create=0,connect_ms=2.7,welcome_ms=44.6,op_ms=44.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=44,create=0,connect_ms=2.3,welcome_ms=21.2,op_ms=21.2,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=45,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=46,create=0,connect_ms=2.2,welcome_ms=11.9,op_ms=11.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=47,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=48,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=49,create=0,connect_ms=2.8,welcome_ms=50.1,op_ms=50.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=50,create=0,connect_ms=2.3,welcome_ms=19.7,op_ms=19.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=51,create=0,connect_ms=2.4,welcome_ms=26.9,op_ms=26.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=52,create=0,connect_ms=2.2,welcome_ms=17.3,op_ms=17.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=53,create=0,connect_ms=2.5,welcome_ms=33.9,op_ms=33.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=54,create=0,connect_ms=2.6,welcome_ms=41.2,op_ms=41.2,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=55,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=56,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=57,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=58,create=0,connect_ms=2.3,welcome_ms=20.8,op_ms=20.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=59,create=0,connect_ms=2.4,welcome_ms=28.1,op_ms=28.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=60,create=0,connect_ms=2.7,welcome_ms=43.1,op_ms=43.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=61,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=62,create=0,connect_ms=2.2,welcome_ms=16.6,op_ms=16.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=63,create=0,connect_ms=2.5,welcome_ms=34.3,op_ms=34.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=64,create=0,connect_ms=2.8,welcome_ms=52.8,op_ms=52.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=65,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=66,create=0,connect_ms=2.2,welcome_ms=12.3,op_ms=12.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=67,create=0,connect_ms=2.2,welcome_ms=15.8,op_ms=15.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=68,create=0,connect_ms=2.4,welcome_ms=30.8,op_ms=30.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=69,create=0,connect_ms=2.5,welcome_ms=39.3,op_ms=39.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=70,create=0,connect_ms=2.8,welcome_ms=53.2,op_ms=53.2,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=71,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=72,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=73,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=74,create=0,connect_ms=2.1,welcome_ms=4.9,op_ms=4.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=75,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=76,create=0,connect_ms=2.2,welcome_ms=13.8,op_ms=13.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=77,create=0,connect_ms=2.3,welcome_ms=18.5,op_ms=18.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=78,create=0,connect_ms=2.3,welcome_ms=22.5,op_ms=22.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=79,create=0,connect_ms=2.4,welcome_ms=27.7,op_ms=27.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=80,create=0,connect_ms=2.4,welcome_ms=32.3,op_ms=32.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=81,create=0,connect_ms=2.7,welcome_ms=44.2,op_ms=44.2,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=82,create=0,connect_ms=2.7,welcome_ms=47.0,op_ms=47.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=83,create=0,connect_ms=2.7,welcome_ms=43.5,op_ms=43.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=84,create=0,connect_ms=2.8,welcome_ms=50.5,op_ms=50.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=85,create=0,connect_ms=2.8,welcome_ms=51.7,op_ms=51.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=86,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=87,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=88,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=89,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=90,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=91,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=92,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=93,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=94,create=0,connect_ms=2.1,welcome_ms=6.7,op_ms=6.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=95,create=0,connect_ms=2.2,welcome_ms=11.1,op_ms=11.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=96,create=0,connect_ms=2.2,welcome_ms=15.0,op_ms=15.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=97,create=0,connect_ms=2.2,welcome_ms=16.2,op_ms=16.2,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=98,create=0,connect_ms=2.3,welcome_ms=20.1,op_ms=20.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=99,create=0,connect_ms=2.3,welcome_ms=21.6,op_ms=21.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=100,create=0,connect_ms=2.4,welcome_ms=26.6,op_ms=26.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=101,create=0,connect_ms=2.4,welcome_ms=25.3,op_ms=25.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=102,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=103,create=0,connect_ms=2.5,welcome_ms=32.7,op_ms=32.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=104,create=0,connect_ms=2.5,welcome_ms=35.0,op_ms=35.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=105,create=0,connect_ms=2.6,welcome_ms=40.1,op_ms=40.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=106,create=0,connect_ms=2.7,welcome_ms=42.0,op_ms=42.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=107,create=0,connect_ms=2.7,welcome_ms=46.2,op_ms=46.2,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=108,create=0,connect_ms=2.8,welcome_ms=49.3,op_ms=49.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=109,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=110,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=111,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=112,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=113,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=114,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=115,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=116,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=117,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=118,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=119,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=120,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=121,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=122,create=0,connect_ms=2.2,welcome_ms=8.9,op_ms=8.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=123,create=0,connect_ms=2.2,welcome_ms=9.3,op_ms=9.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=124,create=0,connect_ms=2.2,welcome_ms=13.1,op_ms=13.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=125,create=0,connect_ms=2.3,welcome_ms=18.9,op_ms=18.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=126,create=0,connect_ms=2.3,welcome_ms=19.3,op_ms=19.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=127,create=0,connect_ms=2.3,welcome_ms=23.3,op_ms=23.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=128,create=0,connect_ms=2.4,welcome_ms=24.9,op_ms=24.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=129,create=0,connect_ms=2.4,welcome_ms=29.2,op_ms=29.2,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=130,create=0,connect_ms=2.4,welcome_ms=30.4,op_ms=30.4,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=131,create=0,connect_ms=2.5,welcome_ms=33.5,op_ms=33.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=132,create=0,connect_ms=2.5,welcome_ms=36.4,op_ms=36.4,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=133,create=0,connect_ms=2.5,welcome_ms=35.5,op_ms=35.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=134,create=0,connect_ms=2.5,welcome_ms=38.9,op_ms=38.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=135,create=0,connect_ms=2.6,welcome_ms=39.7,op_ms=39.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=136,create=0,connect_ms=2.6,welcome_ms=40.8,op_ms=40.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=137,create=0,connect_ms=2.7,welcome_ms=46.6,op_ms=46.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=138,create=0,connect_ms=2.8,welcome_ms=45.4,op_ms=45.4,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=139,create=0,connect_ms=2.8,welcome_ms=50.9,op_ms=50.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=140,create=0,connect_ms=2.9,welcome_ms=52.0,op_ms=52.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=141,create=0,connect_ms=2.8,welcome_ms=53.6,op_ms=53.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=142,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=143,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=144,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=145,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=146,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=147,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=148,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=149,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=150,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=151,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=152,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=153,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=154,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=155,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=156,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=157,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=158,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=159,create=0,connect_ms=2.1,welcome_ms=4.1,op_ms=4.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=160,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=161,create=0,connect_ms=2.1,welcome_ms=8.1,op_ms=8.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=162,create=0,connect_ms=2.2,welcome_ms=10.0,op_ms=10.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=163,create=0,connect_ms=2.1,welcome_ms=7.4,op_ms=7.4,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=164,create=0,connect_ms=2.2,welcome_ms=9.6,op_ms=9.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=165,create=0,connect_ms=2.2,welcome_ms=10.8,op_ms=10.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=166,create=0,connect_ms=2.7,welcome_ms=47.7,op_ms=47.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=167,create=0,connect_ms=2.8,welcome_ms=48.1,op_ms=48.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=168,create=0,connect_ms=2.8,welcome_ms=51.3,op_ms=51.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=169,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=170,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=171,create=0,connect_ms=2.9,welcome_ms=54.0,op_ms=54.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=172,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=173,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=174,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=175,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=176,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=177,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=178,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=179,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=180,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=181,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=182,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=183,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=184,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=185,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=186,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=187,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=188,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=189,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=190,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=191,create=0,connect_ms=2.1,welcome_ms=4.5,op_ms=4.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=192,create=0,connect_ms=2.1,welcome_ms=7.0,op_ms=7.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=193,create=0,connect_ms=2.2,welcome_ms=8.5,op_ms=8.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=194,create=0,connect_ms=2.2,welcome_ms=10.4,op_ms=10.4,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=195,create=0,connect_ms=2.2,welcome_ms=12.7,op_ms=12.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=196,create=0,connect_ms=2.2,welcome_ms=14.6,op_ms=14.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=197,create=0,connect_ms=2.2,welcome_ms=15.4,op_ms=15.4,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=198,create=0,connect_ms=2.2,welcome_ms=16.9,op_ms=16.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=199,create=0,connect_ms=2.3,welcome_ms=17.8,op_ms=17.8,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=200,create=0,connect_ms=2.3,welcome_ms=20.5,op_ms=20.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=201,create=0,connect_ms=2.3,welcome_ms=22.0,op_ms=22.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=202,create=0,connect_ms=2.3,welcome_ms=22.9,op_ms=22.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=203,create=0,connect_ms=2.4,welcome_ms=25.7,op_ms=25.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=204,create=0,connect_ms=2.4,welcome_ms=27.3,op_ms=27.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=205,create=0,connect_ms=2.4,welcome_ms=28.5,op_ms=28.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=206,create=0,connect_ms=2.4,welcome_ms=30.0,op_ms=30.0,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=207,create=0,connect_ms=2.4,welcome_ms=31.9,op_ms=31.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=208,create=0,connect_ms=2.5,welcome_ms=33.1,op_ms=33.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=209,create=0,connect_ms=2.5,welcome_ms=34.6,op_ms=34.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=210,create=0,connect_ms=2.5,welcome_ms=35.9,op_ms=35.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=211,create=0,connect_ms=2.5,welcome_ms=37.4,op_ms=37.4,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=212,create=0,connect_ms=2.5,welcome_ms=38.5,op_ms=38.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=213,create=0,connect_ms=2.6,welcome_ms=40.4,op_ms=40.4,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=214,create=0,connect_ms=2.7,welcome_ms=41.6,op_ms=41.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=215,create=0,connect_ms=2.7,welcome_ms=42.3,op_ms=42.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=216,create=0,connect_ms=2.8,welcome_ms=48.5,op_ms=48.5,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=217,create=0,connect_ms=2.8,welcome_ms=48.9,op_ms=48.9,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=218,create=0,connect_ms=2.8,welcome_ms=49.7,op_ms=49.7,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=219,create=0,connect_ms=2.8,welcome_ms=52.4,op_ms=52.4,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=220,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=221,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=222,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=223,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=224,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=225,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=226,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=227,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=228,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=229,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=230,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=231,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=232,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=233,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=234,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=235,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=236,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=237,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=238,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=239,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=240,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=241,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=242,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=243,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=244,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=245,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=246,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=247,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=248,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=249,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=250,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=251,create=0,connect_ms=2.1,welcome_ms=6.3,op_ms=6.3,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=256,delay_ms=0,i=252,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=253,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=254,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
hello-storm,creates=0,hellos=256,delay_ms=0,i=255,create=0,connect_ms=2.1,welcome_ms=5.9,op_ms=5.9,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=0,create=1,connect_ms=0.7,welcome_ms=125.3,op_ms=164.2,outcome=ok,host_pid=38476,detail=
mix,creates=8,hellos=64,delay_ms=0,i=1,create=1,connect_ms=0.7,welcome_ms=211.2,op_ms=251.8,outcome=ok,host_pid=38496,detail=
mix,creates=8,hellos=64,delay_ms=0,i=2,create=1,connect_ms=0.7,welcome_ms=43.3,op_ms=83.8,outcome=ok,host_pid=38468,detail=
mix,creates=8,hellos=64,delay_ms=0,i=3,create=1,connect_ms=0.7,welcome_ms=165.1,op_ms=205.8,outcome=ok,host_pid=38482,detail=
mix,creates=8,hellos=64,delay_ms=0,i=4,create=1,connect_ms=0.7,welcome_ms=253.3,op_ms=294.4,outcome=ok,host_pid=38508,detail=
mix,creates=8,hellos=64,delay_ms=0,i=5,create=1,connect_ms=0.9,welcome_ms=310.1,op_ms=351.1,outcome=ok,host_pid=38523,detail=
mix,creates=8,hellos=64,delay_ms=0,i=6,create=1,connect_ms=0.7,welcome_ms=3.0,op_ms=42.6,outcome=ok,host_pid=38458,detail=
mix,creates=8,hellos=64,delay_ms=0,i=7,create=1,connect_ms=0.7,welcome_ms=84.9,op_ms=123.9,outcome=ok,host_pid=38474,detail=
mix,creates=8,hellos=64,delay_ms=0,i=8,create=0,connect_ms=0.7,welcome_ms=207.2,op_ms=207.2,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=9,create=0,connect_ms=1.0,welcome_ms=361.1,op_ms=361.1,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=10,create=0,connect_ms=1.1,welcome_ms=373.4,op_ms=373.4,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=11,create=0,connect_ms=0.8,welcome_ms=302.9,op_ms=302.9,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=12,create=0,connect_ms=1.0,welcome_ms=365.8,op_ms=365.8,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=13,create=0,connect_ms=1.1,welcome_ms=370.9,op_ms=370.9,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=14,create=0,connect_ms=0.7,welcome_ms=210.6,op_ms=210.6,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=15,create=0,connect_ms=1.0,welcome_ms=367.9,op_ms=367.9,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=16,create=0,connect_ms=0.8,welcome_ms=299.8,op_ms=299.8,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=17,create=0,connect_ms=0.8,welcome_ms=299.0,op_ms=299.0,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=18,create=0,connect_ms=0.7,welcome_ms=209.2,op_ms=209.2,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=19,create=0,connect_ms=0.8,welcome_ms=302.4,op_ms=302.4,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=20,create=0,connect_ms=1.0,welcome_ms=358.9,op_ms=358.9,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=21,create=0,connect_ms=1.1,welcome_ms=372.3,op_ms=372.3,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=22,create=0,connect_ms=1.0,welcome_ms=360.4,op_ms=360.4,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=23,create=0,connect_ms=0.9,welcome_ms=309.4,op_ms=309.4,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=24,create=0,connect_ms=1.0,welcome_ms=362.6,op_ms=362.6,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=25,create=0,connect_ms=1.0,welcome_ms=367.5,op_ms=367.5,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=26,create=0,connect_ms=1.1,welcome_ms=372.9,op_ms=372.9,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=27,create=0,connect_ms=0.7,welcome_ms=295.9,op_ms=295.9,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=28,create=0,connect_ms=0.9,welcome_ms=352.2,op_ms=352.2,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=29,create=0,connect_ms=0.8,welcome_ms=301.1,op_ms=301.1,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=30,create=0,connect_ms=0.9,welcome_ms=308.6,op_ms=308.6,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=31,create=0,connect_ms=0.9,welcome_ms=355.0,op_ms=355.0,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=32,create=0,connect_ms=1.0,welcome_ms=358.3,op_ms=358.3,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=33,create=0,connect_ms=1.0,welcome_ms=366.4,op_ms=366.4,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=34,create=0,connect_ms=1.1,welcome_ms=370.3,op_ms=370.3,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=35,create=0,connect_ms=0.7,welcome_ms=207.8,op_ms=207.8,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=36,create=0,connect_ms=0.7,welcome_ms=252.6,op_ms=252.6,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=37,create=0,connect_ms=0.8,welcome_ms=297.3,op_ms=297.3,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=38,create=0,connect_ms=0.8,welcome_ms=300.6,op_ms=300.6,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=39,create=0,connect_ms=1.0,welcome_ms=363.8,op_ms=363.8,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=40,create=0,connect_ms=0.9,welcome_ms=355.8,op_ms=355.8,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=41,create=0,connect_ms=0.9,welcome_ms=306.1,op_ms=306.1,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=42,create=0,connect_ms=0.9,welcome_ms=352.9,op_ms=352.9,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=43,create=0,connect_ms=0.9,welcome_ms=356.6,op_ms=356.6,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=44,create=0,connect_ms=1.0,welcome_ms=363.2,op_ms=363.2,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=45,create=0,connect_ms=1.0,welcome_ms=369.0,op_ms=369.0,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=46,create=0,connect_ms=1.0,welcome_ms=368.3,op_ms=368.3,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=47,create=0,connect_ms=0.7,welcome_ms=210.0,op_ms=210.0,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=48,create=0,connect_ms=0.7,welcome_ms=124.6,op_ms=124.6,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=49,create=0,connect_ms=0.7,welcome_ms=206.5,op_ms=206.5,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=50,create=0,connect_ms=0.7,welcome_ms=295.2,op_ms=295.2,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=51,create=0,connect_ms=0.8,welcome_ms=296.6,op_ms=296.6,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=52,create=0,connect_ms=0.8,welcome_ms=298.4,op_ms=298.4,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=53,create=0,connect_ms=0.9,welcome_ms=304.6,op_ms=304.6,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=54,create=0,connect_ms=0.8,welcome_ms=303.8,op_ms=303.8,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=55,create=0,connect_ms=0.9,welcome_ms=307.9,op_ms=307.9,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=56,create=0,connect_ms=0.9,welcome_ms=357.3,op_ms=357.3,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=57,create=0,connect_ms=0.8,welcome_ms=301.5,op_ms=301.5,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=58,create=0,connect_ms=0.9,welcome_ms=305.3,op_ms=305.3,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=59,create=0,connect_ms=0.9,welcome_ms=353.6,op_ms=353.6,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=60,create=0,connect_ms=0.9,welcome_ms=306.8,op_ms=306.8,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=61,create=0,connect_ms=0.9,welcome_ms=354.3,op_ms=354.3,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=62,create=0,connect_ms=1.0,welcome_ms=357.8,op_ms=357.8,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=63,create=0,connect_ms=1.0,welcome_ms=359.6,op_ms=359.6,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=64,create=0,connect_ms=1.0,welcome_ms=361.8,op_ms=361.8,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=65,create=0,connect_ms=1.0,welcome_ms=364.4,op_ms=364.4,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=66,create=0,connect_ms=1.0,welcome_ms=365.1,op_ms=365.1,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=67,create=0,connect_ms=1.0,welcome_ms=366.8,op_ms=366.8,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=68,create=0,connect_ms=1.1,welcome_ms=369.7,op_ms=369.7,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=69,create=0,connect_ms=1.1,welcome_ms=371.6,op_ms=371.6,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=70,create=0,connect_ms=0.7,welcome_ms=2.6,op_ms=2.6,outcome=ok,host_pid=0,detail=
mix,creates=8,hellos=64,delay_ms=0,i=71,create=0,connect_ms=0.7,welcome_ms=208.5,op_ms=208.5,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=0,create=1,connect_ms=1.4,welcome_ms=85.6,op_ms=126.0,outcome=ok,host_pid=38539,detail=
mix,creates=16,hellos=128,delay_ms=0,i=1,create=1,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
mix,creates=16,hellos=128,delay_ms=0,i=2,create=1,connect_ms=1.8,welcome_ms=415.3,op_ms=456.7,outcome=ok,host_pid=38597,detail=
mix,creates=16,hellos=128,delay_ms=0,i=3,create=1,connect_ms=1.4,welcome_ms=4.9,op_ms=42.5,outcome=ok,host_pid=38533,detail=
mix,creates=16,hellos=128,delay_ms=0,i=4,create=1,connect_ms=1.7,welcome_ms=371.8,op_ms=412.8,outcome=ok,host_pid=38586,detail=
mix,creates=16,hellos=128,delay_ms=0,i=5,create=1,connect_ms=1.7,welcome_ms=331.2,op_ms=370.9,outcome=ok,host_pid=38575,detail=
mix,creates=16,hellos=128,delay_ms=0,i=6,create=1,connect_ms=1.6,welcome_ms=235.9,op_ms=275.1,outcome=ok,host_pid=38571,detail=
mix,creates=16,hellos=128,delay_ms=0,i=7,create=1,connect_ms=1.8,welcome_ms=504.5,op_ms=544.9,outcome=ok,host_pid=38614,detail=
mix,creates=16,hellos=128,delay_ms=0,i=8,create=1,connect_ms=1.4,welcome_ms=43.8,op_ms=82.5,outcome=ok,host_pid=38535,detail=
mix,creates=16,hellos=128,delay_ms=0,i=9,create=1,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
mix,creates=16,hellos=128,delay_ms=0,i=10,create=1,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
mix,creates=16,hellos=128,delay_ms=0,i=11,create=1,connect_ms=1.4,welcome_ms=129.0,op_ms=171.1,outcome=ok,host_pid=38550,detail=
mix,creates=16,hellos=128,delay_ms=0,i=12,create=1,connect_ms=1.6,welcome_ms=188.0,op_ms=228.7,outcome=ok,host_pid=38565,detail=
mix,creates=16,hellos=128,delay_ms=0,i=13,create=1,connect_ms=1.9,welcome_ms=555.7,op_ms=595.4,outcome=ok,host_pid=38616,detail=
mix,creates=16,hellos=128,delay_ms=0,i=14,create=1,connect_ms=1.7,welcome_ms=278.9,op_ms=319.0,outcome=ok,host_pid=38573,detail=
mix,creates=16,hellos=128,delay_ms=0,i=15,create=1,connect_ms=1.8,welcome_ms=461.4,op_ms=502.6,outcome=ok,host_pid=38603,detail=
mix,creates=16,hellos=128,delay_ms=0,i=16,create=0,connect_ms=1.4,welcome_ms=3.7,op_ms=3.7,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=17,create=0,connect_ms=1.5,welcome_ms=174.2,op_ms=174.2,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=18,create=0,connect_ms=1.5,welcome_ms=181.5,op_ms=181.5,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=19,create=0,connect_ms=1.9,welcome_ms=597.0,op_ms=597.0,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=20,create=0,connect_ms=1.5,welcome_ms=182.5,op_ms=182.5,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=21,create=0,connect_ms=1.7,welcome_ms=323.5,op_ms=323.5,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=22,create=0,connect_ms=2.0,welcome_ms=599.7,op_ms=599.7,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=23,create=0,connect_ms=2.0,welcome_ms=608.0,op_ms=608.0,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=24,create=0,connect_ms=1.4,welcome_ms=128.5,op_ms=128.5,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=25,create=0,connect_ms=1.5,welcome_ms=178.7,op_ms=178.7,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=26,create=0,connect_ms=1.7,welcome_ms=324.2,op_ms=324.2,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=27,create=0,connect_ms=1.7,welcome_ms=327.4,op_ms=327.4,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=28,create=0,connect_ms=1.9,welcome_ms=596.3,op_ms=596.3,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=29,create=0,connect_ms=2.0,welcome_ms=603.3,op_ms=603.3,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=30,create=0,connect_ms=1.4,welcome_ms=84.1,op_ms=84.1,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=31,create=0,connect_ms=1.4,welcome_ms=127.4,op_ms=127.4,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=32,create=0,connect_ms=1.5,welcome_ms=184.1,op_ms=184.1,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=33,create=0,connect_ms=1.6,welcome_ms=231.9,op_ms=231.9,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=34,create=0,connect_ms=1.7,welcome_ms=329.5,op_ms=329.5,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=35,create=0,connect_ms=1.8,welcome_ms=458.8,op_ms=458.8,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=36,create=0,connect_ms=1.8,welcome_ms=547.1,op_ms=547.1,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=37,create=0,connect_ms=2.0,welcome_ms=605.8,op_ms=605.8,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=38,create=0,connect_ms=2.0,welcome_ms=612.4,op_ms=612.4,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=39,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
mix,creates=16,hellos=128,delay_ms=0,i=40,create=0,connect_ms=1.5,welcome_ms=176.2,op_ms=176.2,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=41,create=0,connect_ms=1.5,welcome_ms=179.4,op_ms=179.4,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=42,create=0,connect_ms=1.6,welcome_ms=187.4,op_ms=187.4,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=43,create=0,connect_ms=1.6,welcome_ms=275.9,op_ms=275.9,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=44,create=0,connect_ms=1.7,welcome_ms=330.6,op_ms=330.6,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=45,create=0,connect_ms=1.8,welcome_ms=460.0,op_ms=460.0,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=46,create=0,connect_ms=1.9,welcome_ms=549.1,op_ms=549.1,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=47,create=0,connect_ms=2.0,welcome_ms=609.2,op_ms=609.2,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=48,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
mix,creates=16,hellos=128,delay_ms=0,i=49,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
mix,creates=16,hellos=128,delay_ms=0,i=50,create=0,connect_ms=1.4,welcome_ms=83.4,op_ms=83.4,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=51,create=0,connect_ms=1.5,welcome_ms=175.6,op_ms=175.6,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=52,create=0,connect_ms=1.5,welcome_ms=180.1,op_ms=180.1,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=53,create=0,connect_ms=1.6,welcome_ms=231.1,op_ms=231.1,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=54,create=0,connect_ms=1.6,welcome_ms=234.0,op_ms=234.0,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=55,create=0,connect_ms=1.7,welcome_ms=278.1,op_ms=278.1,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=56,create=0,connect_ms=1.7,welcome_ms=321.4,op_ms=321.4,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=57,create=0,connect_ms=1.8,welcome_ms=414.3,op_ms=414.3,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=58,create=0,connect_ms=1.8,welcome_ms=547.6,op_ms=547.6,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=59,create=0,connect_ms=1.8,welcome_ms=460.8,op_ms=460.8,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=60,create=0,connect_ms=1.9,welcome_ms=552.9,op_ms=552.9,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=61,create=0,connect_ms=2.0,welcome_ms=610.6,op_ms=610.6,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=62,create=0,connect_ms=2.0,welcome_ms=604.4,op_ms=604.4,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=63,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
mix,creates=16,hellos=128,delay_ms=0,i=64,create=0,connect_ms=2.1,welcome_ms=613.6,op_ms=613.6,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=65,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
mix,creates=16,hellos=128,delay_ms=0,i=66,create=0,connect_ms=1.4,welcome_ms=126.8,op_ms=126.8,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=67,create=0,connect_ms=1.5,welcome_ms=172.0,op_ms=172.0,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=68,create=0,connect_ms=1.6,welcome_ms=186.1,op_ms=186.1,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=69,create=0,connect_ms=1.5,welcome_ms=183.6,op_ms=183.6,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=70,create=0,connect_ms=1.6,welcome_ms=229.6,op_ms=229.6,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=71,create=0,connect_ms=1.6,welcome_ms=234.6,op_ms=234.6,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=72,create=0,connect_ms=1.7,welcome_ms=322.8,op_ms=322.8,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=73,create=0,connect_ms=1.7,welcome_ms=325.4,op_ms=325.4,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=74,create=0,connect_ms=1.7,welcome_ms=328.1,op_ms=328.1,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=75,create=0,connect_ms=1.9,welcome_ms=552.3,op_ms=552.3,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=76,create=0,connect_ms=1.9,welcome_ms=597.8,op_ms=597.8,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=77,create=0,connect_ms=1.8,welcome_ms=548.4,op_ms=548.4,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=78,create=0,connect_ms=1.9,welcome_ms=598.5,op_ms=598.5,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=79,create=0,connect_ms=2.0,welcome_ms=600.4,op_ms=600.4,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=80,create=0,connect_ms=2.0,welcome_ms=601.9,op_ms=601.9,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=81,create=0,connect_ms=2.0,welcome_ms=609.9,op_ms=609.9,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=82,create=0,connect_ms=2.0,welcome_ms=611.8,op_ms=611.8,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=83,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
mix,creates=16,hellos=128,delay_ms=0,i=84,create=0,connect_ms=1.4,welcome_ms=4.0,op_ms=4.0,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=85,create=0,connect_ms=1.4,welcome_ms=85.0,op_ms=85.0,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=86,create=0,connect_ms=1.5,welcome_ms=172.8,op_ms=172.8,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=87,create=0,connect_ms=1.5,welcome_ms=176.9,op_ms=176.9,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=88,create=0,connect_ms=1.6,welcome_ms=230.3,op_ms=230.3,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=89,create=0,connect_ms=1.5,welcome_ms=180.8,op_ms=180.8,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=90,create=0,connect_ms=1.5,welcome_ms=184.7,op_ms=184.7,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=91,create=0,connect_ms=1.6,welcome_ms=233.3,op_ms=233.3,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=92,create=0,connect_ms=1.6,welcome_ms=277.4,op_ms=277.4,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=93,create=0,connect_ms=1.7,welcome_ms=320.0,op_ms=320.0,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=94,create=0,connect_ms=1.7,welcome_ms=326.1,op_ms=326.1,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=95,create=0,connect_ms=1.7,welcome_ms=328.8,op_ms=328.8,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=96,create=0,connect_ms=1.8,welcome_ms=458.2,op_ms=458.2,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=97,create=0,connect_ms=1.8,welcome_ms=546.5,op_ms=546.5,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=98,create=0,connect_ms=1.8,welcome_ms=459.4,op_ms=459.4,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=99,create=0,connect_ms=1.9,welcome_ms=555.0,op_ms=555.0,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=100,create=0,connect_ms=1.9,welcome_ms=551.6,op_ms=551.6,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=101,create=0,connect_ms=1.9,welcome_ms=549.6,op_ms=549.6,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=102,create=0,connect_ms=2.0,welcome_ms=603.7,op_ms=603.7,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=103,create=0,connect_ms=2.0,welcome_ms=601.2,op_ms=601.2,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=104,create=0,connect_ms=2.0,welcome_ms=607.3,op_ms=607.3,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=105,create=0,connect_ms=2.0,welcome_ms=613.1,op_ms=613.1,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=106,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
mix,creates=16,hellos=128,delay_ms=0,i=107,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
mix,creates=16,hellos=128,delay_ms=0,i=108,create=0,connect_ms=1.3,welcome_ms=3.3,op_ms=3.3,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=109,create=0,connect_ms=1.4,welcome_ms=43.2,op_ms=43.2,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=110,create=0,connect_ms=1.4,welcome_ms=127.9,op_ms=127.9,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=111,create=0,connect_ms=1.5,welcome_ms=173.5,op_ms=173.5,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=112,create=0,connect_ms=1.5,welcome_ms=174.9,op_ms=174.9,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=113,create=0,connect_ms=1.5,welcome_ms=177.7,op_ms=177.7,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=114,create=0,connect_ms=1.6,welcome_ms=186.7,op_ms=186.7,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=115,create=0,connect_ms=1.5,welcome_ms=183.2,op_ms=183.2,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=116,create=0,connect_ms=1.6,welcome_ms=185.4,op_ms=185.4,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=117,create=0,connect_ms=1.6,welcome_ms=232.6,op_ms=232.6,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=118,create=0,connect_ms=1.6,welcome_ms=235.3,op_ms=235.3,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=119,create=0,connect_ms=1.6,welcome_ms=276.6,op_ms=276.6,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=120,create=0,connect_ms=1.7,welcome_ms=320.8,op_ms=320.8,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=121,create=0,connect_ms=1.7,welcome_ms=322.1,op_ms=322.1,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=122,create=0,connect_ms=1.7,welcome_ms=324.9,op_ms=324.9,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=123,create=0,connect_ms=1.7,welcome_ms=326.7,op_ms=326.7,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=124,create=0,connect_ms=1.7,welcome_ms=330.1,op_ms=330.1,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=125,create=0,connect_ms=1.8,welcome_ms=413.5,op_ms=413.5,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=126,create=0,connect_ms=1.8,welcome_ms=457.5,op_ms=457.5,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=127,create=0,connect_ms=1.9,welcome_ms=550.2,op_ms=550.2,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=128,create=0,connect_ms=1.8,welcome_ms=545.8,op_ms=545.8,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=129,create=0,connect_ms=1.8,welcome_ms=503.6,op_ms=503.6,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=130,create=0,connect_ms=1.9,welcome_ms=551.0,op_ms=551.0,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=131,create=0,connect_ms=1.9,welcome_ms=553.8,op_ms=553.8,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=132,create=0,connect_ms=1.9,welcome_ms=554.5,op_ms=554.5,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=133,create=0,connect_ms=1.9,welcome_ms=599.0,op_ms=599.0,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=134,create=0,connect_ms=2.0,welcome_ms=602.6,op_ms=602.6,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=135,create=0,connect_ms=2.0,welcome_ms=605.0,op_ms=605.0,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=136,create=0,connect_ms=2.0,welcome_ms=606.7,op_ms=606.7,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=137,create=0,connect_ms=2.0,welcome_ms=608.6,op_ms=608.6,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=138,create=0,connect_ms=2.0,welcome_ms=611.2,op_ms=611.2,outcome=ok,host_pid=0,detail=
mix,creates=16,hellos=128,delay_ms=0,i=139,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
mix,creates=16,hellos=128,delay_ms=0,i=140,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
mix,creates=16,hellos=128,delay_ms=0,i=141,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
mix,creates=16,hellos=128,delay_ms=0,i=142,create=0,connect_ms=-1.0,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=ConnectionRefused
mix,creates=16,hellos=128,delay_ms=0,i=143,create=0,connect_ms=1.4,welcome_ms=4.4,op_ms=4.4,outcome=ok,host_pid=0,detail=
burst-create,creates=1,hellos=0,delay_ms=4000,i=0,create=1,connect_ms=0.1,welcome_ms=4003.1,op_ms=4053.4,outcome=ok,host_pid=38872,detail=
burst-create,creates=4,hellos=0,delay_ms=1000,i=0,create=1,connect_ms=0.1,welcome_ms=2053.9,op_ms=2102.9,outcome=ok,host_pid=39068,detail=
burst-create,creates=4,hellos=0,delay_ms=1000,i=1,create=1,connect_ms=0.1,welcome_ms=4161.8,op_ms=4210.4,outcome=ok,host_pid=39237,detail=
burst-create,creates=4,hellos=0,delay_ms=1000,i=2,create=1,connect_ms=0.1,welcome_ms=1007.2,op_ms=1049.9,outcome=ok,host_pid=38965,detail=
burst-create,creates=4,hellos=0,delay_ms=1000,i=3,create=1,connect_ms=0.1,welcome_ms=3105.1,op_ms=3160.2,outcome=ok,host_pid=39163,detail=
burst-create,creates=16,hellos=0,delay_ms=250,i=0,create=1,connect_ms=0.3,welcome_ms=2975.1,op_ms=3026.6,outcome=ok,host_pid=39480,detail=
burst-create,creates=16,hellos=0,delay_ms=250,i=1,create=1,connect_ms=0.3,welcome_ms=2062.8,op_ms=2116.9,outcome=ok,host_pid=39432,detail=
burst-create,creates=16,hellos=0,delay_ms=250,i=2,create=1,connect_ms=0.2,welcome_ms=850.0,op_ms=894.7,outcome=ok,host_pid=39333,detail=
burst-create,creates=16,hellos=0,delay_ms=250,i=3,create=1,connect_ms=0.3,welcome_ms=3278.5,op_ms=3319.5,outcome=ok,host_pid=39529,detail=
burst-create,creates=16,hellos=0,delay_ms=250,i=4,create=1,connect_ms=0.3,welcome_ms=4780.2,op_ms=4838.0,outcome=ok,host_pid=39627,detail=
burst-create,creates=16,hellos=0,delay_ms=250,i=5,create=1,connect_ms=0.2,welcome_ms=258.1,op_ms=299.3,outcome=ok,host_pid=39274,detail=
burst-create,creates=16,hellos=0,delay_ms=250,i=6,create=1,connect_ms=0.3,welcome_ms=3874.0,op_ms=3922.5,outcome=ok,host_pid=39564,detail=
burst-create,creates=16,hellos=0,delay_ms=250,i=7,create=1,connect_ms=0.2,welcome_ms=1443.1,op_ms=1491.5,outcome=ok,host_pid=39402,detail=
burst-create,creates=16,hellos=0,delay_ms=250,i=8,create=1,connect_ms=0.3,welcome_ms=2675.2,op_ms=2721.2,outcome=ok,host_pid=39464,detail=
burst-create,creates=16,hellos=0,delay_ms=250,i=9,create=1,connect_ms=0.2,welcome_ms=554.7,op_ms=595.6,outcome=ok,host_pid=39305,detail=
burst-create,creates=16,hellos=0,delay_ms=250,i=10,create=1,connect_ms=0.3,welcome_ms=1747.9,op_ms=1811.0,outcome=ok,host_pid=39413,detail=
burst-create,creates=16,hellos=0,delay_ms=250,i=11,create=1,connect_ms=0.3,welcome_ms=3571.3,op_ms=3618.5,outcome=ok,host_pid=39554,detail=
burst-create,creates=16,hellos=0,delay_ms=250,i=12,create=1,connect_ms=0.3,welcome_ms=4175.8,op_ms=4233.7,outcome=ok,host_pid=39574,detail=
burst-create,creates=16,hellos=0,delay_ms=250,i=13,create=1,connect_ms=0.3,welcome_ms=2368.8,op_ms=2421.1,outcome=ok,host_pid=39442,detail=
burst-create,creates=16,hellos=0,delay_ms=250,i=14,create=1,connect_ms=0.3,welcome_ms=4485.1,op_ms=4529.0,outcome=ok,host_pid=39601,detail=
burst-create,creates=16,hellos=0,delay_ms=250,i=15,create=1,connect_ms=0.2,welcome_ms=1145.8,op_ms=1191.1,outcome=ok,host_pid=39383,detail=
burst-create,creates=16,hellos=0,delay_ms=1000,i=0,create=1,connect_ms=0.2,welcome_ms=2052.0,op_ms=2111.6,outcome=ok,host_pid=39789,detail=
burst-create,creates=16,hellos=0,delay_ms=1000,i=1,create=1,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
burst-create,creates=16,hellos=0,delay_ms=1000,i=2,create=1,connect_ms=0.2,welcome_ms=5226.9,op_ms=5267.9,outcome=ok,host_pid=39980,detail=
burst-create,creates=16,hellos=0,delay_ms=1000,i=3,create=1,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
burst-create,creates=16,hellos=0,delay_ms=1000,i=4,create=1,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
burst-create,creates=16,hellos=0,delay_ms=1000,i=5,create=1,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
burst-create,creates=16,hellos=0,delay_ms=1000,i=6,create=1,connect_ms=0.2,welcome_ms=7316.9,op_ms=7367.5,outcome=ok,host_pid=40166,detail=
burst-create,creates=16,hellos=0,delay_ms=1000,i=7,create=1,connect_ms=0.2,welcome_ms=1007.8,op_ms=1049.8,outcome=ok,host_pid=39710,detail=
burst-create,creates=16,hellos=0,delay_ms=1000,i=8,create=1,connect_ms=0.2,welcome_ms=6269.3,op_ms=6314.2,outcome=ok,host_pid=40088,detail=
burst-create,creates=16,hellos=0,delay_ms=1000,i=9,create=1,connect_ms=0.2,welcome_ms=9427.5,op_ms=9472.2,outcome=ok,host_pid=40296,detail=
burst-create,creates=16,hellos=0,delay_ms=1000,i=10,create=1,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
burst-create,creates=16,hellos=0,delay_ms=1000,i=11,create=1,connect_ms=0.2,welcome_ms=4177.1,op_ms=4225.1,outcome=ok,host_pid=39920,detail=
burst-create,creates=16,hellos=0,delay_ms=1000,i=12,create=1,connect_ms=0.2,welcome_ms=8368.6,op_ms=8425.2,outcome=ok,host_pid=40201,detail=
burst-create,creates=16,hellos=0,delay_ms=1000,i=13,create=1,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
burst-create,creates=16,hellos=0,delay_ms=1000,i=14,create=1,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
burst-create,creates=16,hellos=0,delay_ms=1000,i=15,create=1,connect_ms=0.2,welcome_ms=3114.2,op_ms=3175.6,outcome=ok,host_pid=39824,detail=
burst-create,creates=16,hellos=0,delay_ms=2000,i=0,create=1,connect_ms=0.4,welcome_ms=6108.4,op_ms=6150.5,outcome=ok,host_pid=41157,detail=
burst-create,creates=16,hellos=0,delay_ms=2000,i=1,create=1,connect_ms=0.5,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=2000,i=2,create=1,connect_ms=0.5,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=2000,i=3,create=1,connect_ms=0.4,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
burst-create,creates=16,hellos=0,delay_ms=2000,i=4,create=1,connect_ms=0.5,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=2000,i=5,create=1,connect_ms=0.4,welcome_ms=2006.4,op_ms=2054.7,outcome=ok,host_pid=40876,detail=
burst-create,creates=16,hellos=0,delay_ms=2000,i=6,create=1,connect_ms=0.4,welcome_ms=4058.0,op_ms=4107.1,outcome=ok,host_pid=41005,detail=
burst-create,creates=16,hellos=0,delay_ms=2000,i=7,create=1,connect_ms=0.4,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
burst-create,creates=16,hellos=0,delay_ms=2000,i=8,create=1,connect_ms=0.4,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
burst-create,creates=16,hellos=0,delay_ms=2000,i=9,create=1,connect_ms=0.4,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=2000,i=10,create=1,connect_ms=0.4,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
burst-create,creates=16,hellos=0,delay_ms=2000,i=11,create=1,connect_ms=0.5,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=2000,i=12,create=1,connect_ms=0.4,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
burst-create,creates=16,hellos=0,delay_ms=2000,i=13,create=1,connect_ms=0.4,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=2000,i=14,create=1,connect_ms=0.5,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=2000,i=15,create=1,connect_ms=0.4,welcome_ms=8157.3,op_ms=8220.3,outcome=ok,host_pid=41341,detail=
burst-create,creates=16,hellos=0,delay_ms=4000,i=0,create=1,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=4000,i=1,create=1,connect_ms=0.3,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=4000,i=2,create=1,connect_ms=0.3,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=4000,i=3,create=1,connect_ms=0.3,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=4000,i=4,create=1,connect_ms=0.3,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=4000,i=5,create=1,connect_ms=0.3,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=4000,i=6,create=1,connect_ms=0.2,welcome_ms=4003.2,op_ms=4053.2,outcome=ok,host_pid=42349,detail=
burst-create,creates=16,hellos=0,delay_ms=4000,i=7,create=1,connect_ms=0.3,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=4000,i=8,create=1,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
burst-create,creates=16,hellos=0,delay_ms=4000,i=9,create=1,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
burst-create,creates=16,hellos=0,delay_ms=4000,i=10,create=1,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=4000,i=11,create=1,connect_ms=0.3,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=4000,i=12,create=1,connect_ms=0.3,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=4000,i=13,create=1,connect_ms=0.3,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=4000,i=14,create=1,connect_ms=0.3,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
burst-create,creates=16,hellos=0,delay_ms=4000,i=15,create=1,connect_ms=0.2,welcome_ms=8059.1,op_ms=8108.0,outcome=ok,host_pid=42616,detail=
hello-storm,creates=0,hellos=16,delay_ms=2000,i=0,create=0,connect_ms=0.2,welcome_ms=4010.4,op_ms=4010.4,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=16,delay_ms=2000,i=1,create=0,connect_ms=0.2,welcome_ms=8017.6,op_ms=8017.6,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=16,delay_ms=2000,i=2,create=0,connect_ms=0.3,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
hello-storm,creates=0,hellos=16,delay_ms=2000,i=3,create=0,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
hello-storm,creates=0,hellos=16,delay_ms=2000,i=4,create=0,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
hello-storm,creates=0,hellos=16,delay_ms=2000,i=5,create=0,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
hello-storm,creates=0,hellos=16,delay_ms=2000,i=6,create=0,connect_ms=0.3,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
hello-storm,creates=0,hellos=16,delay_ms=2000,i=7,create=0,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
hello-storm,creates=0,hellos=16,delay_ms=2000,i=8,create=0,connect_ms=0.2,welcome_ms=2008.1,op_ms=2008.1,outcome=ok,host_pid=0,detail=
hello-storm,creates=0,hellos=16,delay_ms=2000,i=9,create=0,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
hello-storm,creates=0,hellos=16,delay_ms=2000,i=10,create=0,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
hello-storm,creates=0,hellos=16,delay_ms=2000,i=11,create=0,connect_ms=0.3,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
hello-storm,creates=0,hellos=16,delay_ms=2000,i=12,create=0,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
hello-storm,creates=0,hellos=16,delay_ms=2000,i=13,create=0,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=wire-failure-frame
hello-storm,creates=0,hellos=16,delay_ms=2000,i=14,create=0,connect_ms=0.2,welcome_ms=-1.0,op_ms=-1.0,outcome=failure,host_pid=0,detail=WouldBlock
hello-storm,creates=0,hellos=16,delay_ms=2000,i=15,create=0,connect_ms=0.2,welcome_ms=6013.3,op_ms=6013.3,outcome=ok,host_pid=0,detail=
```
## Appendix D — incident artifacts, verbatim

The exact failure strings recorded for the sixteen (from the kill results):

```
Group A — "Spawn failure for <name>: sessiond HELLO request timed out: teardown could not be verified: Process-tree probe did not contain root pid <N>"
          (nina pid 87232, anna 87583, omar 88921, lena 87332, noah 87462)
Group B — "Spawn failure for <name>: terminal session exited: teardown could not be verified: Process-tree probe did not contain root pid <N>"
          (sam 85925, john 86921, leo 88007, emma 88583)
Group C — "resume launch failed: terminal session exited; teardown could not be verified: Process-tree probe did not contain root pid 99935"
          (david, after recoveryAttempts=1)
Group D — no failureReason recorded; status terminalState "lost"
          (alex, james, priya, zoe, liam, sarah)
Group E — "died in a crash and could not be resumed: worktree is missing; session not resumable"
          (sarah, alex, james, priya)
```

Every host record + final state in the incident home
(`/tmp/hv-a27e3d322a/runtime/sessiond/hosts/`), extracted from each
`record.json`/`final.json`. The 16 gen-1 hosts are the `ses_019fa549-*`
rows; `ses_019fa54a` is david gen 2, `ses_019fa54d` liam gen 2,
`ses_019fa544` maya (the healthy control), `ses_019fa53b` queen:

| session | hostPid | createdAt (Z) | expiresAt (Z) | vis state | failureCode | exit |
|---|---|---|---|---|---|---|
| ses_019fa53b-c3d6-7d21-a598-102ab9db1279 | 19838 | 2026-07-27T20:19:45.375Z | 2026-07-27T20:20:00.375Z | attaching | None | None | None |
| ses_019fa544-f27a-7f06-85fd-331c4b6a6195 | 57217 | 2026-07-27T20:29:47.120Z | 2026-07-27T20:30:02.120Z | attaching | None | None | 9 |
| ses_019fa549-e967-792a-b10d-dbde2c462792 | 85358 | 2026-07-27T20:35:12.914Z | 2026-07-27T20:35:27.914Z | attaching | VISIBILITY_EXPIRED | 1 | None |
| ses_019fa549-ec76-75ee-82d7-fd5c28832128 | 85671 | 2026-07-27T20:35:13.839Z | 2026-07-27T20:35:28.839Z | attaching | VISIBILITY_EXPIRED | 1 | None |
| ses_019fa549-ecc3-76d6-9334-f6547de69a24 | 85925 | 2026-07-27T20:35:14.796Z | 2026-07-27T20:35:29.795Z | attaching | VISIBILITY_EXPIRED | 1 | None |
| ses_019fa549-ee87-7baa-85f7-bc0a644132b9 | 86921 | 2026-07-27T20:35:16.235Z | 2026-07-27T20:35:31.235Z | attaching | VISIBILITY_EXPIRED | 1 | None |
| ses_019fa549-f063-7afb-a811-ccec98c9c89a | 87254 | 2026-07-27T20:35:16.784Z | 2026-07-27T20:35:31.784Z | attaching | VISIBILITY_EXPIRED | 1 | None |
| ses_019fa549-f16b-7bee-a8ec-4e31afaa20c3 | 87232 | 2026-07-27T20:35:16.703Z | 2026-07-27T20:35:31.703Z | attaching | VISIBILITY_EXPIRED | 1 | None |
| ses_019fa549-f18d-7c72-9b76-9026988bf188 | 88583 | 2026-07-27T20:35:17.852Z | 2026-07-27T20:35:32.852Z | attaching | VISIBILITY_EXPIRED | 1 | None |
| ses_019fa549-f18e-7e97-be6d-fcd836d8bd33 | 87462 | 2026-07-27T20:35:16.967Z | 2026-07-27T20:35:31.967Z | attaching | VISIBILITY_EXPIRED | 1 | None |
| ses_019fa549-f18f-72fb-994a-5bf93c88bdab | 88007 | 2026-07-27T20:35:17.398Z | 2026-07-27T20:35:32.398Z | attaching | VISIBILITY_EXPIRED | 1 | None |
| ses_019fa549-f18f-7596-9fb9-55f9c8b93ead | 88730 | 2026-07-27T20:35:17.959Z | 2026-07-27T20:35:32.959Z | attaching | VISIBILITY_EXPIRED | 1 | None |
| ses_019fa549-f190-7077-85e6-d3364c99ac55 | 88921 | 2026-07-27T20:35:18.061Z | 2026-07-27T20:35:33.061Z | attaching | VISIBILITY_EXPIRED | 1 | None |
| ses_019fa549-f190-7e42-b84e-cd2733ed8159 | 88214 | 2026-07-27T20:35:17.562Z | 2026-07-27T20:35:32.561Z | attaching | VISIBILITY_EXPIRED | 1 | None |
| ses_019fa549-f191-7796-95a8-fbf6ee3a8a1a | 87332 | 2026-07-27T20:35:16.876Z | 2026-07-27T20:35:31.876Z | attaching | VISIBILITY_EXPIRED | 1 | None |
| ses_019fa549-f192-7185-a06a-5c0136824040 | 87717 | 2026-07-27T20:35:17.145Z | 2026-07-27T20:35:32.145Z | attaching | VISIBILITY_EXPIRED | 1 | None |
| ses_019fa549-f192-7a03-a4a0-4f62a16d1c32 | 87583 | 2026-07-27T20:35:17.059Z | 2026-07-27T20:35:32.058Z | attaching | VISIBILITY_EXPIRED | 1 | None |
| ses_019fa549-f193-7e59-808a-7cc156ce12b9 | 87916 | 2026-07-27T20:35:17.290Z | 2026-07-27T20:35:32.290Z | attaching | VISIBILITY_EXPIRED | 1 | None |
| ses_019fa54a-e0a3-76fd-b634-53661a13fa2a | 99935 | 2026-07-27T20:36:21.281Z | 2026-07-27T20:36:36.281Z | attaching | VISIBILITY_EXPIRED | 1 | None |
| ses_019fa54d-3980-798a-b668-a7175c4c6f06 | 26669 | 2026-07-27T20:38:50.863Z | 2026-07-27T20:39:05.863Z | attaching | None | None | 9 |
| ses_019fa54f-f03d-7e05-952d-14ce6de157e1 | 40385 | 2026-07-27T20:41:47.529Z | 2026-07-27T20:42:02.529Z | attaching | None | None | None |

One full record/final pair (sam, `ses_019fa549-ecc3-...`; the pid 85925 in
his Group-B failure string is this record's hostPid):

```json
{"locator":{"schemaVersion":1,"instanceId":"adc6ff7499","subject":{"kind":"agent","agentId":"e4cae49a-ee4d-4c9a-bb83-c169e252de40"},"generation":1,"sessionId":"ses_019fa549-ecc3-76d6-9334-f6547de69a24","hostKind":"sessiond","engineBuildId":"6e34032563f7a103faf7b70859d41c83374fe34948ecffd85e30160a516b11e1"},"hostPid":85925,"hostStartToken":"1785184514:756705","processRoot":{"pid":85931,"startToken":"1785184514:777439","processGroupId":85931},"expectedExecutable":"/bin/zsh","executableBuildHash":"a2d048ec56625706bf3f2d8dd1734ec84fe73e2d9c780b575b370bbc452cd6e0","engineBuildId":"6e34032563f7a103faf7b70859d41c83374fe34948ecffd85e30160a516b11e1","protocol":{"major":1,"minor":0},"geometry":{"columns":80,"rows":24,"widthPx":800,"heightPx":480,"cellWidthPx":10,"cellHeightPx":20},"state":"live","visibility":{"state":"attaching","workspaceSessionId":"25DE88DB-1F9C-440B-802F-30FFE3DBAF2F","openTerminalRevision":"191","expiresAt":"2026-07-27T20:35:29.795Z"},"outputSeq":"0","checkpointSeq":"0","schemaVersion":1,"socketRelativePath":"host.sock","createdAt":"2026-07-27T20:35:14.796Z"}
```

```json
{"schemaVersion":1,"state":"unknown","exitCode":1,"exitSignal":null,"waitObserved":true,"outputSeq":"4880","checkpointSeq":"0","survivors":[],"errors":[],"failureCode":"VISIBILITY_EXPIRED"}
```

maya's final.json — SIGKILL after a completed task, no failureCode, ten
minutes of output; the renewal path works when the loops are idle:

```json
{"schemaVersion":1,"state":"unknown","exitCode":null,"exitSignal":9,"waitObserved":true,"outputSeq":"405195","checkpointSeq":"392620","survivors":[],"errors":[{"phase":"neutral-control-operation","code":"incomplete-after-root-reap"}],"failureCode":null}
```

workspace.log, the stall and the attach storm (local time, UTC-4;
16:35:18.436 = 20:35:18.436Z). 907 `attach grant refused` lines total:

```
2026-07-27 16:35:18.436 HiveWorkspace[19755:50878325] workspace-feed error: status poll timed out after 5000ms
2026-07-27 16:35:45.149 HiveWorkspace[19755:51000049] sessiond attach for sarah failed: attach grant refused: hive: sessiond NOT_READY: not_ready
2026-07-27 16:35:45.153 HiveWorkspace[19755:50968155] sessiond attach for sam failed: attach grant refused: hive: sessiond NOT_READY: not_ready
2026-07-27 16:35:47.194 HiveWorkspace[19755:50878325] workspace-feed error: workspace visibility publish failed: HTTP 409
2026-07-27 16:35:48.820 HiveWorkspace[19755:50878325] workspace-feed error: status poll timed out after 5000ms
2026-07-27 16:35:52.205 HiveWorkspace[19755:50878325] workspace-feed error: workspace visibility publish timed out after 5000ms
2026-07-27 16:36:17.598 HiveWorkspace[19755:50966959] sessiond attach for david failed: attach grant refused: hive: Hive refused to attach david: its session generation changed [session-locator-mismatch]
```

Hook events proving six of the sixteen were genuinely working when their
leases expired underneath them (`events` table, UTC):

```
2026-07-27T20:35:14.966Z|david|session-start
2026-07-27T20:35:18.966Z|alex|session-start
2026-07-27T20:35:19.503Z|james|session-start
2026-07-27T20:35:20.736Z|sarah|tool-start
2026-07-27T20:35:21.513Z|priya|session-start
2026-07-27T20:35:25.520Z|zoe|tool-start
2026-07-27T20:35:28.626Z|liam|tool-start
```
