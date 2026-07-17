# STORY-001 — Gut ALL tmux terminal code (complete removal, no legacy shims)

Milestone: M1 (this story is the cut that completes M1)
Backlog position: #1 — ground zero of the rebuild. Written and specified first; **executed at the Removal Gate** (see Sequencing).
State when board access lands: **Ready**

## Why

The tmux stack is the old process host and terminal transport for every Hive agent session. The rebuild's first principle is gut-then-rebuild with no legacy support: every rebuilt system's story sequence begins with removal of the old one. This story is that removal for the terminal.

## Sequencing — explicit and safe (resolves "gut tmux" vs "new terminal functional")

You cannot remove the process host that runs agents before its replacement runs agents. Resolution:

- **Backlog order:** this story is #1. It is fully specified now so every M1 story builds toward its gate, not toward coexistence.
- **Execution order:** this story executes at the **Removal Gate** — the replacement host (sessiond + `SessionHost` backend + HiveTerminalKit renderer) is **live-proven across the full vendor matrix** (atlas second opinion, adopted): real Claude Code, Codex, AND Grok interactive TUIs each exercised live in the new host; daemon restart + renderer reconnect; PTY resize/SIGWINCH; EOF/exit with authoritative `waitpid` reap evidence (kevent EVFILT_PROC is notification, not proof); process-tree containment; sustained-output backpressure (100 MiB class) with no byte loss; crash survival with bounded replay. If ANY matrix cell fails, this story cannot execute. (The matrix needs only the M1 qualification harness launching vendor TUIs manually — not M2's spawn/belief/status pipeline.)
- **Hard cut, not canary:** there is NO dual-host flag, NO `terminal_host=tmux|sessiond` admission ramp, NO compatibility writes, NO quarantined tmux bridge. The reference design doc (terminal-stack-transition, phases T2/T6/T7) prescribes a gradual dual-host canary for a production migration; this rebuild explicitly overrides that with a single cut on a dev build. Between now and the gate, tmux code is frozen — no new callers, no fixes except fleet-critical.
- **Atomic cut with STORY-002 (atlas R3 P0-3, adopted):** the two removal stories overlap (TerminalPaneView/PaneView/LaunchConfig/ProjectState/AgentFeed/scroll/smoke) and their DoDs depend on each other. They execute as ONE atomic Removal Gate merge train — a single cut with explicit internal ordering — and the full vendor matrix is re-run on the post-deletion tree before the cut lands. Two separately-green PRs are NOT acceptable.
- **M1/M2 ownership boundary (atlas R3 P0-2, adopted):** M1 owns generic command launch, PTY byte I/O, locator/lifecycle/recovery, and a neutral test fixture; vendor binaries are launched MANUALLY for terminal qualification. M2 owns provider launch profiles, silent beliefs, approval semantics, authenticated status, and control-message receipt. This story's proofs are therefore generic-session proofs, not agent-pipeline proofs.
- Everything in M1 between now and the gate exists solely to make this cut safe.

## Scope

**Authoritative scope is BEHAVIORAL:** every behavior through which Hive currently touches tmux is removed — session creation/naming, process hosting, byte injection (send-keys/paste), capture/observation, attach/scroll, socket and instance namespacing, teardown/recovery/readiness probing, supervision of orchestrator and agent roots, resource accounting keyed to tmux sessions, DB identity rows, wire/protocol host-kind values (successor protocol and its TS/native/Swift schema mirrors must lose the tmux host kind), provider delivery manifests describing tmux paste/cancel mechanics, launch readiness/watch, instance/handshake/lifecycle/mutation/quota/worktree namespace helpers, Workspace app argument parsing and lifecycle semantics (orchestrator session/socket, attach command, pane-close-vs-agent-kill, quit), CLI→Workspace launcher state, generated fixtures/snapshots, release/package/notarization contents, and third-party licenses/notices. (Expanded per atlas R3 P1.)

**At execution:** regenerate a fresh exact-reference inventory of files/symbols and attach it to the story as EPHEMERAL evidence. The file list below is a snapshot (repo survey 2026-07-17) kept as scoping evidence only — behaviors above are authoritative, paths go stale.

**Primarily-tmux source (~1,677 LOC), delete entirely:**
- `src/adapters/tmux.ts` — TmuxAdapter/TmuxEngine/TmuxRunner CLI wrapper (new-session, capture-pane, send-keys, sockets, quoting).
- `src/daemon/session-host/tmux-host.ts` — TmuxSessionHost, the sole `SessionHost` implementation.
- `src/daemon/tmux-sessions.ts` — tmux session-naming conventions (widely imported; see rewiring).
- tmux minting in `src/daemon/session-host/locators.ts`.

**Embedded call sites, rewire to the replacement `SessionHost` backend (~40 files):** `src/daemon/server.ts` (holds `this.tmux`), `delivery.ts` (send-keys input path), `spawner-impl.ts` (spawns into tmux sessions), `teardown.ts`, `recovery.ts`, `readiness.ts`, `orchestrator-root-delivery.ts`, `launch-prompt.ts`, `src/cli/{control,daemon,workspace,orchestrator,start,uninstall,project-config-cleanup,orchestrator-brief}.ts`, provider adapters importing `hiveInstanceSuffix`, `src/schemas/{session-protocol,agent}.ts` (`tmuxSession` identity field → exact host locator + generation).

**Swift app tmux path:** `tmux attach-session` exec and `TmuxScrollController` in `workspace/Sources/HiveWorkspace/TerminalPaneView.swift`, tmux fields in `PaneView.swift`/`LaunchConfig.swift`/`ProjectState.swift`/`AgentFeed.swift`/`TerminalScroll.swift`, tmux driving in `SmokeRunner.swift` and `workspace/scripts/smoke.sh`. (The SwiftTerm renderer itself is STORY-002.)

**Tests:** delete `src/adapters/tmux.test.ts`, `tmux-boundary.test.ts`, `src/daemon/session-host/tmux-host.test.ts`, `src/daemon/tmux-sessions.test.ts` (~1,074 LOC); rework tmux-coupled assertions in ~14 other suites (spawner-impl, server, delivery, recovery, control, idle-reap, e2e-real, teardown, db, multi-instance.live, Swift ProjectStateTests/WorkspaceFeedWireContractTests).

**The seam is replaced or revalidated, never presumed kept (atlas R3 P0-1, adopted):** the current `SessionHost` contract is NOT neutral — it embeds Hive instance identity, root/agent subjects, a closed claude|codex|grok provider enum, worktree/repository language, readOnly/capabilityEpoch/launchGrant policy, Workspace visibility revisions, and a tmux|sessiond hostKind. Story M1-A0 audits and re-derives the terminal-host boundary from external PTY/session behavior: the host boundary accepts opaque session identity + argv/cwd/env/fds/geometry and exposes byte I/O, resize, attach/replay, inspect/exit/reap; Hive agent/provider/grant/worktree/Workspace policy lives in the adapter/control plane above it. Session/instance NAMING helpers lose their tmux identity; their instance-suffix semantics are re-homed (~20 non-terminal importers).

**Pre-cut drain by the OLD build — no cleanup code in the new build (atlas R3 P0-4, adopted):** a tmux-less new build cannot reliably enumerate or kill legacy tmux sessions, and shipping cleanup code is a hidden compat reader. Instead: the old/bootstrap build performs the drain BEFORE the cut — the cut is refused while any legacy session or process survives; emptiness is positively proven (live tmux server query + process-table readback, not absence-of-error); incompatible dev DB/runtime state is archived and destructively RESET (dev rebuild — persistent agent rows carry mandatory tmux identity and are not migrated). The new build ships with zero legacy readers.

## Definition of done

1. **Zero production reference:** no source file, package manifest, script, or shipped artifact references tmux (`grep -ri tmux src/ workspace/Sources native/ scripts/ package.json` → only historical docs/ADR mentions, which the doc-cleanup task rewrites as past-tense history).
2. **Live proof on a tmux-less machine:** on a machine (or PATH-sanitized env) with **no tmux binary installed**, a dev build launches Hive, creates a session generation, runs each of the three real vendor TUIs (manually launched — M1 boundary), types/scrolls/resizes, closes with positive process-termination readback (waitpid evidence), and survives daemon restart + renderer reconnect. Recorded (screen capture + transcript) and reproduced by someone other than the author. Matrix re-run on the post-deletion tree (atomic cut).
3. **Identity replacement proven at the generic-session level (M1 boundary per atlas R3 P0-2):** session identity carries exact host locator + generation; no tmux host kind or `tmuxSession` field remains in schemas, DB, successor protocol, or its TS/native/Swift mirrors. A generic session round-trips create → byte input → inspect → terminate through the new locator. (The full agent spawn→message→status→teardown round-trip is M2 scope and does NOT gate this story.)
4. Full TS suite + typecheck green; Swift tests green; Zig sessiond tests green.
5. **No legacy shims:** review confirms no dual-host flags, no compat writes, no re-introduced tmux fallbacks.
6. **Project-agnostic:** nothing in the replacement wiring assumes the Hive repo, Bun, or any specific project layout; verified by launching the dev build on a non-Hive repository.
7. **Doc-cleanup task (paired, same milestone):** rewrite `docs/daemon/*`, `docs/providers/launch-mechanics.md`, `docs/workspace/*`, `README.md`, `SPEC.md` terminal sections, and `docs/terminal/legacy-terminal-postconditions.md` to describe the new behavior and contracts. **No doc may reference code by file path or line number** — behavior and contracts only.
8. Fresh external research drives; current code state and design docs are reference, not truth (stated here per the rebuild's hard principles).

## External documentation (story must be executed against these, not repo memory)

Verified by atlas 2026-07-17 (official sources; local binaries agree):
- tmux(1) manual — server/client/session/window/pane lifetime model and command contracts; enumerate every responsibility being replaced, not just UI calls. https://man.openbsd.org/tmux.1
- tmux official wiki — send-keys/capture-pane semantics being removed: https://github.com/tmux/tmux/wiki/Advanced-Use ; control-mode responsibilities (verify no hidden orchestration dependency remains): https://github.com/tmux/tmux/wiki/Control-Mode
- macOS PTY/process lifecycle the replacement owns instead: openpty/login_tty/forkpty (https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/openpty.3.html and current mirror https://keith.github.io/xcode-man-pages/openpty.3.html), posix_openpt lifecycle (https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/posix_openpt.3.html), termios/job control (https://keith.github.io/xcode-man-pages/termios.4.html), kevent EVFILT_PROC as notification only (https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kevent.2.html), waitpid as the authoritative exit/reap evidence (https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/waitpid.2.html), execve fd/controlling-tty inheritance + KERN_ARGMAX/E2BIG — query the limit at runtime, never bake it (https://keith.github.io/xcode-man-pages/execve.2.html).
- libghostty embedding surface: https://ghostty.org/docs/about ; upstream header caveat — the embedding API is "not general-purpose yet" (sole consumer: the Ghostty macOS app), so pin the commit, wrap behind a Hive-owned adapter, gate on ABI/behavior tests, never promise a stable upstream ABI: https://github.com/ghostty-org/ghostty/blob/main/include/ghostty.h ; libghostty-vt (API unstable): https://libghostty.tip.ghostty.org/

## Out of scope

SwiftTerm removal (STORY-002); building the replacement (M1 stories 1.x); status/messaging semantics (M2/M3).
