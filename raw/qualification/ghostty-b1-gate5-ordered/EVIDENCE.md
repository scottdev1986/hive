# M1-B1 Gate 5 — ordered output live-proof evidence

Status: **authoring complete** for matrix row C. Frozen pin is this commit;
full cross-vendor review is required before land (do not self-land).

## What was proven

Live `hive_ghostty_surface_process_output_v1` on a real manual surface
(not the Swift `OutputRangeApplicator` fake):

1. **Chunk boundaries** — CSI, OSC, DCS, APC, UTF-8 codepoint, and combining
   grapheme splits complete correctly across separate process_output calls.
2. **Empty / null input** — empty `Data` and C null pointer are invalid.
3. **Fault dispositions** — gap, partial overlap, exact duplicate (idempotent
   no re-parse), conflicting bytes, and u64 sequence overflow — each with a
   control that fails if the disposition is wrong.
4. **Failure hygiene** — rejects do not poison later accepts and do not retain
   admission locks under concurrent callers (`operationObserver` peak == 1).
5. **Serialization** — processOutput is main-admitted and does not nest with
   itself or restore; draw can race admission without nested C entry.
6. **Stress** — ≥ 100 MiB ordered stream with uneven chunks, alternating
   DA1/DA2 reply-order proof, lossless sentinel content; concurrent callers
   serialize with exactly one accept of a contested stream_seq.

## How to re-run

```bash
# Materialize GhosttyKit for the locked patchedTree d92dc8fe… (seven symbols).
# Then:
cd workspace
swift build --build-tests
/usr/bin/arch -arm64 /usr/bin/xcrun xctest \
  -XCTest 'HiveTerminalKitTests.OrderedOutputEngineTests' \
  .build/arm64-apple-macosx/debug/HiveWorkspacePackageTests.xctest
/usr/bin/arch -arm64 /usr/bin/xcrun xctest \
  -XCTest 'HiveTerminalKitTests.OrderedOutputStressTests' \
  .build/arm64-apple-macosx/debug/HiveWorkspacePackageTests.xctest
```

## Artifacts in this directory

| File | Role |
|---|---|
| `provenance.txt` | Host, toolchain, lock digests, run identity |
| `dispositions.md` | Full disposition matrix with positive controls |
| `live-proof.jsonl` | Machine-readable pass records |
| `arm64-engine-xctest.txt` | XCTest transcript (16 tests) |
| `arm64-stress-xctest.txt` | XCTest transcript (2 tests) |
| `arm64-seven-symbols.txt` | Seven-symbol allowlist from linked library |
| `libghostty-internal.sha256` | Hash of the embedded static library used |
| `evidence-sha256.txt` | Self-verifying manifest (excludes itself) |

## Reviewer checklist

```bash
cd raw/qualification/ghostty-b1-gate5-ordered
shasum -c evidence-sha256.txt
# Expect: all OK. Manifest must not list itself or any gitignored path.
```

## Explicit non-claims

- This corpus does not re-prove Gate 3 lifetime races or Gate 6 checkpoint
  authoring; restore is only exercised as a failed empty payload (no-op) and
  serialization peer of processOutput.
- Physical multi-arch stress under Rosetta is not in this pin's evidence set;
  arm64 host only for this run.
