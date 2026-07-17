# STORY-002 — Complete removal of agent TUI code (SwiftTerm/tmux-attach presentation path)

Milestone: M1 (executes together with STORY-001 as the M1 cut)
Backlog position: #2
State when board access lands: **Ready** (with one interpretation flag for queen/user below)

## Interpretation (stated, not silently chosen)

Hive does not render an agent TUI of its own: the vendor TUIs (Claude Code, Codex, Grok) render themselves, and Hive's shipping path *hosts* them via a SwiftTerm view execing `tmux attach-session` per pane ("Hive never rolls its own renderer" — TerminalPaneView). Therefore "agent TUI code" is read as: **the legacy presentation/hosting layer through which agent TUIs are displayed** — the SwiftTerm renderer and its tmux-attach glue. The replacement (HiveTerminalKit, Ghostty-based) is NOT in scope — it is the successor. If the requester meant something broader (e.g. also the CLI status-table/statusline text emitters), say so and this story splits; the broader reading risks dragging core session management out with the TUI (WorkspaceCore blends both).

## Sequencing

Same Removal Gate as STORY-001, renderer edition: executes when HiveTerminalKit's `HiveTerminalView` (manual-I/O Ghostty surface attached to sessiond) renders live vendor-TUI sessions inside the Workspace pane with input, resize, scroll, selection, copy, IME, and close/teardown proven live — across the full vendor matrix (real Claude Code, Codex, AND Grok interactive TUIs; atlas second opinion, adopted). Hard cut: no `terminal_renderer=swiftterm|ghostty` flag, no per-pane fallback. The in-tree HiveTerminalKit is an implementation candidate, not evidence — the gate measures live behavior, never code presence.

**Atomic cut with STORY-001 (atlas R3 P0-3, adopted):** the two removal stories overlap (TerminalPaneView/PaneView/LaunchConfig/ProjectState/AgentFeed/scroll/smoke) and execute as ONE atomic Removal Gate merge train with explicit internal ordering; the full matrix re-runs on the post-deletion tree. Two separately-green PRs are not acceptable.

## Scope — removal inventory (verified by repo survey 2026-07-17; re-verify at execution)

**Delete / replace:**
- SwiftTerm package dependency (`workspace/Package.swift`, exact 1.11.2) — removed entirely from the dependency graph.
- `workspace/Sources/HiveWorkspace/TerminalPaneView.swift` (~325 LOC) — `LocalProcessTerminalView` (SwiftTerm) subclass, `tmux attach-session` exec, `TmuxScrollController` (tmux copy-mode scroll), PTY mouse-packet fixups. Superseded by a pane hosting `HiveTerminalView`.
- tmux session/socket fields and plumbing in `PaneView.swift`, `LaunchConfig.swift`, and the tmux copy-mode geometry in `WorkspaceCore/TerminalScroll.swift`.
- `SmokeRunner.swift` SwiftTerm-driving harness + `workspace/scripts/smoke.sh` tmux driving — replaced by an equivalent smoke harness against sessiond/HiveTerminalKit (same coverage, new spine; writing that harness is an M1 build story, this story deletes the old one).
- Tests asserting SwiftTerm/tmux-attach behavior (subset of WorkspaceCoreTests/HiveWorkspaceTests, e.g. tmux expectations in ProjectStateTests and wire-contract fixtures).

**Kept as CATEGORY but revalidated, never presumed unchanged (atlas R3 correction, adopted):** pane chrome and layout (`PaneStatusBorderView`, `PaneFocusRingView`, `LayoutContainerView`, LayoutTree/SpatialNavigation/PaneFocus), attention/status reducers, DesignSystem, Settings, ModelControl, the `workspace-feed` NDJSON status wire, `statusline.ts` fact ingestion. **`ProjectState` and `AgentFeed` explicitly carry tmux identity today and MUST be revalidated and rewired**, as must Workspace app argument parsing and lifecycle semantics (AppDelegate/main/ProjectWindowController: orchestrator session/socket, attach command, first-responder, deferred geometry, pane-close-vs-agent-kill, quit). At execution, regenerate a fresh exact-reference inventory as ephemeral evidence; the behavioral scope is authoritative, the file list is a dated snapshot.

## Definition of done

1. **Zero SwiftTerm — full supply chain (expanded per atlas R3):** SwiftTerm absent from the dependency graph (`Package.swift`), the resolved lock (`Package.resolved`), all imports, dynamic linkage of shipped binaries, bundled resources, third-party licenses/notices, and launch scripts; app builds and is signed/notarized without it.
2. **Live proof — all three vendors (corrected: DoD matches the Sequencing matrix):** dev-build Workspace opens panes on live session generations rendered by HiveTerminalKit; each of Claude Code, Codex, AND Grok's real TUIs is exercised end-to-end (type, scroll, resize, select/copy, IME text entry, mouse, close with verified process termination, quit-Workspace teardown of every provider tree). Recorded and independently reproduced, re-run on the post-deletion tree.
3. **Fidelity floor (expanded per atlas R3):** judged against external VT references, never against SwiftTerm's behavior. Corpus must cover: Unicode width/combining/emoji-ZWJ; truecolor + 256-color; cursor shapes; focus events; bracketed paste; OSC 8 hyperlinks; OSC 52 clipboard policy; title/bell; primary + alternate screen; all mouse modes; keyboard incl. dead keys and Option mappings (kitty protocol); search/scrollback limits; selection/copy/paste; IME; Retina scale changes; GPU sleep/wake/memory behavior. Exact corpus/version/results recorded — "looks right" belongs only to the aesthetic C1 gate.
3a. **Accessibility is live acceptance, not a citation (promoted per atlas R3):** VoiceOver + Accessibility Inspector runs on the new terminal pane pass and are recorded as part of this story's DoD.
4. Swift, TS, and Zig suites + typecheck green.
5. **No legacy shims:** no renderer flag, no SwiftTerm code path retained "just in case."
6. **Project-agnostic:** pane hosting carries no Hive-repo assumptions; proven by opening the dev build on a non-Hive repository.
7. **Doc-cleanup task (paired):** `docs/workspace/*`, README, SPEC terminal/workspace sections describe the new renderer's behavior and contracts; no file-path or line-number references in any doc.
8. Fresh external research drives; current code and design docs are reference only.

## External documentation

Verified by atlas 2026-07-17 (official sources):
- libghostty embedding: https://ghostty.org/docs/about and https://github.com/ghostty-org/ghostty (emulation precedence: standards → xterm → popular terminals). Upstream header caveat — embedding API "not general-purpose yet," sole consumer is the Ghostty macOS app: https://github.com/ghostty-org/ghostty/blob/main/include/ghostty.h — pin commit, Hive-owned adapter, ABI/behavior gates (ADR-0002 governs the patch budget). libghostty-vt (API unstable): https://libghostty.tip.ghostty.org/ . Reference consumer ghostling is a demo, never production proof: https://github.com/ghostty-org/ghostling
- VT conformance (the fidelity floor in DoD-3): ECMA-48 (https://ecma-international.org/publications-and-standards/standards/ecma-48/), xterm ctlseqs incl. alt-screen 1049, bracketed paste, mouse tracking (https://invisible-island.net/xterm/ctlseqs/ctlseqs.html), vttest executable corpus — record exact test/version/results, not "looks right" (https://invisible-island.net/vttest/), kitty keyboard protocol (https://sw.kovidgoyal.net/kitty/keyboard-protocol/).
- AppKit IME contract — marked text, insertion, command dispatch, character coordinates: https://developer.apple.com/documentation/AppKit/NSTextInputClient
- AppKit accessibility — custom-drawn terminal content needs accessibility elements + live VoiceOver/Accessibility Inspector proof: https://developer.apple.com/documentation/accessibility/integrating-accessibility-into-your-app

## Out of scope

Building/wiring HiveTerminalKit (M1 build stories); tmux daemon-side removal (STORY-001); Split Horizon layout changes (explicitly last, after everything is proven).
