# Hive rebuild — milestone-structured backlog outline

Lead planner: astrid · drafted 2026-07-17 · board: github.com/users/scottdev1986/projects/11 (write access pending `project` scope)
Reviewed by: atlas (sequencing guardrail + vendor belief-injection finding folded in)

Every story below inherits the HARD PRINCIPLES (stated in each story's DoD when written):
external research drives, code and design docs are reference not truth; external citations required on every terminal/agent story; gut-then-rebuild, no legacy shims; parallel wherever safe; paired SPEC + doc-cleanup task, docs describe behavior/contracts never file paths or line numbers; production-grade; project-agnostic (works on any repo, any stack); LIVE PROOF to close; UI (split-horizon) last and only consumes proven features.

## Ground zero (backlog positions 1–2, fully specified, READY)

- **STORY-001 Gut ALL tmux terminal code** — planning/story-001-gut-tmux.md
- **STORY-002 Complete removal of agent TUI code (SwiftTerm/tmux-attach hosting path)** — planning/story-002-remove-agent-tui.md

Sequencing resolution (explicit): both are specified FIRST and execute at the **Removal Gate** — the replacement host+renderer live-proven (launch/attach/type/resize/scroll/close-with-verified-termination/reconnect with a real vendor TUI). Hard cut, no dual-host canary, no renderer flag, no compat writes. Every M1 build story exists to reach that gate; the two removals then complete M1. You cannot remove the process host that runs agents before its replacement runs agents — so its replacement running agents is the gate, and nothing else unblocks execution.

Standing decision (applies to several stories): sessiond (~10.3K LOC Zig), HiveTerminalKit (~2.2K LOC Swift), vendored Ghostty, ADRs 0001/0002, and conformance-test IDs already exist in-tree, but HiveTerminalKit is imported only by its own tests — nothing user-facing runs it. Per the hard principles this code is NOT presumed correct: each M1 story QUALIFIES the existing artifact against external conformance sources and keeps it only if it passes live; rewrite is the fallback, not the default. (Open question Q4 asks queen/user to confirm this stance.)

---

## M1 — dev build with a fully functional, beautiful native terminal

Exit: open the dev build → a blank native terminal that looks excellent; create/type/scroll/resize/select/copy/IME/close/reconnect all work; zero tmux, zero SwiftTerm; self-contained app (no user-installed tmux/Ghostty/Zig); works on any project directory.

Parallel tracks (∥ = concurrent):

**Track A — session host (Zig/daemon)**
- A1 Qualify sessiond against external conformance: PTY lifecycle (posix_openpt/openpty/forkpty, kevent EVFILT_PROC), crash/adoption/termination matrices, bounded journal + replay. Sources: Apple man pages, ghostty libghostty-vt docs, conformance-test-ids.json (reference).
- A2 `sessiond-host.ts` — the production `SessionHost` backend speaking the sessiond protocol; daemon wiring (server, delivery, teardown, recovery) behind the existing neutral contract.
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
- STORY-001 + STORY-002 execute (Removal Gate reached) → M1 exit proof recorded.

Dependencies: A2 needs A1; B2 needs B1 and A2; cut needs A3/A4/B2/B3; C1/C2 anytime after B1.

---

## M2 — vendor coding-agent TUIs live, silent Queen belief, proven status

Exit: for each of claude code / codex / grok × {normal, yolo}: agent boots inside the new terminal as Queen with the belief injected silently (never visible in the transcript), performs work, and updates status end-to-end with every current status promise proven live.

- **S2.1 Native spawn pipeline** (per-vendor, 3 stories, ∥ after M1-A2): spawn vendor CLI into a sessiond generation with env/cwd/argv contract; no tmux paste-based prompt delivery; argv-size and secret-hygiene rules (0600 files over argv for sensitive payloads).
- **S2.2 Silent belief injection** (per-vendor, ∥) — atlas finding (sourced, 2026-07-17) is the spec:
  - claude: `--append-system-prompt-file <0600 file>` (interactive-mode confirmed; code.claude.com/docs/en/cli-usage#system-prompt-flags). Normal `--permission-mode default`; yolo `--dangerously-skip-permissions` (permission-modes doc).
  - codex: `developer_instructions` via ephemeral 0600 `$CODEX_HOME/<name>.config.toml` + `--profile <name>` (not AGENTS.md, not model_instructions_file which REPLACES base instructions; developers.openai.com/codex/config-reference + config-advanced). Normal `-a on-request -s workspace-write`; yolo `--yolo`.
  - grok (research RESOLVED): `--rules` (alias `--append-system-prompt`) appends to system prompt, carried in ACP initialize metadata, not transcript-visible (docs.x.ai/build/cli/reference, modes-and-commands; xai-org/grok-build source). Never `--system-prompt-override` (replaces xAI base prompt). Normal: explicit `--permission-mode default` + explicit sandbox (sandbox default is OFF); yolo `--always-approve`/`--yolo`. Caveat: argv visible via `ps` — belief in argv is silent-in-TUI but not process-inspection-private; if that matters (Q6), use ACP initialize metadata or upstream a file surface.
  - Live proof (all vendors, from atlas): unique nonce in belief; capture ALL PTY bytes and assert nonce never renders; neutral first prompt elicits belief-dependent behavior or an authenticated status call carrying the nonce; normal-mode run produces a real approval state on a harmless write+shell, yolo run executes without one. Green exit ≠ proof.
- **S2.3 Status pipeline**: StatusEnvelope v2 (source/freshness/confidence), `hive_update_status`, statusline-fact ingestion on the new spine; live agent demonstrates EVERY current status promise (working/idle/approval/paused/stuck/done/failed/unknown) observed end-to-end; terminal pixels are never status truth (I6).
- **S2.4 Message delivery over the new spine**: normal/steer/urgent/critical delivered through the sessiond arbiter per-vendor with measured receipt; truthful degradation stated per vendor (flat queen→workers policy only; hierarchy comes in M4).
- **S2.5 Vendor-TUI terminal conformance**: alt-screen, kitty keyboard, mouse reports, bracketed paste, OSC 52 — per-vendor corpus runs inside the new terminal.

Dependencies: all need the M1 cut; per-vendor stories are mutually ∥; S2.3/S2.4 ∥ with S2.1 after A2 exists.

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

## Open questions / user decisions (surfaced, not decided)

Q1 Board access: gh token lacks `project` scope — user must run `gh auth refresh -s project` (or supply a PAT). Blocks all board writes.
Q2 Where does the gutted state land: main immediately at the M1 cut (the fleet's running production Hive keeps its old binary until M2?), or a long-lived integration branch until M2? Affects Hive-develops-Hive during the gap. My recommendation: integration branch until M2 exit, then one landing — but this is the user's call.
Q3 STORY-002 interpretation: confirm "agent TUI code" = SwiftTerm/tmux-attach hosting path (my primary reading), not the CLI status-text emitters.
Q4 Confirm the qualify-don't-presume stance on in-tree sessiond/HiveTerminalKit (vs. mandated from-scratch rewrite).
Q5 M1 "beautiful" bar: propose design checklist + engineer screenshot review as the acceptance mechanism — who signs off?
Q6 Grok argv caveat: is silent-in-TUI sufficient, or must the belief also be invisible to local `ps` (then: ACP initialize metadata path / upstream file-surface request)?
Q7 Third-opinion trigger: atlas's grok finding is sourced from official xAI docs + source; do we still want a Grok-researcher third opinion (queen would spawn) before S2.2-grok is marked Ready?
