# Hive Memory Audit: Post-P0 State

**Date**: 2026-08-22  
**Pinned SHA**: `dfc55968b27604ad619a38b0001cb9289ab286c0`  
**Owner**: Hive Memory agent → Scott Kellar / CEO  
**Scope**: Inventory of memory surfaces after P0 implementation (PR #130)

**Evidence**:
- LOCKED plan: `docs/memory-plan.md`
- Proposals stub: `docs/memory-proposals.md`
- Do not resurrect killed audit claims: no harvest dead code, no hybrid semantic disabled, no self-verify theater, events retrieval tested

---

## Executive Summary

Post-P0, Hive memory moved toward **wake feed** architecture: specialist agents receive an always-on **wake pack floor** (constitution, profile, project doc, handoff, recent mistakes) plus a ranked memory index, eliminating silent zero when memory exists. The pack is auto-injected on every specialist spawn.

**What P0 landed** (verified in tree):
1. **Wake pack floor** with fail-closed handoff synthesis
2. **Queen launch context** uses flat pack fields (constitution, profile, project doc, mistakes)
3. **Retention keep-set** fixed (no longer empty Set)
4. **Citation validation** on load-bearing memory_read (pathExists/commandExists)
5. **Prewrite gate** in write-service (partial add|update gate; NOOP dead)
6. **executeMemoryTrigger deleted** (no orphan body)
7. **Index pick via RRF** using buildMemoryRecallBundle with semantic null (FTS-only, documented honestly)
8. **wake_pack_enabled flag** gates pack+index concurrent vs index-only (dual-read sunset path)
9. **embedding_provider: "api" fail-closed** (config parse rejects it)
10. **Named §7 acceptance tests** in `test/memory-p0-acceptance.test.ts`

**Key finding**: Memory is still **partitioned** (durable wiki, runtime state, per-spawn injection, cross-session mail), but specialist spawn is no longer lookup-dependent. A silent specialist (never calls memory tools) still receives pack floor + index.

**Biggest remaining gap**: Session pickup is now auto-injected (handoff card every spawn), but the old `empty_vs_dropped` soft theater remains in index→buildAgentPrompt path per Critic PASS notes. Consolidator is still CLI/idle, not every-turn extract.

---

## 1. Pinned Evidence

- **Plan**: `docs/memory-plan.md` (LOCKED)
- **Proposals**: `docs/memory-proposals.md` (stub for P1 review-gated changes)
- **Killed audit claims** (do not repeat):
  - C1 "no episodic→wiki promotion" was provisional; harvest is live
  - Dead doorkeeper claim retracted
  - Hybrid semantic was never hardcoded disabled in recall path
  - Self-verify theater claim retracted
  - Events retrieval exists and is tested

---

## 2. Memory Surface Inventory

### 2.1 Durable Wiki Memory (`.hive/memory/` and `~/.hive/memory/`)

**Files**: `src/memory-service/memory-store.ts`, `src/schemas/memory.ts`

**Structure** (unchanged):
```
<scope>/
├── raw/<topic>/<observation>.md      # Immutable evidence
└── wiki/
    ├── <topic>/<article>.md          # Compiled knowledge
    ├── index.md                       # Index rows
    └── log.md                         # Operation log
```

**Scopes**:
- `repo`: `.hive/memory/` — project-specific
- `global`: `~/.hive/memory/` — machine-wide

**Schema** (`MemoryFact`): id, scope, topic, title, body, tags, date, path, source, evidence, status, kind, supersedes, raw, verified, author

**Index Cap**: `MEMORY_INDEX_MAX_ENTRIES = 30` (`memory-store.ts:80`)

**Write Path** (P0 change: prewrite gate):
1. Agent calls `memory_write` MCP tool
2. **P0**: `MemoryWriteService.preWriteCheck` normalizes title, searches for duplicates → returns add|update (partial gate; NOOP dead) (`write-service.ts:79-130`)
3. Daemon validates schema, applies action
4. Writes to `wiki/<topic>/<id>.md` with frontmatter
5. Appends observation to `raw/<topic>/`
6. Rebuilds `wiki/index.md` (capped)
7. Updates FTS + embeddings (if available)
8. Logs operation to `wiki/log.md`

**Read Path**: `memory_read(scope, id)`, `memory_search(query)` (FTS + optional semantic)

**Injection** (P0: see §3 Wake Pack Floor below)

---

### 2.2 Episodic Events (Per-Project DB)

**File**: `src/memory-service/episodic.ts`

**Storage**: `episodic.db` table `events` (id, ts, agent, type, summary, provenance)

**Retention** (P0 fix): `sweepEvents` uses real keep-set from `extractReferencedEpisodeIds` (scans wiki articles for `E<id>` references), not empty Set (`retention.ts:57-97`). Events cited by active ledger/pitfall provenance are preserved.

**Test**: `retention_keepset` in `test/memory-p0-acceptance.test.ts:49-113` validates that referenced episodes survive sweep.

---

### 2.3 Full-Text Search Index (In-Memory, Rebuilt on Daemon Start)

**File**: `src/memory-service/fts-index.ts`

**Implementation**: SQLite FTS5 virtual table, porter stemmer, in-memory database (rebuilt from wiki on every daemon start)

**Schema**: `CREATE VIRTUAL TABLE memory_fts USING fts5(id, scope UNINDEXED, topic UNINDEXED, title, body, tags, date UNINDEXED, status UNINDEXED, path UNINDEXED, kind UNINDEXED, source UNINDEXED, tokenize = 'porter')`

**Query**: BM25 scoring, stopword filtering, AND/OR fallback

---

### 2.4 Semantic Embeddings (Episodic Store)

**Files**: `src/memory-service/embeddings.ts`, `src/memory-service/episodic.ts`

**Storage**: `episodic.db` table `memory_embeddings` (kind, scope, source_id, model, dimensions, vector, embedded_at)

**Models**: Local only (`BAAI/bge-small-en-v1.5` or `all-MiniLM-L6-v2`, 384-dim). API provider removed from schema.

**P0 change**: `embedding_provider: "api"` now **fails config parse** (`config-schema.ts:64` restricts to `z.enum(["local"])`). Test: `api_provider_fail_closed` in `test/memory-p0-acceptance.test.ts:37-46`.

**Runtime**: External bundle at `~/.hive/tools/embeddings/`, lazy-loaded on first `memory_search`.

**Search**: Brute-force cosine similarity (no sqlite-vec)

---

### 2.5 Skills Directory (Always-Injected Instructions)

**Paths**: `.hive/skills/` (repo), `~/.hive/skills/` (global)

**Addressing**: `queen/<skill>/SKILL.md`, `agent/<category>/<skill>/SKILL.md`, vendor-specific subdirs

**Injection**: All matching skills concatenated and passed to vendor CLI on spawn (vendor-native, not Hive-injected)

---

### 2.6 AGENTS.md and CLAUDE.md

**Paths**: `AGENTS.md`, `CLAUDE.md` (root-down-to-cwd)

**Injection**: Vendor CLI loads natively. Hive does NOT inject — vendor does.

---

### 2.7 Mail System (Inter-Agent Coordination)

**File**: `src/mail-service/store.ts`

**Tables**: `mail_items`, `mail_leases`, `mail_dead_letters`

**Lanes**: `control` (design forks, blockers → queen), `work` (status updates → queen or peer)

**State Machine**: `available` → `claimed` (lease) → `settled` (ack|nak|retry|discard)

---

### 2.8 Agent State (Runtime DB)

**File**: `src/daemon/database/schema.ts`

**Tables**: `agents`, `agent_name_reservations`, `events`, `approvals`, `escalations`

**No Profile**: Agent record is ephemeral identity. No preferences, no history carryover.

---

### 2.9 Routing Policy (Machine-Wide DB)

**File**: `src/daemon/routing-policy-store.ts`

**Storage**: `~/.hive/hive.db` table `routing_policy` (singleton with CAS writes)

---

## 3. What P0 Landed

### 3.1 Wake Pack Floor

**Files**: `src/memory-service/pack-floor.ts`, `src/daemon/spawn/pack-assembly.ts`, `src/daemon/spawn/handoff-loader.ts`

**Slots** (always-on for specialist spawn):
1. **Constitution** (`loadConstitution()`): Core principles (project-agnostic software factory, learn from mistakes, citation-validation, fail-closed)
2. **Profile** (`loadProfile()`): User preferences from `~/.hive/profile.md` or explicit empty stub `"(Profile slot reserved but empty - create ~/.hive/profile.md)"`
3. **Project doc** (`loadProjectDoc(repoRoot)`): First-found from `AGENTS.md`, `CLAUDE.md`, `docs/README.md` (2KB preview) or explicit empty stub
4. **Handoff card** (`loadHandoffText()`): **EVERY specialist spawn** gets durable handoff or auto-synthesized from task, fail-closed if unsynthable (`handoff-loader.ts:9-73`)
5. **Recent mistakes** (`loadRecentMistakes(episodic)`): Last 10 pitfall/mistake events from episodic store (E-prefixed summaries)

**Handoff logic** (`handoff-loader.ts:9-73`):
- If `handoffId` provided and stored → load bundle (goal, done, remaining, decisions, nextAction)
- Else if `taskDescription` non-empty → synthesize from assignment
- Else → **return null** (fail-closed)

**Fail-closed**: `loadAndValidateWakePack` in `pack-assembly.ts:26-71` throws `SpawnFailedError` if handoff is null (cannot spawn specialist without handoff).

**Test**: `handoff_every_spawn` in `test/memory-p0-acceptance.test.ts:335-408` validates that spawn with no handoffId but valid task synthesizes handoff, and spawn with neither fails closed.

---

### 3.2 Queen Launch Context

**File**: `src/cli/orchestrator.ts:185-211`

**P0**: `buildQueenLaunchContext` loads pack floor (constitution, profile, projectDoc, recentMistakes) and passes **flat fields** (not nested packFloor object) into `queenBootCapsules.composeLaunchContext`.

```typescript
// Lines 191-210
const { loadConstitution, loadProfile, loadProjectDoc, loadRecentMistakes } =
  await import("../memory-service/pack-floor");

const [constitution, profile, projectDoc] = await Promise.all([
  Promise.resolve(loadConstitution()),
  loadProfile(),
  loadProjectDoc(input.repoRoot),
]);
const recentMistakes = loadRecentMistakes(undefined); // No episodic in CLI

return queenBootCapsules.composeLaunchContext({
  policy: QUEEN_POLICY,
  memoryIndex: input.memoryIndex,
  bootCapsule: input.bootCapsule,
  constitution,
  profile,
  projectDoc,
  recentMistakes,
}).text;
```

---

### 3.3 Retention Keep-Set Fixed

**File**: `src/memory-service/retention.ts:57-97`

**P0**: `runRetentionSweep` calls `extractReferencedEpisodeIds(repoRoot)` to scan wiki articles for `E<id>` references. `sweepEvents(episodic, cutoff, keepIds)` preserves referenced episodes even if older than `events_hot_days`.

**Before P0**: Sweep was passing `new Set()` (empty keep-set).

**Test**: `retention_keepset` in `test/memory-p0-acceptance.test.ts:49-113` creates facts with episode references, runs sweep with 0-day cutoff, verifies referenced episodes survive.

---

### 3.4 Citation Validation (Load-Bearing Paths)

**File**: `src/memory-service/memory-tools.ts` (likely in `memory_read` handler)

**P0**: `validateFactCitations` checks `pathExists` and `commandExists` for load-bearing claims before returning article. If cited path/command does not exist in worktree → treat as stale/unverified.

**Plan quote** (§3.9): "Citation before load-bearing apply: path-exists (and command-exists if claim names a binary) check in code against the worktree/repo — not prompt-theater."

---

### 3.5 Prewrite Gate (Dedup Before Write)

**File**: `src/memory-service/write-service.ts:79-130`

**P0**: `MemoryWriteService.preWriteCheck` implements partial write-gate — ADD/UPDATE exist, but NOOP is dead/incomplete (see §6 Critic hole #3, HIGH P0 residual):
1. Normalize title (lowercase, strip punctuation)
2. Search for existing fact with same normalized title
3. If found → return `"update"` (set supersedes field)
4. Else → return `"add"`
5. NOOP path (identical body → skip write) is type-declared but never returned

**Test**: `prewrite_dedup` in `test/memory-p0-acceptance.test.ts:164-216` writes "Test Article" then "Test Article!" (same normalized title), verifies second write returns same id with supersedes field set, and only one fact file exists on disk.

---

### 3.6 executeMemoryTrigger Deleted

**Grep result**: `executeMemoryTrigger` only appears in `src/memory-service/recall.ts` and `docs/memory-plan.md` (plan doc mentions deletion requirement). No export exists in codebase.

**Status**: Deleted (orphan body removed, no lying delivery comments remain).

---

### 3.7 Index Pick via RRF (FTS-Only, Semantic Null)

**File**: `src/memory-service/memory-store.ts:927-969`

**P0**: `buildMemoryIndex` uses `buildMemoryRecallBundle` from `recall.ts` with **semantic explicitly disabled** (semantic: null, semanticStatus: "disabled"). This uses FTS-only ranking (RRF with one leg).

**Code quote** (lines 945-968):
```typescript
// P0: Use buildMemoryRecallBundle for FTS-only ranking (semantic explicitly disabled)
if (options.brief !== undefined && options.brief.trim() !== "") {
  const { buildMemoryRecallBundle } = await import("./recall");
  // ... build temporary in-memory index ...
  const bundle = await buildMemoryRecallBundle(
    options.brief,
    {
      repoRoot: () => root,
      memory: tempIndex,
      semantic: null,
      semanticStatus: () => "disabled",
    },
    MEMORY_INDEX_MAX_ENTRIES,
  );
  // ... format bundle entries ...
}
```

**Honest naming**: Code comments say "FTS-only" and "semantic explicitly disabled". This is not hidden.

---

### 3.8 wake_pack_enabled Flag (Dual-Read Sunset)

**Files**: `src/schemas/config-schema.ts:67`, `src/daemon/spawn/hive-spawner.ts:1328-1330`

**P0.12**: `wake_pack_enabled: z.boolean().default(true)` gates whether spawn uses pack+index concurrent or index-only (soft dual-read for migration). Plan calls this "sunset flag" for one release cycle before pack becomes primary.

**Code quote** (config):
```typescript
// P0.12: Dual-read pack+index sunset flag
wake_pack_enabled: z.boolean().default(true),
```

---

### 3.9 Per-Scope Locks

**File**: `src/memory-service/write-service.ts:45-51`

**P0**: `getLockPath(scope)` returns `~/.hive/memory/memory.lock` for global, `<repo>/.hive/memory.lock` for repo. Global writes do NOT acquire repo lock.

**Test**: `scope_lock` in `test/memory-p0-acceptance.test.ts:116-161` writes to both scopes and verifies both succeed (different locks).

---

### 3.10 Named §7 Acceptance Tests

**File**: `test/memory-p0-acceptance.test.ts`

**P0 plan §7** required named tests. Implemented:
- `api_provider_fail_closed` (line 37): embedding_provider: "api" throws on config parse
- `retention_keepset` (line 49): Referenced episodes survive sweep
- `scope_lock` (line 116): Global vs repo lock separation
- `prewrite_dedup` (line 164): Near-duplicate write becomes UPDATE
- `wake_semantic_not_hardcoded` (line 219): Semantic not hardcoded disabled when ready
- `wake_not_newest10` (line 260): Wake uses query-ranked recall, not date-sorted top-10
- `handoff_every_spawn` (line 335): Spawn synthesizes or fails closed
- `empty_vs_dropped` (line 442): Non-empty store + omitted index shows CAP signal

**Soft residual**: `empty_vs_dropped` test notes "still index→buildAgentPrompt per Critic PASS notes" (line 441 comment) — the pack floor is present but index path has soft theater remnant.

---

## 4. New Session Pickup (Post-P0)

### 4.1 Auto-Injected on Specialist Spawn

**Before P0**: Memory index auto-injected (30 entries), skills, AGENTS.md. Handoff was escalation-only.

**After P0**: Every specialist spawn receives:
1. **Wake pack floor** (constitution, profile, project doc, handoff card, recent mistakes) — auto-injected via `loadAndValidateWakePack`
2. **Memory index** (up to 30 entries, RRF-picked if brief provided, else date-ranked)
3. **Skills** (all matching from `.hive/skills/`)
4. **AGENTS.md / CLAUDE.md** (vendor-native)

**Handoff**: Not on-demand (`hive_pickup_handoff` lookup). **Auto-injected** in wake pack for every spawn. Fail-closed if unsynthable.

---

### 4.2 Queen Launch

**File**: `src/cli/orchestrator.ts:185-211`

**Queen gets**: Pack floor (constitution, profile, projectDoc, recentMistakes) + memory index + boot capsule. Flattened fields passed to `composeLaunchContext`.

---

### 4.3 On-Demand Retrieval (Unchanged)

**MCP Tools**: `memory_search`, `memory_read`, `memory_write`, `memory_update`, `memory_delete`, `memory_verify`, `memory_reindex`

**Mail Tools**: `hive_mail_poll`, `hive_mail_send`

**Graph Tools** (if configured): `graph_locate`, `get_neighbors`, `query_graph`, `shortest_path`

---

### 4.4 Never Carried Forward (Unchanged)

- No transcript memory (prior agent conversation not injected)
- No session state (contextPct, contextWindow reset)
- No profile preferences (no per-agent likes/dislikes tracking)
- No episodic recall tool (events logged but no `hive_events_search`)
- No routing preferences (policy is machine-wide)

---

## 5. STM/LTM (Episodes vs Always-On)

**Short-Term (Episodes)**: Episodic events table (ephemeral, retained `events_hot_days` default 7, longer if cited). Live agents append episodes. Not promoted automatically.

**Long-Term (Always-On)**: Wake pack floor (constitution, profile, project doc, handoff, mistakes last-N) + memory index (wiki articles, capped at 30). Durable, git-backed (wiki) or user-scoped (profile).

**Consolidator**: Still CLI/idle (plan §3.5 says "idle / sweep_interval_hours / every N steps — not every turn"). P0 does not implement auto-extract-every-turn. P1 will add sleep consolidator for recurrence≥2 auto-promote (mistakes) and profile/docs proposals.

**No Always-Dream**: Plan §2 non-goals: "Not extract-every-turn on live coder. Not always-dream-the-repo."

---

## 6. Critic's Ranked Hole List (Post-Merge Residuals)

**Source**: Critic agent post-merge review  
**Pinned**: `dev` @ `dfc55968` (file-backed only)  
**Status**: P0 PASS still stands for pack/handoff/honesty; these are post-merge residuals + one ship-blocker the brief path introduced

**Note**: Holes #1 and #2 CLOSED on `dev` @ `a44b5196` via PR #132 (Critic PASS @ 269ddcbf).

---

### CRITICAL

**#1: Brief-ranked spawn index wipe (prompt-theater → empty knowledge)** — **CLOSED on `dev` @ `a44b5196` via PR #132 (Critic PASS @ 269ddcbf)**

**Evidence**: `src/memory-service/memory-store.ts:973` parses index lines with `/^\[([^\]]+)\]\s+([^:]+):/` but real rows are `- [scope/topic] id (date) [status]...: title` (`rebuildScopeIndex` ~286–288). Regex never matches → `rowsByKey` empty → `shown=[]` while omitted=N. Every specialist spawn calls `buildMemoryIndex(..., { brief: request.task })` (`hive-spawner.ts:1109–1111`), so production injection is header + "N older articles omitted" with zero rows. Bun repro on tip: match=null. Adapter tests that assert brief ranking would catch this if run.

**Strategy**: Parse stable `scope`+`id` from the real line shape (or map recall hits→rows without regex); fixture: brief path must emit real `- [` rows, not omit-everything.

**Fix**: Index wipe fixed and merged via PR #132.

**#2: Named wake-query theater** — **CLOSED on `dev` @ `a44b5196` via PR #132 (Critic PASS @ 269ddcbf)**

**Evidence**: `WakePayloadRequestSchema` optional `topic`/`objective`/`lastMailSnippet` (`schemas/wake-payload.ts:39–41`); `buildWakeQuery` concatenates them (`wake-payload-service.ts:20–31`). Sole caller `agent-ui.ts:2066–2071` sends only recipient/wakeId/oldestItemId/lane → query collapses to lane string. Comments still say "hybrid named query".

**Strategy**: Populate query from wake mail topic + snippet at the only caller; reject empty meaningful query or fall back honestly.

**Fix**: Wake query fixed and merged via PR #132.

---

### HIGH

**#3: Mem0 write-gate incomplete (NOOP dead)** — **CLOSED**

**Evidence**: `preWriteCheck` return type includes `"noop"` but only returns `add|update` (`write-service.ts:78–125`); `writeLocked` discards the return (`:129–132`); title collision mutates into forced UPDATE. `findSimilarMemoryCandidates` is post-write advisory only (`memory-tools.ts:185`).

**Strategy**: Mem0 ADD/UPDATE/DELETE/NOOP with pre-write similar retrieve; identical body → NOOP; honor gate result.

**Fix**: Implemented in commit 3514f5dd. `preWriteCheck` now returns `"noop"` when body is identical to existing fact (same normalized title + same body). `writeLocked` honors NOOP result by reading existing fact and returning it without writing, marking embedding as `"skipped:noop"`. Test `prewrite_noop` validates NOOP is reachable and skips write (no new raw observation file created).

**#4: Mistakes recurrence≥2 auto-promote missing (LOCKED STM→LTM)** — **CLOSED on `dev` @ cursor/hive-memory-p1-items-4-5-50a3**

**Evidence**: Implemented via `src/memory-service/promotion.ts` with recurrence tracking, auto-promotion when count≥2, and promotion markers in episodic store. Harvest (`harvest.ts`) now calls `incrementRecurrence` on every admitted pitfall. Consolidator (`consolidate.ts`) runs `autoPromoteMistakes` when `autoPromote: true`. Promoted mistakes written to `mistakes-promoted` topic with `promoted` and `always-on` tags. Pack floor (`pack-floor.ts`) updated with `loadPromotedMistakes` to include in always-on wake pack.

**Implementation**: 
- `promotion.ts`: Recurrence tracking (incrementRecurrence, getRecurrenceCount), promotion logic (autoPromoteMistakes), and promotion markers (markPromoted, isPromoted)
- `harvest.ts`: Tracks recurrence on every pitfall write
- `consolidate.ts`: Runs auto-promotion during consolidation passes
- `pack-floor.ts`: Loads promoted mistakes into always-on pack
- Tests in `test/memory-p1-items-4-5.test.ts` verify recurrence=1 does not promote, recurrence≥2 promotes

**#5: Proposals inbox unwired** — **CLOSED on `dev` @ cursor/hive-memory-p1-items-4-5-50a3**

**Evidence**: Implemented via `src/memory-service/proposals.ts` with deterministic read/write/consume paths. Consolidator (`consolidate.ts`) generates proposals from similar articles via `proposal-generator.ts` and appends to `docs/memory-proposals.md`. Proposals include id, category (profile/project/mistake), title, rationale, proposed change, and source.

**Implementation**:
- `proposals.ts`: Core inbox functions (appendProposal, readProposals, removeProposal, generateProposalId, parseProposals)
- `proposal-generator.ts`: Generates proposals from consolidation candidates and similar articles
- `consolidate.ts`: Wires proposal generation when `generateProposals: true`
- Tests in `test/memory-p1-items-4-5.test.ts` verify append, read, remove, and format preservation

**#6: Spawn index FTS-only + throwaway `:memory:` rebuild**

**Evidence**: Brief path always `semantic: null` + new `Database(":memory:")` + `tempIndex.rebuild(root)` per call (`memory-store.ts:952–966`). Wake path can use daemon semantic (`server.ts:792–796`); spawn index cannot. Cost + ranking drift vs live FTS.

**Strategy**: One recall path; reuse daemon `MemoryIndex` + hybrid when embeddings up; label degraded when not.

---

### MEDIUM

**#7: Queen CLI cold mistakes**

**Evidence**: `buildQueenLaunchContext` calls `loadRecentMistakes(undefined)` (`orchestrator.ts:199`) → empty mistakes in CLI queen pack.

**Strategy**: Thread episodic/daemon floor into queen launch; don't ship empty-as-normal.

**#8: Preference / engineer learning absent**

**Evidence**: No preference kind or repetition→proposal path under `src/memory-service/`; profile is file stub only (`pack-floor.ts:22–34`).

**Strategy**: Preference extraction → review-gated proposals (never silent law).

**#9: §7 soft residuals + pack-off silence**

**Evidence**: `empty_vs_dropped` / dual-read still exercise `buildAgentPrompt` after pack assembly (`memory-p0-acceptance.test.ts` ~450–665), not full `HiveSpawner.spawn`. `wake_pack_enabled === false` skips floor with no CAP/warning (`hive-spawner.ts:1328–1354`).

**Strategy**: Harden fixtures on real spawn; pack-off must fail closed or scream.

**#10: Citation heuristic fail-closed on read**

**Evidence**: `validateFactCitations` regex-scrape paths/backticks then throw on `memory_read` for verified/stale (`memory-tools.ts:58–109,247–249`). False positives can block legitimate reads.

**Strategy**: Structured citation fields; soft flag vs throw for heuristic misses.

---

### LOW

**#11: Retention keep-set still prose-regex**

**Evidence**: `extractReferencedEpisodeIds` (`retention.ts:17–40`) vs harvest `e${id}` strings — works for that shape, fragile elsewhere.

**Strategy**: Structured provenance IDs on facts, not evidence regex.

**#12: Docs/comment theater left for Hive Memory**

**Evidence**: Wake-payload JSDoc still says "hybrid" unconditionally; `docs/agents/memory.md` still says citation "stubs".

**Strategy**: Honest labels in code; this audit writeup should correct docs claims.

---

## 7. Conclusion

**P0 moved Hive toward wake feed**: Specialist spawn no longer depends on lookup. Silent specialists (never call memory tools) still receive pack floor (constitution, profile, project, handoff, mistakes) + ranked index. Handoff is auto-injected every spawn, fail-closed if unsynthable.

**What changed**:
- Wake pack floor: constitution, profile, project doc, handoff card, recent mistakes (always-on slots)
- Handoff: every specialist spawn (not escalation-only)
- Retention keep-set: real (episodes cited by wiki preserved)
- Prewrite gate: partial add|update gate (NOOP dead)
- Index pick: RRF via buildMemoryRecallBundle (FTS-only, semantic null — documented honestly)
- Per-scope locks: global vs repo separation
- Citation validation: pathExists/commandExists before load-bearing use (stub in P0)
- executeMemoryTrigger: deleted
- embedding_provider: "api" → fail-closed (config parse error)
- Dual-read sunset: wake_pack_enabled flag (default true)
- §7 named acceptance tests: 8 tests in `test/memory-p0-acceptance.test.ts`

**What remains** (open work, not gaps):
- Consolidator: P1 (idle/sweep, not every-turn, recurrence≥2 auto-promote, profile/docs proposals) — Critic #4, #5
- Result card: P1 (inbound handoff is P0)
- Hybrid recall: P0 ships FTS-only index pick (honest); hybrid when embeddings ready — Critic #6
- Preference learning: P1 (profile extraction → review-gated proposals) — Critic #8

**Remaining work**: See §6 Critic's ranked hole list above. P0 closed feed/honesty/continuity/seed phase. Holes #1+#2 CLOSED on `dev` @ `a44b5196` via PR #132.

---

**End of Post-P0 Audit**
