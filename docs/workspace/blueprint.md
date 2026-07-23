# Workspace Blueprint

Updated: 2026-07-14
Source: Hive source tree, 2026-07-14

## Summary

The Workspace is a shipping signed Swift/AppKit app (`workspace/`) whose panes are SwiftTerm terminals attached to daemon-owned tmux sessions running the vendors' own TUIs; Hive owns the window, the layout, status, attention, and the project boundary, and owns none of the conversation. This article records the reasoning the code cannot state — what was rejected, what reversed, and why.

## What is settled

**Hive owns the experience.** The flagship is a signed AppKit application, not AppleScript around Terminal.app. Owning windows buys native focus, animation, restoration, VoiceOver, IME, selection, and links, and removes Terminal.app's mutable tab identity, Automation timing, and Accessibility-permission failure modes.

**Hyprland inspires behavior; the visual language is macOS HIG.** The tiling model — stable master, satellite workers, attention that never steals focus — is Hyprland's. The surface is standard AppKit. A custom-skinned tiling-WM aesthetic was rejected because it would spend the platform behavior that owning the windows was chosen to gain (appearance adaptation, accessibility, familiarity) to buy only novelty. See [ui-design-system.md](ui-design-system.md).

**Structured events are truth.** Codex app-server, Claude stream-json control and hooks, and conformant future adapters drive lifecycle and attention. Screen scraping is never authoritative. Panes render bytes; agent state never depends on terminal contents.

**Authority fails closed.** Hive never guesses an executable, silently substitutes a model, replays a turn with an unknown outcome, accepts a peer because `/health` answered, or treats an anonymous endpoint as identity. Ambiguity is a visible state requiring reconciliation.

**Survival and presentation are separate.** An unexpected UI crash cannot stop an agent: agents live in daemon-owned tmux sessions, and relaunching the Workspace reattaches to them. Deliberate close actions are different. Closing an agent pane asks the daemon to kill that agent through `hive kill`; if verified teardown fails, the pane returns with the reason. Closing the Workspace runs `hive stop`, which stops the instance's team and daemon. This preserves the *viewers-not-containers* rule ([SPEC.md](../../SPEC.md) §9) without making an explicit close button a no-op. Typing in a pane is typing into the vendor's real composer, so "send the agent a message" is not a feature Hive implements — it is the TUI working (`workspace/Sources/HiveWorkspace/ProjectWindowController.swift:125-181`, `workspace/Sources/HiveWorkspace/AppDelegate.swift:309-350`).

**Incoming Hive traffic never owns a human draft.** Workspace creates `$HIVE_HOME/runtime/composers/<recipient>.typing` synchronously before the first editing keystroke or paste reaches a root or agent PTY. The daemon rechecks that lease inside the recipient's serialized delivery lane before every tmux, native Codex, urgent, steer, critical, or root transport action. A submission keeps the lease through a short grace period; Escape, Control-C, and Control-U cancel it after the cancellation reaches the TUI. A generation counter prevents the prior submit timer from clearing a newly started draft. While leased, messages remain durable and queued—even a critical control revokes authority immediately but defers process interruption until the human input has left the composer (`workspace/Sources/HiveWorkspace/ComposerLeaseStore.swift`, `workspace/Sources/HiveWorkspace/TerminalPaneView.swift`, `src/daemon/composer-lease.ts`, `src/daemon/delivery.ts`).

The authority split (Supervisor / Tenant Broker / AgentHost / provider / UI) is fixed. Supervisor owns the registry, immutable executable bindings, build negotiation, and repo-family landing leases; the Tenant Broker owns project policy and semantic truth; AgentHost owns provider pipes plus a bounded replay WAL *for driven headless sessions only*; the provider owns its native session; the UI owns presentation. **Broker death must not sever pipes.** **Host/provider ambiguity becomes `UNKNOWN_OUTCOME`, never an automatic replay.** **Health is never authorization** — `/health` and `/handshake` are public and prove liveness and identity respectively; they authorize nothing.

## Entry points

Bare `hive` is the graphical front door: it resolves and prepares the repository, selects a fresh runtime instance, starts that instance's daemon, and opens a new Workspace process (`src/cli.ts` → `runWorkspace()` → `startSession()`). It never focuses or reuses an existing Workspace; two invocations from the same Git worktree produce distinct instance homes, ports, databases, tmux namespaces, and windows. The project root is the git toplevel of the invocation directory, resolved by the same probe the identity resolver uses, so CLI and daemon can never disagree about the root. Outside a git worktree the app launches with no project and shows a new placeholder window — the project-neutral home a Dock click gets (`workspace/Sources/HiveWorkspace/LaunchConfig.swift`, `workspace/Sources/HiveWorkspace/AppDelegate.swift`). A fully standalone launcher whose cwd was deliberately irrelevant was tried and rejected: it left no path that could ever open a project window, with the app telling you to run `hive init` and `hive init` telling you to run `hive`.

`hive claude`, `hive codex`, and `hive grok` **also create fresh instances and open new Workspaces**, with queen as a read-only orchestrator on the named vendor. They are not a plain-terminal escape hatch — no such mode exists. Grok is a first-class vendor alongside Claude and Codex (`--orchestrator claude|codex|grok` selects the vendor; the root is still named queen; `workspace/Sources/HiveWorkspace/LaunchConfig.swift`). `hive init` is the headless, repo-only onboarding boundary: skills, optional memory, and the required Graphify graph. It starts no daemon and opens no window.

**There is no fixture mode and no headless acceptance mode.** The mock UI was deleted in commit 2b4c1c3 ("Replace mock Workspace with live tmux terminals"). The internal `--smoke` flag is a component diagnostic against real panes (`workspace/Sources/HiveWorkspace/LaunchConfig.swift:10-58`); it does not open the product experience and therefore cannot satisfy release acceptance. Pre-release acceptance launches the installed app through public `hive claude`, `hive codex`, and `hive grok` commands and drives the visible vendor TUIs. Any document claiming the `workspace/` UI is a mock-driven prototype that "touches no control plane" is describing a build that no longer exists: the app speaks to the daemon.

## The feed contract

The feed is a terminal-free, long-lived `hive workspace-feed` subprocess printing NDJSON snapshots. It reads the daemon through the operator credential and carries the agent records, writer-autonomy dial, and queen (orchestrator) status to the app; it neither registers a viewer nor changes daemon behavior (`src/cli/workspace-feed.ts:1-26`, `:132-200`). Agent panes exist only in the Workspace, attached to instance-owned tmux sessions.

The feed retries daemon errors internally for 30 seconds with bounded backoff. If the process exits, the app marks every pane disconnected while keeping the terminals attached, then restarts the feed with delays from 1 to 15 seconds and a budget of five attempts. A successful snapshot resets the budget (`workspace/Sources/WorkspaceCore/ProjectState.swift:243-264`, `workspace/Sources/HiveWorkspace/AppDelegate.swift:138-189`).

Exhausting the restart budget closes the app's owned terminal surfaces and terminates that Workspace instance (`workspace/Sources/HiveWorkspace/AppDelegate.swift:191-203`). There is no daemon-side presence lease, external Terminal.app fallback, or hidden viewer window. Losing the metadata feed can make status unknown; it never moves the live agent sessions or invents another presentation surface.

## Panes, master, focus

The first pane is queen's terminal (the orchestrator) and begins as the master. The master ratio is clamped to the 0.55–0.60 band, default 0.58, gap 8 pt (workspace/Sources/WorkspaceCore/LayoutTree.swift:90-92); layout is deterministic for the same ordered pane tree and geometry. Creation, completion, and background attention **never steal keyboard focus**. A click focuses a pane but does not promote it; double-clicking the header or invoking Promote atomically swaps it with the master, and queen is restorable without rebuilding satellite order.

Mouse and keyboard actions share **one command model** so accessibility actions, menu items, shortcuts, and clicks cannot disagree (`ProjectWindowController.dispatch` is the single entry).

Layout transitions animate from presentation geometry for ~180 ms and are interruptible (`LayoutTransition.duration = 0.18`, workspace/Sources/WorkspaceCore/LayoutTransition.swift:9). Terminal cell geometry is committed once at the end; this avoids resize storms and TUI flicker. Reduce Motion turns transitions instant. **Animation never changes semantic state or clears attention.**

Status color and focus are separate signals, and a focus ring never overwrites a status border (workspace/Sources/WorkspaceCore/Status.swift). `PaneStatus.unknown` exists explicitly (workspace/Sources/WorkspaceCore/Status.swift:16) so an unrecognized feed word can never be silently upgraded to a healthy state. The attention queue is ordered by severity and time, not pane position; focus alone does not approve, dismiss, or clear a waiting state, and layout changes acknowledge nothing.

## Scrolling: the rule, the incident, and the second reversal

Attached tmux panes let tmux route wheel gestures. When the program inside requests mouse reporting, tmux forwards the gesture and the program owns its viewport — this is how an alt-screen TUI scrolls content that has no tmux history. Otherwise tmux enters copy-mode over its retained scrollback.

Intercepting every pane's wheel in the app and forcing copy-mode was **rejected**: an alt-screen TUI then opens an empty `[0/0]` copy-mode history instead of scrolling its own content. A second, Hive-owned transcript buffer was also rejected — two histories with ambiguous resize and restoration semantics. The accepted cost is that each mouse-aware TUI defines its own scroll behavior and retention.

queen's pane used to be the exception: Hive **suppressed** its terminal mouse reporting, because macOS tap-to-click had committed an unintended selection in a Claude Code multiple-choice prompt. **That exception is now gone, and the reasoning behind its removal matters more than the exception did.**

Two things changed. tmux mouse mode became global (`set-option -g mouse on`) for every session on the socket, including the root orchestrator's, so the original constraint — queen's session bypassed the adapter and had no mouse mode — no longer held. And the *real* cause of the phantom click was found: SwiftTerm 1.11.2 misencodes no-button SGR motion as a button **release** (`ESC[<32;x;ym`), so merely hovering committed the row under the pointer. Suppressing mouse reporting had been treating the symptom by disabling the whole input channel.

Today **both pane kinds forward mouse reporting** (`terminalAllowsMouseReporting` returns `true` for both — workspace/Sources/WorkspaceCore/TerminalScroll.swift:23-25), and the malformed packet is dropped at the PTY boundary instead (`isMalformedNoButtonMotion`, workspace/Sources/WorkspaceCore/TerminalScroll.swift:29-37, applied in workspace/Sources/HiveWorkspace/TerminalPaneView.swift:8-16). Clicks, drags, and wheels pass through byte-for-byte. The comment states the invariant: **hover highlighting is optional; committing is not.** The tmux copy-mode coalescing machinery survives for panes that suppress reporting, though none currently do — do not delete it as dead code without re-deriving why it existed.

The durable lesson: a UI symptom traced to a *vendor library encoding bug* was, for weeks, mistaken for a *policy* question about whether terminals should see the mouse.

## Project identity: evidence may only refuse

`HiveUUID` is an opaque random value minted once at registration. Deriving it from the canonical path was rejected: a path-derived identity makes a deleted-and-recreated directory inherit the old Hive, and makes a legitimate move look like a new project. **The path is a lookup key, never the identity.**

**Bookmark resolution is path-first and will name an impostor.** Driving real `NSURL` bookmarks shows one follows a rename only while the old path stays vacant; the moment any unrelated directory reoccupies that path, the bookmark abandons the moved project and resolves to the impostor. So deciding moves by comparing a bookmark's resolved path against the last confirmed path is *rejected* — in exactly the dangerous case the two paths **agree**, the comparison passes, and the resolver attaches the wrong directory. Foundation's `isStale` is a trigger to re-verify, never a verdict.

**Filesystem evidence is what refuses.** `ino` and `birthtimeMs` are not persistent identities and may never be treated as such — but the asymmetry is the whole point: *matching* evidence is necessary and not sufficient, while either value differing is dispositive proof of non-identity. `st_dev` is only a process-local mount hint because macOS may renumber a mount across reboot; a change in it alone proves nothing. The resolver therefore compares durable evidence **before** it consults the bookmark, and uses evidence **only ever to refuse, never to attach**. A rename preserves inode and birth time, so a moved project is located and offered a rebind that preserves its UUID; a cross-volume move copies, gets a new inode, and is correctly a new project. A deleted-and-recreated path never inherits an old Hive: the registry tombstones the binding and requires an explicit create or rebind.

## Superseded: the Hive-owned semantic transcript

This is the most important rejected alternative, because **it passed its prototype and lost anyway.** An `NSTextView` transcript survived streaming partial messages, 5,000-line tool output, ANSI content, approvals, and inline diffs, with find, selection, links, IME, and VoiceOver inherited from the platform.

It lost on product grounds after the first field test of a shipped release. Rendering the conversation ourselves means re-implementing, and forever chasing, three vendors' full interactive products before anything real can ship — and the only thing a release could show in the meantime was a scripted mock, which is exactly what shipped, and it read as "nothing works" within minutes of real use. The native TUIs are already the experience users know, and structured events already carry every state signal Hive needs. What the transcript bought — semantic search, collapsible output, approvals answered in place — is given up inside the pane; the attention queue and queen (the orchestrator) carry approvals instead.

The decision would be reopened by a SwiftTerm accessibility-conformance failure or by vendor TUIs becoming un-embeddable — **not** by the transcript evidence, which was never the problem. Evidence that a thing *works* is not evidence that it should *ship*.

Two corollaries: tmux as *truth* lost and stays lost (capture-pane scraping is never authoritative). The earlier decisions to keep tmux as the *survival substrate* and defer libghostty are superseded by [ADR 0001](../adr/0001-native-terminal-foundation.md) and [terminal-stack-transition.html](../design/terminal-stack-transition.html) §§01/§05: pinned libghostty behind the bounded Hive bridge is binding, while tmux/SwiftTerm remain the admission fallback only if TG1 or TG2 fails. Alacritty, `libghostty-vt`, and WezTerm's crates are parser/core layers, not AppKit surfaces.

## Release safety gates

The flagship does not pass its safety gate until **all thirteen** statements are falsifiably true. (The prior blueprint's prose said "twelve" while listing thirteen — gate 13 was added by 2b4c1c3 and the count was never updated.) Enumerated in the archived blueprint; the load-bearing additions are:

- **Gate 10.** UI and broker loss preserve execution — tmux for interactive agents, AgentHost for driven sessions; host/provider loss yields replay, native resume, or explicit `UNKNOWN_OUTCOME`, never duplicate work.
- **Gate 13.** No release bundle contains a fixture-driven surface. Component smoke checks may run earlier, but release acceptance must drive the installed *visible Workspace*—real daemon, real tmux sessions, real panes, and separate text/submit keystrokes. **A mock reaching a user as the product, or a headless check being reported as GUI acceptance, is a release-blocking defect.**

Performance and polish are targets, not gates: warm launch to attached project p95 < 400 ms, idle CPU < 2%, no identity loss in a 50-pane eight-hour soak, Reduce Motion honored.

## See Also

- [UI Design System](ui-design-system.md) — tokens, components, and the AppKit invariants the app is built on
- [SPEC.md](../../SPEC.md) — the shipping Bun/tmux system; authoritative for the current substrate and the viewers-not-containers rule
- [Orchestrator status](../daemon/orchestrator-status.md) — the status the app's panes render
- [Model Control Center](../routing/model-control-center.md) — the Settings surface and the design system's reference implementation
