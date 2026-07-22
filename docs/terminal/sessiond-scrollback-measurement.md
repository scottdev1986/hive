# sessiond scrollback measurement

Measured on 2026-07-22 against the vendored libghostty-vt engine, using an
80-column, 24-row terminal and an 80,000-line fixed-width text corpus.

`GhosttyTerminalOptions.max_scrollback` is a byte budget. The public C header's
line-oriented wording is contradicted by Ghostty's `terminal/Screen.zig`
implementation and by the retained-state measurements below.

| `max_scrollback` | Rows after feed | History rows | Checkpoint payload |
| --- | ---: | ---: | ---: |
| `50_000` | 807 | 783 | 821,859 bytes |
| `48 * 1024 * 1024` | 71,727 | 71,703 | 50,015,739 bytes |

The 48 MiB checkpoint restored to exactly 71,727 rows through both the
headless libghostty-vt restore path and the GhosttyKit renderer. These row
counts describe this corpus, not a product line guarantee: wrapping, cell
attributes, grapheme width, images, and geometry all change rows retained per
byte.

The replay journal and checkpoint bridge preserve continuity across attach,
but they are not additive visible history. After reattach, visible scrollback
is capped by the terminal-state byte budget restored into the renderer.

The 50,015,739-byte non-image payload also proves that a 48 MiB scrollback
budget consumes nearly all of the 64 MiB checkpoint payload ceiling before
active-screen metadata or the separate 16 MiB image allowance. Root cutover
therefore requires an explicit lower budget/headroom decision and a combined
worst-case checkpoint regression; the measurement does not claim that the
current split is reattach-safe.
