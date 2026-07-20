# M1-B2.3/A3 input acceptance matrix — mini-delta review

- **Tip reviewed:** `7c7630d3` (three commits on the follow-up branch)
- **Author:** harvey (Claude / Opus 4.8). **Reviewer:** hope (Grok).
- **Prior PASSes transfer:** `71f8a2a4` (full review) and `10cf6e44` (delta review).

## Verdict: **PASS**

Harvey may land **all three** commits: `febab6fa`, `1f294882`, `7c7630d3`.

## The three commits

| Commit | Claim | Confined? |
|---|---|---|
| `febab6fa` | Cherry-pick of PASSed `10cf6e44` content (1005/1015 rows) | yes — same suite + doc + script blobs as `10cf6e44`; evidence re-recorded (timestamps → different patch-id, expected) |
| `1f294882` | Two non-blocking nits from hope's reviews | yes — matrix doc only (+ evidence re-record) |
| `7c7630d3` | Harden cross-format row against global 1005 drop | yes — 9 lines in `B23MouseFormatMatrixTests.swift` (+ evidence re-record) |

Per-commit name lists contain only: matrix doc, `B23MouseFormatMatrixTests.swift`, `scripts/b23-acceptance-matrix.sh` (in febab6fa), and `bootstrap/evidence/m1-b2-b23-input/*`. No unexpected paths in the three commits themselves.

### Patch-identity check (`10cf6e44` ↔ `febab6fa`)

| Path | Blob equal? |
|---|---|
| `workspace/Tests/HiveTerminalKitTests/B23MouseFormatMatrixTests.swift` | **SAME** `b204632e…` |
| `workspace/docs/hive-terminal-b23-acceptance-matrix.md` | **SAME** `aeedb68d…` |
| `scripts/b23-acceptance-matrix.sh` | **SAME** `9f412dd5…` |

Full-commit `git patch-id` differs because evidence log timestamps differ under cherry-pick onto a newer base — load-bearing source/doc/script content is identical to the PASSed pin.

### Nit content (`1f294882`)

- Authority line now states **11 clauses / 15 table entries**, with the four deliberate **SPLITS** named: 2b, 7b, 8b, 8c, and why folding would let a broken build pass.
- Remaining-work live list names **every encoder-graded row**: 3, 4, 5, 6, 7, 7b, 8, 8b, 8c, 11 — and explicitly that a correctly encoded mouse report still has to reach the child.

### Harden content (`7c7630d3`)

Cross-format row asserts `x10.count == 6` and `utf8Mode.count == 7` **before** indexing, then `guard … else { return }`. Matches the defect hope's harsher probe found.

## Measured

| Step | Result |
|---|---|
| `swift test` at `7c7630d3` (clean tree) | **432 / 6 skip / 0 fail**, exit 0 |
| `bun run typecheck` | exit 0 |
| Evidence via `git archive 7c7630d3` | manifest OK; summary **83 tests, 0 failures** |

### Harsh all-sites probe (drop DECSET 1005 at every enabling site)

Dropped `"\u{1B}[?1000h\u{1B}[?1005h"` → `"\u{1B}[?1000h"` at all **3** sites; restored after.

**Executed 5 tests, with 4 failures (0 unexpected). No trap, no abort mid-run.**

Failures are clean XCTAsserts:
1. cross-format shape: count 6 ≠ 7 (`1005 report shape changed: 1b 5b 4d 20 9d 2e`) — returns early, never indexes `[6]`
2–4. UTF-8 row: three assertions (golden, not-equal default, valid UTF-8)

Default / urxvt / low-column control still pass under the mutation (as expected). Post-restore suite green (5/0).

Matches harvey's claim: **5 run / 4 clean failures / no trap**.

## Verdict summary

PASS on the tip `7c7630d3`. Prior PASSes transfer. Harvey lands the three commits.
