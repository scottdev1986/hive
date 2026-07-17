# STORY-002 — Complete removal of agent TUI code (SwiftTerm/tmux-attach presentation path)

Milestone: M1 (executes together with STORY-001 as the M1 cut)
Backlog position: #2
State when board access lands: **Ready** (with one interpretation flag for queen/user below)

## Interpretation (stated, not silently chosen)

Hive does not render an agent TUI of its own: the vendor TUIs (Claude Code, Codex, Grok) render themselves, and Hive's shipping path *hosts* them via a SwiftTerm view execing `tmux attach-session` per pane ("Hive never rolls its own renderer" — TerminalPaneView). Therefore "agent TUI code" is read as: **the legacy presentation/hosting layer through which agent TUIs are displayed** — the SwiftTerm renderer and its tmux-attach glue. The replacement (HiveTerminalKit, Ghostty-based) is NOT in scope — it is the successor. If the requester meant something broader (e.g. also the CLI status-table/statusline text emitters), say so and this story splits; the broader reading risks dragging core session management out with the TUI (WorkspaceCore blends both).

## Sequencing

Same Removal Gate as STORY-001, renderer edition: executes when HiveTerminalKit's `HiveTerminalView` (manual-I/O Ghostty surface attached to sessiond) renders a live vendor-TUI session inside the Workspace pane with input, resize, scroll, selection, copy, IME, and close/teardown proven live. Hard cut: no `terminal_renderer=swiftterm|ghostty` flag, no per-pane fallback.

## Scope — removal inventory (verified by repo survey 2026-07-17; re-verify at execution)

**Delete / replace:**
- SwiftTerm package dependency (`workspace/Package.swift`, exact 1.11.2) — removed entirely from the dependency graph.
- `workspace/Sources/HiveWorkspace/TerminalPaneView.swift` (~325 LOC) — `LocalProcessTerminalView` (SwiftTerm) subclass, `tmux attach-session` exec, `TmuxScrollController` (tmux copy-mode scroll), PTY mouse-packet fixups. Superseded by a pane hosting `HiveTerminalView`.
- tmux session/socket fields and plumbing in `PaneView.swift`, `LaunchConfig.swift`, and the tmux copy-mode geometry in `WorkspaceCore/TerminalScroll.swift`.
- `SmokeRunner.swift` SwiftTerm-driving harness + `workspace/scripts/smoke.sh` tmux driving — replaced by an equivalent smoke harness against sessiond/HiveTerminalKit (same coverage, new spine; writing that harness is an M1 build story, this story deletes the old one).
- Tests asserting SwiftTerm/tmux-attach behavior (subset of WorkspaceCoreTests/HiveWorkspaceTests, e.g. tmux expectations in ProjectStateTests and wire-contract fixtures).

**Explicitly kept (not agent-TUI code):** pane chrome and layout (`PaneStatusBorderView`, `PaneFocusRingView`, `LayoutContainerView`, LayoutTree/SpatialNavigation/PaneFocus), attention/status reducers, DesignSystem, Settings, `ProjectState`/`AgentFeed`/ModelControl session logic, the `workspace-feed` NDJSON status wire, `statusline.ts` fact ingestion. These serve the new renderer unchanged (per-file re-verification at execution; anything entangled gets rewired, not deleted).

## Definition of done

1. **Zero SwiftTerm:** SwiftTerm absent from `Package.swift`, `Package.resolved`, and all imports; no `tmux attach` or copy-mode escape anywhere in the app; app builds and is signed/notarized without it.
2. **Live proof:** dev-build Workspace opens a pane on a live session generation rendered by HiveTerminalKit; a real vendor TUI is exercised end-to-end (type, scroll, resize, select/copy, IME text entry, mouse, close with verified process termination, quit-Workspace teardown of every provider tree). Recorded and independently reproduced.
3. **Fidelity floor:** the vendor-TUI conformance checks that today pass on SwiftTerm (smoke harness scope) pass on the replacement — parity is the floor, judged against external VT references (xterm ctlseqs, vttest, kitty keyboard protocol), not against SwiftTerm's behavior.
4. Swift, TS, and Zig suites + typecheck green.
5. **No legacy shims:** no renderer flag, no SwiftTerm code path retained "just in case."
6. **Project-agnostic:** pane hosting carries no Hive-repo assumptions; proven by opening the dev build on a non-Hive repository.
7. **Doc-cleanup task (paired):** `docs/workspace/*`, README, SPEC terminal/workspace sections describe the new renderer's behavior and contracts; no file-path or line-number references in any doc.
8. Fresh external research drives; current code and design docs are reference only.

## External documentation

- libghostty embedding + libghostty-vt: https://ghostty.org/docs and the pinned upstream commit under `vendor/ghostty` (ADR-0002 governs the patch budget for the manual-I/O seam).
- VT conformance: xterm ctlseqs (invisible-island.net/xterm/ctlseqs/ctlseqs.html), vttest, kitty keyboard protocol (sw.kovidgoyal.net/kitty/keyboard-protocol/), alternate-screen semantics — the fidelity floor in DoD-3.
- Apple AppKit text input / NSTextInputClient (IME correctness) and accessibility (VoiceOver) documentation — the native affordances the replacement must keep.
- Atlas citation pack (R2) folds in before execution.

## Out of scope

Building/wiring HiveTerminalKit (M1 build stories); tmux daemon-side removal (STORY-001); Split Horizon layout changes (explicitly last, after everything is proven).
