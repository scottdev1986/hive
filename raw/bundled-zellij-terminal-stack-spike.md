# Spike: Bundled Zellij with a Hive-owned cross-platform terminal surface

**Status:** Proposed  
**Type:** Technical and UX feasibility spike  
**Option under test:** Bundled Zellij + Electron + xterm.js + node-pty  
**Timebox:** 10 engineering days  
**Production migration:** Out of scope for this spike

## Story

As a Hive user, I want Hive to display and manage the real Codex, Claude Code, and Grok terminal interfaces without requiring me to install tmux or another terminal multiplexer, so that I get a self-contained, consistent experience on macOS, Linux, and Windows while retaining the complete vendor TUI.

As a user composing text in a vendor TUI, I want my pane to remain exclusively under my control until I submit, cancel, or explicitly release it, so that an incoming Hive message can never erase, alter, submit, or interleave with my draft.

As a Hive product, we want to own the visible layout, focus, navigation, animation, and attention behavior, so that the workspace can provide Hyprland-style window management without exposing the session host's UI or keybindings.

## Decision this spike must enable

Determine whether Hive can adopt the following architecture as its production direction:

```text
Hive desktop application
  |-- Electron: application shell and layout engine
  |-- xterm.js: one terminal surface per agent
  |     `-- node-pty: ephemeral `zellij attach` process
  |           `-- bundled Zellij session
  |                 `-- vendor TUI process
  `-- single-writer input arbiter
        |-- human input
        `-- queued Hive and remote input
```

The spike ends with a go, conditional go, or no-go recommendation. A conditional go must identify each remaining blocker, its owner, and the experiment required to close it.

## Product invariants

These are requirements, not tradeable implementation details.

1. **The vendor TUI is the pane content.** Hive must display the real Codex, Claude Code, and Grok TUI. A reconstructed transcript or Hive-owned conversation UI is not an acceptable substitute.
2. **Hive is the window manager.** Hive owns pane layout, focus, borders, promotion, swapping, fullscreen behavior, attention, animation, and keyboard navigation. Zellij must not expose panes, tabs, frames, status bars, or navigation UI.
3. **Human input has priority.** Once a person interacts with a terminal pane, automated input must not write to that pane until human ownership is conclusively released.
4. **No focus stealing.** Output, completion, approval requests, or queued messages may change pane decoration and badges but may not move keyboard focus.
5. **Sessions outlive the viewer.** Closing or crashing an xterm.js renderer, its attach PTY, or the entire Hive UI must not terminate the vendor TUI.
6. **No external multiplexer prerequisite.** The prototype must use the exact Zellij binary packaged by Hive and must work when `zellij` and `tmux` are absent from `PATH`.
7. **Cross-platform means native macOS, Linux, and Windows behavior.** WSL may be evaluated as an additional execution target but cannot be the only Windows result.
8. **Hive does not reserve ordinary vendor shortcuts.** Normal terminal keys must reach the TUI unchanged. Hive layout commands must use an explicit, visible, configurable application navigation mode.

## Hypotheses

The spike should attempt to falsify these claims.

### H1: Zellij can be an invisible session substrate

A Hive-supplied Zellij configuration can run one vendor process in one session with no visible Zellij chrome and no Zellij-owned keyboard shortcuts. Hive can create, locate, attach, resize, capture, and terminate the session without displaying Zellij's own layout.

### H2: The terminal surface preserves vendor behavior

xterm.js connected through node-pty to `zellij attach` correctly renders and drives the full vendor TUI, including alternate-screen behavior, cursor addressing, mouse reporting, Unicode, IME composition, bracketed paste, colors, hyperlinks, and resize events.

### H3: Hive can provide Hyprland-style management independently

Electron can host multiple terminal surfaces while Hive alone controls a master/stack layout, directional focus, pane promotion, swapping, fullscreen, attention borders, and animated geometry changes. A layout animation can settle before Hive sends the final PTY resize, avoiding resize storms and TUI flicker.

### H4: A single-writer arbiter can protect drafts

Every human and automated input path can be serialized through one authority. A latched human-ownership state prevents automated bytes from entering a pane containing a draft, including when the user pauses for an arbitrary amount of time or changes focus.

### H5: Zellij's Windows support is mature enough for Hive

The same lifecycle, rendering, input, resize, reattach, and teardown operations work through native Windows ConPTY without material vendor-specific breakage.

### H6: Hive can retain its current operational controls

The replacement can provide equivalents for the capabilities currently supplied by `src/adapters/tmux.ts`: isolated session creation, input delivery, screen capture, root-process discovery, liveness, session enumeration, verified teardown, and UI crash recovery.

## Prototype scope

### 1. Package the exact runtime stack

Produce development builds for macOS, Linux, and Windows containing:

- A pinned Zellij binary for the target platform and architecture.
- A minimal Electron application.
- xterm.js and the addons required by the prototype.
- node-pty built and packaged for the Electron runtime and target architecture.
- A Hive-owned Zellij configuration.
- Checksums, source versions, licenses, and a record of the packaged size for every native artifact.

The application must launch Zellij by an absolute path inside its own resources. It must set private runtime, socket, cache, and configuration locations so that a user's installed Zellij version or personal configuration cannot affect Hive.

Do not download executable components on first launch. Code signing, notarization, installer polish, and automatic updates are not part of the spike, but the findings must identify any blockers they would face.

### 2. Implement the minimum session-host seam

Create a spike-only adapter with operations equivalent to:

```ts
interface SessionHost {
  create(spec: SessionSpec): Promise<SessionLocator>;
  attach(locator: SessionLocator, size: TerminalSize): Promise<AttachHandle>;
  writeAutomated(locator: SessionLocator, payload: Uint8Array): Promise<void>;
  capture(locator: SessionLocator): Promise<string>;
  inspect(locator: SessionLocator): Promise<SessionInspection>;
  terminate(locator: SessionLocator): Promise<TerminationResult>;
  list(): Promise<SessionInspection[]>;
}
```

`SessionLocator` must not contain tmux terminology. It must identify a Hive home or tenant, agent, generation, and session-host address without relying on a globally shared default socket.

Use one Zellij session with one terminal pane for each agent. Do not use Zellij to arrange multiple Hive agents in one session.

The spike must determine the safest way to deliver arbitrary automated input without placing prompt content in process arguments. Acceptable candidates include a small bundled Zellij WASM bridge receiving input over stdin or a persistent, authenticated control attachment. The result must support large multiline messages, embedded quotes, control characters, and bracketed paste. If no safe stdin-based path is viable, record that as a no-go finding rather than silently falling back to command-line arguments.

### 3. Build a minimal Hive terminal workspace

The Electron prototype must render at least four simultaneous terminal panes and provide:

- Master/stack layout.
- Directional focus.
- Promote focused pane to master.
- Swap two panes.
- Split/add and close/detach.
- Focused-pane fullscreen and restore.
- Visible focus and attention borders.
- A queued-message badge that does not steal focus.
- Animated layout transitions with Reduce Motion support.
- A configurable Hive navigation leader or mode.

The prototype is not expected to reproduce the production visual design. It must be complete enough to test real terminal focus, keyboard routing, mouse behavior, resizing, and animation under multi-pane use.

Hive must commit terminal cell geometry only after an animation settles, except when an immediate resize is required by an explicit user action such as maximizing a pane with animations disabled.

### 4. Implement a single-writer input arbiter

All bytes sent toward a vendor pane must pass through one ordered authority in the trusted Electron main process or a dedicated local broker. The renderer must not have an independent automation write path.

Use this state model:

```text
AVAILABLE
  | human-originated terminal event
  v
HUMAN_OWNED -----------------------------------+
  | trusted submit/cancel event or              |
  | explicit user release                       | no timeout
  v                                              |
AVAILABLE                                       |
  | pane unfocused, no draft, queued automation |
  v                                              |
AUTOMATION_OWNED                                |
  | one delivery transaction completes          |
  v                                              |
AVAILABLE <--------------------------------------+
```

Rules:

- Acquire `HUMAN_OWNED` before forwarding the first user-originated byte.
- Treat keyboard input, paste, IME commit data, mouse-generated terminal input, and terminal-protocol responses caused by direct user interaction as human-originated.
- Human ownership does not expire and is not cleared by loss of focus.
- Enter alone is not sufficient proof of submission when a vendor can use it for multiline editing or redefine the key.
- Prefer a structured vendor event confirming submit or cancel. If no reliable event exists, require an explicit Hive release action.
- While `HUMAN_OWNED`, enqueue automated messages and update only Hive-owned decoration.
- Never send synthetic `Escape`, `Ctrl+C`, `Ctrl+U`, backspace, or replacement text to clear a possible draft.
- Begin automation only when the pane is unfocused and human ownership is clear.
- While `AUTOMATION_OWNED`, do not transfer keyboard focus into the pane until the transaction completes. A focus request arriving before the first automated byte cancels the transaction; one arriving after the first byte waits for the bounded transaction to finish.
- Send automated content as bracketed paste followed by a separately ordered submit action unless the vendor offers a proven same-session API that avoids the editor buffer.
- Record ownership transitions and message identifiers without logging prompt content.

The spike must distinguish provider-native delivery from PTY delivery. A provider-native path counts only if it demonstrably targets the same session displayed by the vendor TUI and does not replace that TUI.

### 5. Exercise real vendor TUIs

Run the following matrix on each operating system supported by the corresponding vendor executable:

| Vendor | Launch | Interactive compose | Multiline/paste | Vendor shortcuts | Resume after viewer crash | Automated delivery |
|---|---|---|---|---|---|---|
| Codex | Required | Required | Required | Required | Required | Required |
| Claude Code | Required | Required | Required | Required | Required | Required |
| Grok | Required | Required | Required | Required | Required | Required |

If a vendor does not ship for a target OS, record that as a vendor-platform limitation separately from the Hive stack result. Do not count a WSL execution as proof of native Windows behavior.

The matrix must include the vendor's help, model picker, permission dialog, command palette, session picker, scrolling, and any mouse-driven UI. Zellij keys such as `Ctrl+G` and common `Ctrl` and `Alt` combinations must reach each vendor unchanged under Hive's supplied configuration.

### 6. Exercise a deterministic terminal fixture

In addition to real vendors, use a small test fixture that can deterministically emit and verify:

- Primary and alternate screen transitions.
- Cursor movement and screen clearing.
- 16-color, 256-color, and true-color output.
- SGR mouse modes.
- Bracketed-paste enablement and exact received bytes.
- Large and multiline pastes.
- Unicode grapheme clusters, wide glyphs, combining characters, and emoji.
- IME composition and committed text.
- OSC 8 hyperlinks.
- OSC 52 clipboard attempts, with the chosen Hive security policy recorded.
- Rapid resize sequences.
- Child and grandchild processes.
- A long-running session with enough output to exercise scrollback and reattachment.

The fixture is test infrastructure, not a terminal implementation.

### 7. Prove recovery and teardown behavior

For every platform:

1. Start a vendor TUI and create recognizable on-screen state.
2. Kill only the xterm.js renderer.
3. Kill the node-pty attach process.
4. Kill the complete Electron UI process.
5. Reopen Hive and reattach to the same Zellij session.
6. Confirm the vendor process identity and session state were preserved.
7. Terminate the agent through the session-host adapter.
8. Verify the vendor root and all ordinary descendants are gone.
9. Exercise a deliberately detached or escaped descendant and record whether Hive's OS process ownership layer can still find and terminate it.

The finding must specify the production ownership primitive needed on each platform. Evaluate Windows Job Objects and Linux process groups or cgroups rather than assuming that terminating Zellij alone handles escaped descendants.

## Test scenarios

### Draft-protection race suite

Automate the transport-level cases and manually verify them against each real vendor:

1. An automated message becomes eligible at the same instant as the user's first key.
2. The user types, pauses longer than any previous lease duration, and resumes.
3. The user leaves a draft, focuses another pane, and returns later.
4. The user pastes while an automated message is waiting.
5. The user begins and commits an IME composition while a message is waiting.
6. The user submits and immediately begins a new draft.
7. The user cancels or clears a draft using vendor-specific controls.
8. Multiple automated messages arrive while the pane is human-owned.
9. The UI crashes while a pane is human-owned and has queued messages.
10. The user requests focus while an automated transaction is preparing and while it is already writing.

For every case, capture the bytes received by the deterministic fixture and the resulting real-vendor behavior. A queued message arriving late is acceptable. A human byte or draft being lost, reordered, modified, or submitted is not.

### Layout and focus suite

1. Repeatedly promote and swap four busy vendor panes.
2. Hold a key in one pane during layout animations.
3. Generate output and attention events in every unfocused pane.
4. Add and remove panes while another pane owns a draft.
5. Toggle fullscreen and restore while a vendor is in alternate-screen mode.
6. Exercise keyboard-only and mouse-only navigation.
7. Repeat with Reduce Motion enabled.

No scenario may move terminal focus because of agent output. No keystroke may be delivered to a pane other than the one visibly focused when the key was accepted.

## Acceptance criteria

The spike is complete only when it produces evidence for all of the following.

1. A packaged prototype launches on macOS, Linux, and native Windows without `tmux` or `zellij` installed or present in `PATH`.
2. Hive uses its bundled, pinned Zellij binary and private configuration on every platform.
3. Zellij contributes no visible chrome and consumes no vendor keybinding under the Hive configuration.
4. Four real vendor TUI panes can be displayed and managed by the Hive layout prototype. Any unavailable vendor-platform combination is documented with vendor evidence and a product impact assessment.
5. The deterministic fixture passes alternate-screen, mouse, bracketed-paste, Unicode, IME, hyperlink, resize, and long-output tests without lost or mutated input bytes.
6. The draft-protection race suite produces zero automated bytes inside every `HUMAN_OWNED` interval and zero human/automation interleaving.
7. A human-owned pane remains protected after an arbitrary pause, focus change, and UI restart. No elapsed-time expiry is used.
8. Automated input supports at least 1 MiB of arbitrary multiline UTF-8 content without exposing the content in process arguments or diagnostic logs.
9. Killing the renderer, attach PTY, and Electron UI leaves the vendor process running; a new UI reattaches to the same session.
10. Hive can inspect the session and identify the vendor root process on all three operating systems.
11. Normal termination removes the session and its ordinary process tree. Escaped-descendant behavior and the required OS ownership mechanism are explicitly documented.
12. Master/stack, directional focus, promote, swap, fullscreen, attention, and animated resize work without focus stealing or input loss.
13. The report records cold attach, warm reattach, keystroke round-trip, resize, idle memory, four-pane memory, CPU, and packaged-size measurements per platform.
14. All bundled components have recorded versions, checksums, source locations, licenses, and known security/update implications.
15. The final recommendation maps every capability in the current tmux adapter to `proven`, `proven with caveat`, `not proven`, or `not required`.

## UX and performance targets

These are targets to measure and explain, not permission to hide correctness failures.

- Added input-path latency against the deterministic local echo fixture: p95 at or below one display frame on the test machine.
- Warm reattach until the terminal is usable: p95 under 500 ms.
- Full UI restart and session restoration: under 2 seconds excluding vendor authentication or vendor-controlled startup.
- Layout animation: no more than one final PTY resize per pane after the animation settles.
- Eight-hour, four-pane soak: no lost session, unbounded log growth, sustained idle CPU use, or increasing attach-process count.
- Keyboard focus is always visually unambiguous.
- A queued message is visible without obscuring the TUI or changing focus.

## Go/no-go rules

### Go

Recommend option one when every product invariant and acceptance criterion passes, and remaining issues are bounded packaging or production-hardening work.

### Conditional go

Use only when all input-safety, vendor-fidelity, crash-survival, and cross-platform gates pass, but a bounded issue such as installer integration, signing, or non-critical performance remains. The report must include an owner and closure test for each condition.

### No-go

Recommend against option one if any of the following is true at the end of the timebox:

- Zellij cannot be made visually and behaviorally invisible.
- A Zellij or Hive shortcut prevents required vendor input from reaching the TUI.
- The same architecture cannot run through native Windows ConPTY.
- Human and automated bytes can interleave or a paused draft must rely on a timeout for protection.
- Arbitrary automated messages cannot be delivered safely without command-line exposure.
- A UI or attach-client crash terminates the vendor TUI or loses the recoverable session.
- xterm.js cannot faithfully render or interact with a required vendor workflow.
- The process root cannot be identified well enough to support resource reporting and verified teardown.

A no-go report must identify which layer failed: Zellij session host, node-pty attachment, xterm.js surface, Electron shell, input arbitration, packaging, or vendor limitation. This keeps viable portions of the design available for a different combination.

## Deliverables

1. Packaged macOS, Linux, and Windows prototype builds or reproducible build artifacts for each.
2. Spike source isolated from the current production workspace implementation.
3. Pinned Zellij configuration and launch contract.
4. Deterministic terminal fixture and automated transport/race tests.
5. Completed vendor-platform test matrix with screenshots or recordings for visual failures and byte captures for transport failures.
6. Crash-recovery and teardown results for each operating system.
7. Performance, resource, and package-size measurements.
8. Dependency license, provenance, checksum, and update record.
9. Capability mapping from the current tmux adapter to the proposed session host.
10. A short decision record recommending go, conditional go, or no-go and naming the next production story if the result is positive.

## Out of scope

- Replacing the production tmux adapter during the spike.
- Rewriting or recreating any vendor TUI.
- Building a terminal parser or renderer.
- Bundling the vendor agent executables or changing their licensing and installation model.
- Final visual styling and complete accessibility remediation.
- Remote or multi-machine session attachment.
- A general-purpose terminal multiplexer UI.
- Provider-independent semantic transcript rendering.
- Production code signing, notarization, installers, auto-update, and rollback implementation.
- Final sandboxing or tenant-isolation architecture beyond recording implications.

## Current Hive touchpoints

The spike should compare its findings with, but not modify, these current components:

- `src/adapters/tmux.ts` — session lifecycle, input injection, capture, process lookup, and termination contract.
- `src/daemon/tmux-sessions.ts` — Hive-home socket isolation and session naming.
- `src/daemon/readiness.ts` — screen activity and real process liveness.
- `src/daemon/resources.ts` — process and resource inspection.
- `src/daemon/teardown.ts` — process-tree capture and verified cleanup.
- `workspace/Sources/HiveWorkspace/TerminalPaneView.swift` — current SwiftTerm attach surface, keyboard interception, lease integration, resize, and scroll behavior.
- `docs/workspace/blueprint.md` — product requirement that Hive owns the layout while the vendor TUI remains the product content.

## Research anchors

- Zellij installation and packaged binaries: <https://zellij.dev/documentation/installation.html>
- Zellij programmatic control: <https://zellij.dev/documentation/programmatic-control.html>
- Zellij CLI actions: <https://zellij.dev/documentation/cli-actions.html>
- Zellij keybinding removal: <https://zellij.dev/documentation/keybindings-binding.html>
- Zellij input modes: <https://zellij.dev/documentation/keybindings-modes>
- Zellij plugin API commands: <https://zellij.dev/documentation/plugin-api-commands.html>
- Zellij Windows release: <https://github.com/zellij-org/zellij/releases/tag/v0.44.0>
- Zellij current regression fixes: <https://github.com/zellij-org/zellij/releases/tag/v0.44.3>
- xterm.js: <https://github.com/xtermjs/xterm.js>
- xterm.js terminal API: <https://xtermjs.org/docs/api/terminal/classes/terminal/>
- node-pty: <https://github.com/microsoft/node-pty>
- Electron platform rationale: <https://www.electronjs.org/docs/latest/why-electron>
- Electron security guidance: <https://www.electronjs.org/docs/latest/tutorial/security>
- Windows pseudoconsoles: <https://learn.microsoft.com/en-us/windows/console/pseudoconsoles>
- Windows Job Objects: <https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects>

## Follow-on story if the spike passes

Replace the production tmux-specific contract with a platform-neutral `SessionHost`, ship the bundled Zellij runtime behind a feature flag, retain the current SwiftTerm workspace as the first client, and run both hosts through the same conformance suite before changing the default. Build the cross-platform Electron workspace as a separately gated migration so that session-host replacement and UI replacement can be rolled back independently.
