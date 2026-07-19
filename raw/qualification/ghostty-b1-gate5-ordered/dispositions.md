# Gate 5 — ordered output: recorded dispositions (2026-07-19, forrest)

Object under qualification: the manual-mode GhosttyKit surface at the
locked tuple (`native/toolchain-lock.json`) plus the live
`hive_ghostty_surface_process_output_v1` path.

Evidence run: `arm64-engine-xctest.txt` (16/16) + `arm64-stress-xctest.txt` (2/2).
Each row names a **positive control** that goes RED if the disposition is wrong.

## Fraser re-review (NO-LAND) — four controls reworked to bite

| Control | Was vacuous because | Now bites by |
|---|---|---|
| Draw/restore serialization | `activeOps` ignored draw; output stalled pre-admission; stamps discarded | `draw` observed; in-body hold of processOutput; draw+restore queued mid-hold; sequence stamps require `processOutput.end` before `draw`/`restore` begin; peak nesting == 1 |
| 100 MiB byte-loss | thin 48-line tail; filler drops left titles/replies green | dense unique `SENT{block}.{line}@{abs}` per block across full 100 MiB; OSC title sink `B{i}@{abs}` for EVERY block (full-stream); source feed stamps contiguous; DA1/DA2 order |
| APC split | only `contains("Z")` | unsplit baseline vs split: equal through_seq, write callbacks, and screen text |
| Concurrent serialization | no ready barrier / in-body hold / stamps | ready barrier; first entrant holds in body; mid-hold asserts active==1 and single begin; sequence stamps prove non-nested begin/end for every contender |

## Fault / input dispositions (ledger + C boundary)

| Case | Disposition | Positive control |
|---|---|---|
| Contiguous non-empty | **accept** | stress + accept legs |
| Exact retransmit same range+digest | **duplicate** no re-parse | `testDuplicateExactRetransmitIsIdempotent` |
| Same range different digest | **conflicting-byte** invalid | `testConflictingBytesAtSameRangeIsInvalid` |
| stream_seq > through_seq | **gap** invalid | `testGapAheadIsInvalidAndDoesNotAdvanceThroughSeq` |
| stream_seq < through_seq non-exact range | **partial overlap** invalid | `testPartialOverlapIsInvalidAndDoesNotAdvanceThroughSeq` |
| stream_seq + length overflows u64 | **sequence-overflow** invalid | `testSequenceOverflowIsInvalid` |
| Empty bytes | **empty** invalid | `testEmptyBytesIsInvalid` |
| Null pointer (any length) | **null** invalid | `testNullPointerInputIsInvalidAtCBoundary` |

## Chunk-boundary continuity

| Split | Control |
|---|---|
| CSI | `testCSISequenceSplitAcrossChunkBoundaryStillReplies` |
| UTF-8 | `testUTF8CodepointSplitAcrossChunkBoundaryDecodesToTheCorrectCharacter` |
| Grapheme | `testGraphemeClusterSplitAcrossChunkBoundaryDecodesCorrectly` |
| OSC | `testOSCSequenceSplitAcrossChunkBoundaryStillSetsTitle` |
| DCS | `testDCSSequenceSplitAcrossChunkBoundaryStillReplies` |
| APC | `testAPCSequenceSplitAcrossChunkBoundaryMatchesUnsplitBaseline` |

## Failure hygiene + serialization + stress

| Claim | Control |
|---|---|
| Reject does not poison | `testRejectedGapDoesNotPoisonSubsequentValidCall` |
| Concurrent reject/accept + forced serialization | `testRejectedFaultsDoNotRetainLocksOrPoisonConcurrentCaller` |
| Ingestion serialized with draw/restore | `testIngestionSerializedWithDrawAndRestore` |
| Concurrent callers forced serialize | `testConcurrentCallersAreSerializedAndUncoordinatedGapsRejected` |
| 100 MiB dense lossless + reply order | `testLargeOrderedStreamProvesReplyOrderAndLosslessContent` |
