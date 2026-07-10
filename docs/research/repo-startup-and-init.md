# Repo startup and initialization: how coding tools bootstrap into a codebase

Hive's token economics rest on a claim it has only ever tested against one repo: that a spawned agent can be handed the two doc sections its task names instead of "go read SPEC.md," and that the orchestrator already knows which docs are load-bearing. Every mechanism that makes a spawn cheap — the scoped brief, the memory index, the skills library, the tier router's build/test knowledge — silently assumes it knows this repo's shape. That knowledge is currently hardcoded: `src/adapters/brief.ts` ships a literal `["SPEC.md", "README.md", "CLAUDE.md"]` allowlist and a bare-name `SPEC §6` special case. Point Hive at a repo whose design doc is `DESIGN.md` under `rfcs/` and the economics evaporate — the brief mechanism refuses to extract a doc it was never told about.

Scott's binding constraint is that Hive must work with **any** repo, with nothing hive-repo-specific built into the product. So the shape of a repo has to be *discovered once and written down*, not compiled in. This document researches how the best coding tools discover a codebase and what a durable, token-cheap repo profile should capture. It is the input to the SPEC design of Hive's initialization routine (SPEC §14).

Every external claim below was checked against live documentation or source in July 2026, not recalled from training. Provenance is inline.

## Claude Code `/init`

Claude Code ships a `/init` slash command whose entire job is to write the repo's onboarding doc for the agent. It crawls the project directory — reading manifest files (`package.json` and friends), existing documentation, configuration files, and the code structure — and generates a `CLAUDE.md` tailored to what it found. The generated file "typically includes build commands, test instructions, key directories, and coding conventions it detected," and more specifically: build/test/lint commands, architecture patterns (framework, routing, state management), code conventions (naming, file organization, import style), key dependencies and why they're used, and common workflows (deployment, PR process, CI/CD).

Two design lessons matter for Hive. First, `/init` is explicitly framed as **a starting point, not a finished product** — Anthropic's own guidance says it "captures obvious patterns but may miss nuances specific to your workflow. Review what Claude produces and refine it." The tool derives what it cheaply can and hands a human the rest; it does not pretend the generated file is authoritative. Second, `/init` is **on-demand, not automatic** — it runs when the user asks, because it spends model tokens crawling the repo. Nothing runs it silently on every session.

Sources: [Claude Code commands docs](https://code.claude.com/docs/en/commands), [Using CLAUDE.md files (Anthropic)](https://claude.com/blog/using-claude-md-files), [What Does /init Do (howdoiuseai)](https://www.howdoiuseai.com/blog/2026-04-16-what-does-init-do-in-claude-code-claudemd-setup).

## Codex CLI and the AGENTS.md standard

Codex reads project instructions from `AGENTS.md`, now an open standard governed by the Agentic AI Foundation under the Linux Foundation and supported by 25+ agents (Claude Code, Cursor, Copilot, Devin, Gemini CLI, and others). The discovery and merge rules are precise and worth copying:

- **Discovery order.** Global scope first (`~/.codex/AGENTS.override.md`, else `~/.codex/AGENTS.md`), then project scope: Codex walks from the Git root *down* to the current working directory, and at each level checks `AGENTS.override.md`, then `AGENTS.md`, then any names in `project_doc_fallback_filenames`. **At most one file per directory.**
- **Merge order.** Discovered files are concatenated root-to-current with blank-line joins; files closer to the working directory appear *later* and therefore override earlier guidance. Precedence is positional, not semantic.
- **Size cap.** Codex stops adding files once the combined size reaches `project_doc_max_bytes` (**32 KiB** default), and skips empty files. Truncation is **silent** — no warning when instructions are cut. This is a real hazard: an instruction file that pushes the chain past 32 KiB drops content nobody is told about.
- **Rebuild.** The instruction chain is rebuilt every run; there is no cache to clear.

Codex also ships a `/init` that generates an `AGENTS.md` scaffold in the current directory — the same "derive a starting point" move as Claude Code, against the cross-vendor standard.

The lesson for Hive: `AGENTS.md` is the **conventions** layer (SPEC §5's committed-conventions category), and it is already portable — both tools load it natively with zero hive machinery. Hive should not reinvent conventions delivery. But it should be *aware* of AGENTS.md: whether one exists is a repo fact worth recording, and a rich init can offer to scaffold one, exactly as `/init` does — never silently, because it is a committed file that changes behavior for humans too, and because the 32 KiB silent cap means blindly appending to it can evict a human's instructions.

Sources: [Custom instructions with AGENTS.md (OpenAI/ChatGPT Learn)](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [AGENTS.md Playbook 2026 (codegateway)](https://www.codegateway.dev/en/blog/agents-md-playbook-2026), [Bootstrapping AGENTS.md (Vaughan)](https://codex.danielvaughan.com/2026/04/08/bootstrapping-agents-md/).

## aider's repo map — the canonical token-cheap repo index

aider solves the exact problem Hive's brief mechanism solves — give the model enough of the codebase to be useful without pasting the whole thing — and its repo map is the reference design for a ranked, budgeted index.

- **Extraction.** For each source file, aider parses it with **tree-sitter** and runs modified `tags.scm` query files (borrowed from the tree-sitter language projects, one per language: Python, JS, Rust, Go, Java, …) to pull two kinds of tags: **def** (definitions — functions, classes, methods, types) and **ref** (usages of those names).
- **Graph.** It builds a graph where each source file is a node and edges connect files with dependencies, derived from those def/ref relationships.
- **Ranking.** It ranks symbols with **PageRank** (via NetworkX), **personalized** by the files currently in the chat — so the map re-weights toward what the user is actually working on. The map keeps only the most-referenced identifiers, "the key pieces of context the model needs to know."
- **Budget.** The map is fit to a token budget set by `--map-tokens` (**default 1k tokens**), and aider **binary-searches** how many ranked tags fit. When no files are in the chat, it expands the map significantly; when files are added, it shrinks and re-personalizes.
- **Rendering.** Ranked defs are rendered through `grep_ast.TreeContext`, which shows each definition with its enclosing structural context (class headers, parent scopes) and elides irrelevant lines — signatures and shape, not bodies.

The transferable ideas: **a repo index is ranked and budgeted, not exhaustive**; the budget is an explicit knob; and the ranking should be re-personalizable to the task at hand. Hive's scoped brief is the doc-level analogue (extract the named sections, hand pointers to the rest); an aider-style symbol map is the code-level analogue Hive does not yet have, and the repo profile is the natural place to record its budget and its top-ranked entry points.

Sources: [aider repo map docs](https://aider.chat/docs/repomap.html), [Building a better repository map with tree-sitter (aider blog)](https://aider.chat/2023/10/22/repomap.html), [Repository Mapping System (DeepWiki)](https://deepwiki.com/Aider-AI/aider/4.1-repository-mapping-system).

## Cursor rules generation

Cursor stores project rules as `.cursor/rules/*.mdc` — Markdown with MDC frontmatter (`description`, `globs`, `alwaysApply`); a plain `.md` there is ignored precisely because it has no frontmatter to say when the rule applies. Rule contents are injected at the *start* of the model context, the same always-present placement as AGENTS.md.

The generation move is the interesting part. `/Generate Cursor Rules` works by **example, not by crawl**: you attach a few of your best-written files to a chat and ask it to extract the patterns; the model writes rules that match *your* codebase's conventions and structure, better than generic templates because they're grounded in real exemplars. It generalizes across concerns — route handlers, DB models, CSS — by pointing the extractor at good instances of each.

The lesson: convention capture grounded in **exemplar files** beats convention capture from a generic template. If Hive's rich init ever authors a conventions summary, it should read the repo's own best files, not emit boilerplate.

Sources: [Cursor Rules docs](https://cursor.com/docs/rules), [How to Generate Cursor Rules (pageai)](https://pageai.pro/blog/cursor-rules-tutorial).

## What a one-time repo profile should capture

Synthesizing the four tools against Hive's actual consumers (the scoped brief, the orchestrator's citation guidance, the tier router, the memory seed), a durable profile should hold:

- **Doc inventory + which docs are load-bearing.** The set of docs an agent might be pointed at, and which one is the *primary design doc* — the answer to "read the spec" in a repo that doesn't call it SPEC. This is what replaces `brief.ts`'s hardcoded allowlist and its bare-name `SPEC §6` special case. Rank by inbound references and role, the way aider ranks symbols and Claude `/init` reads existing docs; the primary doc is the one everything else cites.
- **Build / test / typecheck / lint / run commands.** The concrete commands, discovered from manifests (`package.json` scripts, `Makefile`, `justfile`, CI config). Every tool's `/init` captures these first because they're the cheapest high-value facts and the landing gate's "re-run the tests" needs a concrete command in an arbitrary repo.
- **Conventions pointer.** Whether an `AGENTS.md`/`CLAUDE.md` exists and where, the primary language and package manager, and monorepo layout if any. Hive doesn't store the conventions themselves — those live in AGENTS.md, loaded natively — it records *that they exist and where*, so it never duplicates them.
- **Key entry points.** The top-ranked files/directories, the aider-style answer to "where does this codebase start." Cheaply approximated at first (manifest entry points, most-linked files), upgradeable to a tree-sitter/PageRank map later without changing the profile's shape.
- **Repo-size-aware index budget.** aider's `--map-tokens` made explicit and *scaled to the repo*: a 200-file repo and a 20k-file monorepo cannot share one index budget, or the big repo drowns every context it touches. The profile records the size class and the budget, so injection stays bounded on any repo.
- **A staleness fingerprint.** Cheap-to-recompute signals over the profile's own inputs (the doc set, the manifests/lockfile, the Git tree) plus the date and hive version that produced it — so a later session can decide "still fresh?" in a few `stat`s without re-running the expensive profiling. Every tool rebuilds its instruction chain per run (Codex explicitly); Hive's profile is durable, so it needs an explicit freshness check the per-run tools don't.

Two cross-cutting lessons shape the SPEC design. **Derive-then-refine, never block:** every tool treats generation as a starting point a human refines, and none runs the expensive pass silently. And **cheap deterministic facts and expensive model-authored facts are different tiers:** build commands come from a manifest for free; a conventions narrative or a ranked symbol map costs a model pass. `hive init` owns both tiers without making onboarding two commands: it deterministically creates or refreshes the structured profile when needed, accepts explicitly supplied model-authored facts and scaffolding, then starts the session. `hive init --refresh` is the profile-only maintenance path. That sequencing is the core of SPEC §14.
