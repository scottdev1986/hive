# M1-B1 Gate 5 — ordered output live-proof evidence

Status: **fraser round-2 residual vacuity fixed**. Freeze pin for re-check of
controls #2/#3/#4 (mechanics + #1 already cleared). Do not self-land.

## Round-2 fixes

2. **100 MiB** — each block is a full screen of unique SENT lines; after feed,
   `readScreen` must equal the source stamp list for that block; clear; next.
   Mutating any mid-stream SENT printable fails that block's equality.
3. **APC** — unsplit baseline must emit exact Kitty `\x1b_Gi=1;OK\x1b\\`, then
   split==unsplit on through/writes/screen.
4. **Concurrent** — pre-admission `attempted` counter; all contenders must
   attempt before hold release (measured, not sleep).

## Green

- OrderedOutputEngineTests 16/16
- OrderedOutputStressTests 2/2
- `shasum -c evidence-sha256.txt` self-verifies
