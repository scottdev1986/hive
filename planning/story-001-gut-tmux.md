# STORY-001 — Gut ALL tmux terminal code (complete removal, no legacy shims)

Milestone: M1 (this story is the cut that completes M1)
Backlog position: #1 — ground zero of the rebuild. Written and specified first; **executed at the Removal Gate** (see Sequencing).
State when board access lands: **Ready**

## Why

The tmux stack is the old process host and terminal transport for every Hive agent session. The rebuild's first principle is gut-then-rebuild with no legacy support: every rebuilt system's story sequence begins with removal of the old one. This story is that removal for the terminal.

## Sequencing — explicit and safe (resolves "gut tmux" vs "new terminal functional")

You cannot remove the process host that runs agents before its replacement runs agents. Resolution:

- **Backlog order:** this story is #1. It is fully specified now so every M1 story builds toward its gate, not toward coexistence.
- **Execution order:** this story executes at the **Removal Gate** — the moment the replacement host (sessiond + `SessionHost` backend + HiveTerminalKit renderer) is **live-proven**: launch, attach, type, resize, scroll, close-with-verified-termination, and bounded reconnect/replay, demonstrated with a real vendor TUI (any one vendor suffices for the gate; all three are M2).
- **Hard cut, not canary:** there is NO dual-host flag, NO `terminal_host=tmux|sessiond` admission ramp, NO compatibility writes, NO quarantined tmux bridge. The reference design doc (terminal-stack-transition, phases T2/T6/T7) prescribes a gradual dual-host canary for a production migration; this rebuild explicitly overrides that with a single cut on a dev build. Between now and the gate, tmux code is frozen — no new callers, no fixes except fleet-critical.
- Everything in M1 between now and the gate exists solely to make this cut safe.

## Scope — removal inventory (verified by repo survey 2026-07-17; re-verify at execution)

**Primarily-tmux source (~1,677 LOC), delete entirely:**
- `src/adapters/tmux.ts` — TmuxAdapter/TmuxEngine/TmuxRunner CLI wrapper (new-session, capture-pane, send-keys, sockets, quoting).
- `src/daemon/session-host/tmux-host.ts` — TmuxSessionHost, the sole `SessionHost` implementation.
- `src/daemon/tmux-sessions.ts` — tmux session-naming conventions (widely imported; see rewiring).
- tmux minting in `src/daemon/session-host/locators.ts`.

**Embedded call sites, rewire to the replacement `SessionHost` backend (~40 files):** `src/daemon/server.ts` (holds `this.tmux`), `delivery.ts` (send-keys input path), `spawner-impl.ts` (spawns into tmux sessions), `teardown.ts`, `recovery.ts`, `readiness.ts`, `orchestrator-root-delivery.ts`, `launch-prompt.ts`, `src/cli/{control,daemon,workspace,orchestrator,start,uninstall,project-config-cleanup,orchestrator-brief}.ts`, provider adapters importing `hiveInstanceSuffix`, `src/schemas/{session-protocol,agent}.ts` (`tmuxSession` identity field → exact host locator + generation).

**Swift app tmux path:** `tmux attach-session` exec and `TmuxScrollController` in `workspace/Sources/HiveWorkspace/TerminalPaneView.swift`, tmux fields in `PaneView.swift`/`LaunchConfig.swift`/`ProjectState.swift`/`AgentFeed.swift`/`TerminalScroll.swift`, tmux driving in `SmokeRunner.swift` and `workspace/scripts/smoke.sh`. (The SwiftTerm renderer itself is STORY-002.)

**Tests:** delete `src/adapters/tmux.test.ts`, `tmux-boundary.test.ts`, `src/daemon/session-host/tmux-host.test.ts`, `src/daemon/tmux-sessions.test.ts` (~1,074 LOC); rework tmux-coupled assertions in ~14 other suites (spawner-impl, server, delivery, recovery, control, idle-reap, e2e-real, teardown, db, multi-instance.live, Swift ProjectStateTests/WorkspaceFeedWireContractTests).

**Kept:** `src/daemon/session-host/contract.ts` (the neutral `SessionHost` seam) — re-pointed, not deleted. Session/instance NAMING helpers lose their tmux identity but their instance-suffix semantics must be re-homed (they are imported by ~20 non-terminal files for quota/lifecycle/worktree naming).

**One-time cleanup, then gone:** a single dev-build release path may detect and terminate orphaned legacy tmux sessions on first boot, then the detection code is deleted in the same milestone. No enduring legacy readers.

## Definition of done

1. **Zero production reference:** no source file, package manifest, script, or shipped artifact references tmux (`grep -ri tmux src/ workspace/Sources native/ scripts/ package.json` → only historical docs/ADR mentions, which the doc-cleanup task rewrites as past-tense history).
2. **Live proof on a tmux-less machine:** on a machine (or PATH-sanitized env) with **no tmux binary installed**, a dev build launches Hive, creates a session generation, runs a real vendor TUI, types/scrolls/resizes, closes with positive process-termination readback, and survives daemon restart + renderer reconnect. Recorded (screen capture + transcript) and reproduced by someone other than the author.
3. **Identity migration proven:** agent identity carries exact host locator + generation; no `tmuxSession` field remains in schemas, DB, or wire messages. A spawned agent round-trips spawn → message delivery → status → teardown through the new locator.
4. Full TS suite + typecheck green; Swift tests green; Zig sessiond tests green.
5. **No legacy shims:** review confirms no dual-host flags, no compat writes, no re-introduced tmux fallbacks.
6. **Project-agnostic:** nothing in the replacement wiring assumes the Hive repo, Bun, or any specific project layout; verified by launching the dev build on a non-Hive repository.
7. **Doc-cleanup task (paired, same milestone):** rewrite `docs/daemon/*`, `docs/providers/launch-mechanics.md`, `docs/workspace/*`, `README.md`, `SPEC.md` terminal sections, and `docs/terminal/legacy-terminal-postconditions.md` to describe the new behavior and contracts. **No doc may reference code by file path or line number** — behavior and contracts only.
8. Fresh external research drives; current code state and design docs are reference, not truth (stated here per the rebuild's hard principles).

## External documentation (story must be executed against these, not repo memory)

- tmux(1) manual — server/session/pane model, `send-keys`, `capture-pane`, control mode: the exact surface being excised. https://man.openbsd.org/tmux.1
- POSIX/macOS PTY lifecycle the replacement owns instead: `posix_openpt(3)`, `openpty(3)`/`forkpty(3)` (Apple man pages), `kevent(2)` `EVFILT_PROC` for positive child-exit readback.
- libghostty / libghostty-vt embedding surface (renderer + VT state the replacement uses): https://ghostty.org/docs (and pinned `vendor/ghostty` upstream commit docs).
- Citation pack being verified and expanded by atlas (R2) — fold in before execution.

## Out of scope

SwiftTerm removal (STORY-002); building the replacement (M1 stories 1.x); status/messaging semantics (M2/M3).
