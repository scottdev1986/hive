# OSC 52 clipboard policy

Hive's manual Ghostty surface denies terminal-controlled clipboard reads,
writes, and clears. Untrusted remote output must not move bytes across the host
clipboard boundary.

## Read requests: deny silently

For `OSC 52 ; c ; ? BEL` and `OSC 52 ; c ; ? ST`, the surface does not call a
host clipboard reader and emits no terminal reply. In particular, it never
returns base64-encoded host clipboard content to the remote program. The two
read variants in `live-proof.jsonl` each observe zero write callbacks and then
observe the exact DA1 response once through that same callback. Their silence
is therefore a measured denial, not an empty or disconnected observation
channel.

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
