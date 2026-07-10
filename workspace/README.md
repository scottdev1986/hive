# Hive Workspace (UI foundation prototype)

The Swift/AppKit flagship UI foundation from the [Workspace blueprint](../docs/architecture/hive-workspace-blueprint.md): one AppKit process multiplexing per-project workspace windows, the deterministic master/satellite layout, the status/attention model, and the native transcript pane (blueprint prototype hypothesis 2). Everything is driven by a mock structured event source — there is deliberately **no** daemon integration, Supervisor, Tenant Broker, AgentHost, SwiftTerm, or libghostty here; those are separate later phases.

Evidence for prototype hypothesis 2 lives in [docs/prototype-hypothesis-2-evidence.md](docs/prototype-hypothesis-2-evidence.md).

## Run it

```sh
cd workspace
swift run HiveWorkspace          # interactive: two project windows, scripted agents
swift run HiveWorkspace --smoke  # headless end-to-end checks, exits 0/1
swift test                       # WorkspaceCore unit tests
```

The interactive run plays a ~15 s scripted timeline across two projects ("hive", "docs-site"): an orchestrator streams its plan, four workers spawn into least-disruptive splits, one produces 5,000 lines of tool output, one emits ANSI logs, one requests an approval with an inline diff (amber), one fails (red badge), one completes then disconnects (green → gray dashed).

## Layout of the code

- `Sources/WorkspaceCore` — platform-independent logic, fully unit-tested:
  - `LayoutTree` — deterministic master/satellite split tree (master fixed to the 55–60 % band, default 0.58; least-disruptive insertion; close collapses only the parent split; promote is an atomic swap that preserves satellite order).
  - `SpatialNavigation` — arrow-key focus movement over solved frames.
  - `Status` / `Attention` — the five status states and the severity+time attention queue.
  - `Command` — the one shared `WorkspaceCommand` model every input surface dispatches through.
  - `AgentEvent` / `TranscriptModel` — WAL-shaped event envelopes reduced to transcript items.
  - `ANSIParser` — forgiving SGR parser (16/256/truecolor, bold/italic/underline); other escapes dropped, never leaked.
  - `MockEventSource` / `FixtureScript` — the scripted structured event stream.
  - `LayoutTransition` — the ~180 ms ease curve and interruptible-retarget math.
- `Sources/HiveWorkspace` — the AppKit shell (HIG-native: system semantic colors, system fonts, SF Symbols, native chrome/menus/materials):
  - `ProjectWindowController` — one window + reducer per project; the single command dispatch point; key window owns routing.
  - `PaneView` — header, status border, separate inset focus ring, failure badge, bounded amber pulse, accessibility custom actions.
  - `TranscriptPaneView` / `TranscriptRenderer` — NSTextView transcript (native find bar, selection, links, VoiceOver) + editable composer (native IME); `hive://` links route expand/approve into the command model.
  - `LayoutAnimator` — 180 ms interruptible transitions; terminal-cell geometry commits exactly once at the end; Reduce Motion snaps.
  - `AttentionCenter` / `ProjectSwitcherController` — cross-project attention panel and sanitized project cards.

## Keyboard map (all also in the Pane/Workspace menus)

| Command | Keys |
| --- | --- |
| Promote focused pane to master | ⌘↩ (or double-click pane header) |
| Return Orchestrator to Master | ⇧⌘↩ |
| Focus orchestrator | ⌘0 |
| Move focus spatially | ⌥⌘←/→/↑/↓ |
| Acknowledge focused pane | ⇧⌘K |
| Approve / Deny pending request | ⇧⌘Y / ⇧⌘N |
| Close pane | ⇧⌘W |
| Attention queue | ⌥⌘A |
| Projects | ⇧⌘P |
| Find in transcript | ⌘F |

## Deliberate non-goals in this phase

Shell/TUI panes (SwiftTerm), header drag-rearrange with drop targets, window restoration/display fingerprints, and any real provider or daemon connection. The `commitCellGeometry()` hook and the 30 Hz drag-throttle rule documented in the blueprint are where the terminal pane phase plugs in.
