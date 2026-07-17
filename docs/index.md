# Knowledge Base Index

Compiled knowledge about Hive, verified against the source tree. Where a document and
the code disagreed, the code won and the document was corrected. Immutable measurement
evidence lives in `raw/`, outside the briefing walk; the design authority is
[SPEC.md](../SPEC.md).

## routing

How Hive chooses a model, and what stops it choosing quietly.

| Article | Summary | Updated |
| --- | --- | --- |
| [Routing policy](routing/routing-policy.md) | Explicit enablement is the outer boundary; category and Default chains express preference order, and only an exhausted authored search widens across the remaining enabled models. | 2026-07-14 |
| [Quota and headroom](routing/quota-and-headroom.md) | Quota gates every candidate; weighted-fair dispatch serves `auto` and exhausted-`choice` fallback without comparing unlike provider windows or scoring unknown capacity. | 2026-07-14 |
| [Model Control Center](routing/model-control-center.md) | The settings surface that keeps consent, routing preference, capability, and quota evidence distinct; unknown never renders as zero. | 2026-07-14 |
| [Rejected approaches](routing/rejected-approaches.md) | Routing designs that were adopted and then killed — tiers, signed-manifest ranking, and external benchmark scoring — and why each died, so nobody rebuilds them. | 2026-07-14 |

## providers

Vendor wire behavior. Most of this was bought with measured prompts and cannot be re-derived by reading code.

| Article | Summary | Updated |
| --- | --- | --- |
| [Capability discovery](providers/capability-discovery.md) | Every vendor CLI can expose an account-scoped model catalog without buying an inference; none says which model is good, and every absent field remains unknown. | 2026-07-14 |
| [Launch mechanics](providers/launch-mechanics.md) | Per-CLI launch arguments with sharp edges: model, effort, autonomy, session identity, and the verification required before a failed launch may be replaced. | 2026-07-14 |
| [Quota surfaces](providers/quota-surfaces.md) | Vendor quota readings, machine-wide reservations, provenance, and the positive catalog evidence required before spend can be attributed to a provider pool. | 2026-07-14 |
| [Grok](providers/grok.md) | Grok as a peer vendor: semantic-prefix permission rules, a sandbox that is not a write barrier, measured catalog liveness, and quota surfaces. | 2026-07-14 |

## graphify

The opt-in code knowledge graph, and how it is shipped.

| Article | Summary | Updated |
| --- | --- | --- |
| [Graphify integration](graphify/integration.md) | Graph context is a hint, never an authority, and no Hive operation may block on it. Everything else is a consequence of those rules or a trap found enforcing them. | 2026-07-14 |
| [Graphify bundling](graphify/bundling.md) | Shipping Graphify as a frozen self-contained bundle Hive builds, signs, and hash-verifies — no uv, Python, or PyPI on a user's machine. | 2026-07-14 |

## daemon

The control plane: who may do what, and what happens when state is missing.

| Article | Summary | Updated |
| --- | --- | --- |
| [Authorization](daemon/authorization.md) | The daemon is the authority boundary even though every agent shares a UID; capabilities and endpoint checks decide which requests may mutate state. | 2026-07-14 |
| [Database resilience](daemon/database-resilience.md) | Per-instance state and the shared quota ledger fail closed on missing or unreadable evidence, preserving work rather than fabricating an empty world. | 2026-07-14 |
| [Orchestrator status](daemon/orchestrator-status.md) | queen (the root orchestrator) has no agents row, so structured turn events and process evidence derive its status without terminal scraping. | 2026-07-15 |
| [Multiple concurrent instances](daemon/multi-instance.md) | Per-instance identity, lifecycle, and control state; owner-scoped repository work; serialized landing; one machine-wide quota ledger; and a global mutation lease. | 2026-07-14 |
| [Isolated rebuild bootstrap](daemon/bootstrap.md) | The immutable old-release control plane used while main carries the rebuild: exact artifact pin, full process-home and runtime isolation, operating contract, and simultaneous live proof. | 2026-07-17 |
| [Agent teardown](daemon/agent-teardown.md) | Capture the owned process tree before killing tmux, reap it, verify post-state, and preserve work whenever cleanup cannot be proved. | 2026-07-14 |

## workspace

The native macOS app, its visual language, and the platform underneath it.

| Article | Summary | Updated |
| --- | --- | --- |
| [Workspace blueprint](workspace/blueprint.md) | A shipping AppKit app whose SwiftTerm panes attach to daemon-owned tmux sessions while structured feeds carry status and control state. | 2026-07-14 |
| [UI design system](workspace/ui-design-system.md) | Semantic colors, native controls, honest unknown states, and the AppKit layout invariants the Workspace enforces. | 2026-07-14 |
| [Platform constraints](workspace/platform-constraints.md) | macOS traps a native Workspace keeps rediscovering: bookmark identity, XPC authority, pasteboard limits, and terminal-renderer boundaries. | 2026-07-14 |

## agents

What a spawned agent carries, remembers, and when it should be replaced.

| Article | Summary | Updated |
| --- | --- | --- |
| [Context and recycling](agents/context-and-recycling.md) | Why percentage thresholds are the wrong unit, what context telemetry can honestly say, and why Hive still lacks the decision-7 recycle actuator. | 2026-07-14 |
| [Agent memory](agents/memory.md) | Committed instructions and agent-authored durable memory are distinct tracks; Hive keeps scoped, provenance-bearing articles rather than an opaque note pile. | 2026-07-14 |
| [Briefing](agents/briefing.md) | Scoped spawn briefs and repo-neutral doc discovery and ranking. | 2026-07-14 |

## release

How a version comes into existence and reaches a machine.

| Article | Summary | Updated |
| --- | --- | --- |
| [Versioning and release](release/versioning-and-release.md) | Patch-only releases, Apple and manifest signing, staged verification, atomic no-follow activation, rollback provenance, and ownership-aware updates. | 2026-07-14 |
| [Update experience](release/update-experience.md) | Bounded notices and an update flow that stages verified bytes first, then tells the truth when quiescence blocks activation. | 2026-07-14 |
| [Distribution](release/distribution.md) | Why Hive uses its native installer — and the first-install authenticity gap the portable shell bootstrap cannot close. | 2026-07-14 |
| [Pre-release acceptance testing](release/acceptance-testing.md) | The development-build gate: run a temporary isolated fleet beside the continuously healthy installed Hive, prove the 3×3 matrix and no-op boundaries, then perform ownership-guarded cleanup and production-baseline attestation. | 2026-07-15 |
