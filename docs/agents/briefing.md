# Briefing: how Hive discovers a repo and what a spawn actually carries

Updated: 2026-07-13
Sources: Hive source tree, 2026-07-13; docs/research/repo-startup-and-init.md; docs/research/model-routing-and-token-efficiency.md; SPEC.md decision 14

## Summary

Every mechanism that makes a Hive spawn cheap — the scoped brief, the memory index, the landing gate's test command — silently assumes it knows the repo's shape. That knowledge used to be compiled in; it is now **discovered**, by a tracked root-doc inventory, scoped on-disk walks of conventional doc directories, and an inbound-citation ranking that runs in 56 ms at every session boundary. This article records how discovery actually works, the two subtleties that are load-bearing and were learned the hard way, and the measured token facts that justify a scoped brief at all.

## Correction: the allowlist is no longer hardcoded

The research this article compiles opens on a premise that was true when written and is **false now**. It claimed `src/adapters/brief.ts` "ships a literal `["SPEC.md", "README.md", "CLAUDE.md"]` allowlist and a bare-name `SPEC §6` special case." SPEC decision 14 still narrates that hardcode as the *problem*, and readers have mistaken the narration for the current state.

Verified against the tree on 2026-07-13, it is fixed:

- `src/adapters/brief.ts:5-15` defines only profile-supplied briefing inputs; no repository document name is compiled in.
- `src/adapters/brief.ts:24-33` (`loadBriefConfig`) reads `briefableDocs`, `briefableDirectories`, and `primaryDoc: profile.docs.primary` from the profile — and a repo whose profile cannot be built briefs **nothing**, rather than falling back to Hive's own doc names. That is the safe, portable default.
- `src/adapters/brief.ts:168-189` derives the bare-name rule from `primaryDoc`: a task citing `DESIGN §3` in a repo whose profile names `DESIGN.md` primary gets the same treatment `SPEC §6` gets here. `primaryDoc` may be `null`, in which case the special case simply does not exist — a special case that turned out never to have been needed.

Scott's binding constraint — **Hive works with any repo; nothing Hive-repo-specific in the product** — is satisfied at this seam.

## How doc discovery actually works

Two properties of `src/adapters/profile.ts` are subtle, load-bearing, and each cost an incident to learn.

### Doc directories read from disk; root docs use the tracked inventory

Discovery is a **scoped on-disk walk** of `DOC_DIRECTORIES` — `docs/`, `doc/`, `research/`, `rfcs/`, `rfc/`, `design/`, `.github/` (`profile.ts:508-518`) — plus tracked root-level `.md` files from `git ls-files`. A non-git repository falls back to reading its root directory (`profile.ts:520-539`). A design doc can be called anything, so every tracked root markdown file is a candidate and inbound-link ranking finds the primary.

> **Inside a conventional doc directory, a doc is briefable because it is *there*, not because it is *tracked*.** (`profile.ts:547-581`)

`docs/` may be gitignored local working state and still be exactly what an agent needs briefing on. The previous directory-wide `git ls-files` implementation meant that gitignoring `docs/` silently deleted the entire briefable corpus and demoted the primary design doc — a failure with no error message, discovered only because briefing quietly stopped working. An ignored markdown file at the repository root is different: it is not in the tracked root inventory.

### The walk is deliberately scoped — and that scope is the whole reason dropping `ls-files` is free

The walk recurses only within `<root>/<dir>`. This is not tidiness. A walk from the repo root would descend into `node_modules/`, `dist/`, and — worst — **`.hive/worktrees/<agent>/`, which holds a full checkout of the repo, its own `docs/` included, and would duplicate the corpus once per live agent** (`profile.ts:547-581`). Scoping is what buys back the ignore-filtering that `ls-files` used to provide, at zero cost. Keep it scoped.

Caps exist because discovery sits on the spawn path and a pathological directory must not hang a spawn: `DOC_WALK_MAX_DEPTH = 8`, `DOC_WALK_MAX_FILES = 500` (`profile.ts:542-545`).

### `rankPrimaryDoc` counts inbound *citations*, not mentions

`rankPrimaryDoc` (`profile.ts:621-650`) picks the repo's primary design doc by counting how many times each doc is **linked to** across the corpus. `citedPaths` (`profile.ts:606-615`) extracts only markdown link targets — `](target)` and reference definitions `[label]: target` — never prose occurrences of a filename. Targets are compared by basename, so `../SPEC.md` and `./SPEC.md` both resolve. A small role boost of 1 goes to a basename starting with `spec`, `design`, `architecture`, or `readme` (`profile.ts:643-646`), so a young repo where little cites anything yet still gets a sensible primary. Ranking runs over the *root* docs, scored against links found in the *whole* briefable corpus (`profile.ts:653-670`).

**The links-not-mentions distinction is load-bearing, and it was learned the hard way.** Counting mentions made the ranking a **popularity contest over prose** — any new document could win it by discussing a filename often enough, silently re-pointing the primary doc that *every agent in the fleet is briefed with*. That is a scoring change with fleet-wide blast radius and no error message.

The measurement that settled it, taken when the fix landed:

| Doc | Inbound **links** | Bare **mentions** |
|---|---|---|
| `SPEC.md` | **5** | 23 |
| Claude conventions file | **0** | 23 |

**Mentions could not separate them. Links were decisive.** The extractor therefore reads link targets and never bare prose (`profile.ts:606-615`).

### The practical consequence, worth writing down

> **Adding or deleting docs changes what every agent gets briefed with.**

Deleting a doc that cites `SPEC.md` *lowers* SPEC.md's inbound count. A doc corpus is not inert: it is the input to a ranking that decides the primary design doc, and the primary design doc decides which bare-name `§` citations resolve. Restructure the docs tree with that in mind.

## The profile is a cache, not a document

`ensureProfile` runs at every session boundary — bare `hive` and the vendor-specific Workspace commands through `startSession` (`src/cli/start.ts:125`), the orchestrator (`src/cli/orchestrator.ts:192`), the daemon (`src/daemon/server.ts:1048-1057`), every spawn (`src/daemon/spawner-impl.ts:1893-1910`), and `loadBriefConfig` itself (`src/adapters/brief.ts:26`). It is **silent** when successful: there is no init step to run and no refresh to remember.

It lives in Hive's own per-project state directory — `~/.hive/projects/<hiveUuid>/profile.toml` (`profile.ts:59-79`) — keyed by the identity the project registry already mints, so it survives the repo being moved or renamed, and **every linked worktree of a repo reads the one project profile** rather than quietly profiling its own branch. It is not in the repo, not in anyone's diff, and not anyone's business.

**It shipped committed at `.hive/profile.toml` first, and lost to a measurement.** Generating it is a `git ls-files`, some `stat`s, and a read of the repo's markdown: **56 ms and zero model tokens.** What committing it spared a teammate was 56 ms. What it cost was a file in every diff plus — because a cached artifact in a tree that moves must be checked — a staleness concept, a staleness message, and a `hive init --refresh` command for a human to run. All three were built, and all three were the disease: the user updated, started Hive, and was told the profile was "20 commits stale" and that they should go fix it by hand. Regenerating produced **byte-identical** doc names and commands. The nag was real and the staleness was not.

> **A derived artifact that is cheap to rebuild should never be something a human maintains, and should never be somewhere a human has to look at it.**

### Two traps in the durable-artifact design

**The staleness-fingerprint trap.** A fingerprint must hash the profile's own *inputs* — the doc inventory, manifests, lockfiles, conventional entry files.

> **Do not fold the Git tree hash into that signal.** It is tempting because one hash covers every committed change, and it is wrong, because it makes every commit to every file invalidate a profile whose derived answers did not move. **A fingerprint must hash what *determines* the output, or "stale" stops meaning "wrong."**

**The frozen-cap trap.** The profile used to carry an `index_budget` — a file count and a derived `map_tokens` cap, aider's `--map-tokens` made explicit, sized so a monorepo's index could not drown every context it touched. It was built and then deleted: nothing ever read the number, and caching it meant every commit that added a file invalidated the profile — which is precisely how a *correct* profile came to look stale. aider recomputes its map budget per run, and that is the right shape.

> **A size-derived cap belongs at the point of use, not frozen into a durable artifact.**

## What `hive init` is left owning

Profiling is not a command. `hive init` (`src/cli/init.ts:1-20`) owns **only** the tier that must be asked for, because it writes into the user's repo or spends their tokens:

- When no `AGENTS.md` exists, **offer** to scaffold one — opt-in, never blind. Codex caps the AGENTS.md chain at **32 KiB and truncates silently**, so Hive never appends to a human's existing instructions (`init.ts:9-10`, `scaffoldAgentsMd` at `init.ts:258`).
- Seed a small set of narrative memory articles with `source: "init"` and a `verified` date — derived and re-derivable, distinct from the earned facts an agent learns. **Structured facts never become memory**; they are already in the profile.

Running the command is the authorization, every action is printed, and it never ends by asking for another command: anything Hive can finish itself, it finishes there (seeded facts are indexed on the spot, not left with a note to go reindex them).

## The external survey behind all of this

**Claude Code `/init`** crawls manifests, existing docs, config, and structure to generate a `CLAUDE.md` with build/test/lint commands, architecture patterns, conventions, and workflows. Two lessons. It is explicitly framed as **a starting point, not a finished product** — Anthropic's own guidance says it "captures obvious patterns but may miss nuances." And it is **on-demand, not automatic**, because it spends model tokens crawling.

**Codex / AGENTS.md.** Global scope first, then Git-root *down* to cwd, at most one file per directory, concatenated root-to-current with files closer to cwd appearing later and therefore overriding. Precedence is **positional, not semantic**. The chain stops at `project_doc_max_bytes` (**32 KiB** default) and **truncation is silent — no warning when instructions are cut.** The chain is rebuilt every run; there is no cache to clear. `AGENTS.md` is the conventions layer and it is *already portable*: both Codex and Claude Code load it natively with zero Hive machinery, so Hive should never reinvent conventions delivery — only record *that* a conventions file exists and *where*.

**aider's repo map — the reference design for a ranked, budgeted index.** Parse each source file with **tree-sitter**, pull `def` and `ref` tags, build a file-level dependency graph, rank symbols with **PageRank personalized by the files currently in the chat**, and **binary-search** how many ranked tags fit a token budget (`--map-tokens`, default 1k). Render through `TreeContext` — signatures and enclosing scope, not bodies. The transferable ideas: **a repo index is ranked and budgeted, not exhaustive**; the budget is an explicit knob; the ranking is re-personalizable to the task. Hive's scoped brief is the doc-level analogue of this, and `rankPrimaryDoc` is its doc-level PageRank.

**Cursor rules generation.** `/Generate Cursor Rules` works **by example, not by crawl**: attach a few of your best-written files and the model extracts the patterns. Convention capture grounded in **exemplar files** beats capture from a generic template. If Hive's init ever authors a conventions narrative, it should read the repo's own best files, not emit boilerplate.

**The cross-cutting lesson Hive took further than the survey.** Every tool lands on "generate once, let a human maintain it," splitting cheap deterministic facts from expensive model-authored ones. Hive splits them by *who runs them*: the deterministic tier costs 56 ms and zero model tokens, so **every session boundary just does it, silently.** The measurement pushed Hive somewhere the survey did not — a fact this cheap to re-derive should never have been a human's to maintain.

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

That is the whole justification for the brief mechanism, and `src/adapters/brief.ts:5-9` states the inversion plainly: an agent told "read the spec" reads all ~20K tokens of it to find the two sections its task actually named; the brief has the daemon do that extraction **once, at spawn**, and hands the agent the sections plus a `file:line` outline of everything it did *not* embed. Reading deeper becomes an opt-in the agent makes with a specific destination, rather than a reflex.

The brief rides into the prompt through `options.brief` (`src/daemon/spawner-impl.ts:570-584`, spliced in at `:683-685`) — so any future handoff artifact can ride the same channel with no new plumbing.

The caps are deliberate: a whole doc under `WHOLE_DOC_MAX_CHARS` (4,000) is cheaper to embed than to make the agent burn a tool call opening it; one section's body is capped at 6,000 chars, and the whole brief at 12,000 (`brief.ts:35-41`). And the allowlist is a *security* boundary as much as an economy one: a task naming any path outside it is ignored, because **the brief must never become a way to paste arbitrary repo files into a prompt** (`brief.ts:5-15`, `:100-119`).

**The open measurement:** the brief only pays off if the orchestrator *writes* briefs that cite their sources. `ORCHESTRATOR_BRIEF` instructs it to (`src/cli/orchestrator-brief.ts:5`: "Name the sections; never tell an agent to read a document whole"), and nothing measures whether it does. The cheapest check is a count of spawn task descriptors containing a `§` or a `.md` path, which the daemon already logs.

## See Also

- [Context degradation and agent recycling](context-and-recycling.md) — what a respawn re-pays, and why the ~33K cold start is not free
- [Agent memory](memory.md) — the narrative tier the profile deliberately does not hold
- [Rejected approaches](../routing/rejected-approaches.md) — the full token-efficiency measurements
- [Launch mechanics](../providers/launch-mechanics.md) — how the spawn prompt reaches the vendor CLI
- [Database resilience](../daemon/database-resilience.md) — the sibling invariant: an unobserved value is null, not zero
- [SPEC.md decision 14](../../SPEC.md) — starting into a repo
