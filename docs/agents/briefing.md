# Briefing: how Hive discovers a repo and what a spawn actually carries

Updated: 2026-07-14
Sources: Hive source tree, 2026-07-14; [SPEC decision 14](../../SPEC.md); [profiling implementation plan](../design/profiling-implementation-plan.md)

## Summary

Every mechanism that makes a Hive spawn cheap — the scoped brief, the memory index, the landing gate's test command — silently assumes it knows the repo's shape. That knowledge used to be compiled in; it is **discovered** and written into a structured **repo profile**. Profile *storage and acceptance* for the agent-authored design are landed under `~/.hive/projects/<hiveUuid>/profile/{current.json,state.json}` (`src/schemas/project-profile.ts`, `src/daemon/project-profile.ts`). Profile *consumption by briefing* still uses the transitional deterministic reader (`src/adapters/profile.ts` via `ensureProfile` / `loadBriefConfig`) until plan package P8; this article must not be read as "brief already reads `current.json`." This page records how the brief is built today, how profiles are produced under the landed foundation, the load-bearing doc-discovery lessons, and the measured token facts that justify a scoped brief at all.

## Correction: the allowlist is no longer hardcoded

The research this article compiles opens on a premise that was true when written and is **false now**. It claimed `src/adapters/brief.ts` "ships a literal `["SPEC.md", "README.md", "CLAUDE.md"]` allowlist and a bare-name `SPEC §6` special case." SPEC decision 14 still narrates that hardcode as the *problem*, and readers have mistaken the narration for the current state.

Verified against the tree on 2026-07-14, it is fixed:

- `src/adapters/brief.ts:5-15` defines only profile-supplied briefing inputs; no repository document name is compiled in.
- `src/adapters/brief.ts:24-33` (`loadBriefConfig`) reads `briefableDocs`, `briefableDirectories`, and `primaryDoc: profile.docs.primary` from the profile — and a repo whose profile cannot be built briefs **nothing**, rather than falling back to Hive's own doc names. That is the safe, portable default.
- `src/adapters/brief.ts:168-189` derives the bare-name rule from `primaryDoc`: a task citing `DESIGN §3` in a repo whose profile names `DESIGN.md` primary gets the same treatment `SPEC §6` gets here. `primaryDoc` may be `null`, in which case the special case simply does not exist — a special case that turned out never to have been needed.

Scott's binding constraint — **Hive works with any repo; nothing Hive-repo-specific in the product** — is satisfied at this seam.

## How doc discovery actually works

The discovery rules below are what the **transitional** deterministic generator in `src/adapters/profile.ts` still uses, and what `loadBriefConfig` therefore still sees until consumer migration (plan package P8). The agent-authored profile will carry evidenced briefable/primary claims instead of re-running this scan in product code; the lessons (scoped walks, links not mentions) remain load-bearing for whoever authors those claims.

Two properties of `src/adapters/profile.ts` are subtle, load-bearing, and each cost an incident to learn.

### Doc directories read from disk; root docs use the tracked inventory

Discovery is a **scoped on-disk walk** of `DOC_DIRECTORIES` — `docs/`, `doc/`, `research/`, `rfcs/`, `rfc/`, `design/`, `.github/` (`src/adapters/profile.ts:508-518`) — plus tracked root-level `.md` files from `git ls-files`. A non-git repository falls back to reading its root directory (`src/adapters/profile.ts:520-539`). A design doc can be called anything, so every tracked root markdown file is a candidate and inbound-link ranking finds the primary.

> **Inside a conventional doc directory, a doc is briefable because it is *there*, not because it is *tracked*.** (`src/adapters/profile.ts:547-581`)

`docs/` may be gitignored local working state and still be exactly what an agent needs briefing on. The previous directory-wide `git ls-files` implementation meant that gitignoring `docs/` silently deleted the entire briefable corpus and demoted the primary design doc — a failure with no error message, discovered only because briefing quietly stopped working. An ignored markdown file at the repository root is different: it is not in the tracked root inventory.

### The walk is deliberately scoped — and that scope is the whole reason dropping `ls-files` is free

The walk recurses only within `<root>/<dir>`. This is not tidiness. A walk from the repo root would descend into `node_modules/`, `dist/`, and — worst — **`.hive/worktrees/<agent>/`, which holds a full checkout of the repo, its own `docs/` included, and would duplicate the corpus once per live agent** (`src/adapters/profile.ts:547-581`). Scoping is what buys back the ignore-filtering that `ls-files` used to provide, at zero cost. Keep it scoped.

Caps exist because discovery sits on the spawn path and a pathological directory must not hang a spawn: `DOC_WALK_MAX_DEPTH = 8`, `DOC_WALK_MAX_FILES = 500` (`src/adapters/profile.ts:542-545`).

### `rankPrimaryDoc` counts inbound *citations*, not mentions

`rankPrimaryDoc` (`src/adapters/profile.ts:621-650`) picks the repo's primary design doc by counting how many times each doc is **linked to** across the corpus. `citedPaths` (`src/adapters/profile.ts:606-615`) extracts only markdown link targets — `](target)` and reference definitions `[label]: target` — never prose occurrences of a filename. Targets are compared by basename, so `../SPEC.md` and `./SPEC.md` both resolve. A small role boost of 1 goes to a basename starting with `spec`, `design`, `architecture`, or `readme` (`src/adapters/profile.ts:643-646`), so a young repo where little cites anything yet still gets a sensible primary. Ranking runs over the *root* docs, scored against links found in the *whole* briefable corpus (`src/adapters/profile.ts:653-670`).

**The links-not-mentions distinction is load-bearing, and it was learned the hard way.** Counting mentions made the ranking a **popularity contest over prose** — any new document could win it by discussing a filename often enough, silently re-pointing the primary doc that *every agent in the fleet is briefed with*. That is a scoring change with fleet-wide blast radius and no error message.

The measurement that settled it, taken when the fix landed:

| Doc | Inbound **links** | Bare **mentions** |
|---|---|---|
| `SPEC.md` | **5** | 23 |
| Claude conventions file | **0** | 23 |

**Mentions could not separate them. Links were decisive.** The extractor therefore reads link targets and never bare prose (`src/adapters/profile.ts:606-615`).

### The practical consequence, worth writing down

> **Adding or deleting docs changes what every agent gets briefed with.**

Deleting a doc that cites `SPEC.md` *lowers* SPEC.md's inbound count. A doc corpus is not inert: it is the input to a ranking that decides the primary design doc, and the primary design doc decides which bare-name `§` citations resolve. Restructure the docs tree with that in mind.

## How profiles are produced (landed foundation vs transitional reader)

**Structured profile vs narrative memory.** The profile is typed JSON product code can read; memory is narrative articles agents pull on demand. Neither stores the other's fields (SPEC decisions 5 and 14).

**Local profile file vs content shown to a provider.** Accepted state lives only under the instance home: `projectProfileDir` → `…/profile/`, with `current.json` and `state.json` (`src/daemon/project-profile.ts`). That is not repository content and is not committed. A future profiler process sees a **bounded inventory** of selected paths (F1: caps, denylists, secret skipping, fail-closed limits in `computeProfileInventory`); inventory bytes are not the accepted profile file.

**Landed foundation.** Schema and lifecycle are in `src/schemas/project-profile.ts` (`unprofiled | profiling | current | stale | failed`). Daemon APIs in `src/daemon/project-profile.ts` own begin/submit/fail/stale, cross-process locking, and atomic temp+rename replacement of `current.json`. Validation and cited-path proof are in `src/daemon/project-profile-validate.ts`. F2 splits **candidate** (model-authored claims) from **envelope** (daemon-authored run/provider/model/provenance); requesters carry in-lock timestamps; optional guidance is capped request provenance, never a validation override. A legacy `profile.toml` or `.hive/profile.override.toml` is **not** a completed agent-authored profile.

**Automatic refresh vs explicit reprofiling.** Planned packages P3/P7 own background stale/refresh while keeping the last validated current readable; planned P5 owns operator `hive profile reprofile|status|show`. Those are different paths. Neither is "silent `ensureProfile` rewrote your TOML before you noticed," and neither is `hive init --refresh` as the supported long-term control surface.

**Still transitional for briefing.** Session boundaries and `loadBriefConfig` still call `ensureProfile` on the deterministic adapter (`src/adapters/profile.ts`) so the scoped brief keeps working. Consumer cutover to `readCurrentProfile` is plan package P8 and is **unbuilt**. Do not document briefing as already consuming the new profile.

### Lessons retained from the deterministic cache (outgoing path)

The first design shipped a committed `.hive/profile.toml`, then a silent `profile.toml` under `~/.hive/projects/<uuid>/` regenerated in ~56 ms with path/size fingerprints. Two traps that remain true for any durable profile signal:

**The staleness-fingerprint trap.** A fingerprint must hash what *determines* the accepted answers. Folding the whole Git tree hash in marks every unrelated commit "stale." The agent-authored foundation content-digests the bounded inventory instead of path/size alone (F1); continuous post-accept drift is plan package P7.

**The frozen-cap trap.** A cached `index_budget` / `map_tokens` with no reader made correct profiles look stale. Size-derived caps belong at the point of use.

> **Humans do not maintain the profile file.** Corrections are not a committed override TOML in the new design; optional guidance is request provenance on a reprofile, and the daemon still validates every accepted claim.

## What `hive init` is left owning

`hive init` (`src/cli/init.ts`) is **not** the profile author for the agent-authored design. It owns the tier that must be asked for because it writes into the user's repo or spends their tokens:

- When no `AGENTS.md` exists, **offer** to scaffold one — opt-in, never blind. Codex caps the AGENTS.md chain at **32 KiB and truncates silently**, so Hive never appends to a human's existing instructions (`src/cli/init.ts:9-10`, `scaffoldAgentsMd` at `src/cli/init.ts:258`).
- Seed a small set of narrative memory articles with `source: "init"` and a `verified` date — derived and re-derivable, distinct from the earned facts an agent learns. **Structured facts never become memory**; they belong in the profile.
- Graphify enablement and starting the instance daemon.

Running the command is the authorization, every action is printed, and it never ends by asking for another command: anything Hive can finish itself, it finishes there (seeded facts are indexed on the spot, not left with a note to go reindex them). Operator profile commands (`hive profile …`) are planned per the implementation plan (P5), not current CLI surface.

## The external survey behind all of this

**Claude Code `/init`** crawls manifests, existing docs, config, and structure to generate a `CLAUDE.md` with build/test/lint commands, architecture patterns, conventions, and workflows. Two lessons. It is explicitly framed as **a starting point, not a finished product** — Anthropic's own guidance says it "captures obvious patterns but may miss nuances." And it is **on-demand, not automatic**, because it spends model tokens crawling.

**Codex / AGENTS.md.** Global scope first, then Git-root *down* to cwd, at most one file per directory, concatenated root-to-current with files closer to cwd appearing later and therefore overriding. Precedence is **positional, not semantic**. The chain stops at `project_doc_max_bytes` (**32 KiB** default) and **truncation is silent — no warning when instructions are cut.** The chain is rebuilt every run; there is no cache to clear. `AGENTS.md` is the conventions layer and it is *already portable*: both Codex and Claude Code load it natively with zero Hive machinery, so Hive should never reinvent conventions delivery — only record *that* a conventions file exists and *where*.

**aider's repo map — the reference design for a ranked, budgeted index.** Parse each source file with **tree-sitter**, pull `def` and `ref` tags, build a file-level dependency graph, rank symbols with **PageRank personalized by the files currently in the chat**, and **binary-search** how many ranked tags fit a token budget (`--map-tokens`, default 1k). Render through `TreeContext` — signatures and enclosing scope, not bodies. The transferable ideas: **a repo index is ranked and budgeted, not exhaustive**; the budget is an explicit knob; the ranking is re-personalizable to the task. Hive's scoped brief is the doc-level analogue of this, and `rankPrimaryDoc` is its doc-level PageRank.

**Cursor rules generation.** `/Generate Cursor Rules` works **by example, not by crawl**: attach a few of your best-written files and the model extracts the patterns. Convention capture grounded in **exemplar files** beats capture from a generic template. If Hive's init ever authors a conventions narrative, it should read the repo's own best files, not emit boilerplate.

**The cross-cutting lesson Hive took further than the survey.** Every tool lands on "generate once, let a human maintain it." Hive first split by cost: a deterministic tier that could run silently at every session boundary. That un-hardcoded the brief, then hit monorepo/ambiguity limits. The architecture now splits by *role*: a specialized profiler authors evidenced claims from a bounded inventory; the daemon alone accepts and stores them; humans neither maintain a cache file nor override validation. Until the tools layer and consumer migration land, the transitional deterministic reader still feeds the brief — but it is no longer the design truth for how profiles are produced.

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

The caps are deliberate: a whole doc under `WHOLE_DOC_MAX_CHARS` (4,000) is cheaper to embed than to make the agent burn a tool call opening it; one section's body is capped at 6,000 chars, and the whole brief at 12,000 (`src/adapters/brief.ts:35-41`). And the allowlist is a *security* boundary as much as an economy one: a task naming any path outside it is ignored, because **the brief must never become a way to paste arbitrary repo files into a prompt** (`src/adapters/brief.ts:5-15`, `:100-119`).

**The open measurement:** the brief only pays off if the orchestrator *writes* briefs that cite their sources. `ORCHESTRATOR_BRIEF` instructs it to (`src/cli/orchestrator-brief.ts:5`: "Name the sections; never tell an agent to read a document whole"), and nothing measures whether it does. The cheapest check is a count of spawn task descriptors containing a `§` or a `.md` path, which the daemon already logs.

## See Also

- [Context degradation and agent recycling](context-and-recycling.md) — what a respawn re-pays, and why the ~33K cold start is not free
- [Agent memory](memory.md) — the narrative tier the profile deliberately does not hold
- [Profiling implementation plan](../design/profiling-implementation-plan.md) — landed foundation vs independently landable packages (tools, gate, CLI, drift, consumer cutover)
- [Rejected approaches](../routing/rejected-approaches.md) — the full token-efficiency measurements
- [Launch mechanics](../providers/launch-mechanics.md) — how the spawn prompt reaches the vendor CLI
- [Database resilience](../daemon/database-resilience.md) — the sibling invariant: an unobserved value is null, not zero
- [SPEC.md decision 14](../../SPEC.md) — starting into a repo
