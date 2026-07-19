# Gate 5 — ordered output: recorded dispositions (2026-07-19, forrest)

Object under qualification: the manual-mode GhosttyKit surface at the
locked tuple (`native/toolchain-lock.json`) plus the live
`hive_ghostty_surface_process_output_v1` path. Semantics come from the
patched `OutputRangeLedger.classify/commit` (native patch series) and the
Swift main-queue admission wrapper (`GhosttyManualSurface.processOutput`).

Evidence run: `arm64-engine-xctest.txt` (16/16) + `arm64-stress-xctest.txt` (2/2).
Each row names a **positive control** that goes RED if the disposition is wrong.

## Fault / input dispositions (ledger + C boundary)

| Case | Disposition | Positive control (would fail if wrong) |
|---|---|---|
| Contiguous `stream_seq == through_seq`, non-empty | **accept** — parse, advance `through_seq` by length, emit invalidate | First leg of every accept test; stress stream advances exact total |
| Exact retransmit same `[start,end)` + same SHA-256 | **duplicate** — success, **no re-parse** (zero new events) | `testDuplicateExactRetransmitIsIdempotent` (event-count positive control first) |
| Exact same range, different digest | **conflicting-byte** → invalid; `through_seq` unchanged | `testConflictingBytesAtSameRangeIsInvalid` |
| `stream_seq > through_seq` | **gap** → invalid; no advance | `testGapAheadIsInvalidAndDoesNotAdvanceThroughSeq` |
| `stream_seq < through_seq` but not an exact prior range | **partial overlap** → invalid; no advance | `testPartialOverlapIsInvalidAndDoesNotAdvanceThroughSeq` |
| `stream_seq + length` overflows u64 | **sequence-overflow** → invalid | `testSequenceOverflowIsInvalid` |
| Empty bytes (`length == 0`) | **empty** → invalid | `testEmptyBytesIsInvalid` |
| Null pointer at C API (any length including 0) | **null** → invalid | `testNullPointerInputIsInvalidAtCBoundary` |

## Chunk-boundary continuity (parser state across calls)

| Split | Disposition | Positive control |
|---|---|---|
| CSI (`ESC [` then `c`) | Incomplete does not reply; complete replies **exactly once** byte-identical DA1 | `testCSISequenceSplitAcrossChunkBoundaryStillReplies` |
| UTF-8 codepoint (`é` = C3 A9 split) | Decodes to **exactly** one `é` on screen readback | `testUTF8CodepointSplitAcrossChunkBoundaryDecodesToTheCorrectCharacter` |
| Grapheme (`e` + U+0301 split) | NFC equals `é` | `testGraphemeClusterSplitAcrossChunkBoundaryDecodesCorrectly` |
| OSC 0 title split mid-sequence | One title event only after ST/BEL; payload `split-title` | `testOSCSequenceSplitAcrossChunkBoundaryStillSetsTitle` |
| DCS DECRQSS split after `ESC P` | One non-empty ESC-framed reply after complete | `testDCSSequenceSplitAcrossChunkBoundaryStillReplies` |
| APC (Kitty graphics query) split mid-payload | Following printable `Z` still lands | `testAPCSequenceSplitAcrossChunkBoundaryDoesNotPoisonFollowingText` |

## Failure hygiene + serialization

| Claim | Disposition | Positive control |
|---|---|---|
| Rejected gap does not poison next accept | Subsequent contiguous write succeeds | `testRejectedGapDoesNotPoisonSubsequentValidCall` |
| Concurrent invalid burst does not retain locks | Valid follow-up accepts; `operationObserver` peak active == 1; active returns to 0 | `testRejectedFaultsDoNotRetainLocksOrPoisonConcurrentCaller` |
| Ingestion serialized with draw + restore | Off-main processOutput + main draw; failed empty restore no-ops; continue at prior `through_seq`; peak nested ops == 1 | `testIngestionSerializedWithDrawAndRestore` |
| Concurrent callers at same `stream_seq` | Main-queue **serialized** (peak == 1); exactly one accept, seven rejects (conflict/mismatch); surface still usable | `testConcurrentCallersAreSerializedAndUncoordinatedGapsRejected` |

## Large stream (100 MiB class)

| Claim | Proof |
|---|---|
| ≥ 100 MiB ordered stream, uneven chunks, alternating DA1/DA2 reply order, lossless sentinel suffix | `testLargeOrderedStreamProvesReplyOrderAndLosslessContent` — reply array equals expected DA1/DA2 alternation; visible sentinels contiguous +1 ending at last; post-stress DA1 still exact |

## Ledger decisions (native, three-valued)

From `OutputRangeLedger.Decision`: `{ accept, duplicate, invalid }`.
There is no silent correction path. `.invalid` returns before parser feed,
pending buffer mutation, or renderer mutex acquisition.
