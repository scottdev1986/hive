# Memory Audit: Complete Map of How Hive Remembers

**Auditor**: Claude Sonnet 4.5 (Cloud Agent)  
**Date**: 2026-08-21  
**Owner**: Scott Kellar  
**Scope**: Complete inventory of every memory surface, storage mechanism, and injection path in Hive  
**Mandate**: Honest map of what exists, plus concrete holes. No implementations. No refactors.

---

## Executive Summary

Hive has **seven distinct memory systems** with different lifecycles, scopes, and injection mechanics. The architecture is split between:
- **Durable, git-backed markdown** (wiki articles, raw observations)
- **Runtime SQLite state** (agent records, mail, routing policy, embeddings, events)
- **Per-spawn injection** (memory index, skills, AGENTS.md)
- **Cross-session coordination** (mail queues, wake payloads)

**Key finding**: Memory is *partitioned* rather than unified. A new session gets:
1. Automatic: memory index (capped at 30 entries), skills, AGENTS.md
2. On-demand: `memory_read`, `memory_search` tools, `hive_mail_poll`
3. Never: prior agent transcript, session-specific context, routing preferences

**Biggest gap**: No automatic promotion from episodic events to wiki. No agent profile/preference memory. No codebase learning beyond manual `memory_write`. Session continuity depends entirely on mail + worktree state.

---

## 1. Memory Surface Inventory

### 1.1 Durable Wiki Memory (`.hive/memory/` and `~/.hive/memory/`)

**Files**: `src/memory-service/memory-store.ts`, `src/schemas/memory.ts`

**Structure**:
```
<scope>/
├── raw/<topic>/<observation>.md      # Immutable evidence
└── wiki/
    ├── <topic>/<article>.md          # Compiled knowledge
    ├── index.md                       # Always-injected index
    └── log.md                         # Operation log
```

**Scopes**:
- `repo`: `.hive/memory/` — project-specific knowledge
- `global`: `~/.hive/memory/` — machine-wide knowledge

**Schema** (`MemoryFact`):
- `id`, `scope`, `topic`, `title`, `body`, `tags`
- `date`, `path`, `source` (init|agent|orchestrator|user|legacy)
- `evidence`, `status` (verified|unverified|stale|conflicted)
- `kind` (article|pitfall)
- `supersedes` (array of prior article IDs)
- `raw` (array of raw observation pointers)
- `verified` (ISO date when verified)
- `author` (who wrote it, for dedup)

**Index Cap**: `MEMORY_INDEX_MAX_ENTRIES = 30` (line 80, `memory-store.ts`)  
**Pitfall Min**: 8 entries, **Article Min**: 8 entries

**Write Path**:
1. Agent calls `memory_write` MCP tool
2. Daemon validates schema, deduplicates by author
3. Writes to `wiki/<topic>/<id>.md` with frontmatter
4. Appends immutable observation to `raw/<topic>/`
5. Rebuilds `wiki/index.md` (capped)
6. Updates FTS index + embeddings (if available)
7. Logs operation to `wiki/log.md`

**Read Path**:
- `memory_read(scope, id)` — fetch full article
- `memory_search(query)` — FTS + optional semantic

**Injection**:
- **Spawn brief**: `buildMemoryIndex` reads `wiki/index.md` from both scopes, caps at 30 total rows, injects as JSON in agent prompt (`src/daemon/spawn/agent-prompt.ts:69-83`)
- **Wake payload**: `WakePayloadService` builds date-ranked 10-most-recent slice capped to `wake_budget_tokens` (default 800), sent to queen on wake (`src/daemon/wake-payload-service.ts:21-108`)

**Holes**:
- **Promotion**: No automatic episodic→wiki promotion. All wiki writes are manual `memory_write` calls.
- **Staleness**: Articles demote to `stale` after `stale_after_days` (default 90), but `stale` articles stay in index — no re-verification nudge.
- **Dedup**: FTS similarity candidates are advisory only (`memory-tools.ts:103-115`). No enforcement.
- **Verification**: `verified` date set on write, but no required verification workflow. Agents can mark own writes `verified` without peer review.

---

### 1.2 Memory Configuration (`.hive/config.toml`)

**File**: `src/memory-service/memory-config.ts`

**Schema**:
```toml
[memory]
wake_budget_tokens = 800
embedding_provider = "local"  # or "api"
embedding_model = "BAAI/bge-small-en-v1.5"

[memory.retention]
events_hot_days = 7
stale_after_days = 90
sweep_interval_hours = 24
```

**CAS Write**: Compare-and-set on revision hash of entire config, inside file lock. Reads revision from file, fences on mismatch, writes atomically (`memory-config.ts:73-129`).

**Holes**:
- **No per-agent budgets**: All agents share same `wake_budget_tokens`.
- **No recency bias**: Retention is time-based only; frequently-referenced articles don't get TTL extension.

---

### 1.3 Full-Text Search Index (In-Memory, Rebuilt on Daemon Start)

**File**: `src/memory-service/fts-index.ts`

**Implementation**: SQLite FTS5 virtual table, porter stemmer, in-memory database (`DROP TABLE IF EXISTS memory_fts` on every build).

**Schema**:
```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  id, scope UNINDEXED, topic UNINDEXED,
  title, body, tags,
  date UNINDEXED, status UNINDEXED, path UNINDEXED,
  kind UNINDEXED, source UNINDEXED,
  tokenize = 'porter'
)
```

**Query**: BM25 scoring, stopword filtering (84 English stopwords), AND/OR pass fallback.

**Rebuild**: `buildMemoryIndex()` reads all `wiki/*.md` files, parses frontmatter, inserts into FTS (`fts-index.ts:219-257`).

**Holes**:
- **Ephemeral**: Index rebuilt from scratch on every daemon start. No persistence.
- **No incremental update**: `memory_write` triggers full rebuild (cheap for <1000 articles, but not O(1)).
- **No ranking tuning**: BM25 with default parameters. No click-through feedback.

---

### 1.4 Semantic Embeddings (Episodic Store)

**Files**: `src/memory-service/embeddings.ts`, `src/memory-service/episodic.ts`

**Storage**: `episodic.db` (per-project, under `.hive/state/<uuid>/episodic.db`)

**Schema**:
```sql
CREATE TABLE memory_embeddings (
  kind TEXT NOT NULL CHECK (kind IN ('article', 'fact')),
  scope TEXT NOT NULL,  -- 'repo' or 'global'
  source_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL,  -- Float32Array as bytes
  embedded_at TEXT NOT NULL,
  PRIMARY KEY (kind, scope, source_id)
)
```

**Models**:
- Local: `BAAI/bge-small-en-v1.5` (384-dim) or `sentence-transformers/all-MiniLM-L6-v2` (384-dim)
- API: Not implemented (parses as `unavailable:disabled`)

**Runtime**: External bundle at `~/.hive/tools/embeddings/`, dynamically imported, integrity-checked against build digest (`embeddings.ts:98-120`).

**Lazy Load**: First `memory_search` loads model (~2s init, ~100-300MB RSS). Daemon start pays nothing.

**Search**: Brute-force cosine similarity in JS. No native vector index (no sqlite-vec dependency).

**Write Path**: `upsertMemoryEmbedding` after wiki write, queued if model loading (`embeddings.ts:54-58`).

**Holes**:
- **No caching**: Embedding recomputed on every article update, even if body unchanged.
- **No incremental reindex**: Model change requires manual `hive memory reindex`.
- **API provider not implemented**: Config accepts `"api"`, but no OpenAI/Cohere integration exists.
- **Brute-force search**: O(N) cosine similarity. Fine for <10K articles, but unscaled.
- **No hybrid ranking**: Semantic and FTS results are separate. No learned fusion.

---

### 1.5 Episodic Events (Per-Project DB)

**File**: `src/memory-service/episodic.ts`

**Storage**: `episodic.db` table `events`:
```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  agent TEXT,  -- nullable: system events have no agent
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  provenance TEXT NOT NULL  -- JSON blob
)
```

**Retention**: Swept after `events_hot_days` (default 7), except events referenced in digests (no digests exist — this is dead code).

**No Promotion**: Events are logged but never compiled into wiki articles. No automatic "what did we learn" distillation.

**Usage**: Logged by daemon (spawn, land, escalation), but not queried by agents. No `hive_events_search` tool.

**Holes**:
- **Write-only**: Events are logged but never retrieved by agents. No episodic recall.
- **No summarization**: No agent can run "what mistakes did I make yesterday" against events.
- **Dead digest table**: `digests` table created but unused (`episodic.ts:133-140`).
- **No promotion**: Events stay ephemeral. No path to "harvest useful observations into wiki."

---

### 1.6 Agent State (Runtime DB)

**File**: `src/daemon/database/schema.ts`

**Tables**:
- `agents`: Per-agent runtime record (id, name, tool, model, liveModel, category, status, contextPct, contextWindow, worktreePath, branch, sessionLocator, quotaReservationId, createdAt, lastEventAt, landedCommit, landedAt, closedAt)
- `agent_name_reservations`: Reserved names (prevents name reuse until holder closes)
- `events`: Token usage events (kind, agentName, timestamp, contextPct, usageUnits)
- `approvals`: Pending tool permissions (status=pending|approved|denied)
- `escalations`: Handoff requests to queen

**Context Tracking**:
- `contextPct`: Nullable float (0-100). **Null = no observation**, not zero.
- `contextWindow`: Measured window size (200K or 1M for Claude). Null until first statusLine.
- `liveModel`: Observed model from transcript. Null = no observation.

**Session Locator**:
- Per-agent `sessionLocator` JSON: `{instanceId, sessionId, generation, kind}`
- Ties agent to terminal host session
- Generation increments on control restart

**No Profile**: Agent record is *ephemeral identity*, not a profile. No preferences, no history carryover.

**Holes**:
- **No session continuity**: Closed agent loses all context. Respawn starts fresh with memory index + worktree, but no "where I left off."
- **No preference memory**: No per-agent or per-category learned preferences (e.g., "alice prefers verbose tests").
- **No delegation history**: No "who worked on what module" tracking for smart routing.

---

### 1.7 Mail System (Inter-Agent Coordination)

**File**: `src/mail-service/store.ts`

**Tables**:
- `mail_items`: Messages (itemId, recipient, sender, lane, topic, body, state, attempts, expiresAt)
- `mail_leases`: Active claim locks (itemId, owner, ownerGeneration, handlerId, leaseUntil)
- `mail_dead_letters`: Failed deliveries

**Lanes**:
- `control`: Design forks, scope changes, blockers → queen
- `work`: Status updates, completion reports → queen or peer

**State Machine**: `available` → `claimed` (lease) → `settled` (ack|nak|retry|discard)

**Merge**: Same sender+topic on `work` lane merges into latest; control lane never merges.

**Idempotency**: `idempotencyKey` deduplicates publishes.

**Wake Integration**: Queen wakes include `mailCounts` (controlAvailable, workAvailable) and triggers `hive_mail_poll` when non-zero.

**Holes**:
- **No threading**: Messages have `topic` but no parent/child links. No conversation reconstruction.
- **No search**: No `hive_mail_search`. Agents must poll+filter.
- **Ephemeral**: Mail in DB is runtime state. No durable archive. Cleared on `hive stop --repo`.

---

### 1.8 Routing Policy (Machine-Wide DB)

**File**: `src/daemon/routing-policy-store.ts`

**Storage**: `~/.hive/hive.db` (machine default home, shared across instances):
```sql
CREATE TABLE routing_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton
  revision INTEGER NOT NULL,
  updatedAt TEXT NOT NULL,
  document TEXT NOT NULL  -- canonical JSON
)
```

**Schema**: Revisioned document with provider enablement + per-category routing + model effort mapping.

**CAS Write**: Compare-and-set on revision, with audit trail in `routing_policy_events`.

**No Per-User**: One policy per machine. No user-specific routing.

**Holes**:
- **No agent-specific routing**: Cannot say "alice uses claude, bob uses codex."
- **No learned routing**: No feedback loop from "which model solved task X faster/better."
- **No task-based tuning**: Routing is by category only, not by task content or git diff size.

---

### 1.9 Skills Directory (Always-Injected Instructions)

**Paths**:
- `.hive/skills/` (repo-scoped)
- `~/.hive/skills/` (global)

**Addressing**:
- `queen/<skill>/SKILL.md` → all queens
- `queen/<vendor>/<skill>/SKILL.md` → that vendor's queen
- `agent/<skill>/SKILL.md` → all agents
- `agent/<vendor>/<skill>/SKILL.md` → that vendor's agents
- `agent/<category>/<skill>/SKILL.md` → agents spawned for that category

**Injection**: All matching skills concatenated and passed to vendor CLI on spawn. Skills are NOT in memory system — they're instructions, not learned facts.

**Holes**:
- **No version control**: Skills in `.hive/skills/` may be gitignored. No "which skill version did agent X see" tracking.
- **No dynamic loading**: Skills baked into spawn. No mid-session skill update.

---

### 1.10 AGENTS.md and CLAUDE.md (Vendor Conventions Files)

**Paths**:
- `AGENTS.md` (root-down-to-cwd, concatenated)
- `CLAUDE.md` (Claude Code only)

**Injection**: Vendor CLI loads these natively. Hive does NOT inject them — the vendor does.

**Not Memory**: These are user-authored, committed instructions. Not agent-learned.

**Holes**:
- **Vendor-specific**: Claude Code reads `CLAUDE.md`, not `AGENTS.md`. Codex reads `AGENTS.md`. Multi-vendor repos need both or symlink.
- **Size cap**: Codex silently truncates at 32 KiB. Claude warns at 200 lines. No Hive enforcement.

---

### 1.11 Graphify Knowledge Graph (Optional MCP Server)

**Files**: `src/adapters/graphify.ts`, `src/daemon/spawn/agent-prompt.ts:169-183`

**Injection**: If graphify configured, spawn brief includes `graphBrief` (task-scoped graph digest) and graph-first directive.

**Not Core Memory**: Graphify is a code-structure index, not a memory system. Agents use `graph_locate`, `get_neighbors`, `query_graph` tools.

**Scope**: Code relationships only. No facts, decisions, or pitfalls.

---

### 1.12 Wake Payload (Queen-Only Memory Delta)

**File**: `src/daemon/wake-payload-service.ts`, `src/schemas/wake-payload.ts`

**Injection**: Queen wakes include:
- `mailCounts`: Available messages by lane
- `memoryDelta`: Date-ranked 10-most-recent wiki slice, capped to `wake_budget_tokens` (default 800)
  - Partitioned into pitfalls + articles
  - Semantic recall leg exists but `state: "disabled"` (line 97)
  - Truncation reported if over budget

**Not a Delta**: Despite name, it's NOT "memory since last wake." It's "most recent N articles, period."

**Holes**:
- **No cursor**: Queen sees same recent slice on every wake, even if already acted on it.
- **Semantic disabled**: `memoryDelta.semantic: "disabled"` hardcoded (line 97). No embedding-powered queen recall.
- **Fixed budget**: 800 tokens for all memory. No priority weighting.

---

## 2. New Session Pickup: What Gets Carried Forward

### 2.1 Automatic Injection (Every Spawn)

**Memory Index** (`buildMemoryIndex`):
- 30-entry cap across repo + global scopes
- Partitioned: ≥8 pitfalls, ≥8 articles, rest by ranking
- Injected as JSON block in spawn prompt
- Warnings if truncated

**Skills**:
- All matching skills from `.hive/skills/` and `~/.hive/skills/`
- Concatenated, vendor-native injection

**AGENTS.md / CLAUDE.md**:
- Vendor loads natively (not Hive)

**Graph Brief** (if configured):
- Task-scoped graph digest

**Learned Verification** (if harvested):
- `memory_write(topic=verification)` article with `command` field
- Injected as standing instruction (`agent-prompt.ts:146-158`)

---

### 2.2 On-Demand Retrieval (Tools)

**MCP Tools** (registered in `memory-tools.ts`):
- `memory_search(query, scope?, kind?, limit?)` → FTS + optional semantic
- `memory_read(scope, id)` → Full article body
- `memory_write(...)` → Write new article
- `memory_update(scope, id, ...)` → CAS update existing article
- `memory_delete(scope, id)` → Delete article
- `memory_verify(scope, id)` → Mark verified by self
- `memory_reindex()` → Rebuild FTS + embeddings

**Mail Tools**:
- `hive_mail_poll(lane)` → Claim + read available messages
- `hive_mail_send(recipient, lane, topic, body)` → Publish message

**Graph Tools** (if configured):
- `graph_locate`, `get_neighbors`, `query_graph`, `shortest_path`

---

### 2.3 Never Carried Forward

**No Transcript Memory**:
- Prior agent's conversation history is NOT injected
- No `memory_read_transcript(agent_id)`
- Handoff protocol exists (`HandoffSchema`) but ONLY for escalation, not routine respawn

**No Session State**:
- Agent's `contextPct`, `contextWindow`, `liveModel` are runtime observations
- New spawn starts with `contextPct: null`

**No Profile**:
- No per-agent preferences ("alice likes verbose", "bob prefers terse")
- No delegation history ("sarah worked on auth module last month")

**No Episodic Recall**:
- Events logged to `episodic.db` but no agent tool to query them
- No "what did I try and fail at yesterday"

**No Routing Preferences**:
- Routing policy is machine-wide, not agent-specific

---

## 3. Short-Term vs Long-Term Memory

**Short-Term** (Ephemeral, Cleared on Stop):
- Agent state (`agents` table)
- Mail items (`mail_items` table)
- FTS index (in-memory, rebuilt on start)
- Terminal sessions (destroyed on close)

**Long-Term** (Durable, Git-Backed):
- Wiki articles (`.hive/memory/wiki/`)
- Raw observations (`.hive/memory/raw/`)
- Skills (`.hive/skills/`, `~/.hive/skills/`)

**Medium-Term** (Durable, DB-Backed):
- Episodic events (`.hive/state/<uuid>/episodic.db`, retained `events_hot_days`)
- Embeddings (`episodic.db`, pruned when source deleted)
- Routing policy (`~/.hive/hive.db`, persists across runs)

**No Promotion Path**: Short-term (events) never automatically becomes long-term (wiki). All wiki writes are manual.

---

## 4. Learning Mechanisms

### 4.1 From Mistakes (Pitfalls)

**Manual Only**: Agent must call `memory_write(kind=pitfall, ...)` after hitting an error.

**Harvest**: Pitfall verification workflow exists (`src/memory-service/harvest.ts`):
- Article `id: "verification-2024-08-01-retry-12345"` in `raw/verification/`
- `verificationCommandFromTitle(title)` extracts command
- Injected as standing instruction if `status: verified`

**No Automatic Extraction**: Daemon doesn't parse failed `hive_land` or test errors into pitfalls.

---

### 4.2 From Codebase

**No Automatic Learning**: No "observe file edits → infer module ownership" or "track test patterns."

**Manual Only**: Agent must run `memory_write(topic=<module>, ...)` after working on code.

**Graphify**: Code structure indexed, but not decisions/patterns. Graph is "what calls what," not "why we chose X."

---

### 4.3 From User Feedback

**No Preference Tracking**: No "user said alice's PR was too verbose → store preference."

**Manual Only**: User must run `hive memory write "Alice prefers terse PRs" --scope global`.

---

### 4.4 Deduplication

**Write-Time Advisory**: `memory_write` returns `similarCandidates` (FTS top-3), but doesn't block write.

**No Enforcement**: Agent can ignore suggestions and write duplicate.

**Consolidation**: `hive memory consolidate` reports similar pairs (cosine >0.9) but requires `--apply` to merge. Never automatic.

---

## 5. Determinism and Race Conditions

### 5.1 Can Two Wakes See Same Memory?

**Yes, if same revision**:
- Wiki is git-backed; same commit = same files
- Memory index built from `wiki/index.md` (deterministic if files unchanged)
- Embedding order is stable (sorted by scope+id)

**No, if memory written between wakes**:
- `memory_write` → `wiki/` file changed → index rebuild → different index
- FTS ranking is deterministic given same corpus
- Semantic ranking is deterministic given same model+vectors

**Queen Wake**: Date-ranked 10-most-recent is deterministic at time `T`, but changes as new articles written.

---

### 5.2 Race Conditions

**CAS Writes**:
- `memory_update` is compare-and-set on file mtime + content hash (`memory-store.ts:503-540`)
- `casWriteMemoryConfig` is CAS on revision inside file lock (`memory-config.ts:73-129`)
- `RoutingPolicyStore` is CAS on revision inside DB transaction (`routing-policy-store.ts:194-231`)

**No Session Races**: Each agent has own worktree. No shared mutable state during execution.

**Mail Races**: Lease-based. `mail_leases` table with `leaseUntil` timestamp. Two agents cannot claim same item.

**Index Rebuild**: `buildMemoryIndex` is NOT atomic. Concurrent `memory_write` + index read can see partial state (old index, new file). Mitigated by "index is advisory" — if stale, agent calls `memory_search`.

---

### 5.3 Prompt Theater

**What is it**: Instructions that tell model "remember X" without a real write path.

**Hive Avoidance**:
- Memory index is INJECTED, not prompted ("remember this list")
- Skills are CONCATENATED, not summarized
- Graph brief is COMPUTED, not described

**One Violation**: Wake payload says "recent wiki slice" but doesn't explain it's date-ranked, not relevance-ranked. Model might infer wrong semantics.

---

## 6. Context Overload: Dump-Everything vs Feed-What-You-Need

### 6.1 Automatic Injection (Spawn)

**Memory Index**: 30 entries, ~900 tokens (flat tax, doesn't grow with store size)

**Skills**: Vendor-dependent. Hive concatenates all matching. Claude recommends <200 lines/skill.

**AGENTS.md**: Codex truncates at 32 KiB. Claude warns at 200 lines. No Hive enforcement.

**Graph Brief**: Task-scoped, bounded by token budget (default 2000 for locate output).

**Total Spawn Brief**: Measured at ~33K tokens for writer agent (cold start cost, per `context-and-recycling.md:63`).

---

### 6.2 On-Demand Pull

**memory_read**: 100-400 tokens per article (paid only when called)

**memory_search**: Returns snippets (160 chars), not full bodies

**hive_mail_poll**: One message at a time (work lane) or all control messages

---

### 6.3 Injection Budget

**Documented Constraint** (`docs/agents/memory.md:82-84`):
> The index tax stays flat while avoided rediscovery grows.

**No Per-Agent Tuning**: All agents get same 30-entry index. No "simple_coding gets 10, complex_coding gets 50."

---

## 7. Sloppy, Incomplete, Unused, or Broken Paths

### 7.1 Semantic Search Disabled for Queen

**File**: `src/daemon/wake-payload-service.ts:97`

**Code**:
```typescript
semantic: "disabled" as const,
```

**Impact**: Queen wakes include `memoryDelta.semantic: "disabled"`. Embedding-powered queen recall exists in schema but hardcoded off.

---

### 7.2 Episodic Digests Table Unused

**File**: `src/memory-service/episodic.ts:133-140`

**Schema**:
```sql
CREATE TABLE digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT,
  session_id TEXT,
  compiled_at TEXT NOT NULL,
  body TEXT NOT NULL,
  provenance TEXT NOT NULL
)
```

**Usage**: Zero writes. Zero reads. Comment says "Retired" (line 116-118).

---

### 7.3 Facts Table Retired

**File**: `src/memory-service/episodic.ts:119-132`

**Schema**:
```sql
CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'decision')),
  ...
  valid_at TEXT NOT NULL,
  invalid_at TEXT,
  expired_at TEXT,
  supersedes_id TEXT REFERENCES facts(id)
)
```

**Usage**: Zero writes. Comment: "Retired: nothing writes the facts or digests tables any more" (line 116-117).

**Intent**: Bi-temporal episodic facts. Superseded by wiki articles.

---

### 7.4 Embedding API Provider Not Implemented

**File**: `src/memory-service/embeddings.ts:65`, `src/schemas/config-schema.ts`

**Config Accepts**:
```toml
embedding_provider = "api"
```

**Reality**: `initializeMemoryEmbedding()` checks `config.provider === "api"` → returns `{state: "unavailable", detail: "embedding-api-provider-not-configured"}` (line 210).

**No OpenAI/Cohere Integration**: Env var `HIVE_EMBEDDING_API_KEY` defined but unused.

---

### 7.5 Memory Admission Doorkeeper Unused

**File**: `src/memory-service/episodic.ts:254-281`, `observeMemoryCandidate()`

**Table**:
```sql
CREATE TABLE memory_doorkeeper (
  signature TEXT PRIMARY KEY
)
```

**Purpose**: Reject duplicate memory candidates based on content hash.

**Usage**: Zero calls in `src/`. Method exists, stats collected, but no caller.

---

### 7.6 No Agent Tool for Episodic Events

**File**: `src/memory-service/episodic.ts:209-225`, `eventsFor()`

**Method Exists**: Query events by agent or since timestamp.

**No MCP Tool**: Agents cannot call `hive_events_search` or `hive_events_for_agent`.

**Impact**: Events are write-only. No "what did I learn from errors" introspection.

---

### 7.7 Handoff Protocol Not Used for Respawn

**Files**: `src/schemas/handoff-schema.ts`, `src/daemon/server.ts:3671-3680`

**Schema**: `HandoffSchema` exists (goal, done, remaining, decisions, failedApproaches, branch).

**Usage**: ONLY in `hive_escalate` path (agent→queen handoff when stuck).

**Not Used**: Routine agent respawn (same category, more context) does NOT use handoff protocol. New agent gets memory index + worktree, no structured "where I left off."

**Intent**: Per `docs/agents/context-and-recycling.md:122`, handoff should carry "what was tried and failed." Not implemented for recycle.

---

### 7.8 Context Percentage Nullable, Not Zero

**File**: `src/schemas/agent.ts:106`

**Schema**:
```typescript
contextPct: z.number().min(0).max(100).nullable(),
```

**Semantic**: `null` = "Hive has not observed it," NOT "context is empty."

**Intentional**: Prevents treating unobserved agent as having room.

**Hole**: Many tools/UIs might render `null` as `0` or `N/A`. No automated recycle actuator exists (per `docs/agents/context-and-recycling.md:157-161`).

---

### 7.9 Learned Verification Limited to One Command

**File**: `src/memory-service/harvest.ts:28-68`, `verificationCommandFromTitle()`

**Injection**: If `memory_write(topic=verification, status=verified)` exists, extract command from title and inject as standing instruction.

**Limit**: ONE command per repo. Second verification article does NOT merge; it supersedes or conflicts.

**No Multi-Step**: Cannot represent "run lint, then test, then type-check."

---

### 7.10 Consolidate Requires Manual `--apply`

**File**: `src/memory-service/consolidate.ts`, `src/cli/memory-consolidate.ts`

**Flow**:
1. `hive memory consolidate` → reports similar pairs (cosine >0.9)
2. User reviews
3. `hive memory consolidate --apply` → merges pairs

**No Auto-Merge**: Intentionally manual. But no "approve this pair" workflow — it's all-or-nothing.

---

### 7.11 Memory Retention Sweep Skips Consolidation Candidates

**File**: `src/memory-service/retention.ts:57-59`

**Code**:
```typescript
if (options.countCandidates !== false) {
  report.consolidationCandidates = countConsolidationCandidates(episodic);
}
```

**Usage**: Consolidation candidate count included in retention report, but never acted on. No nudge to user.

---

## 8. Tests: What Is Covered, What Is Missing

**Total Memory Test Lines**: 4,665 lines (`test/daemon/memory*.test.ts`)

### 8.1 What Exists

**Test Files** (8 files in `test/daemon/`):
- `memory-consolidate.test.ts` — consolidation workflow
- `memory-degradation-visibility.test.ts` — staleness UI
- `memory-embeddings.test.ts` — vector upsert/prune
- `memory-index.test.ts` — index build/cap/warnings
- `memory-jobs.test.ts` — background embedding jobs
- `memory-mcp.test.ts` — MCP tool contracts
- `memory-projections.test.ts` — config CAS writes
- `memory-retention.test.ts` — sweep logic

**Plus**:
- `test/memory-self-test.test.ts` — end-to-end write→search→read
- `test/memory-vendor-conformance.test.ts` — cross-vendor AGENTS.md behavior
- `test/memory-recall-client.test.ts` — recall ranking
- `test/memory-embedding-live.test.ts` — live embedding model tests (skipped in CI)

### 8.2 What Is Missing

**No Tests For**:
- Episodic event→wiki promotion (doesn't exist)
- Memory admission doorkeeper (unused)
- Handoff protocol for respawn (unused)
- Queen wake semantic recall (hardcoded disabled)
- Multi-agent concurrent `memory_write` races
- FTS ranking quality (BM25 tuning)
- Semantic search quality (no golden-set accuracy tests)
- Memory index truncation behavior when >30 entries of equal priority
- Verification workflow (harvest→verify→inject loop)
- Consolidate auto-apply (disabled)

---

## 9. Determinism: Can Two Agents See Same Memory?

### 9.1 Same Commit, Same Daemon

**Yes**: Memory index built from same `wiki/index.md` → same 30 entries → same spawn brief.

### 9.2 Same Commit, Different Daemon

**Mostly Yes**:
- Wiki files are git-backed (deterministic)
- FTS index rebuilt from files (deterministic)
- Embeddings rebuilt from files (deterministic if same model)
- Ranking stable if corpus unchanged

**One Variance**: Embedding model lazy-loads. If model not cached, first daemon pays 2s init. But vectors are identical.

### 9.3 Different Commits

**No**: Memory writes between commits → different files → different index.

### 9.4 Queen Wakes

**No**: Date-ranked slice is point-in-time. Two queen wakes 1 hour apart may see different "10 most recent."

---

## 10. Concrete Holes Ranked by Severity

### CRITICAL

**C1. No episodic→wiki promotion**  
**Files**: None (gap)  
**Impact**: Events are write-only. Agents cannot distill "what we learned from errors" into durable pitfalls. All wiki writes are manual.  
**Evidence**: `episodic.ts:180-196` logs events; zero callers of `eventsFor()` outside tests.  
**Fix**: Background job or `hive_compile_pitfalls` tool to extract error patterns from events.

**C2. No agent transcript/session continuity for respawn**  
**Files**: `src/schemas/handoff-schema.ts` (exists but unused for respawn)  
**Impact**: Respawned agent starts with memory index + worktree, no "where I left off." Must rediscover prior attempts.  
**Evidence**: `docs/agents/context-and-recycling.md:157-161` confirms "no recycle actuator exists."  
**Fix**: Handoff protocol for same-category respawn, not just escalation.

**C3. Semantic recall disabled for queen wakes**  
**Files**: `src/daemon/wake-payload-service.ts:97`  
**Impact**: Queen gets date-ranked slice, not relevance-ranked. May miss critical pitfalls.  
**Evidence**: `semantic: "disabled" as const` hardcoded.  
**Fix**: Enable semantic search for queen, re-rank pitfalls by task relevance.

### HIGH

**H1. No automatic deduplication**  
**Files**: `src/memory-service/memory-tools.ts:103-115` (advisory only)  
**Impact**: Agents can write near-duplicate articles. Consolidation is manual.  
**Evidence**: `similarCandidates` returned but not enforced.  
**Fix**: Block writes above similarity threshold, require explicit supersede.

**H2. No per-agent or per-category memory budget**  
**Files**: `src/memory-service/memory-config.ts:23-30`  
**Impact**: All agents share 30-entry index. Simple agents pay full tax; complex agents may need more.  
**Evidence**: `MEMORY_INDEX_MAX_ENTRIES = 30` global constant.  
**Fix**: Per-category budgets (e.g., `simple_coding: 10`, `complex_coding: 50`).

**H3. No user preference or agent profile memory**  
**Files**: None (gap)  
**Impact**: Cannot track "alice prefers verbose, bob prefers terse" or "sarah worked on auth module."  
**Evidence**: No `profiles` table or `memory_write(scope=user, ...)` flow.  
**Fix**: User-scoped memory + per-agent delegation history.

**H4. Verification limited to one command**  
**Files**: `src/memory-service/harvest.ts:28-68`  
**Impact**: Cannot represent multi-step verification (lint → test → type-check).  
**Evidence**: `verificationCommandFromTitle` extracts single command.  
**Fix**: Array of commands or composite script in `verification` article.

### MEDIUM

**M1. FTS index rebuilt on every daemon start**  
**Files**: `src/memory-service/fts-index.ts:131-140`  
**Impact**: ~200ms startup delay per 1000 articles. Not incremental.  
**Evidence**: `DROP TABLE IF EXISTS memory_fts` on every build.  
**Fix**: Persist FTS to episodic.db, rebuild only on file mtime change.

**M2. Embeddings recomputed on every article update**  
**Files**: `src/memory-service/embeddings.ts:325-358`  
**Impact**: Expensive recompute even if body unchanged.  
**Evidence**: No content-hash check before embedding.  
**Fix**: Hash article body, skip embed if hash unchanged.

**M3. Consolidation is all-or-nothing**  
**Files**: `src/cli/memory-consolidate.ts:45-102`  
**Impact**: User cannot approve/reject individual pairs.  
**Evidence**: `--apply` merges all pairs above threshold.  
**Fix**: Interactive `--approve` mode.

**M4. No multi-agent memory write conflict resolution**  
**Files**: `src/memory-service/memory-store.ts:503-540` (CAS exists, but no merge helper)  
**Impact**: Two agents writing to same article → second agent gets conflict error, no guidance on merging.  
**Evidence**: CAS fences on mtime+hash, but no `memory_merge` tool.  
**Fix**: Three-way merge tool or automatic "append to body" for compatible edits.

### LOW

**L1. Embedding API provider not implemented**  
**Files**: `src/memory-service/embeddings.ts:210`  
**Impact**: Config parses but doesn't work. Misleading UX.  
**Evidence**: `embedding_provider: "api"` → `unavailable` state.  
**Fix**: Implement OpenAI/Cohere embedding API, or remove config option.

**L2. Memory admission doorkeeper unused**  
**Files**: `src/memory-service/episodic.ts:254-281`  
**Impact**: Dead code collecting stats.  
**Evidence**: Zero callers of `observeMemoryCandidate`.  
**Fix**: Remove table or wire it into write path.

**L3. Facts and digests tables unused**  
**Files**: `src/memory-service/episodic.ts:119-140`  
**Impact**: Schema churn, misleading to readers.  
**Evidence**: "Retired" comment, zero writes.  
**Fix**: Drop tables in next schema version.

**L4. No episodic event search tool for agents**  
**Files**: `src/memory-service/episodic.ts:209-225` (method exists, no MCP tool)  
**Impact**: Agents cannot introspect own error history.  
**Evidence**: `eventsFor()` exists, no `hive_events_search` registration.  
**Fix**: Add `hive_events_search(agent?, since?)` MCP tool.

---

## 11. What Is Missing vs Scott's Goals

**Inferred Goals** (from docs and architecture):
1. Durable, git-backed memory that survives daemon restarts ✅
2. Cheap automatic injection (flat tax, not growing with store size) ✅
3. On-demand retrieval (memory_search, memory_read) ✅
4. Deduplication (write policy: never silently write duplicates) ⚠️ Advisory only
5. Staleness handling (demote verified→stale after N days) ✅
6. Provenance (every article links back to raw observations) ✅
7. Multi-vendor support (AGENTS.md + CLAUDE.md) ✅
8. Session continuity (agents pick up where they left off) ❌ **MISSING**
9. Learning from mistakes (pitfalls extracted from failures) ⚠️ Manual only
10. Learning from codebase (module ownership, patterns) ❌ **MISSING**
11. User preference memory (likes/dislikes per agent) ❌ **MISSING**

---

## 12. Summary of File Paths for Every Memory Surface

| Surface | Files | Storage | Scope |
|---------|-------|---------|-------|
| **Wiki Articles** | `.hive/memory/wiki/<topic>/<id>.md` | Git-backed markdown | Repo |
| | `~/.hive/memory/wiki/<topic>/<id>.md` | Git-backed markdown | Global |
| **Raw Observations** | `.hive/memory/raw/<topic>/<obs>.md` | Git-backed markdown | Repo |
| | `~/.hive/memory/raw/<topic>/<obs>.md` | Git-backed markdown | Global |
| **Memory Index** | `.hive/memory/wiki/index.md` | Git-backed markdown | Repo |
| | `~/.hive/memory/wiki/index.md` | Git-backed markdown | Global |
| **Memory Log** | `.hive/memory/wiki/log.md` | Git-backed markdown | Repo |
| | `~/.hive/memory/wiki/log.md` | Git-backed markdown | Global |
| **Memory Config** | `.hive/config.toml` | TOML, CAS writes | Repo |
| **FTS Index** | In-memory SQLite | Ephemeral, rebuilt on start | Daemon |
| **Embeddings** | `.hive/state/<uuid>/episodic.db` table `memory_embeddings` | SQLite, per-project | Project |
| **Episodic Events** | `.hive/state/<uuid>/episodic.db` table `events` | SQLite, per-project | Project |
| **Agent State** | `~/.hive/instances/<instance>/hive.db` table `agents` | SQLite, per-instance | Instance |
| **Mail** | `~/.hive/instances/<instance>/hive.db` tables `mail_items`, `mail_leases` | SQLite, per-instance | Instance |
| **Routing Policy** | `~/.hive/hive.db` table `routing_policy` | SQLite, machine-wide | Machine |
| **Skills** | `.hive/skills/<role>/<vendor>/<category>/<skill>/SKILL.md` | Git or gitignored | Repo |
| | `~/.hive/skills/<role>/<vendor>/<category>/<skill>/SKILL.md` | Filesystem | Global |
| **AGENTS.md** | `AGENTS.md` (root-down-to-cwd) | Git-backed | Repo |
| **CLAUDE.md** | `CLAUDE.md` (root-down-to-cwd) | Git-backed | Repo |
| **Graphify Graph** | Served via MCP, not stored by Hive | External | Repo |
| **Wake Payload** | Ephemeral JSON, built on demand | In-memory | Queen |

---

## 13. Intended vs Actual Behavior Gaps

### 13.1 Memory Index Supposed to Cap Fairly

**Intended**: "If >30 articles, rank and truncate fairly. Pitfalls prioritized."  
**Actual**: `selectMemoryClasses` sorts pitfalls, then articles, applies min thresholds (8 each), fills remaining slots by date desc. Works as intended.  
**Gap**: None. ✅

### 13.2 Semantic Search Supposed to Augment FTS

**Intended**: "Semantic recall improves over FTS."  
**Actual**: Semantic search works for agents but disabled for queen wakes (`semantic: "disabled"`).  
**Gap**: Queen doesn't get semantic recall. ⚠️

### 13.3 Staleness Supposed to Demote, Not Delete

**Intended**: "Stale articles stay visible but flagged."  
**Actual**: `runRetentionSweep` demotes `verified→stale` after `stale_after_days`. Article stays in index. Works as intended.  
**Gap**: None. ✅

### 13.4 Dedup Supposed to Block Duplicate Writes

**Intended** (from `docs/agents/memory.md:64-68`):  
> Write policy — dedup before write, and never silently into the shared tier.

**Actual**: `memory_write` returns `similarCandidates` but doesn't block. Agent can ignore and write duplicate.  
**Gap**: Advisory, not enforced. ⚠️

### 13.5 Handoff Supposed to Enable Respawn Continuity

**Intended** (from `docs/agents/context-and-recycling.md:105-108`):  
> A deep agent's handoff must be reconstructed from sources that cannot have degraded.

**Actual**: `HandoffSchema` exists, used in escalation, NOT in respawn. Respawn gets memory index + worktree, no structured handoff.  
**Gap**: Respawn doesn't use handoff. ❌

### 13.6 Events Supposed to Feed Digests

**Intended**: `digests` table references events for drill-down.  
**Actual**: `digests` table never written. Events retained but not compiled.  
**Gap**: No digest→event link. ❌

### 13.7 Episodic Facts Supposed to Be Bi-Temporal

**Intended**: `facts` table with `valid_at`/`invalid_at` for time-travel queries.  
**Actual**: `facts` table never written. Wiki articles supersede this design.  
**Gap**: Bi-temporal facts abandoned. ⚠️ (Design change, not bug)

### 13.8 Consolidation Supposed to Merge Near-Duplicates

**Intended**: `hive memory consolidate --apply` merges pairs.  
**Actual**: Works, but requires manual `--apply`. No per-pair approval.  
**Gap**: All-or-nothing merge. ⚠️

---

## 14. Prompt Theater: Does Hive Tell Models to Remember Without Real Storage?

**Definition**: Instructions that say "remember this" or "keep track of X" without a write path.

**Hive Avoidance**:
- Memory index is INJECTED as data, not prompted as request
- Skills are CONCATENATED, not summarized
- Graph brief is COMPUTED, not described

**One Gray Area**: Wake payload prompt could be clearer about "this is date-ranked, not relevance-ranked." Model might infer wrong semantics and optimize for recency vs relevance.

**Verdict**: Mostly clean. No egregious "you'll remember this, right?" without a store. ✅

---

## 15. Conclusion

Hive's memory is **partitioned, not unified**:
- **Durable wiki** (git-backed) for long-term facts
- **Ephemeral DB** (agent state, mail, events) for coordination
- **Automatic injection** (memory index, skills) for cold start
- **On-demand tools** (memory_search, memory_read, hive_mail_poll) for deep dives

**Biggest wins**:
1. Index-plus-retrieval keeps spawn brief small (30 entries, ~900 tokens)
2. Git-backed markdown makes memory inspectable/diffable
3. CAS writes prevent lost updates
4. Staleness demotion keeps index honest

**Biggest gaps**:
1. No episodic→wiki promotion (events are write-only)
2. No session continuity for respawn (handoff protocol unused)
3. No user preference or agent profile memory
4. Semantic recall disabled for queen wakes
5. Deduplication is advisory, not enforced

**Scott's decision points**:
- Keep partitioned architecture, or unify into one queryable memory?
- Make dedup enforced, or keep advisory?
- Implement session continuity via handoff, or keep stateless respawns?
- Enable queen semantic recall, or keep date-ranked?
- Auto-promote events→pitfalls, or keep manual?

Every finding above is observable in code or documented behavior. No inventions.

---

**End of Audit**
