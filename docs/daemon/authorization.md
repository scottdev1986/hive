# Authorization: the capability rights matrix

Updated: 2026-07-13
Sources: Hive source tree, 2026-07-13; compiled from `docs/architecture/capability-rights-matrix.md`

## Summary

The daemon can spawn processes, kill them, approve tool calls on a human's behalf, and fast-forward branches into `main` — and every agent it spawns runs as the same UID with a shell. Authorization is therefore the only boundary Hive has, and it rests on two rules: **a request body is evidence of intent, never of authority**, and **only the daemon mints** (`src/daemon/capabilities.ts:1-15`).

This document is the binding contract for `src/daemon/capabilities.ts`; if the code and this table disagree, the code is wrong. That claim only survives if the table is maintained — see [Keeping the matrix from drifting](#keeping-the-matrix-from-drifting).

## Authentication and authorization are different problems

Authentication answers "which capability is speaking" (`capabilities.ts:277-304`). Authorization answers "may that capability do this, to this subject, right now" (`capabilities.ts:306-365`). Conflating them is how control planes grow confused deputies: a caller proves it is *someone*, then names *anyone* in the request body, and the server obliges.

So the daemon does two things in order. It authenticates the bearer token and resolves it to exactly one capability record — **before it parses the body**, so a caller with no credential is turned away without the daemon ever reading what it asked for (`capabilities.ts:406-424`). Then, for every request that names a subject (`agent`, `from`, `agentName`), it compares that name against the subject bound into the capability. A mismatch is a denial (`capability.foreign-subject`), not a coercion.

The blueprint's XPC design gets this for free by omitting tenant IDs from method signatures. HTTP has no such affordance — the body is attacker-controlled and there is nowhere else to put the subject — so the daemon rejects on mismatch and audits the attempt. Same boundary, different road.

## The four roles

Four roles exist (`capabilities.ts:94-133`), and the interesting property of each is what it *cannot* do.

**Operator** — the human's `hive` CLI and the Workspace acting for them. Holds 26 of the 27 actions; the one it lacks is `channel:use`, which is an agent-bridge transport, not a control-plane right. Unrestricted subject scope, deliberately: a caller that can already spawn and kill any agent gains no new authority from also being allowed to name one, so narrowing it would cost clarity and buy nothing.

**Orchestrator** — the root agent. Spawns, approves, kills, recovers, reads the global inbox, reads autonomy. It holds **no landing right and no autonomy/routing/graphify write**, ever. This is the single most important line in the matrix: the process that decides *what work happens* must not be the process that can *put code on `main`*. An orchestrator compromised by prompt injection can waste money; it cannot merge.

**Writer** — a spawned agent with a worktree and a branch. It talks, reads its own inbox, acks its own controls, reports its own events, writes memory, and — exactly once, at the current epoch, for its own branch — lands.

**Reader** — read-only: talks and reports on itself. No `branch:land`, no `memory:write`.

The asymmetry is the design. **Neither orchestrator nor writer is a superset of the other**, so a captured credential of either kind buys a strict subset of the control plane. There is no role that both decides and merges (`capabilities.ts:93-95`).

## The 27 actions

Enumerated from `capabilities.ts:21-48`. `O` operator, `R` orchestrator, `W` writer, `r` reader.

| Action | Roles | Notes |
|---|---|---|
| `status:read` | O R W r | |
| `quota:read` | O R W r | |
| `quota:write` | O R | |
| `token-usage:read` | O R | |
| `token-usage:write` | O | |
| `agent:spawn` | O R | |
| `agent:kill` | O R | any-subject for R |
| `agent:mark-dead` | O R | any-subject for R |
| `agent:recover` | O R | any-subject for R |
| `approval:read` | O R | |
| `approval:decide` | O R | any-subject for R |
| `message:send` | O R W r | |
| `message:ack` | O R W r | **epoch-checked** |
| `message:read` | O R | orchestrator inbox only |
| `inbox:read` | O R W r | |
| `branch:land` | **O W** | **epoch-checked; one-shot for W** |
| `memory:read` | O R W r | |
| `memory:write` | O R W | blocked when `writeRevoked` |
| `event:report` | O R W r | |
| `telemetry:report` | O R W r | |
| `channel:use` | R W r | **operator does not hold it** |
| `root-token:mint` | O | the one minting carve-out |
| `autonomy:read` | O R | agents may observe the dial |
| `autonomy:write` | O | an agent raising it is a sandbox escape |
| `routing-policy:read` | O | |
| `routing-policy:write` | O | an agent rewriting the router is self-authorization |
| `graphify:write` | O | opting a repo into an indexing service is consent |

`anySubject` (`capabilities.ts:59-64`): the operator for everything it holds; the orchestrator for exactly the four agent-directed actions. Writers and readers may only ever name themselves.

## The routes and tools

Every HTTP route below `/handshake` in `server.ts:2380-2442` authenticates first. **Audit** is whether an *allow* is written to `audit_log`; denials are always audited (`capabilities.ts:426-449`).

| Route / tool | Action | Subject | Audit allow | Gate |
|---|---|---|---|---|
| `GET /health` | — public | — | — | `server.ts:2349-2375` (runs `quickCheck`) |
| `GET /handshake` | — public | — | — | `server.ts:2377-2379` |
| `POST /event` | `event:report` | self | no | `server.ts:2382-2384` |
| `POST /statusline` | `telemetry:report` | self | no | `server.ts:2385-2387` |
| `POST /channel/{register,poll,ack,permission-request}` | `channel:use` | self | register + permission-request only | `server.ts:2426-2428`, `:2474-2540` |
| `GET /autonomy` | `autonomy:read` | — | no | `server.ts:2388-2393` |
| `POST /autonomy` | `autonomy:write` | — | yes | `server.ts:2388-2393` |
| `GET /routing/policy` | `routing-policy:read` | — | no | `server.ts:2394-2399` |
| `POST /routing/policy` | `routing-policy:write` | — | yes | `server.ts:2394-2399` |
| `POST /graphify` | `graphify:write` | — | yes | `server.ts:2423-2425` |
| `GET /orchestrator-status` | `status:read` | — | no | `server.ts:2400-2402` |
| `GET /token-usage` | `token-usage:read` | — | no | `server.ts:2403-2405` |
| `POST /token-usage/**` | `token-usage:write` | — | yes | `server.ts:2406-2422` |
| `POST /recover` | `agent:recover` | any | yes | `server.ts:2429-2431` |
| `POST /agents/:name/kill` | `agent:kill` | any | yes | `server.ts:2435-2439` |
| `POST /codex-root-token` | `root-token:mint` | — | yes | `server.ts:2447-2472` |
| `hive_status`, `hive_models`, `graph_locate` | `status:read` | — | no | `server.ts:3458`, `:3564`, `:4072` |
| `hive_quota_status` | `quota:read` | — | no | `server.ts:3536` |
| `hive_quota_reconcile` | `quota:write` | — | yes | `server.ts:3577` |
| `hive_token_usage` | `token-usage:read` | — | no | `server.ts:3546` |
| `hive_spawn` | `agent:spawn` | — | yes | `server.ts:3795` |
| `hive_kill`, `hive_preserve_branch` | `agent:kill` | any | kill yes, preserve no | `server.ts:3623`, `:3519` |
| `hive_mark_dead` | `agent:mark-dead` | any | yes | `server.ts:3604` |
| `hive_recover` | `agent:recover` | any | yes | `server.ts:3594` |
| `hive_approvals` | `approval:read` | — | no | `server.ts:3850` |
| `hive_approve` | `approval:decide` | any | yes | `server.ts:3868` |
| `hive_send`, `hive_escalate` | `message:send` | self (`from` / `agent`) | no | `server.ts:3643`, `:3676` |
| `hive_inbox` | `inbox:read` | self | no | `server.ts:3764` |
| `hive_ack_message` | `message:ack` | self | yes, **epoch** | `server.ts:3748` |
| `hive_read_message` | `message:read` | — | no | `server.ts:3781` |
| `hive_land` | `branch:land` | self | yes, **epoch + once** | `server.ts:3946` |
| `memory_search`, `memory_read` | `memory:read` | — | no | `server.ts:4009`, `:4033` |
| `memory_write`, `memory_delete`, `memory_reindex` | `memory:write` | — | yes | `server.ts:4019`, `:4047`, `:4057` |

`/health` and `/handshake` are public and non-authorizing. Health proves liveness; the handshake proves *identity* (build hash, project, protocol range) so a launcher can decide whether this daemon is the right one to talk to. **Neither may ever grow a side effect** — a handshake that writes is a handshake that needs a capability, and the launcher has none by construction: it is trying to find out whether a capability would even be worth minting.

## Landing: reserve before merge

`branch:land` is the only one-shot right in the system (`capabilities.ts:116-124`). The daemon **reserves** the right before it touches git and releases it only if the merge failed (`consumeOneShot` / `releaseOneShot`, `capabilities.ts:367-383`).

Reserving up front rather than consuming afterwards is what makes two concurrent lands safe: the reservation is a primary-key insert, so the second request loses the race inside SQLite and never reaches `git merge`. Consuming *after* the merge would let both callers merge and only then discover one was a replay.

Burning the grant on a *failed* attempt — stricter, simpler, and the third alternative we rejected — would make the writer's mandatory retry loop unwinnable: a fast-forward merge legitimately fails when `main` moves under a writer, who is then required to rebase and try again. That would push agents toward merging into the primary checkout by hand, trading a narrow replay window for a much worse behavior. So: a failed land is retryable, a succeeded land is spent, a replay is denied as `capability.replayed`.

### Who re-arms a spent grant

Something must re-arm the grant, because a working agent lands more than once. That something used to be a human, every lap, and it was the most expensive thing in the system: **one orchestrator cleared nine re-arm approvals in a single session**, and the more productive the agent, the more often it stalled. Most of those approvals granted nothing — the agent had already landed, `main..branch` was empty, and a human was being spent on merging a diff that did not exist.

So the daemon now *measures the branch* first (`server.ts:1190-1246`). Three answers:

- **`nothing-to-land`** — `main..branch` is empty. Nothing to merge, so nothing to grant, so **no approval is filed at all**. A grant to merge nothing is not a right anybody needs.
- **`rearmed`** — the branch has commits the primary lacks *and* is rebased on current `main`, so the merge is a genuine fast-forward. Those are the two facts the human was being asked to eyeball, and git can state both. Audited as `capability.auto-rearm`, and bounded: `AUTO_REARM_BUDGET = 3` (`server.ts:384-385`) per agent, counted from the audit log itself.
- **`ask`** — everything else, and **every unknown**: an unreadable branch, a `null` from either measurement, a diverged branch, an exhausted budget.

`readLandReadiness` is three-valued on purpose (`src/daemon/landing.ts:225-278`): `pending` and `rebased` are `null` when git could not answer, and **null routes to ask, never to grant**. An unreadable branch is no evidence, and **no evidence must never be converted into permission** — the failure mode that once disarmed both of the guards whose entire purpose was to refuse. This is the same invariant as the absence test in [database-resilience.md](database-resilience.md).

What is deliberately *not* claimed is that the suite is green. The daemon cannot run a test suite inside a land handler, and an agent's *claim* that it is green is an act, not a state. The budget is the containment instead of a promise Hive cannot keep.

## Epoch, expiry, delegation

**Epoch** is the revocation primitive. Every agent row carries a `capabilityEpoch`; every token freezes the epoch it was minted at. Revoking authority means advancing the epoch — one integer write, no token list to walk. Because the critical-control path already advances the epoch when it revokes writes, `hive_send --priority critical` becomes, for free, a credential revocation.

Only `branch:land` and `message:ack` check it (`EPOCH_CHECKED`, `capabilities.ts:135-142`). This is a deliberate narrowing, not an oversight: epoch checks exist to stop *stale authority*, so only the actions that **commit** carry one — merging a branch, and confirming a control instruction landed. Gating reads on the epoch would fail every status poll during a rotation and buy nothing. The operator is exempt because it has no agent row (`capabilities.ts:241-245`) — the same invariant [orchestrator-status.md](orchestrator-status.md) depends on for the root.

Separately, `WRITE_ACTIONS = {branch:land, memory:write}` (`capabilities.ts:144-148`) are refused for a `writeRevoked` agent even at a current epoch.

**Expiry is absolute, not sliding.** A token dies at `expiresAt` regardless of use (default 24h, `capabilities.ts:201-202`). A sliding window was rejected because it lets a stolen credential keep itself alive forever simply by being used — exactly the credential we most want to expire.

**Delegation is not supported, and this is a feature.** No capability mints another; there is no attenuation grammar. The authority graph is exactly one level deep and can be reasoned about by reading the agents table. A macaroon-style attenuable token is strictly more expressive and was rejected because Hive has no use case for it and every delegation edge is a place for authority to escape.

**The one carve-out is `POST /codex-root-token`** (`server.ts:2447-2472`, gated `root-token:mint` at `:2459`). The operator's launcher asks the *daemon* to mint the orchestrator credential a Codex root will present, because that root has no spawn path of its own. Still daemon-minted, still one level deep, and deliberately short-lived: a 60-second TTL that covers the hand-off window and nothing more. (An earlier version of this document flatly claimed no token-exchange endpoint exists. It did not survive contact with Codex.)

## What a stolen credential buys

A token is `hv1.<capabilityId>.<secret>` (`capabilities.ts:214-225`). The daemon stores only `sha256(secret)` and compares with `timingSafeEqual` (`capabilities.ts:204-211`), so a database or WAL leak yields no usable credential. An id that exists with a wrong secret is denied `capability.unknown` — indistinguishable, to the caller, from an id that never existed.

Tokens travel by file, never by environment variable and never by argv: `$HIVE_HOME/credentials/<subject>.cap`, mode `0600`, inside a `0700` directory outside every worktree (`src/daemon/credentials.ts:29-42`), read with `O_CLOEXEC` (`:45-60`). Claude Code fetches its header through `headersHelper` rather than `${ENV_VAR}` expansion — the env-var form is documented and simpler, and was rejected because an environment variable is inherited by every descendant of the agent process, which is precisely the grandchild we are trying to starve. Codex has no headers-helper, so its token goes into a `0600` `config.toml`; `bearer_token_env_var` was rejected for the same reason.

Now the honest part. **Hive runs every agent as the user's own UID.** A same-UID process that knows the path can read the credential file, and a shell tool call inside an agent is such a process. No Unix socket, no `CLOEXEC` descriptor, and no peer check fixes that. What this design actually buys is not secrecy against a determined same-UID attacker — it is that **the credential an agent can steal is worth almost nothing**. A writer's token cannot spawn, cannot approve, cannot kill, cannot name another agent, cannot land twice, and stops working the moment its epoch rotates. The blast radius of theft is the authority the thief's own parent already had.

The adversarial tests therefore prove a precise claim: a descendant of an agent process inherits **no** credential through its environment or its file descriptors. Closing the same-UID filesystem read requires a real privilege boundary — a separate UID, a sandbox profile, or a signed-XPC peer check — and that is the known, accepted residual risk, not a defect.

## Audit

Every mutating decision appends an `audit_log` row: timestamp, route, action, caller subject and role, capability id, the subject the caller *requested*, epoch, decision, reason. Denials are audited at least as carefully as allows, because the interesting security signal is `agent maya attempted branch:land on subject zara` — a request a well-behaved agent never makes. Read-only and long-poll routes pass `auditAllow: false` so `hive_status` polls cannot bury the rows that matter. The token secret never appears in a row, a log line, or an error message.

**The audit log is load-bearing for authorization, not merely history** — `countAuditEntries` (`src/daemon/db.ts:1484`) computes the auto-re-arm budget from it. Trimming it would silently re-arm land grants the user already spent. See [database-resilience.md](database-resilience.md#what-must-never-be-auto-pruned).

## Keeping the matrix from drifting

This document declares itself binding and `capabilities.ts:1-3` declares the code must not drift from it. Between those two statements, the code grew six actions (`root-token:mint`, `autonomy:read/write`, `routing-policy:read/write`, `graphify:write`), seven routes, and four MCP tools that this table had no rows for. The contract did not fail loudly; it failed by **omission**, which is the failure mode a "binding table" is least able to detect.

So, the rule the drift itself teaches:

> **Adding a mutation route or an `Action` means adding its matrix row in the same change.** A route that reaches `main` without a row here is an unreviewed grant, and the fact that it is *gated* is not the same as the fact that anyone *agreed to the gate*.

## Open questions

The audit log shares the daemon's SQLite database, which an agent with a shell can also read and, in principle, rewrite. Making it genuinely tamper-evident — an append-only file with a hash chain, or a separate writer process — is unresolved and probably belongs with a component that has a real privilege boundary to protect it.

Capabilities are bound to a subject, not to a connection. Over HTTP there is nothing stable to bind to; XPC binds to the connection object itself and is strictly better. Whether the HTTP plane should adopt a rolling token that rotates on every use — converting credential theft from silent to loud, at the cost of a persistence race across concurrent MCP calls — is open.

## See Also

- [Database resilience](database-resilience.md) — the absence test, and why `audit_log` may never be pruned
- [Orchestrator status](orchestrator-status.md) — `status:read`, and the no-agents-row invariant
- [Routing policy](../routing/routing-policy.md) — what `routing-policy:write` consents to
- [Graphify integration](../graphify/integration.md) — what `graphify:write` consents to
- [SPEC](../../SPEC.md) — the agent model these roles are cut from
