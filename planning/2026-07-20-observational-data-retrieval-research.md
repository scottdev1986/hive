# Observational-data retrieval for queen — research recommendation

> **ADOPTED — user ruling 2026-07-20.** The hybrid recommendation is adopted:
> this incremental skeleton (lena) plus priya's five green-field grafts
> (`planning/2026-07-20-observational-data-retrieval-greenfield.md` §4.3). A
> binding hardware floor is set: the **base 14-inch MacBook Pro — M1 Pro, 16 GB
> unified memory** — against which every performance / memory / latency AC is
> measured (`planning/terminal-ownership-methodology.md` §4a). **The normative
> carriers are now the two story docs** — `planning/story-m3-s36-retrieval-core.md`
> (L0+L1) and `planning/story-m3-s37-digests-lifecycle.md` (L2+L3); this research
> doc is the rationale record, superseded by those stories as the execution spec.

**Status: research recommendation, user-commissioned (2026-07-20). Not yet ratified.**
Author: lena (writer agent, Fable 5, explicitly requested). External sources verified 2026-07-20.

This answers the research remit that `planning/terminal-ownership-methodology.md`
§4a–§4c names and deliberately leaves open: how queen gets **fast, token-efficient
access to Hive's vast per-project observational data**, what the project-isolation
boundary is, what the data-lifecycle policy is, and where the build work belongs
in the milestone plan. Recommendation in one line:

> **Compose four layers — typed projections first, a scoped index with bounded
> excerpts second, session digests with drill-down third, tiered retention
> underneath — and treat graph structure as links inside those layers, not as a
> fifth index. Build the first two layers plus the isolation proof in M3 as a new
> story alongside S3.1; digests and lifecycle as a second story; defer everything
> embedding- or community-summary-shaped until a measured gap demands it.**

---

## 1. The problem, and the constraints that decide it

The ratified methodology commits Hive to: *queen can answer "what is agent X
doing / what happened" from journaled data, without interrupting agents, quickly,
and at low token cost* (terminal-ownership-methodology §1, §4a). Constraints that
bind any design, all already established in-repo:

- **Token budget is an accuracy budget, not just a price.** Models degrade inside
  their advertised window; the always-injected surface must stay small and
  retrieval must be pull-on-demand ([docs/agents/memory.md](../docs/agents/memory.md),
  "Token budget is also an accuracy budget";
  [docs/agents/context-and-recycling.md](../docs/agents/context-and-recycling.md),
  the units error). Queen is a long-lived agent; every retrieval token it spends
  is carried in cache for the rest of its life. Cheap reads compound.
- **A claimed efficiency win must be measured.** Graphify ships with Hive because
  it *proved* token-cost reduction, and its integration history is a catalog of
  measured traps — the 2000-token default that silently cut all edges, fixed only
  by measuring where edges appear (~16000)
  ([docs/graphify/integration.md](../docs/graphify/integration.md), the truncation
  trap). Any layer proposed here inherits that bar: token-cost measurement is an
  acceptance criterion, not a hope.
- **Hint vs. authority is a hard lane split.** Screen-derived and
  summarizer-derived facts inform; authenticated records adjudicate (methodology
  §3, invariant I6). Any summarization layer must carry provenance and never sit
  where its being wrong becomes a Hive failure — the same degradation contract
  graphify lives under (integration.md, the degradation contract).
- **Absent is unknown, never false.** A retrieval that finds nothing must be
  distinguishable from a store that has nothing (SPEC accurate-or-unknown; Hive
  protocol rule 3).

## 2. What the observational data actually is today (inventoried 2026-07-20)

| Surface | Where | Shape and bound |
|---|---|---|
| Terminal byte journal | sessiond, `journal.bin` per generation | Rolling replay window, capacity 64 MiB per generation, persisted at most every 250 ms (`native/sessiond/src/terminal_state.zig`, journal constants). A **bounded flight recorder, not an archive** — rotation is silent from a reader's perspective. |
| Lifecycle events | per-instance `hive.db` `events` table | Typed rows (kind, agentName, timestamp, contextPct, description, …); 355 rows in the newest run DB. |
| Messages / status | `messages` table, StatusEnvelopes, `hive_update_status` reports | Durable, typed, already source/freshness-labeled (S2.3 direction). |
| Token telemetry | `token_usage_events` / `_sessions` / `_subjects` / `_artifacts` | Per-provider observations; cumulative-flag semantics differ per provider. |
| Compiled memory wiki | `<repo>/.hive/memory/{raw,wiki}` and `~/.hive/memory` | Immutable raw observations + compiled articles with `verified/unverified/stale/conflicted` status, `supersedes` links, an FTS5 search (`memory_fts` in hive.db), and a ≤30-row injected index. |
| Project identity | `~/.hive/project-registry.json` | `hiveUuid` per project, keyed by canonical path + inode evidence; per-project state dir `~/.hive/projects/<hiveUuid>/`. |
| Per-instance stores | `~/.hive/instances/run-<uuid>/hive.db` | Observational rows are **fragmented across run instances** today — a prior incident read per-instance DBs as data loss. |

Two structural facts drive the design. First, the data is **already
event-shaped and typed** — Hive is an event-sourced system in all but name.
Second, the only unbounded-growth surface (terminal bytes) is currently a
*rolling* window: today Hive cannot answer "what happened three sessions ago"
from the journal at all. S3.1's checksummed journal outside worktrees and
content object store are what turn the flight recorder into an archive; this
document designs the *read side* over that substrate.

## 3. The five candidate architectures

### 3a. Hierarchical / rolling summarization (summaries-of-summaries, drill-down to raw)

Prior art: [RAPTOR (arXiv 2401.18059)](https://arxiv.org/abs/2401.18059) builds a
tree of recursive summaries and retrieves at the abstraction level the question
needs — +20% on QuALITY with GPT-4 over flat retrieval.
[MemGPT (arXiv 2310.08560)](https://arxiv.org/abs/2310.08560) pages between a
fixed main context and external storage with recursive summaries as the eviction
product. [GraphRAG](https://www.microsoft.com/en-us/research/blog/graphrag-new-tool-for-complex-data-discovery-now-on-github/)
measured the headline token number: root-level community summaries answered
global questions with **97% fewer tokens** than map-reducing source text.

Token argument: a narrative question ("what happened while I was away?") answered
from raw journal costs O(session bytes); answered from a compiled digest it costs
O(digest) — hundreds of tokens — with drill-down pointers when the digest is not
enough. This is the only layer that can answer *narrative* questions cheaply.

The in-repo evidence constrains it hard
([context-and-recycling.md](../docs/agents/context-and-recycling.md)): summary
content fluctuates run-to-run and ignores volume instructions; summarizers drop
exactly the soft constraints that matter (0% → 38% violation when dropped); a bad
agent-authored summary scored *below* no summary at all. Therefore: digests are
**navigation aids with provenance, never authority**; compiled by a **fresh
summarizer at lifecycle boundaries** (session end, landing, kill), never by the
agent about itself and never on the hot path; every digest line that matters
carries a pointer into the typed record or journal range it came from.

### 3b. Event-sourced projections (precomputed typed views)

Prior art: [Fowler, Event Sourcing (2005)](https://martinfowler.com/eaaDev/EventSourcing.html);
[Greg Young's CQRS documents](https://github.com/shamash2014/awesome-cqrs-event-sourcing) —
a projection is a left-fold over the event sequence; the
[Azure event-sourcing + materialized-view patterns](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)
state the operational form: replaying events is costly, so you materialize
read-optimized views and keep them current incrementally.

Token argument: **the cheapest possible read is one nobody computes at read
time.** "What is agent X doing right now" collapses to reading a maintained
`WorkspaceSnapshot`-class row: no scan, no LLM, no retrieval ranking —
deterministic, bounded, and honest about freshness because the projection carries
its own source/freshness/confidence labels (StatusEnvelope v2 discipline, S2.3).
This is where the bulk of queen's day-to-day questions should terminate, and it
is precisely the ground S3.1 already reserves (`WorkManifest`,
`TokenAttributionProjection`, `ContextInputRecord`; M5's WorkspaceSnapshot v2).
`hive_status` today is this pattern in miniature.

Limit: projections only answer questions someone anticipated. They are the fast
lane, not the escape hatch.

### 3c. Graph-based retrieval (graphify generalized to runtime data)

Prior art: [GraphRAG](https://www.microsoft.com/en-us/research/project/graphrag/)
(entity graph + Leiden communities + multi-level summaries);
[LazyGraphRAG](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)
— which is the more instructive result: indexing at **0.1% of GraphRAG's cost**
and answering at **4% of its global-search query cost** by *deferring* LLM work
to query time; and [Zep/Graphiti's bi-temporal knowledge graph](../docs/agents/memory.md)
(valid-at/expired-at on every edge, supersede-don't-delete) as the staleness
gold standard for agent memory.

Evaluation: **do not build a separate graph index over runtime data in M3.**
Three reasons. (1) The runtime data is *already relational and typed* — agent,
session, task, landing, message — so the "graph" is the foreign keys and causal
links S3.1's v2 envelopes already mandate, plus the memory wiki's `[[links]]`.
Nothing needs entity extraction, which is where graph pipelines pay their cost
and take their accuracy risk. (2) Graphify's own integration history is the
warning label: a 45–76%-accurate oracle whose failure mode is *confident answers
rooted in the wrong place*, admissible only as a hint outside every critical path
(integration.md). Queen's observation path is exactly where that is not
acceptable. (3) LazyGraphRAG's lesson — defer expensive indexing, spend at query
time inside a budget — is *implemented* by layer 3d below without any graph
machinery. What survives from this candidate: **causal links as first-class edges**
in the typed record (already S3.1) so "what led to this?" is a link walk, not a
search; and the graphify *methodology* precedent — measure, publish the token
numbers, ship only what proved itself.

### 3d. Search-index-over-journal with bounded excerpt windows

Prior art: [Grafana Loki's architecture](https://grafana.com/docs/loki/latest/get-started/architecture/)
is the load-bearing analogy — index **only metadata labels** (which stream, which
window), keep raw content in compressed chunks, and scan chunks only inside the
label-scoped slice. Full inverted indexes over log content routinely cost as much
storage as the logs themselves; Loki's bet is that real queries are
label-scoped first and text-filtered second. That is exactly the shape of queen's
"what happened" queries: always scoped by agent/session/time before any text
match. [SQLite FTS5](https://www.sqlite.org/fts5.html) supplies the local engine —
Hive **already runs FTS5 in production** for compiled-memory search
(`memory_fts` in hive.db), and its `snippet()` auxiliary returns bounded
match-windows (≤64 tokens per excerpt) natively.

Token argument: a point query ("did anyone touch the quota tables?", "when did
lena's rebase fail?") costs O(matches × excerpt window), not O(journal). The
excerpt window is the institutionalized form of graphify's `token_budget: 16000`
lesson: **every retrieval surface takes an explicit budget, enforces it
server-side, and reports truncation loudly** — a default that silently cuts the
useful part of the payload is a measured, named failure mode in this repo
(integration.md, the truncation trap).

Practical notes: index the *text-bearing, typed* surfaces (envelope previews,
event descriptions, status reports, digest bodies) eagerly; index terminal
journal content only after ANSI/control-sequence stripping (the raw byte stream
is escape-sequence-dense and would poison a tokenizer), and only for archived
sessions — the live rolling journal is served by `hive_terminal_observe`, not by
search.

### 3e. Tiered storage (hot raw / warm summarized / cold archived)

Prior art: [Elasticsearch ILM hot/warm/cold/frozen/delete](https://www.elastic.co/blog/implementing-hot-warm-cold-in-elasticsearch-with-index-lifecycle-management)
— policy-driven phase transitions with explicit triggers and per-phase actions;
[Thanos downsampling](https://thanos.io/v0.8/components/compact/) — raw blocks
older than 40 h get 5-minute downsamples, those older than 10 d get 1-hour
downsamples, and **retention is set per resolution**
(`--retention.resolution-raw/5m/1h`), so old data stays *queryable at coarse
grain* long after raw is gone.

Token/cost argument: tiering is what makes the other layers *stay* cheap as data
grows. The Thanos move — age raw out while keeping a coarse queryable artifact —
maps directly: the **digest is the downsample**. A five-month-old session exists
as a digest + typed events (warm, searchable, hundreds of tokens) and optionally
as a cold archived journal blob (retrievable by explicit range read, never
scanned), while raw hot state is only the live rolling window. S3.1's object
store with retention and orphan GC is the storage half of this; the policy half
is §6 below.

## 4. The recommended composition

Route every queen question through the cheapest layer that can answer it, in
this order:

| Layer | Answers | Mechanism | Read cost shape |
|---|---|---|---|
| **L0 Projections** | "what is X doing *now*", "what landed", "who is blocked", token spend | Typed views maintained as left-folds over the event stream (S3.1/S2.3 ground; `hive_status` pattern) | Fixed, small — no scan, no LLM |
| **L1 Scoped index** | "what happened / did Y occur" point queries | Label-scoped SQL over typed rows + FTS5 with `snippet()` excerpts, hard token budget per call, loud truncation | O(matches × window), bounded |
| **L2 Session digests** | "catch me up", "what did X do all session", cross-session narrative | Fresh-summarizer digest per session/landing/kill, provenance pointers to L1 rows and journal ranges, drill-down | O(digest), bounded; LLM cost paid once, off hot path |
| **L3 Tiers + retention** | keeps L0–L2 cheap forever | hot rolling journal / warm digests+objects+index / cold archive; policy-driven sweeps | Storage discipline, not a query surface |

Graph structure lives *inside* the layers (causal links in envelopes, wiki
links, foreign keys) rather than as a separate index. Embeddings and
community-summary indexes are consciously excluded until a measured retrieval
gap demands them — FTS-first is the same discipline as graphify's enforced
code-only: no background LLM/embedding spend on an unproven surface.

Queen's tool surface should be **one query tool with declared query classes**,
each class carrying its own token ceiling, rather than N ad-hoc tools — the
ceilings are what make cost measurable and regressions visible. Every class
distinguishes "no results" from "surface absent/rotated" (absent is unknown).

**Why not a single winner:** projections alone cannot answer unanticipated
questions; search alone makes narrative catch-up cost O(session); summaries
alone are unauthoritative and non-deterministic; tiering alone answers nothing.
The composition exists because each layer's failure mode is another layer's
job.

## 5. Project isolation

**Boundary statement.** The unit of isolation is the **project identity**: the
`hiveUuid` minted in `~/.hive/project-registry.json`, bound to a canonical path
with inode evidence. All observational data — journal archives, object store,
event/status/message rows, FTS index, digests — lives under exactly one of:

- `<repo>/.hive/memory/{raw,wiki}` — repo-scoped knowledge, travels with the repo
  (already shipped);
- `~/.hive/projects/<hiveUuid>/` — machine-local observational store for that
  project (the natural home for the M3 read-side artifacts: index, digests,
  archived journal objects). The current fragmentation across
  `~/.hive/instances/run-<uuid>/hive.db` should consolidate here so retrieval has
  one project-keyed home and a respawned instance stops "losing" history.

**Query scoping.** Every retrieval call executes with a project binding the
**daemon derives from the requesting instance's own registered identity** —
never from a caller-supplied parameter. This is the same authority rule S3.5
applies to `from`: identity is bound by the server, not asserted by the client.
There is no cross-project query surface at all; a leak would have to be a bug,
not a misuse.

**Legitimately global** (explicitly enumerated; everything else is per-project):
global-scope memory (`~/.hive/memory` — a deliberate, user-visible scope with its
own index), provider quota/billing and routing state (facts about accounts and
models, not about any project), credentials, and tool bundles (graphify).
**Never global:** anything derived from a repo's content or an agent's terminal
bytes, including digests, indexes, and "generic-looking" lessons mined from
observational data — those go through the memory system's explicit global scope
or not at all.

**The non-leakage test** (two-way, with positive controls — an all-empty result
is usually a bad key, not an empty world):

1. Initialize Hive in throwaway projects A and B. In A, run an agent whose
   journaled output, status reports, and a memory article each embed nonce `N_A`;
   likewise `N_B` in B.
2. *Positive control:* in A, every query class (L0/L1/L2, plus memory search)
   finds `N_A`. A query class that cannot find its own nonce disqualifies the run.
3. *Isolation assertions:* in B, every query class returns zero hits for `N_A`;
   `grep -r` over B's entire scope (`~/.hive/projects/<uuidB>/`, B's repo
   `.hive/`) finds no `N_A` bytes; and the mirror-image assertions hold for `N_B`
   against A. Storage and query are asserted separately — bytes absent under the
   wrong scope, and results absent from the wrong query surface.

## 6. Data lifecycle

The memory wiki already has the right semantics — `verified` / `unverified` /
`stale` / `conflicted`, explicit `supersedes`, immutable raw history. The policy
below extends those mechanics to observational data instead of inventing a
parallel scheme; the external anchors are GitHub Copilot's shipped
citation-revalidation + unused-TTL and Zep's expire-don't-delete bi-temporal
model (both surveyed with sources in [docs/agents/memory.md](../docs/agents/memory.md)).

**How a 5-month-old decision is prevented from silently steering today.** Three
mechanisms, all already partly in place:

1. **Nothing observational is auto-injected.** Only the ≤30-row memory index
   enters a spawn brief; digests, events, and archives are pull-on-demand. A
   fact that is never pulled cannot steer anything. (Shipped behavior.)
2. **Recall requires revalidation before load-bearing use.** A recalled article
   or digest naming a concrete path/flag/decision is re-checked against the
   current repo before it drives action (SPEC decision 5; Copilot's
   citation-validation pattern). Decision-shaped digest content should carry its
   anchors (commit, file, issue) precisely so this check is mechanical.
3. **Age demotes, supersession retires — nothing silently persists as current.**
   A `verified` article whose verification date ages past a threshold without
   re-verification demotes to `stale` (visible in the index, still readable —
   Copilot's 28-day unused-TTL is the precedent for the *shape*, with demotion
   instead of deletion); a decision replaced by a newer one is `superseded` and
   its body states current truth while raw history preserves the reasoning
   (already the `memory_write` contract; Zep's past-tense rewrite is the same
   move). Point-in-time reconstruction survives because nothing is destroyed
   until cold-retention deletes it.

**Is yesterday's session still relevant? Who decides?** Split the question:
*storage* relevance is decided by policy (below); *use* relevance is decided at
retrieval time by queen's query — a session from three sessions ago is exactly as
relevant as the query that pulls its digest, and costs nothing when unpulled.
The wrong answer is injecting recency by default; the repo's own evidence says
context is an accuracy budget and successors over-trust predecessors.

**Cleanup cadence and windows** (proposed defaults — tunable policy constants,
named in config, changes loud; the *structure* is the recommendation, the
numbers are starting points to ratify):

- **On session end / landing / kill (event-driven):** compile the digest, move
  the journal generation into the archive tier (content-addressed object),
  index it. Consolidation is background work, never hot-path (survey consensus:
  Letta, LangMem, Mem0, Zep).
- **Daily, on daemon idle (periodic sweep):** retention enforcement per tier —
  Thanos-style per-resolution retention: raw archived journal bytes deleted
  after ~30 days (the digest and typed events remain the queryable downsample),
  typed events and digests kept for the project's lifetime (they are small),
  orphan GC per S3.1's object-store contract, stale-demotion scan for
  memory/digest verification dates.
- **Never:** cleanup that deletes the only record of an un-landed agent's work
  while a WorkManifest still references it (S3.3 stranding recovery owns that
  dependency; retention must check references before delete — a delete keyed on
  a registry that forgets is a known Hive failure class).

## 7. Where it belongs in the milestones

**What S3.1 already covers** (planning/backlog-outline.md M3): the durable
substrate — v2 envelopes/events with digests and causal links, the content
object store with bounded previews/range reads, retention and orphan GC hooks,
ContextInputRecord, TokenAttributionProjection, and the checksummed journal
outside worktrees. In this document's terms: the storage half of L3, the write
side of L0, and the bounded-read primitive L1 depends on.

**What is missing from M3 for the methodology's §4a promise to be real:** the
queen-facing read side — the query tool with classes and budgets, the
project-scoped index, session digests, the lifecycle policy, and the isolation
proof. Two new stories:

**S3.6 — Observational retrieval core (L0+L1).** Depends on S3.1; can start
daemon-side during M2 like S3.1. DoD sketch, repo style:

1. A per-project observation store under `~/.hive/projects/<hiveUuid>/`
   consolidates events, envelopes, digest metadata, and archived-journal
   references for that project; a fresh instance reads prior sessions' data
   (kills the per-instance fragmentation, live-proven across a daemon restart).
2. One queen query tool with declared query classes (at minimum: agent-now,
   agent-history, fleet-summary, point-search); every class carries a
   server-enforced token ceiling; truncation is reported in-band, loudly.
3. FTS index over text-bearing typed surfaces with bounded excerpts
   (`snippet()`-class windows); journal content indexed only post-ANSI-strip and
   only for archived generations.
4. **Live proof of non-interruption:** queries answered while a target agent is
   mid-turn; the agent's transcript and PTY show zero injected bytes.
5. **Token cost measured, not claimed** (graphify precedent): for a scripted
   session corpus, publish measured tokens per query class vs. the raw-journal
   baseline for the same questions; the story states its reduction target and
   the measurement method up front.
6. Absent-vs-empty discipline: every class distinguishes "no matches" from
   "surface absent/rotated/unbuilt", with a positive control in the test suite.
7. The isolation nonce test of §5, two-way, green in CI against two throwaway
   projects.

**S3.7 — Session digests and lifecycle (L2+L3 policy).** Depends on S3.6.
DoD sketch:

1. Digest compiled by a fresh summarizer on session end/landing/kill; never
   authored by the session's own agent; carries provenance pointers (event ids,
   journal ranges) for every load-bearing claim; labeled hint-not-authority.
2. Drill-down live proof: a digest claim is followed through its pointer to the
   exact typed rows/journal range that ground it.
3. Retention sweeps per §6 cadence, with per-tier retention constants in named
   config; a delete never breaks a live WorkManifest reference (referenced-check
   proven by test).
4. Stale-demotion and supersession for digest/decision content ride the existing
   memory status mechanics — no parallel state machine introduced.
5. Digest token cost measured: catch-up question answered from digest vs. from
   L1 search vs. from raw, three-way numbers published.

**Defer to M4/M5:** hierarchy-aware rollups (subtree rollups belong to S4.3/S4.5
where the hierarchy exists), WorkspaceSnapshot v2 / CommunicationProjection
freezes (M5 S5.x already owns them), any embedding or community-summary index
(only if S3.6's measured numbers show a class of question L1+L2 cannot answer
within budget), and cross-project *global* lesson mining (a memory-system
write-policy question, not a retrieval question).

**Why M3 is the right home:** S3.2's wake budgets and S3.3's journal-first
recovery both *consume* this read side; building it later would force interim
ad-hoc readers that the cutover (S3.5) would then have to delete. The
methodology's §4a names M3 as the likely home; this research confirms it with
the dependency argument, not just affinity.

## 8. Sources

External (all verified 2026-07-20):

- RAPTOR: [arXiv 2401.18059](https://arxiv.org/abs/2401.18059)
- MemGPT: [arXiv 2310.08560](https://arxiv.org/abs/2310.08560) / [ar5iv](https://ar5iv.labs.arxiv.org/html/2310.08560)
- GraphRAG: [Microsoft Research project page](https://www.microsoft.com/en-us/research/project/graphrag/), [announcement](https://www.microsoft.com/en-us/research/blog/graphrag-new-tool-for-complex-data-discovery-now-on-github/), [dynamic community selection](https://www.microsoft.com/en-us/research/blog/graphrag-improving-global-search-via-dynamic-community-selection/)
- LazyGraphRAG: [Microsoft Research blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)
- Event sourcing: [Fowler 2005](https://martinfowler.com/eaaDev/EventSourcing.html), [Azure event-sourcing pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing), [Greg Young CQRS materials](https://github.com/shamash2014/awesome-cqrs-event-sourcing)
- Grafana Loki: [architecture](https://grafana.com/docs/loki/latest/get-started/architecture/), [storage operations](https://grafana.com/docs/loki/latest/operations/storage/), [label best practices](https://grafana.com/docs/loki/latest/get-started/labels/bp-labels/)
- SQLite FTS5: [official documentation](https://www.sqlite.org/fts5.html)
- Elasticsearch ILM: [hot-warm-cold with ILM](https://www.elastic.co/blog/implementing-hot-warm-cold-in-elasticsearch-with-index-lifecycle-management), [data tiers](https://www.elastic.co/docs/manage-data/lifecycle/data-tiers)
- Thanos compaction/downsampling: [component docs](https://thanos.io/v0.8/components/compact/), [retention clarification issue #813](https://github.com/thanos-io/thanos/issues/813)
- OpenTelemetry GenAI semantic conventions (schema alignment for v2 envelopes): [OTel blog, GenAI observability](https://opentelemetry.io/blog/2026/genai-observability/)
- Copilot memory revalidation + TTL, Zep/Graphiti bi-temporal model, Mem0 write
  gate, Letta MemFS: surveyed with primary links in
  [docs/agents/memory.md](../docs/agents/memory.md) (vendor mechanics re-verify
  caveat applies).

In-repo: `planning/terminal-ownership-methodology.md` (§1, §3, §4a–c);
`planning/backlog-outline.md` (M3 S3.1–S3.5, M4, M5);
`docs/graphify/integration.md` (degradation contract, truncation trap, locate);
`docs/graphify/bundling.md` (ships-because-proven);
`docs/agents/memory.md`; `docs/agents/context-and-recycling.md`;
`docs/design/hive-communication.html` (S3.1 record definitions);
`native/sessiond/src/terminal_state.zig` (journal constants);
live state inventory under `~/.hive` (2026-07-20).
