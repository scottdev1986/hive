# Graphify integration

Updated: 2026-07-23
Source: Hive source tree, 2026-07-23

## Summary

Hive uses Graphify as its local code-structure tool. Every `hive init` installs or verifies the pinned standalone runtime and builds a queryable, code-only graph. Agents receive a targeted graph brief at spawn and Graphify tools for deeper structural queries. Two rules shape the integration: **graph context is a hint, never an authority**, and **no Hive operation may block on Graphify**.

## The degradation contract

Upstream's own published QA accuracy is **45–76%**. That single number is the load-bearing fact of the whole integration: it means a graph answer is a lead, not a truth, and it means graphify can never sit in a path whose failure would be a Hive failure.

So unavailable (offline init, missing platform bundle), broken (extract failing, server unhealthy), and slow (build in progress, query timeout) all collapse to **one** behavior: the agent runs without graph context, its brief says so in one line, `hive graphify status` reports the cause, and no spawn or landing fails. `hive graphify enable` completes or refreshes the graph. "Loudly noted" is not politeness — a silently missing graph is indistinguishable from a repo with nothing to find, and Hive's protocol is that an absent field is unknown, never false (`SPEC.md`, the accurate-or-unknown rule). Telemetry follows the same rule: `graphifyCalls` is null when unknown, never 0.

**There is deliberately no land-time enforcement** — no "did you consult the graph" gate. It would be unverifiable in exactly the way Hive's protocol warns about (an MCP call proves an act, not that the answer informed anything), and it would put a 45–76%-accurate oracle in the landing path for no measurable gain.

## Ignore hygiene

Hive's repository-wide generated paths belong in the tracked `.gitignore`. `hive init` appends exactly `.hive/memory/`, `.hive/worktrees/`, `graphify-out/`, and `.graphifyignore`. It never writes the parent `.hive/` entry: `.hive/skills/` is user-authored project knowledge intended for version control, and ignoring the parent also caused the 2026-07-20 worktree-deletion incident.

The command-boundary test proves all four entries with `git check-ignore --no-index` on fresh probe names. Plain `check-ignore` consults the index and can lie for tracked files.

## The vendored-code flood

Measured on this repo: **51% of all graph nodes were vendored Swift** under `workspace/.build/checkouts/`. The counter-intuitive part, and the reason this matters: **the damage lands at start-node selection, not traversal.** For the failing acceptance question only 11 of 336 *reachable* nodes were vendored — but the keyword matcher anchored "spawning" on a vendored `AgentFeed.swift` and `.attach()` on SwiftTerm's `BufferLine.swift`, so every traversal began in code no agent asks about. A poisoned graph does not return junk; it returns confident, well-formed answers rooted in the wrong place.

The pinned binary honors gitignore rules **only at the scan root** (`_load_graphifyignore` walks ancestors, never descendants), so the nested `workspace/.gitignore: .build/` that git itself respects was invisible to extraction. And `extract` has no `--exclude` flag: `.graphifyignore` at the repo root is the only exclusion lever that exists.

Hive therefore generates that file before every build: a short static floor of commonly *committed* vendored dirs (`vendor/`, `third_party/`, `Pods/`, `.build/`, …) plus, verbatim, the directories the repo's own gitignore machinery already excludes, taken from `git ls-files --others --ignored --exclude-standard --directory`. The team's own gitignore is the general signal — it is their declaration of "not our code," per-repo and ecosystem-free — which is what makes the rule portable instead of a hand-maintained ecosystem list that is always one ecosystem behind. Rebuilt, this repo went from 10,033 nodes (51.3% vendored, 25.3% `src/`) to 4,895 (0% vendored, 51.8% `src/`), and start nodes stopped resolving into SwiftTerm.

Two guards, both because over-exclusion is a *silent* failure: a `.graphifyignore` not starting with Hive's marker line is user-authored and never touched, and the build says out loud what it excluded.

## Why the serving snapshot exists

The server is pointed at a snapshot under Hive's project state dir, never at the live `graphify-out/graph.json` (`src/daemon/graphify-service.ts:136-150`). The reason is a measured collision (2026-07-12): the serve process re-reads its graph file from disk **on every query**, and `graphify update` **rewrites that file in place** — so serving the live file opened a "graph.json not found" window during every post-landing rebuild, and a freshly spawned agent's first `query_graph` landed inside one. A perfectly healthy server returned a not-found error.

"The old server keeps serving the last good graph" is only true when the file it serves is one no rebuild mutates. Each restart refreshes the snapshot (tmp+rename) before the new process comes up.

## Why Hive wrote its own locate

The layer-1 spawn digest is **Hive's own locate over `graph.json`** (`buildTargetedGraphBrief`, `src/adapters/graphify.ts:447-752`), not the binary's `query`. The subprocess query is only the oversized, malformed, or matchless fallback (`:831-879`). The binary's `query` anchors its BFS on its own keyword matcher and **accepts no explicit start nodes** — so when the matcher is wrong there is no lever to correct it. On the acceptance question it anchored "spawning" on vendored Swift; even de-poisoned and de-truncated, it ranked the graphify implementation cluster above the files that answer. Better anchoring had to happen on Hive's side.

Hive's locate scores files by IDF-weighted name/symbol/path match, expands one hop through the graph's own edges hub-normalized (so `db.ts`-shaped files cannot win on raw connectivity), and adds the matched-symbol rule — a seed imports a symbol whose *name* matches the task, so the file *defining* it surfaces — which is what finds the config writer that no locate-question ever names by name. ~10ms, no subprocess. The binary's `query` + selection path remains only as the fallback for malformed, matchless, or >50MB graphs.

**Cross-repo validation (2026-07-12): 16/20 strict** across four repos it was never tuned on (Python, C#/Next.js monorepo, FastAPI+React, and a 20,271-node Java repo — a 28× node-count range) with every constant untouched. Two stated limits, both real:

- **Locate is name-anchored.** When a question uses ecosystem vocabulary the repo's file names don't (asking about "langgraph" in a repo whose `langgraph.json` files are config, not the agent graph), it anchors on textual look-alikes — the same place name-based grep fails. Content search is the correct fallback, which is why the spawn directive names it.
- **In-tree historical copies dilute.** A repo keeping old versions of itself in-tree (one was 71% of its own graph) cannot be ignore-ruled away: that code is tracked, first-party, and indistinguishable by any rule Hive could write.

No constants were changed in response to those four misses. A flip-one-question tweak is overfitting with extra steps.

## The truncation trap (why `token_budget: 16000`)

The serializer writes **all nodes before any edge**, and both of Hive's truncation limits cut from the head. So the relational payload — the only provenance-tagged, `file:line`-cited content in the output — is always the part that falls off the end. Measured on this repo's graph: budget 1200 → 51 nodes / **0 edges**; budget 2000 (the schema default) → 86 / **0**; 8000 → 325 / **0**; edges only start appearing near **16000**. Raising the budget alone was a no-op while a 6KB character cap re-truncated the same head — both limits fail in the same direction, and both had to move.

This is why the spawn directive explicitly tells agents `query_graph` with `token_budget: 16000` and names the 2000 default as a trap that "cuts the output off before the cited EDGE lines" (`src/daemon/spawner-impl.ts:591-605`). An agent calling the tool with defaults gets the degraded shape every time and has no way to know it.

## Vendor trap: the Codex hook-shape inversion

The installed upstream Codex hook emits nothing, on the claim that Codex rejects Claude's `additionalContext` shape. Measured against **codex 0.144.1** with a mock model provider, the truth is the exact opposite: a PreToolUse `{"systemMessage": …}` is **parsed and then silently dropped** — no error, the text simply never reaches a model request — while the Claude-style `hookSpecificOutput.additionalContext` **is** injected, as a developer message, in both `exec` and the TUI.

Hive shipped the `systemMessage` shape first, and **no Codex agent ever received a nudge.** Both harnesses now get the one shape both honor (`src/adapters/tools/graphify-hook.ts:45-68`). The general lesson is a Hive recurring theme: a vendor accepting your payload without error is not evidence it consumed it.

## Why the daemon owns one HTTP server per repo

The obvious alternative — a stdio server spawned per agent — was seriously considered for its simplicity (no port, no lifecycle, dies with the agent) and rejected on two grounds: **N concurrent agents would each hold a full copy of the graph in memory**, and **a long-lived agent would keep serving a graph from before every landing since its spawn**. The daemon-owned instance gets restart-on-rebuild for free. The cost is port and health management — both patterns the daemon already carries.

The child is *held*, not detached: it must die with the daemon rather than leak, with a readiness poll before it is ever advertised and an exit watcher, so a crashed server can never remain a URL that spawns still attach.

## Enforced code-only, twice

Lock one: every build runs `extract --code-only`, the binary's own zero-LLM switch. Lock two, the backstop: every graphify invocation runs under a **scrubbed allowlist environment** — `PATH`, a `HOME` pointed into Hive's tools dir (so upstream's `~/.graphify` global state is never read or written), `TMPDIR`, nothing else (`src/adapters/graphify.ts:73-85`). An allowlist rather than a `*_API_KEY` scrub, **so a provider key Hive has never heard of still cannot leak.** Upstream errors rather than degrades when a doc file needs a backend and no key exists, so a pin bump that drifts what `--code-only` covers fails loud (graphless, noted) instead of exfiltrating quietly.

## Codex app-server parity

Codex agents launched through the app-server host receive the same healthy
Graphify MCP URL as the TUI driver. The URL crosses the Hive host boundary as
an explicit process argument; the host then attaches it with a process-local
Codex config override. Apps/connectors and unrelated inherited MCP servers are
disabled for that child without changing the user's Codex configuration
(`src/adapters/tools/codex-app-server.ts`). The layer-1 digest still degrades
independently, so a missing Graphify server never blocks a spawn.

## See Also

- [Bundling](bundling.md) — how the graphify binary is built, signed, and shipped
- [SPEC](../../SPEC.md) — the accurate-or-unknown protocol the degradation reporting defers to
