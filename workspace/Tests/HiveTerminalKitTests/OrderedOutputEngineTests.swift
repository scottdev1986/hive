import AppKit
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

/// Gate 5 (M1-B1) live proof: ordered-output semantics at the REAL C
/// boundary (`hive_ghostty_surface_process_output_v1`), not the Swift-side
/// `OutputRangeApplicator` fake already covered by OutputRangeApplicatorTests.
///
/// Semantics are read from native/ghostty-patches (hive_checkpoint.zig
/// OutputRangeLedger.classify/commit): stream_seq == through_seq accepts;
/// stream_seq < through_seq requires an exact prior [start,end) match —
/// same range + same SHA-256 digest is a no-op duplicate, same range with
/// a different digest is invalid (conflicting bytes); any other
/// arrangement (gap ahead, partial overlap) is invalid. A `.invalid`
/// classification returns before touching parser state, pending buffer,
/// or the renderer mutex — failures cannot poison later calls.
final class OrderedOutputEngineTests: XCTestCase {
    /// Fails loudly rather than XCTSkip: this is the story's mandated
    /// LIVE-PROOF gate, so a run where every test silently skips must not
    /// report as "N tests, 0 failures" (matches the fix applied to
    /// TerminalReplyCorpusTests/AppWakeupLifecycleTests after cross-vendor
    /// review 2026-07-17 caught exactly this failure mode).
    private func makeSurface() throws -> GhosttyManualSurface {
        do {
            return try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        } catch {
            XCTFail("real manual surface required for gate 5 live proof, got: \(error)")
            throw error
        }
    }

    func testGapAheadIsInvalidAndDoesNotAdvanceThroughSeq() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        let result = surface.processOutput(bytes: Data("x".utf8), streamSeq: 100)
        XCTAssertEqual(result, .invalidValue)
        XCTAssertEqual(surface.throughSeq, 0, "a rejected gap must not advance through_seq")
    }

    func testDuplicateExactRetransmitIsIdempotent() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        let bytes = Data("hello".utf8)
        XCTAssertEqual(surface.processOutput(bytes: bytes, streamSeq: 0), .success)
        XCTAssertEqual(surface.throughSeq, 5)

        // Exact same [0,5) range, identical bytes -> duplicate, still success.
        XCTAssertEqual(surface.processOutput(bytes: bytes, streamSeq: 0), .success)
        XCTAssertEqual(surface.throughSeq, 5, "a duplicate retransmit must not double-advance through_seq")
    }

    func testConflictingBytesAtSameRangeIsInvalid() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        XCTAssertEqual(surface.processOutput(bytes: Data("hello".utf8), streamSeq: 0), .success)
        XCTAssertEqual(surface.throughSeq, 5)

        // Same [0,5) range, DIFFERENT bytes -> digest mismatch -> invalid,
        // never silently accepted as a "correction".
        let result = surface.processOutput(bytes: Data("world".utf8), streamSeq: 0)
        XCTAssertEqual(result, .invalidValue)
        XCTAssertEqual(surface.throughSeq, 5, "a rejected conflict must not touch through_seq")
    }

    func testEmptyBytesIsInvalid() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        let result = surface.processOutput(bytes: Data(), streamSeq: 0)
        XCTAssertEqual(result, .invalidValue)
        XCTAssertEqual(surface.throughSeq, 0)
    }

    /// Arbitrary chunk boundary across a CSI sequence: "\x1b[" then "c" in
    /// two separate process_output_v1 calls at contiguous stream_seq. The
    /// per-surface parser (terminal.TerminalStream) persists across calls,
    /// so the DA1 reply must still fire exactly once, byte-identical to a
    /// single-call send (cross-checked against TerminalReplyCorpusTests).
    func testCSISequenceSplitAcrossChunkBoundaryStillReplies() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }

        let first = Data("\u{1B}[".utf8)
        let second = Data("c".utf8)
        XCTAssertEqual(surface.processOutput(bytes: first, streamSeq: 0), .success)
        XCTAssertEqual(writes.count, 0, "an incomplete CSI sequence must not reply early")

        XCTAssertEqual(surface.processOutput(bytes: second, streamSeq: UInt64(first.count)), .success)
        XCTAssertEqual(writes.count, 1, "the reply must fire once the sequence completes, split or not")
        XCTAssertEqual(writes.first, Data("\u{1B}[?62;22c".utf8))
    }

    /// Arbitrary chunk boundary across a UTF-8 codepoint: "é" (U+00E9,
    /// 0xC3 0xA9) split into its two bytes across two calls. Must not
    /// crash or corrupt parser state — INVALIDATE still fires once the
    /// codepoint completes.
    func testUTF8CodepointSplitAcrossChunkBoundaryDoesNotCorruptState() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        var events: [BridgeEvent] = []
        surface.callbackContext.onEvent = { events.append($0) }

        let firstByte = Data([0xC3])
        let secondByte = Data([0xA9])
        XCTAssertEqual(surface.processOutput(bytes: firstByte, streamSeq: 0), .success)
        XCTAssertEqual(surface.processOutput(bytes: secondByte, streamSeq: 1), .success)

        XCTAssertTrue(events.contains { $0.type == .invalidate },
                      "a split UTF-8 codepoint must still resolve to a normal paint")
        XCTAssertEqual(surface.throughSeq, 2)
    }

    /// Failures must never poison later calls: a rejected gap is followed
    /// by a normal contiguous write, which must still succeed exactly as
    /// if the failed call had never happened.
    func testRejectedGapDoesNotPoisonSubsequentValidCall() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        XCTAssertEqual(surface.processOutput(bytes: Data("late".utf8), streamSeq: 999), .invalidValue)
        XCTAssertEqual(surface.throughSeq, 0)

        let result = surface.processOutput(bytes: Data("ok".utf8), streamSeq: 0)
        XCTAssertEqual(result, .success, "a prior rejected call must not poison a correctly-ordered one")
        XCTAssertEqual(surface.throughSeq, 2)
    }
}
