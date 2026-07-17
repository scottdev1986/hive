# M1-A1 sessiond qualification

Status: the contract-freeze-facing minimum is qualified for review. This increment covers freeze cases B, C, and D only. The deeper PTY lifecycle, reap-authority, crash/adoption, termination, and bounded replay qualification remains open.

## Qualified behavior

- Launch is an outcome, not an inferred success. A failed replacement reports the failing layer and the operating-system error number. A running outcome is emitted only after the close-on-exec barrier proves replacement.
- Descriptor transfer is allowlisted. The caller retains its source descriptor, the child receives a duplicate at the declared target, standard streams remain attached to the PTY, and every other inherited descriptor is closed before replacement.
- Resize is a revisioned ordered mutation. Revisions must increase, input accepted earlier is written before the resize, and success returns the geometry read back from the terminal after the set operation. The receipt does not claim that a foreground application handled `SIGWINCH`.

## Live conformance evidence

Environment: macOS 26.3.1 (25D2128), arm64; locked Zig 0.15.2.

| Freeze case | Live proof | Result |
| --- | --- | --- |
| B — exec proof | Replacement of a nonexistent executable returned layer `exec-transition` with `ENOENT` (2); replacement of a real non-executable file returned the same layer with `EACCES` (13). Neither produced a running host, live PID, or open PTY master. | Pass |
| C — descriptor transfer | A pipe declared for target descriptor 9 delivered its payload in the replaced process while the caller's source remained open. | Pass |
| C — descriptor hygiene | An arbitrary descriptor was made intentionally inheritable before launch; the replaced process positively observed that it was absent. | Pass |
| D — ordered resize | Revision 41 applied rows 37, columns 111, and both pixel dimensions. An independent `TIOCGWINSZ` matched every receipt value. Input accepted next preceded revision 42, its ordered position increased, and replaying revision 42 was rejected as stale. | Pass |

Positive controls were observed before the production change: the focused real-host discriminator step reported 0/4 passing. The strengthened behavioral discriminator step and the complete native suite pass after the change.

## External basis

- Darwin `execve(2)` says descriptors survive replacement unless close-on-exec is set, the controlling terminal is inherited, failure returns `-1` with the real `errno`, and specifically defines `ENOENT` and `EACCES`: [Xcode execve(2)](https://keith.github.io/xcode-man-pages/execve.2.html).
- Darwin `fcntl(2)` defines `FD_CLOEXEC` as automatic closure in the successor image: [Xcode fcntl(2)](https://keith.github.io/xcode-man-pages/fcntl.2.html). Apple's spawn file actions likewise document the close-by-default allowlist model and explicit descriptor inheritance: [Xcode spawn file actions](https://keith.github.io/xcode-man-pages/posix_spawn_file_actions_addopen.3.html).
- Darwin terminal job control requires an explicit controlling-terminal association for the new session: [Xcode termios(4)](https://keith.github.io/xcode-man-pages/termios.4.html).
- Darwin defines `TIOCSWINSZ` as setting all window-size fields and `TIOCGWINSZ` as returning the terminal's associated size: [Xcode tty(4)](https://keith.github.io/xcode-man-pages/tty.4.html).

## Remaining A1 qualification

The next increment must qualify PTY creation alternatives, prove `waitpid` as exit/reap authority while treating process filters as notification only, exercise broker/host crash and adoption matrices, verify termination survivors, and qualify bounded journal/replay behavior against the frozen cases.
