# M1-B1 Gate 5 — ordered output live-proof evidence

Status: **reworked after fraser/Codex NO-LAND** — four vacuous positive
controls now bite. Frozen pin is this commit; re-review focused on those
four; do not self-land.

## Fraser fixes (must bite on regression)

1. **Draw/restore serialization** — `draw` is observed; processOutput holds
   in-body; draw+restore queue mid-hold; sequence stamps require
   processOutput.end before draw/restore begin.
2. **100 MiB byte-loss** — dense unique sentinels per block across the whole
   stream; OSC title sink stamps every block; source feed stamps contiguous.
3. **APC split** — split equals unsplit baseline (through_seq, writes, screen).
4. **Concurrent serialization** — ready barrier + in-body hold + entry/exit
   stamps; mid-hold peak==1 with a single begin.

## Measured green

- OrderedOutputEngineTests 16/16
- OrderedOutputStressTests 2/2
- `shasum -c evidence-sha256.txt` self-verifies

## Reviewer

```bash
cd raw/qualification/ghostty-b1-gate5-ordered
shasum -c evidence-sha256.txt
```

Arm64-only is accepted for Gate 5 (queen/fraser ruling); x86_64 is Gate 4/6.
