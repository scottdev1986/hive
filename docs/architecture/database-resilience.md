# Hive database resilience: self-healing and self-cleaning

Research and design. Nothing here is implemented. Every number in the inventory was read from the live `~/.hive/hive.db` on 2026-07-13; every behavioral claim is traced to `file:line` or reproduced in an isolated `HIVE_HOME`. Where I could not measure something, it says so.

The headline is not what I expected going in. Hive's SQLite file is in good shape — WAL, atomic commits, an idempotent migration ladder, a real 14-day pruner, and `PRAGMA integrity_check` returns `ok` today. **The database is not the fragile part. The way Hive reads a database that isn't there is.**

## 0. The organizing principle: absence read as the permissive answer

Four independent defects surfaced during this research. They look unrelated — a policy bug, a health endpoint, a quota ledger, a file-open flag — and they are the same bug wearing four costumes:

| Surface | The absent thing | What Hive concluded |
|---|---|---|
| Routing policy | provider row absent | **allowed** *(closed — `1348a17`)* |
| `hive.db` | file absent | **fresh install** |
| Quota ledger | usage rows absent | **nothing spent, full headroom** |
| `/health` | database never queried | **healthy** |

One habit: *a missing thing is read as the permissive answer.* Not "I don't know" — the good answer. Not "refuse" — the safe answer. The **convenient** answer, every time.

This matters enormously for the task at hand, because **self-healing is that habit, industrialized.** A repair path's entire job is to encounter something missing and produce something workable. That is the bug class's native shape. Build it carelessly and you will not have fixed the habit — you will have automated it, and given it a cron schedule.

So this document applies one test to every mechanism it proposes, and disqualifies anything that fails:

> **The absence test.** What does this mechanism do when the thing it reads is ABSENT? If the answer is anything other than *refuse, preserve, and say so* — it is disqualified. "Restores a working configuration" is not a feature. It is this bug class, recurring.

Everything below is organized around that test. §1–§3 establish what is really there and what really happens. §4–§5 run each healing and cleaning option through the test. §6 lists what must never be automated at all.

---

## 1. Inventory: what is actually in there

Measured 2026-07-13T13:03Z. The database was created 2026-07-10T18:11Z, so every rate below is over an observed **2.72 days** of heavy dogfooding.

**File and configuration** (read from the live DB, and from `bun:sqlite`'s real defaults under Hive's exact pragmas):

| Property | Observed | Set where |
|---|---|---|
| main file | 5,324,800 B (1,308 pages × 4,096) | — |
| `-wal` | 2,624,472 B at first read, 1,240,152 B minutes later | autocheckpointing works (§4) |
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
| `routing_policy_events` | 5 | 40,960 | per policy edit | **no** — the consent record (§6) |
| `approvals` | 91 | 32,768 | — | yes, 14-day prune |
| `capability_consumptions` | 120 | — | — | **no** |
| `escalations` | 0 | — | — | **no** |
| `quota_*` (pools, alerts, observations, route_health, model_catalog), `meta`, `agent_name_reservations` | ≤24 each | small | — | bounded by primary-key upsert |

Total growth: **~1.96 MB/day** at this workload. Extrapolation is a guess and this is an unusually hot install, so I won't dress it up as a forecast — but a year of *this* is roughly 700 MB, and nothing in the system would notice or complain.

Two structural facts drive most of the cleaning story:

- **`messages` is the database.** 54% of all bytes; 1.99 MB of that is `body` text alone (avg 1,506 B, max 13,127 B). Agent-to-agent mail is the dominant growth term.
- **`agents` rows are large and effectively immortal.** 196 of 202 rows (97%) are `dead`, and `taskDescription` — the entire spawn prompt — averages 2,979 B. Dead agents are 298 KB/day of pure history.

**What is pruned today.** Exactly one mechanism: `HiveDatabase.pruneHistory` (`db.ts:1512`), called with a 14-day window from the daemon's 30-second maintenance tick (`server.ts:1121`). It deletes `events` past the cutoff, `messages` **only in state `applied`**, and `approvals` **only** when not `pending`. That is a careful policy as far as it goes.

But note `freelist_count = 1`: **on this install the pruner has never actually deleted a row.** The database is 2.72 days old; the window is 14 days. The retention path is, in production, untested code. Worth knowing before we build more of it.

---

## 2. The real corruption surface for Hive's actual topology

I checked the topology rather than assuming it. `lsof` on the live file returns **exactly one process**: `hive daemon`. The Swift Workspace app never opens SQLite — it reaches state over HTTP and by shelling out to the `hive` CLI (no `import SQLite3`, no sqlite dependency in `workspace/Package.swift`). The statusline hook goes over HTTP (`cli/statusline.ts:178`). The MCP server is not a separate process; it is served by the daemon and shares the one handle (`server.ts:606`).

Hive is, in normal operation, a **single-writer, single-process database**. That one fact demolishes most generic SQLite-hardening advice, which is why this section is short.

**Real:**

1. **File loss — the highest-consequence failure, and it is silent.** `db.ts:312` opens with `new Database(path, { create: true })`. A deleted, moved, or badly-restored `hive.db` is *recreated empty*, with **no throw and no signal**, and the daemon proceeds as though freshly installed. Every agent record, every durable message, the whole audit trail: gone, without a word. This is the file-absent row of the §0 table. *(In-flight: darius is adding a durable out-of-DB init marker so a lost DB can be distinguished from a first boot and refused loudly.)*

2. **A second writer exists after all: `hive routing`.** `cli/routing.ts:100` constructs `HiveDatabase` directly in a short-lived CLI process. The constructor is unconditionally read-write — it sets the WAL pragma and runs the entire `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` migration ladder — so a command that only wants to *print* the routing table takes a write connection and can run schema migrations against a live daemon's database. Combined with the measured `busy_timeout = 0`, this throws. Reproduced in an isolated `HIVE_HOME`: with a holder process mid-transaction, a genuine read-only open reads fine (WAL doing its job) while `new HiveDatabase()` fails with **`database is locked`**. Blast radius is small today — the daemon's write transactions are short — but it is a real crash on a real command, and an old CLI binary can run its ladder against a newer live DB. *(In-flight: dean.)*

3. **Disk-full.** Unhandled anywhere. `SQLITE_FULL` surfaces as a generic `Error` and takes the daemon down at boot or 500s a request at runtime, with a database growing ~2 MB/day that nothing watches.

4. **Power loss / OS crash can lose recent commits.** `synchronous = NORMAL` (bun's default, never overridden) means the WAL is not fsynced on every commit. This is a *durability* gap, not a corruption one — WAL+NORMAL is still crash-safe against corruption; you lose the tail, not the file. I would not change it (§7).

**Mostly theoretical — and here the existing code deserves credit rather than an invented problem:**

5. **SIGKILL of the daemon mid-write does not corrupt anything.** This is what WAL is *for*: an uncommitted transaction is rolled back on next open. The brief listed this first; the honest finding is that it is already solved.

6. **Partial migrations are largely self-healing already.** The ladder (`db.ts:~420-660`) is a sequence of `ALTER`s, each guarded by a `PRAGMA table_info` introspection. It is idempotent and re-entrant: a SIGKILL halfway through resumes correctly on the next open. The one destructive step — `rebuildAgentsTable`, which does `DROP TABLE agents` / `RENAME` — **is wrapped in a transaction** (`db.ts:683-701`) and restores `foreign_keys` in a `finally`. It reconstructs columns it has never heard of from SQLite's own description of them (`db.ts:644-707`), specifically so an older binary cannot silently erase a newer one's column. Someone thought hard about this. It holds.

7. **Schema drift between a release and an older DB.** `user_version` is `0` and unused; schema version is *inferred* from introspection. Forward migration works; backward degrades rather than destroys, thanks to the column-preserving rebuild above. Real, but designed for.

8. **Bit-rot / malformed pages.** Possible on any filesystem; no evidence here (`integrity_check` = `ok`). Cheap to detect, so worth detecting — but I won't claim it is a live problem when I have no observation of one.

---

## 3. What happens today on a bad DB — traced

| Condition | Behavior | Verdict |
|---|---|---|
| DB file **corrupt** | throws out of the constructor (`db.ts:307-315`), uncaught; the only handler is the generic `cli.ts:830-839`, which prints one line and exits 1 | **fail-closed**, but silent — the daemon is detached, so the user just sees "the daemon won't come up" |
| DB file **missing** | `{ create: true }` (`db.ts:312`) recreates it empty; no throw, no signal | **silent data loss** |
| `routing_policy` row absent, on read | `emptyRoutingPolicy` → every model reads `unconfigured` → gate refuses (`routing-policy-store.ts:86-104`; `schemas/routing-policy.ts`) | **fail-closed** |
| `routing_policy` row **unparseable** | `RoutingPolicyCorruptError` (`routing-policy-store.ts:95,101`) — explicitly never degrades to the empty document | **fail-closed** |
| `capabilities` row absent | 401 deny (`capabilities.ts:277-302`) | fail-closed |
| **quota ledger empty** | `COALESCE(SUM(...), 0)` (`quota-ledger.ts:596-620`) — zero rows means zero units spent, i.e. **full headroom** | **fail-open on money** *(in-flight: darius)* |
| spawn with an empty policy | refuses, and names the remedy (`authorized-launch.ts:57-79`; `spawner-impl.ts:853-868`) | fail-closed |
| `/health` on a totally broken DB | returns `{ ok: true }` **without touching SQLite** (`server.ts:2006-2008`) | **green on a corpse** *(in-flight: dean)* |
| `SQLITE_BUSY` / `SQLITE_CORRUPT` at runtime | nothing catches them; `runMaintenance` catches and `console.error`s in a loop forever (`server.ts:915-922`) | silent degradation |

The policy read paths are genuinely well-built, and `routing-policy-store.ts:32-37` states the rule outright — *"'I could not read your policy' and 'you have no policy' are different facts and only one of them may be answered with defaults."* The code honors it.

**The consent variant of this bug is closed.** Earlier today the seeder wrote `state: "enabled"` rows beneath an absent provider, so a policy the user never authorized could launch agents. `1348a17` ("fail closed on unconfigured model providers") fixed it, and I re-ran my own wiped-DB experiment against current `main` to confirm rather than take it on report — including a positive control proving the probe *can* return `true`:

```
FIRST INSTALL : {"refusal":"gpt-5.6-sol cannot launch because provider codex is not enabled; ..."}
AFTER WIPE    : {"refusal":"gpt-5.6-sol cannot launch because provider codex is not enabled; ..."}
POSITIVE CTRL : true            <- after the operator explicitly enables the provider
```

The seed now writes `providers: {}` and `models: []` — **zero consent rows. A wiped database authorizes nothing.** That door is shut, and this document does not reopen it.

But it is the reason §0 exists. The same reflex is still live on three other surfaces, and the audit trail that *proved* the timeline — `routing_policy_events` row 1, `actor = hive`, not `operator` — is the thing a naive retention policy would have deleted. Which brings us to the design.

---

## 4. Healing options, run through the absence test

Measured against the real 5.3 MB database, not quoted from the SQLite docs.

**Integrity checking on open — cheap; do it.** `PRAGMA quick_check` took **8 ms** on the live file; full `integrity_check` took **10 ms**. At this size the distinction is academic; `quick_check` is the right default because it skips expensive index cross-checks while still catching malformed pages, and stays cheap as the file grows. Today **no integrity check of any kind exists**: `integrity_check`, `quick_check`, `wal_checkpoint`, `VACUUM`, and `busy_timeout` have **zero occurrences** in `src/` (positive control: the same grep *does* match the two pragmas that exist, at `db.ts:313-314` — so that is a real absence, not a bad pattern).

> *Absence test:* check fails, or the file is unreadable → **quarantine and refuse**. Never "check failed, rebuild and continue."

**WAL checkpointing — already works; do nothing.** The widely-recommended pattern Hive does not need. `wal_autocheckpoint` sits at SQLite's default 1,000 pages, and I watched it fire unattended: the WAL fell from 2,624,472 B to 1,240,152 B between two reads minutes apart. Manual checkpointing would be ceremony. The one useful checkpoint — before a snapshot — comes free with `VACUUM INTO`.

**Snapshots — three candidates; only one is right, and it is not the one the guides name.**

- *Raw file copy (`cp hive.db`)* — **reject, and understand why, because the failure is nastier than "it's corrupt."** I copied the live file without its `-wal`, opened the copy, and it worked fine: `quick_check` returned **`ok`**. It simply had 1,320 messages against the live 1,323, 2,732 events against 2,736, 1,387 audit rows against 1,389. **It silently dropped every transaction still living in the WAL, and it passed its own integrity check while doing so.** A backup that fails loudly is a nuisance; a backup that looks valid while missing your most recent commits is this document's bug class in backup form — absence (of the WAL) read as *fine*. (A torn mid-write copy is also possible under concurrency; I did not observe one, so I won't claim it.)

- *SQLite Online Backup API* — **not available.** The answer every generic guide gives, and it does not apply: `bun:sqlite`'s `Database` exposes no `.backup()` (verified on Bun 1.3.14 — `typeof db.backup === "undefined"`; the prototype offers `serialize`, `fileControl`, `exec`, `query`, `transaction`, but no backup). Any design assuming it is designing for a different runtime. `.serialize()` exists but pulls the whole DB into a memory buffer, buying nothing over the next option.

- *`VACUUM INTO`* — **recommend.** Plain SQL, so the runtime's API surface is irrelevant. Measured against the live database **while the daemon was running**, from a read-only connection: **12 ms**, output 5,279,744 B, `integrity_check` = `ok`, row counts matching live **exactly** (1,322/2,736/1,388 at snapshot time) — i.e. it includes WAL content, unlike the file copy. It takes only a read lock, so it never blocks the daemon's writers. It also emits a *defragmented* file, so the same primitive doubles as the compaction story (§5).

**Quarantine-and-rebuild — right shape, with the obvious design inverted.** On a failed integrity check the corrupt file is **moved aside and preserved** (`hive.db.corrupt.<timestamp>`), never deleted — and then the daemon **refuses to start normally**. It does not rebuild and carry on. "Start clean" is precisely the §0 habit wearing a repair badge: it takes an absent database and produces a working one. The correct terminal state is: quarantine the evidence; restore the most recent snapshot that passes `quick_check` if one exists; and if none does, **come up in a refusing state that can answer questions but cannot launch agents**, telling the user what was lost and where the corpse is.

> *Absence test:* no snapshot to restore → **refuse and say so.** Not "reinitialize."

**Event-log replay — real for policy, and it does not generalize.** `routing_policy_events` stores `before` and `after` as **full canonical policy documents**, not deltas (`routing-policy-store.ts:71-79`; confirmed against live rows at 4,365–4,581 bytes each). So `routing_policy` is a materialized view of its own log — the highest-revision `after` *is* the current document, written in the same transaction (`routing-policy-store.ts:199-219`). Reconstruction is therefore trivial, and worth wiring up, since **nothing in `src/` reads this table today**; it is a pure write-only append log.

Two hard constraints on that reconstruction, both straight from §0:

- Take the **latest revision's `after`**. Never "replay forward from the baseline" — replaying from revision 1 re-runs `seed-provisional-baseline`, and a reconstruction that re-executes a seed is a reconstruction that can invent consent. Read the endpoint; don't re-perform the history.
- If the log is empty or unreadable, the answer is the **empty policy (refuse)** — never a reseed.

It does not generalize. No other table has an event log. `agents`, `messages`, and `capabilities` have no replay source. `quota_usage` is genuinely unreconstructible: the vendors expose percentages, not spend history (repo memory: quota read surfaces), so a lost ledger is *lost*, and the only honest recovery is to **say so** rather than report zero.

---

## 5. Cleaning options, run through the absence test

**What grows without bound:** `agents`, `audit_log`, `escalations`, `capabilities`, `capability_consumptions`, `quota_reservations`, `quota_usage`, `routing_policy_events`, and — importantly — **any message that never reaches `state = 'applied'`**. Mail queued to an agent that died is never delivered, never applied, and therefore never pruned. Dead agents' mail accumulates forever.

Pruning targets, in order of bytes reclaimed per unit of risk:

1. **`messages` (54% of the DB).** The existing 14-day prune of `applied` messages is correct; keep it. The gap is terminal-but-not-applied mail. Safe extension: prune messages addressed to an agent `dead` longer than the window. This must be a *deliberate* rule — an undelivered instruction is evidence of something that didn't happen — but there is no argument for keeping a 60-day-old message to an agent dead for 59 of them.

2. **`agents` (298 KB/day, 97% dead).** Prune `dead` rows past the window — **with one non-negotiable exception: never prune an agent row whose branch is unlanded.** SPEC §13 is explicit that *"a process is disposable, a worktree is durable"*; the agent row is the **index into that durable worktree**. Delete it and you strand real, unlanded work with nothing pointing at it. This is the most dangerous prune in the system and the one most likely to look harmless.

3. **`quota_reservations` (245 of 246 rows terminal).** Terminal (`reconciled`/`released`) reservations past the widest quota window are dead weight. Safe to prune at ~30 days, comfortably past the weekly window they could still affect.

4. **`quota_usage`.** Prunable *in principle* past the widest rolling window, since the sums are windowed (`occurredAt >= cutoff`) and older rows contribute zero. But this is the spend ledger and it costs 45 KB. Prune it late (90 days) or not at all — reclaiming 45 KB is not worth being wrong about money.

5. **`routing_policy_events`** — 5 rows, 40 KB. **A non-problem; leave it.** See §6.

**VACUUM, auto_vacuum, and incremental vacuum.** The honest answer today is **do nothing**, and precision matters more than reciting the tradeoff.

`auto_vacuum` is `0`, and it **cannot be turned on in place.** I tested it: `PRAGMA auto_vacuum = 2` on an existing database reports back `0` — it silently does not take effect. Switching to incremental auto-vacuum requires a full `VACUUM` to rewrite the file, which takes an exclusive lock and blocks the daemon for its duration. So the usual advice ("prefer `incremental_vacuum` over a full `VACUUM`") presupposes a decision that was never made at file-creation time, and buying into it now costs exactly the thing it was meant to avoid.

Meanwhile the case for compaction is currently *zero*: `freelist_count = 1`. There are no free pages, because nothing has ever been pruned. When retention does start freeing them, the move is already on the table: **`VACUUM INTO` a fresh file and swap it in at daemon shutdown.** It never takes an exclusive lock on the live database, it defragments, and it is the same 12 ms primitive as the snapshot — one mechanism, two jobs. A full in-place `VACUUM` is never needed.

---

## 6. What must NEVER be auto-repaired or auto-pruned

Read this section if you read nothing else. Each item is the absence test, applied.

**Never auto-reseed the routing policy.** Absent must mean *refuse*. A rebuild, restore, or repair that leaves Hive holding an enabled policy has re-opened the door `1348a17` just shut. A policy store empty **because the database was lost** must be distinguishable from one empty **because this is a genuine first install** — today it is not (§2.1), which is exactly what the in-flight init marker fixes. Until that marker exists, no repair path may touch `routing_policy` at all.

**Never prune `audit_log`. It is not merely an audit trail — it is load-bearing for authorization.** `countAuditEntries` (`db.ts:1408-1424`) counts audit rows to compute the **auto-re-arm budget for spent land grants** (`server.ts:1164`), and the comment at `db.ts:1408-1411` says this is deliberate: the audit log is the durable record, and a second counter could disagree with it. **Pruning `audit_log` would silently re-arm authorizations the user already spent.** A retention policy written by someone who assumed "audit log = just history, safe to trim" would introduce a privilege escalation while tidying up disk space. This is the sharpest edge in the whole cleaning story.

**Never prune `routing_policy_events` below the latest revision.** It is the consent record — the durable proof of who enabled what, when, and whether it was the user or Hive. It is what let us reconstruct this morning's consent timeline at all: row 1, `actor = hive`, not `operator`. A naive "trim the event log" retention rule would have destroyed the evidence that proved the defect. It costs 40 KB. No disk-space argument survives contact with that.

**Never delete a corrupt database.** Quarantine and preserve it. The corrupt file is the only evidence of what went wrong, and it may still be partially recoverable.

**Never prune an agent row with an unlanded branch.** The row is the index to a durable worktree holding real work (SPEC §13).

**Never report a zero you did not measure.** An unreadable database reports *unreadable*. An empty quota ledger reports *unknown spend*, not *full headroom*. A health check that cannot read the database says so, rather than returning `{ok: true}`. This is the repo's standing rule, and it is the same rule as §0 read from the other end.

---

## 7. Recommendation

Ranked by risk reduction per unit of complexity. The top items are small, and they are worth more than everything beneath them — because they close a data-loss hole, a crash, and a lie, and none of them require building a "self-healing subsystem" at all. Three of the four are already in flight with other agents; this document's job is to make sure the *fourth* thing we build doesn't undo them.

### Phase 0 — invert the default (small, highest value)

These are the §0 bug class, and they are being fixed now. Listed so the design below inherits them rather than re-litigating them.

1. **Distinguish a lost database from a first boot** — a durable init marker *outside* `hive.db`. If the marker exists but the database is empty, **refuse loudly**: the policy store was lost, and the user must be told, not silently re-onboarded. *(In-flight: darius.)*
2. **An empty quota ledger must report unknown spend, not full headroom.** *(In-flight: darius.)*
3. **`/health` must actually read the database** — report `degraded`/`unreadable` rather than `ok`. *(In-flight: dean.)*
4. **`busy_timeout`, and a genuine read-only mode for `HiveDatabase`** (skip the DDL and migration ladder), putting `hive routing` on it — or move it to HTTP as `hive routing-policy` already is. Restores a true single-writer topology, the invariant everything below leans on. *(In-flight: dean.)*

### Phase 1 — detect and preserve (small, high value) — **the first thing to actually build**

5. **`PRAGMA quick_check` at daemon startup** (measured: 8 ms). On failure: **quarantine, never delete**; refuse to launch agents; say exactly what happened and where the file went. *Verify: corrupt a file, confirm the daemon refuses and the corpse is preserved.*

6. **Snapshot rotation via `VACUUM INTO`** (measured: 12 ms, WAL-inclusive, non-blocking) on daemon start and clean shutdown, keeping the last N. This is what makes quarantine survivable — without a snapshot, "preserve the corpse and refuse" leaves the user with nothing to restore. Two constraints, both from §0: a restored *policy* is legitimate (the user wrote it), but a restored *quota ledger* is stale, and the honest move is to mark spend unknown-since-snapshot rather than quietly returning headroom. And **no snapshot to restore → refuse**, never reinitialize.

### Phase 2 — clean (moderate, lower urgency)

7. **Extend retention** to dead-agent rows (with the unlanded-branch exception), terminal quota reservations, and mail to long-dead agents. The existing 14-day pruner has **never actually run a deletion** on this install, so land this behind a dry-run count first — it is untested code.

8. **Compact via `VACUUM INTO` + atomic swap at shutdown**, only once retention actually frees pages. Never a full in-place `VACUUM`.

### Explicitly not recommended

- **Manual WAL checkpointing** — already happens; measured.
- **`synchronous = FULL`** — buys crash-durability of the last few events at a per-commit fsync cost, against a threat (power loss, not process kill) whose worst case is losing a handful of telemetry rows. WAL already prevents *corruption*. Not worth it.
- **`auto_vacuum` / `incremental_vacuum`** — cannot be enabled without the full `VACUUM` they were meant to avoid (measured: the pragma silently no-ops). `VACUUM INTO` supersedes them.
- **The SQLite Online Backup API** — not exposed by `bun:sqlite`. The standard advice does not apply to this runtime.
- **Any "restore to a working configuration" repair.** There is no such thing. A repair that helpfully produces a working state out of a missing one is not a repair. It is §0, on a schedule.
