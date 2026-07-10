---
title: Hive Workspace restart handoff
date: 2026-07-10
tags: [architecture, workspace, restart, security, appkit, agenthost]
---

Canonical documents:

- `docs/architecture/hive-workspace-blueprint.md` — destination architecture, decisions, verified defects, superseded proposals, prototypes, gates, sources, and open questions.
- `docs/architecture/restart-handoff.md` — precise ordered continuation checklist.
- `research/cross-vendor-architecture-review.md` — driven provider/macOS evidence and Claude repro procedures, source research landed at `1859353`.
- Source research landed at `1859353`; the companion routing/cost policy landed at `ad21bae`. Resolve the final canonical documentation landing without chat using `git log -1 -- docs/architecture/hive-workspace-blueprint.md`, and resolve this memory's containing landing with `git log -1 -- .hive/memory/hive-workspace-restart-handoff.md`.

Accepted architecture: a signed Swift/AppKit Hive Workspace owns Hyprland-inspired project windows. Agent panes are native semantic AppKit transcripts; SwiftTerm and tmux are limited to a user shell and legacy TUI compatibility. `libghostty` is deferred until its embedding API is tagged and stable. One UI process multiplexes hard tenant objects. Each canonical project root has an immutable `HiveUUID`; user linked worktrees are separate Hives, while Hive-managed agent worktrees attach through authenticated owner-ledger metadata. Simultaneous `hive init` calls coalesce under a Supervisor registry lease (the command was `hive start` until it was folded into `hive init` and removed).

Authority split: the per-user Supervisor owns project/binding registries, build negotiation, quota metadata, and repo-family landing leases. One Tenant Broker per Hive owns semantic truth, settings, worktrees, approvals, epochs, and landing policy. One reconnectable AgentHost per provider session owns the child process and stdio plus a bounded replay WAL. The provider owns its native session; the UI owns presentation. Broker loss reattaches to AgentHost. Host/provider ambiguity becomes explicit `UNKNOWN_OUTCOME`; prompts and approvals are never replayed automatically.

Verified Phase 0 blocker: the current daemon exposes `/mcp` and other mutation routes on unauthenticated `127.0.0.1:4483`, including spawn, kill, approve, and land. A local agent can bypass the intended authority boundary. The first proposed implementation task after restart is a narrowly scoped Phase 0 authentication/authorization repair for every mutation endpoint: public peer authentication, connection-bound least-privilege subject/action capabilities, epoch rotation/revocation, one-shot self-landing grants, credential `CLOEXEC`/noninheritance, audit, and adversarial tests. A Unix socket alone is insufficient against same-UID agents. No flagship or Phase 0 product/security implementation was authorized during this documentation task.

Verified reliability defect: daemon reuse accepts any `/health` body with `ok === true`, ignores version, and captures the first daemon's cwd as repo root. This permits cross-project and stale-build reuse and likely explains the post-land Terminal PID failure. The replacement handshake binds `HiveUUID`, content-addressed build hash, protocol/schema ranges, capabilities, and generation; health never authorizes reuse.

Providers: Codex CLI 0.144.0 and Claude Code 2.1.206 are ring-1 candidates only per immutable binding generation that passes the common conformance fixture. Claude's account-scoped model list, approvals, cancellation capability, and pending-approval replay were driven successfully; `--permission-prompt-tool` remains undocumented and version-gated. Model state is catalogued, provider-reported selectable, then launch validated. No guessed probes, billable discovery, fallback, or silent substitution. Executables launch by immutable absolute binding, not PATH.

Key prototypes, in order: AgentHost crash matrix across every accept/write/event/WAL boundary; native transcript usability and accessibility; signed XPC plus capability noninheritance; project identity under rename/move/recreate/symlink/submodule/linked-worktree/network volume; provider-neutral Claude/Codex conformance. The blueprint's twelve safety gates block release; performance, accessibility, animation, and soak numbers are product-quality targets.

Resume order: read the handoff and blueprint; verify the documentation and source research commits; read `docs/research/model-routing-and-token-efficiency.md` when work touches routing/cost policy; scope and land Phase 0 before any Swift flagship work; then fix build/project handshake; run prototypes; build Supervisor/registry/brokers; migrate legacy `HIVE_HOME`/tmux transactionally; build the AppKit transcript workspace; add SwiftTerm only for shell/legacy panes.
