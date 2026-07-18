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

    /// Cross-vendor review (2026-07-17, bobby) flagged the original version
    /// of this test: it only checked throughSeq stayed at 5, but a BROKEN
    /// implementation that incorrectly re-parses the duplicate bytes would
    /// also leave throughSeq unchanged (re-parsing "hello" doesn't move
    /// position) -- throughSeq alone is a success-mirror, not proof of
    /// no-op. HiveManual.process() classifies duplicates and returns
    /// .success BEFORE touching the parser/pending buffer/emit -- so the
    /// real proof is that the event stream gets ZERO new entries.
    func testDuplicateExactRetransmitIsIdempotent() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        var events: [BridgeEvent] = []
        surface.callbackContext.onEvent = { events.append($0) }

        let bytes = Data("hello".utf8)
        XCTAssertEqual(surface.processOutput(bytes: bytes, streamSeq: 0), .success)
        XCTAssertEqual(surface.throughSeq, 5)
        let eventCountAfterFirstParse = events.count
        XCTAssertGreaterThan(eventCountAfterFirstParse, 0,
                             "positive control: the real first parse must produce at least one event " +
                             "(process() emits INVALIDATE unconditionally on every accepted call) -- " +
                             "otherwise the zero-new-events check below would be vacuous")

        // Exact same [0,5) range, identical bytes -> duplicate, still success.
        XCTAssertEqual(surface.processOutput(bytes: bytes, streamSeq: 0), .success)
        XCTAssertEqual(surface.throughSeq, 5, "a duplicate retransmit must not double-advance through_seq")
        XCTAssertEqual(events.count, eventCountAfterFirstParse,
                       "a duplicate retransmit must re-parse NOTHING -- zero additional events, " +
                       "not merely an unchanged throughSeq")
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

    /// Reads the full screen text via `ghostty_surface_read_text`, matching
    /// the real Ghostty app's own "cachedScreenContents" pattern exactly
    /// (Surface View/SurfaceView_AppKit.swift ~244-262: GHOSTTY_POINT_SCREEN
    /// top-left/bottom-right, non-rectangle selection reads the whole
    /// screen).
    private func readScreenText(_ surface: GhosttyManualSurface) -> String {
        guard let handle = surface.surfaceHandle else { return "" }
        var text = ghostty_text_s()
        let sel = ghostty_selection_s(
            top_left: ghostty_point_s(tag: GHOSTTY_POINT_SCREEN, coord: GHOSTTY_POINT_COORD_TOP_LEFT, x: 0, y: 0),
            bottom_right: ghostty_point_s(tag: GHOSTTY_POINT_SCREEN, coord: GHOSTTY_POINT_COORD_BOTTOM_RIGHT, x: 0, y: 0),
            rectangle: false
        )
        guard ghostty_surface_read_text(handle, sel, &text) else { return "" }
        defer { ghostty_surface_free_text(handle, &text) }
        return String(cString: text.text)
    }

    /// Arbitrary chunk boundary across a UTF-8 codepoint: "é" (U+00E9,
    /// 0xC3 0xA9) split into its two bytes across two calls.
    ///
    /// Cross-vendor review (2026-07-17, bobby) flagged the original
    /// version, which only checked "some INVALIDATE eventually fired."
    /// That's not discriminating: process() emits INVALIDATE
    /// unconditionally on every accepted call (not conditionally on a
    /// complete grapheme forming), and a first FOLLOW-UP attempt at
    /// comparing event COUNTS against a single-call baseline turned out to
    /// be equally flawed -- two calls always produce one more INVALIDATE
    /// than one call, purely because of the per-call-not-per-grapheme
    /// architecture, regardless of whether the codepoint decoded
    /// correctly. Neither approach can tell "correctly buffered
    /// continuation byte" from "silently decoded as two garbled
    /// characters" without reading the actual terminal content.
    ///
    /// The real proof: read back the screen text via
    /// ghostty_surface_read_text and assert it is exactly "é" — not two
    /// mangled replacement characters, not "é" plus a stray byte.
    func testUTF8CodepointSplitAcrossChunkBoundaryDecodesToTheCorrectCharacter() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        XCTAssertEqual(surface.processOutput(bytes: Data([0xC3]), streamSeq: 0), .success)
        XCTAssertEqual(surface.processOutput(bytes: Data([0xA9]), streamSeq: 1), .success)
        XCTAssertEqual(surface.throughSeq, 2)

        // Exactness (cross-vendor review bram, 2026-07-18 — this control's
        // third round): hasPrefix("é") stayed green for "é" plus a stray
        // replacement/duplicate glyph, so extra-byte corruption passed.
        // The grid's blank cells and row separators are the read API's
        // expected fill; after stripping ONLY that whitespace/newline
        // padding, the ENTIRE meaningful screen content must equal "é" —
        // any additional glyph (U+FFFD, "Ã©", a duplicated "é") survives
        // the trim and goes RED.
        let screen = readScreenText(surface)
        let meaningful = screen.trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertEqual(meaningful, "é",
                       "the split lead+continuation bytes must decode to EXACTLY one 'é' and nothing else " +
                       "— got \(meaningful.debugDescription) (full screen \(String(screen.prefix(8)).debugDescription)…)")
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
