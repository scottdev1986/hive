# Hive Workspace blueprint

## The product we are building

Hive should feel like a purpose-built, Hyprland-inspired workspace for supervising a team of coding agents, not like a script that happens to arrange Terminal.app windows. A user changes into a project, runs `hive start`, and gets one owned workspace where an orchestrator is the stable center of gravity, workers appear as satellites, attention is visible without stealing focus, and every action stays inside the selected project.

The important correction from the original design is that an agent pane is not a terminal. Hive owns the composer and receives structured provider events, so the useful surface is a native transcript: messages, tool calls, diffs, approvals, failures, and state transitions that AppKit can make searchable and accessible. A terminal emulator remains necessary for a user shell and for legacy provider TUIs, but it is no longer the product foundation.

This document is the canonical destination architecture. [SPEC.md](../../SPEC.md) describes the shipping Bun/tmux/Terminal.app system and the control-plane lessons that remain valuable during migration. The [cross-vendor review](../../research/cross-vendor-architecture-review.md) preserves the experiments and corrections behind this blueprint. The de-risking prototypes below run as individually scoped assignments — the Workspace UI foundation and native-transcript prototype lives in [`workspace/`](../../workspace/README.md), driven by a mock event source and deliberately unconnected to the daemon. The Phase 0 authentication repair described below is landed, and its route-by-route contract is the [capability rights matrix](capability-rights-matrix.md); daemon-connected flagship work is no longer gated on it, but still needs its own scoped assignment.

The status words in this document are deliberate:

- **Decision** means the restart may treat the choice as settled unless new evidence invalidates it.
- **Verified defect** means the current repository or a driven provider binary demonstrated the failure.
- **Prototype hypothesis** means the direction is preferred but cannot become a shipping promise until its named experiment passes.
- **Open question** means no decision has been made.
- **Superseded** records an alternative that once looked right and why it lost.

## Product principles

**Decision — Hive owns the experience.** The flagship is a signed Swift/AppKit application, not improved AppleScript around somebody else's terminal. Owning the windows removes Terminal.app's mutable tab/window identity, Automation timing, Accessibility permission, and stale AppleScript handle failures. It also gives Hive native focus, animation, restoration, VoiceOver, IME, selection, links, and search.

**Decision — Hyprland inspires behavior; the visual language is macOS HIG.** The tiling model — a stable master, satellite workers, attention that never steals focus — comes from Hyprland, but the surface is standard AppKit: system materials and vibrancy, system fonts and SF Symbols, semantic colors that follow light/dark mode and the user's accent, native window chrome, menus, and control sizing, with Reduce Motion, Reduce Transparency, and accessibility settings honored. A custom-skinned tiling-WM aesthetic was rejected because it would spend the platform behavior that owning the windows was chosen to gain — appearance adaptation, accessibility, familiarity — to buy only novelty.

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

Transcript panes use native AppKit text and collection views so VoiceOver, IME, copy/paste, links, find, selection, drag-and-drop, and inline diffs begin from platform behavior. The [`workspace/` prototype](../../workspace/docs/prototype-hypothesis-2-evidence.md) drove streaming partial messages, 5,000-line tool output, ANSI content, missing provider fields, approvals, and inline diffs from a mock structured source through an `NSTextView` transcript, and the hypothesis survived: find, selection, links, IME, and VoiceOver come from the platform rather than reimplementation; huge output collapses behind an explicit control instead of flooding scrollback; approvals stay actionable in place instead of scrolling away as a keystroke race. The terminal-renderer decision is not reopened, though it would be by a human comprehension comparison that the transcript loses, a failed screen-reader and IME conformance audit, or bad transcript behavior at soak scale — none of which have been run.

Shell and legacy TUI panes use SwiftTerm behind a small internal interface. SwiftTerm won because it is the only evaluated full AppKit terminal stack; its accessibility depth and selection behavior still require a conformance test. `libghostty` is deferred until its full embedding surface is tagged and stable. Alacritty, `libghostty-vt`, and WezTerm's terminal crates are parser/core layers, not substitute AppKit surfaces.

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

Step 1 leans on `realpath(2)`, which resolves symlinks and firmlinks and, on volumes that fold case or Unicode normalization, rewrites each component to its on-disk spelling. That is measured behavior, not an Apple guarantee, so the resolver still detects the volume's case behavior and folds the identity key itself. Folding is gated on that detection because a fold can only merge two keys, and merging two genuinely distinct directories into one Hive is worse than minting two Hives for one directory. Step 3 must query bareness before asking for a top level, because `--show-toplevel` makes the whole `rev-parse` fail inside a bare repository; it must pass `--path-format=absolute`, because `--git-common-dir` is otherwise reported relative to the invocation directory and silently mis-keys the repository family; and it must strip `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, and `GIT_CEILING_DIRECTORIES` from the environment, because any of them redirects discovery to a repository the user did not name.

`HiveUUID` is an opaque random value minted once at registration and stored. Deriving it from the canonical path was rejected: a path-derived identity makes a deleted and recreated directory inherit the old Hive, and makes a legitimate move look like a brand-new project. The path is a lookup key, never the identity.

The Supervisor stores a plain Foundation bookmark, the last confirmed canonical path, and supporting filesystem evidence. A plain bookmark resolves path-first, with file-ID lookup only as a fallback. Driving real `NSURL` bookmarks shows one follows a rename only while the old path stays vacant; the moment any unrelated directory reoccupies that path, the bookmark abandons the moved project and resolves to the impostor instead, even though the real directory still exists. Deciding moves by comparing the bookmark's resolved path against the confirmed path and entering `NEEDS_REBIND` on disagreement is therefore rejected. It loses because in exactly the dangerous case the two paths *agree*: the bookmark names the impostor, the impostor stands at the confirmed path, the comparison passes, and the resolver attaches the wrong directory. Deleting the evidence check from the prototype reproduces that failure, and a recreated path inherits its predecessor's Hive.

Filesystem evidence is what refuses. File resource identifiers and inode/device pairs are not persistent, non-reusable identities and may never be treated as such, but that caution understates their use. The asymmetry is the point: matching evidence is necessary and not sufficient to prove identity, while differing evidence is dispositive proof of non-identity. So the resolver compares `dev`, `ino`, and `birthtimeMs` before it consults the bookmark, and uses evidence only ever to refuse, never to attach. A rename preserves all three, so a moved project is located by evidence and offered a rebind that preserves its `HiveUUID`; a cross-volume move copies rather than renames, produces a new inode, and is correctly treated as a new project. Foundation's `isStale` flag is a trigger to re-verify, never a verdict — an ordinary move sets it and so does an impostor. A deleted and recreated path never inherits an old Hive: the registry tombstones the path binding, leaves the evicted Hive in `NEEDS_REBIND` rather than deleting it, and requires an explicit create or rebind.

The [identity-under-motion prototype](../../prototypes/project-identity/) implements this resolver and settles the identity-under-motion hypothesis. It exercises rename, move, delete and recreate, the move-then-impostor case, symlink aliases, nested paths, nested repositories, submodules, linked worktrees, separate clones, bare repositories, `Use Parent`, a forged in-repository ownership file, and case-sensitive and case-insensitive APFS volumes mounted from disk images. Each decisive refusal is confirmed by deleting it and watching the corresponding scenario fail. Its registry is in-process, so the twenty-concurrent-start rule below is exercised against a unique constraint and an idempotency lease, but not against cross-process leasing. Network volumes remain untested.

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

Authentication and authorization are separate. XPC listeners apply a public code-signing requirement (`NSXPCListener.setConnectionCodeSigningRequirement` or the public C `xpc_listener_set_peer_code_signing_requirement`); an anonymous endpoint by itself is only a bearer address. The endpoint then supplies a connection-bound capability whose methods omit tenant IDs, preventing a confused deputy.

Agent processes cannot receive a broad bearer token in their environment. The broker exposes only an inherited, close-on-exec stdio proxy or similarly narrow channel. Every capability has an explicit subject/action allowlist and expiry. An ordinary agent may send messages, read its own inbox, and acknowledge its own controls. A writer receives a short-lived, one-shot right to land only its own branch at the current epoch. It cannot spawn, approve, kill another agent, or read the global inbox. The orchestrator may spawn and approve but holds no write or landing capability. Revocation advances the epoch and invalidates stale rights. The one-shot landing right is reserved at authorization and burned only on a successful merge; a fast-forward merge that loses a concurrent race releases the right so the writer can rebase and retry, rather than stranding it on a failure that was not its fault. This capability model and its audit vocabulary are shared with the Phase 0 HTTP control plane, which cannot omit the tenant ID and so must instead reject and audit any request whose named subject does not match the caller's bound subject.

Per-tenant Unix sockets prevent accidents and cross-project confusion but do not stop a malicious same-UID process. The capability and peer check are the boundary. Capability descriptors are `CLOEXEC`, and descendants do not inherit reusable credentials.

The [authenticated-XPC prototype](../../prototypes/authenticated-xpc/) proves this section with runnable evidence and settles the authenticated-IPC hypothesis. Three peer binaries — byte-identical before signing — establish that the signing requirement, not the address, is what authenticates: a validly signed but untrusted client that holds a real endpoint is still rejected before the connection delegate runs, while the same endpoint served without a requirement admits it. On Apple Silicon a fully unsigned binary is killed by the kernel at `exec` before it reaches XPC, so "unsigned" is refused at two independent layers. The confused deputy is not merely asserted but reproduced against a deliberately vulnerable subject-taking method, then shown to be structurally impossible once the wire methods omit the subject. A broker→agent→grandchild process tree proves the `CLOEXEC` descriptor is unreadable (EBADF) in a hostile grandchild while a non-`CLOEXEC` control descriptor remains readable, so the test observes a real leak when nothing stops one.

## Phase 0: verified current defects

**Repaired defect — unauthenticated control plane.** The daemon bound `127.0.0.1:4483` and dispatched `/mcp` without authentication, exposing `hive_land`, `hive_kill`, `hive_approve`, and `hive_spawn` to any local process; `/event`, `/channel/*`, `/viewer`, `/recover`, and `/orchestrator-terminal` were equally open. A harness against a stub daemon confirmed it: a caller presenting no credential spawned an agent, landed a branch it did not own, marked a foreign agent dead, and cleared the orchestrator terminal. Capability epochs could not protect a boundary that callers bypassed.

Every mutation route now authenticates a bearer capability before it parses a request body, and authorizes the action against a least-privilege subject/action allowlist. The binding contract is the [capability rights matrix](capability-rights-matrix.md). An agent acts only on itself, because the subject named in a request body is compared against the subject bound into the capability and never used to widen it — the confused-deputy fix that XPC gets for free by omitting tenant IDs. A writer holds one reserved right to land its own branch at the current epoch; the orchestrator spawns and approves but can never merge. Revocation advances the agent's epoch, so `hive_send --priority critical` is already a credential revocation, and killing an agent revokes its credential outright. Every decision that mutates is audited with the caller, the subject it reached for, and why it lost. `/health` and `/handshake` stay public, prove liveness and identity respectively, and authorize nothing. Mock-driven prototypes such as the [`workspace/` UI foundation](../../workspace/README.md) touch no control plane and were never gated on this.

Tokens reach agents through `0600` files in a `0700` directory outside every worktree, read with `CLOEXEC` descriptors. Claude Code fetches its header through a connect-time `headersHelper`; Codex, which has no such hook, receives a static header in a `0600` config. Neither an environment variable nor argv ever carries a secret, because both are inherited or world-readable. What this buys is not secrecy against a same-UID attacker — nothing at this layer provides that — but that a stolen writer credential cannot spawn, approve, kill, name another agent, land twice, or outlive an epoch rotation. Its blast radius is the authority the thief's parent already had.

Adversarial tests hold the boundary: an unauthenticated process, a foreign agent, a forbidden role, a revoked epoch, an expired token, a replayed one-shot grant, and a descendant process all fail, while the orchestrator and self-scoped writer workflows keep working. The residual risk is explicit and accepted: a same-UID process that knows the credential path can read the file. Closing that needs a real privilege boundary — a separate UID, a sandbox profile, or the signed-XPC peer check the Supervisor will bring — and is not a defect in Phase 0. Moving to a Unix socket remains routing hygiene, not part of the fix.

**Verified defect — stale and cross-project daemon reuse.** `ensureStarted()` accepts any shared-port health response with `ok === true`, ignoring the version already returned. The daemon captures its startup `process.cwd()` as `repoRoot`. Project B can therefore adopt project A's daemon, and a detached daemon may continue executing pre-fix code after a source update. This is the leading explanation for the Terminal PID failure recurring after commit `5a50e0c` landed.

The replacement handshake includes product version, content-addressed build hash, wire protocol range, schema/migration epoch, capability tokens, `HiveUUID`, and broker generation. A peer with the same marketing version but the wrong build or project identity is rejected visibly. Supervisor upgrades checkpoint brokers, preserve AgentHosts, and restart compatible generations. Health proves liveness only; it never authorizes reuse. The distribution and activation implications are detailed in [distribution research](../../research/distribution-auto-update.md) and [update experience](../../research/update-experience.md).

## AgentHost journal and crash semantics

Broker commands carry `commandId`, `brokerGeneration`, and `sessionEpoch`. AgentHost journals `ACCEPTED` before writing to the provider, then journals provider semantic events with a monotonic sequence, stable provider event identity, and high-water mark. Boundaries, approvals, tool starts and results, and terminal outcomes are durable. The prompt itself and raw environment are not WAL data. Reconnect reports child identity, executable binding hash, vendor session ID, last accepted command, last event sequence, and in-flight phase before replaying from the broker's high-water mark. Repeated command, approval, and provider event identities return known state rather than touching provider stdin twice.

If the broker dies, AgentHost keeps draining provider output into a bounded write-ahead log, never auto-approves, and permits the current turn to finish. A new broker authenticates and replays. If AgentHost or provider dies, a new host uses the native vendor session ID where supported. A command that was accepted or written but lacks a durable terminal outcome becomes `UNKNOWN_OUTCOME`. Hive never resends the prompt or approval automatically. It queries provider thread/turn state where the protocol allows; otherwise it says the action may have completed and requires explicit reconciliation. Worktree and Git state separately reconcile tool mutations.

Providers without durable resume are `DEGRADED_RECOVERY` and cannot claim crash-safe orchestrator eligibility. Broker upgrades are transparent. AgentHost upgrades drain at a semantic turn boundary and resume into a new pinned host; security upgrades may terminate into `UNKNOWN_OUTCOME` rather than risk duplication.

The host WAL is bounded, follows transcript retention, excludes prompts, raw environment, and secrets, and is encrypted at rest where the threat model requires it. Compaction may remove only events at or below the broker's durable high-water mark. If unacknowledged semantic boundaries fill the bound, AgentHost terminates the provider and reports durable overflow rather than discarding events or deadlocking the provider.

The [crash-matrix prototype](../../prototypes/agenthost-crash-matrix/) makes the host half of this contract concrete. Its 48 deterministic process-level rows kill separate UI, broker, host, and provider processes at every named boundary for Claude- and Codex-shaped sessions. Four stop at `UNKNOWN_OUTCOME`; the other forty-four either replay known state or use the fixture's vendor-session resume, with the exact split allowed to depend on whether a final already reached the surviving host pipe. None executes a prompt, approval, or tool twice, reports false completion, adopts another tenant, or leaves its provider process group alive. A replacement host verifies the pinned child identity before killing a surviving group, and stable provider event IDs deduplicate semantic state repeated by resume. The strict result after `ACCEPTED` but before a vendor session exists is intentionally `UNKNOWN_OUTCOME`, even when the last durable host phase says no write completed: absence of a write receipt is not proof that bytes never crossed the pipe.

The same prototype drove installed Claude Code 2.1.206 and Codex CLI 0.144.0 through one real denied-tool task each. Both runs put `ACCEPTED` before provider write, captured the vendor session ID, journaled monotonic semantic events and one approval decision, observed the requested terminal text, and reaped the owned process group. This proves that both live protocols can feed the journal shape; it does not turn fixture resume into vendor crash evidence. Release gate 10 still requires live host/provider `SIGKILL` rows against each pinned binding generation. Treating deterministic fault injection as proof of an undocumented vendor persistence contract was the tempting shortcut and lost because it would erase the exact uncertainty `UNKNOWN_OUTCOME` exists to preserve.

## Providers, models, and executable identity

First launch runs setup before starting an orchestrator. It discovers candidates from the invoking shell's `PATH`, known package-manager and user application locations, and an explicit file picker. It does not scan the whole disk. Every probe comes from a signed/built-in `ProviderDefinition`, closes stdin, uses a clean bounded environment, has a timeout and output cap, and is documented as non-billable. Guessing commands is forbidden: Claude treats unknown subcommands such as `claude models` as a prompt and may charge for them.

Discovery creates an immutable `InstallationBinding`: binding UUID, provider, absolute real path, filesystem identity evidence, SHA-256 and signing identity, platform and architecture, provider version/build, discovery source, probe schema, and capability revision. `PATH` is discovery only. A digest, signature, architecture, version, or probe-schema change creates a new generation even when the path is unchanged. Running sessions remain pinned; new sessions wait for conformance. Self-updating CLIs require launch-time identity revalidation so probe-to-exec replacement cannot retarget a binding.

Setup keeps independent observations for installed identity, authentication, provider reachability, catalog membership, provider-reported selectability, and launch validation. Each carries provenance and age. Unknown is never rendered as yes. Credential files are not inspected. No probe sends a prompt or spends credits without explicit user action.

Claude Code 2.1.206 and Codex CLI 0.144.0 are **ring-1, version-gated orchestrators for their exact tested binding generations**, not timeless provider guarantees. Their hashed executables passed the same eighteen common [provider-conformance facts](../../prototypes/provider-conformance/): lifecycle, approve, deny, needs-user, steer, cancel with receipt, native resume, invalid-model validation, and read-only enforcement. Codex also passed a declared provider-specific dual-client gate. The fixture records documentation, observation, and billability separately, and every new digest, version, or probe schema must pass every applicable fact before selection.

Claude's stream-json `initialize` reports account-scoped models before a model call, and `system/init` reports capability tokens. The public CLI reference documents `--permission-prompt-tool`; the low-level `stdio` target that produces stdout `control_request`/`can_use_tool` frames is still absent from that reference. The approval path has two observed transports that the adapter must preserve: the AgentHost prototype registered a real per-session MCP relay and received a correlated request there, while the canonical conformance run drove low-level stdio. An arbitrary sentinel fails rather than creating either channel. The earlier idea that the flag alone defines one stable wire shape therefore lost; AgentHost version-gates the provider and merges the transport that the binding exposes into one semantic journal. Reconnect reports pending permission requests.

Codex app-server exposes rich thread, turn, approval, account, and rate-limit methods, but its initialize lacks a numeric protocol version and the surface is experimental. Its needs-user path exposed a sharper trap: an ordinary default turn answered the fixture's question itself even though `item/tool/requestUserInput` existed in the schema. Only an experimental plan collaboration turn surfaced the correlated request. The fixture asserts the request, not merely the expected final text, and generates the binding's experimental schema before launch. Read-only enforcement is also narrower than the event catalog suggests: this generation reported `readOnly` and prevented the marker write but logged the rejected patch on stderr without a rejected `fileChange` item. Hive may trust the structured policy plus its own side-effect check; it may not promise a per-tool denial event for this generation.

The same Codex app-server can own a durable thread while its interactive TUI attaches over WebSocket and a second JSON-RPC client resumes the ID. A live proof on thread `019f4c5e-0834-7931-93b6-d8d0ecdb583c` returned a correlated `turn/steer` receipt, accepted model-visible history through `thread/inject_items`, and rendered the history-dependent verification response `HIVE_INJECT_SEEN` in the attached TUI without disturbing its composer. The proof used three tiny, no-tool billable turns. The tiny steer turn completed before the correction changed its answer, so the proof does not erase timing: the fixture uses a deliberate active turn for future steer drives and retains injection plus verification as the cross-client semantic check. Native transcript remains the flagship pane, but structured control and an attached provider TUI are no longer treated as mutually exclusive.

A ring-1 orchestrator must prove structured lifecycle; prompt, steer, and cancel with receipt; approval request/response; needs-user state; durable session ID and resume; concrete model pin plus reported effective model; cwd, policy, and instruction injection; Hive control delivery; bounded queues; read-only denial; and every provider-specific capability Hive selects it for. A worker may omit interactive approvals or resume but must accept a scoped task, cwd, policy, and model; emit lifecycle and liveness; report the effective model; and stop deterministically.

Model state is `catalogued`, `providerReportedSelectable`, then `launchValidated`. Claude can report the middle state without a model call, but the account-scoped catalog is reported evidence, not authoritative entitlement. Both tested bindings accepted a bogus concrete pin when creating the session and rejected it on the first validation turn without substitution. Claude reported exactly zero cost. Codex emitted an unsupported-model 400 and no token-usage update, but app-server supplied no currency receipt or zero-cost contract, so its validation billability remains unknown. A new provider session therefore enters `VALIDATING` and accepts only the adapter's declared sentinel until the outcome lands. Zero-cost validation is asserted only where the adapter proves it. Hive never passes Claude's `--fallback-model`, and no adapter silently substitutes another model.

The exact Claude procedures and wider provider matrix live in the [cross-vendor review](../../research/cross-vendor-architecture-review.md). Model choice, escalation, token budgets, and routing telemetry belong to the companion [model-routing and token-efficiency policy](../research/model-routing-and-token-efficiency.md); this blueprint owns provider identity and conformance and does not duplicate that policy.

## Settings and onboarding

Security is an intersection; preferences have precedence. The order is signed managed-policy ceiling, explicit launch preference, tenant-local user override, trusted repository safe config, global user defaults, then built-ins. A lower layer cannot widen a managed restriction.

Global settings select default orchestrator provider, immutable installation binding, concrete model, worker routes, landing policy, and UI/accessibility preferences. Tenant-local settings select project overrides, runner tier, binding generations, Git integration, and restoration. A shareable `.hive/project.toml` may request provider/model policies, worker route candidates, and landing-branch preference. It may not specify executable paths, binding IDs, auth sources, secrets, endpoints, environment injection, hooks, MCP servers, permission expansion, or security-tier elevation. Invalid privileged keys are ignored with an actionable provenance report.

Setup displays Installed, Authenticated, Reachable, Catalogued, Reported Selectable, and Launch Validated independently. The user chooses the default orchestrator CLI and model only from conformant bindings, then optionally chooses worker routes. Each new project previews the resolved root and kind, inherited settings and provenance, landing branch, execution tier, and any safe repository override before registration.

The project switcher lists sanitized cards: display name, last active time, provider/model, aggregate agent states, and setup/recovery warnings. It never shares another project's transcript surface. Repeated agent names are valid because identity is `(HiveUUID, AgentUUID)`.

## Migration from the current Hive

Migration is transactional, versioned, backed up, resumable, and rollbackable. The Supervisor detects the default `~/.hive` once and imports `config.toml`, `routing.toml`, `quota.toml`, and `hive.db` only after the user confirms the resolved project. A custom `HIVE_HOME` requires an explicit import path. Hive never mutates two homes or silently merges them. After migration, `HIVE_HOME` is an import hint, not tenant routing.

Safe global values become global defaults; project/session/worktree records become one tenant. Terminal, headless, and layout settings are legacy compatibility, not flagship architecture. Old `hive claude` and `hive codex` become deprecated `hive start` launch preferences that still pass conformance. Model aliases resolve to concrete IDs with an alias-policy revision; unresolved aliases stop for user input.

Live tmux sessions cannot move between tmux servers. The broker records a compatibility locator and drains them without interruption; all new semantic agents use AgentHost, while tmux remains for the old TUI session until it ends. New shell panes use the tenant's tmux namespace. Worktrees and branches are never deleted as a migration side effect.

## Release safety gates and quality targets

The flagship does not pass its safety gate until all twelve statements are falsifiably true:

1. Nested paths and symlinks resolve to one Hive; user linked worktrees and separate clones resolve to distinct Hives; bare repositories are refused.
2. Moved projects require confirmed rebind, and deleted/recreated paths never inherit automatically.
3. Twenty concurrent starts produce one UUID, broker, orchestrator, and attachment.
4. Identically named agents in two projects never cross-route; stop in A cannot signal B.
5. Same marketing version with a different build hash or project identity is rejected.
6. No unauthenticated local process reaches a mutation. Capabilities enforce their exact subject/action/epoch, and descendants inherit no credential.
7. A hostile unsigned XPC peer fails even when it knows an endpoint.
8. Every ring-1 binding generation passes the common provider facts and its declared provider-specific gates with evidence provenance.
9. Invalid model pins fail before a real task, with no fallback or substitution and an honest validation-cost claim.
10. UI and broker loss preserve execution through AgentHost; host/provider loss yields replay, native resume, or explicit `UNKNOWN_OUTCOME`, never duplicate work.
11. Setup keeps identity, auth, reachability, catalog, reported selectability, and validation distinct; probes do not spend credits.
12. Interrupted migration rolls back to a working prior state.

Performance and polish remain release targets rather than safety gates: warm `hive start` to focused UI p95 under 400 ms; cold broker/UI under two seconds excluding provider startup; recovery under two seconds when AgentHost survives; bounded logs and no identity loss in a 50-pane eight-hour soak; idle CPU under two percent on the reference machine; Reduce Motion honored; transcript VoiceOver parity with native text; and no PTY resize storms in shell panes.

## Superseded proposals

Terminal.app/iTerm2 AppleScript window management is containment for the current CLI, not the flagship. AX helpers could improve separate windows but retain mutable external identity and permission/race failure modes.

A terminal emulator for every agent lost when driven Claude and Codex protocols proved that Hive can own a semantic composer and transcript. A three-way SwiftTerm/libghostty/Alacritty bake-off compared different layers and overinvested in the least differentiated surface. Full `libghostty` remains interesting only after a stable, tagged embedding API.

Tmux as universal agent identity and survival substrate lost because survival must not depend on a TUI. Codex proves that a provider TUI and structured clients can project the same app-server thread, which strengthens the separation rather than restoring tmux as truth. AgentHost preserves provider pipes; tmux remains valuable for shells and legacy compatibility.

One UI process per tenant lost because it complicates Dock, menu, settings, and restoration while native agents already execute as the same user. Real isolation belongs to a VM or remote runner. The restricted-native T1 tier was removed because supported macOS APIs cannot apply a tighter custom sandbox to arbitrary child toolchains; deprecated `sandbox_init` is not a product boundary.

Security-scoped bookmarks in a nonsandboxed Supervisor lost to plain bookmarks. Treating a plain bookmark as the authority on where a project moved lost to filesystem evidence, once driving one showed that bookmark resolution is path-first and will name an impostor. Private named pasteboards lost as a security claim, though OSC 52 mediation remains useful accident containment.

## Open questions

- Can the transcript prototype satisfy users who want to watch raw agent behavior, including interactive subprocesses that expect a TTY? The related unrun checks are a human comprehension comparison against a terminal, a screen-reader and IME conformance audit, and transcript behavior at soak scale.
- How much transcript and AgentHost WAL should be retained, and which threat model requires encryption at rest?
- Which post-write host/provider crash rows can Claude and Codex recover from live vendor state, and which must remain explicit `UNKNOWN_OUTCOME`?
- Does one host per session create material process pressure, or is consolidation an unnecessary failure-domain expansion?
- How should remote viewing replace tmux's incidental SSH/reattach convenience before the remote-runner tier exists?
- Which exact fields may the sanitized overview and quota arbiter retain, and what privacy threat model governs them?
- What is the supported behavior on network volumes? The resolver refuses on filesystem-evidence divergence, which presumes `dev`, `ino`, and `birthtimeMs` change when a directory is replaced. An SMB client synthesizes inode numbers and a server may reissue them across remounts; if it does, evidence can both miss a real move and match an unrelated directory. The settling experiment is to export a case-sensitive and a case-insensitive share from a known server, run the identity scenarios against both, and remount between steps to see whether the evidence survives. Until it runs, a network volume should resolve to `BLOCKED_CONFIG` rather than trust evidence it cannot.
- Will Anthropic document and stabilize the low-level `stdio` control target beneath the documented `--permission-prompt-tool` flag, or must Hive retain legacy TUI indefinitely?
- When the independent routing/cost policy lands, which choices belong in global defaults versus managed policy?

## Primary evidence

- [Cross-vendor driven review and Claude repro procedures](../../research/cross-vendor-architecture-review.md)
- [Workspace UI foundation prototype](../../workspace/README.md) and [native-transcript evidence](../../workspace/docs/prototype-hypothesis-2-evidence.md)
- [Identity-under-motion prototype](../../prototypes/project-identity/) and its [measured evidence log](../../prototypes/project-identity/EVIDENCE.md)
- [AgentHost crash matrix and live provider evidence](../../prototypes/agenthost-crash-matrix/)
- [Provider-conformance fixture and canonical Claude/Codex evidence](../../prototypes/provider-conformance/)
- [Git repository and worktree discovery](https://git-scm.com/docs/git-rev-parse.html), [linked worktree behavior](https://git-scm.com/docs/git-worktree.html)
- [Apple bookmark access](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox), [XPC peer identity and signing requirements](https://developer.apple.com/documentation/xpc/xpc-connections), [NSXPCConnection](https://developer.apple.com/documentation/foundation/nsxpcconnection)
- [Authenticated-XPC prototype](../../prototypes/authenticated-xpc/) — runnable evidence for the authenticated-IPC hypothesis
- [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config), [Claude hooks](https://code.claude.com/docs/en/hooks)
- [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm), [Ghostty embedding status](https://github.com/ghostty-org/ghostty)
- [Agent Client Protocol](https://agentclientprotocol.com/protocol/overview)
- [Model routing and token efficiency](../research/model-routing-and-token-efficiency.md)
- [Hive distribution and update research](../../research/distribution-auto-update.md), [update UX research](../../research/update-experience.md)
