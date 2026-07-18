# M1-A1 sessiond qualification

Status: the contract-freeze-facing minimum, PTY/reap qualification, and production lifecycle wire have landed. Frozen claim, transactional input, and resize receipts are projected onto the production host wire in the current review increment. Attach streaming, visibility renewal, crash/adoption, and bounded replay qualification remain open.

## Qualified behavior

- Launch is an outcome, not an inferred success. A failed replacement reports the failing layer and the operating-system error number. A running outcome is emitted only after the close-on-exec barrier proves replacement.
- Descriptor transfer is allowlisted. The caller retains its source descriptor, the child receives a duplicate at the declared target, standard streams remain attached to the PTY, and every other inherited descriptor is closed before replacement.
- Resize is a revisioned ordered mutation. Revisions must increase, input accepted earlier is written before the resize, and success returns the geometry read back from the terminal after the set operation. The receipt does not claim that a foreground application handled `SIGWINCH`.
- PTY creation produces one master/slave pair. The replacement becomes a new session and process-group leader, receives the slave as all three standard streams and controlling terminal, starts in the foreground process group, and observes the requested initial geometry.
- A process event is notification, not exit proof. Exit evidence is authoritative only when the host, as direct parent, obtains the status from `waitpid`. A nonblocking wait distinguishes a running child from an unavailable wait authority; `ECHILD` is reported as unknown rather than fabricated into an exit.
- Process-tree termination cannot consume the root child's wait status behind the PTY owner's back. Root waits are routed through the owner, and successful immediate termination persists a positive direct-child wait observation.
- The production broker dispatches inventory, exact-locator inspection, and termination instead of collapsing those defined operations to not-found. Inventory preserves enumeration completeness; registry-only inspection marks unavailable host-owned arbiter and checkpoint facts as partial rather than inventing them; termination reports success only after the registry receives positive host and process-tree readback.
- The production host wire validates strict frozen claim, input-receipt, and resize-receipt projections after an authenticated exact-locator attachment. A domain transaction ID controls input idempotency independently of the transport request ID, and the advertised decoded-input cap is enforced before any PTY effect.
- Input claims distinguish a grant, a denial with the real current owner, and an unavailable arbiter without fabricating ownership. Bytes receive an applied receipt only after ordered PTY write and drain; an identical retry replays that receipt without writing twice. Canonical EOF is accepted only when the live terminal attributes make the configured EOF byte meaningful, while hangup closes the real PTY endpoint.
- Wire resize applies the requested revision through the PTY owner and returns the actual post-`TIOCSWINSZ` `TIOCGWINSZ` readback. An identical transaction replays its receipt without another mutation.

## Live conformance evidence

Environment: macOS 26.3.1 (25D2128), arm64; locked Zig 0.15.2.

| Freeze case | Live proof | Result |
| --- | --- | --- |
| B — exec proof | Replacement of a nonexistent executable returned layer `exec-transition` with `ENOENT` (2); replacement of a real non-executable file returned the same layer with `EACCES` (13). Neither produced a running host, live PID, or open PTY master. | Pass |
| C — descriptor transfer | A pipe declared for target descriptor 9 delivered its payload in the replaced process while the caller's source remained open. | Pass |
| C — descriptor hygiene | An arbitrary descriptor was made intentionally inheritable before launch; the replaced process positively observed that it was absent. | Pass |
| D — ordered resize | Revision 41 applied rows 37, columns 111, and both pixel dimensions. An independent `TIOCGWINSZ` matched every receipt value. Input accepted next preceded revision 42, its ordered position increased, and replaying revision 42 was rejected as stale. | Pass |
| A — PTY lifecycle | A real replacement reported PID = session ID = process-group ID. `TIOCGPGRP` on the live master returned that group, the child observed descriptors 0, 1, and 2 as terminals, and `stty` read back the requested 37-by-111 geometry. | Pass |
| F — notify then reap | A real `EVFILT_PROC`/`NOTE_EXIT` event arrived for a child exiting 23. The event was followed by a separate direct-parent `waitpid`, which returned the same child's status and produced typed exited/reaped evidence. | Pass |
| F — lost authority | A deliberate competing `waitpid` consumed a child exiting 29. The PTY owner's subsequent wait observed `ECHILD` and returned unavailable/unknown with no invented exit code. | Pass |
| Termination evidence | A real provider tree was terminated while an unrelated sentinel process survived. The immutable terminal result reported no survivors and a positive root wait observation. | Pass |
| Production broker lifecycle wire | A framed production-backend connection returned correlated, schema-valid inventory, exact inspection, and termination responses for one admitted generation. The same operations then ran against a real recovered sessiond host; exact provider and host PIDs became absent and immutable final evidence remained positive. | Pass |
| Resize discriminator promotion | The formerly expected-failure resize shape discriminator now runs as an ordinary passing assertion, so a genuine resize receipt/readback regression is a normal suite failure rather than an expected failure or XPASS. | Pass |
| Claim wire | An authenticated real-host attachment acquired a claim, replayed the holder truthfully, and denied a competing automation claimant with the live holder token. A separate unbound-host control returned unknown without an owner field. | Pass |
| Transactional input wire | A framed byte transaction wrote one line through a real PTY. Retrying the same domain transaction under a different transport request ID returned the identical frozen receipt, and the provider-side file still contained exactly one line after the retry. | Pass |
| Resize wire | A framed resize applied revision 41 to a real PTY and returned rows 37 and columns 111 from the post-set terminal readback. | Pass |
| EOF and hangup | Canonical EOF against the real raw-mode provider was rejected because the terminal was not canonical and the provider remained live. A real PTY accepted hangup only after draining, closed its master, and produced direct-child reap evidence. | Pass |

Positive controls were observed before the production changes: the focused freeze discriminator step reported 0/4 passing, and the live termination test observed a terminated tree whose root wait evidence had been lost. For the transactional input increment, removing the production `INPUT_SUBMIT` dispatch while retaining the real-host control failed at the expected APPLIED response; restoring it made the same control pass. The strengthened behavioral discriminators and the complete native suite pass after the changes.

## External basis

- Darwin `execve(2)` says descriptors survive replacement unless close-on-exec is set, the controlling terminal is inherited, failure returns `-1` with the real `errno`, and specifically defines `ENOENT` and `EACCES`: [Xcode execve(2)](https://keith.github.io/xcode-man-pages/execve.2.html).
- Darwin `fcntl(2)` defines `FD_CLOEXEC` as automatic closure in the successor image: [Xcode fcntl(2)](https://keith.github.io/xcode-man-pages/fcntl.2.html). Apple's spawn file actions likewise document the close-by-default allowlist model and explicit descriptor inheritance: [Xcode spawn file actions](https://keith.github.io/xcode-man-pages/posix_spawn_file_actions_addopen.3.html).
- Darwin terminal job control requires an explicit controlling-terminal association for the new session, and defines the configured EOF character as meaningful input only in canonical mode: [Xcode termios(4)](https://keith.github.io/xcode-man-pages/termios.4.html).
- Darwin defines `TIOCSWINSZ` as setting all window-size fields and `TIOCGWINSZ` as returning the terminal's associated size: [Xcode tty(4)](https://keith.github.io/xcode-man-pages/tty.4.html).
- Apple's `openpty(3)` defines creation of the master/slave pair and application of initial terminal attributes and window size: [Apple openpty(3)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/openpty.3.html).
- Apple's `kevent(2)` defines `EVFILT_PROC` process events, including `NOTE_EXIT`, as filter notifications. It separately documents `NOTE_REAP` for the later parent reap: [Apple kevent(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kevent.2.html).
- Apple's `waitpid(2)` makes wait status a parent/child operation, defines zero from `WNOHANG` as still running, and defines `ECHILD` when the requested child is unavailable to the caller: [Apple waitpid(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/waitpid.2.html).
- Ghostty describes `libghostty-vt` as the terminal-sequence parser and terminal-state layer. That boundary supports keeping PTY/process lifecycle evidence outside VT parsing rather than treating parser state as process evidence: [Ghostty](https://github.com/ghostty-org/ghostty).

## Remaining A1 qualification

The next increment must wire attach streaming and visibility renewal, then exercise broker/host crash and adoption matrices and bounded journal/replay behavior.
