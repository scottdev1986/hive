# Hive database resilience: self-healing and self-cleaning

Research and design. Nothing here is implemented. Every number in the inventory was read from the live `~/.hive/hive.db` on 2026-07-13; every behavioral claim is traced to `file:line` or reproduced in an isolated `HIVE_HOME`. Where I could not measure something, it says so.

The headline is not what I expected going in. Hive's SQLite file is in good shape — WAL, atomic commits, an idempotent migration ladder, a real 14-day pruner, and `PRAGMA integrity_check` reports `ok` today. The database is not the fragile part. **The fragile part is what Hive does when the database is *missing*, and the answer today is that it silently rebuilds it and re-grants consent the user never gave.** A self-healing story built without fixing that first would automate the worst bug in the system.

---

## 1. Inventory: what is actually in there

Measured 2026-07-13T13:03Z. The database was created 2026-07-10T18:11Z, so every rate below is over an observed **2.72 days** of heavy dogfooding.

**File and configuration** (read from the live DB, and from `bun:sqlite`'s real defaults under Hive's exact pragmas):

| Property | Observed | Set where |
|---|---|---|
| main file | 5,324,800 B (1,308 pages × 4,096) | — |
| `-wal` | 2,624,472 B at first read, 1,240,152 B minutes later | autocheckpointing works (see §4) |
| `journal_mode` | `wal` | `db.ts:313` |
| `foreign_keys` | `ON` | `db.ts:314` |
| `synchronous` | `1` (NORMAL) | **never set** — bun's default |
| `busy_timeout` | **`0`** | **never set** — bun's default |
| `auto_vacuum` | `0` (NONE) | never set |
| `wal_autocheckpoint` | `1000` pages (~4 MB) | SQLite default |
| `user_version` | `0` | **unused** — migrations are introspection-driven |
| `freelist_count` | `1` | nothing has ever been pruned here |
| `quick_check` | `ok` | — |

**Tables**, by bytes on disk (`dbstat`), with row counts and observed growth:

| Table | Rows | Bytes | Rate | Bounded? |
|---|---|---|---|---|
| `messages` | 1,320 | 2,879,488 (54% of DB) | ~485/day, ~1.06 MB/day | only `state='applied'` is pruned |
| `agents` | 202 | 811,008 | ~74/day, ~298 KB/day | **no** |
| `audit_log` | 1,387 | 196,608 | ~510/day | **no — and must not be** (§6) |
| `memory_fts_content` | 55 | 192,512 | — | derived index, rebuildable |
| `events` | 2,732 | 163,840 (+139,264 index) | ~1,005/day | yes, 14-day prune |
| `quota_reservations` | 246 | 86,016 | — | **no** (216 reconciled, 29 released, 1 active) |
| `capabilities` | 259 | 61,440 | — | **no** (revoked in place) |
| `quota_usage` | 216 | 45,056 | — | **no** |
| `routing_policy_events` | 5 | 40,960 | per policy edit | **no** — but see §6, it is the consent record |
| `approvals` | 91 | 32,768 | — | yes, 14-day prune |
| `capability_consumptions` | 120 | — | — | **no** |
| `escalations` | 0 | — | — | **no** |
| `quota_*` (pools, alerts, observations, route_health, model_catalog), `meta`, `agent_name_reservations` | ≤24 each | small | — | bounded by primary-key upsert |

Total growth: **~1.96 MB/day** at this workload. Extrapolating is a guess, and this is an unusually hot install, so I will not dress it up as a forecast — but a year of *this* would be roughly 700 MB, and nothing in the system would notice or complain.

Two structural facts drive most of the cleaning story:

- **`messages` is the database.** 54% of all bytes. 1.99 MB of that is `body` text alone (avg 1,506 B, max 13,127 B). Agent-to-agent mail is the dominant growth term.
- **`agents` rows are enormous and effectively immortal.** 196 of 202 rows (97%) are `dead`, and `taskDescription` — the entire spawn prompt — averages 2,979 B. Dead agents are 298 KB/day of pure history.

**What is pruned today.** Exactly one mechanism exists: `HiveDatabase.pruneHistory` (`db.ts:1512`), called with a 14-day window from the daemon's 30-second maintenance tick (`server.ts:1121`). It deletes `events` older than the cutoff, `messages` **only in state `applied`**, and `approvals` **only** when not `pending`. That is a careful, correct policy as far as it goes.

But note `freelist_count = 1`: **on this install the pruner has never actually deleted a row.** The database is 2.72 days old and the window is 14 days. The retention path is, in production, untested code. That is worth knowing before we build more of it.

---

## 2. The real corruption surface for Hive's actual topology

I checked the process topology rather than assuming it. `lsof` on the live file returns **exactly one process**: `hive daemon` (PID 15858). The Swift Workspace app never opens SQLite — it reaches state over HTTP and by shelling out to the `hive` CLI (no `import SQLite3`, no sqlite dependency in `workspace/Package.swift`). The statusline hook goes over HTTP (`src/cli/statusline.ts:178`). The MCP server is not a separate process; it is served by the daemon and shares the one handle (`server.ts:606`).

So Hive is, in normal operation, a **single-writer, single-process database**. That single fact demolishes most of the generic SQLite-hardening advice, and it is why this section is short.

**Real:**

1. **File loss or replacement — by far the highest consequence.** Not corruption at all, which is exactly why it slipped through. `db.ts:312` opens with `new Database(path, { create: true })`. A deleted, moved, or restored-from-a-bad-backup `hive.db` is *silently recreated empty*, and the daemon proceeds as if freshly installed. Consequences in §3. This is the one to fix.

2. **A second writer exists after all: `hive routing`.** `src/cli/routing.ts:100` constructs `HiveDatabase` directly in a short-lived CLI process. `HiveDatabase`'s constructor is unconditionally read-write — it sets the WAL pragma and runs the entire `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` migration ladder — so a command that only wants to *print* the routing table takes a write connection and can execute schema migrations against a live daemon's database. Combined with the measured `busy_timeout = 0`, this throws. I reproduced it in an isolated `HIVE_HOME`: with a holder process mid-transaction, a genuine read-only open reads fine (WAL doing its job), while `new HiveDatabase()` fails with **`database is locked`**. Low blast radius today — the daemon's write transactions are short, so the collision window is small — but it is a real crash on a real command, and the fix is one line.

3. **Disk-full.** Unhandled anywhere. `SQLITE_FULL` would surface as a generic `Error` and take the daemon down at boot or 500 a request at runtime, with a database growing ~2 MB/day that nothing watches.

4. **Power loss / OS crash can lose recent commits.** `synchronous = NORMAL` (bun's default, never overridden) means the WAL is not fsynced on every commit. This is a *durability* gap, not a corruption one — SQLite in WAL+NORMAL is still crash-safe against corruption; you lose the tail, you don't lose the file. Losing the last few events and messages is acceptable for Hive. I would not change this, and I'll say why in §4.

**Mostly theoretical, and I want to give the existing code credit rather than invent a problem:**

5. **SIGKILL of the daemon mid-write does not corrupt anything.** This is what WAL is *for*. An uncommitted transaction is simply rolled back on next open. The task brief listed this first; the honest finding is that it is already solved.

6. **Partial migrations are largely self-healing already.** The ladder (`db.ts:~420-660`) is a sequence of `ALTER`s, each guarded by a `PRAGMA table_info` introspection (`if the column isn't there, add it`). It is idempotent and re-entrant: a SIGKILL halfway through resumes correctly on the next open. The one genuinely destructive step — `rebuildAgentsTable`, which does `DROP TABLE agents` / `RENAME` — **is wrapped in a transaction** (`db.ts:683-701`) and restores `foreign_keys` enforcement in a `finally`. It also reconstructs columns it has never heard of from SQLite's own description of them (`db.ts:644-707`), specifically so an older binary cannot silently erase a newer one's column. Someone thought hard about this. It holds.

7. **Schema drift between a release and an older DB.** `user_version` is `0` and unused; the schema version is *inferred* from introspection. Forward migration works. Backward (an old binary opening a newer DB) degrades rather than destroys, thanks to the column-preserving rebuild above. Real, but designed for.

8. **Bit-rot / malformed pages.** Possible on any filesystem; no evidence of it here (`integrity_check` = `ok`). Cheap to detect, so worth detecting — but I am not going to claim it is a live problem when I have no observation of it.

---

## 3. What happens today on a bad DB — traced

This is the section that matters, because a system that fails *open* on a degraded database cannot be made safe by adding repair logic on top.

| Condition | Behavior | Verdict |
|---|---|---|
| DB file **corrupt** | throws out of the constructor (`db.ts:307-315`), uncaught; the only handler is the generic `cli.ts:830-839`, which prints one line and exits 1 | **fail-closed**, but silent — the daemon is detached, so the symptom the user sees is "the daemon won't come up" |
| DB file **missing** | `{ create: true }` (`db.ts:312`) recreates it empty; no throw, no signal | **silent empty recreate** |
| `routing_policy` row absent, **on read** | `emptyRoutingPolicy` → every model reads `unconfigured` → gate refuses (`routing-policy-store.ts:86-104`; `schemas/routing-policy.ts:227-254`; `routing-policy-store.ts:434-443`) | **fail-closed, correctly** |
| `routing_policy` row **unparseable** | `RoutingPolicyCorruptError` (`routing-policy-store.ts:95,101`) — explicitly never degrades to the empty document | **fail-closed, correctly** |
| `routing_policy` empty **at daemon boot** | `if (routingPolicy.isEmpty())` (`cli/daemon.ts:65`) → `seedProvisionalBaseline` writes `state: "enabled"` for every covered model (`routing-policy-store.ts:179-183`) | **FAIL-OPEN — this is the consent hole** |
| `capabilities` row absent | 401 deny (`capabilities.ts:277-302`) | fail-closed |
| **quota ledger empty** | `COALESCE(SUM(...), 0)` (`quota-ledger.ts:596-620`) — zero rows means zero units spent, i.e. **full headroom** | **fail-open on money** |
| spawn with an empty policy | refuses, and names the remedy (`authorized-launch.ts:57-79`; `spawner-impl.ts:853-868`) | fail-closed |
| `/health` on a totally broken DB | returns `{ ok: true }` **without touching SQLite** (`server.ts:2006-2008`) | **green on a corpse** |
| `SQLITE_BUSY` / `SQLITE_CORRUPT` at runtime | nothing catches them; `runMaintenance` catches and `console.error`s in a loop forever (`server.ts:915-922`) | silent degradation |

The read paths are genuinely well-built. `routing-policy-store.ts:32-37` already states the rule in a comment — *"'I could not read your policy' and 'you have no policy' are different facts and only one of them may be answered with defaults"* — and the code honors it.

**The hole is not in the reader. It is in the boot seeder.** And I proved it rather than reasoning about it. In an isolated `HIVE_HOME`: install a policy (revision 1) → `rm hive.db` → reopen.

```
install : isEmpty = false | revision = 1
wiped   : file exists = false
reboot  : file recreated = true | threw = no
reboot  : isEmpty = true  -> cli/daemon.ts:65 takes the SEED branch
reboot  : policy revision = 0  (the seeder is about to write rev 1, ENABLED)
```

**A wiped database is byte-for-byte indistinguishable from a first boot.** Losing the file — to a disk fault, a bad restore, a quarantine step, or a user's `rm` — causes Hive to manufacture consent on the next boot.

This is not hypothetical. The live database's own audit trail records it happening: `routing_policy_events` row 1 is `seed-provisional-baseline`, actor **`hive`** (not `operator`), at 2026-07-13T10:40:53Z, enabling 12 models with an **empty `providers: {}` map** — precisely the absent-provider-promoted-to-permission shape currently being patched.

Three corollaries follow, and they are the reason self-healing has to be designed against itself:

- **The quota ledger has the same shape.** An empty ledger doesn't say "I don't know what you've spent"; it says "you've spent nothing." Restoring a database from a stale snapshot silently returns spend headroom.
- **`/health` cannot be the health check.** It reports `ok` without reading the database. This repo already ruled that *"Health is never authorization"* (`restart-handoff.md`); it must also stop being *liveness*.
- **A repair path that "restores a working config" is the bug.** Any rebuild that produces an enabled policy is the wiped-DB defect with a friendlier name.

---

## 4. Healing options, compared

I measured each of these against the real 5.3 MB database rather than quoting the SQLite docs at you.

**Integrity checking on open — cheap, do it.** `PRAGMA quick_check` took **8 ms** on the live file; the full `integrity_check` took **10 ms**. At this size the distinction is academic; `quick_check` is the right default because it skips the expensive index cross-checks while still catching malformed pages, and it stays cheap as the file grows. There is no reason not to run this at daemon startup. Today, **no integrity check of any kind exists**: `integrity_check`, `quick_check`, `wal_checkpoint`, `VACUUM`, and `busy_timeout` have **zero occurrences** anywhere in `src/` (positive control: the same grep does match the two pragmas that *do* exist, at `db.ts:313-314`, so that is a real absence and not a bad pattern).

**WAL checkpointing — already works; do nothing.** This is the widely-recommended pattern that Hive does not need. `wal_autocheckpoint` is at SQLite's default of 1,000 pages, and I watched it fire: the WAL went from 2,624,472 B to 1,240,152 B between two reads minutes apart, unattended. Adding manual checkpointing would be ceremony. The only thing worth adding is a checkpoint before taking a snapshot, and `VACUUM INTO` gets that for free.

**Snapshots — three candidates, only one is right, and it is not the one the docs usually name.**

- *Raw file copy (`cp hive.db`)* — **reject, and understand why, because the failure is nastier than "it's corrupt."** I copied the live file without its `-wal`, opened the copy, and it worked fine: `PRAGMA quick_check` returned **`ok`**. It just had 1,320 messages against the live 1,323, 2,732 events against 2,736, 1,387 audit rows against 1,389. **It silently dropped every transaction still living in the WAL, and it looked perfectly valid while doing it.** A backup that fails loudly is a nuisance; a backup that passes its own integrity check while missing your most recent commits is a trap. (A torn mid-write copy is also possible under concurrency; I did not observe one, so I won't claim it.)

- *SQLite Online Backup API* — **not available.** This is the answer every generic guide gives, and it does not apply here: `bun:sqlite`'s `Database` exposes no `.backup()` method (verified on Bun 1.3.14 — `typeof db.backup === "undefined"`; the prototype offers `serialize`, `fileControl`, `exec`, `query`, `transaction`, and friends, but no backup). Any design that assumes it is designing for a different runtime. `.serialize()` exists but pulls the whole database into a memory buffer, which buys nothing over the option below.

- *`VACUUM INTO`* — **recommend.** Plain SQL, so the runtime's API surface is irrelevant. Measured against the live database **while the daemon was running**, from a read-only connection: **12 ms**, output 5,279,744 B, `integrity_check` = `ok`, and row counts matching the live database **exactly** (1,322/2,736/1,388 at the moment of the snapshot) — i.e. it includes WAL content, unlike the file copy. It takes only a read lock, so it does not block the daemon's writers. It also produces a *defragmented* file, which means the same primitive doubles as our compaction story (§5).

**Quarantine-and-rebuild.** The right shape, with one inversion of the obvious design. On a failed integrity check, the corrupt file must be **moved aside and preserved** (`hive.db.corrupt.<timestamp>`), never deleted — and then the daemon must **refuse to start normally**, not rebuild and carry on. "Start clean" is the manufactured-consent path wearing a repair badge. The correct terminal state is: quarantine the evidence, restore the most recent snapshot that passes `quick_check` if one exists, and if none does, **come up in a refusing state that can answer questions but cannot launch agents**, telling the user exactly what was lost and where the corpse is.

**Event-log replay — real for policy, and does not generalize.** `routing_policy_events` stores `before` and `after` as **full canonical policy documents**, not deltas (`routing-policy-store.ts:71-79`, confirmed against the live rows: 4,365–4,581 bytes each). So `routing_policy` is a materialized view of its own log — the highest-revision `after` *is* the current document, written in the same transaction (`routing-policy-store.ts:199-219`). Reconstruction is therefore trivial, and worth wiring up: **nothing in `src/` reads this table today**; it is a pure write-only append log.

But it comes with a live trap that must be designed against explicitly. **Replaying the log from revision 1 replays `seed-provisional-baseline` — the manufactured consent.** Reconstruction must take the **latest revision's `after`**, never re-run the seed, and never "replay forward from the baseline." And if the log is empty or unreadable, the answer is the empty policy (refuse), *not* a reseed.

It does not generalize. No other table has an event log. `agents`, `messages`, and `capabilities` have no replay source. `quota_usage` is genuinely unreconstructible: the vendors expose percentages, not spend history (see repo memory on quota read surfaces), so a lost ledger is *lost*, and the only honest recovery is to say so rather than to report zero.

---

## 5. Cleaning options, compared

**What grows without bound:** `agents`, `audit_log`, `escalations`, `capabilities`, `capability_consumptions`, `quota_reservations`, `quota_usage`, `routing_policy_events`, and — importantly — **any message that never reaches `state = 'applied'`**. A message queued to an agent that died is never delivered, never applied, and therefore never pruned. Dead agents' mail accumulates forever.

**The pruning targets, in order of bytes reclaimed per unit of risk:**

1. **`messages` (54% of the DB).** The existing 14-day prune of `applied` messages is correct and should stay. The gap is terminal-but-not-applied mail. Safe extension: prune messages addressed to an agent that has been `dead` for longer than the window. This must be a *deliberate* rule, because an undelivered instruction is evidence of something that didn't happen — but there is no argument for keeping a 60-day-old message to an agent that has been dead for 59 of them.

2. **`agents` (298 KB/day, 97% dead).** Prune `dead` agent rows older than the retention window — **with a hard exception that is not negotiable: never prune an agent row whose branch is unlanded.** SPEC §13 is explicit that *"a process is disposable, a worktree is durable"*; the agent row is the **index into that durable worktree**. Deleting it strands real, unlanded work with nothing pointing at it. This is the single most dangerous prune in the system and the one most likely to look harmless.

3. **`quota_reservations` (245 of 246 rows terminal).** Terminal (`reconciled`/`released`) reservations older than the widest quota window are dead weight. Safe to prune at, say, 30 days — comfortably past the weekly window they could still affect.

4. **`quota_usage`.** Prunable *in principle* past the widest rolling window, since the sums are windowed (`occurredAt >= cutoff`), so older rows contribute zero. But this is the spend ledger and it is cheap (45 KB); prune it late (90 days) or not at all. Reclaiming 45 KB is not worth being wrong about money.

5. **`routing_policy_events`** — 5 rows, 40 KB. **A non-problem. Leave it alone.** See §6.

**VACUUM, auto_vacuum, and incremental vacuum.** The honest answer for today is **do nothing**, and I want to be precise about why rather than reciting the tradeoff.

`auto_vacuum` is `0`, and it **cannot be turned on in place**. I tested it: `PRAGMA auto_vacuum = 2` on an existing database reports back `0` — it silently does not take effect. Switching to incremental auto-vacuum requires a full `VACUUM` to rewrite the file, which takes an exclusive lock and blocks the daemon for the duration. So the usual advice ("prefer `incremental_vacuum` over a full `VACUUM`") presupposes a decision that was never made at file-creation time, and buying into it now costs exactly the thing it was supposed to avoid.

Meanwhile the case for compaction is currently *zero*: `freelist_count = 1`. There are no free pages, because nothing has ever been pruned. When retention does start freeing pages, the elegant move is already on the table: **`VACUUM INTO` a fresh file and swap it in at daemon shutdown.** It never takes an exclusive lock on the live database, it defragments, and it is the same 12 ms primitive as the snapshot — one mechanism, two jobs. A full in-place `VACUUM` is never needed.

---

## 6. What must NEVER be auto-repaired or auto-pruned

This is the section to read if you read nothing else.

**Never auto-reseed the routing policy.** Absent must mean *refuse*, always. A rebuild, restore, or repair that leaves Hive with an enabled policy has re-opened the consent hole. Concretely: a policy store that is empty **because the database was lost** must be distinguishable from one that is empty **because this is a genuine first install** — and today it is not (§3). Until it is, no repair path may touch `routing_policy`.

**Never prune `audit_log`. It is not just an audit trail — it is load-bearing for authorization.** `countAuditEntries` (`db.ts:1408-1424`) counts audit rows to compute the **auto-re-arm budget for spent land grants** (`server.ts:1164`), and the comment at `db.ts:1408-1411` says this is deliberate: the audit log is the durable record, and a second counter could disagree with it. **Pruning `audit_log` would silently re-arm authorizations the user already spent.** A retention policy written by someone who assumed "audit log = safe to trim, it's just history" would introduce a privilege bug while cleaning up disk space. It is also the trail that proved the consent defect this morning — the `actor = hive` seed row is *in* that table's sibling log, and it is the only reason we know when the user consented to what.

**Never prune `routing_policy_events` below the latest revision.** It is the consent record — the durable proof of who enabled what, when, and whether it was the user or Hive. It is 40 KB. There is no disk-space argument that survives contact with that.

**Never delete a corrupt database.** Quarantine it (`hive.db.corrupt.<timestamp>`) and preserve it. The corrupt file is the only evidence of what went wrong, and it may still be partially recoverable.

**Never prune an agent row with an unlanded branch.** The row is the index to a durable worktree containing real work (SPEC §13).

**Never report a zero you did not measure.** An unreadable database must report *unreadable*. An empty quota ledger must report *unknown spend*, not *full headroom* (`quota-ledger.ts:596-620` currently reports the latter). A health check that cannot read the database must say so, not return `{ok: true}` (`server.ts:2006-2008` currently returns the latter).

---

## 7. Recommendation

Ranked by risk reduction per unit of complexity. The top three are small, and they are worth more than everything below them combined — because they close a consent hole, a crash, and a lie, and none of them require building a "self-healing" subsystem at all.

### Phase 0 — stop the bleeding (small, high value)

1. **Make a lost database distinguishable from a first boot.** The seeder's precondition must be "this install has never been configured," not "this table is empty." Put an install marker *outside* `hive.db` (an `installId` + `seededAt` written next to it, or keyed off the existing `~/.hive/project-registry.json` / `credentials/`). If the marker exists but the policy store is empty, **do not seed** — come up refusing, and tell the user their policy store was lost and must be re-authorized in the Model Control Center. This is the whole ballgame; it is also perhaps 30 lines. *Verify: the wiped-DB reproduction in §3 must end in a refusal, not a seed.*

2. **Set `busy_timeout`.** One line in `db.ts`. Removes the reproduced `database is locked` crash and every future one. *Verify: the contention reproduction stops throwing.*

3. **Make `/health` actually read the database** — a `SELECT 1` and a `quick_check` result, reporting `degraded`/`unreadable` rather than `ok`. *Verify: corrupt the file, hit `/health`, get a non-ok answer.*

### Phase 1 — detect and preserve (small, high value)

4. **`PRAGMA quick_check` at daemon startup** (measured: 8 ms). On failure: **quarantine, do not delete**; refuse to launch agents; say exactly what happened and where the file went.

5. **Snapshot rotation via `VACUUM INTO`** (measured: 12 ms, WAL-inclusive, non-blocking) on daemon start and clean shutdown, keeping the last N. This is what makes quarantine survivable — without a snapshot, "preserve the corpse and refuse" leaves the user with nothing to restore. **Restoring a snapshot must not restore consent it cannot vouch for**: a restored policy is still a policy the user wrote, so it is legitimate — but a restored *quota ledger* is stale, and the honest move is to mark spend as unknown-since-snapshot rather than silently returning headroom.

6. **Give `HiveDatabase` a genuine read-only mode** (skip the DDL and the migration ladder), and put `hive routing` on it — or move it to HTTP like `hive routing-policy` already is. This restores a true single-writer topology, which is the invariant most of this design leans on.

### Phase 2 — clean (moderate, lower urgency)

7. **Extend retention** to dead-agent rows (with the unlanded-branch exception), terminal quota reservations, and mail to long-dead agents. Note the existing 14-day pruner has **never actually run a deletion** on this install, so land this behind a dry-run count first — it is untested code.

8. **Compact via `VACUUM INTO` + atomic swap at shutdown**, only once retention is actually freeing pages. Never a full in-place `VACUUM`.

### Explicitly not recommended

- **Manual WAL checkpointing** — already happens; measured.
- **Switching to `synchronous = FULL`** — buys crash-durability of the last few events at a per-commit fsync cost, against a threat (power loss, not process kill) whose worst case is losing a handful of telemetry rows. WAL already prevents *corruption*. Not worth it.
- **`auto_vacuum` / `incremental_vacuum`** — cannot be enabled without the full `VACUUM` it was meant to avoid (measured: the pragma silently no-ops). `VACUUM INTO` supersedes it.
- **The SQLite Online Backup API** — not exposed by `bun:sqlite`. The standard advice does not apply to this runtime.
- **Any "restore to a working configuration" repair.** There is no such thing. A repair that produces an enabled policy is the bug.

---

## Appendix: live defects found while researching

Reported to the orchestrator on 2026-07-13 rather than fixed here, since the policy path is under concurrent repair. All four are reachable **today**, without any self-healing feature existing:

1. **A wiped/lost DB reseeds enabled models** — `db.ts:312` (`{create: true}`) + `cli/daemon.ts:65` (`isEmpty()`) + `routing-policy-store.ts:179-183` (`state: "enabled"`). Reproduced.
2. **`/health` returns `{ok: true}` without touching SQLite** — `server.ts:2006-2008`. Green on a dead database.
3. **An empty quota ledger reads as full headroom** — `quota-ledger.ts:596-620` (`COALESCE(SUM(...), 0)`).
4. **`hive routing` is a second read-write writer and crashes on contention** — `cli/routing.ts:100` + `busy_timeout = 0`. Reproduced (`database is locked`).
