# Authorization: the capability rights matrix

Updated: 2026-07-15
Source: Hive source tree, 2026-07-15

## Summary

The daemon can spawn processes, kill them, approve tool calls on a human's behalf, and fast-forward branches into `main` — and every agent it spawns runs as the same UID with a shell. Authorization is therefore the only boundary Hive has, and it rests on two rules: **a request body is evidence of intent, never of authority**, and **only the daemon mints** (`src/daemon/capabilities.ts:1-15`).

This document is the binding contract for `src/daemon/capabilities.ts`; if the code and this table disagree, the code is wrong. That claim only survives if the table is maintained — see [Keeping the matrix from drifting](#keeping-the-matrix-from-drifting).

## Authentication and authorization are different problems

Authentication answers "which capability is speaking" (`src/daemon/capabilities.ts:277-304`). Authorization answers "may that capability do this, to this subject, right now" (`src/daemon/capabilities.ts:306-365`). Conflating them is how control planes grow confused deputies: a caller proves it is *someone*, then names *anyone* in the request body, and the server obliges.

So the daemon does two things in order. It authenticates the bearer token and resolves it to exactly one capability record — **before it parses the body**, so a caller with no credential is turned away without the daemon ever reading what it asked for (`src/daemon/capabilities.ts:406-424`). Then, for every request that names a subject (`agent`, `from`, `agentName`), it compares that name against the subject bound into the capability. A mismatch is a denial (`capability.foreign-subject`), not a coercion.

The blueprint's XPC design gets this for free by omitting tenant IDs from method signatures. HTTP has no such affordance — the body is attacker-controlled and there is nowhere else to put the subject — so the daemon rejects on mismatch and audits the attempt. Same boundary, different road.

## The four roles

Four roles exist (`src/daemon/capabilities.ts:97-136`), and the interesting property of each is what it *cannot* do.

**Operator** — the human's `hive` CLI and the Workspace acting for them. Holds every action. Its subject scope is unrestricted, deliberately: a caller that can already spawn and kill any agent gains no new authority from also being allowed to name one, so narrowing it would cost clarity and buy nothing.

**Orchestrator** — the root agent, named queen. Prefer queen when addressing or referring to it; the role name orchestrator remains correct, and old/`orchestrator` addressing is still understood. Spawns, approves, kills, recovers, reads the global inbox, and reads autonomy. It holds **no landing right and no autonomy/routing/graphify write**, ever. This is the single most important line in the matrix: the process that decides *what work happens* must not be the process that can *put code on `main`*. An orchestrator compromised by prompt injection can waste money; it cannot merge. Naming does not change this matrix.

**Writer** — a spawned agent with a worktree and a branch. It talks, reads its own inbox, acks its own controls, reports its own events, writes memory, and — exactly once, at the current epoch, for its own branch — lands.

**Reader** — read-only: talks and reports on itself. No `branch:land`, no `memory:write`.

The asymmetry is the design. **No role is a superset of another that both decides and merges** — orchestrator and writer are disjoint. A captured credential of any kind buys a strict subset of the control plane (`src/daemon/capabilities.ts:97-100`).

## The 26 actions

Enumerated from `src/daemon/capabilities.ts:25-51`. `O` operator, `R` orchestrator, `W` writer, `r` reader.

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
| `message:read` | O R | queen (orchestrator) inbox only |
| `inbox:read` | O R W r | |
| `branch:land` | **O W** | **epoch-checked; one-shot for W** |
| `memory:read` | O R W r | |
| `memory:write` | O R W | blocked when `writeRevoked` |
| `event:report` | O R W r | |
| `telemetry:report` | O R W r | |
| `root-token:mint` | O | the one minting carve-out |
| `autonomy:read` | O R | agents may observe the dial |
| `autonomy:write` | O | an agent raising it is a sandbox escape |
| `routing-policy:read` | O | |
| `routing-policy:write` | O | an agent rewriting the router is self-authorization |
| `workspace-visibility:write` | O | only the credential-holding Workspace feed may attest UI inventory |
| `graphify:write` | O | opting a repo into an indexing service is consent |

`anySubject` (`src/daemon/capabilities.ts:62-67`): the operator for everything it holds; the orchestrator for exactly the four agent-directed actions. Writers and readers may only ever name themselves.

### `codex:mutate` — the one action no capability can buy

There is a 27th authorized action, and it is deliberately **not** a row in the table above, because the table is enumerated from `Action` in `src/daemon/capabilities.ts` and this one is not an `Action`. It is worth a row of its own precisely because the drift rule below would otherwise let it land unreviewed.

| Action | Roles | Notes |
|---|---|---|
| `codex:mutate` | **nobody** | not capability-authorized; no token grants it; decided per-mutation by `HiveDaemon.authorizeCodexMutation` |

Every other action is authorized by a bearer presenting a capability for a subject. A Codex writer's mutation cannot work that way: the request does not arrive over HTTP with a token, it arrives as a JSON-RPC request on the agent's own app-server socket, from the process being authorized. A credential proves *who is speaking*; here the question is *what is running right now*, which no credential can answer.

So the decision is made by the daemon against state the caller cannot forge:

- **The holder row, re-read by id** — not by name, because names are reusable and a replacement answering to `maya` is not `maya`. The session's `processIncarnation` and `capabilityEpoch` must still be the row's current ones, and the row must be a live, non-terminal, non-`writeRevoked` writer.
- **The provider's own applied identity**, read from the rollout the app-server names for that thread, for the exact `turn_id` the provider itself put on the approval request, and compared to the immutable launch identity. `unattested`, `unknown`, and `drift` are each a denial. Absent is not "fine"; it is "we could not tell", which is the same answer.
- **Twice.** Once before the approval is queued, and again immediately before the allow response is sent, because a human approval holds a window open and an identity can drift inside it.

What a stolen credential buys here is nothing: there is no capability to steal, and `writeRevoked` on the row denies the next mutation regardless of what any token says. What tampering with the worktree's `.codex/` hooks or config buys is also nothing — no part of this decision reads them. That is the whole reason a Codex writer is admissible on the app-server driver and never on the TUI, whose guard *is* those tamperable bytes (see [launch-mechanics](../providers/launch-mechanics.md)).

Two protocol facts constrain the shape of the grant, both verified against the installed codex-cli 0.144.4:

- **The grant is one request, never a permission.** `PermissionGrantScope` is exactly `["turn","session"]`, so `item/permissions/requestApproval` can only ever grant something that outlives the identity check that authorized it. It is therefore never granted — always answered with an empty profile. One-shot lives on the `fileChange`/`commandExecution` decision enums instead, where `accept` decides exactly one request; `acceptForSession` is never sent.
- **`execCommandApproval` and `applyPatchApproval` are refused.** Their params carry `conversationId` and `callId` but no `turnId`, so a decision on them cannot be bound to the turn whose identity was attested. Unbindable is unknown.

`branch:land` for a Codex writer is gated by this same decision, bound to the live turn whose tool call is asking to land. It is re-attested **inside the merge-boundary callback** rather than before `land()`: the landing lease waits up to 30s, and diagnosis and collision cleanup run after it, so an identity read before all that describes a process that *was*. A holder-row CAS at that boundary cannot stand in for it — a row CAS cannot see a model that drifted.

#### The sandbox is not the only way out, so the gate is not only in the broker

An MCP tool call leaves the Codex sandbox entirely: it is not a sandboxed exec, so no approval request is brokered for it, and it arrives here as an ordinary authorized HTTP request. Hive's own MCP server is attached to every Codex session, and `memory:write` is in the writer role's action set and mutates real files under `<repo>/.hive/memory` and `~/.hive/memory`. So `memory_write`, `memory_delete`, and `memory_reindex` route through the same `codex:mutate` decision when the calling credential belongs to a Codex writer. The rule generalizes: **any daemon-side tool that writes the filesystem and is reachable by a writer credential needs this gate**, because "the sandbox contains it" is only true of things that run in the sandbox.

Two related exposures are deliberately *not* closed here, and both are pre-existing and vendor-agnostic rather than anything Codex writers introduce. `listInheritedCodexMcpServers` returns an empty list when the user's `~/.codex/config.toml` is missing or unreadable, and `buildCodexMcpExclusionArgs` leaves servers whose names `-c` cannot address attached. Both mean "unreadable local config ⇒ attach by default", which is the wrong default for a writer: an inherited third-party MCP server is an unbrokered mutation path exactly like Hive's own would be without the gate above. Closing it means failing the spawn closed on an unreadable inventory. It is a local-config concern, tracked separately, and it is a real gap — not one this document is claiming is covered.

## The routes and tools

Every HTTP route below `/handshake` in `src/daemon/server.ts:2349-2411` authenticates first. **Audit** is whether an *allow* is written to `audit_log`; denials are always audited (`src/daemon/capabilities.ts:426-449`).

| Route / tool | Action | Subject | Audit allow | Gate |
|---|---|---|---|---|
| `GET /health` | — public | — | — | `src/daemon/server.ts:2315-2345` (runs `quickCheck`) |
| `GET /handshake` | — public | — | — | `src/daemon/server.ts:2346-2348` |
| `POST /event` | `event:report` | self | no | `src/daemon/server.ts:2351-2353` |
| `POST /statusline` | `telemetry:report` | self | no | `src/daemon/server.ts:2354-2356` |
| `GET /autonomy` | `autonomy:read` | — | no | `src/daemon/server.ts:2357-2362` |
| `POST /autonomy` | `autonomy:write` | — | yes | `src/daemon/server.ts:2357-2362` |
| `GET /routing/policy` | `routing-policy:read` | — | no | `src/daemon/server.ts:2363-2368` |
| `POST /routing/policy` | `routing-policy:write` | — | yes | `src/daemon/server.ts:2363-2368` |
| `POST /workspace-visibility` | `workspace-visibility:write` | — | yes | `src/daemon/server.ts:2800-2849` |
| `POST /graphify` | `graphify:write` | — | yes | `src/daemon/server.ts:2392-2394` |
| `GET /orchestrator-status` | `status:read` | — | no | `src/daemon/server.ts:2369-2371` |
| `GET /token-usage` | `token-usage:read` | — | no | `src/daemon/server.ts:2372-2374` |
| `POST /token-usage/**` | `token-usage:write` | — | yes | `src/daemon/server.ts:2375-2390` |
| `POST /recover` | `agent:recover` | any | yes | `src/daemon/server.ts:2398-2400` |
| `POST /agents/:name/kill` | `agent:kill` | any | yes | `src/daemon/server.ts:3156-3217` |
| `POST /codex-root-token` | `root-token:mint` | — | yes | `src/daemon/server.ts:2401-2403`, `:2416-2441` |
| `hive_status`, `hive_models`, `graph_locate` | `status:read` | — | no | `src/daemon/server.ts:3427-3433`, `:3533-3539`, `:4044-4054` |
| `hive_quota_status` | `quota:read` | — | no | `src/daemon/server.ts:3505-3512` |
| `hive_quota_reconcile` | `quota:write` | — | yes | `src/daemon/server.ts:3546-3553` |
| `hive_token_usage` | `token-usage:read` | — | no | `src/daemon/server.ts:3515-3525` |
| `hive_spawn` | `agent:spawn` | — | yes | `src/daemon/server.ts:3764-3785` |
| `hive_kill`, `hive_preserve_branch` | `agent:kill` | any | kill yes, preserve no | `src/daemon/server.ts:3592-3599`, `:3488-3494` |
| `hive_mark_dead` | `agent:mark-dead` | any | yes | `src/daemon/server.ts:3573-3579` |
| `hive_recover` | `agent:recover` | any | yes | `src/daemon/server.ts:3563-3569` |
| `hive_approvals` | `approval:read` | — | no | `src/daemon/server.ts:3822-3833` |
| `hive_approve` | `approval:decide` | any | yes | `src/daemon/server.ts:3840-3850` |
| `hive_send`, `hive_escalate` | `message:send` | self (`from` / `agent`) | no | `src/daemon/server.ts:3612-3620`, `:3645-3659` |
| `hive_inbox` | `inbox:read` | self | no | `src/daemon/server.ts:3733-3743` |
| `hive_ack_message` | `message:ack` | self | yes, **epoch** | `src/daemon/server.ts:3717-3724` |
| `hive_read_message` | `message:read` | — | no | `src/daemon/server.ts:3750-3757` |
| `hive_land` | `branch:land` | self | yes, **epoch + once** | `src/daemon/server.ts:3918-3927` |
| `memory_search`, `memory_read` | `memory:read` | — | no | `src/daemon/server.ts:3981-3988`, `:4005-4012` |
| `memory_write`, `memory_delete`, `memory_reindex` | `memory:write` | — | yes | `src/daemon/server.ts:3991-3998`, `:4019-4026`, `:4029-4036` |

`/health` and `/handshake` are public and non-authorizing. Health proves liveness; the handshake proves *identity* (build hash, project, protocol range) so a launcher can decide whether this daemon is the right one to talk to. **Neither may ever grow a side effect** — a handshake that writes is a handshake that needs a capability, and the launcher has none by construction: it is trying to find out whether a capability would even be worth minting.

## Landing: reserve before merge

`branch:land` is the only one-shot right in the system (`src/daemon/capabilities.ts:116-124`). The daemon **reserves** the right before it touches git and releases it only if the merge failed (`consumeOneShot` / `releaseOneShot`, `src/daemon/capabilities.ts:367-383`).

Reserving up front rather than consuming afterwards is what makes two concurrent lands safe: the reservation is a primary-key insert, so the second request loses the race inside SQLite and never reaches `git merge`. Consuming *after* the merge would let both callers merge and only then discover one was a replay.

Burning the grant on a *failed* attempt — stricter, simpler, and the third alternative we rejected — would make the writer's mandatory retry loop unwinnable: a fast-forward merge legitimately fails when `main` moves under a writer, who is then required to rebase and try again. That would push agents toward merging into the primary checkout by hand, trading a narrow replay window for a much worse behavior. So: a failed land is retryable, a succeeded land is spent, a replay is denied as `capability.replayed`.

### Who re-arms a spent grant

Something must re-arm the grant, because a working agent lands more than once. That something used to be a human, every lap, and it was the most expensive thing in the system: **one orchestrator cleared nine re-arm approvals in a single session**, and the more productive the agent, the more often it stalled. Most of those approvals granted nothing — the agent had already landed, `main..branch` was empty, and a human was being spent on merging a diff that did not exist.

So the daemon now *measures the branch* first (`src/daemon/server.ts:1246-1300`). Three answers:

- **`nothing-to-land`** — `main..branch` is empty. Nothing to merge, so nothing to grant, so **no approval is filed at all**. A grant to merge nothing is not a right anybody needs.
- **`rearmed`** — the branch has commits the primary lacks *and* is rebased on current `main`, so the merge is a genuine fast-forward. Those are the two facts the human was being asked to eyeball, and git can state both. Audited as `capability.auto-rearm`, and bounded: `AUTO_REARM_BUDGET = 3` (`src/daemon/server.ts:399-404`) per agent, counted from the audit log itself.
- **`ask`** — everything else, and **every unknown**: an unreadable branch, a `null` from either measurement, a diverged branch, an exhausted budget.

`readLandReadiness` is three-valued on purpose (`src/daemon/landing.ts:225-278`): `pending` and `rebased` are `null` when git could not answer, and **null routes to ask, never to grant**. An unreadable branch is no evidence, and **no evidence must never be converted into permission** — the failure mode that once disarmed both of the guards whose entire purpose was to refuse. This is the same invariant as the absence test in [database-resilience.md](database-resilience.md).

What is deliberately *not* claimed is that the suite is green. The daemon cannot run a test suite inside a land handler, and an agent's *claim* that it is green is an act, not a state. The budget is the containment instead of a promise Hive cannot keep.

## Epoch, expiry, delegation

**Epoch** is the revocation primitive. Every agent row carries a `capabilityEpoch`; every token freezes the epoch it was minted at. Revoking authority means advancing the epoch — one integer write, no token list to walk. Because the critical-control path already advances the epoch when it revokes writes, `hive_send --priority critical` becomes, for free, a credential revocation.

Only `branch:land` and `message:ack` check it (`EPOCH_CHECKED`, `src/daemon/capabilities.ts:135-142`). This is a deliberate narrowing, not an oversight: epoch checks exist to stop *stale authority*, so only the actions that **commit** carry one — merging a branch, and confirming a control instruction landed. Gating reads on the epoch would fail every status poll during a rotation and buy nothing. The operator is exempt because it has no agent row (`src/daemon/credentials.ts:26-27`, `src/daemon/capabilities.ts:329-345`) — the same invariant [orchestrator-status.md](orchestrator-status.md) depends on for the root.

Separately, `WRITE_ACTIONS = {branch:land, memory:write}` (`src/daemon/capabilities.ts:144-148`) are refused for a `writeRevoked` agent even at a current epoch.

**Expiry is absolute, not sliding.** A token dies at `expiresAt` regardless of use (default 24h, `src/daemon/capabilities.ts:201-202`). A sliding window was rejected because it lets a stolen credential keep itself alive forever simply by being used — exactly the credential we most want to expire.

**Delegation is not supported, and this is a feature.** No capability mints another; there is no attenuation grammar. The authority graph is exactly one level deep and can be reasoned about by reading the agents table. A macaroon-style attenuable token is strictly more expressive and was rejected because Hive has no use case for it and every delegation edge is a place for authority to escape.

**The one carve-out is `POST /codex-root-token`** (`src/daemon/server.ts:2401-2403`, handler at `:2416-2441`). The operator's launcher asks the *daemon* to mint the orchestrator credential a Codex root will present, because that root has no spawn path of its own. Still daemon-minted, still one level deep, and deliberately short-lived: a 60-second TTL that covers the hand-off window and nothing more. (An earlier version of this document flatly claimed no token-exchange endpoint exists. It did not survive contact with Codex.)

## What a stolen credential buys

A token is `hv1.<capabilityId>.<secret>` (`src/daemon/capabilities.ts:214-225`). The daemon stores only `sha256(secret)` and compares with `timingSafeEqual` (`src/daemon/capabilities.ts:204-211`), so a database or WAL leak yields no usable credential. An id that exists with a wrong secret is denied `capability.unknown` — indistinguishable, to the caller, from an id that never existed.

Tokens travel by file, never by environment variable and never by argv: `$HIVE_HOME/credentials/<subject>.cap`, mode `0600`, inside a `0700` directory outside every worktree (`src/daemon/credentials.ts:29-42`), read with `O_CLOEXEC` (`:45-60`). Claude Code fetches its header through `headersHelper` rather than `${ENV_VAR}` expansion — the env-var form is documented and simpler, and was rejected because an environment variable is inherited by every descendant of the agent process, which is precisely the grandchild we are trying to starve. Codex has no headers-helper, so its token goes into a `0600` `config.toml`; `bearer_token_env_var` was rejected for the same reason.

Now the honest part. **Hive runs every agent as the user's own UID.** A same-UID process that knows the path can read the credential file, and a shell tool call inside an agent is such a process. No Unix socket, no `CLOEXEC` descriptor, and no peer check fixes that. What this design actually buys is not secrecy against a determined same-UID attacker — it is that **the credential an agent can steal is worth almost nothing**. A writer's token cannot spawn, cannot approve, cannot kill, cannot name another agent, cannot land twice, and stops working the moment its epoch rotates. The blast radius of theft is the authority the thief's own parent already had.

The adversarial tests therefore prove a precise claim: a descendant of an agent process inherits **no** credential through its environment or its file descriptors. Closing the same-UID filesystem read requires a real privilege boundary — a separate UID, a sandbox profile, or a signed-XPC peer check — and that is the known, accepted residual risk, not a defect.

## Audit

Every mutating decision appends an `audit_log` row: timestamp, route, action, caller subject and role, capability id, the subject the caller *requested*, epoch, decision, reason. Denials are audited at least as carefully as allows, because the interesting security signal is `agent maya attempted branch:land on subject zara` — a request a well-behaved agent never makes. Read-only and long-poll routes pass `auditAllow: false` so `hive_status` polls cannot bury the rows that matter. The token secret never appears in a row, a log line, or an error message.

**The audit log is load-bearing for authorization, not merely history** — `countAuditEntries` (`src/daemon/db.ts:1484`) computes the auto-re-arm budget from it. Trimming it would silently re-arm land grants the user already spent. See [database-resilience.md](database-resilience.md#what-must-never-be-auto-pruned).

## Keeping the matrix from drifting

This document declares itself binding and `src/daemon/capabilities.ts:1-3` declares the code must not drift from it. Between those two statements, the code grew six actions (`root-token:mint`, `autonomy:read/write`, `routing-policy:read/write`, `graphify:write`), seven routes, and four MCP tools that this table had no rows for. The contract did not fail loudly; it failed by **omission**, which is the failure mode a "binding table" is least able to detect.

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
