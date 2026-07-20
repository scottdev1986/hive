# M3-S3.6 — Observational retrieval core (L0 projections + L1 scoped index)

Milestone: M3, retrieval track. GitHub issue: **not yet carded** — queen cards this story after the doc lands.
Origin: research recommendation adopted by the user **2026-07-20** (the hybrid ruling). Skeleton from `planning/2026-07-20-observational-data-retrieval-research.md` §7 (lena, S3.6 sketch); grafts from `planning/2026-07-20-observational-data-retrieval-greenfield.md` §4.3 (priya). This doc promotes those into a story; it invents no new scope.
Status: **ADOPTED for planning, not yet ratified for execution.** Depends on S3.1. Scoped against `planning/terminal-ownership-methodology.md` §4a (EFFICIENCY, incl. the 16 GB hardware floor) and §4b (PROJECT ISOLATION).

## Why

S3.6 is the queen-facing **read side** the methodology's §4a promise needs and S3.1 does not supply: *queen answers "what is agent X doing / what happened" quickly, at low token cost, without interrupting the agent* (methodology §1, §4a). It builds the two cheapest retrieval layers:

- **L0 — typed projections.** The cheapest read is one nobody computes at read time. "What is X doing now", "what landed", "who is blocked", token spend collapse to reading a maintained typed row — no scan, no LLM, no ranking — carrying its own source/freshness/confidence (StatusEnvelope v2, S2.3). `hive_status` is this pattern in miniature. This is where the bulk of queen's day-to-day questions terminate.
- **L1 — project-scoped index with bounded excerpts.** Point queries ("did anyone touch the quota tables?", "when did lena's rebase fail?") cost O(matches × excerpt window), not O(journal), over label-scoped SQL + FTS5 `snippet()`-class windows with a hard, server-enforced token budget.

It also consolidates the per-instance fragmentation (a prior incident read per-instance DBs as data loss) into one project-keyed store, and it carries three of priya's five green-field grafts (cheap-reader escalation, frozen-prefix cache discipline, local reranker). Isolation is a **hard boundary, not a best-effort filter** (methodology §4b).

## Scope boundary

In scope:
- **Per-project observation store** under `~/.hive/projects/<hiveUuid>/` consolidating events, envelopes, digest metadata, and archived-journal references for one project; a respawned instance reads prior sessions' data (kills per-instance fragmentation).
- **L0 typed projections** maintained as left-folds over the event stream (agent-now, what-landed, who-blocked, token spend), each labeled source/freshness/confidence.
- **L1 query tool** — one queen tool with declared query classes (at minimum: agent-now, agent-history, fleet-summary, point-search); every class carries a **server-enforced token ceiling**; truncation is reported in-band, loudly.
- **FTS index** over text-bearing typed surfaces (envelope previews, event descriptions, status reports) with bounded excerpts; terminal journal content indexed **only post-ANSI-strip and only for archived generations** — the live rolling window is served by `hive_terminal_observe`, not by search.
- **Cheap-reader escalation for forensic dives** (priya graft 1 / D3): the deep-dive class spawns a project-scoped cheap reader sub-agent that returns conclusions + citations, never raw bytes into queen.
- **Frozen-prefix cache discipline** (priya graft 3 / D5) as a **tested** acceptance criterion.
- **Local cross-encoder reranker now** (priya graft 5 / D7); embeddings gated behind measured need.
- **Two-way nonce isolation test** with positive controls (lena §5).

Out of scope (named so it is not silently absorbed):
- **Session digests and lifecycle policy** — that is S3.7 (L2+L3).
- **The durable storage substrate** — checksummed journal outside worktrees, content object store, v2 envelopes, retention/GC hooks are **S3.1**; S3.6 is the read side over that substrate.
- **An embedding / dense index** — deferred behind a measured gap (see DoD 7); adopted here only if S3.6's own numbers show a question class L1 cannot answer within budget.
- **Scaling engines** — Tantivy over FTS5, DuckDB, Parquet, sealed segments (priya D6) are the **named scaling route, measured-trigger-only, not built now** (see Blocker 2).

## Definition of done (numbered acceptance criteria)

Each criterion restates the HARD PRINCIPLES that apply (external research drives; external citations; no legacy shims; production-grade; **project-agnostic** — works on any repo/stack; paired SPEC + doc-cleanup, docs describe behavior not file paths; **LIVE PROOF to close**). Per methodology §4a: every efficiency claim carries a **measured** token-cost AC (graphify precedent), and every performance / memory / latency AC states its **16 GB floor-machine bound** (base 14" MacBook Pro, M1 Pro, 16 GB).

1. **Per-project store consolidation — live-proven across a restart.** Events, envelopes, digest metadata, and archived-journal references for a project consolidate under `~/.hive/projects/<hiveUuid>/`; a **fresh instance reads a prior session's data** after a daemon restart. Live proof that the fragmentation is gone: a row written by run-A is read by run-B, not "lost" per-instance.

2. **One query tool, declared classes, server-enforced ceilings — MEASURED.** At minimum agent-now, agent-history, fleet-summary, point-search; each class carries a server-enforced token ceiling; truncation is reported in-band, loudly (the institutionalized form of graphify's `token_budget: 16000` — a default that silently cuts the payload is a named failure mode). **Measured token-cost AC:** for a scripted session corpus, publish measured tokens per query class **vs. the raw-journal baseline** for the same questions; the story states its reduction target and measurement method up front.

3. **L0 projections are deterministic and freshness-honest — floor-bounded.** Projections are maintained left-folds carrying source/freshness/confidence (S2.3); a read is fixed and small — no scan, no LLM, no ranking. **Floor bound:** projection resident-set and read latency measured on the 16 GB floor machine **under sustained fleet load** (agents running, builds churning), not a cold single-shot.

4. **L1 bounded-excerpt index — floor-bounded.** FTS over text-bearing typed surfaces with `snippet()`-class windows capped at a stated per-call token budget; journal content indexed only post-ANSI-strip and only for archived generations (the raw byte stream is escape-sequence-dense and would poison a tokenizer). **Floor bound:** index size and index-resident memory measured on the floor machine; index build is background, off any agent-felt path.

5. **Cheap-reader escalation for forensic dives — MEASURED** (priya graft 1). The deep-dive class spawns a project-scoped cheap reader sub-agent with manifest-pruned seek tools; the reader returns conclusions + citations only — **never raw bytes into queen** (context-rot: stuffing answers *worse*, not just costs more). **Measured token-cost AC:** reader-token cost and queen-token delta vs. a stuffing baseline, published; the reader's resident-set + latency stated on the floor machine if it runs locally.

6. **Frozen-prefix cache discipline — TESTED** (priya graft 3). Queen holds **one byte-stable frozen prefix** (tools + system + a small per-project card) under a 1-hour-TTL cache breakpoint; volatile data never enters the prefix; answers are appended after it. This is an acceptance criterion with a test, not a note: `cache_read_input_tokens > 0` is **asserted in the suite** (a single stray timestamp in the prefix silently re-bills the corpus at full price every turn).

7. **Local cross-encoder reranker now; embeddings gated — floor-bounded.** Adopt the index-free local cross-encoder reranker (priya graft 5); it is the cheapest accuracy lever and needs no embedding index. **Floor bound:** reranker resident-set + per-query latency measured on the 16 GB floor machine. The embedding/dense index stays **behind a measured gate** — built only if S3.6's measured numbers show a class of question L1+rerank cannot answer within budget (the incremental's own gate, unchanged).

8. **Live proof of non-interruption.** Queries are answered while a target agent is **mid-turn**; the agent's transcript and PTY show **zero injected bytes** — a positive readback, not absence-of-error (measure the state, do not infer it from a clean query return).

9. **Absent-vs-empty discipline.** Every class distinguishes "no matches" from "surface absent / rotated / unbuilt"; a **positive control** in the suite proves the reader can see a positive before any negative is trusted (an all-empty result is usually a bad key, not an empty world).

10. **Two-way nonce isolation test with positive controls** (lena §5; methodology §4b). Initialize Hive in throwaway projects A and B with nonces `N_A`, `N_B` embedded in journaled output, status reports, and a memory article. *Positive control:* in A, every query class finds `N_A` (a class that cannot find its own nonce disqualifies the run). *Isolation assertions:* in B, every class returns zero hits for `N_A`, `grep -r` over B's entire scope finds no `N_A` bytes, and the mirror holds for `N_B` against A — **storage and query asserted separately**. Query scoping is a project binding the **daemon derives from the requesting instance's own identity, never from a caller-supplied parameter**; there is no cross-project query surface at all. Green in CI, both directions.

## Live-proof requirements

- Non-interruption is proven on a **live mid-turn agent** with a positive PTY/transcript readback (zero injected bytes) — not inferred from a clean return.
- Token-cost numbers are **measured on a real scripted corpus**, published, with the reduction target and method stated up front (graphify precedent).
- The isolation test runs **two-way in CI against two throwaway projects, with positive controls** — a query class that cannot find its own nonce fails the run.
- Every performance / memory / latency figure is measured **on the base 14" MacBook Pro (M1 Pro, 16 GB), under sustained load** — or explicitly modeled against it, never certified only on faster hardware.

## Current completion state

- **Not started.** The hybrid recommendation was adopted 2026-07-20; this story is the normative carrier for the L0+L1 half. **Not yet carded** — queen cards it after this doc lands.
- **Substrate primitive already in production:** Hive runs FTS5 today for compiled-memory search (`memory_fts` in `hive.db`), so the L1 engine and its bounded `snippet()` windows are proven local machinery, not a new dependency.
- **Depends on S3.1** for the durable read substrate (storage half of L3, write side of L0, the bounded-read primitive L1 consumes). Like S3.1, S3.6 can start daemon-side during M2.

## Open blockers (explicitly named)

1. **S3.1 dependency.** L0's projection write side, L1's bounded-read primitive, and the archived-generation index all sit on S3.1's substrate (v2 envelopes, content object store, checksummed journal outside worktrees). S3.6 cannot close before that substrate exists, though daemon-side work can begin in parallel during M2.
2. **Scaling-engine trigger is unset — measured-trigger-only.** FTS5 + per-instance SQLite are within measured comfort at Hive's current scale (hundreds of K docs, not 10M). **Tantivy** (Lucene-class BM25, ~2× Lucene throughput) is the **named migration**, built only when a **measured number** — FTS5 index size or query latency crossing a stated threshold — demands it. Not now; both designs keep truth append-only so the migration stays open.
3. **Reduction target and measurement corpus not yet pinned** (AC 2, AC 5). The story must state its per-class reduction target and the scripted-corpus method before the measured ACs can be graded; that pinning is the first execution step, not a runtime discovery.
