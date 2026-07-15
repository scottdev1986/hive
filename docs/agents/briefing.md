# Briefing: how Hive discovers a repo and what a spawn actually carries

Updated: 2026-07-15
Sources: Hive source tree, 2026-07-15; [SPEC decision 14](../../SPEC.md)

## Summary

Every mechanism that makes a Hive spawn cheap — the scoped brief, the memory index — must not assume it knows the repo's shape. The one thing Hive derives from a repo it did not write is **which docs are briefable and which is primary**, and it discovers that **on demand** from the tree: `discoverBriefableDocs` (`src/adapters/briefing-docs.ts`) walks the repo when a spawn needs it, and `buildScopedBrief` (`src/adapters/brief.ts`) extracts the sections a task cites. Nothing is stored, cached, or compiled in — no document name, design-doc convention, or build command is Hive-repo-specific. This page records how discovery works, the load-bearing lessons behind it (scoped walks, links not mentions), what `hive init` owns, and the measured token facts that justify a scoped brief at all.

## Agent hierarchy and addressing

Workers report to queen. The root process is the orchestrator; its name is queen. Prefer queen in `hive_send`, completion reports, blockers, escalations, and any prose that tells a human or agent who to address. Explanatory wording such as "the orchestrator (queen) is in charge" is fine. The architectural role name orchestrator stays in capability matrices, routing prose ("the orchestrator classifies"), CLI flags (`--orchestrator`), and module paths. Input or docs that still say `orchestrator` as a recipient remain understood — naming is not a new authority boundary and does not change the read-only root role.

## How doc discovery actually works

`discoverBriefableDocs` (`src/adapters/briefing-docs.ts:184`) reads the tree fresh on every call — zero model tokens, no cache — and returns the briefable `.md` set, the doc directories that held any, and the primary design doc. `loadBriefConfig` in `src/adapters/brief.ts` turns that into the brief inputs; a repo whose docs cannot be walked briefs **nothing** rather than falling back to Hive's own doc names. That is the safe, portable default, and it is why Scott's binding constraint — **Hive works with any repo; nothing Hive-repo-specific in the product** — holds at this seam.

Two properties of the walk are subtle, load-bearing, and each cost an incident to learn.

### Doc directories read from disk; root docs use the tracked inventory

Discovery is a **scoped on-disk walk** of `DOC_DIRECTORIES` — `docs/`, `doc/`, `research/`, `rfcs/`, `rfc/`, `design/`, `.github/` (`src/adapters/briefing-docs.ts:29-40`) — plus tracked root-level `.md` files from `git ls-files`. A non-git repository falls back to reading its root directory (`listRootMarkdown`, `src/adapters/briefing-docs.ts:42-60`). A design doc can be called anything, so every tracked root markdown file is a candidate and inbound-link ranking finds the primary.

> **Inside a conventional doc directory, a doc is briefable because it is *there*, not because it is *tracked*.** (`listMarkdownUnder`, `src/adapters/briefing-docs.ts:76-102`)

`docs/` may be gitignored local working state and still be exactly what an agent needs briefing on. A previous directory-wide `git ls-files` implementation meant that gitignoring `docs/` silently deleted the entire briefable corpus and demoted the primary design doc — a failure with no error message, discovered only because briefing quietly stopped working. An ignored markdown file at the repository root is different: it is not in the tracked root inventory.

### The walk is deliberately scoped — and that scope is the whole reason dropping `ls-files` is free

The walk recurses only within `<root>/<dir>`. This is not tidiness. A walk from the repo root would descend into `node_modules/`, `dist/`, and — worst — **`.hive/worktrees/<agent>/`, which holds a full checkout of the repo, its own `docs/` included, and would duplicate the corpus once per live agent** (`src/adapters/briefing-docs.ts:76-102`). Scoping is what buys back the ignore-filtering that `ls-files` used to provide, at zero cost. Keep it scoped.

Caps exist because discovery sits on the spawn path and a pathological directory must not hang a spawn: `DOC_WALK_MAX_DEPTH = 8`, `DOC_WALK_MAX_FILES = 500` (`src/adapters/briefing-docs.ts:62-63`).

### `rankPrimaryDoc` counts inbound *citations*, not mentions

`rankPrimaryDoc` (`src/adapters/briefing-docs.ts:141-166`) picks the repo's primary design doc by counting how many times each doc is **linked to** across the corpus. `citedPaths` (`src/adapters/briefing-docs.ts:126-137`) extracts only markdown link targets — `](target)` and reference definitions `[label]: target` — never prose occurrences of a filename. Targets are compared by basename, so `../SPEC.md` and `./SPEC.md` both resolve. A small role boost of 1 goes to a basename starting with `spec`, `design`, `architecture`, or `readme` (`src/adapters/briefing-docs.ts:163`), so a young repo where little cites anything yet still gets a sensible primary. Ranking runs over the *root* docs, scored against links found in the *whole* briefable corpus (`discoverBriefableDocs`, `src/adapters/briefing-docs.ts:184`).

**The links-not-mentions distinction is load-bearing, and it was learned the hard way.** Counting mentions made the ranking a **popularity contest over prose** — any new document could win it by discussing a filename often enough, silently re-pointing the primary doc that *every agent in the fleet is briefed with*. That is a scoring change with fleet-wide blast radius and no error message.

The measurement that settled it:

| Doc | Inbound **links** | Bare **mentions** |
|---|---|---|
| `SPEC.md` | **5** | 23 |
| Claude conventions file | **0** | 23 |

**Mentions could not separate them. Links were decisive.** The extractor therefore reads link targets and never bare prose (`citedPaths`, `src/adapters/briefing-docs.ts:126-137`).

### The practical consequence, worth writing down

> **Adding or deleting docs changes what every agent gets briefed with.**

Deleting a doc that cites `SPEC.md` *lowers* SPEC.md's inbound count. A doc corpus is not inert: it is the input to a ranking that decides the primary design doc, and the primary design doc decides which bare-name `§` citations resolve. Restructure the docs tree with that in mind.

## What `hive init` owns

`hive init` (`src/cli/init.ts`) is the repo-only onboarding pass: it writes into the user's repo or spends their tokens, so running it is the authorization and every action is printed. It does **not** profile the repo, start a daemon, or open a window, and there is no `--refresh` flag — doc discovery is on demand, so there is no cache to rebuild. What it owns:

- When no `AGENTS.md` exists, **offer** to scaffold a starter one — opt-in, never blind. Codex caps the AGENTS.md chain at **32 KiB and truncates silently**, so Hive never appends to a human's existing instructions (`scaffoldAgentsMd` in `src/cli/init.ts`). The starter is generic — placeholder Commands/Stack sections a human fills in — plus the discovered primary design doc; Hive invents no build command it did not read.
- Seed a small set of narrative memory articles with `source: "init"` and a `verified` date — derived and re-derivable, distinct from the earned facts an agent learns.
- Graphify enablement.

It never ends by asking for another command: anything Hive can finish itself, it finishes there (seeded facts are indexed on the spot, not left with a note to go reindex them).

## The external survey behind all of this

**Claude Code `/init`** crawls manifests, existing docs, config, and structure to generate a `CLAUDE.md` with build/test/lint commands, architecture patterns, conventions, and workflows. Two lessons. It is explicitly framed as **a starting point, not a finished product** — Anthropic's own guidance says it "captures obvious patterns but may miss nuances." And it is **on-demand, not automatic**, because it spends model tokens crawling.

**Codex / AGENTS.md.** Global scope first, then Git-root *down* to cwd, at most one file per directory, concatenated root-to-current with files closer to cwd appearing later and therefore overriding. Precedence is **positional, not semantic**. The chain stops at `project_doc_max_bytes` (**32 KiB** default) and **truncation is silent — no warning when instructions are cut.** The chain is rebuilt every run; there is no cache to clear. `AGENTS.md` is the conventions layer and it is *already portable*: both Codex and Claude Code load it natively with zero Hive machinery, so Hive should never reinvent conventions delivery — only record *that* a conventions file exists and *where*.

**aider's repo map — the reference design for a ranked, budgeted index.** Parse each source file with **tree-sitter**, pull `def` and `ref` tags, build a file-level dependency graph, rank symbols with **PageRank personalized by the files currently in the chat**, and **binary-search** how many ranked tags fit a token budget (`--map-tokens`, default 1k). Render through `TreeContext` — signatures and enclosing scope, not bodies. The transferable ideas: **a repo index is ranked and budgeted, not exhaustive**; the budget is an explicit knob; the ranking is re-personalizable to the task. Hive's scoped brief is the doc-level analogue of this, and `rankPrimaryDoc` is its doc-level PageRank.

**Cursor rules generation.** `/Generate Cursor Rules` works **by example, not by crawl**: attach a few of your best-written files and the model extracts the patterns. Convention capture grounded in **exemplar files** beats capture from a generic template. If Hive's init ever authors a conventions narrative, it should read the repo's own best files, not emit boilerplate.

**The cross-cutting lesson Hive took further than the survey.** Every tool in the survey lands on "generate a file once, let a human maintain it." Hive does not generate or maintain such a file at all: it discovers a repo's docs **on demand** and derives nothing else from a repo it did not write. Conventions ride the vendor's own native instructions file (`AGENTS.md` / `CLAUDE.md`); build commands are never guessed, so the landing gate stays repo-neutral; the only repo-derived thing a spawn carries is the scoped brief, computed fresh each time.

## Why a scoped brief at all: the measured token facts

Measured on this machine on 2026-07-10 by differencing two `claude -p` runs — not estimated:

| What the spawn prompt carries | Input tokens |
|---|---|
| `SPEC.md` embedded whole, as a task saying "read SPEC.md" | **18,726** |
| …replaced by a scoped brief naming a section (`SPEC §6`) | **1,882** |
| …replaced by an outline, when no section is named | **421** |
| `standard` spawn prompt | 579 |
| `cheap` spawn prompt | 398 |

> **The document lever is two orders of magnitude bigger than the other three combined.**

That is the whole justification for the brief mechanism: an agent told "read the spec" reads all ~20K tokens of it to find the two sections its task actually named; the brief has the daemon do that extraction **once, at spawn**, and hands the agent the sections plus a `file:line` outline of everything it did *not* embed. Reading deeper becomes an opt-in the agent makes with a specific destination, rather than a reflex.

The brief rides into the prompt through `options.brief` (`src/daemon/spawner-impl.ts`, spliced into the agent prompt at spawn) — so any future handoff artifact can ride the same channel with no new plumbing.

The caps are deliberate: a whole doc under `WHOLE_DOC_MAX_CHARS` (4,000) is cheaper to embed than to make the agent burn a tool call opening it; one section's body is capped at `SECTION_MAX_CHARS` (6,000) chars, and the whole brief at `BRIEF_MAX_CHARS` (12,000) (`src/adapters/brief.ts:37-41`). And the briefable-doc allowlist is a *security* boundary as much as an economy one: a task naming any path outside it is ignored, because **the brief must never become a way to paste arbitrary repo files into a prompt** (`src/adapters/brief.ts`, `resolveBriefablePath`).

**The open measurement:** the brief only pays off if queen *writes* briefs that cite their sources. `ORCHESTRATOR_BRIEF` instructs the orchestrator to ("Name the sections; never tell an agent to read a document whole"), and nothing measures whether it does. The cheapest check is a count of spawn task descriptors containing a `§` or a `.md` path, which the daemon already logs.

## See Also

- [Context degradation and agent recycling](context-and-recycling.md) — what a respawn re-pays, and why the ~33K cold start is not free
- [Agent memory](memory.md) — the narrative tier, distinct from the derivable repo facts discovery finds
- [Rejected approaches](../routing/rejected-approaches.md) — the full token-efficiency measurements
- [Launch mechanics](../providers/launch-mechanics.md) — how the spawn prompt reaches the vendor CLI
- [Database resilience](../daemon/database-resilience.md) — the sibling invariant: an unobserved value is null, not zero
- [SPEC.md decision 14](../../SPEC.md) — starting into a repo
