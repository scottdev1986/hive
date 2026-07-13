# Wiki Log

## [2026-07-13] ingest | Compile docs/ into a code-verified wiki

Rebuilt `docs/` as a compiled wiki. Every prior document was audited claim-by-claim
against the source tree; the code was treated as the source of truth wherever the two
disagreed. Durable knowledge — design rationale, measured vendor behavior, rejected
alternatives, incidents — was compiled into topic articles. Everything else was purged.

Immutable measurement evidence moved from `artifacts/` to `raw/grok/`, which sits
outside the briefing walk (`DOC_DIRECTORIES` in `src/adapters/profile.ts`) so that
evidence is preserved without being fed to every spawned agent.

- Created: Routing policy; Quota and headroom; Model Control Center; Rejected approaches
- Created: Capability discovery; Launch mechanics; Quota surfaces; Grok
- Created: Graphify integration; Graphify bundling
- Created: Authorization; Database resilience; Orchestrator status
- Created: Workspace blueprint; UI design system; Platform constraints
- Created: Context and recycling; Agent memory; Briefing
- Created: Versioning and release; Update experience; Distribution

Purged as ephemeral (work completed, or describing deleted code):
`session-2026-07-11-findings-and-plan.md`, `adapter-hardening-audit.md`,
`architecture/stranded-branch-disposal-2026-07-13.md`,
`architecture/graphify-query-degradation.md`, `design/workspace-visual-audit.md`,
`architecture/restart-handoff.md`.

Purged as superseded: `architecture/grok-vendor-integration.md` (subsumed by the Grok
spec), `benchmark-fit-policy-proposal.md` (marked "ADOPTED / live" while the function it
governed, `deriveRouting`, had already been deleted), `research/dynamic-model-router.md`
and `research/dynamic-router-adoption.md` (the signed-manifest router, ripped out),
`model-selection.md` Layer 1 (the tier ladder, deleted).
