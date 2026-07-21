# 2026-07-21 fleet-wide vendor death: a stalled visibility publish expires every lease at once

Investigated live against the running dev instance (daemon pid 81422, started
2026-07-21 21:32:16Z, HIVE_HOME `/tmp/hv-a27e3d322a`, instance `adc6ff7499`) by
omar. All timestamps UTC; workspace.log lines are local (UTC−4) and are
converted where quoted.

At 22:19:47–22:19:50Z all five live agents' vendor processes died within ~2.5 s:
maya + john (claude) and david + alex + nina (codex). The daemon did not restart.

## Root cause

sessiond's **fail-closed visibility-lease enforcement** terminated all five
hosts because the Workspace's visibility renewal stalled past the 15 s lease.
The kill was Hive's own crash-invariant enforcement working exactly as written;
the defect is that a single stalled publish stalls renewal for the *entire
fleet*, with no timeout bounding it.

1. The visibility lease is `visibility_expiry_ms = 15000` (15 s), renewed every
   5 s (`test/session-host-conformance/contract.test.ts:75` asserts the
   generated constant; `native/sessiond/test/real-host-golden.zig:875-878`
   documents the 5 s renewal against a 15 s lease).
2. Renewal is published by the `hive workspace-feed` child (pid 81513) as one
   full-inventory POST to `/workspace-visibility`, which the daemon fans out to
   `terminalHost.renewVisibility` per session (`src/daemon/server.ts:3150-3172`).
   One publish therefore carries the liveness of **every** pane.
3. The last successful renewal set `expiresAt` on all five bindings to
   **22:19:31.681Z / .697 / .714 / .729 / .745** — clustered within **64 ms**,
   the signature of that single batch publish. Last successful publish was
   therefore ≈ 22:19:16.7Z:

   ```
   sqlite3 hive.db "SELECT locatorSessionId, expectedExecutable, expiresAt, terminationAuditJson ..."
   ses_019f86a7-a4fd  claude  2254   2026-07-21T22:19:31.681Z  NONE
   ses_019f86a7-bc9f  codex   2582   2026-07-21T22:19:31.697Z  NONE
   ses_019f86bf-a3b3  claude  37988  2026-07-21T22:19:31.714Z  NONE
   ses_019f86bf-c1c5  codex   38955  2026-07-21T22:19:31.729Z  NONE
   ses_019f86c1-9a47  codex   50622  2026-07-21T22:19:31.745Z  NONE
   ```

   Two `claude` + three `codex` — exactly the observed maya/john + david/alex/nina
   split. All five carry **no termination audit**, unlike the two legitimately
   stopped sessions in the same table (`stop agent …` at 21:47:19Z and 22:15:27Z).
4. Renewal then stopped. The feed logged the daemon's local HTTP surface
   stalling on either side of the freeze:

   ```
   2026-07-21 18:18:52.974  workspace-feed error: status poll timed out after 5000ms   (22:18:52.974Z)
   2026-07-21 18:19:22.428  workspace-feed error: status poll timed out after 5000ms   (22:19:22.428Z)
   ```

5. **`publishWorkspaceVisibility` awaits `operatorFetch` with no timeout and no
   `AbortSignal`** (`src/cli/workspace-feed.ts:82-118`), and
   `WorkspaceVisibilityPublisher.publishLine` serializes every publish onto one
   promise chain — `this.publications = this.publications.then(...)`
   (`src/cli/workspace-feed.ts:125-160`, introduced by fde93610). A single hung
   publish therefore head-of-line blocks all subsequent renewals indefinitely.
6. The leases expired at 22:19:31.68Z. `HostCore.enforceVisibilityExpiry` —
   "Crash invariant enforcement. The caller invokes this from the host lifecycle
   clock **even when no broker transport is connected**" — calls
   `terminateBound(.graceful, "VISIBILITY_EXPIRED")`
   (`native/sessiond/src/session_host.zig:3881-3886`).
7. `host_graceful_stop_bound_ms = 2s + 2s = 4000ms`
   (`native/sessiond/src/broker.zig:2373`). Predicted host death:
   22:19:31.681 + 4.000 s = **22:19:35.681Z**. Observed, all five within
   **51–289 ms** of that deadline:

   ```
   2026-07-21 18:19:35.732  sessiond pane david entering recovery: host transport lost   (22:19:35.732Z)
   2026-07-21 18:19:35.758  sessiond pane alex  entering recovery: host transport lost
   2026-07-21 18:19:35.759  sessiond pane maya  entering recovery: host transport lost
   2026-07-21 18:19:35.776  sessiond pane nina  entering recovery: host transport lost
   2026-07-21 18:19:35.970  sessiond pane john  entering recovery: host transport lost
   ```

8. The graceful terminate escalates to SIGKILL, which is maya's observed
   **exit 137** at ~22:19:47–50Z. That is the termination escalation, not an
   out-of-memory kill.

## Ruled out (each with a positive control)

**OOM / jetsam — refuted.** The premise that this is a 16 GB M1 Pro is wrong:
`sysctl hw.memsize` = 51539607552 (**48 GiB**), `hw.model` = Mac16,5, **Apple
M4 Max**. `sysctl vm.swapusage` = `total = 0.00M used = 0.00M` — swap was never
even allocated across 1 d 11 h of uptime. `kern.memorystatus_level` = 87. No
JetsamEvent report exists for 2026-07-21. *Positive control:* jetsam reports
**do** get written on this box —
`/Library/Logs/DiagnosticReports/JetsamEvent-2026-07-20-150027.ips` exists from
the previous day — so the reader works and the absence is real. maya's
concurrent `zig build` is coincidence; her exit 137 is explained by step 8.

**Daemon restart — refuted.** pid 81422, started 17:32:16 local, `etime` 56:25
when sampled, still `LISTEN` on 127.0.0.1:57506. Continuous across the incident.

**workspace-feed crash — refuted.** pid 81513, started 17:32:18, still alive. It
stalled; it did not die. The fde93610 halt path never fired either:
`grep -c halted workspace.log` = 0.

**The HTTP 409 storm — consequence, not cause.** The 409s begin at
22:19:36.898Z, *after* expiry. `src/daemon/server.ts:3165-3171` returns 409 when
any `renewVisibility` fails, with diagnostic `sessiond visibility renewal failed
closed` — i.e. renewing against hosts sessiond had already terminated. The lone
earlier 409 (22:15:22.451Z) coincides with sam's `GENERATION_GONE` and is the
same benign class.

**Port 64342 — red herring.** It is not a Hive endpoint. Hive MCP in this
instance is `http://127.0.0.1:57506/mcp`
(`$HIVE_HOME/runtime/orchestrator/.mcp.json`), and nothing listens on 64342.
64342 is the JetBrains `idea` MCP server: `~/.claude.json` has
`"idea": {"type":"sse","url":"http://127.0.0.1:64342/sse"}`, and
`src/adapters/tools/mcp-scope.test.ts:31` carries the exact string nina
reported, `url = "http://127.0.0.1:64342/stream"`. nina's `MCP startup
incomplete (failed: hive, idea)` named two servers; the URL shown belonged to
`idea`, not to hive. No endpoint moved and no daemon-adjacent component
restarted. Hive's own port never changed: 57506 throughout.

**david's B2.5 harness collision — no evidence.** Exactly one `hive daemon`
process exists and `/tmp` holds exactly one instance home (`hv-a27e3d322a`); no
competing instance home was created in the window.

**The "c898df04 immunized the feed" premise — misattributed.** c898df04 is
`fix(status): keep blocked delivery rows schema-valid`, touching
`orchestrator-lifecycle.ts` and `schemas/agent.ts`. It never touched the feed.

**"maya + john were tmux-hosted" — wrong.** All five bindings record
`hostKind: "sessiond"`.

## What is not proven

- **Which stall it was.** Either (a) a visibility publish hung and head-of-line
  blocked the chain, or (b) the Workspace stopped emitting inventory lines. Both
  leave the identical trace — silence, then a frozen `expiresAt`. The two 5 s
  status-poll timeouts bracketing the freeze favour (a), but the feed logs only
  errors, so a successful or in-flight publish leaves no record. **A publish
  attempt/duration log line would settle this.**
- **Why the daemon's HTTP surface stalled >5 s.** Load average was 5.04 with
  concurrent zig/bun builds in agent worktrees, but the daemon's stdout/stderr
  go to `/dev/null` and there is no request-latency instrumentation.

## Can it recur

Yes, trivially. Nothing in the path is guarded: no timeout on the renewal
request, no bound on the serialized chain, and enforcement is deliberately
fail-closed with a 15 s lease and a 4 s grace. **Any ≥15 s stall of the
daemon's `/workspace-visibility` path kills every live vendor process
fleet-wide, simultaneously, and leaves no termination audit row.**

## Recommendation

This is product-side, not an operational capacity limit. Do **not** file a
fleet-size/build-concurrency admission guard — the machine was nowhere near its
memory ceiling.

1. **Bound the renewal request.** Give `publishWorkspaceVisibility` an
   `AbortSignal` with a timeout well under the 15 s lease (the 5 s already used
   for the status poll is the natural choice), so a stalled daemon fails one
   renewal instead of wedging the chain.
2. **Stop head-of-line blocking the fleet.** A hung publish must not be able to
   block the next one. Drop-and-supersede (only the newest inventory matters) is
   the natural shape for a full-inventory publish.
3. **Distinguish "publisher stalled" from "Workspace died" before killing.** The
   Workspace PID and startToken still verified throughout; fail-closed is right
   when the Workspace is *gone*, but expiring every session because one HTTP
   request was slow is a blast radius far larger than the invariant needs.
4. **Audit VISIBILITY_EXPIRED terminations.** All five kills left
   `terminationAuditJson` NULL, which is why this incident had no durable record
   in the DB at all and had to be reconstructed from workspace.log plus a
   4-second arithmetic coincidence.

## Addendum: two recurrences confirm the mechanism (22:49Z, 22:57Z)

The fleet died twice more the same evening. Both are the **same mechanism** —
no second mechanism exists. The confirmation is stronger than the original
diagnosis: it is now **per-agent**, not merely per-cluster. Each host dies
`host_graceful_stop_bound_ms` (4.000 s) after **its own** lease deadline, and
the death order reproduces the `expiresAt` order exactly.

Agent names come from joining `terminal_host_bindings` to `agents` on the
locator subject; deaths are the `host transport lost` lines in workspace.log,
converted from local (UTC−4).

**Event 2 — 22:49Z, seven hosts:**

| agent | expiresAt (Z) | +4.000 s predicted | observed death | delta |
| --- | --- | --- | --- | --- |
| priya | 22:49:02.802 | 22:49:06.802 | 22:49:06.823 | +21 ms |
| emma | 22:49:03.485 | 22:49:07.485 | 22:49:07.499 | +14 ms |
| noah | 22:49:03.501 | 22:49:07.501 | 22:49:07.535 | +34 ms |
| james | 22:49:03.518 | 22:49:07.518 | 22:49:07.538 | +20 ms |
| omar | 22:49:03.534 | 22:49:07.534 | 22:49:07.556 | +22 ms |
| lena | 22:49:03.551 | 22:49:07.551 | 22:49:07.575 | +24 ms |
| liam | 22:49:03.569 | 22:49:07.569 | 22:49:07.589 | +20 ms |

**Event 3 — 22:57Z, five hosts:**

| agent | expiresAt (Z) | +4.000 s predicted | observed death | delta |
| --- | --- | --- | --- | --- |
| henry | 22:57:30.911 | 22:57:34.911 | 22:57:34.932 | +21 ms |
| lucas | 22:57:30.930 | 22:57:34.930 | 22:57:34.950 | +20 ms |
| ethan | 22:57:30.963 | 22:57:34.963 | 22:57:34.994 | +31 ms |
| mia | 22:57:30.981 | 22:57:34.981 | 22:57:35.002 | +21 ms |
| ava | 22:57:30.998 | 22:57:34.998 | 22:57:35.016 | +18 ms |

Every delta across both events falls in **+14 ms to +34 ms**. The supporting
signature holds each time: a `status poll timed out after 5000ms` precursor
(22:48:52.854Z before event 2), and the HTTP 409 storm starting *after* the
deaths (22:49:08.980Z and 22:57:36.512Z) — consequence, never cause.

A reported death time of 22:49:18Z or 22:57:49–51Z is the **SIGKILL tail**, not
the kill instant: the graceful terminate escalates ~11–16 s after transport
loss. Measure from `host transport lost`, not from when the pane looks dead.

### Why the recurrences happened after the fix landed

The fixes were **landed but not active**. `hive` binary
`.dev/root/versions/0.0.0/hive` has mtime **2026-07-21 17:32:15** local and the
daemon (pid 81422) started 17:32:16 and ran continuously; the fix commits are
**18:52:01** and **18:56:22** local — roughly 80 minutes *newer* than the
binary. The running daemon could not contain them, so events 2 and 3 hit
exactly the un-fixed path. Corroborating: every binding in both events still
has `terminationAuditJson` NULL, which is precisely what the pre-fix code does;
the new audit writer would have populated it.

**Landed on main is not running.** Both halves ship in the same `hive` binary
(`workspace-feed` is that binary too), so the fix requires the ordinary
clean/build/run loop before it protects anything. No Swift change is involved —
`HiveWorkspace.app` is untouched.

### Verifying the fix once it is active

After a rebuild and restart, the fix is self-verifying in the same file this
incident was reconstructed from:

- a slow publish writes `workspace visibility publish was slow: <n>ms for
  revision <r>` to workspace.log, and a hung one writes `workspace visibility
  publish timed out after 5000ms`;
- any lease genuinely allowed to expire writes a `terminationAudit` row with
  `origin: "visibility-expiry"` instead of leaving it NULL.

A fleet death showing **neither** of those, while hosts still die ~4 s after a
clustered `expiresAt`, would be a mechanism this root cause does not cover.
