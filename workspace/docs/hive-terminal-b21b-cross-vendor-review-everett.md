# M1-B2.1b cross-vendor review — authoritative sessiond teardown (close/quit/kill)

**Verdict: PASS — land-authorized at pin `384f2ac5`.**

| | |
|---|---|
| Pin reviewed | `384f2ac5` "feat: complete exact terminal close and quit lifecycle" |
| Author | elaine (Codex) |
| Reviewer | everett (Claude) — cross-vendor, build-capable |
| Materialization | detached checkout at the pin; HEAD never moved; working tree left clean |
| Mutations | applied only in a scratch APFS clone, never in the pin worktree |

This closes the teardown gate B2.1a explicitly deferred. Every property below was held
to an executed positive control, not to inspection.

## 1. Locator-fenced kill — PASS

`killEndpoint` (`src/daemon/server.ts:3176-3208`) parses a strict
`{ sessionLocator }` body, and compares it against the current record with
`sameSessionLocator` (`src/daemon/session-host/locators.ts:7-24`, extracted from the
adapter's private copy so one comparison serves both) before any teardown.

- Stale generation → `409 { state: "rejected", reason: "session-locator-mismatch" }`.
- Absent/malformed body → `400 invalid-session-locator`. There is no name-only fall-through.

**Positive control A — the fence bites.** Replacing the mismatch condition with `false`
turns the stale request into `200`:

```
Expected: 409   Received: 200
(fail) agent kill rejects a stale locator without killing the current generation
```

**Positive control B — "kills NOTHING" is itself asserted, not assumed.** Control A fails
at the status assertion before reaching the kill assertions, so I ran a second mutation
that performs `killAgentTeardown` and *then* returns the 409. The nothing-dies assertion
is live and bites:

```
- []
+ [ "hive-maya" ]
(fail) agent kill rejects a stale locator without killing the current generation
```

The exact-locator positive control in the same committed test kills the current
generation (`200`, `tmux.killed == ["hive-maya"]`, status `dead`).

`hive_kill` (MCP) still takes a bare name, and that is correct: it resolves the agent
record and tears down *that record's current* locator, so it cannot address a wrong
generation. The fence exists for the Workspace, which holds a pane locator that can go
stale — a UI can be wrong about the generation; an MCP caller naming an agent cannot.

## 2. `hive stop` sessiond teardown — PASS

`stopHive` (`src/cli/control.ts:459-534`) partitions persisted records by
`sessionLocator.hostKind`, attempts **every** sessiond teardown through the still-live
authenticated daemon via `Promise.allSettled`, aggregates failures, and throws before
`process.kill(pid, "SIGTERM")` is reached. Ordering is asserted directly by the committed
test (`["sessiond:maya", "SIGTERM", "session:…"]`).

Absence is a real readback, not inference. `stopSessiondAgentSession`
(`src/daemon/teardown.ts:312-360`) captures the tree from the inspected host root
*before* terminating, requires the adapter's `terminated` + zero-survivor result, then
re-reads with `reapCapturedTree` — which parses a live `ps` state table, treats zombies
as dead, and **refuses if its own verification pid is missing from the table**
(`teardown.ts:171-175`). `captureProcessTree` walks full descendants before the kill
precisely because a reparented `nohup`ed child can never be attributed afterward, so the
provider tree is captured, not just the host root.

**Positive control C — a survivor/failure blocks quit.** Neutralizing the
`sessiondFailures` throw lets shutdown proceed to SIGTERM:

```
Expected pattern: /sessiond teardown was not verified: maya: tree still present/
Received message: "daemon pid 4242 did not stop (liveness: live)"
(fail) attempts every sessiond teardown and refuses daemon shutdown on failure
```

At the pin the guard fires first and `signalled` stays `false`. Survivors reach it
through `killAgentCli`, which throws on any non-empty `reaped.survivors`
(`control.ts:262-271`) — a survivor is never reported as success.

**Clean path, live.** The native gate (`native/sessiond/test/ts-live-create.ts`) drives
the production `stopHive` against a real host/provider pair and proves exact absence by
PID **and OS start token** (`waitForExactProcessAbsence`), with `stoppedSurvivors == []`
re-asserted *inside* the `kill` callback so the ordering claim is measured, not narrated.

## 3. AppKit `terminateLater` — PASS

`applicationShouldTerminate` returns `.terminateLater`, is re-entrant-safe via
`terminationPending`, and replies `true` only after `hive stop` exits 0. The old 5s
`stopDeadline` — which let a quit succeed over a pending teardown — is deleted.

**Positive control D — quit does not succeed on failure.** Flipping the failure branch to
`replyToApplicationTermination(true)`:

```
XCTAssertEqual failed: ("[true]") is not equal to ("[false]")
(fail) testTerminationFailureCancelsQuitAndSurfacesReason
```

On failure the pin replies `false` and presents the *actual* stop diagnostic (stderr is
piped and surfaced), so the failure stays visible.

## 4. Feed — malformed present locator fails immediately (evan #3) — PASS

`AgentSnapshot` now decodes `sessionLocator` with `try` rather than `try?`, and `FeedLine`
converts the throw into an immediate `workspace-feed agent schema error:` which
`AppDelegate` routes to a critical alert. The `LossyAgentSnapshot` shim is gone.

**Positive control E — restoring `try?` reproduces the exact reported defect:**

```
XCTAssertNil failed: "[AgentSnapshot(… name: "worker", status: "unknown", sessionLocator: nil)]"
(fail) testMalformedPresentSessionLocatorSurfacesAsFeedContractError
(fail) testFeedWireSurfacesMalformedPresentLocatorImmediately   [3 failures]
```

That `sessionLocator: nil` on an otherwise-accepted agent is precisely the silent drop
that used to surface 10s later as a misleading "never became visible". Both the wire test
(real `FeedClient` subprocess) and the unit test bite.

## 5. Two-live-source exclusivity (evan #1) — PASS, and now reachable

The committed control gives `observeProcess` **two distinct live PID/start-token
identities**, so the prior source is live and the `source-identity-mismatch` branch is
genuinely reachable — the defect in the earlier fixture, whose single-source cardinality
made the branch unreachable while the suite stayed green.

**Positive control F — the branch bites.** Replacing `if (this.sourceIsLive(prior.source))`
with `if (false)` flips the rejection to `{ state: "accepted" }` and fails the test.

## 6. Restored teardown assertions (evan #2) — PASS

`stopSpawnedSession` survivors `[]` and the DB `terminationAudit` exact reason
(`stop agent <id>`) are both restored in the live gate as B2.1b's authoritative
close/quit proof, alongside exact-identity absence for host and provider.

## 7. 15s lease is the crash backstop only — CONFIRMED

The ordinary close path (`killEndpoint → killAgentTeardown → stopSessiondAgentSession →
terminate{mode:"immediate"}`) has no lease dependency. The lease appears only in the
publisher-death arm of the live gate, which kills the Workspace publisher and proves
bounded expiry on an independently created second generation.

## 8. Docs (evan #4/#5) — PASS

`docs/daemon/authorization.md` now carries exact line ranges. Verified against source at
the pin: `server.ts:2800` is `workspaceVisibilityEndpoint`'s opening line and `:2849` its
close; `server.ts:3156` is `killEndpoint`'s opening line and `:3217` its close. The story
records the a/b split, B2.1b's own row, and B2.2's dependency on both halves.

## 9. Suites — all green, independently reproduced

| Gate | Result |
|---|---|
| Bun | **1724 pass / 10 skip / 0 fail** across 1734 tests, 133 files — matches the claim exactly |
| `tsc --noEmit` | exit 0 |
| Native sessiond (`bun run test:sessiond`) | exit 0; live gate **52 expect() calls** — matches the claim |
| Swift (`swift test`) | 367 tests, 1 skipped, **0 failures** |
| Qualifier, arm64 + x86_64 | exit 0 |
| Renderer suppression | `answered_when_enabled_count=7`, `vacuous_count=0` on **both** arches |
| Committed evidence hashes | **48/48** verify |

My regenerated qualifier evidence matches the committed artifacts byte-for-byte —
`arm64/x86_64-public-api.txt`, `c-zig-abi-symbol-lock.txt`, `library-architectures.txt`,
`artifact-lock-match.txt`, `architecture-bound-engine-ids.txt`. The only two files that
differ do so exactly where they must: `*-protocol.jsonl` in the recorded `pid`, and
`loaded-artifact-sha256.txt` in the path prefix (both sha256 values identical). Per-arch
`engineBuildId` reproduced exactly (`de9688e2…` arm64, `4eb4c9f6…` x86_64), and the arm64
id matches the `SWIFT_ABI_OK build_id` from my own Swift run.

## Residuals — non-blocking, for B2.2

1. **`hive stop` against a non-live daemon skips sessiond teardown and exits 0.** The
   sessiond block sits inside `daemonWasLive`, which is right — there is no authenticated
   route once the broker is gone — and the 15s lease backstop covers exactly this case,
   proven live by the publisher-death arm. Worth naming explicitly in B2.2 so nobody
   later reads that exit 0 as "trees verified absent".

2. **Asymmetric vacuity when `hostPid` is null.** `SessionInspection.hostPid` is
   `number | null`; when null, `captureProcessTree([])` short-circuits and
   `reapCapturedTree` returns `{killed: [], survivors: []}` with no `ps` readback at all.
   The tmux sibling refuses this case loudly ("Process-root probe returned no panes for
   live tmux session"); the sessiond path does not. This is not a hole at the pin — the
   remaining authority is the *stronger* belt: the native `terminationFromTree` derives
   survivors from per-member fate with exact start tokens plus a waitpid-class
   direct-child reap measurement. But the TS second belt goes silently vacuous rather
   than refusing, and that asymmetry is the shape a future regression would hide in.

Neither residual blocks. **PASS at `384f2ac5`** — elaine lands, then B2.2.
