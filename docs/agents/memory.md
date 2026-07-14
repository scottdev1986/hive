# Agent memory: what the field does, and why Hive does what it does

Updated: 2026-07-13
Sources: Hive source tree, 2026-07-13; docs/research/agent-memory-best-practices.md; SPEC.md decision 5

## Summary

Every mature coding-agent vendor now ships two memory tracks — a committed human-authored instruction file and an agent-authored auto-accumulating store — and conflating them is the classic mistake. This article is the sourced provenance behind [SPEC.md decision 5](../../SPEC.md): the external survey that argued Hive's write policy, its staleness handling, and its index-plus-retrieval shape. The Hive decisions themselves live in SPEC and are not re-argued here.

> **Currency caveat, preserved deliberately.** Every vendor mechanic below was checked against a live doc or source in **July 2026**. These are protocol and product surfaces, not stable contracts. **Re-verify before trusting any of it against a newer release.** A survey of moving targets ages; the *patterns* below outlive the vendors' current implementations of them.

## The two-track consensus

The single thing everyone agrees on, and it is a split in kind, not degree:

- A **human-authored, always-injected instruction file** — `CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, `.github/copilot-instructions.md`. Committed, shared, deliberate. Loaded in full every session, bounded only by size caps.
- An **agent-authored, auto-accumulating memory store** — Claude Code auto memory, Cursor Memories, Windsurf/Cascade Memories, GitHub Copilot agentic memory. Cheap, per-user or per-repo, written as the agent works.

Codex is the lone outlier: `AGENTS.md` and nothing else, no native agent-written memory. Everyone else runs both.

*Deliberate + shared + committed* is one mechanism; *auto-captured + cheap + local* is a different one. Windsurf states the split most cleanly of anyone: Cascade Memories are the ephemeral "stop re-asking" tier, and its own docs say **durable shared conventions belong in a Rule or `AGENTS.md` instead**.

## The multi-vendor filename trap

`AGENTS.md` is the emerging cross-tool lingua franca — 60,000+ open-source repos ship one, read natively by 20+ agents (Codex, Cursor, Copilot, Windsurf, Aider, Gemini CLI, Devin). Its universal merge rule is **root-down concatenation, nearest-file-wins-by-position**.

The gap that matters for a multi-vendor tool: **Claude Code reads `CLAUDE.md`, not `AGENTS.md`** — bridged only by a `CLAUDE.md` containing `@AGENTS.md`, or a symlink.

> **Any cross-vendor design that assumes one filename will silently starve the other vendor's agents.**

This is why Hive neither picks the filename nor injects the contents: the vendor loads its own conventions file natively, and *which* file a given repo uses is a repo-specific fact the profile records rather than a constant Hive hardcodes (SPEC decision 5; see [briefing.md](briefing.md) for how the profile discovers it).

## Vendor mechanisms worth stealing from

**Claude Code.** `CLAUDE.md` is a scope hierarchy (managed-policy → user → project → local) that is **concatenated, not overridden**, root-down. `@path` imports expand at launch (max depth 4) and **do not save tokens**. Guidance: keep each file **under 200 lines** — longer files "consume more context and reduce adherence." Content arrives as a *user message after the system prompt* — soft guidance, not enforcement; hard rules belong in a hook. Auto memory (v2.1.59+, on by default) stores per-git-repo, machine-local, and its recall design is the load-bearing part: a **`MEMORY.md` index** (only the first **200 lines or 25 KB**, whichever comes first, loaded at session start) plus **topic files that are not loaded at startup** and are read on demand. Index-plus-retrieval, built to bound token cost — the same shape Hive landed.

**Codex.** `AGENTS.md` only. Global then repo-root-down-to-cwd, concatenated root-down, nearest-to-cwd highest-precedence. `AGENTS.override.md` *replaces* a level rather than merging. Concatenation stops at `project_doc_max_bytes`, **default 32 KiB — and truncation is silent.** No warning when instructions are cut. This is why Hive's `hive init` will *offer* to scaffold an `AGENTS.md` when none exists but will never append to a human's existing one (`src/cli/init.ts:9-10`).

**Cursor.** `.cursor/rules/*.mdc` with four activation modes — Always, Agent-requested, Auto-attached (glob), Manual. Only Always rules cost tokens every request. Size guidance **under 500 lines** — the firmest public per-file number in the field. Memories are agent-proposed and **user-approved before saving**.

**GitHub Copilot — the strongest *shipped* staleness handling anywhere.** Agentic memory auto-captures "tightly scoped insights" as **repository facts stored with citations pointing at the supporting code**. Two mechanisms make it rigorous:

- **Before use, each memory's citations are re-validated against the current branch.** Only validated facts are applied; if the code contradicts a memory, the agent is prompted to store a corrected version.
- **Any unused fact is auto-deleted after 28 days**, the timer resetting on validated use.

**Citation-validation-before-use is the pattern to steal for anything load-bearing.**

## Open frameworks and stores

**Letta / MemFS** is the closest published analog to Hive's design, arrived at independently: "a git-backed memory filesystem … projecting memory into markdown files with git version history and conflict resolution." Files in `system/` are always loaded; everything else shows **only path + description in a 'memory tree' and loads full content only when relevant**. Reorganization subagents use **git worktrees so they write concurrently without blocking** the main agent. Git-backed markdown + always-loaded index + lazy full content is exactly Hive's shape.

**Zep / Graphiti — the staleness gold standard.** Its distinguishing feature is a **bi-temporal model**: four timestamps per edge — `valid_at`/`invalid_at` (when the fact was true in the world) and `created_at`/`expired_at` (when the store learned/unlearned it). On a contradicting new fact, an invalidation pass marks the old edge expired and **rewrites its text to past tense** — **nothing is deleted**, so point-in-time reconstruction ("what did we believe at commit X") survives. The lesson generalizes past graphs: a plain vector store retrieves the most-*similar* chunk regardless of currency; a validity-window model retrieves the *currently-true* fact.

**Mem0 — the sharpest write gate.** Two phases: extraction (excluding "greetings, filler, vague acknowledgments"), then update — retrieve the top-10 semantically-similar existing memories, then emit exactly one of **ADD / UPDATE / DELETE / NOOP**. ADD only when no equivalent exists; UPDATE mutates in place with stable IDs; DELETE on contradiction. **Retrieving similar memories *before* writing is genuine dedup-before-write, and it is the reference design for it.**

**LangGraph / LangMem** names the taxonomy explicitly — semantic (facts), episodic (successful interactions as few-shot examples), procedural (behaviour rules). Its write pattern is retrieve-`existing`-then-decide; consolidation is split into hot-path (inline, adds latency) vs background (reflect after the fact, higher recall), with a **debounced ReflectionExecutor** that cancels and reschedules pending consolidation as new messages arrive, so it processes complete context rather than fragments.

**Devin Knowledge** recalls items by **trigger description** ("Devin uses this when…") — selective trigger-matched injection, not a dump. Auto-suggestions are **edited by the user before saving**. Staleness handling is weakly specified — a real gap.

## The patterns that matter

**Store the distilled lesson, not the transcript.** Everyone separates a raw event log from distilled facts. Reflexion is the result behind it: natural-language *explanations* of failures beat raw trajectories by ~8 points on HumanEval. (The same finding drives the handoff protocol — see [context-and-recycling.md](context-and-recycling.md).)

**Write policy — dedup before write, and never silently into the shared tier.** The dominant pattern is retrieve-similar-then-decide *before* writing (Mem0's ADD/UPDATE/DELETE/NOOP; Zep's dedup + invalidation; LangMem's `existing`-gated managers). And:

> **Auto-capture is universally suggestion or local-only, never a silent write into the shared tier.** Devin and Cursor route through human approval; Windsurf keeps it local; Copilot validates against code before applying.

A spec that lets agents silently write shared, load-bearing facts is out of step with every shipped product. This is why Hive's silent auto-extraction stays deferred until its write policy is trusted (SPEC decision 5).

**Retrieval — a tiny index plus pull-on-demand.** The hybrid worth copying for a file-backed tool is Letta MemFS / Claude auto-memory: a small always-loaded index (path + title + status) with full content pulled only on match. **You cannot pull what you cannot see exists** — the index is what makes search-on-demand actually fire. Hive implements exactly this: `buildMemoryIndex` (`src/adapters/memory.ts:785-804`) rebuilds and reads each scope's `wiki/index.md`, capped at `MEMORY_INDEX_MAX_ENTRIES = 30` rows (`src/adapters/memory.ts:32`), and article bodies never enter the spawn brief. Full articles are pulled through `memory_read` (`src/daemon/server.ts:3981-3993`).

**Staleness — the sharpest differentiator and the biggest shipped gap.** Zep's bi-temporal supersede-don't-delete is the strongest *primitive*; Copilot's citation-validation-before-use + 28-day TTL is the strongest *shipped* one. Everyone else handles staleness only by contradiction-driven overwrite, losing the audit trail; Devin and Windsurf have essentially none. The load-bearing rule across the rigorous systems:

> **A recalled fact must be re-checked against current reality before it drives an action.** Facts age. A recalled fact is a claim, not truth.

Hive's version of this is enforced rather than hoped for: the index is a pointer, the article is a claim, and the repo plus linked raw evidence are truth — **a recalled article that names a concrete path, command, or flag is re-checked against the repo before it drives an action** (SPEC decision 5). Hive gets Zep's point-in-time reconstruction free from git-committed markdown, without the knowledge-graph weight.

**Token budget is also an accuracy budget.** This is the argument that decides the whole shape, and it is *not* a price argument:

> **The strongest case for a small injected context is not cost — it is that models degrade *inside* their advertised window.**

Chroma's context-rot study found all 18 frontier models degrading non-uniformly as input grows, driven more by semantic similarity between target and distractors than by raw length — and models scored *better* on shuffled haystacks than logically ordered ones, so **well-organized context is not automatically safe context**. A separate Oct-2025 result found performance falling 13.9–85% as input grew **even with 100% perfect retrieval**. The convergent guidance across vendors: keep the always-injected surface small and semantically distinct — Cursor's <500 lines, Claude's <200 lines, Devin/Windsurf's "inject on trigger, never front-load everything."

Hive's accounting makes this explicit: the injected index is a **flat tax** (30 compact rows plus header, below ~900 tokens no matter how large the store grows), a `memory_read` is ~100–400 tokens paid only when relevant, and against that a cold agent spends thousands rediscovering repo shape or hitting a gotcha live. **The index tax stays flat while avoided rediscovery grows.**

**Consolidation is background, not hot-path.** Deferred everywhere: Letta's sleep-time/dream subagents, LangMem's debounced executor, Mem0's async summary module, Zep's map-reduce community summaries. Cheap in-loop writes for urgent context; expensive consolidation deferred.

## Where this lands in Hive

The design decisions, token accounting, and rejected alternatives are argued in [SPEC.md decision 5](../../SPEC.md) and are deliberately not duplicated here. In one breath: Hive already sits on the industry-consensus shape (committed markdown + always-injected index + search-on-demand), and the growth areas the survey identified are a **write policy** (Mem0's dedup-before-write; suggestion, never silent shared write), **provenance + verification** (Copilot's re-validate-before-load-bearing), and a **repo profile** that front-loads the structured facts an agent would otherwise burn a cold exploration discovering.

Two boundaries the survey did not supply but SPEC draws, and which matter when reading any of this back:

- **Memory holds narrative truth; the profile holds structured truth; neither stores the other's.** Build commands and doc names live in the profile, read deterministically by product code. Only non-derivable narrative lessons live in memory.
- **A shipped skill is not a followed skill.** The `hive-memory` skill explains compilation and lint judgment, but the write contract (`topic`, `source`, `evidence`, explicit `status`, `supersedes`) is enforced at the MCP schema *and* re-parsed in the filesystem adapter — because telemetry already proved that progressive disclosure is not an enforcement path.

## Confidence caveats from the survey

Carried forward verbatim, because a spec that cites a marketing figure as evidence inherits the lie:

- Cursor Memories mechanics come from changelog/forum, not the (client-rendered) official page.
- Zep-vs-Mem0 head-to-heads were not confirmable on either vendor's primary pages; both publish self-favouring figures. Use each system's own-vs-full-context number.
- Mem0 has two coexisting benchmark regimes at different scales (paper 66.88% J vs 2026 marketing LoCoMo 92.5) — cite with system *and* source.
- The AGENTS.md "150 lines / 20–23% inference cost" figure **has no public methodology — do not cite it as evidence.** Cursor's <500 is the firm public number.
- Context-rot's precise "30–50%" and "300k–400k token" figures are secondary aggregations of Chroma's qualitative curves, not verbatim from the report.
- **All vendor mechanics were current as of July 2026 — re-verify before trusting against a newer release.**

## See Also

- [Agent briefing](briefing.md) — the repo profile, and how it discovers the conventions file rather than assuming its name
- [Context degradation and agent recycling](context-and-recycling.md) — why a small injected surface is an accuracy budget, and the constraint-pinning result
- [Rejected approaches](../routing/rejected-approaches.md) — measured token costs of what enters a spawn prompt
- [Database resilience](../daemon/database-resilience.md) — the sibling invariant: absence is a finding, not a zero
- [SPEC.md decision 5](../../SPEC.md) — what "memory" actually means in Hive
