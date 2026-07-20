# hive

> **Authority, 2026-07-20.** This document is again the single authoritative top-level design doc for Hive: it states the vision, the architecture in outline, and the milestone boundaries. Subsystem detail lives in the design docs under `docs/` (contracts, daemon, ADRs, agents, routing, providers, terminal, workspace) and in `planning/`; SPEC points at them by name and section and does not duplicate them. Where the two disagree about a *decision*, SPEC is authoritative and the design doc is to be corrected; where they differ in *depth*, the design doc is the detail and SPEC is the ruling.
>
> This refresh **ends the interim state** in which SPEC.md was treated as historical and the design docs were treated as authoritative pending a rewrite. Everything below is current as of 2026-07-20 unless a section says otherwise. Decisions that were true in the previous SPEC and remain true are carried forward under their original numbers with a carried-forward note; decisions that have been superseded are listed in the [superseded-decisions appendix](#appendix-a--superseded-decisions) rather than deleted, because a decision that vanishes silently gets re-made.

## The vision

**Hive is building a custom terminal so that Hive can be integrated *into* that terminal.**

Every other orchestrator watches its agents from outside — through hooks that fire when a vendor chooses to fire them, through transcripts written after the fact, through screen scrapes that guess. Hive owns the terminal the agent runs in, so it can see what is actually on the wire.

The point of owning the terminal is **omniscience about what is happening in a TUI**:

- If the agent is **asking a question**, Hive knows.
- If the agent has **stopped working when it should be working**, Hive knows.
- If the agent has hit a **vendor cybersecurity or safety stop**, Hive knows.

And in each case Hive gets the user's attention so a human can handle it. An agent blocked behind a question nobody sees is an agent that has silently stopped; that failure is the reason the terminal is being rebuilt rather than adapted.

The second half of the vision is **the agent factory**. M2 rebuilds agent spawning and agents themselves into a factory, so that adding a new TUI — Kimi Code, opencode, whatever ships next quarter — is exactly two steps: *do the research, build the factory entry*. Not a new pipeline, not a new adapter subsystem, not a per-vendor fork of the spawn path. Vendor neutrality stops being a claim about how many vendors we happen to support and becomes a property of the spine.

Everything in the milestone plan below serves those two things: a terminal Hive can see through, and a factory that makes seeing through it cheap for every new agent.

## What this is

You `cd` into a project and type `hive claude`, `hive codex`, or `hive grok`. The Workspace app opens with the selected AI orchestrator — **queen** — in its master terminal pane, scoped to that folder. You talk to it like a tech lead: "build this feature," "figure out why the tests are flaky," "have Codex take a second look at the auth code." It doesn't write the code itself. It decomposes the work, spawns agents — Claude Code here, Codex there, big model for the hard part, cheap model for the changelog — and each agent appears in a terminal pane where you can watch it work and type into it. Agents talk to each other when they need to, regardless of vendor. When the work is done, it gets merged, and the panes go away.

What separates this from a demo is the safety and control stack: **quota-aware routing that durably reserves subscription-CLI capacity before spawning, durable peer delivery with critical controls that mechanically revoke authority rather than politely request compliance, an orchestrator that physically cannot write, and a rebase→verify→fast-forward-only landing protocol that makes "the tests and the typechecker passed on exactly what main now is" structural.** Worktrees, terminals, sandboxes, panes are table stakes we build because we must; the control plane over cross-vendor agents is the product — and, from this rebuild forward, the terminal is part of that control plane rather than a window we borrowed.

The strategic read is unchanged and stated honestly: several parties could close this gap — a vendor shipping cross-vendor teams, or an existing orchestrator growing a real control plane. The defensible ground is the safety stack plus vendor neutrality, which is why the agent factory (M2) is a milestone rather than a refactor. macOS only, by choice, for now.

## Where the rebuild stands

Hive is mid-rebuild. The product described above runs today on a tmux + SwiftTerm substrate that is being replaced, on `main`, progressively — not on a long-lived integration branch. Development is coordinated by a checksummed, pinned **old** Hive release with its own `HIVE_HOME`, database, sockets, and ports, so the tool building the rebuild cannot see the rebuild's runtime state (`M1-BOOT`, closed; `planning/backlog-outline.md` M1 Prerequisite).

Ground truth for board state, landed artifacts, and where the tracker lags reality is `planning/2026-07-20-board-planning-repo-reconciliation.md` §1–§4. Its standing observation is worth repeating here because it changes how the milestones below should be read: **the board understates engineering progress** (columns lag landings) while the definition-of-done verdict holds exactly — the atomic cut has not started, and zero of six human evidence gates are met. The milestone boundaries below are stated in terms of *exit criteria*, never column positions.

Two standing rules govern every milestone:

- **Qualify, don't presume.** `sessiond` (Zig), `HiveTerminalKit` (Swift), the vendored Ghostty, and the in-tree conformance-test ids exist, but in-tree code is a *candidate*, never evidence. Each story qualifies its artifact against external conformance sources and live matrices and keeps it only if it passes; rewrite is the fallback, not the default (user ruling Q4).
- **Gut, then rebuild.** No legacy shims, no dual-host canary, no renderer flag, no compat writes. The replacement proves itself on the full live vendor matrix first; then the old path is deleted atomically.

## Milestones

### M1 — Hive works using ONLY the new terminal

M1 is done when Hive runs on the new terminal alone: `sessiond` plus `HiveTerminalKit`, with tmux and every temporary harness gone — **the orchestrator session included, not exempted.**

The foundation M1 is qualifying is recorded in [ADR 0001 — macOS native terminal foundation](docs/adr/0001-native-terminal-foundation.md) (Decision, Consequences) and frozen behind the neutral [terminal host contract v1](docs/contracts/terminal-host-v1.md) (Required behavior §§1–10, Freeze qualification A–K). The control-side interface is `SessionHost`, which contains no tmux and no renderer vocabulary; all Hive policy lives above that seam and syscalls are implementation options, never API vocabulary.

**Exit criteria.** All of the following, none softened:

1. **The atomic tmux cut** — `#1` (STORY-001, gut all tmux terminal code) and `#2` (STORY-002, remove the SwiftTerm/tmux-attach agent-TUI hosting path) execute as **one atomic merge train** at the Removal Gate, with the full live vendor matrix re-run on the post-deletion tree. **The orchestrator session is included in the cut.** Pre-cut drain is performed by the pinned bootstrap build.
2. **`make terminal` and all testing-only support code removed** — `#59`. Every temporary harness or support path that exists only to exercise the terminal during development is deleted before M1 closes. An artifact that still ships or depends on a testing-only support path has not proven what M1 claims.
3. **The exit-command acceptance criterion** — `#60`. An agent's own exit command closes the *agent*; the **terminal pane STAYS OPEN**; and Hive records the closure and runs work preservation. Agent lifetime and pane lifetime are separate facts, and this is the first place M1 proves it.
4. **C2 packaging** — `#11`, per `planning/story-m1-c2-packaging.md`. A signed, notarized, self-contained universal artifact installs and runs the full M1 spine. Per the user rulings recorded in that doc: signing/notarization evidence is a **green `release.yml` run on the post-cut tree**, not a fresh per-cut attestation bundle; and **"clean machine" means a tmux-absence check only** — any machine where `tmux` is verifiably absent from `PATH`, measured with a negative control, not a fresh user account and not separate hardware.
5. **B3 smoke re-run post-cut** — `#9`. The replacement smoke harness on the sessiond/HiveTerminalKit spine has landed; it must re-run green on the post-cut tree.
6. **The deferred live-proof matrix cells** — `#36`. Cells J/K/I/G-live were split out of B1 by queen's direction (2026-07-17) and are not duplicate scope; M1 does not exit with them open.
7. **The human evidence gates.** The aesthetic bar is signed off by **the USER personally** against reference terminals (Ghostty app, Terminal.app, iTerm2) — a hard gate, no engineer proxy (user ruling Q5). The remaining deferred human evidence is tracked in `#45`.

The engineering tracks that reach those criteria — A0 contract freeze, A1 sessiond qualification, A2 the production `SessionHost` backend, A3 input arbiter, A4 close/reconnect/containment, B1 GhosttyKit qualification, B2 pane wiring, B3 smoke, C1 the beautiful blank terminal, C2 packaging — and their dependency edges are specified in `planning/backlog-outline.md` M1 and the per-story `planning/story-m1-*.md` docs. SPEC does not restate them.

### M2 — the agent factory

M2 is the factory. Adding a new TUI becomes: do the research, build the factory entry.

**Exit criteria:**

1. **An agent-agnostic spawn spine** — `#38`. One vendor-neutral spawn and registration path, not a per-vendor fork. **`#12` (Claude Code), `#13` (Codex), and `#14` (Grok Build) are proof targets under that spine, not independent pipelines** — the per-vendor S2.1/S2.2 structure in `planning/backlog-outline.md` M2 is superseded by `#38` (banner landed 2026-07-18; the banner is on the outline itself).
2. **Spawning is native to our terminals.** No tmux paste-based prompt delivery, no terminal-emulator borrowing: an agent is launched into a sessiond generation with an explicit env/cwd/argv contract, and sensitive payloads ride `0600` files rather than argv.
3. **Kimi Code and opencode are FIRST-CLASS agents** — `#63`. Native spawn, normal **and** yolo approval postures, protocol, and landing — held to **the same bar as Claude, Codex, and Grok**, not a reduced one. This is the criterion that proves the factory is a factory: if adding them requires anything beyond research plus a factory entry, M2 is not done.
4. **Status pipeline v2** — `#15`. StatusEnvelope v2 with source/freshness/confidence, and a live agent demonstrating **every current status promise** — working, idle, awaiting-approval, paused, stuck, done, failed, unknown — observed end to end. `#15` proves the **promises only**; it does not own new status semantics. Terminal pixels are never status truth (invariant I6).
5. **Message delivery over the new spine** — `#16`. normal / steer / urgent / critical delivered through the sessiond arbiter with **measured** receipt, and truthful per-vendor degradation stated rather than papered over.
6. **A vendor-TUI conformance corpus** — `#17`. Alt-screen, kitty keyboard, mouse reports, bracketed paste, OSC 52 — run per vendor inside the new terminal.

The belief-injection research folded into the outline's S2.2 (per-vendor flags, the three-way approval matrix, the nonce-based silence proof) remains valid *as research*; it is the content a factory entry is built from, not the structure M2 builds. Read `planning/backlog-outline.md` M2 S2.2 as sourced vendor detail under `#38`'s spine.

### M3 — communication

M3 is where the vision's omniscience half lands.

**Exit criteria:**

1. **TUI omniscience** — `#61`. The three detection classes, with user-attention escalation: the agent is **asking a question**; the agent has **stopped working when it should be working**; the agent has hit a **vendor cybersecurity/safety stop**. Detection alone is not the criterion — getting the user's attention is.
2. **Queen can open and close BLANK terminals** — `#62`. Terminal lifecycle is decoupled from agent lifecycle: a terminal is a thing queen can create and destroy with no agent in it, and an agent ending does not end its terminal (the other side of M1's `#60`).
3. **The durable-communication ladder** — `#18`–`#22`, staged on `docs/design/hive-communication.html`'s C-ladder: C0A durable core (v2 envelopes, pre-spawn identity reservation, digests/causal links/idempotency, content object store, WorkManifest + checksummed journal outside worktrees); C0B bounded truthful wakes (one delivery lane, provider-observed vs applied split, wake budgets, inbox cursors, explicit acks); C0C stranding recovery; C1A hierarchy-aware routes (lands with M4's schema); C1B cutover, which **deletes** the ambiguous legacy paths rather than shimming them.

### M4 and M5

M4 is the agentic hierarchy (`#23`–`#28`), staged on `docs/design/agentic-hierarchy.html`'s H-ladder: shadow records → direct+flat control plane → optional lead tier → promotion trains → recovery and succession → frozen stable projections. `hive_land` loses its fixed target and becomes `PromotionGrant`-derived at H1.

M5 is a **UI-readiness gate, not UI work** (`#29`–`#33`): every Split Horizon feature-ledger row has its underlying truth built and live-proven through projections, CLI, and typed operations, demonstrated with no new UI. Split Horizon then starts as pure presentation. The final story is the end-state demo: the dev build opens on an arbitrary non-Hive project, any vendor boots as queen, and the full loop — spawn → work → status → message → land — is proven.

Detail for both lives in `planning/backlog-outline.md` M4/M5 and the two design docs. M5's row families are named there but the rows are not yet enumerated; that refinement is deliberately deferred until M4-H5 freezes the projections.
