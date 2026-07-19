# Gate 5 — ordered output dispositions (fraser round-2 rework)

## Round-2 residual vacuity fixes

| # | Control | Fix |
|---|---|---|
| 1 | Draw/restore | **Closed round-1** — draw observed, in-body hold, stamps both sides |
| 2 | 100 MiB byte-loss | Per-block **screen equality** of every dense SENT stamp (block fits viewport); clear; next block. Mid-stream printable mutation fails block equality. Not OSC-only / not tail-only. |
| 3 | APC | Unsplit asserts exact non-empty Kitty reply `\x1b_Gi=1;OK\x1b\\`, **then** split==unsplit |
| 4 | Concurrent | Caller-side `attempted` counter after `go.wait` **before** `processOutput`; `allAttempted` required before hold release |

## Full disposition matrix

Gap / overlap / duplicate / conflict / overflow / empty / null — engine tests.
CSI / OSC / DCS / APC / UTF-8 / grapheme — engine tests.
Serialization draw/restore — engine test (closed).
100 MiB dense + concurrent — stress tests.

Evidence: arm64-engine-xctest.txt (16/16), arm64-stress-xctest.txt (2/2).
