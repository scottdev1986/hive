# Cross-vendor review — DA3 (tertiary device attributes) reply fix

- **Pin reviewed:** `08c486fe` "Fix tertiary device attributes reply" (frozen; HEAD not moved)
- **Author:** edwin (Codex / gpt-5.6-sol)
- **Reviewer:** eileen (Claude / Opus 4.8) — different vendor, build-capable
- **Verdict: PASS — land authorized at `08c486fe`**

Materialized via `git archive 08c486fe` into a private scratch tree (never the
author's worktree), with an APFS-cloned warm zig cache from a sibling. The
vendored `vendor/ghostty` tree came from the archive, not a symlink to the
primary checkout, so the tree under test is the pin's patched tree
`a27fc0e76555552cf7202c98fb1a31b2021bcf26`.

## 1. Root cause and fix correctness — CONFIRMED

Gate 2 inserted two lines into `vendor/ghostty/src/terminal/stream_terminal.zig`:

```zig
// Match Ghostty's exec-mode handler: tertiary DA is unsupported.
if (req == .tertiary) return;
```

The rationale was factually accurate about exec mode —
`src/termio/stream_handler.zig:834` `deviceAttributes` handles only `.primary`
and `.secondary` and logs `unimplemented device attributes req` for anything
else — but it was applied in the wrong place. `stream_terminal.zig` is
*pristine upstream Ghostty code*, and upstream implements all three DA levels
and ships its own test for DA3. The suppression short-circuited before
`Attributes.encode` + `writePty`, so the upstream test's `S.written` stayed
null and `S.written.?` panicked with "attempt to use null value".

Two facts confirm this is a revert, not a mask:

- The patch series at the pin **no longer touches `reportDeviceAttributes` at
  all** (`grep reportDeviceAttributes 0002-hive-terminal-reply-effects.patch`
  returns nothing). The function is byte-identical to upstream again.
- The failing test is **upstream's**, not hive's — `"device attributes:
  tertiary DA"` does not appear anywhere in the patch series.

So the fix restores shared upstream code that hive had no business narrowing.
A terminal *should* answer DA3; suppressing it leaves a querying program
waiting on a reply that never comes. If hive ever genuinely wanted DA3 silent
for its own surface, the place for that is the effects layer in
`embedded.zig`, not upstream's shared handler.

Note the divergence this leaves is in the *right* direction: the hive manual
surface now answers DA3 while Ghostty's legacy exec-mode handler still does
not. DA1/DA2 remain deliberately identical to exec mode — exec mode replies
`\x1B[?62;22c` / `\x1B[>1;10;0c`, and the hive effect returns
`conformance_level = .vt220` + `ansi_color` and `firmware_version = 10`, which
encode to the same bytes.

**Wire format verified against the specs, not from memory:**

- DEC VT510 `DECRPTUI` (vt100.net): `DCS ! | D...D ST`, where `D...D` is
  8 hex digits (a two-digit site code plus a six-digit unit number).
- Ghostty's `Tertiary.encode` prints `"\x1bP!|{X:0>8}\x1b\\"` — `ESC P` (7-bit
  DCS), `!`, `|`, eight uppercase hex digits, `ESC \` (7-bit ST). Exact match.
- Observed reply for `CSI = c`: `ESC P ! | 00000000 ESC \`. Correct.

## 2. Zeroed unit ID is a safe default — CONFIRMED

`Tertiary.unit_id` defaults to `0`, and `embedded.zig`'s effect returns
`.{ .secondary = .{ .firmware_version = 10 } }`, leaving `tertiary` at its
default. That yields site code `00` and unit number `000000`.

xterm's own ctlseqs documentation states: *"XTerm uses zeros for the site code
and serial number in its DECRPTUI response."* Zeroing is therefore both the
de-facto standard emulator behavior and the privacy-correct choice — a manual
surface has no hardware unit, and no host, install, or machine identifier is
exposed. There is no code path that populates a non-zero unit ID.

## 3. Full unfiltered `test-lib-vt` — GREEN, numbers reproduced

Run in scratch with the build script's toolchain and sysroot overlay
(`prepare-zig-xcode-overlay.sh`, pinned zig 0.15.2, `TOOLCHAINS` set,
`zig-runner-tools` on PATH, proxy blackholed) — a bare `zig build test-lib-vt`
would miss the overlay:

```
Build Summary: 21/21 steps succeeded; 4916/4950 tests passed; 34 skipped
test-lib-vt success
REAL_EXIT=0
```

Independently identical to edwin's reported 21/21, 4916/4950, 34 skip.
Exit status read from the run log, not from a pipeline's tail.

## 4. Positive control — BITES

Re-added the exact two suppression lines in a throwaway copy of the tree and
re-ran the same suite:

```
error: while executing test 'terminal.stream_terminal.test.device attributes: tertiary DA',
       the following command terminated with signal 6
thread ... panic: attempt to use null value
Build Summary: 18/21 steps succeeded; 2 failed; 4930/4950 tests passed; 20 skipped
REAL_EXIT=1
```

The failure names the tertiary-DA test specifically and reproduces the exact
reported panic, so the test is wired and load-bearing — not silently absent.
The two failed steps are the two test binaries, both failing on that one test;
no other test changed state.

The mutation was confined to a disposable copy. The baseline tree's
`stream_terminal.zig` still hashes
`77121ba4289c89d13cf83048ddcaddd216f0636b6b8786f70ab8189046534a52`, byte-identical
to `git show 08c486fe:vendor/ghostty/src/terminal/stream_terminal.zig`.

## 5. No regression — CONFIRMED

- Every other reply test in `stream_terminal.zig` is green in the baseline run:
  DA1, DA2, `device attributes: custom response`, `device attributes: readonly
  ignores`, the full `device status` family (operating status, cursor position,
  origin mode, color scheme, readonly ignores), DECRQM with `write_pty`, kitty
  keyboard query, kitty color protocol queries, OSC color queries, size reports,
  and kitty graphics APC responses.
- The read-only path is unaffected: `device attributes: readonly ignores` still
  passes, so surfaces without replies enabled stay silent for all three DA levels.
- The diff is scoped to `reportDeviceAttributes` plus a stale comment in
  `embedded.zig` and the mechanical lock/patch-series/tree-hash updates.
- Patch series regenerates and reproduces the pinned tree:
  `scripts/vendor-ghostty.sh verify` → `patched_tree=a27fc0e765...`,
  `patches=603bb8a1ef...`, matching `toolchain-lock.json`.
  `scripts/validate-native-toolchain-lock.sh` → `native toolchain lock validated`.

## Process note

Gate-2 qualification ran the Swift bundle and the build but not the full
`test-lib-vt` Zig suite, which is why an upstream test broken by a hive patch
escaped. The suppression also demonstrates a narrower hazard worth naming:
hive patches that *constrain* pristine upstream code — rather than adding a
hive-specific hook — inherit upstream's test obligations and will break them.
