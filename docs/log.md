# Wiki Log

## [2026-07-14] correction | Reconcile docs with landed agent-authored profiling foundation

Reconciled public and knowledge-base docs with the **landed** portion of the
agent-authored project-profiling epic (schema/storage/lifecycle, F1 bounded
inventory, F2 candidate/envelope + requester/guidance provenance, `profiling`
routing category). Corrected passages that still presented the deterministic
`profile.toml` / silent `ensureProfile` path as architecture truth.

- **Landed surfaces cited:** `src/schemas/project-profile.ts`,
  `src/daemon/project-profile.ts`, `src/daemon/project-profile-validate.ts`,
  `src/schemas/routing-policy.ts` (`profiling` category).
- **Unbuilt called planned only:** five `profile_*` MCP tools, launcher/skill,
  spawn gate, operator CLI, drift refresh, consumer migration, legacy removal —
  per `docs/design/profiling-implementation-plan.md` §Independently-landable
  work packages. Briefing still on transitional `src/adapters/profile.ts` until P8.
- **Touched:** `SPEC.md` (decisions 5/14, summary, roadmap v1), `README.md`,
  `docs/agents/briefing.md`, `docs/agents/memory.md`, `docs/index.md`,
  `docs/daemon/multi-instance.md`, `docs/design/profiling-implementation-plan.md`,
  `docs/workspace/blueprint.md`. Excluded P1 surfaces (`docs/daemon/authorization.md`,
  `src/**`, capability matrix).

Distinctions kept sharp: local profile file vs inventory sent to a provider;
automatic background refresh vs explicit reprofiling; structured profile vs
narrative memory; new foundation vs outgoing legacy reader.

## [2026-07-14] correction | README init --refresh does not start the daemon

Plain `hive init` starts the daemon. `hive init --refresh` forces the outgoing
cache rebuild while otherwise running init (skills, optional memory, Graphify,
stamp), then exits without starting the daemon (`src/cli.ts` skips `runStart`
when `options.refresh === true`). README quick-start prose and the commands
table state that split explicitly.

## [2026-07-14] correction | Profiling-docs re-review fixes (forrest)

Cross-vendor review NO-LAND findings applied:

1. **Plan F1/F2 as completed contract** — `docs/design/profiling-implementation-plan.md`
   no longer presents bounded inventory / candidate-envelope / provenance as open
   work; sequencing narrative starts at P1; obsolete full-payload and false
   validation-line imperatives removed.
2. **Current init profiling restored** — README, SPEC decision 14, briefing, and
   Workspace blueprint state that `hive init` still runs legacy `ensureProfile`
   and supports `--refresh` until plan package P5.
3. **SPEC §15 summary split** — landed storage/acceptance vs transitional
   `profile.ts` consumers vs planned P2/P8 authorship/consumption.
4. **Log touched-list** — includes the design plan and blueprint (this entry's parent).

## [2026-07-14] measurement | Exercise three native instances; retain the GUI blocker

A fresh isolated native build opened three real Workspace processes from the same
repository for Claude Code, Codex, and Grok. All nine orchestrator-to-agent pairings
returned unique initial and follow-up identifiers to only their originating database;
a simultaneous nine-message wave had zero sibling identifiers. Every live root and
agent exposed a known status, all three Graphify instances served the pinned 0.9.12
graph, writer launches used the selected full-autonomy posture without a prompt, one
agent and then one instance stopped without affecting the survivors, and the stopped
instance relaunched with a fresh root and no cross-attachment.

This was diagnostic evidence, not a completed release acceptance run. macOS reported
Accessibility automation disabled, so prompts had to enter through tmux. The visible
GUI-input, pane-close, and composer draft-preservation cases were therefore unexecuted
and remain blocked rather than being converted into passes. The acceptance article now
requires an Accessibility preflight before provider work and forbids that fallback.
It also tells no-op agents to finish their turn instead of calling a wait primitive;
one Codex agent demonstrated why by correctly holding a normal follow-up until its
artificially open turn ended.

## [2026-07-14] correction | Replace the rejected Codex dual-client root path

Live native acceptance on Codex 0.144.4 disproved the fake-transport assumption that
an app-server authority serving the remote TUI also accepts a second Hive client. The
server closed that client during initialization and all three agent reports remained
queued. Root delivery now uses the composer-leased delayed terminal transport for all
three providers, and the dead second-client driver was removed. The same run exposed
a blocking Codex-root approval for `hive_spawn`; the root now pre-approves only Hive's
capability-scoped MCP server. Matrix guidance now requires writer agents performing
read-only no-op tasks so full autonomy is actually exercised.

The next fresh fleet exposed a separate installed-build boundary: Codex lifecycle
hooks invoked bare `hive`, which is intentionally absent from an isolated native test
installation's `PATH`. Every tool/stop hook exited 127, so idle Codex agents remained
shown as working and a follow-up stayed queued. Codex spawn and recovery hooks now pin
the exact running Hive binary, matching Claude's existing release behavior.

## [2026-07-14] audit | Define the native Workspace acceptance gate

Compiled the release acceptance procedure from the production builder, native install
layout, public Workspace entry points, instance lifecycle, provider drivers, Graphify,
and composer-lease implementation. The gate now requires three visible concurrent
Workspace processes, every orchestrator-to-agent combination, separate GUI text and
submit events, known structured status, enabled-Graphify queries, cross-instance and
draft isolation, no-op repository proof, a fresh final build, and complete cleanup.
It explicitly rejects private launch helpers, copied repositories, headless smoke as
acceptance, provider-secret/keychain handling, and evidence spanning two builds.

## [2026-07-14] audit | Reconcile docs with the hardened control plane

Audited every article against the source after multi-instance isolation, machine-wide
mutation leases, verified agent teardown, shared Swift/TypeScript wire fixtures, and
terminal-surface removal landed. Corrected routing fallback, installer provenance,
quota ownership, workspace feed, authorization, and source references; refreshed the
index only after the article-level checks passed.

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
