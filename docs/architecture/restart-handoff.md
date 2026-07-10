# Hive Workspace restart handoff

## The one-minute restart brief

The accepted flagship is a signed Swift/AppKit workspace with native semantic agent transcripts, a limited SwiftTerm shell/legacy-TUI surface, immutable per-project `HiveUUID`s, one Supervisor, one Tenant Broker per Hive, reconnectable per-session AgentHosts, and authenticated connection-bound capabilities. The [Workspace blueprint](hive-workspace-blueprint.md) is canonical. The [cross-vendor review](../../research/cross-vendor-architecture-review.md) is the experimental record.

**Phase 0 — authenticating and authorizing the loopback control plane — is landed**, behind the [capability rights matrix](capability-rights-matrix.md) and its adversarial tests. No further flagship implementation is authorized yet. Do not start the Swift app, Supervisor migration, provider refactor, or AgentHost implementation before each has its own scoped assignment and acceptance tests.

## What is settled

Agent panes are AppKit transcripts, not terminal grids. SwiftTerm exists only for a user shell and legacy provider TUI. `libghostty` is deferred until its embedding API is tagged and stable. One AppKit process multiplexes project windows; tenant isolation is logical unless a VM or remote runner is selected.

`hive start` resolves a canonical Git worktree or exact plain directory to an immutable `HiveUUID`. User linked worktrees are separate projects; Hive-managed agent worktrees attach to their authenticated owner. Nested repositories win. Plain bookmarks follow moves, so path disagreement requires rebind; recreated paths never inherit automatically. Concurrent starts coalesce under a registry uniqueness lease.

The authority split is fixed: Supervisor owns registry, bindings, build negotiation, quota metadata, and repo-family landing leases; Tenant Broker owns project policy and semantic truth; AgentHost owns provider process and pipes plus a bounded replay WAL; provider owns native session; UI owns presentation. Broker death must not sever pipes. Host/provider ambiguity becomes `UNKNOWN_OUTCOME`, never an automatic replay.

Claude Code 2.1.206 and Codex CLI 0.144.0 are ring-1 candidates only for binding generations that pass the shared conformance fixture. Claude's model/approval/replay surfaces were driven successfully, but `--permission-prompt-tool` is undocumented. Model status distinguishes catalogued, provider-reported selectable, and launch validated. Hive never guesses probes or silently falls back.

## Verified defects to preserve in every plan

The daemon exposed control and mutation endpoints on `127.0.0.1:4483` without authentication, including MCP tools capable of spawning, killing, approving, and landing, which made the capability-epoch story bypassable by any worktree-confined local process. Phase 0 closed this: every mutation route authenticates a bearer capability and authorizes it against the least-privilege allowlist in the [capability rights matrix](capability-rights-matrix.md), credentials never travel in environment or argv, revocation advances the epoch, and decisions are audited. The residual same-UID filesystem read is accepted and documented; a Unix socket would not have stopped it either.

The current launcher also treats any `/health` response with `ok === true` as the right daemon, ignores its version, and uses the first daemon's startup cwd as repository root. This permits cross-project and stale-build reuse. The destination handshake binds project identity, content-addressed build, protocol/schema ranges, capability set, and generation. Health is never authorization.

## Resume after restart, in order

1. Read this handoff, then the [canonical blueprint](hive-workspace-blueprint.md). Pull details only as needed from the [cross-vendor review](../../research/cross-vendor-architecture-review.md).
2. Verify main contains this documentation landing and research commit `1859353`. Resolve the documentation landing with `git log -1 -- docs/architecture/hive-workspace-blueprint.md` and record it in the new work report.
3. Read the landed [model-routing and token-efficiency policy](../research/model-routing-and-token-efficiency.md) only when work touches provider choice, escalation, budgets, or telemetry. Reconcile direct conflicts in the owning document rather than copying its policy into the blueprint.
4. Phase 0 is landed. The [capability rights matrix](capability-rights-matrix.md) is its binding contract: read it before touching any daemon route, and treat `/health` and `/handshake` as public and non-authorizing. Adding a mutation route means adding a matrix row and an adversarial test in the same change.
5. The HTTP plane's residual risk is a same-UID process reading a `0600` credential file. Do not paper over it. Closing it requires a real privilege boundary and belongs with the Supervisor.
6. Reproduce any future control-plane defect only with non-destructive calls or a test harness. Never invoke landing, kill, or approval against live work to prove exposure.
7. Add build/project/protocol validation to daemon reuse as the next bounded reliability task.
8. Run the five de-risking prototypes in blueprint order: AgentHost crash matrix, native transcript, authenticated XPC, identity under motion, and provider conformance. Record evidence before promoting a hypothesis to a decision.
9. Build the Supervisor/registry/brokers only after IPC and identity prototypes pass. Migrate CLI state transactionally before building the UI.
10. Build one multiplexing AppKit Workspace with transcript panes. Add SwiftTerm only when implementing shell/legacy panes. Do not start a libghostty integration.
11. Treat the twelve safety gates as release blockers and the performance/accessibility/soak numbers as product-quality targets. Update the blueprint in place when evidence changes a decision.

## Artifacts and ownership

- Canonical destination: [Hive Workspace blueprint](hive-workspace-blueprint.md)
- Authorization contract for every daemon route: [capability rights matrix](capability-rights-matrix.md)
- Operational entry point: this handoff
- Experimental corrections and provider repro: [cross-vendor architecture review](../../research/cross-vendor-architecture-review.md), landed at `1859353`
- Current shipping architecture and historical reasoning: [SPEC.md](../../SPEC.md)
- Packaging and activation: [distribution research](../../research/distribution-auto-update.md) and [update experience](../../research/update-experience.md)
- Routing/cost companion: [model routing and token efficiency](../research/model-routing-and-token-efficiency.md), landed at `ad21bae`
- Durable summary: repo memory fact `hive-workspace-restart-handoff`

## Open work, not authorization

The blueprint names genuine questions around transcript usability, WAL retention and encryption, AgentHost process count, remote viewing, overview privacy, network-volume identity, the undocumented Claude flag, and routing policy. They are prototype or policy work. Their presence does not authorize product code during this documentation handoff.
