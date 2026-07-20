# M3-S3.7 — Session digests and data lifecycle (L2 digests + L3 retention)

Milestone: M3, retrieval track. GitHub issue: **not yet carded** — queen cards this story after the doc lands.
Origin: research recommendation adopted by the user **2026-07-20** (the hybrid ruling). Skeleton from `planning/2026-07-20-observational-data-retrieval-research.md` §6–§7 (lena, S3.7 sketch); grafts from `planning/2026-07-20-observational-data-retrieval-greenfield.md` §4.3 (priya). This doc promotes those into a story; it invents no new scope.
Status: **ADOPTED for planning, not yet ratified for execution.** Depends on S3.6 (and S3.1 substrate). Scoped against `planning/terminal-ownership-methodology.md` §4a (EFFICIENCY, incl. the 16 GB hardware floor) and §4c (DATA LIFECYCLE).

## Why

S3.7 answers the two questions the methodology's §4c leaves deliberately open — *how do we keep the store clean, and how do we stop a five-month-old decision from silently steering today* — and it adds the one narrative layer L0/L1 cannot supply cheaply:

- **L2 — session digests.** "Catch me up" / "what did X do all session" answered at O(digest) — hundreds of tokens — instead of O(session bytes). Digests are **navigation aids with provenance, never authority**: the in-repo evidence is hard on this (summary content fluctuates run-to-run, drops the soft constraints that matter — 0% → 38% violation when dropped — and a bad agent-authored summary scored *below* no summary at all). So digests are compiled by a **fresh summarizer at lifecycle boundaries, never by the agent about itself, never on the hot path**, and every load-bearing line carries a pointer into the typed record or journal range it came from.
- **L3 — tiered retention.** Tiering is what makes L0–L2 *stay* cheap as data grows: the **digest is the downsample** (Thanos move). A five-month-old session survives as a digest + typed events (warm, searchable, hundreds of tokens) and optionally a cold archived journal blob, while raw hot state is only the live rolling window.

It rides the memory wiki's existing `verified / stale / superseded` mechanics rather than inventing a parallel scheme, and it carries priya's remaining two grafts (rolling digests with exact-value side tables; bi-temporal columns).

## Scope boundary

In scope:
- **L2 digests** compiled by a **fresh summarizer** on session end / landing / kill, never authored by the session's own agent, never on the hot path; provenance pointers (event ids, journal ranges) for every load-bearing claim; labeled hint-not-authority.
- **Rolling digests on activity boundaries** (priya graft 2 / D1): re-synthesized (not blind-merged) from the previous digest + the new delta on tool-call completion / phase change / silence timeout — not fixed intervals.
- **Exact-value side tables** (priya graft 2 / D2): SHAs, file paths, error strings, exit codes, numbers extracted into typed columns — never trusted to prose.
- **Bi-temporal columns** (priya graft 4 / D4): `valid_at` / `invalid_at` / `created_at` / `expired_at` on decision/fact records, with a default `invalid_at IS NULL` recall filter and an as-of override.
- **L3 tiered retention:** hot rolling journal / warm digests + objects + index / cold archive; policy-driven sweeps; per-tier retention constants in **named config**.
- **Stale-demotion + supersession** riding the existing memory status mechanics (no parallel state machine).
- **WorkManifest reference-check before deletion.**
- The green-field **local 7–8B distiller** claim carried as a **measured** AC (resident-set + latency + sustained-load on the floor machine), with an API fallback — not an assertion.

Out of scope (named so it is not silently absorbed):
- **L0 projections and the L1 query core** — that is **S3.6**.
- **The durable storage substrate** — content object store, checksummed journal archive, retention/GC hooks are **S3.1**.
- **Scaling storage engines** — sealed segments + BLAKE3 manifest, Parquet cold tier, DuckDB analytics (priya D6) are the **named scaling route, measured-trigger-only, not built now** (see Blocker 3).
- **Hierarchy-aware rollups** (subtree rollups belong to S4.3/S4.5 where the hierarchy exists).
- **Cross-project global lesson mining** — a memory-system write-policy question, not a retrieval question.

## Definition of done (numbered acceptance criteria)

Each criterion restates the HARD PRINCIPLES that apply (external research drives; external citations; no legacy shims; production-grade; **project-agnostic**; paired SPEC + doc-cleanup, docs describe behavior not file paths; **LIVE PROOF to close**). Per methodology §4a: every efficiency claim carries a **measured** token-cost AC (graphify precedent), and every performance / memory / latency AC states its **16 GB floor-machine bound** (base 14" MacBook Pro, M1 Pro, 16 GB).

1. **Fresh-summarizer digest, provenance-bearing, off the hot path.** A digest is compiled on session end / landing / kill by a **fresh summarizer** — never the session's own agent, never on the hot path; every load-bearing claim carries a provenance pointer (event ids, journal ranges); the digest is labeled **hint-not-authority**.

2. **Rolling digest on activity boundaries** (priya graft 2). The digest is re-synthesized from the previous digest + the new delta on **activity boundaries** (tool-call completion / phase change / silence timeout), not fixed intervals, and re-synthesized rather than blind-merged (naive rolling merges drift). **Digest-drift audit:** a digest regenerated from the typed record / journal must match the served digest.

3. **Exact-value side tables** (priya graft 2). SHAs, file paths, error strings, exit codes, and numbers are extracted into **typed columns**, queryable without a drill-down — because summarization provably drops exact values, they are never trusted to prose. **Positive control:** an exact value present in the source but dropped from the prose digest is still recovered from the side table.

4. **Bi-temporal columns are the mechanism for "no silent steering"** (priya graft 4; methodology §4c). Decision/fact records carry `valid_at` / `invalid_at` / `created_at` / `expired_at`; the default recall filter is `invalid_at IS NULL`, so an invalidated decision cannot reach queen unless it asks **as-of**; a contradiction produces a **new row + `invalid_at` stamp + supersedes-pointer, never a delete**. Proven by test: an invalidated 5-month-old decision is **absent from default recall** and **present in an as-of query** — point-in-time reconstruction survives.

5. **Retention sweeps per cadence, constants in named config.** Event-driven on session end / landing / kill (compile digest, move the journal generation to the archive tier, index it); periodic daily idle sweep for per-tier retention (raw archived journal bytes aged out after the configured window, typed events + digests kept for the project's lifetime, stale-demotion scan). Per-tier retention constants live in **named config**; changes are loud. The numbers are ratifiable starting points; the **structure** is the recommendation.

6. **A delete never breaks a live WorkManifest reference.** Retention **checks references before delete** — cleanup never removes the only record of an un-landed agent's work while a WorkManifest still references it (S3.3 stranding recovery owns that dependency). Referenced-check proven by test (a delete keyed on a registry that forgets is a known Hive failure class).

7. **Stale-demotion and supersession ride existing memory mechanics — no parallel state machine.** A `verified` article/digest whose verification date ages past a threshold demotes to `stale` (visible in the index, still readable, demoted in rank — not deleted); a decision replaced by a newer one is `superseded`, its body states current truth while raw history preserves the reasoning. This is the existing `memory_write` contract extended to observational data, not a new scheme.

8. **Local 7–8B distiller — MEASURED, not asserted — floor-bounded.** The green-field "local 7–8B distiller ≈ $0 marginal" claim (greenfield §3.2, §2.5) enters here as a **measured** AC: **resident-set, generation/prefill latency, and sustained-load behavior on the base 14" MacBook Pro (M1 Pro, 16 GB)** while builds and agent processes contend for the same 16 GB. **Degradation path stated and exercised:** fall back to a Haiku-class API (~$0.01 / 10K-token chunk) when the local model cannot fit alongside the working fleet. The distiller never runs on the hot path. The local-vs-API choice is a **policy knob gated on this measurement** — it is not fixed by assertion.

9. **Digest token cost — MEASURED** (graphify precedent). A catch-up question answered from the digest vs. from L1 search vs. from raw journal — **three-way numbers published**; the story states its reduction target and measurement method up front.

10. **Drill-down live proof.** A digest claim is **followed through its provenance pointer** to the exact typed rows / journal range that ground it — the hint-to-authority path is exercised end-to-end, not asserted.

11. **Absent-vs-empty discipline.** A digest/fact lookup that finds nothing distinguishes "no such record" from "surface absent / rotated"; a **positive control** in the suite proves the reader can see a positive before any negative is trusted.

## Live-proof requirements

- The digest is compiled by a **genuinely fresh summarizer** (not the session's own agent) — proven, not assumed (a bad self-summary scored below no summary at all).
- The **drill-down** is followed end-to-end to the grounding record; the bi-temporal filter is proven live (invalidated decision absent from default recall, present as-of).
- The distiller's **resident-set + latency + sustained-load are measured on the floor machine**, not modeled; the API-fallback degradation is exercised, not just described.
- **Reference-check-before-delete** is proven by test against a live WorkManifest reference.
- Every token figure is **measured on a real corpus**, published, method stated; every performance/memory figure is bounded on the base 14" MacBook Pro (M1 Pro, 16 GB) under sustained load.

## Current completion state

- **Not started.** The hybrid recommendation was adopted 2026-07-20; this story is the normative carrier for the L2+L3 half. **Not yet carded** — queen cards it after this doc lands.
- **Mechanics already shipped to extend:** the memory wiki already carries `verified / unverified / stale / conflicted` status, explicit `supersedes` links, immutable raw history, and an FTS5 search (`memory_fts`). S3.7 extends these to observational data; it introduces **no** parallel status machine.
- **Depends on S3.6** (the consolidated per-project store and the query surface digests are read through) and **S3.1** (the archive tier / object store / retention hooks the sweeps drive).

## Open blockers (explicitly named)

1. **S3.6 + S3.1 dependency.** Digests are read through S3.6's query classes and stored in S3.6's per-project home; retention sweeps drive S3.1's object store and archive tier. S3.7 cannot close before both exist.
2. **Retention constants are proposed defaults to ratify.** Raw-archive TTL (~30 days), digest/event lifetime (project lifetime), and the stale-demotion threshold are **tunable policy constants named in config** — the structure is the recommendation, the numbers are starting points the user ratifies. The event/decision copy that a policy retires must be pinned before the periodic sweep is graded.
3. **Scaling-storage trigger is unset — measured-trigger-only.** Sealed zstd segments + BLAKE3 manifest, Parquet cold tier (5–20× columnar compression), and DuckDB analytics (sub-second aggregates at tens of GB on 8 GB laptops) are the **named scaling route** (greenfield D6), built only when a **measured number** — aggregate-scan latency or archive size crossing a stated threshold — demands it. Not now; both designs keep truth append-only so the migration stays open.
4. **Distiller model choice is gated on AC 8's floor measurement.** Local 7–8B vs. Haiku-class API cannot be fixed until the resident-set + sustained-load numbers on the 16 GB floor machine are in hand; until then the distiller is specified behind the measured gate, with the API fallback as the safe default under memory contention.
