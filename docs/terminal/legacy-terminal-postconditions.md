# tmux and SwiftTerm postcondition inventory

- Updated: 2026-07-16
- Phase: T0, documentation only
- Proof registry: [conformance-test-ids.json](conformance-test-ids.json)

## Scope and interpretation

This is the T0 exit inventory: every observable guarantee Hive currently receives from tmux or SwiftTerm has a named owner in the §04 target architecture and a stable proof ID. “Postcondition” means state Hive depends on after an operation, not merely that a command or API returned success.

The survey covers production TypeScript direct calls through `TmuxAdapter`, the direct orchestrator tmux command builder, the shipped Workspace tmux subprocesses, every SwiftTerm symbol use under `workspace/Sources`, and the real-substrate Workspace smoke caller. Unit-test fakes and prose-only mentions do not create additional runtime postconditions. Line references identify the surveyed baseline; proof IDs, not line numbers, are stable.

Owners use the component names from terminal-stack-transition §04:

- **Hive daemon** owns lifecycle intent, authorization, structured status, message ledger, and attention.
- **sessiond service** owns broker discovery/leases/adoption and each host's process generation, PTY, ordered I/O, output/checkpoint state, clients, and resource limits.
- **HiveTerminalKit** owns the native surface, render/input/focus/selection/search/accessibility contract and attach state.
- **SessionHost** owns the renderer-neutral create/attach/write/resize/snapshot/inspect/terminate interface and its conformance contract.
- **Provider adapters** own provider launch, readiness, receipts, context/model, and explicit status integration.

## Direct tmux caller census

| Caller | Current operations | Postconditions represented below |
| --- | --- | --- |
| `src/adapters/tmux.ts:83–329` | The sole TypeScript tmux subprocess runner and adapter: `has-session`, `new-session`, options/history, buffered paste, interrupt keys, capture, clients, pane PIDs, kill, list | All `TST.TERM.LEGACY.TMUX.*` adapter rows |
| `src/daemon/delivery.ts:197–205` | Sends normal and interrupting control text through the adapter | `LITERAL_INPUT`, `INTERRUPT_INPUT` |
| `src/daemon/spawner-impl.ts:1059,1111,1213–1240,2089,2206–2207` | Creates/replaces provider sessions; readiness capture; pane-root/resource discovery | `SESSION_CREATE`, `LAUNCH_FAILURE_EVIDENCE`, `SESSION_DISCOVERY`, `CAPTURE_VISIBLE`, `PROCESS_ROOT_DISCOVERY` |
| `src/daemon/recovery.ts:231,305,341,539,626–637` | Proves old session presence, recreates when allowed, and captures bounded recovery diagnostics | `SESSION_DISCOVERY`, `SESSION_CREATE`, `CAPTURE_VISIBLE`, `REATTACH_RECOVERY` |
| `src/daemon/readiness.ts:271–294` | Uses injected session-existence and capture operations during provider readiness | `SESSION_DISCOVERY`, `LAUNCH_FAILURE_EVIDENCE`, `CAPTURE_VISIBLE` |
| `src/daemon/teardown.ts:198–234` | Captures pane roots before kill, kills the session, then verifies it is absent | `PROCESS_ROOT_DISCOVERY`, `TERMINATE_READBACK` |
| `src/daemon/server.ts:682,759,775,784–787,3438` | Liveness/status probing, process-root attribution, kill wiring, and lifecycle guards | `SESSION_DISCOVERY`, `PROCESS_ROOT_DISCOVERY`, `TERMINATE_READBACK` |
| `src/cli/control.ts:58–84` | Enumerates instance sessions, captures roots, kills, and verifies the remaining set during stop | `SESSION_ENUMERATION`, `PROCESS_ROOT_DISCOVERY`, `TERMINATE_READBACK` |
| `src/cli/orchestrator.ts:131–145,343–396` | Refuses to replace an attached root session, removes an unattached stale one, and directly builds provider-specific `tmux new-session` commands | `CLIENT_TTY_DISCOVERY`, `TERMINATE_READBACK`, `ORCHESTRATOR_LAUNCH` |
| `src/cli/daemon.ts:126,195` | Wires one instance-scoped adapter into daemon lifecycle and delivery | `INSTANCE_SCOPE`, `LITERAL_INPUT`, `INTERRUPT_INPUT` |
| `workspace/Sources/HiveWorkspace/ProjectWindowController.swift:300–310` | Polls the exact agent target and starts a tmux attach client; the root path starts the Workspace orchestrator, which creates its own tmux session | `WORKSPACE_ATTACH`, `ORCHESTRATOR_LAUNCH`, `REATTACH_RECOVERY` |
| `workspace/Sources/HiveWorkspace/TerminalPaneView.swift:25–100` | Direct tmux copy-mode/scroll subprocesses, coalesced on a serial queue | `SCROLL_ROUTING` |
| `workspace/Sources/HiveWorkspace/SmokeRunner.swift:62–68` and `workspace/scripts/smoke.sh:31–119` | Real-substrate verification creates, attaches, inspects, captures, and kills tmux sessions | Evidence for `SESSION_CREATE`, `WORKSPACE_ATTACH`, `DETACH_WITHOUT_KILL`, `SCROLL_ROUTING`, `LITERAL_INPUT`, and `TERMINATE_READBACK`; it is a harness, not a production owner |

## tmux postconditions

| Current postcondition and source evidence | New owner | Conformance-test ID |
| --- | --- | --- |
| Only syntactically valid sessions in Hive's instance-scoped socket namespace are targeted; foreign-instance targets are rejected (`tmux.ts:27–35,107–148`). | SessionHost defines exact locators; Hive daemon authorizes the instance/subject/generation. | `TST.TERM.LEGACY.TMUX.INSTANCE_SCOPE` |
| Existence can be distinguished from absence; “no server” is absence, while unrelated command errors are not rounded down (`tmux.ts:55–62,129–152`). | SessionHost contract; sessiond broker/host registry. | `TST.TERM.LEGACY.TMUX.SESSION_DISCOVERY` |
| A provider session is created detached, in the requested working directory, with the requested command, mouse enabled, bounded history, and positive post-create readback (`tmux.ts:155–187`). | SessionHost create contract; sessiond host and Provider adapter launch contract. | `TST.TERM.LEGACY.TMUX.SESSION_CREATE` |
| A nonzero provider exit remains visible briefly so readiness can capture the real failure rather than report only disappearance (`tmux.ts:43–74`; `readiness.ts:271–294`). | Provider adapters emit structured readiness/exit evidence; Hive daemon retains it. | `TST.TERM.LEGACY.TMUX.LAUNCH_FAILURE_EVIDENCE` |
| Automated text reaches the exact pane literally through a named tmux buffer, is pasted once, buffer cleanup is bounded, and submit follows after the anti-paste delay (`tmux.ts:207–242`). | sessiond host's ordered input arbiter; Provider adapters define readiness/receipt. | `TST.TERM.LEGACY.TMUX.LITERAL_INPUT` |
| Interrupt delivery sends Escape, waits, clears the old composer with Control-U, waits, then sends the new control; the cancelled prompt cannot be resumed (`tmux.ts:190–242`). | sessiond arbiter orders/revokes; Provider adapters define the provider-specific cancellation action and evidence. | `TST.TERM.LEGACY.TMUX.INTERRUPT_INPUT` |
| Hive can obtain a bounded visible pane string for readiness, recovery diagnosis, and tests (`tmux.ts:245–253`). The new stack must preserve observation without preserving screen text as status or receipt truth. | SessionHost snapshot/inspect contract; sessiond headless VT state. | `TST.TERM.LEGACY.TMUX.CAPTURE_VISIBLE` |
| Hive can tell whether a real TTY client is attached and refuses to replace an actively used root session (`tmux.ts:255–269`; `orchestrator.ts:131–145`). | sessiond visibility leases/attach clients, interpreted under Hive daemon lifecycle intent. | `TST.TERM.LEGACY.TMUX.CLIENT_TTY_DISCOVERY` |
| Hive can enumerate pane root PIDs before destructive action, anchoring descendant/resource inspection (`tmux.ts:271–284`; `teardown.ts:198–225`). | sessiond host process identity/inspection, extended by Provider adapters for auxiliary roots. | `TST.TERM.LEGACY.TMUX.PROCESS_ROOT_DISCOVERY` |
| Kill targets one exact session and success requires a subsequent absence readback; missing is idempotent when allowed (`tmux.ts:286–305`). | sessiond exact-generation terminate/readback; Hive daemon lifecycle result. | `TST.TERM.LEGACY.TMUX.TERMINATE_READBACK` |
| Instance session enumeration returns a de-duplicated namespace view and treats a missing tmux server as empty (`tmux.ts:307–329`; `control.ts:58–84`). | SessionHost list contract; sessiond broker registry re-proved by live hosts. | `TST.TERM.LEGACY.TMUX.SESSION_ENUMERATION` |
| The selected root provider launches once in a persistent real terminal session in the requested directory, with terminal mouse mode enabled (`orchestrator.ts:343–396`). | SessionHost and sessiond host; Provider adapter launch contract. | `TST.TERM.LEGACY.TMUX.ORCHESTRATOR_LAUNCH` |
| An agent pane waits until its exact session exists, then attaches to that existing provider TUI rather than starting a replacement (`ProjectWindowController.swift:297–310`). | HiveTerminalKit attach state; SessionHost attach contract; sessiond exact-generation routing. | `TST.TERM.LEGACY.TMUX.WORKSPACE_ATTACH` |
| Closing/replacing only a tmux client detaches the renderer without killing the daemon-owned provider; user-close of an agent separately calls daemon teardown (`TerminalPaneView.swift:260–268`; `ProjectWindowController.swift:131–185,230–236`). | HiveTerminalKit surface lifecycle and sessiond visibility lease. Close intent remains Hive daemon authority. | `TST.TERM.LEGACY.TMUX.DETACH_WITHOUT_KILL` |
| Wheel traffic reaches an alternate-screen TUI through terminal mouse reporting; the legacy copy-mode fallback coalesces adjacent gestures and serializes commands rather than creating an unbounded subprocess queue (`TerminalPaneView.swift:25–100,188–225`; `TerminalScroll.swift:17–64`). | HiveTerminalKit native mouse and scrollback behavior. | `TST.TERM.LEGACY.TMUX.SCROLL_ROUTING` |
| Scrollback is retained up to an explicit 50,000-line tmux history limit rather than growing without bound (`tmux.ts:25,174–182`). | sessiond bounded journal/checkpoints/scrollback; HiveTerminalKit viewer state. | `TST.TERM.LEGACY.TMUX.BOUNDED_HISTORY` |
| A renderer or daemon recovery can reconnect to the same still-running provider session instead of fabricating a new one (`recovery.ts:231–341,626–637`; Workspace attach loop). | SessionHost reconnect contract and sessiond adoption/high-water proof. | `TST.TERM.LEGACY.TMUX.REATTACH_RECOVERY` |

## SwiftTerm usage census

There is one production import: `workspace/Sources/HiveWorkspace/TerminalPaneView.swift:2`. `workspace/Package.swift:20,28` pins and links SwiftTerm 1.11.2. The concrete API use is:

- `WorkspaceTerminalView: LocalProcessTerminalView` overrides paste and the PTY-boundary send hook (`TerminalPaneView.swift:8–22`).
- `TerminalPaneView` owns one `LocalProcessTerminalView`, its delegate, constraints, mouse mode, local key/scroll monitors, deferred process launch, focus, termination, screen inspection, and test send path (`TerminalPaneView.swift:112–302`).
- `Terminal.getEnvironmentVariables` supplies the base terminal environment before Hive adds only PATH and TMPDIR (`TerminalPaneView.swift:248–258,304–319`).
- `ProjectWindowController` commits settled geometry, reconciles first responder with pane focus, and observes SwiftTerm's click-driven responder changes (`ProjectWindowController.swift:99–113,330–376,503–515`).
- `WorkspaceCore/TerminalScroll.swift:25–38` identifies the pinned SwiftTerm malformed no-button SGR motion packet that the subclass drops.
- `MainMenuBuilder.swift:27–38` routes native Copy, Paste, and Select All through the active responder; when a terminal is first responder those operations are supplied by the terminal view.
- `SmokeRunner.swift` uses `visibleText`, synthetic key/mouse paths, focus state, and real tmux output to prove the actual SwiftTerm substrate. It adds proof, not a separate production guarantee.

No production Workspace code calls a SwiftTerm search API or consumes its title, working-directory, or size delegate callbacks; the three delegate methods are present but empty (`TerminalPaneView.swift:292–296`). Those are therefore not claimed as old postconditions. Search and accessibility are new HiveTerminalKit requirements from the target design, not legacy guarantees invented by this inventory.

## SwiftTerm postconditions

| Current postcondition and source evidence | New owner | Conformance-test ID |
| --- | --- | --- |
| The pane shows the real provider VT stream with terminal modes rather than a reconstructed transcript (`TerminalPaneView.swift:103–110`). | HiveTerminalKit, fed from canonical sessiond VT/output state. | `TST.TERM.LEGACY.SWIFTTERM.REAL_TUI` |
| Process launch waits for a nontrivial, settled pane size so the child PTY is not born at 0×0 (`TerminalPaneView.swift:142–145,227–258`; `ProjectWindowController.swift:99–113`). | HiveTerminalKit computes geometry; sessiond host creates/resizes the PTY. | `TST.TERM.LEGACY.SWIFTTERM.INITIAL_GEOMETRY` |
| Live frame changes update terminal winsize, while layout-tree animations commit geometry once at the end (`TerminalPaneView.swift:234–242`; `ProjectWindowController.swift:319–329`). | HiveTerminalKit geometry/reflow and sessiond ordered resize. | `TST.TERM.LEGACY.SWIFTTERM.LIVE_RESIZE` |
| The provider receives a terminal environment with `TERM=xterm-256color` and required user values, plus inherited PATH and TMPDIR needed to locate providers/tmux and the Codex socket (`TerminalPaneView.swift:248–258,304–319`). | Provider adapters define launch environment; sessiond host performs exec. | `TST.TERM.LEGACY.SWIFTTERM.ENVIRONMENT` |
| Native key and text events reach the terminal child, while Hive classifies edit/submit/cancel for human-input state (`TerminalPaneView.swift:157–186,286–288`). | HiveTerminalKit encoding; sessiond input arbiter. | `TST.TERM.LEGACY.SWIFTTERM.KEY_TEXT_INPUT` |
| Paste uses the terminal's native encoder and first marks the composer as human editing (`TerminalPaneView.swift:10–14`). | HiveTerminalKit paste/clipboard policy; sessiond human claim and input order. | `TST.TERM.LEGACY.SWIFTTERM.PASTE` |
| Click, drag, motion, and wheel reporting are enabled per pane and wheel coordinates are translated to the current terminal grid (`TerminalPaneView.swift:129–138,188–225`). | HiveTerminalKit mouse encoder and geometry. | `TST.TERM.LEGACY.SWIFTTERM.MOUSE` |
| The pinned SwiftTerm bug that encodes no-button all-motion as a release is filtered, while clicks, drags, and wheels pass (`TerminalPaneView.swift:5–22`; `TerminalScroll.swift:25–38`). | HiveTerminalKit/Ghostty input encoding must make false release impossible. | `TST.TERM.LEGACY.SWIFTTERM.MALFORMED_MOTION` |
| Explicit pane navigation and clicks make the terminal first responder; the model and visible focus ring reconcile to the responder that really owns keyboard input (`TerminalPaneView.swift:270–272`; `ProjectWindowController.swift:330–376,503–515`). | HiveTerminalKit first-responder and focus contract. | `TST.TERM.LEGACY.SWIFTTERM.FOCUS` |
| Tearing down the `LocalProcessTerminalView` child releases the client-side PTY/attach process; it does not itself decide provider lifecycle (`TerminalPaneView.swift:260–268`). | HiveTerminalKit surface/transport cleanup; sessiond independently owns provider lifetime. | `TST.TERM.LEGACY.SWIFTTERM.CHILD_TERMINATION` |
| Child exit clears `childRunning` and notifies the Workspace, which can render root terminal exit (`TerminalPaneView.swift:290–302`; `ProjectWindowController.swift:280–286`). | sessiond records canonical host/provider exit; Hive daemon and HiveTerminalKit project it. | `TST.TERM.LEGACY.SWIFTTERM.EXIT_EVENT` |
| Tests can read deterministic visible rows and inject text through the same terminal object used by the app (`TerminalPaneView.swift:274–288`). | HiveTerminalKit test surface plus sessiond headless digest; never a production status source. | `TST.TERM.LEGACY.SWIFTTERM.VISIBLE_SCREEN` |
| Editing, paste, submit, and cancel observations drive the current human composer state, including deferred submit/cancel notification after SwiftTerm sees the key (`TerminalPaneView.swift:10–14,157–186`). | HiveTerminalKit emits native input intent; sessiond owns the claim; Hive daemon may project structured state. | `TST.TERM.LEGACY.SWIFTTERM.COMPOSER_SIGNAL` |
| Standard AppKit Copy and Select All commands reach the focused terminal responder and operate on terminal selection; Copy does not send PTY bytes (`MainMenuBuilder.swift:27–38`; terminal first-responder path above). | HiveTerminalKit selection/copy/clipboard policy. | `TST.TERM.LEGACY.SWIFTTERM.SELECTION_COPY` |

## Closure rule

T0 freezes names and ownership; it does not claim the new implementation passes them. Later work packages must reference these IDs verbatim in tests and evidence. A legacy path may be removed only when its mapped proof passes on the admitted replacement and TG7's two-release, zero-live-generation, clean-install, no-direct-call, and rollback conditions are also satisfied.
