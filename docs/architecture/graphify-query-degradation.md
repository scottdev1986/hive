# Graphify query degradation: measured findings

Read-only investigation (agent `ashley`, 2026-07-12). Every claim below is tagged
**MEASURED** (I ran it, output reproduced) or **INFERRED** (reasoning from measurements).
The pinned binary — `~/.hive/tools/graphify/venv/bin/graphify`, v0.9.12 — is the source of
truth throughout; upstream web docs were not consulted and are not trusted.

## Headline

Hive **is** leaving a better-grounded answer format on the table, but not for the reason the
task hypothesised. There is no hidden "cited mode" flag. `graphify query` already emits
provenance-tagged relations — `EDGE a --relation [EXTRACTED context=call]--> b` — and it
already emits `file:line` on every node. Hive never sees the edges because **the serializer
writes all nodes first and all edges last, and both of Hive's two truncation limits cut from
the head.** The relational payload is always the part that falls off the end.

Fixing this is *not* a matter of raising `--budget`. Raising the budget alone changes nothing,
because Hive's 6 KB character cap re-truncates the same head. Both limits must move together,
or the brief must select the tail.

## Q1 — Is there a cited-output mode Hive is failing to use?

**MEASURED.** No hidden flag. `graphify query --help` offers exactly `--dfs`, `--context`,
`--budget`, `--graph`. None of them toggle citation or provenance.

But the output format already carries both, and the premise in the task brief ("NO file:line
citations and NO EXTRACTED/INFERRED tags whatsoever") is **half wrong**:

- Every `NODE` line already carries a citation:
  `NODE HiveSpawner [src=src/daemon/spawner-impl.ts loc=L638 community=7]`
- Every `EDGE` line already carries a provenance tag:
  `EDGE graphify.ts --imports_from [EXTRACTED context=import]--> profile.ts`
  `EDGE agent() --indirect_call [INFERRED context=collection]--> timestamp()`

The two agents that reported "bare symbol names" were seeing the node section only. They never
reached the edge section. That is the whole bug.

**MEASURED** — graph-level tag census over `graph.json` (9,081 nodes / 23,159 edges): edges
carry a `confidence` field valued `EXTRACTED` (4,819) or `INFERRED` (181) in the first 5,000
sampled. No `AMBIGUOUS` value appeared. The upstream doc's three-way tag vocabulary is, on this
graph, effectively two-way.

CLI and MCP are the **same code path**: identical `Traversal:` header, identical `NODE`/`EDGE`
grammar, identical truncation behaviour. Neither cites more than the other.

## Q2 — Is Hive's own invocation degrading the output? **Yes. This is the finding.**

Hive runs (`src/adapters/graphify.ts:338-348`):

    graphify query "<task>" --budget 1200 --graph <graph.json>

then slices the result to `GRAPH_BRIEF_MAX_CHARS = 6_000` (`graphify.ts:319, 359`).

**MEASURED** — same question, same graph, budget swept. Question was the one both agents failed:
*"where does the daemon attach the graphify MCP server to a spawning agent"*.

| `--budget` | NODE lines | EDGE lines | chars |
|-----------:|-----------:|-----------:|------:|
| 1200 (Hive's) | 51 | **0** | 3,845 |
| 2000 (CLI + MCP default) | 86 | **0** | 6,261 |
| 4000 | 162 | **0** | 12,196 |
| 8000 | 325 | **0** | 24,217 |
| 16000 | 336 | 333 | 48,260 |
| 40000 | 336 | 436 | 55,663 |

The shape does not change with budget — the header and the `NODE`/`EDGE` grammar are constant.
Only the *cut point* moves. Edges begin appearing on this graph somewhere between budget 8000
and 16000, i.e. at roughly **13× Hive's setting**.

**MEASURED** — the character cap independently guarantees the same loss. Taking the *full*
budget-40000 output and keeping only its first 6,000 characters (exactly what
`output.slice(0, GRAPH_BRIEF_MAX_CHARS)` does) yields **0 EDGE lines**. So even if the budget
were raised to 40000 today, the brief Hive injects would still contain zero edges. **The two
limits are redundant, and both fail in the same direction.**

**MEASURED** — the MCP tool inherits the identical defect. `query_graph`'s schema defaults
`token_budget: 2000`, which by the table above yields zero edges. Calling it by hand with
`token_budget: 16000` returned 83 nodes *and* 79 provenance-tagged edges. Agents calling the
tool with defaults — which is what the harness nudge tells them to do — get the degraded shape
every time.

## Q3 — `path` and `explain`: cited output, and partly MCP-invisible

**MEASURED.** Both exist on the pinned CLI and both produce exactly the compact, cited,
provenance-tagged output the upstream docs advertise — far denser per byte than a truncated
`query`:

    $ graphify explain "HiveSpawner"
    Node: HiveSpawner
      Source:    src/daemon/spawner-impl.ts L638
      Degree:    26
    Connections (26):
      <-- spawner-impl.ts [contains] [EXTRACTED]
      --> .spawn() [method] [EXTRACTED]
      ...

    $ graphify path "spawner-impl.ts" "graphify.ts"
    warning: target match was ambiguous (top score 55627.9, runner-up 55627.9)
    Shortest path (2 hops):
      spawner-impl.ts --imports_from [EXTRACTED]--> profile.ts <--imports_from [EXTRACTED]-- graphify.ts

MCP exposure, measured against the live server's tool schemas:

- `path` **is** exposed, as `shortest_path` (`source`, `target`, `max_hops`).
- `explain` is **not** exposed under that name; `get_neighbors` is the nearest equivalent.
- `affected` (reverse-impact traversal) and `diagnose` are **CLI-only** — no MCP tool.

The CLI also carries subcommands with no MCP counterpart that nobody in Hive currently uses:
`affected`, `diagnose multigraph`, `save-result`.

## Q4 — Is the graph poisoned? Yes — 49% vendored.

**MEASURED** — bucketing all 9,081 nodes in `graphify-out/graph.json` by `source_file`:

| nodes | share | origin |
|------:|------:|--------|
| 4,469 | **49.2%** | `workspace/.build/checkouts/` (vendored SwiftTerm, swift-argument-parser) |
| 2,535 | 27.9% | `src/` (Hive TypeScript — the code anyone actually asks about) |
| 1,024 | 11.3% | **no `source_file` at all** (untraceable: `Int`, `cstring`, …) |
| 517 | 5.7% | `workspace/` (Hive's own Swift) |
| 471 | 5.2% | `prototypes/` |
| ~65 | 0.7% | config/scripts |

Half the graph is third-party Swift that no Hive agent will ever ask about, and a further 11%
of nodes cannot be cited at all because they have no source file.

**Where the damage actually lands — MEASURED, and it is not where I expected.** For the failing
question, only 11 of the 336 *reachable* nodes were vendored. The poisoning hurts at
**start-node selection**, not traversal: the keyword matcher resolved `spawning` to
`workspace/Sources/WorkspaceCore/AgentFeed.swift` and `.attach()` to
`SwiftTerm/BufferLine.swift`. The layer-1 digest in my own spawn brief is the extreme case — its
start-node list is almost entirely `MDocSerializationContext`, `BashCompletionsGenerator.swift`,
`UInt16`, `SplitMix64`, plus bare stopwords (`bin`, `both`, `two`, `text`, `trust`). The query
anchors on vendored Swift and stopwords, then traverses outward from the wrong place.

**MEASURED** — exclusion is a **`.graphifyignore` question, not a build-flag question**. The
pinned binary implements `_load_graphifyignore(root)` in `graphify/detect.py` and calls it from
`graphify/extract.py` (two call sites, gitignore-style patterns, applied during the file walk).
`extract --help` exposes no `--exclude`/`--ignore` flag. The repo currently has **no
`.graphifyignore`** and Hive never writes one (`grep -rn graphifyignore src/` → no hits).

**INFERRED** — a `.graphifyignore` excluding `workspace/.build/` would remove ~49% of nodes and,
more importantly, remove the vendored symbols from the start-node candidate pool. It would not
by itself fix the ordering bug in Q2 — a clean graph still emits all nodes before any edge — but
it would shrink the node section enough that a given budget reaches further into the edges.

## What I did *not* establish

Even with edges restored at budget 16000, the query still did **not** surface the true answer
(`src/daemon/spawner-impl.ts`, `src/adapters/tools/claude.ts`, `src/adapters/tools/mcp-scope.ts`);
it returned the graphify *implementation* module. So edge restoration is necessary but I have
**not** shown it is sufficient for relevance. Plain grep still beat the graph on this question.
I did not rebuild the graph with exclusions, so the size of that win is inferred, not measured.

## Proposed change (not made — this was read-only)

Three independent defects; they compose, and I'd do them in this order.

1. **Stop truncating the edges away (the real fix).** Raising `--budget` alone is a no-op —
   the 6 KB char cap re-truncates the same head. Either raise both together, or, better, make
   `buildGraphBrief` select rather than slice: keep the `Traversal:` header, a bounded number of
   `NODE` lines, and then the `EDGE` lines, which are the only provenance-tagged content in the
   output. Header + all edges alone was 30,897 chars for this query, so edges need their own
   budget too — this is a selection problem, not a "turn the cap up" problem.

2. **Write a `.graphifyignore`** covering `workspace/.build/` (and consider `prototypes/`) and
   rebuild. This is the only supported exclusion mechanism on the pinned binary. It removes the
   vendored half of the graph and, critically, de-poisons start-node selection.

3. **Raise the MCP nudge's default.** `query_graph`'s `token_budget` defaults to 2000, which
   provably returns zero edges. The harness nudge should tell agents to pass a budget that
   actually reaches the relational payload, or Hive should attach the server with a higher
   default. Consider also pointing agents at `shortest_path` and `get_neighbors`, which return
   cited, tagged output *without* a truncation cliff.

The honest framing for the doc: graphify's `query` is a **breadth-first node dump with a
relational appendix**, and Hive has been reading only the dump. Upstream's "explicit paths with
citations" example corresponds to `path`/`explain`, not to `query`.
