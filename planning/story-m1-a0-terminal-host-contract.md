# M1-A0 — Terminal-host contract audit & freeze

Milestone: M1, track A. Board item PVTI_lAHOBUNSMM4BdtCrzgzO5RE.
Origin: atlas R3 P0-1 (the current `SessionHost` seam is not neutral). Contract semantics below from atlas's A0 pre-review (2026-07-17), adopted in full.
Status: fully specified. Execution RATIFIED — user approval granted 2026-07-20 (backlog-outline.md ratified header + digest preamble ruling P1), scoped to `main@0b604f6e`; prior execution 2026-07-17→2026-07-20 retroactively ratified.

## Why

The current contract embeds Hive instance identity, root/agent subjects, a closed provider enum, worktree/grant/Workspace policy, and a tmux hostKind. A2 must build against an externally-derived, frozen, project-agnostic boundary — never today's unproven seam. The boundary is behavior-level and implementation-neutral: freeze externally observable invariants and evidence, not syscalls. Do NOT expose forkpty/setsid/TIOCSCTTY/TIOCSWINSZ as caller knobs; the native implementation stays free to use a safer spawn mechanism (in a multithreaded host only async-signal-safe child-side work is permitted after fork — an isolated spawner/monitor is materially safer than arbitrary child setup in the AppKit/daemon process; see pthread_atfork, posix_spawn close-on-exec).

## Boundary direction

Host accepts opaque session identity + command{executable, argv, cwd, completeEnv, fdMap} + terminal profile + initial winsize; exposes byte I/O, resize, attach/replay, inspect, exit/reap evidence, termination. ALL Hive agent/provider/grant/worktree/Workspace policy lives above the seam.

## P0 contract semantics (must-express before the freeze)

1. **PTY/job-control creation invariant** — not merely argv/cwd/env/fds/geometry: child enters a new session as session leader; the slave PTY is its controlling terminal; stdin/stdout/stderr name that same slave; foreground process group is valid; initial termios profile and all four winsize fields applied BEFORE exec. openpty/forkpty/login_tty are implementation options, not API vocabulary (login_tty creates session+ctty+stdio; opening a tty alone never acquires a controlling terminal).
2. **Exec proof** — forkpty success proves fork, not exec. create returns {running, exec_failed, exited, unknown} and claims running only after an exec handshake/readback. Typed errno/layer for invalid executable, cwd, env/ARG_MAX, fd setup, controlling-tty setup. PID existence is never equated with the expected executable.
3. **ABA fencing on opaque identity** — host-issued incarnation/generation token; every attach/write/resize/terminate carries it. create idempotency so retry after uncertain transport failure cannot double-exec. PID identity always includes a start token, never PID alone.
4. **fd transfer semantics** — integer fds are process-local; define transferable handles (SCM_RIGHTS or equivalent), target-fd mapping, ownership/dup/close rules, close-on-exec default; only explicitly mapped descriptors survive exec. Environment is a COMPLETE vector (or overlay + explicit unset) — no ambient inheritance surprises.
5. **Parenthood/reap authority** — waitpid is child-only; reparenting after forker death breaks truthful reap. Choose: durable per-session monitor remains the vendor's parent and journals wait status (broker restart/adopts the monitor), OR host crash yields typed lost/unknown exit authority + survivor cleanup. Exit evidence: {source: waitpid|parent-journal|unavailable, code/signal, reaped, completeness}. kevent/PID absence is notification, never reap proof.
   - **RULED 2026-07-20:** durable per-session monitor — a watcher process remains the vendor's parent, journals wait status, and broker restart adopts the monitor; the typed-loss-on-host-crash alternative is rejected. Freeze test G must prove the monitor: kill the broker mid-session, restart, and confirm exit evidence is intact.
6. **Output and exit are independent ordered facts** — raw bytes (not assumed UTF-8), byte offsets/event sequence, tail-drain semantics (child may exit with unread PTY output). Replay does not close at waitpid until master EOF/error/drain policy resolves; output_closed reported separately from process_exited/reaped.
7. **Resize is an ordered mutation** — rows/cols/xpixel/ypixel + expected incarnation + idempotency/revision. Receipt proves ioctl applied + TIOCGWINSZ readback, NOT that the TUI handled SIGWINCH. Coalescing allowed; live proof shows the foreground process observes final geometry. Ordering defined relative to writes/attach — resize and input cannot silently reorder.
8. **Flow control/backpressure in the contract** — partial/EINTR/EAGAIN reads/writes; bounded input queues; termios IXON/IXOFF can stop/start output. Bounded credit/ack (or equivalent), journal low/high watermarks, explicit gap/overflow (never silent loss), max write/frame sizes; write-receipt words precise: accepted/queued/written-to-master ≠ consumed by child. Decide whether TIOCPKT control events are internal or typed control frames.
   - **RULED 2026-07-20:** packet-mode (TIOCPKT) events are INTERNAL, not typed contract frames; flow-control facts are expressed only through the frozen receipt/gap/watermark vocabulary. Concrete numeric caps/watermarks are OWNED by the A1 wire projection (the contract stays behavioral). Freeze test E's pass bound = memory stays under the configured watermark ceiling, and that ceiling is sized against the 16 GB hardware floor (base 14" MacBook Pro M1 Pro).
9. **Attach/replay is a resumable cursor, not a boolean** — protocol/build capability negotiation; checkpoint content-type/schema/hash + checkpoint/output sequence; resume-from sequence; bounded retention; explicit gap requiring full checkpoint. Checkpoints opaque/versioned — the host contract does not bake Ghostty structs. Mid-escape/mid-UTF-8 disconnect replays without duplicate or loss.
10. **Input arbitration ≠ write(bytes)** — generic writer claim/lease/token + ordered transaction/idempotency + synchronous human-claim acquisition. These are terminal concurrency semantics, not Hive policy. Key-to-byte encoding stays renderer-side.
11. **Termination is a required INPUT** — graceful vs immediate; target semantics (foreground pgrp / session / process tree); deadline/idempotency; result includes survivors. Closing the PTY is hangup, not generic half-close; VEOF is canonical-mode-only (ordinary data in raw mode) — PTY input is not a socket.
12. **Inspect exposes honest evidence/completeness** — lifecycle state; host/child pid+start token; sid/pgid/foreground pgid/tty identity; geometry+revision; output/checkpoint retained ranges; input owner; exit/reap authority; descendants/survivors; evidence time/diagnostics. Transport failure ⇒ unknown, never absent/exited.

## Minimal shape (semantic, not prescribing method count)

- create(opaqueKey, idempotencyKey, command{executable,argv,cwd,completeEnv,fdMap}, terminalProfile, initialWinsize) → incarnation + launch evidence
- claim/releaseInput; write(bytes, transaction, claim, incarnation)
- resize(winsize, revision, incarnation)
- attach/resume(cursor, capabilities, incarnation); ackOutput
- inspect/list; subscribe ordered events
- terminate(mode, target, deadline, idempotency, incarnation)
- outputs: raw data/control frames, checkpoint/replay metadata, lifecycle/exit/reap evidence, receipts with completeness.

## Live freeze tests (the contract freezes only when these pass on a neutral fixture AND real sessiond)

A. Fixture proves isatty(0/1/2), same tty, new sid, foreground pgid, initial geometry present before first user instruction.
B. Nonexistent exec / invalid cwd / oversize env / unmappable fd ⇒ typed exec failure, no ghost running session; Unicode/spaces + non-git cwd work (project-agnostic).
C. fd-leak test: only declared fds survive; transferred-fd ownership/closure deterministic.
D. Burst resizes interleaved with input: ioctl readback + trapped SIGWINCH/final geometry, monotonic revisions, no reordered bytes.
E. 100 MiB producer + slow/disconnected viewer + XOFF/XON: no byte loss, bounded memory, explicit backpressure/gap.
F. Child emits tail bytes then exits (normal and by signal): full tail replays; output_closed, exited, waitpid-reaped observed separately.
G. Broker restart with live durable parent reconnects; parent/monitor death produces typed loss, never fabricated exit.
H. Attach disconnects mid-escape and mid-multibyte-UTF-8, resumes from checkpoint/cursor exactly once.
I. Concurrent human+automation writes: claim fencing, idempotent retry, no interleaving.
J. Descendant creates new pgrp/session; immediate terminate either kills it or reports it as survivor — signal delivery alone is not success.
K. Canonical VEOF vs raw ^D vs PTY close/hangup are distinguished.

## Primary sources (verified by atlas 2026-07-17)

- Apple openpty/login_tty/forkpty: https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/openpty.3.html
- Darwin termios (job control, controlling tty, nonblocking, EOF, signals, flow control): https://keith.github.io/xcode-man-pages/termios.4.html
- tcsetpgrp (foreground pgrp): https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/tcsetpgrp.3.html
- pty packet-mode control events: https://keith.github.io/xcode-man-pages/pty.4.html
- waitpid (child-only, reparenting, reap): https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/waitpid.2.html
- pthread_atfork (post-fork restrictions in multithreaded code): https://keith.github.io/xcode-man-pages/pthread_atfork.3.html
- posix_spawn close-on-exec option: https://keith.github.io/xcode-man-pages/posix_spawnattr_setflags.3.html
- execve (limits, fd inheritance): https://keith.github.io/xcode-man-pages/execve.2.html
- kevent is notification, not reap: https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kevent.2.html

## Definition of done

1. Contract document (behavior/contracts only — no file paths/line numbers) expressing all 12 semantics and the minimal shape, versioned, with conformance-test IDs mapped to freeze tests A–K.
   - **RULED 2026-07-20:** FULL coverage before freeze. Add dedicated freeze tests for semantic 3 (ABA/idempotency fencing), semantic 11 (termination modes/deadline/survivors), and semantic 12 (inspect completeness); the semantic→test mapping must be complete before the contract is declared frozen.
2. Freeze tests A–K pass live against a neutral fake AND real sessiond; results recorded with exact versions.
3. Non-Hive consumer demo (generic command, non-agent, non-Hive repo cwd) runs through the frozen boundary — project-agnostic proof.
4. A2 declared unblocked only at freeze; deep A1 qualification continues in parallel.
5. Hard principles apply (external research drives; no legacy shims; production-grade; live proof; paired doc-cleanup).
