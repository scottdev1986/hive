# Hive Workspace blueprint

## The product we are building

Hive should feel like a purpose-built, Hyprland-inspired workspace for supervising a team of coding agents, not like a script that happens to arrange Terminal.app windows. A user changes into a project, runs `hive start`, and gets one owned workspace where an orchestrator is the stable center of gravity, workers appear as satellites, attention is visible without stealing focus, and every action stays inside the selected project.

The important correction from the original design is that an agent pane is not a terminal. Hive owns the composer and receives structured provider events, so the useful surface is a native transcript: messages, tool calls, diffs, approvals, failures, and state transitions that AppKit can make searchable and accessible. A terminal emulator remains necessary for a user shell and for legacy provider TUIs, but it is no longer the product foundation.

This document is the canonical destination architecture. [SPEC.md](../../SPEC.md) describes the shipping Bun/tmux/Terminal.app system and the control-plane lessons that remain valuable during migration. The [cross-vendor review](../../research/cross-vendor-architecture-review.md) preserves the experiments and corrections behind this blueprint. No flagship implementation is authorized before the planned restart. The first proposed implementation afterward is the Phase 0 authentication repair described below.

The status words in this document are deliberate:

- **Decision** means the restart may treat the choice as settled unless new evidence invalidates it.
- **Verified defect** means the current repository or a driven provider binary demonstrated the failure.
- **Prototype hypothesis** means the direction is preferred but cannot become a shipping promise until its named experiment passes.
- **Open question** means no decision has been made.
- **Superseded** records an alternative that once looked right and why it lost.

## Product principles

**Decision — Hive owns the experience.** The flagship is a signed Swift/AppKit application, not improved AppleScript around somebody else's terminal. Owning the windows removes Terminal.app's mutable tab/window identity, Automation timing, Accessibility permission, and stale AppleScript handle failures. It also gives Hive native focus, animation, restoration, VoiceOver, IME, selection, links, and search.

**Decision — project ownership is the safety boundary.** Multiple Hives may run concurrently, but each has an immutable `HiveUUID`, one canonical project root, its own broker, state, worktrees, approvals, epochs, and execution sessions. A request derives its tenant from an authenticated connection; no payload may select another tenant. Native execution is logical isolation, not a claim that same-user code is jailed. Strong containment belongs to a per-Hive VM or a remote runner.

**Decision — structured events are truth.** Codex app-server, Claude stream-json control, and future conformant provider protocols drive lifecycle and attention. Screen scraping is never authoritative. Shell panes still render bytes, but agent state does not depend on terminal contents.

**Decision — authority fails closed.** Hive never guesses an executable, silently substitutes a model, replays a turn with an unknown outcome, accepts a peer because `/health` answered, or treats an anonymous endpoint as identity. Ambiguity is a visible state that requires reconciliation.

**Decision — process survival and presentation are separate.** Closing or crashing the UI cannot stop an agent. Broker upgrades cannot sever provider pipes. A provider crash cannot be reported as completion. These are independent responsibilities with independent recovery tests.

## The Workspace experience

One AppKit process multiplexes projects as hard in-process tenant objects. Each project normally owns one workspace window and one independent layout tree. This choice keeps a single Dock tile, menu owner, `UserDefaults` suite, and native restoration container. The earlier process-per-project proposal was superseded because macOS instances of one bundle still share those resources while providing no meaningful hostile-code boundary.

### Panes, master, focus, and promotion

The first pane is the orchestrator transcript and begins as the master, occupying about 55–60 percent of the usable area. Worker transcripts and shell panes fill a balanced satellite tree. New panes take the least disruptive split that preserves the master ratio; closing a pane collapses only its parent split. Layout is deterministic for the same ordered pane tree and screen geometry.

Creation, completion, and background attention never steal keyboard focus. A click focuses a pane but does not promote it. Spatial arrow shortcuts move focus to the nearest pane in that direction; project and orchestrator shortcuts work regardless of tree shape. Double-clicking a pane header or invoking the Promote command atomically swaps that pane with the current master. The orchestrator remains the default master, and Return Orchestrator to Master restores it without rebuilding the satellite order. Dragging a header changes the split tree only after a visible drop target is chosen; cross-project dragging is not allowed.

Mouse and keyboard actions share one command model so accessibility actions, menu items, shortcuts, and clicks cannot disagree. The key window owns routing. A project switcher shows sanitized cards and activates a project before routing to a selected pane.

### Motion and terminal resizing

Layout transitions animate compositor layers from their presentation geometry for roughly 180 ms and are interruptible. Terminal cell geometry is committed once at the end; interactive splitter drags may throttle PTY resize to at most 30 Hz. This avoids resize storms and TUI flicker. Reduce Motion turns transitions into immediate or cross-fade changes. Animation never changes semantic state or clears attention.

### State and attention

Status color and focus are separate signals. A focus ring never overwrites the status border.

- **Running:** blue border, quiet and steady.
- **Waiting on user or approval:** amber pulse for a short bounded burst, then steady amber until the request is answered or explicitly acknowledged.
- **Completed:** green border until acknowledged, then a subdued completed treatment.
- **Failed:** red border and persistent failure badge until the failure is opened or resolved.
- **Disconnected or recovering:** gray dashed border with the last confirmed state and recovery reason.

An attention queue is ordered by severity and time, not pane position. Selecting an item activates its project and pane. Focus alone does not approve, dismiss, or clear a waiting state. Layout changes do not acknowledge anything.

### Displays, Spaces, full screen, and restoration

The application persists each project's normalized split tree, selected pane, master, window frame, and display fingerprint. AppKit chooses the user's current Space; Hive does not promise placement by private Space identifiers. Missing displays consolidate their subtrees onto the primary available window, and a returning display offers to restore the saved arrangement. Native full screen applies per project window. Stage Manager and Space reassignment must degrade to a valid single-window layout rather than fight the system.

Transcript panes use native AppKit text and collection views so VoiceOver, IME, copy/paste, links, find, selection, drag-and-drop, and inline diffs begin from platform behavior. Shell and legacy TUI panes use SwiftTerm behind a small internal interface. SwiftTerm won because it is the only evaluated full AppKit terminal stack; its accessibility depth and selection behavior still require a conformance test. `libghostty` is deferred until its full embedding surface is tagged and stable. Alacritty, `libghostty-vt`, and WezTerm's terminal crates are parser/core layers, not substitute AppKit surfaces.

Named pasteboards and OSC 52 mediation may prevent accidents, but they are not tenant security: any same-user process can reach a named or general pasteboard. The UI must describe that honestly.

## `hive start` and immutable project identity

`hive start` is an idempotent request to resolve, create, attach, and focus a project. The thin signed CLI sends a directory locator and idempotency key to the Supervisor. The Supervisor resolves identity before it returns a tenant endpoint.

The resolver follows this order:

1. Canonicalize the existing invocation directory using physical path and the volume's case behavior.
2. Check authenticated Hive-managed-worktree ownership in the Supervisor/broker ledger. A managed worker worktree routes to its owning Hive and pane. A repository file cannot assert this ownership.
3. Otherwise discover the nearest Git worktree with `git rev-parse --show-toplevel`, record `--git-dir` and `--git-common-dir`, and reject a bare repository without a worktree.
4. Use the canonical physical worktree root as the project boundary. Nested paths and symlink aliases reuse it. A nested repository or submodule is its own nearest project. “Use Parent” is an ephemeral override only before the child has been registered; afterward it is disallowed.
5. A user-created linked Git worktree gets a distinct `HiveUUID` because it is a distinct writable project, even though linked worktrees share `git-common-dir`. Separate clones are also distinct.
6. A plain directory uses its exact canonical root. If a registered plain ancestor exists, setup asks whether to attach to it or deliberately create a nested project. Plain directories do not get parallel Git writer semantics.

The Supervisor stores a plain Foundation bookmark plus the last confirmed canonical path and supporting filesystem evidence. Bookmarks follow moves silently, so every resolution compares the resolved path with the confirmed path and enters `NEEDS_REBIND` on disagreement. File resource identifiers and inode/device pairs are evidence only; they are not persistent, non-reusable identities. A deleted and recreated path never inherits an old Hive automatically. The registry tombstones the old identity and requires explicit create or rebind.

`resolveOrCreate(ProjectKey, idempotencyKey)` runs under a unique registry constraint and creation lease. Twenty simultaneous starts for the same root must yield one `HiveUUID`, broker, orchestrator, and UI attachment. Starting an already visible project focuses it; starting a headless project opens its view; starting a stopped project preserves its UUID and asks whether to resume the recorded orchestrator session or start fresh. Closing a window detaches presentation only. `hive stop` quiesces and stops exactly one tenant. `hive forget` is allowed only after stop and a dirty-work/worktree audit.

The durable project state is `ABSENT → REGISTERING → READY ↔ STOPPED`; `NEEDS_SETUP`, `NEEDS_REBIND`, and `BLOCKED_CONFIG` are recoverable states, and `FORGOTTEN` follows only the stopped safety audit. Runtime is derived from real processes: `RESOLVING → BROKER_STARTING → ORCHESTRATOR_STARTING|RESUMING → RUNNING_VISIBLE`, with `RUNNING_HEADLESS` after detach, `RECOVERING` after a broker/provider failure, and `QUIESCING → STOPPED` after stop. A stale UI generation fails closed and requests a new snapshot. A missing executable, expired authentication, rejected model, or invalid Git landing state blocks only the affected action and keeps the tenant, worktrees, and diagnostic state; it never creates a replacement Hive or falls back to another provider.

Linked worktrees share refs, so the Supervisor also holds a repo-family landing lease keyed by the real path of `git-common-dir`. The lease serializes rebase → retest → fast-forward merge; Git's `--ff-only` update remains the final compare-and-swap. A dedicated Git service would add machinery without strengthening that invariant.

## Process and authority model

The destination has four Hive-owned authorities and one provider-owned authority.

**Supervisor.** A signed per-user `SMAppService` agent owns the `ProjectKey ↔ HiveUUID` registry and creation leases, immutable executable bindings, repo-family landing leases, build negotiation, and sanitized global overview. A colocated quota arbiter sees only an allowlist: provider, account, pool, concrete model, estimated units, and HiveUUID. “Content-blind” means it never receives prompts, transcript events, repository names, paths, or branches; it does not mean it learns nothing.

**Tenant Broker.** One broker per `HiveUUID` owns canonical semantic state, the project event log, settings, worktree ownership, approvals, capability epochs, landing policy, and the UI snapshot. It never owns anonymous provider pipes.

**AgentHost.** One minimal, tenant-scoped host per live provider session owns the provider process group and its stdin/stdout/stderr. The Supervisor launches a signed host generation pinned to an immutable executable binding and fixed `HiveUUID` plus `SessionUUID`. Its authenticated reconnectable endpoint accepts no tenant ID. Consolidating hosts into a tenant runtime is deferred until measured process pressure justifies the larger failure domain.

**Workspace UI.** One signed AppKit process owns presentation and local layout journals. It sends intents, never mutates broker state optimistically, and reconnects from snapshot revision plus event high-water mark.

**Provider.** Claude Code, Codex, or a future adapter owns its native remote/local session. Hive records the vendor session ID and uses native resume where conformance proves it.

### Authenticated IPC and capabilities

Authentication and authorization are separate. XPC listeners apply a public code-signing requirement (`NSXPCConnection.setCodeSigningRequirement` or the public C XPC equivalent); an anonymous endpoint by itself is only a bearer address. The endpoint then supplies a connection-bound capability whose methods omit tenant IDs, preventing a confused deputy.

Agent processes cannot receive a broad bearer token in their environment. The broker exposes only an inherited, close-on-exec stdio proxy or similarly narrow channel. Every capability has an explicit subject/action allowlist and expiry. An ordinary agent may send messages, read its own inbox, and acknowledge its own controls. A writer receives a short-lived, one-shot right to land only its own branch at the current epoch. It cannot spawn, approve, kill another agent, or read the global inbox. The orchestrator may spawn and approve but holds no write or landing capability. Revocation advances the epoch and invalidates stale rights.

Per-tenant Unix sockets prevent accidents and cross-project confusion but do not stop a malicious same-UID process. The capability and peer check are the boundary. Capability descriptors are `CLOEXEC`, and adversarial tests must prove descendants do not inherit reusable credentials.

## Phase 0: verified current defects

**Verified defect — unauthenticated control plane.** The current daemon binds `127.0.0.1:4483`; `fetch()` dispatches `/mcp` without authentication; `handleMcp()` directly exposes tools including `hive_land`, `hive_kill`, `hive_approve`, and `hive_spawn`. The mutation routes `/event`, `/channel/*`, `/viewer`, `/recover`, and `/orchestrator-terminal` are also unauthenticated. Any local process, including a worktree-confined agent with loopback access, can attempt control operations outside its intended authority. Capability epochs cannot protect a boundary that callers can bypass.

The first proposed implementation task after restart is therefore Phase 0 authentication, before any flagship UI or migration work. It must authenticate every mutation endpoint, give each caller a least-privilege subject/action capability, prevent descendant credential inheritance, rotate on epoch/generation changes, audit decisions, and leave only a minimal non-authorizing health response public. Moving to a Unix socket is part of routing hygiene, not the complete fix.

Phase 0 is accepted only when an unauthenticated local client cannot mutate state; an agent can act only on itself and cannot name another tenant; a writer can consume one current-epoch right to land its own branch and nothing else; revoked and replayed grants fail; an unsigned XPC peer fails; and an agent grandchild has no reusable credential. This work is not authorized in the present documentation-only assignment.

**Verified defect — stale and cross-project daemon reuse.** `ensureStarted()` accepts any shared-port health response with `ok === true`, ignoring the version already returned. The daemon captures its startup `process.cwd()` as `repoRoot`. Project B can therefore adopt project A's daemon, and a detached daemon may continue executing pre-fix code after a source update. This is the leading explanation for the Terminal PID failure recurring after commit `5a50e0c` landed.

The replacement handshake includes product version, content-addressed build hash, wire protocol range, schema/migration epoch, capability tokens, `HiveUUID`, and broker generation. A peer with the same marketing version but the wrong build or project identity is rejected visibly. Supervisor upgrades checkpoint brokers, preserve AgentHosts, and restart compatible generations. Health proves liveness only; it never authorizes reuse. The distribution and activation implications are detailed in [distribution research](../../research/distribution-auto-update.md) and [update experience](../../research/update-experience.md).

## AgentHost journal and crash semantics

Broker commands carry `commandId`, `brokerGeneration`, and `sessionEpoch`. AgentHost journals `ACCEPTED` before writing to the provider, then journals provider semantic events with a monotonic sequence and high-water mark. Boundaries, approvals, tool starts and results, and terminal outcomes are durable. Reconnect reports child identity, executable binding hash, vendor session ID, last accepted command, last event sequence, and in-flight phase before replaying from the broker's high-water mark.

If the broker dies, AgentHost keeps draining provider output into a bounded write-ahead log, never auto-approves, and permits the current turn to finish. A new broker authenticates and replays. If AgentHost or provider dies, a new host uses the native vendor session ID where supported. A command that was accepted or written but lacks a durable terminal outcome becomes `UNKNOWN_OUTCOME`. Hive never resends the prompt or approval automatically. It queries provider thread/turn state where the protocol allows; otherwise it says the action may have completed and requires explicit reconciliation. Worktree and Git state separately reconcile tool mutations.

Providers without durable resume are `DEGRADED_RECOVERY` and cannot claim crash-safe orchestrator eligibility. Broker upgrades are transparent. AgentHost upgrades drain at a semantic turn boundary and resume into a new pinned host; security upgrades may terminate into `UNKNOWN_OUTCOME` rather than risk duplication.

The host WAL is bounded, follows transcript retention, excludes raw environment and secrets, and is encrypted at rest where the threat model requires it. Backpressure spills to the bound, then terminates and reports overflow rather than discarding semantic boundaries or deadlocking the provider.

## Providers, models, and executable identity

First launch runs setup before starting an orchestrator. It discovers candidates from the invoking shell's `PATH`, known package-manager and user application locations, and an explicit file picker. It does not scan the whole disk. Every probe comes from a signed/built-in `ProviderDefinition`, closes stdin, uses a clean bounded environment, has a timeout and output cap, and is documented as non-billable. Guessing commands is forbidden: Claude treats unknown subcommands such as `claude models` as a prompt and may charge for them.

Discovery creates an immutable `InstallationBinding`: binding UUID, provider, absolute real path, filesystem identity evidence, SHA-256 and signing identity, platform and architecture, provider version/build, discovery source, probe schema, and capability revision. `PATH` is discovery only. A digest, signature, architecture, version, or probe-schema change creates a new generation even when the path is unchanged. Running sessions remain pinned; new sessions wait for conformance. Self-updating CLIs require launch-time identity revalidation so probe-to-exec replacement cannot retarget a binding.

Setup keeps independent observations for installed identity, authentication, provider reachability, catalog membership, provider-reported selectability, and launch validation. Each carries provenance and age. Unknown is never rendered as yes. Credential files are not inspected. No probe sends a prompt or spends credits without explicit user action.

Claude Code 2.1.206 and Codex CLI 0.144.0 are **ring-1, version-gated orchestrator candidates**, not timeless provider guarantees. Claude's stream-json `initialize` was driven successfully: it reports account-scoped models and capability tokens before a model call; the undocumented `--permission-prompt-tool` produced correlated approval requests and accepted denials; reconnect reports pending permission requests. Codex app-server exposes rich thread, turn, approval, account, and rate-limit methods, but its initialize lacks a numeric protocol version and the surface is experimental. Every binding generation of both providers must pass one provider-neutral fixture before selection.

A ring-1 orchestrator must prove structured lifecycle; prompt, steer, and cancel with receipt; approval request/response; needs-user state; durable session ID and resume; concrete model pin plus reported effective model; cwd, policy, and instruction injection; Hive control delivery; bounded queues; and read-only denial. A worker may omit interactive approvals or resume but must accept a scoped task, cwd, policy, and model; emit lifecycle and liveness; report the effective model; and stop deterministically.

Model state is `catalogued`, `providerReportedSelectable`, then `launchValidated`. Claude can report the middle state without a model call, but the undocumented surface is reported evidence, not authoritative entitlement. An invalid Claude pin is accepted at initialize and fails on its first turn at zero observed cost. Therefore a new provider session enters `VALIDATING` and accepts no real task until its adapter's validation outcome. Zero-cost validation is asserted only for adapters that prove it. Hive never passes Claude's `--fallback-model`, and no adapter silently substitutes another model.

The exact Claude procedures and wider provider matrix live in the [cross-vendor review](../../research/cross-vendor-architecture-review.md). The independently assigned routing and token-efficiency policy document has not landed in this branch; when it lands, it should be linked here as the companion policy rather than duplicated.

## Settings and onboarding

Security is an intersection; preferences have precedence. The order is signed managed-policy ceiling, explicit launch preference, tenant-local user override, trusted repository safe config, global user defaults, then built-ins. A lower layer cannot widen a managed restriction.

Global settings select default orchestrator provider, immutable installation binding, concrete model, worker routes, landing policy, and UI/accessibility preferences. Tenant-local settings select project overrides, runner tier, binding generations, Git integration, and restoration. A shareable `.hive/project.toml` may request provider/model policies, worker route candidates, and landing-branch preference. It may not specify executable paths, binding IDs, auth sources, secrets, endpoints, environment injection, hooks, MCP servers, permission expansion, or security-tier elevation. Invalid privileged keys are ignored with an actionable provenance report.

Setup displays Installed, Authenticated, Reachable, Catalogued, Reported Selectable, and Launch Validated independently. The user chooses the default orchestrator CLI and model only from conformant bindings, then optionally chooses worker routes. Each new project previews the resolved root and kind, inherited settings and provenance, landing branch, execution tier, and any safe repository override before registration.

The project switcher lists sanitized cards: display name, last active time, provider/model, aggregate agent states, and setup/recovery warnings. It never shares another project's transcript surface. Repeated agent names are valid because identity is `(HiveUUID, AgentUUID)`.

## Migration from the current Hive

Migration is transactional, versioned, backed up, resumable, and rollbackable. The Supervisor detects the default `~/.hive` once and imports `config.toml`, `routing.toml`, `quota.toml`, and `hive.db` only after the user confirms the resolved project. A custom `HIVE_HOME` requires an explicit import path. Hive never mutates two homes or silently merges them. After migration, `HIVE_HOME` is an import hint, not tenant routing.

Safe global values become global defaults; project/session/worktree records become one tenant. Terminal, headless, and layout settings are legacy compatibility, not flagship architecture. Old `hive claude` and `hive codex` become deprecated `hive start` launch preferences that still pass conformance. Model aliases resolve to concrete IDs with an alias-policy revision; unresolved aliases stop for user input.

Live tmux sessions cannot move between tmux servers. The broker records a compatibility locator and drains them without interruption; all new semantic agents use AgentHost, while tmux remains for the old TUI session until it ends. New shell panes use the tenant's tmux namespace. Worktrees and branches are never deleted as a migration side effect.

## Prototype hypotheses

Five hypotheses can still overturn important parts of the plan:

1. **AgentHost crash matrix.** Drive Claude and Codex through a full task and independently kill UI, broker, host, and provider before accept, after accept/before write, after write/before first event, during tool/approval, after provider final/before WAL, and after WAL/before broker acknowledgement. The only legal outcomes are replayed known state, clean vendor resume, or explicit `UNKNOWN_OUTCOME`—never duplicate prompt/tool, false completion, cross-tenant adoption, or orphan.
2. **Native transcript pane.** Render real partial messages, huge tool output, ANSI data, missing provider fields, interactive subprocess requests, approvals, and diffs. It must beat a terminal on comprehension while meeting VoiceOver, IME, selection, links, and find expectations. Failure reopens the terminal-renderer decision.
3. **Authenticated IPC.** Prove public XPC signing requirements reject an unsigned hostile client, an anonymous endpoint alone does not authenticate, capabilities restrict subject/action, and descriptors do not reach descendants.
4. **Identity under motion.** Exercise rename, move, delete/recreate, symlink, nested repository, submodule, linked worktree, case-sensitive and insensitive volumes, and SMB. The registry must detect bookmark move-following and never merge a recreated path automatically.
5. **Provider conformance.** Run the same lifecycle, approve, deny, needs-user, steer, cancel, resume, invalid-model, and read-only fixture against every binding generation, recording whether each fact is documented, observed, and billable.

## Release safety gates and quality targets

The flagship does not pass its safety gate until all twelve statements are falsifiably true:

1. Nested paths and symlinks resolve to one Hive; user linked worktrees and separate clones resolve to distinct Hives; bare repositories are refused.
2. Moved projects require confirmed rebind, and deleted/recreated paths never inherit automatically.
3. Twenty concurrent starts produce one UUID, broker, orchestrator, and attachment.
4. Identically named agents in two projects never cross-route; stop in A cannot signal B.
5. Same marketing version with a different build hash or project identity is rejected.
6. No unauthenticated local process reaches a mutation. Capabilities enforce their exact subject/action/epoch, and descendants inherit no credential.
7. A hostile unsigned XPC peer fails even when it knows an endpoint.
8. Every ring-1 binding generation passes the common provider fixture with evidence provenance.
9. Invalid model pins fail before a real task, with no fallback or substitution and an honest validation-cost claim.
10. UI and broker loss preserve execution through AgentHost; host/provider loss yields replay, native resume, or explicit `UNKNOWN_OUTCOME`, never duplicate work.
11. Setup keeps identity, auth, reachability, catalog, reported selectability, and validation distinct; probes do not spend credits.
12. Interrupted migration rolls back to a working prior state.

Performance and polish remain release targets rather than safety gates: warm `hive start` to focused UI p95 under 400 ms; cold broker/UI under two seconds excluding provider startup; recovery under two seconds when AgentHost survives; bounded logs and no identity loss in a 50-pane eight-hour soak; idle CPU under two percent on the reference machine; Reduce Motion honored; transcript VoiceOver parity with native text; and no PTY resize storms in shell panes.

## Superseded proposals

Terminal.app/iTerm2 AppleScript window management is containment for the current CLI, not the flagship. AX helpers could improve separate windows but retain mutable external identity and permission/race failure modes.

A terminal emulator for every agent lost when driven Claude and Codex protocols proved that Hive can own a semantic composer and transcript. A three-way SwiftTerm/libghostty/Alacritty bake-off compared different layers and overinvested in the least differentiated surface. Full `libghostty` remains interesting only after a stable, tagged embedding API.

Tmux as universal agent identity and survival substrate lost because a headless structured provider is not a TUI. AgentHost now preserves provider pipes; tmux remains valuable for shells and legacy compatibility.

One UI process per tenant lost because it complicates Dock, menu, settings, and restoration while native agents already execute as the same user. Real isolation belongs to a VM or remote runner. The restricted-native T1 tier was removed because supported macOS APIs cannot apply a tighter custom sandbox to arbitrary child toolchains; deprecated `sandbox_init` is not a product boundary.

Security-scoped bookmarks in a nonsandboxed Supervisor lost to plain bookmarks. Private named pasteboards lost as a security claim, though OSC 52 mediation remains useful accident containment.

## Open questions

- Can the transcript prototype satisfy users who want to watch raw agent behavior, including interactive subprocesses that expect a TTY?
- How much transcript and AgentHost WAL should be retained, and which threat model requires encryption at rest?
- Does one host per session create material process pressure, or is consolidation an unnecessary failure-domain expansion?
- How should remote viewing replace tmux's incidental SSH/reattach convenience before the remote-runner tier exists?
- Which exact fields may the sanitized overview and quota arbiter retain, and what privacy threat model governs them?
- What is the supported behavior on network volumes whose bookmark and identity semantics are weaker than local APFS?
- Will Anthropic support the currently undocumented `--permission-prompt-tool` contract, or must Hive retain legacy TUI indefinitely?
- When the independent routing/cost policy lands, which choices belong in global defaults versus managed policy?

## Primary evidence

- [Cross-vendor driven review and Claude repro procedures](../../research/cross-vendor-architecture-review.md)
- [Git repository and worktree discovery](https://git-scm.com/docs/git-rev-parse.html), [linked worktree behavior](https://git-scm.com/docs/git-worktree.html)
- [Apple bookmark access](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox), [XPC peer identity and signing requirements](https://developer.apple.com/documentation/xpc/xpc-connections), [NSXPCConnection](https://developer.apple.com/documentation/foundation/nsxpcconnection)
- [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config), [Claude hooks](https://code.claude.com/docs/en/hooks)
- [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm), [Ghostty embedding status](https://github.com/ghostty-org/ghostty)
- [Agent Client Protocol](https://agentclientprotocol.com/protocol/overview)
- [Hive distribution and update research](../../research/distribution-auto-update.md), [update UX research](../../research/update-experience.md)
