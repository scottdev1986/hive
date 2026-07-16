# Agentic-hierarchy groundwork for the terminal transition

## Scope and reading

This note extracts terminal, session, and workspace substrate requirements from `docs/design/agentic-hierarchy.html`. It uses only the terminal spike's product invariants and prototype-scope item 2 as the starting seam: one hidden Zellij session and one vendor TUI pane per agent, addressed through a platform-neutral `SessionHost` whose locator already includes tenant/Hive home, agent, generation, and host address.

The hierarchy is intentionally bounded, not recursively arbitrary: engineer → queen → leads → workers, with reviewers attached to worker-to-lead gates. The example has three leads; the operating rule caps each crew at 3–5 workers. The substrate should therefore treat roughly 13–19 concurrently visible long-lived roles (queen + 3 leads + 9–15 workers), plus transient reviewers and scouts, as an ordinary workspace rather than designing only for the spike's four panes.

## Groundwork requirements

### 1. Make identity hierarchical while keeping sessions one-agent-per-host-session

**Design demand.** Leads spawn, monitor, and close their own workers; workers branch from a particular lead; reviewers are attached to a particular worker→lead gate. A flat agent name cannot distinguish the same convenient leaf name under two leads, express ownership, or safely target a recreated agent. A flat tmux-style session namespace is insufficient even though Zellij itself should remain one session per agent.

**Provide now.** Make `SessionLocator` an opaque, serializable structured value with at least:

- tenant/Hive-home identity and session-host endpoint;
- immutable run or hierarchy identity;
- role (`queen`, `lead`, `worker`, `reviewer`, `scout`);
- stable agent ID, parent agent ID, and generation/incarnation;
- optional task/gate association, while keeping mutable display names out of identity.

Support equality, persistence, validation, and resolution after UI restart. Zellij session names should be a collision-safe encoding or lookup key derived from immutable IDs, not a slash-delimited display path. APIs and storage must never require parsing the Zellij name to recover ancestry.

### 2. Add parent/child discovery and scoped enumeration to `SessionHost`

**Design demand.** Queen supervises leads, each lead supervises only its crew, workers speak only to their lead, and the human retains final authority. `list(): SessionInspection[]` is too flat and forces every client to reconstruct or over-fetch the hierarchy.

**Provide now.** Preserve basic `list`, but define query/subscription primitives that can select direct children, descendants, ancestors, role, run, owner, state, and generation. Inspections should return locator, parent locator, role, provider/vendor, lifecycle state, timestamps, attention state, and root-process identity. Access scopes should permit the engineer to inspect all terminals, the queen to inspect/drill into leads and descendants, a lead to inspect its own crew, and a worker no lateral terminal access. Reviewer/scout visibility should be explicitly tied to their task rather than treated as an unowned flat session.

### 3. Model the workspace as a tree with level-preserving navigation

**Design demand.** The hierarchy has meaningful crews, not merely more panes. Leads monitor their workers while the queen monitors leads; the engineer needs high-level status with on-demand detail. Showing 13–19+ terminals in one master/stack makes ownership illegible.

**Provide now.** Make the Electron layout model a tree of groups keyed by structured locators. It must support:

- a queen/lead overview, lead crew groups, and transient reviewer/scout membership;
- expand/collapse and drill-down/drill-up without destroying terminal sessions or PTY attachments;
- focus history per group and restoration to the prior pane when returning a level;
- promote, swap, fullscreen, directional focus, and attention within the current group, plus explicit navigation across group boundaries;
- stable layout/focus identity across agent restart generations and UI restart;
- virtualization or attachment suspension for off-screen terminals while sessions continue running.

Do not bake hierarchy into Zellij layouts. Hive remains the window manager, and each agent remains an independent Zellij session.

### 4. Separate keyboard focus, viewed scope, and operational authority

**Design demand.** The engineer may stop or redirect through the queen; the queen routes and escalates; leads task and control workers. Monitoring a descendant must not imply permission to type into it, and output or status must never steal focus.

**Provide now.** Represent at least three independent concepts: the visibly focused terminal, the selected hierarchy/group context, and the authenticated actor allowed to perform an action. Focus changes must be explicit human navigation only. Attention from any level should roll up as badges/counters on collapsed ancestors without focusing or auto-expanding them. A lead viewing a worker must not accidentally inherit the worker's input channel, and queen overview actions must not silently target whichever descendant last had focus.

### 5. Route automated messages by immutable sender/recipient identity and enforce topology

**Design demand.** Allowed channels are engineer↔queen, queen↔leads, lead↔its workers, and narrowly scoped lead↔lead interface negotiation; escalations move worker→lead→queen→engineer. There are no worker→worker or worker→queen side channels. Periodic and on-demand status envelopes coexist with tasking, review, lifecycle, stop, and redirect controls.

**Provide now.** The automation API should accept an envelope, not just `(locator, bytes)`: message ID, sender locator/authority, recipient locator and generation, channel/purpose, hierarchy/run ID, ordering key, priority/control intent, and correlation/reply ID. Authorize the edge against the hierarchy before bytes reach the PTY. Reject stale-generation and forbidden lateral targets; never resolve by display name alone. Keep durable artifact references in envelopes and inject only the intended concise notification/task content—the design makes artifacts, not transcripts, the coordination unit.

### 6. Keep one input arbiter per terminal, coordinated by a hierarchy-aware router

**Design demand.** More senders become eligible to contact a pane (human, parent lead, status/control machinery), but the terminal invariant remains single-writer with human priority and no focus stealing. Lead tasking or lifecycle commands must not interleave with a human draft or another automation transaction.

**Provide now.** Retain a per-session ordered arbiter as the only byte path, with a router ahead of it that performs topology authorization and preserves message identity. Queue automation per target session and generation, expose queue depth/oldest age to ancestor rollups, and define cancellation/supersession for control intents without bypassing human ownership. Ordering must be deterministic at least per target and sender; a bounded automated transaction remains atomic. Persist enough ownership and queued-message metadata to recover safely after renderer/main-process restart without logging prompt content.

### 7. Encode ownership and lifecycle policy instead of applying a global idle reap

**Design demand.** Leads own crew lifecycle and explicitly close workers promptly after merge. Leads are exempt from the current roughly ten-minute non-root auto-reap. Close-out deletes ephemeral branches only after work moves upward; dead workers require lead liveness monitoring.

**Provide now.** Extend create/inspect/terminate around an explicit owner locator and lifecycle policy. Required states/events include creating, live, attention/blocked, terminating, terminated, orphaned, and failed, with reason and timestamps. `terminate` should be idempotent, generation-checked, return verified process-tree cleanup, and emit an event the owner can observe. Support owner-scoped close of a crew, but require deliberate cascade semantics—terminating a lead must not implicitly kill children unless the caller explicitly requests and is shown the descendant set. Preserve sessions across UI/attach crashes, distinguish viewer detachment from agent termination, and surface orphaned workers for queen/human recovery rather than auto-reaping them blindly.

### 8. Make session events and snapshots first-class observability inputs

**Design demand.** Leads perform regular on-task and liveness checks; queen receives periodic/on-demand status; the engineer can request updates; attention, blockers, review gates, and escalations must roll upward. Costs and outcome metrics must be attributable separately to queen, leads, workers, author models, and reviewers.

**Provide now.** Add a session event stream/subscription rather than relying on polling `capture()`. Events should cover created/attached/detached, process exit/liveness change, output/attention, input-ownership transition, automation queued/started/completed/cancelled, focus/view changes, and termination. Every event needs locator, parent, role, generation, hierarchy/run, monotonic sequence, and timestamps. `inspect` should provide a consistent snapshot/cursor so reconnect can resume without gaps. Keep screen capture available for diagnosis, but do not make transcript scraping the status protocol. Emit metadata suitable for rollups (queue latency, uptime, resource use, provider/model attribution) without prompt or terminal-content logging.

### 9. Design capacity and backpressure for full crews, not four-pane demos

**Design demand.** Three example leads at the prescribed 3–5 workers imply 9–15 workers, 3 leads, and a queen before reviewers/scouts; mandatory per-worker review can add bursts of sessions. Multi-agent operation is expected to cost roughly 15× chat, so runaway crews and invisible queues are product risks.

**Provide now.** Set conformance/load targets for at least 19 durable agent sessions plus transient reviewer/scout headroom, with all sessions producing output and queued automation. Session creation and attachment should have bounded concurrency, backpressure, cancellation, and per-owner/run quotas. The workspace should attach/render only what is needed while `SessionHost.inspect`, liveness, events, and termination continue for off-screen sessions. Capacity errors must identify the requesting owner and requested child so the hierarchy can report upward rather than failing as an anonymous global limit.

### 10. Preserve hierarchy state independently of terminal processes

**Design demand.** Specs, shared task lists, interface contracts, summaries, branch/gate state, and durable lessons live on disk; terminal transcripts are explicitly not the coordination record. UI and viewer crashes must not lose running agents.

**Provide now.** Keep the hierarchy graph, display metadata, layout tree, permissions, message ledger, and lifecycle ownership in Hive-owned durable state keyed by structured locators. `SessionHost` should manage terminal process reality and expose stable identity/events, but it must not become the sole database for task or organizational state. On restart, reconcile durable hierarchy records with `SessionHost.list/inspect`, mark missing or extra generations explicitly, rebuild rollups/layout, and reattach without inventing ancestry from process names.

## Required evolution of the spike seam

The minimal seam remains a useful lowest-level contract, but production should reserve these shapes now so hierarchy does not cause another migration:

```ts
interface SessionHost {
  create(spec: SessionSpec): Promise<SessionLocator>;
  attach(locator: SessionLocator, size: TerminalSize): Promise<AttachHandle>;
  writeAutomated(locator: SessionLocator, envelope: AutomatedInputEnvelope): Promise<void>;
  capture(locator: SessionLocator): Promise<string>;
  inspect(locator: SessionLocator): Promise<SessionInspection>;
  terminate(locator: SessionLocator, request: TerminationRequest): Promise<TerminationResult>;
  list(query?: SessionQuery): Promise<SessionInspection[]>;
  subscribe(query: SessionQuery, cursor?: EventCursor): AsyncIterable<SessionEvent>;
}
```

`SessionSpec`, `SessionInspection`, and all events should carry the same opaque structured locator and explicit parent/owner/role metadata. Hierarchy policy belongs above the host, but the host must preserve and return the identity and generation fields needed to enforce that policy without parsing names or screen content.

## Transition acceptance checks influenced by the hierarchy

1. Create two leads with identically named workers and prove locators, routing, inspection, and teardown never collide.
2. Restore a queen/three-lead/five-workers-each workspace after UI restart with group layout, focus history, ownership latches, and ancestor attention rollups intact.
3. Prove a lead can inspect and message its own worker but cannot target a sibling crew; prove stale-generation delivery is rejected.
4. Queue simultaneous human input and parent automation at several hierarchy levels and prove every byte reaches only the visibly focused/explicitly addressed terminal in deterministic order.
5. Detach most terminals while 19+ sessions remain live; verify liveness/events/termination and bounded renderer/PTY resource growth.
6. Terminate a worker, a crew, and a lead-with-live-children; verify explicit cascade rules, process-tree cleanup, lifecycle events, and orphan recovery.
7. Restart the UI/control attachment and reconcile durable hierarchy state with running sessions without reconstructing identity from Zellij names or terminal transcripts.
