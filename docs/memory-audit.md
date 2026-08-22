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
5. **Prewrite gate** in write-service (ADD/UPDATE/NOOP dedup)
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
2. **P0**: `MemoryWriteService.preWriteCheck` normalizes title, searches for duplicates → returns ADD/UPDATE/NOOP (`write-service.ts:79-130`)
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

**P0**: `MemoryWriteService.preWriteCheck` implements ADD/UPDATE/NOOP write-gate:
1. Normalize title (lowercase, strip punctuation)
2. Search for existing fact with same normalized title
3. If found → return `"update"` (set supersedes field)
4. Else → return `"add"`

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

## 6. Open Residuals for Critic

(Short section; Critic owns full ranked list)

1. **empty_vs_dropped soft theater**: Index→buildAgentPrompt path still has soft prompt theater remnant per Critic PASS notes. Pack floor is real but index injection has legacy phrasing.

2. **FTS-only index path**: `buildMemoryIndex` uses semantic: null explicitly (honest, but single-leg RRF). Plan calls for hybrid when embeddings ready, but P0 ships FTS-only.

3. **Consolidator not shipped in P0**: Plan §4 P1 item. P0 has prewrite gate, but no idle consolidator job for recurrence≥2 auto-promote or profile/docs proposals.

4. **Result card on return**: Plan §3.10.5 says "result card on specialist return: P1 acceptable if inbound card is P0." P0 ships inbound handoff; outbound result card is P1.

Before claiming other plan P1+ items as missing, verify against `docs/memory-plan.md` §4 phases.

---

## 7. Conclusion

**P0 moved Hive toward wake feed**: Specialist spawn no longer depends on lookup. Silent specialists (never call memory tools) still receive pack floor (constitution, profile, project, handoff, mistakes) + ranked index. Handoff is auto-injected every spawn, fail-closed if unsynthable.

**What changed**:
- Wake pack floor: constitution, profile, project doc, handoff card, recent mistakes (always-on slots)
- Handoff: every specialist spawn (not escalation-only)
- Retention keep-set: real (episodes cited by wiki preserved)
- Prewrite gate: ADD/UPDATE/NOOP dedup before write
- Index pick: RRF via buildMemoryRecallBundle (FTS-only, semantic null — documented honestly)
- Per-scope locks: global vs repo separation
- Citation validation: pathExists/commandExists before load-bearing use (stub in P0)
- executeMemoryTrigger: deleted
- embedding_provider: "api" → fail-closed (config parse error)
- Dual-read sunset: wake_pack_enabled flag (default true)
- §7 named acceptance tests: 8 tests in `test/memory-p0-acceptance.test.ts`

**What remains** (open work, not gaps):
- Consolidator: P1 (idle/sweep, not every-turn, recurrence≥2 auto-promote, profile/docs proposals)
- Result card: P1 (inbound handoff is P0)
- Hybrid recall: P0 ships FTS-only index pick (honest); hybrid when embeddings ready
- empty_vs_dropped soft theater: pack floor real, index path has legacy phrasing per Critic notes

**Remaining work**: Critic hole list (separate doc) + plan P1+ items. P0 closed feed/honesty/continuity/seed phase.

---

**End of Post-P0 Audit**
