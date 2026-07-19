# Gate 5 dispositions — fraser round-3 (#2 volume)

## Control #2 (100 MiB) — volume bytes in the sink

Each block is a screenful of **full-width unique rows** (`cols-1` load-bearing
characters per row; no strip-able padding). After feed, `readScreen` rows must
**equal the full generated rows** (every volume byte). Clear; next block.

- Mutating any volume byte fails full-row equality.
- Negative control `testVolumeByteLossControlFailsOnSingleVolumeByteMutation`
  flips one mid-row byte and asserts inequality (fraser counterexample).

## Already closed

1. Draw/restore serialization  
3. APC Kitty OK reply + split==unsplit  
4. Concurrent attempted counter before release  
