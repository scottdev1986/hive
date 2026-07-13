# Knowledge Base Index

Compiled knowledge about Hive, verified against the source tree. Where a document and
the code disagreed, the code won and the document was corrected. Immutable measurement
evidence lives in `raw/`, outside the briefing walk; the design authority is
[SPEC.md](../SPEC.md).

## routing

How Hive chooses a model, and what stops it choosing quietly.

| Article | Summary | Updated |
| --- | --- | --- |
| [Routing policy](routing/routing-policy.md) | Hive derives no routes: the user's revisioned policy of categories and ordered chains is the router, and the spawner is the sole unconditional net. | 2026-07-13 |
| [Quota and headroom](routing/quota-and-headroom.md) | Quota is an affordability gate on every candidate, and under `auto` it also reorders them — including the unknown-headroom score of 0.15, an invented number competing against measured ones. | 2026-07-13 |
| [Model Control Center](routing/model-control-center.md) | The settings surface that makes the user the router, and the honesty contract it must not break: percent is the only honest meter, and unknown never renders as zero. | 2026-07-13 |
| [Rejected approaches](routing/rejected-approaches.md) | Six routing designs that were adopted and then killed — tiers, the signed manifest, external benchmark ranking — and why each died, so nobody rebuilds them. | 2026-07-13 |

## providers

Vendor wire behavior. Most of this was bought with measured prompts and cannot be re-derived by reading code.

| Article | Summary | Updated |
| --- | --- | --- |
| [Capability discovery](providers/capability-discovery.md) | Every vendor CLI will tell you for free which models an account can launch; none will tell you which is good. What the wire actually says, and why a guessed field name reads as "no" rather than erroring. | 2026-07-13 |
| [Launch mechanics](providers/launch-mechanics.md) | Per-CLI argv with sharp edges: which flag carries effort, which knob grants autonomy without raising a dialog nobody can answer, and how `-c` deep-merge really behaves. | 2026-07-13 |
| [Quota surfaces](providers/quota-surfaces.md) | All three vendors report the fraction of a rolling window consumed, for free; none reports the window's absolute size. Gauges, guards, and the difference between "not metered" and "no reading". | 2026-07-13 |
| [Grok](providers/grok.md) | Grok as a peer vendor: semantic-prefix permission rules, a sandbox that is not a write barrier, and the authorization gap no switch closes. | 2026-07-13 |

## graphify

The opt-in code knowledge graph, and how it is shipped.

| Article | Summary | Updated |
| --- | --- | --- |
| [Graphify integration](graphify/integration.md) | Graph context is a hint, never an authority, and no Hive operation may block on it. Everything else is a consequence of those two rules or a trap found enforcing them. | 2026-07-13 |
| [Graphify bundling](graphify/bundling.md) | Shipping graphify as a frozen self-contained bundle Hive builds, signs, and hash-verifies — no uv, no Python, no PyPI on a user's machine. | 2026-07-13 |

## daemon

The control plane: who may do what, and what happens when state is missing.

| Article | Summary | Updated |
| --- | --- | --- |
| [Authorization](daemon/authorization.md) | The daemon is the only boundary Hive has, and every agent runs as the same UID with a shell. The rights matrix, re-derived from the code, and why a request body is evidence of intent but never of authority. | 2026-07-13 |
| [Database resilience](daemon/database-resilience.md) | The SQLite file was never the fragile part — the fragile part was how Hive read a database that wasn't there. One invariant, applied everywhere: absence must refuse, preserve, and say so. | 2026-07-13 |
| [Orchestrator status](daemon/orchestrator-status.md) | The orchestrator has no agents row, so its status is derived from turn events — and an unpaired turn-end is a contradiction, while a long silence is merely unknown, never stuck. | 2026-07-13 |
| [Multiple concurrent instances](daemon/multi-instance.md) | Design, not yet built. HIVE_HOME is already the instance key and the isolation stops at the listener — but the fixed port is an accidental mutex, and the shared provider account is the one thing that must not be partitioned. | 2026-07-13 |

## workspace

The native macOS app, its visual language, and the platform underneath it.

| Article | Summary | Updated |
| --- | --- | --- |
| [Workspace blueprint](workspace/blueprint.md) | A shipping AppKit app whose panes are SwiftTerm terminals over daemon-owned tmux. Hive owns the window, layout, status, and project boundary; the vendors own the pixels inside the terminal. | 2026-07-13 |
| [UI design system](workspace/ui-design-system.md) | Semantic colors, native controls, honest states — plus the AppKit invariants that cost real time: overlay views never sublayers, and a truncating label at priority ≥500 resizes the window. | 2026-07-13 |
| [Platform constraints](workspace/platform-constraints.md) | macOS traps a native Workspace keeps rediscovering the expensive way: bookmarks resolve path-first and will name an impostor; an anonymous XPC endpoint authenticates nothing. | 2026-07-13 |

## agents

What a spawned agent carries, remembers, and when it should be replaced.

| Article | Summary | Updated |
| --- | --- | --- |
| [Context and recycling](agents/context-and-recycling.md) | Hive recycled agents at 65% of the window because "quality dies at ~140K." Both numbers were fabricated, and the percentage was the wrong *unit* — a 1M-window model degrades earlier in absolute tokens than a 200K one. | 2026-07-13 |
| [Agent memory](agents/memory.md) | Every mature vendor ships two memory tracks — a committed instruction file and an agent-authored store — and conflating them is the classic mistake. The sourced provenance behind SPEC decision 5. | 2026-07-13 |
| [Briefing](agents/briefing.md) | How Hive discovers a repo's shape instead of hardcoding it, and why the primary-doc ranker counts inbound *links* rather than mentions — a scoring choice with fleet-wide blast radius. | 2026-07-13 |

## release

How a version comes into existence and reaches a machine.

| Article | Summary | Updated |
| --- | --- | --- |
| [Versioning and release](release/versioning-and-release.md) | One push to `main` publishes exactly one release, one patch above the last; nobody types a version number and no commit contains one. Enforced by `src/release/contract.test.ts`. | 2026-07-13 |
| [Update experience](release/update-experience.md) | At most one dim line at the end of a command — never a popup, never an interruption — and an update that always does the safe half and tells the truth about the rest. | 2026-07-13 |
| [Distribution](release/distribution.md) | Why not npm, Homebrew, or Sparkle — and what the shipped installer honestly does not verify yet. | 2026-07-13 |
