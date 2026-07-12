---
name: hive-memory
description: Maintain Hive's durable repo knowledge by compiling immutable observations into canonical articles. Use for memory ingestion or migration, deliberate article consolidation and cascade updates, memory queries, conflict reconciliation, or linting .hive/memory and ~/.hive/memory.
---

# Hive Memory

Make repository knowledge converge. Preserve what an agent measured or was told as immutable evidence, but make future agents read one owned, current account of each concept—not a pile of claims and corrections.

Routine `memory_write` calls enforce the storage schema. Use this skill for the judgment-heavy compile, cascade, query, and lint operations.

## Architecture

Maintain the same shape in each scope root:

```text
<scope>/
├── raw/<topic>/<observation>.md
└── wiki/
    ├── <topic>/<article>.md
    ├── index.md
    └── log.md
```

Use `.hive/memory/` for repo scope and `~/.hive/memory/` for global scope.

- Treat `raw/` as immutable evidence. Never edit or delete an observation. Record the measured or supplied claim, date, writer provenance, evidence, verification status, and supersedes relationships.
- Treat `wiki/` as compiled knowledge Hive fully owns. Rewrite articles to state the best current account, merge duplicates, preserve correction history without presenting it as current truth, cross-link related articles, and annotate unresolved source conflicts explicitly.
- Keep exactly one topic-directory level: `wiki/<topic>/<article>.md` and `raw/<topic>/<observation>.md`. Reuse a close existing topic before creating one. Prefer repo subsystem topics such as `routing`, `quota`, `delivery`, `telemetry`, `landing`, `graphify`, and `workspace-ui`.
- Keep `wiki/index.md` to one compact row per article. Hive injects this surface on every spawn, so never put article bodies, evidence narratives, or raw-source lists in it.
- Append operations to `wiki/log.md`. Never rewrite prior log entries.

## Ingest and compile

1. Search compiled articles before writing.
2. Record the new observation through `memory_write`. Supply every required field: `scope`, `topic`, `source`, `evidence`, `status`, and `supersedes`, plus the article title/body. Use an empty supersedes array only when the observation corrects nothing.
3. Choose the compiled target:
   - Same concept: update the existing article id.
   - New concept: create one article named for the concept.
   - Multiple concepts: update or create each materially distinct article; link them.
4. State current truth first. Move an old belief into a clearly labeled history or conflict passage, explain why it changed, and link its raw observation. Never leave `CORRECTED:` in the current title and never append a contradiction as if both claims remain live.
5. When sources disagree and the evidence cannot decide, set status `conflicted`, attribute each claim, and say what evidence would resolve it. Do not silently pick a winner.
6. Cascade: inspect the same topic, then use the global index to find related cross-topic articles. Update every article materially changed by the observation. Refresh each index row and append one ingest log entry naming cascade updates.

The daemon creates immutable raw observations, writes compiled articles, rebuilds the scope index, appends the log, and refreshes search. Do not bypass it for routine writes. Direct file editing is reserved for deliberate compilation where several articles must be merged; preserve all referenced raw files and run `memory_reindex` afterward.

## Query

1. Read `wiki/index.md` in the relevant scope.
2. Read only the relevant compiled articles with `memory_read`; search wider with `memory_search`.
3. Prefer compiled articles over raw observations and model training knowledge. Treat `unverified`, `stale`, and `conflicted` articles as claims to reconcile before acting.
4. Cite compiled articles. Open raw observations only when evidence or correction history matters.
5. Answer without writing unless explicitly asked to archive or update memory.

## Lint

Run deterministic fixes first:

- Rebuild `wiki/index.md` from compiled articles; add missing rows and mark rows whose targets are missing rather than silently deleting them.
- Fix an internal article link only when its filename has exactly one match. Report zero or multiple matches.
- Fix a raw link only when its filename has exactly one match under `raw/`. Report zero or multiple matches.
- Remove links to deleted compiled articles and add obvious missing same-topic links.
- Reject nested topic directories, duplicate article ids within a scope, mutable or missing raw observations, and compiled articles missing required metadata.

Then report, but do not auto-fix, heuristic findings:

- duplicate or overlapping articles;
- current claims contradicted by newer evidence;
- correction prose masquerading as current truth;
- missing conflict annotations;
- stale or unverified articles that have never been reconciled;
- orphan articles, missing cross-topic links, and recurring concepts with no article;
- supersedes ids that do not resolve to an article or preserved raw history.

Append `## [YYYY-MM-DD] lint | <N> issues found, <M> auto-fixed` to `wiki/log.md`.

## Migration

Treat each legacy flat fact as source material, not as an already-correct article. Before the first corpus write, snapshot the entire scope to the sibling `memory-backups/legacy-v1-<UTC timestamp>/`. Leave every flat source byte-for-byte in place, copy it verbatim into `raw/`, then compile it. Preserve missing verification as `unverified`, preserve an older verification as `stale`, and use `source: legacy` when authorship is unknown rather than inventing provenance. Merge duplicate and correction pairs into one article. Retain the former belief and the evidence that overturned it in history or conflict prose. If a fact cannot be compiled, keep its raw observation, create a flagged article, and report it; never silently drop it. A completed migration writes its marker last; if that marker exists, do not migrate, duplicate, or back up the same corpus again.

After migration, run `memory_reindex`, lint both scopes, and confirm the spawn index remains capped and contains only compiled article pointers.
