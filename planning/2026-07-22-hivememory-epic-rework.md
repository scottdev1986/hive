# HiveMemory epic — memory-system rework and implementation plan

Date: 2026-07-22. Status: PROPOSED, awaiting user ratification.
External driver: "I gave my local agent a real memory, and it finally stopped forgetting everything between sessions" (XDA, 2026-07-21 — https://www.xda-developers.com/gave-my-local-agent-a-real-memory-stopped-forgetting-everything-between-sessions/). User directive 2026-07-22: rewrite all memory stories as a standalone **HiveMemory** epic; full rework taking the article's lessons adapted to Hive; queen AND agent integration — agents share knowledge and learn from past mistakes; must integrate with Claude Code, Codex, Kimi Code, Grok CLI, and opencode.

This doc supersedes the memory scope of `planning/story-m3-s36-retrieval-core.md` and `planning/story-m3-s37-digests-lifecycle.md` (board #71, #72). Their storage-substrate dependency (S3.1) and efficiency/isolation principles (methodology §4a/§4b/§4c, 16 GB floor, measured ACs, live proof to close) are RETAINED unchanged.

## User rulings (2026-07-22, second pass)

- **R1 — Agent-facing confirmed.** The episodic store is for ALL agents, not queen-only. (HM-1 scope stands as rewritten.)
- **R2 — Fresh start, no legacy migration.** The new memory system starts empty; existing `.hive/memory` corpora are not migrated and current-system pitfalls are explicitly out of scope. Hive rebuilds memory from scratch once HiveMemory lands. No back-compat or migration machinery is owed.
- **R3 — Health probe: research-driven.** Best-solution mandate, not a specific design (see §7-D2).
- **R4 — Dedup is required, research-driven.** Duplicate memory is a named failure mode; the dedup strategy is set by research, not deferred (see §7-D1).

## 1. What the article proved (and what we adopt)

The article's architecture (episodic DB + curated Markdown) independently converges on the split Hive already has — the signal value is in its **operational** findings, measured against a real local agent:

- **A1 — Recitation is not compliance.** The model quoted the memory protocol verbatim, then ignored it; context-file instructions lost to the vendor's own system prompt every time. What worked was triggers invoked **in the user turn** ("recall", "note this", "document this:"). *Adopt: memory surfacing is system-triggered, never prose-requested. Every recall path in HiveMemory is initiated by Hive (injection) or the user/queen (trigger), never left to agent goodwill.*
- **A2 — Saves volunteer; recalls must be summoned.** The model stored facts unprompted but never once recalled unprompted. *Adopt: writes stay agent-initiated (they work); recall is always summoned — spawn, wake, task-assignment, or explicit trigger.*
- **A3 — Provenance faking is the real failure mode.** The agent read project files and presented them as "relevant memories"; the author's defense was checking for real tool-call blocks. *Adopt: Hive already specifies hint-not-authority + provenance pointers + positive readbacks (S3.7); extend to a machine-checkable `source: memory` vs `source: repo` discipline and drill-down live proof.*
- **A4 — Prose fences are worthless for destructive ops.** The danger shelf (`delete_note`, `memory_cleanup`) held only because the permission config gated it. *Adopt: destructive memory ops move behind hard capability gates — `memory:delete` becomes its own capability, delete requires reference-check, and agent roles lose delete entirely (queen/operator only).*
- **A5 — The friendly health check lied.** HTTP "healthy" while embeddings silently degraded to hash pseudo-embeddings; only the strict CLI check told the truth. *Adopt: HiveMemory ships a memory self-test that performs actual recalls (positive controls), not liveness pings — the same nonce pattern S3.6 already specifies for isolation.*
- **A6 — Semantic dedup is worth having.** The episodic server flatly refused a duplicate fact. *Adopt: dedup check on the write path (title/FTS now, semantic when A7 lands).*
- **A7 — Local embeddings are cheap and viable.** sqlite-vec + ONNX ran fine locally. *Adopt: semantic layer stays behind the measured gate (S3.6 stance), with the article as external evidence the 16 GB floor can carry it.*

## 2. Target architecture — three layers, one surface

HiveMemory unifies today's curated wiki with the planned observational store into ONE memory system with three layers, all behind the existing daemon MCP endpoint (one loopback HTTP server, per-agent Bearer capability auth — no second server):

- **L-curated — the wiki (exists).** `raw/` immutable observations compiled into `wiki/` articles, repo + global scopes, verified/stale/superseded/conflicted. Unchanged mechanics; the durable, human/queen-curated truth.
- **L-episodic — the fact/event store (absorbs S3.6 + S3.7, now agent-facing).** Typed projections (L0), bounded-excerpt index (L1), session digests (L2), tiered retention (L3), bi-temporal records. Per-project store under `~/.hive/projects/<hiveUuid>/`. Queen AND agents query it, scoped by instance identity, never caller-supplied project params.
- **L-pitfall — mistakes/lessons (NEW).** A first-class memory class for "we burned ourselves before": incident-derived and agent-reported pitfalls with provenance (incident doc, journal range, failing commit). Sourced from `docs/incidents/`, session harvest (§4 HM-3), and direct agent reports. Pitfalls ride the wiki's verification mechanics and are the highest-priority injection class at recall time (§3).

Design rule (SPEC decision 5, retained): memory holds narrative truth not derivable from the repo; the injected surface is an accuracy budget, not merely a cost budget.

## 3. Summoned recall (the core rework)

Today recall happens exactly once: a newest-30 index appended to the first prompt. HiveMemory replaces "hope the agent searches" with four summoned paths:

1. **Spawn injection, relevance-ranked (rework).** The flat newest-30 cap becomes: pitfalls matching the assignment's file/topic scope → task-relevant articles (FTS match on brief) → newest fill. Same token budget, ranked not chronological.
2. **Wake injection (NEW).** On wake/resume/message delivery (S3.2 wake budgets consume this), the daemon injects a bounded memory delta: articles changed since the agent's last turn + pitfalls scoped to the current task. Delivered through the existing `hive_send` lane so it needs **no vendor hook support** (Grok has none).
3. **Trigger protocol (NEW, article A1).** User/queen-invoked triggers honored across all vendors: "recall: <q>" (daemon runs search and injects results), "note this: <fact>" (write observation), "document this: <topic>" (curated article). Implemented in the delivery layer so user-turn invocation outranks ambient context, per A1.
4. **Agent-initiated search (exists, kept).** `memory_search`/`memory_read` stay available; A2 says they'll be used for saves and explicit lookups, and we don't rely on them for recall.

## 4. Implementation plan (phases, each with measured ACs on the 16 GB floor)

- **HM-0 — Contracts and capability split.** `memory:delete` capability carved out of `memory:write`; agent roles lose delete (queen/operator only); `MemoryPitfallSchema` and pitfall class added; trigger protocol spec'd in the delivery contract; MCP tool surface finalized (below). AC: schema tests; a writer-role agent is hard-denied delete (config gate, not prose — A4).
- **HM-1 — Episodic store + unified retrieval (absorbs #71/S3.6).** Per-project store consolidation, L0 projections, L1 bounded-excerpt index, cheap-reader escalation, frozen-prefix cache discipline, local reranker, two-way nonce isolation — all as specced in S3.6 — **plus**: agent-facing query classes (`my-history`, `project-search`, `pitfall-check`) scoped by instance identity. ACs: S3.6's measured token-cost and floor-bound criteria, exercised by a live agent of each wired vendor, not just queen.
- **HM-2 — Digests, lifecycle, and mistake harvest (absorbs #72/S3.7).** S3.7 unchanged (fresh-summarizer digests, exact-value side tables, bi-temporal columns, tiered retention, WorkManifest reference-check) **plus**: the harvest pipeline — at session end/landing/kill, the fresh summarizer extracts candidate pitfalls (failed approaches, burnt-by-X lessons) with provenance pointers; candidates enter the wiki as `unverified`, promoted by queen/human verification. AC: a seeded session with a known failure yields a provenance-bearing pitfall candidate; drill-down live proof from pitfall → journal range (S3.7 DoD 10 pattern).
- **HM-3 — Summoned recall (§3).** Relevance-ranked spawn injection; wake-delta injection over the send lane; trigger protocol end-to-end. ACs (live, per vendor): an agent whose task matches a 60-day-old pitfall receives it at spawn without any search call (A2); a "recall:" trigger from queen returns results in-transcript; Grok (no hooks) receives wake deltas — proving injection never depends on vendor hook support.
- **HM-4 — Vendor coverage (5 vendors).** Claude/Codex/Grok ride existing config writers (headersHelper / bearer_token_env_var / static TOML header — the memory tools extend the one `hive` MCP server, so no new delivery shape is needed). Kimi Code + opencode adapters land with #63 and MUST deliver the same MCP shape + receive spawn/wake injection; their memory conformance joins the M2-style proof matrix. AC: memory conformance suite green on every factory-supported vendor.
- **HM-5 — Semantic layer, measured-gated.** Local embeddings via **fastembed-js + sqlite-vec** (bge-small-en-v1.5, ~100–300 MB RSS warm — D4), hybrid FTS+vector retrieval, and cosine-threshold dedup as an **offline consolidation pass** (reject ≥0.95, suggest-merge 0.85–0.95 — D1 layer 3, never inline). Built only if HM-1's measured numbers show a question class FTS+rerank can't answer in budget; floor-bound RSS/latency ACs (A7). Strict self-check required (A5): the health probe must verify real embedding recall, not endpoint liveness.
- **HM-6 — Guardrails and health.** Delete reference-checks (WorkManifest + wiki `raw:` links); **write-path dedup layers 1–2** (normalized-hash exact match → reject/update; FTS5 similar-candidates returned in the write response for the agent to resolve — D1); **golden-canary self-test** (`hive memory self-test`: ~30 planted canaries across all three layers, recall@5 = 100% asserted, cross-project negative controls, dedup round-trip — D2) wired into CI; audit logging for all destructive ops.
- **HM-exit — docs/README/SPEC reconciliation** (standing rule): SPEC decision 5 rewritten for the three-layer model; `docs/agents/memory.md` updated; this doc folded per the karpathy-llm-wiki skill.

## 5. MCP surface (target)

Existing (kept): `memory_search`, `memory_read`, `memory_write` (wiki layer).
Changed: `memory_delete` → `memory:delete` capability, queen/operator only.
New: `memory_recall` (trigger-backed, scoped query returning ranked articles+pitfalls with token ceiling), `memory_note` (lightweight episodic fact write with dedup-refusal response), `memory_pitfall` (report/search pitfalls), `memory_digest` (session digest read with drill-down pointers), `memory_promote` (queen/operator-only pitfall promotion to global scope with redaction check — D3). All server-enforced token ceilings; truncation loud; capability-gated per role.

## 6. Board mapping

- #71 → rewritten as **HiveMemory — HM-1 episodic store + unified queen/agent retrieval**.
- #72 → rewritten as **HiveMemory — HM-2 digests, lifecycle, mistake harvest**.
- New issues: HM-3 summoned recall; HM-4 vendor coverage; HM-5 semantic layer; HM-6 guardrails/health; epic tracker. Label: `HiveMemory`.
- M3 exit (#75) unchanged; HM-exit lands before it or folds into it.

## 7. Decisions (research-backed, 2026-07-22 — supersedes the open questions)

Research: Mem0 (arXiv:2504.19413), Zep/Graphiti (arXiv:2501.13956), Letta, LangMem, OSS MCP memory servers (Engram, claude-memory), RAG production-eval literature, fastembed/sqlite-vec ecosystem.

- **D1 — Dedup is a layered write-path gate, shipping in HM-6 (NOT gated on embeddings).** Layer 1: normalized title/content-hash exact match → update-in-place or hard reject (free, catches the common agent-write dup). Layer 2: FTS5 bm25 top-k candidates returned **in the write tool's response** — "these N records look similar; re-issue as update(id) or confirm add" — Mem0's LLM-mediated decision but using the calling agent as the LLM, zero extra model calls. Layer 3 (lands with HM-5 embeddings): numeric cosine thresholds (reject ≥0.95, suggest-merge 0.85–0.95, per Engram/claude-memory precedent) as an **offline consolidation pass, never inline** in the write path. Bias toward duplicate bloat over false merges (false merges destroy information irreversibly; Zep resolves contradictions by temporal invalidation, not merging). Pitfall class: append + `superseded_by` links only, never merge — lessons keep their history. Warning from Mem0's production audit: LLM-mediated dedup does not prevent garbage writes (97.8% junk auto-extraction observed) — the fresh-summarizer + verification gate stays the quality boundary.
- **D2 — Health = golden-canary recall test in CI, not liveness.** `hive memory self-test`: plant ~30 canary facts spanning all three layers (wiki, episodic, pitfall) with known query→expected-result pairs in a fixture store; assert recall@5 = 100% on canaries (planted — anything less is a real defect); negative controls assert no cross-project leakage (doubles as the isolation test); dedup round-trip assertion (same fact written twice → one record). Deterministic, no LLM, seconds in CI. A separate non-gating harness with a larger corpus evaluates ranking changes (thresholds, hybrid weights) before they ship; re-run after any embedding model/index change (embedding-drift guard).
- **D3 — Cross-project sharing: explicit promotion only, pitfalls only.** No automatic promotion, no shared read scopes (OWASP MCP names context over-sharing; hard isolation stands). `memory_promote` is a human/queen-approved copy of a *generalized pitfall* into the global scope with `origin_project` provenance metadata, after a redaction check (paths, hostnames, credentials, project names). Facts and raw events are never promoted. Agents read global + own project, never siblings.
- **D4 — Embeddings: local-only fastembed-js + sqlite-vec, manual API override.** bge-small-en-v1.5 (~67 MB, 384-dim) or all-MiniLM-L6-v2; ~100–300 MB RSS warm, single-digit-ms per short record — trivial on the 16 GB floor, so NO automatic fallback machinery (build it only if telemetry says otherwise). `embedding_provider: local | api` is a manual config knob (CI/low-spec escape hatch). The Haiku-class API knob belongs to the offline consolidation/dedup decision where model quality actually matters, not to embedding. Hybrid FTS+vector is the target — embeddings buy paraphrase-level dedup and recall, not correctness.
- **D5 — Slotting: HiveMemory runs as its own track.** HM-0/HM-6 contracts (capability split, dedup layers 1–2, self-test harness) start immediately against the current substrate; HM-1 sequences after M3-C0A (#18) lands; HM-2→HM-3→HM-4 follow; HM-5 builds only when HM-1's measured gate opens.
- **D6 — Wake recall budget: 300-token default, named config** (from the original §7 proposal; tunable, changes loud).

## 8. Implementation record (2026-07-22, all on main, not pushed)

User directive overrode D5 slotting: everything built immediately on the daemon's current data sources, not gated on #18. Commits in order:

- `bd8ee599` HM-0: `memory:delete` capability split; `kind: pitfall` article class.
- `8488eb8e` HM-6: reference-checked delete (supersedes-dangle; WorkManifest check TODO(#18)); dedup layers 1–2.
- `9104f525` HM-6: golden-canary `hive memory self-test` + CI wiring.
- `1c24dc70` HM-3: relevance-ranked spawn injection.
- `4cc0a414` HM-1 WP1: per-project episodic store (`~/.hive/projects/<hiveUuid>/episodic.db`), bi-temporal facts, failure-isolated ingestion.
- `dd51eb11` HM-1 WP2: L0 projections + `memory_query` (9 classes, server-enforced budgets, identity-derived scoping, two-way nonce isolation suite).
- `b76d22a4` HM-2 WP3: tiered retention sweeps, `[memory.retention]` named config, stale-demotion, digest-provenance reference check.
- `ab299bff` HM-2 WP4: **deterministic** session digests (rolling re-synthesis, exact-value side tables, drift audit) + `memory_digest` with drill-down.
- `a6cb2dc3` HM-2 WP5: pitfall harvest pipeline (failure clusters → unverified provenance-bearing candidates; dedup-aware updates) + `memory_pitfall`.
- `8678cc89` HM-3 WP6: wake-delta injection (per-agent high-water marks, `[memory] wake_budget_tokens` default 300, send-lane + resume delivery, no vendor hooks).
- `805b6d23` HM-3 WP7: `recall:`/`note this:`/`document this:` trigger protocol (queen/operator only, enforced at daemon).
- `55557440` fix: spawn index reads the primary checkout (`.hive/memory` is gitignored — worktrees never had it; production bug found during WP6).
- `c5075d41` + `de4fd022` HM-4/§5: `memory_note`, `memory_recall`, `memory_promote` (redaction-checked, operator/queen tier) + static vendor conformance suite (claude/codex/grok).
- `be7da723` HM-5 core (gate waived by user directive): local fastembed embeddings (bge-small-en-v1.5 default, `[memory] embedding_provider`/`embedding_model` knobs, models cached under `~/.hive/models`), `memory_embeddings` vector store in the episodic DB (schema v2), RRF hybrid FTS+vector recall bundle, unavailable-degrades-to-FTS-only; live paraphrase-recall gate env-gated (`HIVE_LIVE_MEMORY_EMBEDDINGS=1`).

**Deviations from the phase plan, ratified by build:**

1. **HM-1 built on current stores** (status-store events, observation audit, token-usage) rather than #18's envelope substrate. When #18 lands, ingestion gains envelope/journal sources; the store schema and query surface are unaffected.
2. **Digests are deterministic structured folds**, not LLM summaries (recorded in `episodic-digest.ts` header). Stronger on provenance and drift-audit; the 7–8B distiller remains a measured upgrade, not a replacement assumption.
3. **High-water marks are per-scope log-entry counts**, not timestamps — wiki log entries are day-granular, so timestamps can't sequence same-day writes.
4. **HM-4 shipped as a static conformance matrix**; live-agent proofs stay environment-gated (`HIVE_LIVE_MEMORY_CONFORMANCE=1`), and kimi/opencode rows join with #63.
5. **HM-5 built by directive, gate waived** (2026-07-22): the measured gate (HM-1 numbers proving an FTS-unanswerable question class) never formally opened — the user directed the build. Measured on this machine: ~360 MB warm RSS delta (above D4's 100–300 MB estimate, trivial on the 16 GB floor), ~39 ms per short-record embed, ~8 ms brute-force scan over 5k vectors (`scripts/memory-embedding-bench.ts`). sqlite-vec was dropped from the D4 stack — brute-force cosine in JS at these corpus sizes needs no native dep. Core landed in `be7da723` (fastembed bge-small, RRF hybrid recall, unavailable-degrades-clean, live paraphrase-recall proof env-gated); consolidation + canary extension in `3488a49e` (`hive memory consolidate` report-first with `--apply` superseding only ≥0.95 identicals, retention-sweep candidate counts, self-test `semantic-recall` + `consolidation-dry-run` assertions with honest SKIP-when-unavailable semantics). Note: Bun `bun test` + onnxruntime-node SIGTRAPs at process teardown — real-model tests use the explicit-exit pattern and run targeted, never in flagged full-suite runs. Also not built: LLM distiller; cheap-reader escalation and local reranker from the S3.6 sketch (queen-scale infrastructure, needs live queen workloads to measure against).

**Outstanding ACs before cards can close:** measured token-cost numbers per query class (needs a scripted session corpus run), live per-vendor proofs (HM-3/HM-4), WorkManifest reference-check (#18), docs reconciliation (HM-exit → #75).
