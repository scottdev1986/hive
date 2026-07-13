# Database resilience

Updated: 2026-07-13
Sources: Hive source tree, 2026-07-13; compiled from `docs/architecture/database-resilience.md`

## Summary

Hive's SQLite file is not the fragile part — WAL, atomic commits, an idempotent migration ladder, and a real pruner all hold. **The fragile part was always the way Hive read a database that wasn't there.** Every fix in this area is one invariant applied to a new surface: *absence must never be read as the permissive answer.*

## The organizing principle: absence read as the permissive answer

Four independent defects surfaced in the same week. They looked unrelated — a policy bug, a health endpoint, a quota ledger, a file-open flag — and they were the same bug in four costumes:

| Surface | The absent thing | What Hive concluded |
|---|---|---|
| Routing policy | provider row absent | **allowed** |
| `hive.db` | file absent | **fresh install** |
| Quota ledger | usage rows absent | **nothing spent, full headroom** |
| `/health` | database never queried | **healthy** |

One habit: a missing thing is read as the permissive answer. Not "I don't know" — the *good* answer. Not "refuse" — the *safe* answer. The **convenient** answer, every time.

This matters most when building repair machinery, because **self-healing is that habit, industrialized.** A repair path's entire job is to encounter something missing and produce something workable. That is the bug class's native shape. Build it carelessly and you have not fixed the habit — you have automated it and given it a cron schedule.

So every mechanism proposed here faces one test:

> **The absence test.** What does this mechanism do when the thing it reads is ABSENT? If the answer is anything other than *refuse, preserve, and say so* — it is disqualified. "Restores a working configuration" is not a feature. It is this bug class, recurring.

The same invariant governs the land-grant guard in [authorization.md](authorization.md#landing-reserve-before-merge), where a `null` from git routes to *ask*, never to *grant*. It is not a database rule. It is a Hive rule that happens to keep surfacing here.

## Topology: why most SQLite advice does not apply

Hive is, in normal operation, a **single-writer, single-process database**. The Swift Workspace never opens SQLite — it reaches state over HTTP and by shelling out to the `hive` CLI. The statusline hook goes over HTTP. The MCP server is not a separate process; it is served by the daemon and shares the one handle. CLI readers take a genuine read-only connection (`HiveDatabase.openReadonly`, `src/daemon/db.ts:346-348`), which skips the DDL and migration ladder entirely — a read-only open that ran migrations against a live daemon's database was a real crash (`database is locked`) and is why that constructor exists.

That single fact demolishes most generic SQLite hardening. There is no second writer to coordinate with, no connection pool, no replication. What is left is: what happens when the file is *wrong*.

## What is already true (do not re-litigate these)

- `PRAGMA busy_timeout = 5000` is set on **every** connection, including read-only ones — it is connection-local and writes nothing (`db.ts:379`). bun:sqlite's default is zero, which fails instantly on honest transient contention.
- `PRAGMA journal_mode = WAL`, `foreign_keys = ON` (`db.ts:401-402`).
- **A missing database file is refused, not recreated.** If the out-of-DB identity marker exists but the file does not, the constructor throws `HiveDatabaseIdentityError` rather than letting `{create: true}` manufacture an empty replacement (`db.ts:357-363`). A *replaced* database is caught too: the stored identity in `meta` is compared against the marker and a mismatch closes the handle and throws (`db.ts:380-399`). This is the file-absent row of the table above, closed.
- **`/health` actually reads the database.** It runs `quickCheck()` and reports `ok` / `degraded` / `unreadable`, and returns 503 when not ok (`src/daemon/server.ts:2039-2066`; `db.ts:726-730`). It used to return `{ok: true}` without touching SQLite — green on a corpse.
- **An empty quota ledger reports unknown spend, not full headroom.** `QuotaLedgerUnknownError` (`src/daemon/quota-ledger.ts:153-161`) refuses to report fresh headroom or reserve more quota from a history it cannot read. Fail-open on money was the sharpest instance of the bug class.
- SIGKILL mid-write does not corrupt anything — that is what WAL is for. Partial migrations are self-healing: the ladder is a sequence of introspection-guarded `ALTER`s, and the one destructive step (the agents-table rebuild) is transactional and reconstructs columns it has never heard of from SQLite's own description of them, so an older binary cannot silently erase a newer one's column.

## What is still open

- **No `quick_check` gate at startup.** `/health` runs it on demand; nothing runs it before the daemon begins serving. (Measured: `quick_check` 8 ms, full `integrity_check` 10 ms on a 5.3 MB file. At this size the distinction is academic; `quick_check` is the right default because it skips index cross-checks and stays cheap as the file grows.)
- **No quarantine of a corrupt `hive.db`.** A corrupt file throws out of the constructor and the daemon just fails to come up. The correct terminal state is: move the corpse aside (`hive.db.corrupt.<timestamp>`), **never delete it**, restore the newest snapshot that passes `quick_check` if one exists, and otherwise come up in a *refusing* state that can answer questions but cannot launch agents. The precedent already exists in this repo for a different file: `src/daemon/project-identity.ts:26-40` renames an unreadable registry to `.corrupt-<ts>` before recovering. That shape is right; copy it, and invert the ending — the registry may safely start fresh, and `hive.db` may not.
- **No snapshot rotation.** Without a snapshot, "preserve the corpse and refuse" leaves the user with nothing to restore.
- **No extended retention.** The only pruner is `pruneHistory` (`db.ts:1636`), called from the maintenance tick (`server.ts:1147`): 14 days, deleting `events`, `messages` **only in state `applied`**, and `approvals` **only** when not `pending`. Mail addressed to an agent that died is never delivered, never applied, and therefore never pruned. `agents` rows are large and effectively immortal.
- **Nothing reads `routing_policy_events`.** It is a pure write-only append log (`src/daemon/routing-policy-store.ts:169, :291`), even though it stores `before`/`after` as *full canonical policy documents*, not deltas — so `routing_policy` is a materialized view of its own log and reconstruction is trivial. Two hard constraints if that is ever wired up: take the **latest revision's `after`** (replaying forward from revision 1 re-runs the provisional seed, and a reconstruction that re-executes a seed can *invent consent*), and if the log is empty or unreadable, the answer is the empty policy — **never a reseed**.

## Three measured findings that overturn the standard advice

**The `cp hive.db` backup trap.** A raw file copy taken without its `-wal` opened cleanly and returned `quick_check` = **`ok`** — while silently missing the most recent commits (1,320 messages against a live 1,323; 1,387 audit rows against 1,389). **It passed its own integrity check while dropping every transaction still living in the WAL.** A backup that fails loudly is a nuisance; a backup that looks valid while missing your newest commits is this document's bug class in backup form — absence (of the WAL) read as *fine*.

**`bun:sqlite` exposes no `.backup()`.** Verified on Bun 1.3.14: the SQLite Online Backup API — the answer every generic guide gives — simply is not on the prototype. Any design assuming it is designing for a different runtime. `.serialize()` exists but pulls the whole DB into memory and buys nothing.

So the right primitive is **`VACUUM INTO`**: plain SQL, so the runtime's API surface is irrelevant. Measured against the live database *while the daemon was running*, from a read-only connection: **12 ms**, WAL-inclusive (row counts matched live exactly, unlike the file copy), `integrity_check` = `ok`, and it takes only a read lock so it never blocks the daemon's writers. It also emits a defragmented file, so one primitive does both the snapshot job and the compaction job.

**`auto_vacuum` cannot be enabled in place.** `PRAGMA auto_vacuum = 2` on an existing database silently reports back `0` — it does not take effect. Switching requires a full `VACUUM` to rewrite the file, which takes an exclusive lock and blocks the daemon for its duration. The usual advice ("prefer `incremental_vacuum` over a full `VACUUM`") presupposes a decision that was never made at file-creation time, and buying into it now costs exactly the thing it was meant to avoid. `VACUUM INTO` + atomic swap at shutdown supersedes it, and a full in-place `VACUUM` is never needed.

Also measured and therefore *not* worth building: **manual WAL checkpointing**. `wal_autocheckpoint` sits at SQLite's default 1,000 pages and was observed firing unattended (the WAL fell from 2.6 MB to 1.2 MB between two reads minutes apart). And **`synchronous = FULL`** buys crash-durability of the last few events at a per-commit fsync cost, against a threat (power loss, not process kill) whose worst case is losing a handful of telemetry rows. WAL already prevents *corruption*; NORMAL loses the tail, not the file.

## What must never be auto-pruned

Read this section if you read nothing else. Each item is the absence test, applied.

**Never prune `audit_log`. It is not merely an audit trail — it is load-bearing for authorization.** `countAuditEntries` (`db.ts:1536`) counts audit rows to compute the **auto-re-arm budget for spent land grants** (`server.ts:1197`), and the comment there says the choice is deliberate: the audit log is already the durable record of every grant the daemon issued, and a second counter could disagree with it. **Trimming `audit_log` would silently re-arm authorizations the user already spent.** A retention policy written by someone who assumed "audit log = just history, safe to trim" would introduce a privilege escalation while tidying up disk space. This is the sharpest edge in the entire cleaning story.

**Never auto-reseed the routing policy.** Absent must mean *refuse*. A repair that leaves Hive holding an *enabled* policy has re-opened the consent hole that `1348a17` closed. A policy store empty *because the database was lost* must remain distinguishable from one empty *because this is a genuine first install* — which is precisely what the identity marker (`db.ts:357-399`) now buys.

**Never prune `routing_policy_events`.** It is the consent record — the durable proof of who enabled what, when, and whether it was the user or Hive. It is what let us reconstruct the consent timeline of the original defect at all (row 1, `actor = hive`, not `operator`). A naive "trim the event log" rule would have destroyed the evidence that proved the bug. It costs 40 KB. No disk-space argument survives contact with that.

**Never delete a corrupt database.** Quarantine and preserve it. The corrupt file is the only evidence of what went wrong, and it may still be partially recoverable.

**Never prune an agent row with an unlanded branch.** [SPEC decision 13](../../SPEC.md) is explicit that a process is disposable and a worktree is durable — the agent row is the **index into that durable worktree**. Delete it and you strand real, unlanded work with nothing pointing at it. This is the most dangerous prune in the system and the one most likely to look harmless.

**Never report a zero you did not measure.** An unreadable database reports *unreadable*. An empty quota ledger reports *unknown spend*, not *full headroom*. A health check that cannot read the database says so. This is the standing repo rule, and it is the absence test read from the other end.

**And never trust a retention path you have not exercised.** The 14-day pruner had, on a 2.7-day-old install with `freelist_count = 1`, never actually deleted a row. Retention code is the code most likely to be shipped untested and least likely to fail visibly when it is wrong. Land any extension behind a dry-run count.

## See Also

- [Authorization](authorization.md) — the audit log's role in the auto-re-arm budget; the same absence rule in the land guard
- [Orchestrator status](orchestrator-status.md) — absence of news is unknown, never a state
- [Routing policy](../routing/routing-policy.md) — the consent record and why it may not be reseeded
- [SPEC](../../SPEC.md) — decision 13, what survives a crash
