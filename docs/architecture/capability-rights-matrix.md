# The Hive capability rights matrix

Hive's daemon is the only thing standing between an agent and the rest of the machine. It can spawn processes, kill them, approve tool calls on a human's behalf, and fast-forward branches into `main`. Until Phase 0 it did all of that for anyone who could open a TCP connection to `127.0.0.1:4483`, which on a shared-UID laptop means every process the user runs — including the coding agents Hive itself spawns, each of which has a shell.

This document is the authorization contract. It says, for every route the daemon exposes, who may call it, on whose behalf, under what freshness constraint, for how long, whether the right can be handed onward, and what evidence the daemon leaves behind. It is the binding reference for the implementation in `src/daemon/capabilities.ts`; if the code and this table disagree, the code is wrong.

## Authentication and authorization are different problems

Authentication answers "which capability is speaking." Authorization answers "may that capability do this, to this subject, right now." Conflating them is how control planes grow confused deputies: a caller proves it is *someone*, then names *anyone* in the request body, and the server obliges.

So the daemon does two things in order. First it authenticates the bearer token on the request and resolves it to exactly one capability record. Then, for every request that names a subject — `agent`, `from`, `agentName` — it compares that name against the subject bound into the capability. A mismatch is a denial, not a coercion. An agent cannot act on another agent by typing its name, because the name in the body never grants anything; the capability does.

The blueprint's XPC design gets this for free by omitting tenant IDs from method signatures. HTTP has no such affordance — the body is attacker-controlled and there is nowhere else to put the subject — so the daemon rejects on mismatch and audits the attempt. That is the same boundary reached by a different road, and it is worth stating plainly: **a request body is evidence of intent, never of authority.**

## Roles

Four roles exist, and the interesting property is what each one *cannot* do.

**Operator** is the human's `hive` CLI. It manages the control plane — viewers, terminals, recovery, quota — and it may act on any agent. It is the only role with an unrestricted subject scope, and it is minted once per daemon into a `0600` file that no agent process is ever told about. Narrowing its subject scope was considered and rejected: a caller that can already spawn and kill any agent gains no new authority from also being allowed to name one, so the restriction would cost clarity and buy nothing.

**Orchestrator** is the root agent. It spawns, approves, kills, recovers, and reads the global inbox. It holds no write right and no landing right, ever. This is the single most important line in the matrix: the process that decides *what work happens* must not be the process that can *put code on `main`*. An orchestrator compromised by a prompt injection can waste money; it cannot merge.

**Writer** is a spawned agent with a worktree and a branch. It may talk, read its own inbox, acknowledge its own controls, report its own events, and — exactly once, at the current epoch, for its own branch — land. Everything else is denied. A writer cannot spawn, cannot approve, cannot kill, cannot read another agent's inbox, and cannot land a branch it does not own.

**Reader** is a read-only agent: it talks and reports on itself, and nothing more.

The asymmetry between orchestrator and writer is deliberate. Neither role is a superset of the other, so a captured credential of either kind buys a strict subset of the control plane. There is no role that both decides and merges.

## The matrix

`caller` is the role the capability carries. `subject` is who the action may name: **self** means the request's subject field must equal the capability's bound subject; **any** means the role may name any agent. The operator is exempt from every **self** constraint, and the orchestrator is exempt for the agent-directed actions it holds. `epoch` marks routes that additionally require the named agent's `capabilityEpoch` to equal the epoch frozen into the token at mint; the operator, which has no agent row, is exempt. `once` marks a one-shot right, held only by writers and consumed on the first successful use.

| Route / tool | Action | Caller | Subject | Epoch | Audit event |
|---|---|---|---|---|---|
| `GET /health` | — | public | — | — | none |
| `GET /handshake` | — | public | — | — | none |
| `POST /event` | `event:report` | writer, reader, orchestrator, operator | self | — | `event.report` |
| `POST /statusline` | `telemetry:report` | writer, reader, orchestrator, operator | self | — | `telemetry.report` |
| `POST /channel/register` | `channel:use` | writer, reader, orchestrator | self | — | `channel.register` |
| `POST /channel/poll` | `channel:use` | writer, reader, orchestrator | self | — | — |
| `POST /channel/ack` | `channel:use` | writer, reader, orchestrator | self | — | — |
| `POST /channel/permission-request` | `channel:use` | writer, reader, orchestrator | self | — | `channel.permission-request` |
| `POST /viewer` | `viewer:attach` | operator | any | — | `viewer.attach` |
| `POST,DELETE /orchestrator-terminal` | `terminal:register` | operator | — | — | `terminal.register` |
| `POST /recover` | `agent:recover` | operator, orchestrator | any | — | `agent.recover` |
| `hive_status` | `status:read` | all | — | — | — |
| `hive_quota_status` | `quota:read` | all | — | — | — |
| `hive_quota_reconcile` | `quota:write` | operator, orchestrator | — | — | `quota.reconcile` |
| `hive_token_usage`, `GET /token-usage` | `token-usage:read` | operator, orchestrator | — | — | — |
| `POST /token-usage/sessions/**` | `token-usage:write` | operator | — | — | `token-usage.write` |
| `POST /token-usage/subjects/**` | `token-usage:write` | operator | — | — | `token-usage.write` |
| `hive_spawn` | `agent:spawn` | operator, orchestrator | — | — | `agent.spawn` |
| `hive_kill` | `agent:kill` | operator, orchestrator | any | — | `agent.kill` |
| `hive_mark_dead` | `agent:mark-dead` | operator, orchestrator | any | — | `agent.mark-dead` |
| `hive_recover` | `agent:recover` | operator, orchestrator | any | — | `agent.recover` |
| `hive_approvals` | `approval:read` | operator, orchestrator | — | — | — |
| `hive_approve` | `approval:decide` | operator, orchestrator | any | — | `approval.decide` |
| `hive_send` | `message:send` | all | self (`from`) | — | — |
| `hive_inbox` | `inbox:read` | all | self | — | — |
| `hive_ack_message` | `message:ack` | all | self | yes | `message.ack` |
| `hive_read_message` | `message:read` | operator, orchestrator | — | — | — |
| `hive_land` | `branch:land` | **writer, operator** | self | **yes, once** | `branch.land` |
| `memory_search`, `memory_read` | `memory:read` | all | — | — | — |
| `memory_write`, `memory_delete`, `memory_reindex` | `memory:write` | operator, orchestrator, writer | — | — | `memory.write` |

Two entries deserve their reasoning spelled out.

`hive_land` is the only one-shot right in the system. A writer's capability carries `branch:land` in its role's one-shot set, and the daemon *reserves* the right before it touches git, then releases it if — and only if — the merge failed. The net effect is that the grant is spent by a successful merge and survives a failed one.

Reserving up front rather than consuming afterwards is what makes two concurrent lands safe: the reservation is a primary-key insert, so the second request loses the race in SQLite and never reaches `git merge`. Consuming after the merge instead would let both callers merge and only then discover one of them was a replay. And burning the grant on a *failed* attempt — stricter, simpler, and the third alternative we rejected — would make the writer's mandatory retry loop unwinnable: a fast-forward merge legitimately fails when `main` moves under a writer, who is then required to rebase and try again. That would push agents toward merging into the primary checkout by hand, trading a narrow replay window for a much worse behavior. So a failed land is audited and retryable; a succeeded land is spent; a replay of a spent grant is denied and audited as `capability.replayed`.

### Who re-arms a spent land grant

The grant is spent by a successful merge, and a working agent lands more than once, so *something* has to re-arm it. That something used to be a human, every single lap, and it was the most expensive thing in the system: one orchestrator cleared nine re-arm approvals in a single session, and the more productive the agent, the more often it stalled. Worse, most of those approvals granted nothing — the agent had already landed, `main..branch` was empty, and it was being asked to spend a human's decision on merging a diff that did not exist. The healthiest loop of all (agent lands, orchestrator directs the next change, agent lands again) was the one that jammed hardest, because an orchestrator approving a re-arm for a fix it specified itself is exactly what the self-approval classifier is built to catch.

So the daemon now *measures the branch* before it asks anyone anything, and there are three answers:

- **Nothing to land.** `main..branch` is empty. There is nothing to merge, therefore nothing to grant, and **no approval is filed at all.** This costs no safety: a grant to merge nothing is not a right anybody needs.
- **Re-arm, on Hive's own evidence.** The branch has commits the primary lacks *and* it is rebased on current `main`, so the merge is a genuine fast-forward. These are the two facts a human was being asked to eyeball, and git can state both. The re-arm is issued without a human and audited as `capability.auto-rearm`. It is bounded: **`AUTO_REARM_BUDGET` (3) auto re-arms per agent**, so a task gets four landings before a person is involved, and the fifth — and every one after it — asks.
- **Ask.** Everything else, and *every unknown*: a branch that cannot be read, a `null` from either measurement, a diverged branch, an exhausted budget. The approval is filed and the classifier still applies to it.

The property preserved is that a writer cannot merge an unbounded stream of unreviewed increments; the property given up is that a human sees each of the first four. What is deliberately **not** claimed is that the suite is green. The daemon cannot run a test suite inside a land handler, and an agent's *claim* that it is green is an act, not a state — so the budget is the containment instead of a promise Hive cannot keep.

The direction of the failure is the whole design. `readLandReadiness` is three-valued on purpose: `pending` and `rebased` are `null` when git could not answer, and `null` is routed to **ask**, never to grant. An unreadable branch is no evidence, and no evidence must never be converted into permission — the failure mode that once disarmed both of the guards whose entire purpose was to refuse.

`/health` and `/handshake` are public and non-authorizing. Health proves liveness. The handshake proves *identity* — build hash, project, protocol range — so a launcher can decide whether this daemon is the right one to talk to. Neither proves authority, neither mutates state, and neither may ever grow a side effect. A handshake that writes is a handshake that needs a capability, and the launcher has none by construction: it is trying to find out whether a capability would even be worth minting.

## Epoch, expiry, delegation

**Epoch** is Hive's revocation primitive. Every agent row carries a `capabilityEpoch`; every token minted for that agent freezes the epoch it was minted at. Revoking an agent's authority means advancing its epoch, which invalidates every outstanding token in one integer write, with no token list to walk and no distributed cache to flush. The critical-control path already advances the epoch when it revokes writes, so `hive_send --priority critical` becomes, for free, a credential revocation. Routes marked `epoch` in the matrix re-read the agent's current epoch and compare; a stale token is denied as `capability.stale-epoch`.

Only `hive_land` and `hive_ack_message` check the epoch, and that is a deliberate narrowing rather than an oversight. Epoch checks exist to stop *stale authority*, and the actions where stale authority is dangerous are the ones that commit: merging a branch, and confirming that a control instruction was applied. Checking the epoch on `hive_status` would buy nothing and would make every read fail during a rotation.

**Expiry** is absolute, not sliding: a token carries `expiresAt` and dies at that instant regardless of use. Agent tokens live as long as a generous agent session; the operator token lives as long as the daemon. A sliding window was rejected because it lets a stolen credential keep itself alive forever simply by being used, which is exactly the credential we most want to expire.

**Delegation is not supported, and this is a feature.** No capability can mint another. Minting happens only inside the daemon: once at startup for the operator, and once per agent at spawn. There is no `hive_mint` tool, no token-exchange endpoint, and no attenuation grammar. A capability is therefore a leaf — the authority graph is one level deep and can be reasoned about by reading the agents table. The alternative, a macaroon-style attenuable token, is strictly more expressive and was rejected because Hive has no use case that needs it and every delegation edge is a place for authority to escape.

## What the credential is, and what a stolen one buys

A token is `hv1.<capabilityId>.<secret>`. The daemon stores only `sha256(secret)` and compares in constant time, so a database or WAL leak yields no usable credential. The `capabilityId` is a lookup key, not a secret.

Tokens are delivered by file, never by environment variable and never by argv. Each subject gets `$HIVE_HOME/credentials/<subject>.cap`, mode `0600`, inside a `0700` directory outside every worktree. The `hive` CLI reads it with `O_CLOEXEC`, so the descriptor does not survive into anything the CLI execs. Claude Code fetches its header through `headersHelper`, a command run at connect time, rather than through `${ENV_VAR}` expansion in `headers` — the env-var form is documented and simpler, and it was rejected because an environment variable is inherited by every descendant of the agent process, which is precisely the grandchild we are trying to starve. Codex has no headers-helper, so its token is written into a `0600` `config.toml` as a static `http_headers` entry; `bearer_token_env_var` was rejected for the same inheritance reason.

Now the honest part. Hive runs every agent as the user's own UID. A same-UID process that knows the path can read the credential file, and a shell tool call inside an agent is such a process. No Unix socket, no `CLOEXEC` descriptor, and no peer check fixes that; the blueprint says as much. What Phase 0 actually buys is not secrecy against a determined same-UID attacker — it is that **the credential an agent can steal is worth almost nothing**. A writer's token cannot spawn, cannot approve, cannot kill, cannot name another agent, cannot land twice, and stops working the moment its epoch rotates. The blast radius of theft is the authority of the thief's own parent, which the thief already had.

The adversarial tests therefore prove a precise claim, not a vague one: a descendant of an agent process inherits **no** credential through its environment or its file descriptors, and a process holding no credential cannot mutate anything. Closing the same-UID filesystem read requires a real privilege boundary — a separate UID, a sandbox profile, or the signed-XPC peer check the blueprint plans for the Supervisor — and that is Phase 0's known, accepted residual risk, not a defect in it.

## Audit

Every authorization decision that mutates state is appended to an `audit_log` row: timestamp, route, action, caller subject and role, capability id, the subject the caller *requested*, the epoch, the decision, and a reason on denial. Denials are audited at least as carefully as approvals, because the interesting security signal is `agent maya attempted branch:land on subject zara` — a request that a well-behaved agent never makes.

Read-only routes are not audited. They are the overwhelming majority of traffic, they change nothing, and drowning the log in `hive_status` polls would make the rows that matter unfindable. The token secret never appears in a row, a log line, or an error message.

## Open questions

The audit log currently shares the daemon's SQLite database, which an agent with a shell can also read and, in principle, rewrite. Making the log genuinely tamper-evident — an append-only file with a hash chain, or a separate writer process — is unresolved and probably belongs with the Supervisor, which is the first component in the architecture with a real privilege boundary to protect it.

Capabilities are bound to a subject, not to a connection. Over HTTP there is nothing stable to bind to; the blueprint's XPC design binds to the connection object itself and is strictly better. Whether the HTTP plane should adopt a rolling token that rotates on every use — which converts credential theft from silent to loud, at the cost of a persistence race across concurrent MCP calls — is open, and worth deciding before the loopback plane outlives its expected lifetime.
