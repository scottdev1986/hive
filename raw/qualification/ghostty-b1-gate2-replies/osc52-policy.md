# OSC 52 clipboard policy

Hive's manual Ghostty surface denies terminal-controlled clipboard reads,
writes, and clears. Untrusted remote output must not move bytes across the host
clipboard boundary.

## Read requests: deny silently

Read denial is engine-enforced at two layers, in this order:

1. The pinned manual terminal handler in `stream_terminal.zig` treats the
   single-byte `?` payload as a read and returns before invoking any clipboard
   effect. This is the primary drop for manual remote-output parsing.
2. The probe loads `clipboard-read = deny` into the Ghostty config with zero
   diagnostics. Ghostty's `Surface` deny gate is therefore armed as
   defense-in-depth if a future parser path forwards an OSC 52 read farther.

The corpus proves the enforcement by behavior, not only by reading those code
paths. Its positive control drives the trusted `paste_from_clipboard` binding
action through the real surface; that action reaches the same
`read_clipboard_cb` counter exactly once. The callback returns false, so the
binding action itself reports false, as expected. After that biting control,
both `OSC 52 ; c ; ? BEL` and `OSC 52 ; c ; ? ST` leave the counter unchanged,
emit no terminal reply, and are followed by an exact-once DA1 reply through
the write callback. The denial therefore does not rely on the host stub's
false return, a dead callback counter, or a disconnected reply channel.

The result is that remote output cannot cause the host reader to return
base64-encoded clipboard content to the remote program.

## Write and clear requests: deny visibly to the host

For a valid base64 write (`OSC 52 ; c ; SGVsbG8= ST`) and a clear request
(`OSC 52 ; c ; ST`), the surface does not mutate a host clipboard and emits no
protocol reply. It emits `HIVE_GHOSTTY_EVENT_CLIPBOARD_DENIED` (numeric event
5) so trusted host UI may explain the rejection. Both records require that
event and then prove the write callback live with an exact-once DA1 response.

Clipboard operations deliberately initiated by a user through trusted host UI
are outside the OSC 52 remote-output path. This policy does not prohibit such
host-side copy/paste; it prohibits terminal escape sequences from reading or
mutating host clipboard state.
