# M1-B1 Gate 5 — ordered output live-proof evidence

Status: **fraser round-3 #2 volume closed**. All four controls done. Do not land.

## Round-3 #2 fix

Full-width volume rows asserted byte-for-byte on screen (no SENT-only strip).
Negative control: single volume-byte mutation fails.

## Green

- OrderedOutputEngineTests 16/16
- OrderedOutputStressTests 3/3 (incl. volume negative control)
- `shasum -c evidence-sha256.txt` self-verifies
