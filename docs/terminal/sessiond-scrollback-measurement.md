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
| `48 * 1024 * 1024`, transactional resize to 500×500 | 71,727 | 71,227 | 309,929,873 bytes |

The 48 MiB checkpoint restored to exactly 71,727 rows through both the
headless libghostty-vt restore path and the GhosttyKit renderer. These row
counts describe this corpus, not a product line guarantee: wrapping, cell
attributes, grapheme width, images, and geometry all change rows retained per
byte.

The replay journal and checkpoint bridge preserve continuity across attach,
but they are not additive visible history. After reattach, visible scrollback
is capped by the terminal-state byte budget restored into the renderer.

The production `session_host` path uses the streaming producer. Its combined
500×500 case crosses the former 64 MiB allocating-export ceiling by
242,821,009 bytes. The 309,929,873-byte terminal payload plus the separately
pinned 16,777,216-byte renderer image allowance totals 326,707,089 bytes,
leaving 210,163,823 bytes (200.428 MiB) beneath the streamed 512 MiB
semantic/import ceiling. The native regression restores the exact row counts
above through libghostty-vt. The Gate 6 cross-library fixture uses the same
80,000-line corpus, limits, geometry, and streaming ABI; its arm64 payload is
309,923,825 bytes and restores successfully into the real GhosttyKit renderer.
