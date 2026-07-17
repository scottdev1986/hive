# Hive rebuild — milestone-structured backlog outline

**PLAN STATUS: FINALIZED 2026-07-17 — awaiting user approval. Execution of any story is NOT authorized until the user approves this plan.** All user decisions (Q1–Q7) are ratified and folded in below.

Lead planner: astrid · drafted 2026-07-17 · board: github.com/users/scottdev1986/projects/11
Reviewed by: atlas (sequencing guardrail + vendor belief-injection finding + full R3 second opinion folded in: P0-1 contract audit → new story M1-A0; P0-2 M1/M2 ownership boundary; P0-3 atomic cut; P0-4 old-build pre-cut drain; P1 behavioral scope; tightened dependency edges; 3-way approval matrix; Q2 revised to main-at-cut + bootstrap binary)

Every story below inherits the HARD PRINCIPLES (stated in each story's DoD when written):
external research drives, code and design docs are reference not truth; external citations required on every terminal/agent story; gut-then-rebuild, no legacy shims; parallel wherever safe; paired SPEC + doc-cleanup task, docs describe behavior/contracts never file paths or line numbers; production-grade; project-agnostic (works on any repo, any stack); LIVE PROOF to close; UI (split-horizon) last and only consumes proven features.

## Ground zero (backlog positions 1–2, fully specified, READY)

- **STORY-001 Gut ALL tmux terminal code** — planning/story-001-gut-tmux.md
- **STORY-002 Complete removal of agent TUI code (SwiftTerm/tmux-attach hosting path)** — planning/story-002-remove-agent-tui.md

Sequencing resolution (explicit): both are specified FIRST and execute at the **Removal Gate** — the replacement host+renderer live-proven across the FULL vendor matrix (real Claude Code, Codex, AND Grok interactive TUIs: launch/type/resize-SIGWINCH/scroll/close with authoritative waitpid reap evidence/restart+reconnect/process-tree containment/100MiB-class backpressure with no loss/crash survival; atlas second opinion, adopted — any failing cell blocks execution). Hard cut, no dual-host canary, no renderer flag, no compat writes. The matrix uses M1's qualification harness launching vendor TUIs manually; it does not depend on M2's spawn/belief/status pipeline. Every M1 build story exists to reach that gate; the two removals then complete M1. You cannot remove the process host that runs agents before its replacement runs agents — so its replacement running agents is the gate, and nothing else unblocks execution.

Standing decision (CONFIRMED by user, Q4): sessiond (~10.3K LOC Zig), HiveTerminalKit (~2.2K LOC Swift), vendored Ghostty, ADRs 0001/0002, and conformance-test IDs already exist in-tree, but HiveTerminalKit is imported only by its own tests — nothing user-facing runs it. This code is NOT presumed correct: each M1 story QUALIFIES the existing artifact against external conformance sources and live matrices and keeps it only if it passes; rewrite is the fallback, not the default. In-tree code is a candidate, never evidence.

---

## M1 — dev build with a fully functional, beautiful native terminal

Exit: open the dev build → a blank native terminal that looks excellent; create/type/scroll/resize/select/copy/IME/close/reconnect all work; zero tmux, zero SwiftTerm; self-contained app (no user-installed tmux/Ghostty/Zig); works on any project directory. **HARD GATE (user ruling Q5): the USER personally signs off the aesthetic bar — explicit user approval against reference terminals (Ghostty app, Terminal.app, iTerm2) is part of M1's definition of done; no engineer proxy.**

Parallel tracks (∥ = concurrent):

**M1/M2 ownership boundary (atlas R3 P0-2, adopted):** M1 owns generic command launch, PTY byte I/O, locator/lifecycle/recovery, and a neutral test fixture — vendor binaries are launched MANUALLY for terminal qualification. M2 owns provider launch profiles, silent beliefs, approval semantics, authenticated status, and control-message receipt. M2 provider-profile work may develop once A2 exists but closes only after the cut.

**Prerequisite (earliest M1, before any gutting-adjacent work merges)**
- M1-BOOT Establish the isolated pinned bootstrap Hive (user-ratified Q2): pin a checksummed known-good OLD Hive release as the bootstrap tool; own HIVE_HOME/DB/socket/ports; provably NO access to new runtime state; used to orchestrate development while main carries the rebuild. Acceptance: recorded checksum + version pin; state-isolation proven live (bootstrap and dev-build instances run simultaneously with zero shared files/sockets/DB rows, verified by inspection not inference); the R3 P0-4 pre-cut drain runs FROM this instance. Doc-cleanup: bootstrap operating procedure documented behaviorally.

**Track A — session host (Zig/daemon)**
- A0 Terminal-host contract audit & freeze (atlas R3 P0-1; FULL SPEC in planning/story-m1-a0-terminal-host-contract.md after atlas's A0 pre-review): re-derive the boundary from external PTY/session behavior. 12 must-express semantics (job-control creation invariant, exec proof beyond fork, incarnation/ABA fencing, fd-transfer + complete-env rules, reap authority vs reparenting, output/exit as independent ordered facts, ordered resize with ioctl readback, bounded backpressure with explicit gaps, resumable attach cursors with opaque versioned checkpoints, writer claims/leases, termination-as-input with survivor reporting, honest inspect with completeness), a minimal semantic shape, and freeze tests A–K that must pass on a neutral fixture AND real sessiond before the contract freezes. All Hive policy lives above the seam; syscalls are implementation options, never API vocabulary. Output: the FREEZE A2 builds against.
- A1 Qualify sessiond against external conformance: PTY lifecycle (posix_openpt/openpty/forkpty, kevent EVFILT_PROC notification vs waitpid evidence), crash/adoption/termination matrices, bounded journal + replay. Sources: Apple man pages, ghostty libghostty-vt docs, conformance-test-ids.json (reference). May split: contract-freeze-facing minimum first (unblocks A2), deep qualification continues in parallel.
- A2 `sessiond-host.ts` — the production `SessionHost` backend speaking the sessiond protocol; daemon wiring (server, delivery, teardown, recovery) behind the A0-frozen contract — never against today's unproven contract.
- A3 Input arbiter live-proof: one ordered write path, human input claim acquired synchronously, no automation timeout steal (invariants I3/I4).
- A4 Close/reconnect semantics live-proof: visibility lease, renderer crash → bounded replay; Workspace quit → verified termination of every provider tree (I2).

**Track B — renderer (Swift)** ∥ A
- B1 Qualify HiveTerminalKit + GhosttyKit build chain: pinned commit, universal XCFramework, patch budget per ADR-0002; fidelity/IME/mouse/resize/copy/search/VoiceOver/GPU lifecycle against real vendor TUIs in a harness.
- B2 Wire HiveTerminalView into Workspace panes (replaces SwiftTerm attach path); first-responder, selection, accessibility, geometry.
- B3 New smoke harness driving sessiond+HiveTerminalKit (replaces SmokeRunner/smoke.sh coverage).

**Track C — quality bar** ∥ A,B
- C1 "Beautiful blank terminal": typography, theme, padding, cursor, scrollback feel; design checklist + engineer screenshot review (the M1 bar is explicitly aesthetic as well as functional).
- C2 Packaging: signed, notarized, self-contained universal build; clean-machine install with tmux absent (I9).

**Cut**
- STORY-001 + STORY-002 execute as ONE atomic merge train (Removal Gate reached); full matrix re-run on the post-deletion tree → M1 exit proof recorded. Pre-cut drain performed by the OLD/bootstrap build (refuse cut while any legacy session survives; dev DB/runtime state archived + destructively reset — tmux identity rows are not migrated).

Dependency edges (tightened per atlas R3): A0→A1(min freeze)→A2 → A3; A2+B1→B2; A2+B2→A4 (host-only crash proofs may run earlier); A2+A3+A4+B1+B2→B3; B2→C1 close (design exploration earlier); B1+A2+B2→C2 integrated packaging, clean-machine acceptance closes only on the cut tree; A3+A4+B2+B3+C1+C2 → atomic cut → re-run B3+C2+matrix → M1 exit. Max parallelism: A0/A1 ∥ B1 ∥ C1-exploration; early starts allowed, closes gated.

---

## M2 — vendor coding-agent TUIs live, silent Queen belief, proven status

Exit: for each of claude code / codex / grok × {normal, yolo}: agent boots inside the new terminal as Queen with the belief injected silently (never visible in the transcript), performs work, and updates status end-to-end with every current status promise proven live.

- **S2.1 Native spawn pipeline** (per-vendor, 3 stories, ∥ after M1-A2): spawn vendor CLI into a sessiond generation with env/cwd/argv contract; no tmux paste-based prompt delivery; argv-size and secret-hygiene rules (0600 files over argv for sensitive payloads).
- **S2.2 Silent belief injection** (per-vendor, ∥) — atlas finding (sourced, 2026-07-17) is the spec:
  - claude: `--append-system-prompt-file <0600 file>` (interactive-mode confirmed; code.claude.com/docs/en/cli-usage#system-prompt-flags). Normal `--permission-mode default`; yolo `--dangerously-skip-permissions` (permission-modes doc).
  - codex: `developer_instructions` via ephemeral 0600 `$CODEX_HOME/<name>.config.toml` + `--profile <name>` (not AGENTS.md, not model_instructions_file which REPLACES base instructions; developers.openai.com/codex/config-reference + config-advanced). Normal `-a on-request -s workspace-write`; yolo `--yolo`.
  - grok (research RESOLVED): `--rules` (alias `--append-system-prompt`) appends to system prompt, carried in ACP initialize metadata, not transcript-visible (docs.x.ai/build/cli/reference, modes-and-commands; xai-org/grok-build source). Never `--system-prompt-override` (replaces xAI base prompt). Normal: explicit `--permission-mode default` + explicit sandbox (sandbox default is OFF); yolo `--always-approve`/`--yolo`. Caveat: argv visible via `ps` — belief in argv is silent-in-TUI but not process-inspection-private; if that matters (Q6), use ACP initialize metadata or upstream a file surface.
  - **Approval modes: FULL 3-WAY MATRIX, RATIFIED by user (final):** approval and sandbox are independent axes; each vendor story BUILDS and LIVE-PROVES all three of {manual, sandboxed-autonomous, unsafe-bypass}, with "yolo" = unsafe-bypass and the middle kept explicit. Unsupported distinctions (e.g. eligibility-gated modes) are named explicitly in evidence, never silently skipped. Claude: manual `--permission-mode default` / eligible auto `--permission-mode auto` / unsafe `--dangerously-skip-permissions`. Codex: `-a on-request -s workspace-write` / `-a never -s workspace-write` / `--yolo`. Grok: `--permission-mode default` + explicit sandbox / `--always-approve` + explicit restrictive sandbox / approval bypass with sandbox off (macOS child-network caveat stands). The brief's "yolo" maps to unsafe-bypass; sandboxed-autonomous is added coverage.
  - Grok argv note (RESOLVED, user ruling Q6): TUI/transcript-silence is SUFFICIENT — "no user should SEE the belief prompt." ps-invisibility is NOT a requirement; prefer a non-argv path only where it is free (do not over-constrain the story on it). "Carried in ACP metadata" is evidence/inference, NOT a vendor secrecy guarantee — the raw-PTY nonce proof remains the authority.
  - Live proof (all vendors, from atlas): unique nonce in belief; capture ALL PTY bytes and assert nonce never renders; neutral first prompt elicits belief-dependent behavior or an authenticated status call carrying the nonce; manual-mode run produces a real approval state on a harmless write+shell, autonomous/bypass runs execute without one. Green exit ≠ proof. Pin vendor versions in evidence.
- **S2.3 Status pipeline**: StatusEnvelope v2 (source/freshness/confidence), `hive_update_status`, statusline-fact ingestion on the new spine; live agent demonstrates EVERY current status promise (working/idle/approval/paused/stuck/done/failed/unknown) observed end-to-end; terminal pixels are never status truth (I6).
- **S2.4 Message delivery over the new spine**: normal/steer/urgent/critical delivered through the sessiond arbiter per-vendor with measured receipt; truthful degradation stated per vendor (flat queen→workers policy only; hierarchy comes in M4).
- **S2.5 Vendor-TUI terminal conformance**: alt-screen, kitty keyboard, mouse reports, bracketed paste, OSC 52 — per-vendor corpus runs inside the new terminal.

Dependencies (contradiction resolved per atlas R3 P0-2): M2 story DEVELOPMENT may start once M1-A2 exists; M2 story CLOSURE requires the M1 cut (post-deletion tree). Per-vendor stories mutually ∥; S2.3/S2.4 ∥ with the vendor stories.

---

## M3 — communication fabric (build docs/design/hive-communication.html)

Staging follows the doc's C-ladder, minus UI (C2 deferred to M5 gate/Split Horizon):
- S3.1 C0A durable core: v2 envelopes/events, pre-spawn identity reservation, digests/causal links/idempotency, content object store + bounded previews, ContextInputRecord + TokenAttributionProjection, WorkManifest + checksummed journal outside worktrees.
- S3.2 C0B bounded truthful wakes: one delivery lane on the sessiond spine, provider-observed vs applied split, byte/rendered-token wake budgets, inbox cursors, mandatory reads, explicit acks.
- S3.3 C0C stranding recovery: journal-first WorkManifest rebuild, agreed-empty auto-clean, typed Engineer prompt with resume/preserve/discard.
- S3.4 C1A hierarchy-aware routes (lands with M4's schema): edge checks, channels, delegation validation, artifacts, rollups, budgets.
- S3.5 C1B cutover: reject caller-supplied `from`, name-only addressing, inbox-implies-applied, unbounded paste, prose-derived control intent. (Gut-then-rebuild applies: the ambiguous legacy paths are deleted, not shimmed; per the doc, only after no live legacy binding remains.)
- Verification stories mirror the doc's attack suite: identity/authority, delivery/recovery chaos (kill -9 between every durable step), context/evidence, token-efficiency gates, stranded work — each a live-proof story, no adapter test doubles for live acceptance.

∥: S3.1 can start during M2 (daemon-side, no terminal dependency); S3.2 needs M1 spine + M2 per-vendor delivery evidence.

## M4 — agentic hierarchy (build docs/design/agentic-hierarchy.html)

Follows the doc's H-ladder, minus UI:
- S4.1 H0 shadow records: SpecRevision, PlanRevision, HierarchyNode/AgentBinding, IntegrationStage, PromotionGrant, Run/Task/TaskDetail, grants/channels/budgets/decisions/checkpoints/reviews/ArtifactRef.
- S4.2 H1 direct+flat control plane: typed G1/G2 gates, queen-owned run IntegrationStage, DelegationSpec, scoped tasks, independent authored-candidate review, budget fencing, daemon-only promotion (hive_land loses its fixed target; PromotionGrant-derived).
- S4.3 H2 optional lead tier: attenuated crew delegation, InterfaceContracts, pair channels, subtree rollups, TopologyDecision.
- S4.4 H3 promotion trains: speculative exact-SHA validation, bisect/requeue, revalidation.
- S4.5 H4 recovery: semantic checkpointing, WorkManifest ownership transfer, queen succession, lead loss, bounded quiesce, circuit breakers.
- S4.6 H5 stable projections freeze — the handoff Split Horizon consumes.
- New-launch integration: spawning (M2 pipeline) gains hierarchy admission — reserve-before-spawn, attenuation checks, capability epochs (project-agnostic: roles/topology never assume the Hive repo).

Depends on M3 C0/C1A; H-stories sequential-ish (H0→H1→H2) with verification stories ∥ per stage.

## M5 — UI-readiness gate (NOT UI work)

Exit = every Split Horizon feature-ledger row (A run awareness/hierarchy, B terminal workbench/input safety, C task/review/lifecycle/evidence, D settings/global controls) has its underlying truth built and LIVE-PROVEN via projections/CLI/typed operations — demonstrated without any new UI. Split Horizon then starts as pure presentation ("about looks, not features") and is out of this plan's build scope.

- S5.x one gate story per ledger row family, each enumerating its projections (Workspace feed v1, WorkspaceSnapshot v2, session inspection+events, TaskDetail+ArtifactRef, CommunicationProjection, TokenAttributionProjection, CLI bridge) with live proof.
- Final story: end-state demo — dev build opens on an arbitrary non-Hive project, any of the three vendors boots as Queen, full loop (spawn→work→status→message→land) proven.

---

## Decisions ledger (ALL RESOLVED — user rulings via queen, 2026-07-17)

Q1 Board access: RESOLVED — `project` scope granted; read+write confirmed, 34 stories on the board.
Q2 Where the rebuild lands: RATIFIED (user, final) — the rebuild proceeds **on main progressively**, and the **PINNED BOOTSTRAP BINARY** approach is formalized: a checksummed known-good OLD Hive release is pinned as an isolated bootstrap tool — its own HIVE_HOME/DB/socket/ports, no access to new runtime state — and orchestrates M2 development while main carries the new/gutted state. Supersedes the integration-branch lean. Baked in as early M1 story **M1-BOOT** (checksum + state-isolation as acceptance criteria) since it is a prerequisite for developing under the gutted main. No long-lived integration branch (branches only for work organization). **Release/activation is a separate END gate: nothing ships to consumers until the whole rebuild is done AND stable.** The Removal Gate still governs the tmux cut — main is never gutted before the replacement passes the full live vendor matrix. The old-build pre-cut drain (R3 P0-4) is executed BY the bootstrap instance.
Q3 STORY-002 scope: RESOLVED (user) — exactly the SwiftTerm/tmux-attach agent-TUI hosting+render path; status-text emitters explicitly excluded.
Q4 In-tree sessiond/HiveTerminalKit: RESOLVED (user) — qualify-don't-presume; candidate to qualify across the live matrix, never evidence.
Q5 M1 aesthetic bar: RESOLVED (user) — the USER personally signs off against reference terminals; hard gate in M1's definition of done.
Q6 Grok belief silence: RESOLVED (user) — TUI/transcript-silent is SUFFICIENT; prefer non-argv where free; ps-invisibility is NOT a requirement.
Q7 Grok third opinion: RESOLVED (user) — not needed; atlas's official-sourced finding stands.

## Plan lifecycle

1. ~~Draft~~ → 2. ~~atlas R3 review adopted~~ → 3. ~~User decisions Q1–Q7 folded in~~ → 4. **NOW: finalized plan awaiting USER approval** → 5. Execution authorization (starts with M1 terminal-BUILD stories A0/A1/B1, never the removals) → 6. Removal Gate → atomic cut → 7. M2…M5 → 8. Release/activation END gate.
