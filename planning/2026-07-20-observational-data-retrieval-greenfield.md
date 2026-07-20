# Green-field design: observational-data retrieval for an agent-fleet orchestrator

**Date:** 2026-07-20
**Author:** priya (writer agent), commissioned by the user via queen
**Status:** research deliverable, complete — recommendation: adopt hybrid (see §4.3)
**Mandate:** Second-pass, green-field research. Design the best current-state-of-the-art system for the problem below, from first principles, explicitly NOT anchored on any existing machinery. The comparison against the incremental proposal appears only in the final section, written after the ideal design was complete.

---

## 1. The problem, decomposed

An orchestrator ("queen") supervises a fleet of AI coding agents, each running in a terminal the system fully owns. The system is local-first: one developer machine, no cloud backend. Per project it accumulates four classes of data:

| Class | Nature | Volume shape | Authority |
|---|---|---|---|
| Terminal byte journals | Append-only raw byte streams, one per session | Largest by far; unbounded if unmanaged | Authoritative (what actually happened on screen) |
| Typed lifecycle/status events | Small structured records (spawn, phase, land, death…) | Thousands–millions of rows, small bytes | Authoritative |
| Task/decision records | Structured documents with rationale | Hundreds–thousands | Authoritative |
| Distilled knowledge | Derived summaries/facts | Grows with distillation policy | **Derived — hint only** |

### 1.1 Query taxonomy

The orchestrator's questions fall into distinguishable classes with different freshness, precision, and cost profiles:

- **Q1 — Liveness/now** ("what is agent X doing right now?"): needs seconds-fresh data, tiny answer, asked constantly. Must not interrupt the agent.
- **Q2 — Recent narrative** ("what happened to Y over the last hour/session?"): needs an ordered, causally coherent account, minutes-fresh, asked often.
- **Q3 — Knowledge lookup** ("what do we know about Z?"): needs the current best distilled answer plus provenance, freshness in hours is fine, asked often.
- **Q4 — Forensic deep-dive** ("show me exactly what the agent saw when the build failed"): needs byte-exact ground truth with cheap seeking, asked rarely, may cost more.
- **Q5 — Fleet aggregate** ("which agents touched the config system this week?" / "how much did we spend?"): needs scan/aggregate over structured events, asked periodically.

A design that funnels all five through one retrieval mechanism will be wrong for most of them. The query classes, not the storage, are the primary design input.

### 1.2 Hard invariants (from the problem statement)

- **I1 — Non-interruption:** answering any query must never take an agent's turn, steal its terminal, or perturb its process.
- **I2 — Project isolation:** zero knowledge leakage between projects — enforced by construction (storage layout / process boundary), not by query discipline.
- **I3 — Relevance lifecycle:** an old decision must not silently steer the present; every derived fact carries validity; storage is bounded by explicit tiering/decay, not by hope.
- **I4 — Two-lane truth:** authoritative records (journals, events, decisions) are never mutated by derivation; derived views are hints carrying provenance pointers back to the authoritative lane; when they conflict, the authoritative lane wins mechanically.
- **I5 — Local-first:** commodity developer hardware (laptop-class CPU/GPU, single NVMe), offline-capable, no mandatory cloud dependency; cloud LLM calls are permissible as a *consumer* of retrieval but the store and index must live and work locally.

### 1.3 Cost model to optimize

Two currencies, both scarce:

1. **Orchestrator tokens.** The queen runs on an expensive frontier model. Every byte that enters its context costs input tokens now and (via longer context) latency and cache-write costs later. The design goal is: *minimum authoritative-enough bytes into the expensive context per question class.*
2. **Wall-clock latency of the answer.** Q1 must be sub-second-to-few-seconds; Q4 may take tens of seconds.

Disk is comparatively cheap but not free (I3 forbids unbounded growth); local compute for indexing/distillation is cheap when it's off the queen's critical path.

## 2. State of the art, 2025–2026 (survey with citations)

Method note: five parallel research passes (agent-memory systems; temporal knowledge graphs; retrieval; local storage engines; token/cache economics + sub-agent patterns), web-sourced July 2026, with explicit skepticism applied — vendor-run benchmarks are labeled as such.

### 2.1 Temporal knowledge graphs for agent memory

**Zep/Graphiti** ([arXiv 2501.13956](https://arxiv.org/abs/2501.13956), Jan 2025) is the reference design: a three-tier graph (raw episodes → LLM-extracted entity edges → community summaries) in which every semantic edge is **bi-temporal** — transaction time (`created_at`/`expired_at`) and validity time (`valid_at`/`invalid_at`) — and contradictions are handled by **edge invalidation, never deletion**. Retrieval is hybrid (embedding + BM25 + graph traversal) with no LLM call at query time (P95 ≈ 300 ms per [Neo4j's writeup](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)). Vendor-run results: LongMemEval up to +18.5% accuracy vs full-context while cutting context ~115k → ~1.6k tokens and latency 28.9 s → 2.58 s.

**The benchmark war is a caution, not a verdict.** Mem0 vs Zep degenerated into dueling misconfiguration accusations ([Mem0's correction](https://github.com/getzep/zep-papers/issues/5); [Zep's rebuttal](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)); LoCoMo itself is short enough to fit in context (16k–26k tokens), has ~6.4% data errors, and a plain full-context baseline (~72.9%) beat Mem0's own system (66.9%) in Mem0's own paper. An independent July 2026 review noted "every memory benchmark in this comparison was run by the vendor that wins it" ([The AI Engineer](https://theaiengineer.substack.com/p/cognee-vs-zep-vs-mem0-vs-letta)). No rigorous independent reproduction exists. Notably, Mem0's biggest 2026 gains (self-reported LongMemEval 94.4 @ ~6.8k tokens/query) came from moving to **multi-signal hybrid retrieval, not graphs** ([Mem0 2026 report](https://mem0.ai/blog/state-of-ai-agent-memory-2026)).

**Graph-vs-hybrid measured evidence.** HippoRAG 2 ([arXiv 2502.14802](https://arxiv.org/abs/2502.14802)) is the honest graph system: +3–10 F1 on multi-hop, within noise of a strong embedder on simple QA, at 9.2M indexing tokens vs GraphRAG's 115.5M (12.5×). Systematic evals ([arXiv 2502.11371](https://arxiv.org/html/2502.11371v2); [arXiv 2506.05690](https://arxiv.org/html/2506.05690v1)) find plain RAG beats GraphRAG on factoid retrieval (NQ 68.18 vs 65.44 F1; fact-retrieval 60.92% vs 36.92–60.14%), graphs win only multi-hop/sense-making (~10–15% of queries), graph construction costs 40–57× more wall-clock, and extracted graphs covered only ~65.5% of answer entities. **LazyGraphRAG** ([Microsoft, benchmarked June 2025](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)) won 96/96 BenchmarkQED comparisons with NLP-only indexing at 0.1% of GraphRAG's indexing cost — the strongest evidence that *upfront LLM graph construction was the mistake*. 2026 academic work splits the same way: cheaper TKG construction (ATOM, [arXiv 2510.22590](https://arxiv.org/abs/2510.22590)) vs abandoning explicit graphs ([arXiv 2601.03417](https://arxiv.org/pdf/2601.03417)).

**What survives scrutiny for a local-first system:**
- Bi-temporal validity metadata + invalidate-don't-delete on a **flat fact table** captures the measured temporal-reasoning/knowledge-update wins (Zep's best LongMemEval categories) without entity resolution or traversal. This is cheap: two timestamp pairs and a foreign key to the source episode.
- Provenance by construction — every derived fact keeps a pointer to its source episode; invalidated facts remain queryable (belief-as-of-date reconstruction). Graphiti's episode subgraph translated to relational form.
- Full LLM graph extraction (GraphRAG-style, 115M tokens for an 11k-passage corpus) is flatly unjustifiable on one developer's machine; per-episode LLM extraction cost is exactly the cost that does not scale down.

### 2.2 Agent memory systems and "memory OSes"

The 2025–2026 record is dominated by one negative result and two positive ones.

**The negative result: write-time extraction is lossy and loses.** An independent ablation ([arXiv 2601.00821](https://arxiv.org/pdf/2601.00821), v3 Jun 2026) found **verbatim chunk retrieval beats extracted-fact memory 43.9% vs 28.0% on LoCoMo and 67.4% vs 45.4% on LongMemEval-S; extraction never beat naive RAG**. Mem0's own paper showed its full-context baseline (~73%) beating its own system (~68.5%). The replication scoreboard is grim: Zep 84 → 58.44 corrected ([zep-papers #5](https://github.com/getzep/zep-papers/issues/5)); EverMemOS 92.32 → 38.38 in third-party reproduction; MemPalace's claimed 100% LoCoMo exposed as retrieval bypass ([arXiv 2604.21284](https://arxiv.org/pdf/2604.21284)). Conclusion: derived memories may index and summarize, but must never *replace* raw history.

**Positive result 1: filesystem + grep + a capable agent is a brutally strong baseline.** Letta measured a plain agent on gpt-4o-mini with only file/grep tools at **74.0% LoCoMo — beating dedicated memory vendors** ([Letta blog](https://www.letta.com/blog/benchmarking-ai-agent-memory/)); LongMemEval-V2's plain coding-agent baseline (69.3%) nearly matched the best specialized system (72.5%). Claude Code's CLAUDE.md/auto-memory design is this position productized. Specialized memory architecture only demonstrably pays past ~500K–10M-token horizons (BEAM benchmark; Hindsight's multi-strategy retrieval leads there at 64.1% @10M vs RAG baseline 24.9%).

**Positive result 2: offline ("sleep-time") consolidation works and replicated.** Letta's sleep-time compute paper ([arXiv 2504.13171](https://arxiv.org/abs/2504.13171)): ~5× test-time compute reduction at equal accuracy, +13–18% when scaled. OpenAI rebuilt ChatGPT memory around a background "dreaming" process (Jun 2026) that re-synthesizes and **rewrites time-sensitive memories**, with self-reported recall 41.5% → 82.8% across generations. The pattern that won at planetary scale: background distillation with continuous re-synthesis from retained history — not one-shot extraction.

On forgetting: **no principled TTL/decay policy has strong published evidence**. Deployed practice is heuristic (importance decay, archive-below-threshold). The field's honest answer: keep raw logs, treat staleness of important facts as an *update/supersede* problem (bi-temporal validity), use decay only to demote retrieval priority — never to silently delete.

### 2.3 Retrieval: what actually wins on a local machine

- **Hybrid (BM25 + dense) fused with reciprocal rank fusion, then cross-encoder rerank, is the best-evidenced default.** Tuned hybrid +7.4% nDCG over either leg alone on WANDS; RRF improves over both constituents across all metrics in a 2026 text+table benchmark (+8.1pp Recall@5) ([arXiv 2604.01733](https://arxiv.org/html/2604.01733v1)); reranking is repeatedly the cheapest accuracy lever ([arXiv 2603.08877](https://arxiv.org/pdf/2603.08877)). Open cross-encoders now beat commercial APIs: mxbai-rerank-base-v2 (0.5B, Apache-2.0) at 55.57 BEIR nDCG@10 vs Cohere Rerank 3.5 at 55.39 ([Mixedbread, Mar 2025](https://www.mixedbread.com/blog/mxbai-rerank-v2)).
- **Lexical search is the right first stage for logs.** Log queries are dominated by exact identifiers (error strings, SHAs, paths). Pi-Serini ([arXiv 2605.10848](https://arxiv.org/abs/2605.10848), 2026): a lexical-only retrieval interface + a strong LLM hit 83.1% on BrowseComp-Plus, beating released dense-retriever agents. The agent loop matters more than the retriever; the dense leg pays mainly for paraphrase queries and weaker reader models.
- **Agentic iterative retrieval beats one-shot RAG on multi-source questions, but accuracy plateaus while cost grows linearly** ([arXiv 2509.04820](https://arxiv.org/pdf/2509.04820)) — so cap iterations and make each step cheap with an index. Hybrid semantic+grep cut coding-agent token use ~40% at equal quality in one 2026 eval ([particula.tech](https://particula.tech/blog/semantic-code-search-vs-grep-coding-agents)).
- **Embedding models degrade badly on long inputs** (LongEmbed, [arXiv 2404.12096](https://arxiv.org/abs/2404.12096)): chunk small; never embed whole sessions. Best small local embedders mid-2026: Qwen3-Embedding-0.6B (64.3 MTEB multilingual, MRL-truncatable) or EmbeddingGemma-300m (&lt;200MB RAM).
- **Late interaction (ColBERT-class) buys ~2 nDCG points over same-size single-vector at 10–50× index cost** ([Answer.AI](https://www.answer.ai/posts/2024-08-13-small-but-mighty-colbert.html)) — worth it only as an index-free reranker, not as first stage, locally.
- **Embeddable engines:** Tantivy is Lucene-class BM25 at ~2× Lucene speed (sub-ms–ms at GB scale); SQLite FTS5 is the zero-dependency choice but ~40× lower throughput and 5× larger index than Lucene-class at 500K+ pages; DuckDB FTS is analytical-grade (~0.3–0.5s over 3.8M rows), not interactive-search-grade.

### 2.4 Local storage engines and event-sourcing practice

- **SQLite is the write tier, not the analytics tier.** Measured: WAL + `synchronous=NORMAL` ≈ 33k inserts/s laptop-class, 80–150k rows/s batched ([Turso, Oct 2025](https://turso.tech/blog/beyond-the-single-writer-limitation-with-tursos-concurrent-writes)) — orders of magnitude above a realistic fleet's event rate. But for scans it needed ~19× the storage/IO of columnar in GreptimeDB's edge benchmark.
- **DuckDB is proven at exactly this scale.** ClickBench full run (100M rows, ~14 GB) on a $700 8 GB-RAM MacBook: hot-run median 0.41 s ([DuckDB, Mar 2026](https://duckdb.org/2026/03/11/big-data-on-the-cheapest-macbook)); reads SQLite and Parquet natively; 1.4-LTS added AES-256-GCM whole-database encryption. Caveats that matter: its FTS index is a static snapshot (rebuild-on-schedule artifact), and its vector extension is officially experimental — don't depend on either for the interactive path.
- **Columnar compression on log-shaped data is dramatic.** ClickHouse measures 5–20× typical on logs, up to 170× on parsed nginx logs with column-aware codecs; asciinema measures zstd at ~8% of original (12.5×) on terminal streams. Parquet+zstd is the universally-readable cold format; Lance's ~2000× random-access advantage is real but single-vendor, and raw seeking is better served at the segment layer anyway.
- **The authoritative layer of every serious production log system is the same design:** append-only sealed segments + a manifest. Kafka segments; Honeycomb's Retriever (segments sealed at 1M events/1 GB/12 h, **timestamp range as the only index**, brute-force parallel scan — proof that at tens-of-GB scale you need segment pruning, not inverted indexes); KurrentDB archiving ("keep ≥N days/≥Y bytes locally", transparent read-through). CQRS discipline: projections are disposable read models rebuilt by idempotent replay with checkpoints; deletion/redaction is segment rewrite + reindex, never in-place edit.
- **Terminal recording prior art:** asciicast v3 (asciinema 3.0, Sept 2025) — NDJSON framing with output/input/resize/marker/exit events, interval timing, native zstd; tlog's stance on input capture (off by default — it records passwords) is the field's only serious redaction precedent; WARC's per-record compression + offset index is the model for O(1) seek into byte-exact streams.
- **Content-addressing:** full CAS is unwarranted locally; the cheap borrow is BLAKE3-hashing each sealed segment into the manifest for tamper-evidence and safe GC (iroh-blobs precedent).

---

## 3. The ideal design

Working name: **the Loom** (it weaves five query classes over two lanes of truth). Everything below is per-project by construction (§3.4).

### 3.0 Design theses (each traceable to §2 evidence)

1. **Raw history is never destroyed by derivation** — extraction-as-replacement measurably loses 16–22 points to verbatim retrieval (arXiv 2601.00821). Derived artifacts index and summarize; they never substitute.
2. **Most queries are not retrieval problems.** Liveness, recency, and aggregates are deterministic reads over structured data. Never make a model do what a WHERE clause can (Chroma: focused 300-token prompts beat 113K-token stuffing *universally*).
3. **The expensive model reads distillates; cheap readers read raw.** Anthropic's 90.2%/15× result + RLM's cost-neutral decomposition + a 5–10× per-token price spread make the reader/orchestrator split the dominant economic move.
4. **Staleness is an update problem, not a decay problem.** Bi-temporal supersede-don't-delete (Graphiti's one durable idea) has measured wins; TTL-based forgetting has no evidence base. Decay demotes rank; it never silently deletes.
5. **Structure over cleverness in storage:** sealed segments + manifest + wide events + columnar cold tier is what every system that actually operates at this shape converged on independently (Honeycomb, Kafka, Kurrent, asciinema).

### 3.1 Storage layout (two lanes, three temperatures)

```
<project-root>/.loom/                    # ONE directory = ONE project = the isolation unit
  manifest.db          # SQLite WAL: sessions, segment catalog (path, time range,
                       #   byte range, BLAKE3, frame-offset seek index),
                       #   projection checkpoints, retention ledger
  truth/                                 # LANE A — authoritative, append-only
    term/<session>.seg.zst               #   terminal journals: asciicast-v3-style framed
                                         #   events, zstd per frame-batch (WARC-style),
                                         #   sealed at size/age, BLAKE3 in manifest
    events.db                            #   hot wide events (OTel-ish: agent resource id,
                                         #   ts, type, ~dozens of nullable typed columns)
    events/dt=*/*.parquet                #   cold events, zstd Parquet, date-partitioned
    records/                             #   task/decision records: append-only documents,
                                         #   superseded, never rewritten
  derived/                               # LANE B — hints; every row carries provenance;
                                         #   fully rebuildable by replay from LANE A
    digests.db                           #   rolling session/agent digests + exact-value
                                         #   side tables (SHAs, paths, numbers as columns)
    facts.db                             #   bi-temporal fact table: fact text, entity keys,
                                         #   valid_at / invalid_at / created_at / expired_at,
                                         #   FK → source (segment id + range | event id |
                                         #   record id), confidence, supersedes-pointer
    index/                               #   Tantivy BM25 over digests+records+facts;
                                         #   small dense index (embeddings of digest/fact
                                         #   chunks ONLY — never raw logs)
```

Hot→cold movement: terminal segments seal at size/age (Honeycomb-style); hot events compact nightly into Parquet; the manifest's retention ledger records every seal, compaction, and deletion. All of Lane B plus the cold event tier are projections with checkpoints — deleting `derived/` entirely and replaying is a supported (and tested) operation, which is what makes the two-lane claim mechanical rather than aspirational.

### 3.2 The write path

Agents' terminals are owned by the system, so capture is passive: the PTY tee appends framed output to the open segment and typed events to `events.db` (33k+ inserts/s of headroom against a realistic fleet's hundreds/s). Nothing on the write path ever calls a model, takes a lock an agent can feel, or blocks on derivation — invariant I1 holds by construction because observation is a tee, not a conversation.

**The distiller** is the only writer to Lane B: a background, budget-bounded loop (sleep-time consolidation — the one active-processing pattern with replicated evidence, §2.2). Per session it maintains:
- a **rolling digest** (≤ ~1.5K tokens): what the agent is doing, in prose, re-synthesized (not blindly merged — naive rolling merges drift, §2.5) from the previous digest + the new delta on **activity boundaries** (tool-call completion, phase change, silence timeout), not fixed intervals — adaptive emission measurably beats schedules;
- **exact-value side tables**: SHAs, file paths, error strings, exit codes, numbers extracted into typed columns — because summarization provably drops exact values (§2.5), they are never trusted to prose;
- **fact proposals** into `facts.db` when the delta contains durable knowledge ("build fails without X", "decision: use Y"), each with provenance FK and validity interval, superseding rather than editing on contradiction.

The distiller runs on a grammar-constrained local 7–8B model (≈100% parse validity, $0 marginal, private) or Haiku-class API (~$0.01 / 10K-token chunk) — a policy knob, not an architectural fork. Its outputs are hints by type: nothing downstream is allowed to treat a digest or fact as more than a pointer-rich claim about Lane A.

### 3.3 The query plane (per class)

The queen holds **one frozen prefix** — tools + system + a small per-project card — under a 1-hour-TTL cache breakpoint; every answer below is appended after it. Volatile data never enters the prefix (one changed byte re-bills the corpus at 10×, §2.5).

| Class | Mechanism | Model calls | Tokens into queen | Latency |
|---|---|---|---|---|
| Q1 liveness | SQL: last events + digest head for agent X | none | ~100–300 | <100 ms |
| Q2 recent narrative | rolling digest + last N typed events, verbatim tail if asked | none | ~1–3K | <500 ms |
| Q3 knowledge | facts.db filtered `invalid_at IS NULL` (+ as-of override) → hybrid BM25+dense over digests/records, RRF, cross-encoder rerank → top-k with provenance pointers | none (rerank is a 0.5B local model) | ~2–5K | <2 s |
| Q4 forensic | cheap reader agent, given manifest-pruned seek tools (time range → segment → O(1) frame seek → bounded read); iterates lexically (Pi-Serini result: lexical + capable loop ≥ dense agents); returns conclusions + citations only | 1–3 reader calls (Haiku-class/local) | ~1–2K (readers burn 30–100K *cheap* tokens) | 10–60 s |
| Q5 aggregate | DuckDB read-only over hot SQLite + cold Parquet | none | ~200–1K (result rows) | <1 s at tens of GB |

Two structural points. First, **four of five query classes involve zero LLM calls** — the design's economy comes from routing, not from a better index. Second, when the queen needs to go deeper than a digest, the escalation path is *cheap reader over Lane A*, never *raw bytes into the queen* — the context-rot data says stuffing would answer worse, not just cost more.

Answer contract: every non-Q1 answer carries provenance pointers (segment+range / event ids / record ids), and any hint-derived sentence is marked as hint. The queen can always spend a Q4 to check a Q3 — the lanes stay ordered.

### 3.4 Isolation

The unit of isolation is the **directory**: one `.loom/` per project; no shared database, no shared index, no cross-project table anywhere in the design. Readers are spawned with their filesystem root at the project's `.loom/` (plus the project worktree); the retrieval tools take no path that can escape it. Cross-project leakage requires a component that does not exist rather than a query bug — isolation by construction, auditable by listing open file handles. Where a stronger guarantee is wanted, the cold tier and manifest ride DuckDB/SQLCipher-class per-project encryption (AES-256-GCM, §2.4) with per-project keys, making even a misdirected process read garbage. Global/user-level knowledge ("how this developer likes commits phrased") is a *separate, explicitly-global* store an operator opts into per query — never a fallback the retrieval path silently unions in.

### 3.5 Relevance lifecycle and bounded storage

**Facts/decisions (the "old decision must not steer the present" invariant):**
- Bi-temporal rows: `valid_at/invalid_at` (world time) and `created_at/expired_at` (belief time). Contradiction ⇒ new row + `invalid_at` stamp on the old one, with a supersedes-pointer. Nothing is deleted; "what did we believe on date D" stays answerable.
- Default Q3 filter is `invalid_at IS NULL` — an invalidated decision cannot reach the queen unless it asks as-of. This is the mechanical form of "not silently steering the present."
- **Staleness demotion, not deletion:** rank fusion applies an age/activity penalty to facts whose subject has seen contradicting or superseding activity; a stale-but-never-contradicted fact surfaces with its age displayed. (Decay-as-ranking is the only decay policy with any evidentiary support, §2.2.)
- Periodic **revalidation sweep** (background, budget-bounded): facts past an age threshold get spot-checked by a cheap reader against recent Lane A activity — confirm (`refreshed_at`), supersede, or invalidate. This converts the unsolved "forgetting" problem into the solved "update" problem.

**Storage bounds (explicit, per tier):**
- Terminal truth: keep ≥N days / ≥Y GB of sealed segments (Kurrent-style dual knob); beyond policy, segments either age to a *compacted evidence form* (typed events + digests + exact-value tables survive; raw bytes go) or are deleted outright — and the manifest's retention ledger records exactly which bytes are gone, so a Q4 that needs them fails *loudly* ("evidence aged out at date D per policy P"), never silently.
- Cold events: Parquet at 5–20× compression is cheap enough to keep for the project's life; bounded by date-partition drop if ever needed.
- Lane B: regenerable ⇒ freely GC-able by age/size with zero truth loss.
- Deletion/redaction is segment rewrite + re-hash + projection replay (event-sourcing practice, §2.4); input keystrokes are captured only behind an explicit flag (tlog precedent — they contain secrets).

### 3.6 What makes this strictly better than the obvious simpler designs

| Simpler design | Why the Loom beats it | Basis |
|---|---|---|
| **Grep over raw logs, nothing else** | Q1/Q2 become LLM jobs over noisy bytes; every question re-reads megabytes; no validity lifecycle, so old decisions steer silently. The Loom's digests+facts answer the frequent classes at ~10² tokens. | Letta's 74% shows grep+agent is strong — *at conversational scale*; BEAM shows it breaks past 500K-token horizons, which one day of a 10-agent fleet exceeds. |
| **Embed everything, vector-search it** | Embeddings collapse on long/log-shaped inputs; log queries are exact-identifier queries where BM25 wins; index cost scales with the biggest tier (raw bytes) for the least-queried class. | LongEmbed degradation (arXiv 2404.12096); Pi-Serini 83.1% lexical-only; hybrid-eval literature (§2.3). |
| **LLM-extracted knowledge graph over everything** | 12.5–40× indexing cost for wins confined to multi-hop (~10–15% of queries); graphs missed ~35% of answer entities; the temporal wins come from bi-temporal *metadata*, which the flat fact table keeps at ~zero cost. | arXiv 2502.14802, 2502.11371, 2506.05690; LazyGraphRAG (§2.1). |
| **Stuff recent context into the queen** | 10× per-question cost on Fable/Opus-class pricing, and measurably *worse answers* past ~16–64K effective context; one changed byte re-bills the whole corpus. | Context-rot corpus (§2.5); cache mechanics (§2.5). |
| **One SQLite DB for everything** | Scans over log-scale data need columnar (19× storage/IO gap measured); FTS5 degrades ~40× vs Lucene-class at 500K+ docs; single DB couples the agent-felt write path to analytical reads. | GreptimeDB edge benchmark, moldstud FTS comparison (§2.3–2.4). |

Each row is falsifiable on local data: the acceptance experiments are (a) token-per-query-class metering against a grep-only baseline, (b) Q3 answer accuracy with/without the rerank stage, (c) Q4 recall on seeded forensic questions with/without manifest pruning, (d) digest-drift audit — digests regenerated from Lane A must match served digests.

---

## 4. Comparison against the incremental proposal (read only after §3 was complete)

Compared against: `planning/2026-07-20-observational-data-retrieval-research.md` (lena, 2026-07-20). Per the mandate, that document was not read until the design above was finished.

### 4.1 The headline finding: independent convergence on the skeleton

The two documents, produced without shared anchoring, converge on roughly 80% of the architecture: route every question through the cheapest layer that can answer it; deterministic typed projections answer the frequent classes with zero LLM; a label/metadata-scoped lexical index with hard token budgets answers point queries; digests are hints with provenance compiled off the hot path, never authority; tiered retention with digest-as-downsample bounds storage; supersede-don't-delete governs staleness; no LLM-extracted graph index (both cite the same LazyGraphRAG evidence); embeddings are not load-bearing; isolation is a per-project home with server-derived scoping and no cross-project query surface. Two independent passes landing on the same skeleton — one reasoning from Hive's in-repo evidence, one from the external 2025–2026 literature — is itself the strongest available evidence that the skeleton is right.

The incremental proposal is also *ahead* of the green-field design in three places: the two-way nonce isolation test with positive controls is more rigorous than my acceptance sketch; server-derived project binding (identity bound by the daemon, never caller-asserted) is a real security improvement over "readers are spawned scoped"; and the milestone-dependency argument for where the work lands is something a green-field exercise cannot supply at all.

### 4.2 Where the ideal diverges, what each divergence buys, what it costs

| # | Divergence | Incremental | Ideal (§3) | What it buys (measured basis) | What it costs |
|---|---|---|---|---|---|
| D1 | **Digest cadence** | Compiled at lifecycle boundaries (session end / landing / kill) | Rolling, re-synthesized on activity boundaries mid-session | Q2 ("what is X doing / recent narrative") — the queen's most frequent narrative class — answered at digest cost *during* a session, not only after it ends; adaptive emission measurably beats fixed schedules (§2.5). Boundary-only digests push mid-session narrative onto L1 search or terminal observation. | A continuously running distiller (local 7–8B ≈ $0 marginal, or ~$0.01/10K-token chunk on Haiku); drift risk handled by re-synthesis-not-merge + the digest-drift audit (§3.6). |
| D2 | **Exact values** | Digests carry provenance pointers | Digests additionally extract SHAs/paths/errors/numbers into typed side-table columns | Summarization provably drops exact values and hard constraints (§2.5; the incremental's own cited in-repo evidence — 0%→38% constraint violation — is the same phenomenon). Pointers let you *recover* the value; columns make it *queryable* without a drill-down. | Small: one schema + grammar-constrained extraction, ~free with D1's distiller. |
| D3 | **Deep-dive path** | Queen follows drill-down pointers itself | Forensic queries route through cheap reader sub-agents that return conclusions + citations only | The largest economic divergence. Reader tokens are 5–10× cheaper per token (Haiku $1 vs Opus-class $5–10 input); decomposition is quality-positive at comparable cost (RLM, arXiv 2512.24601); raw material past ~16–64K effective context answers *worse* in one window (context-rot corpus); queen's own context stays short and cache-stable. | A reader-agent harness with project-scoped seek tools; latency 10–60 s for Q4 (acceptable for its frequency). |
| D4 | **Staleness model** | Rides existing wiki status mechanics (`verified/stale/superseded` + supersedes links) | Bi-temporal columns (`valid_at/invalid_at/created_at/expired_at`) + default `invalid_at IS NULL` filter + as-of queries + budget-bounded revalidation sweep | Bi-temporality separates "when was it true" from "when did we learn it," making point-in-time reconstruction and knowledge-update queries mechanical — the one graph-lineage feature with measured wins (Zep's strongest LongMemEval categories, §2.1). Status enums capture supersession but not validity intervals. | Four columns and a filter on decision-shaped records; the revalidation sweep is new background spend (bounded). |
| D5 | **Cache discipline** | Noted as motivation ("cheap reads compound") | Explicit contract: frozen queen prefix under 1-h-TTL breakpoint, volatile data never in prefix, `cache_read_input_tokens > 0` asserted in tests | ~10× repeat-read discount on the queen's standing context; a single stray timestamp in the prefix silently re-bills the corpus at full price every turn (§2.5). | Nearly free — a serialization rule plus one assertion. |
| D6 | **Storage engines** | SQLite + FTS5 + S3.1 object store | Sealed zstd segments + BLAKE3 manifest; Parquet cold tier; DuckDB analytics; Tantivy | Headroom, not immediate wins: 5–20× columnar compression, sub-second aggregate scans at tens of GB (measured on 8 GB laptops), O(1) seek into any archived session, tamper-evident retention ledger. At Hive's *current* scale (hundreds of K docs, not 10M), FTS5 and per-instance SQLite are within measured comfort zones. | Two new engine dependencies + a compaction pipeline — real complexity, and the incremental's substrate can migrate to it later because both designs keep truth append-only. |
| D7 | **Dense retrieval leg** | Deferred until a measured gap demands it | Small dense index over digests/facts only, RRF + 0.5B reranker | Honest verdict: **the evidence favors the incremental here.** Log-shaped queries are exact-identifier queries where lexical wins (Pi-Serini 83.1%); the dense leg pays mainly for paraphrase queries and weak readers. The reranker (index-free, local, +3–5 nDCG) is worth adopting ahead of embeddings; the embedding index itself should stay behind a measured-gap gate exactly as the incremental says. | — |

### 4.3 Straight recommendation

**Adopt hybrid — the incremental skeleton was right; graft five green-field deltas onto it.**

The incremental proposal independently derived the correct architecture and grounds it in in-repo measured history the green-field exercise could not use; discarding it for a from-scratch build would buy no measured advantage and would forfeit its milestone-dependency analysis, isolation test, and reuse of shipped mechanics. But the green-field pass surfaced real gaps with cited bases, in priority order:

1. **D3 — cheap-reader escalation** (largest token-economics win; changes the query tool's Q4 class from "return pointers" to "spawn reader, return conclusions").
2. **D1+D2 — rolling digests on activity boundaries with exact-value side tables** (converts the most frequent narrative class from search-cost to digest-cost mid-session; local-model option makes it ~$0 marginal).
3. **D5 — frozen-prefix cache discipline as an explicit acceptance criterion** (near-free, ~10× on repeat reads, and silently lost without a test).
4. **D4 — bi-temporal columns on decision/fact-shaped records** (four columns now; retrofitting validity intervals later is a migration).
5. **D7 partially — adopt the local cross-encoder reranker; keep embeddings gated behind measured need** (the incremental's own gate, unchanged).

**D6 (segments/Parquet/DuckDB/Tantivy) should be named as the scaling route, not built now**: the incremental's substrate is within measured comfort at current scale, both designs keep truth append-only so the migration stays open, and the trigger should be a measured number (aggregate-scan latency or FTS5 index size crossing stated thresholds), in keeping with the repo's measure-don't-claim discipline.

One caution the external record adds to *both* documents: every vendor benchmark in the agent-memory space failed or shrank under independent replication (§2.2). The incremental's insistence that token-cost measurement is an acceptance criterion, not a hope, is the correct posture toward this entire literature — including toward the numbers cited in this document.

---

## 5. Primary sources

Inline throughout §2–§4. Load-bearing primary sources: arXiv 2601.00821 (verbatim beats extraction), 2501.13956 (Zep/Graphiti), 2502.14802 (HippoRAG 2), 2502.11371 + 2506.05690 (graph-vs-RAG systematic evals), 2504.13171 (sleep-time compute), 2512.24601 (Recursive Language Models), 2605.10848 (Pi-Serini), 2509.21865 (retrieval-vs-stuffing crossover), 2404.12096 (LongEmbed), 2604.25359 (structured-output benchmark), 2504.15247 (Lance/Parquet random access); trychroma.com/research/context-rot; anthropic.com/engineering/multi-agent-research-system; Microsoft LazyGraphRAG + BenchmarkQED posts; Mixedbread mxbai-rerank-v2; DuckDB "Big Data on the Cheapest MacBook" (2026-03-11); asciicast v3 spec; Honeycomb Retriever design notes; getzep/zep-papers#5 and the associated replication-failure record.

### 2.5 Token economics: what a query may cost

Prices (Anthropic, current): Fable 5 $10/$50 per MTok in/out; Opus 4.8 $5/$25; Haiku 4.5 $1/$5. Cache reads ~0.1× base input; writes 1.25× (5-min TTL) / 2× (1-h TTL); break-even at 2–3 reuses. One changed byte invalidates everything after it. The whole industry converged on the same shape (OpenAI now 90% cached discount, ~24h retention; Gemini implicit caching; DeepSeek −98% cache hits) — so the design conclusion is provider-agnostic: **an orchestrator should hold one frozen, byte-stable prefix and append questions after it; everything volatile stays out of the prefix.**

- **Context rot is the best-replicated negative result in the space.** Chroma's 18-model study ([trychroma.com/research/context-rot](https://www.trychroma.com/research/context-rot)), NoLiMa, RULER, and Fiction.liveBench agree: performance degrades with input length even on trivial tasks; focused ~300-token prompts beat full ~113K-token prompts on LongMemEval across every model family; effective reasoning context is ~16–64K tokens regardless of the advertised window. When relevance density drops below ~20%, retrieval beats stuffing by 13+ F1 at ~1/7 the tokens ([arXiv 2509.21865](https://arxiv.org/pdf/2509.21865)). Stuffing raw logs into the orchestrator is not just expensive — it is measurably *worse*.
- **Cheap-reader/expensive-orchestrator is validated.** Anthropic's multi-agent research system: Opus lead + Sonnet subagents outperformed single-agent Opus by 90.2% on breadth-first research, at ~15× tokens — the readers' tokens are cheap, the pattern pays when raw material exceeds one effective context. Recursive Language Models ([arXiv 2512.24601](https://arxiv.org/abs/2512.24601), MIT): recursive decomposition over a REPL-held corpus is quality-positive (+26% median over compaction) at **comparable cost** — decomposition is not a cost penalty.
- **Compaction/summarization silently drops exact values** (SHAs, numbers, constraints) — a replicated observation across production writeups. Exact values belong in structured fields, never only in prose summaries.
- **Local distillation is free and good enough for narrow schemas.** Grammar-constrained 7–8B local models achieve ~100% parse validity and high schema compliance (Gemma 3 4B: 87% schema compliance; [arXiv 2604.25359](https://arxiv.org/html/2604.25359v1)); Apple-Silicon throughput ~45–62 tok/s generation, prefill-bound on long inputs. Haiku 4.5 at ~$0.01 per 10K-token chunk is the API alternative; the local model's edge is privacy and zero marginal cost, not quality.

*(Design sections follow.)*
