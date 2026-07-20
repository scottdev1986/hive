# M1-B2.3/A3 input acceptance matrix — delta review (final pin)

- **Final pin:** `10cf6e44` (`test(m1-b2.3): record DECSET 1005 and 1015 mouse coordinate formats`)
- **Base already PASSed:** `71f8a2a4` (hope cross-vendor review; prior PASS transfers for everything untouched)
- **Author:** harvey (Claude / Opus 4.8). **Reviewer:** hope (Grok).
- **Method:** pin materialized detached; prior PASS not re-litigated; delta verified by `git diff 71f8a2a4..10cf6e44`, new suite re-run, fifth mutation + low-column control bite re-run by this reviewer.

## Verdict: **PASS**

Harvey may land **`10cf6e44`** (not `71f8a2a4`).

## Delta confinement

`git diff --name-only 71f8a2a4..10cf6e44` is confined to:

| Path | Role |
|---|---|
| `workspace/Tests/HiveTerminalKitTests/B23MouseFormatMatrixTests.swift` | **new** suite (rows 8b/8c) |
| `workspace/docs/hive-terminal-b23-acceptance-matrix.md` | 8b/8c + SECURITY 7b + OPEN-for-closure marking |
| `scripts/b23-acceptance-matrix.sh` | +1 line: `mouse-format-matrix` suite |
| `bootstrap/evidence/m1-b2-b23-input/*` | evidence re-record (+ `mouse-format-matrix.txt`, updated manifest/summary) |

No unexpected paths. Substantive source/doc/script delta is exactly the three queen-ordered additions plus the new suite/evidence wiring.

## Green suite at final pin

| Step | Exit | Result |
|---|---|---|
| `swift test` | **0** | **432 tests, 6 skipped, 0 failures** (was 427; +5 format-suite tests) |
| `bun run typecheck` | **0** | clean |
| New suite alone `B23MouseFormatMatrixTests` | **0** | 5 tests, 0 failures |
| Manifest from `git archive 10cf6e44` | **0** | all digests OK; summary **83 tests, 0 failures** across nine suites |

## (1) Rows 8b/8c — DECSET 1005/1015

Coordinate finding is real and correctly handled:

- Other mouse rows click (25, 40) → column 2; at that column, default and 1005 encodings are **byte-identical** (got `1b 5b 4d 20 22 2e` when the 1005 golden was forced to that cell — 6 bytes, not the 7-byte UTF-8 form).
- Far-right click (`x: 1005` px, 10 px cells) → **column 125**; `125+32=157=0x9D`. Default emits raw `0x9D`; 1005 emits UTF-8 U+009D as **`0xC2 0x9D`** (protocol-reconciled, not guessed).
- 1015: `ESC [ 32 ; 125 ; 14 M` — same button (+32) and cell, decimal, no SGR `<`.
- Cross-format row asserts all three transports share the same logical cell.

### Fifth mutation — drop DECSET 1005 → **RED ×3**

Dropped `?1005h` from `testUTF8FormatEncodesTheSameCoordinateAsMultibyteUTF8` only; restored after:

1. equal to utf8 golden fails (`6 bytes` vs `7 bytes`; got `1b 5b 4d 20 9d 2e` = default)
2. not-equal to x10Report fails (they are equal — "mode was ignored")
3. payload must be valid UTF-8 fails (`XCTAssertNotNil` on raw high byte)

**Executed 1 test, with 3 failures.** Mutation bites as claimed.

### Low-column coincidence control — **bites**

1. Inverted the control to `XCTAssertNotEqual` → RED: both sides are 6 equal bytes (formats genuinely coincide at low column).
2. Forced the 1005 golden under the low-column click → RED: got default-shaped 6-byte report, not the 7-byte UTF-8 golden. Proves a low-column 1005 row would be vacuous against a terminal ignoring 1005.

## (2) Row 7b SECURITY

Table label: `safe paste while unbracketed (SECURITY)`. Prose: **SECURITY behavior / paste-injection vector / Do NOT "fix" this into sending / no deleting the row** — explicit no-delete clause present. Satisfies queen's addition.

## (3) Eight encoder rows · OPEN for closure

Table marks **exactly eight** rows `RECORDED (…encoder…) · OPEN for closure`:

`3, 4, 5, 6, 7, 8b, 8c, 11`

Section "What OPEN for closure means" records queen's ruling verbatim: encoder evidence lands; it is **not** B2.3/A3 story closure; live-PTY traversal still required. Doc does not read as acceptance complete.

## Prior PASS transfer

Everything outside the delta remains under the prior PASS at `71f8a2a4` (four earlier mutations, rows 2b/10/3 recording calls, settle-then-assert, evidence discipline). Not re-litigated.

## Non-blocking notes

1. Suite file header comment says clicks at "column 100"; body and goldens correctly use **column 125**. Cosmetic only.
2. OPEN section says "Six of the twelve rows — 3, 4, 5, 6, 7, 11, plus the new 8b/8c" (awkward arithmetic; the table correctly marks eight). Cosmetic.
3. Dropping 1005 from *all* three enabling sites (including the cross-format row) then indexes `utf8Mode[6]` on a 6-byte default report and can abort the suite mid-run. The claimed fifth mutation (UTF-8 row only) is clean RED×3; a fully global drop is a harsher probe than the suite is hardened for. Not a land blocker.

## Landing instruction

**PASS** on final pin `10cf6e44`. Harvey lands this pin directly.
