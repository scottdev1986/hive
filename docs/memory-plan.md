# Hive Memory Change Plan (LOCKED)

**Owner:** Hive Memory  
**Audience:** CEO → cloud implementers on `dev`  
**Status:** LOCKED — Research YES (4 deltas); Critic objections 1–4 closed; cheap 5–9 folded.  
**Constraints:** Project-agnostic (any software factory). Zero customer/repo-specific content. Documents land only under existing `docs/` (`docs/memory-plan.md`, `docs/memory-proposals.md`, updates to `docs/agents/memory.md`). No new directories. No Hive app code from this room.

**Evidence base:** Critic holes 1–16 (dev @ a296526 / main @ 86ab8e01); audit PR #128 as inventory only; Research brief 21 Aug 2026 + addendum. Do not copy killed audit verdicts (C1, dead doorkeeper, no hybrid, self-verify, events never retrieved).

**Pinned paths**
- User profile (always-on, not git): `~/.hive/profile.md`
- Mistakes ledger (default repo): `.hive/memory/wiki/mistakes/ledger.md` (runtime) with compound promotions into committed `docs/` or `AGENTS.md`
- Plan doc (committed): `docs/memory-plan.md`
- Review-gated proposals (committed): `docs/memory-proposals.md`
- Project conventions: existing `AGENTS.md` / `CLAUDE.md` / committed `docs/` (read at seed; Hive does not invent project content)

---

## 1. Goals

1. **Wake without lookup** — A specialist that never calls a memory tool still behaves correctly on constitution, engineer prefs, project conventions, and the last-N do-not-do ledger.
2. **Session continuity** — Every specialist spawn / routine respawn gets a compiled handoff card (not only quota-drain), auto-injected. Fail-closed or auto-synth from assignment if handoff missing.
3. **Learn mistakes** — Typed failures become short ledger lines (and optional skills). Auto-promote to always-on after recurrence ≥ 2. Deadly rules → hooks.
4. **Learn the engineer** — User-scoped always-on `~/.hive/profile.md`. Never in episodic RAG. Never in the committed project pack. Profile/docs changes are review-gated; proposals land in `docs/memory-proposals.md`.
5. **Learn the project** — Short committed convention surface. Compound lessons into `docs/` or `AGENTS.md`.
6. **STM/LTM like practice** — Episodes = effortful STM. Always-on files = cheap LTM. Sleep consolidator promotes (recurrence / importance / human approve). Not extract-every-turn. Not always-dream-the-repo.
7. **Honest forget** — Replace+pointer, down-rank, redact, precedence. Retention keep-set is real.
8. **Deterministic feed** — Queen/mail wake uses real recall with a named query construction. Never newest-10 with semantic hardcoded off. Never silently drop the memory pack/index.

## 2. Non-goals

- Graph-as-repo-brain. Keep graphify optional for code locate; not LTM.
- Vendor LoCoMo / LongMemEval / DMR as acceptance scores.
- Cursor Memories / Windsurf Cascade product designs.
- Always-extract-every-turn on the live coder. Mem0 ADD/UPDATE/DELETE/NOOP is the **write-gate**, not extract-every-turn.
- Always-dream-the-repo (sleep-time SWE caveat: can regress at high test-time budgets).
- Project-specific templates or one-repo conventions baked into Hive.
- Mixing engineer prefs into the git pack.
- Markdown as a security boundary (deadly rules → hooks).
- New top-level directories or `docs-*` folders.
- Keeping dead `executeMemoryTrigger` protocol (P0: **DELETE** it and its dead delivery comments; do not half-wire).

## 3. Architecture

### 3.1 Always-on wake pack

Target budget: under ~200 lines / 25 KB or Codex 32 KiB — flat tax.

| Slot | Path / source | Writer | Wake? |
|------|---------------|--------|-------|
| Constitution | product standards already loaded | humans / release | Always (floor) |
| Profile | `~/.hive/profile.md` (user) | human; consolidator **proposes** only | Always when non-empty (floor slot reserved) |
| Project | seeded from `AGENTS.md` / `CLAUDE.md` / committed `docs/` gotchas | human + consolidator proposals → `docs/memory-proposals.md` then human apply | Always after P0 seed (floor) |
| Mistakes | repo ledger last N; user ledger only for personal bans | harvest + consolidator; auto-promote recurrence ≥ 2 | Always last N (floor) |
| Handoff card | session; every specialist spawn / routine respawn | orchestrator; auto-inject; if missing → auto-synth from assignment or fail-closed | Always when spawning specialist (floor) |
| Memory index | existing wiki index (≤30, RRF-picked) | memory_write + consolidator | Always with CAP if truncated (floor: never silent zero when store non-empty) |
| Bodies | wiki articles | on-demand `memory_read` / search | On demand |

### 3.2 Ordered drop list (Critic #11 closed)

When over `QUEEN_LAUNCH_CONTEXT_MAX_ESTIMATED_TOKENS` / spawn budget, drop in this order only:

1. Optional graph brief extras / verbose narration  
2. Non-floor mail/board prose beyond refs  
3. Extra index rows beyond a minimum shown set (emit CAP with omitted count)  
4. **Never drop (floor):** constitution, profile slot, project slot, mistakes last-N, handoff card (when spawning), and the in-prompt CAP/index warning itself  

**Empty vs dropped:** If the store is non-empty and the pack/index was truncated or omitted, the prompt **must** contain an explicit `CAP CROSSED` (or equivalent) listing what was omitted. Silent zero when store non-empty is a bug. Acceptance: `empty_vs_dropped`, `queen_budget_cap_signal`.

### 3.3 P0 non-empty pack seed (Critic objection 2)

On first pack compile / migration:

1. **Project** — Read-only import from existing `AGENTS.md`, `CLAUDE.md`, and short committed `docs/` gotchas if present. Do not invent. If none exist, project slot is an explicit empty stub with in-prompt note (not silent absence).
2. **Mistakes** — Distill last-N from **verified** pitfalls into ledger lines (not event dumps). Harvest of **typed** failures writes ledger lines (unverified) immediately; auto-promote to always-on after recurrence ≥ 2.
3. **Profile** — May start empty. Human-edited `~/.hive/profile.md`. No silent scrape.
4. Dual-read old index + new pack until pack is default; **sunset dual-read** behind a version flag after one release cycle (Critic cheap item).

### 3.4 Episodes (STM)

Keep episodic events. Live agents append episodes + inbox. They do **not** edit always-on LTM in the hot path. Surface search honestly on whatever MCP `dev` ships (document six-tool surface; restore `memory_query` only as an explicit P1 if needed).

### 3.5 Sleep consolidator (LTM writer)

Idle / `sweep_interval_hours` / every N orchestrator steps — **not** every turn. **Not** always-dream-the-repo.

Promotion: recurrence ≥ 2 (mistakes auto-promote), importance threshold, predictable-future-query, **human approve** for profile and committed docs (proposals → `docs/memory-proposals.md`, always-on visible list, not silent merge).

Outputs: profile proposals; project lines into proposals; mistakes ledger lines; optional skill/runbook.

Report-first; `--apply` for identical-bucket only (existing consolidate posture).

### 3.6 Retrieval

- Spawn/queen: pack floor + RRF-picked index (use hybrid path in `recall.ts`, not `significantTokens`).
- Mail/queen wake **query construction (named):**  
  `query = join_nonempty(wake.lane, wake.oldestItemTopicOrSubject, assignment.objective, lastControlMailSnippet≤200chars)`  
  Run `buildMemoryRecallBundle(query)` with hybrid when embeddings ready; partition to `wake_budget_tokens`.  
  `semantic` must be `hybrid` | `degraded:<reason>` | `disabled` only when provider config says so — **never** hardcoded `"disabled"` while local embeddings are ready.  
  Not date-ranked newest-10.
- Article bodies remain on-demand; must-know facts live in the pack.
- **P0: DELETE `executeMemoryTrigger`** and dead "daemon executes recall:/note this:" delivery claims. Preview may keep literal-query detection for UX only.

### 3.7 Write policy

- Pre-write retrieve-similar → ADD / UPDATE / DELETE / NOOP (**write-gate**). Live coder does not extract-every-turn.
- Shared/committed tier: proposals + review, never silent load-bearing prefs/conventions.
- One lock **per scope root**.
- Compound across machines via committed `docs/` / `AGENTS.md`, not gitignored wiki alone.

### 3.8 Mistakes → ledger + hooks

- Harvest stays wired (doorkeeper live).
- Typed failures → one ledger line: `do_not: <rule>; failed <date>; see episode E…`
- **Auto-promote** to always-on mistakes slot after recurrence ≥ 2.
- Default scope: **repo**. User scope only for personal tool/taste bans.
- Deadly rules: hooks. Markdown is not enforcement.
- Untyped failures: skip honestly.

### 3.9 Forget / retention / citations

- Real keepIds from ledger/pitfall provenance **or** invalidate-don't-delete for cited hot events. Stop passing `new Set()`.
- Contradiction: replace + pointer.
- Citation before load-bearing apply: **path-exists** (and command-exists if claim names a binary) check in code against the worktree/repo — not prompt-theater. Fail → treat as stale/unverified.
- `embedding_provider: "api"` → config parse error until implemented.

### 3.10 Handoff (P0)

Every specialist spawn / routine respawn:

1. Prefer durable handoff bundle when present.
2. Else **auto-synth** from assignment: `{ goal: assignment.objective|task, constraints: from pack mistakes+profile slice, mistakeIds: last-N ids, files: ≤3 paths from assignment/board, branch/worktree pointers }`.
3. **Auto-inject** into wake pack (not `hive_pickup_handoff` lookup).
4. If neither durable nor synthable (no assignment/task text) → **fail-closed** (refuse spawn with explicit error), not cold empty.
5. Result card on return: P1 acceptable if inbound card is P0.

### 3.11 Multi-agent

Shared project layer + private STM + shared lesson store. Specialists do not inherit orchestrator full episode. Shared write stores that see untrusted input: read-restricted or review-gated.

---

## 4. Phases

### P0 — Feed, honesty, continuity, seed

1. Wake pack floor + ordered drop list + CAP signals (`empty_vs_dropped`).
2. **Seed non-empty pack:** project from AGENTS.md/CLAUDE.md/docs; mistakes last-N from verified pitfalls (distill); typed harvest → ledger lines; profile may be empty.
3. **Handoff card every specialist spawn / routine respawn** — auto-inject; auto-synth or fail-closed.
4. RRF for index pick (not shallow tokens).
5. Queen/mail wake: named query construction; real recall; no hardcoded semantic disabled; not newest-10.
6. Retention keep-set fixed.
7. Pre-write ADD/UPDATE/DELETE/NOOP write-gate.
8. Per-scope locks.
9. `api` provider fail-closed.
10. **DELETE `executeMemoryTrigger`** (and lying docs/comments).
11. Citation path-exists check stub on load-bearing recall apply path (minimum viable).
12. Dual-read pack+index with explicit sunset flag.
13. Docs: cloud-write this file to `docs/memory-plan.md`; create `docs/memory-proposals.md` stub.

### P1 — Consolidator and compound

1. Sleep consolidator (idle/sweep; not every-turn; not always-dream-the-repo).
2. Mistakes recurrence ≥ 2 auto-promote; profile/docs proposals → `docs/memory-proposals.md` (review-gated, always-on list).
3. Compound apply path into committed `docs/` / `AGENTS.md` (human/CEO).
4. Hooks for deadly ledger rules.
5. Result card on specialist return.
6. Full citation re-validate beyond path-exists if needed.
7. MCP surface honesty / optional `memory_query` restore.

### P2 — Polish

1. Prefs proposals from repetition (never silent law).
2. Optional Aider-class repo map (not a KG).
3. Dreams-class pack rewrite on conflict (budget-aware).
4. Temporal KG only if product asks people/decisions/time.
5. Metrics: silent-specialist hit rate, consolidator apply rate, ledger reuse, keep-set violations = 0.
6. Remove dual-read after sunset.

---

## 5. File touch list (indicative)

**Docs only:** `docs/memory-plan.md`, `docs/memory-proposals.md`, fix prompt-theater claims in `docs/agents/memory.md`.

**Spawn/wake:** `agent-prompt.ts`, `launch-prompt.ts`, `hive-spawner.ts`, `queen-boot-capsule-service.ts`, `wake-payload-service.ts`, `wake-prompt.ts`, `agent-ui.ts`.

**Memory:** `memory-store.ts`, `ranking.ts`, `recall.ts`, `recall-preview.ts`, `memory-tools.ts`, `write-service.ts`, `harvest.ts`, `retention.ts`, `episodic.ts`, `consolidate.ts`, jobs/retention-service, `embeddings.ts`.

**Daemon:** `server.ts` (handoff every spawn; DELETE trigger; harvest stays).

**Schemas/config:** prefer separate profile file over new MemoryKind; `config-schema.ts`.

**Hooks/skills:** deadly-rule hooks; `hive-memory` skill stays judgment-only, not the sole wake path.

---

## 6. Migration

1. Wiki remains on-demand LTM archive.
2. Seed project + mistakes as in §3.3.
3. Profile empty until human writes `~/.hive/profile.md`.
4. Doorkeeper/harvest history preserved; ledger additive.
5. Feature flags: pack compile, wake recall, pre-write gate, consolidator apply, dual-read.
6. Dual-read sunset: one release cycle, then pack-primary.

## 7. Named acceptance tests (must appear in CI)

| Test id | Asserts |
|---------|---------|
| `spawn_pack_silent_specialist` | Specialist with memory_* tools denied/unused still follows pack project+mistakes fixtures |
| `queen_budget_cap_signal` | When over budget, prompt contains CAP listing omissions; floor slots present |
| `empty_vs_dropped` | Non-empty store + omitted index ⇒ CAP; empty store ⇒ explicit empty, not identical to dropped |
| `wake_semantic_not_hardcoded` | With local embeddings ready, wake `semantic` ≠ hardcoded `"disabled"` |
| `wake_not_newest10` | Wake ranking follows recall bundle for constructed query, not pure date desc top-10 |
| `handoff_every_spawn` | Non-drain specialist spawn includes auto-injected handoff or synth; missing assignment fail-closed |
| `prewrite_dedup` | Near-duplicate write takes UPDATE/NOOP/DELETE path; no silent second article |
| `scope_lock` | Global write does not acquire `<repo>/.hive/memory.lock` |
| `retention_keepset` | Events cited by active ledger/pitfall provenance are not deleted by sweep |
| `api_provider_fail_closed` | `embedding_provider: "api"` fails config parse / startup |
| `consolidator_not_hotpath` | Consolidator not invoked from `memory_write` hot path; idle/sweep only |

Also: zero project-specific strings in product fixtures beyond generic AGENTS.md samples; docs only under `docs/`.

## 8. Critic holes → plan

| # | Hole | Address |
|---|------|---------|
| 1 | STM→LTM opt-in | Sleep consolidator; recurrence≥2; not every-turn; not always-dream |
| 2 | Lookup-or-forget bodies | Pack for must-know; DELETE executeMemoryTrigger |
| 3 | No prefs | `~/.hive/profile.md` |
| 4 | Post-write gate | Pre-write write-gate |
| 5 | Harvest dumps | Ledger lines + hooks; recurrence promote |
| 6 | Empty keep-set | Real keepIds |
| 7 | Citation theater | path-exists check |
| 8 | Cold respawn | Handoff every spawn in **P0**; synth/fail-closed |
| 9 | Manual consolidate | Sleep job |
| 10 | Shallow 30 | RRF |
| 11 | Queen drops index | Ordered drop list + floor + CAP |
| 12 | Machine-local wiki | Compound to docs/AGENTS.md |
| 13 | Global via repo lock | Per-scope lock |
| 14 | Wake semantic off | Named query + real recall |
| 15 | API theater | Fail closed |
| 16 | Retired digests | Keep-set fix |

## 9. Research deltas (folded)

1. Handoff in P0 — yes.  
2. Mistakes default **repo** — yes.  
3. Mem0 = write-gate not extract-every-turn — yes.  
4. Do not always-dream-the-repo — yes.

## 10. CEO next step

Cloud-write this LOCKED text to **`docs/memory-plan.md`** only. Stub **`docs/memory-proposals.md`**. Spawn implementers on `dev` against P0 acceptance tests above. No new directories.
