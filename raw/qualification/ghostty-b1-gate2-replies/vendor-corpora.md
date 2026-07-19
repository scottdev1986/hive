# Captured vendor startup/query corpora

These are raw PTY output byte streams, captured without `script(1)` headers or
trailers at 80×24 with `TERM=xterm-ghostty` and `COLORTERM=truecolor`. Each CLI
was terminated by a three-second alarm after its initial display. The files
are inputs to the same real-surface probe as the synthetic controls.

| Corpus | Captured CLI | Bytes | SHA-256 | Queries observed |
| --- | --- | ---: | --- | --- |
| `vendor-claude-code-startup.bin` | Claude Code 2.1.215 | 1363 | `5a597d999d321f9d20aa9b6a83aafea2898efb191eace20ed3ed5e3b5034c125` | XTVERSION (`CSI > 0 q`), DA1 |
| `vendor-codex-cli-startup.bin` | codex-cli 0.144.5 | 3681 | `e4a10935a208de2511ce3368e762615d8ccf67e58255d7fa2b8eea20c70dc19f` | CPR, OSC 10, OSC 11, kitty keyboard, DA1 |
| `vendor-grok-cli-startup.bin` | grok 0.2.103 (`89c3d36fb6f1`, stable) | 1316 | `f2a5de4bf24b47136287d743797f65152b4c4b1c90d0c012cc60986825c1b9fe` | none |

The Claude replay produced two callbacks in query order. The Codex replay
produced five callbacks in query order, including the exact default foreground
and background colors and kitty-keyboard flags after Codex's own mode setup.
The Grok replay produced no callback because it emitted no query; this is
recorded explicitly and is not counted as an answered query. Every vendor
stream is followed on its still-live surface by DA1, which must produce the
exact primary-device-attributes reply once.
