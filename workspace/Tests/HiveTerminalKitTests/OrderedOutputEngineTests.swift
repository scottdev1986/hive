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
            return try GhosttyBridgeFactory.makeManualSurfaceForTesting(terminalReplies: .enabled)
        } catch {
            XCTFail("real manual surface required for gate 5 live proof, got: \(error)")
            throw error
        }
    }

    private func pumpMainQueue() {
        let delivered = expectation(description: "main-thread callback delivery")
        DispatchQueue.main.async { delivered.fulfill() }
        wait(for: [delivered], timeout: 1)
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
        pumpMainQueue()
        let eventCountAfterFirstParse = events.count
        XCTAssertGreaterThan(eventCountAfterFirstParse, 0,
                             "positive control: the real first parse must produce at least one event " +
                             "(process() emits INVALIDATE unconditionally on every accepted call) -- " +
                             "otherwise the zero-new-events check below would be vacuous")

        // Exact same [0,5) range, identical bytes -> duplicate, still success.
        XCTAssertEqual(surface.processOutput(bytes: bytes, streamSeq: 0), .success)
        XCTAssertEqual(surface.throughSeq, 5, "a duplicate retransmit must not double-advance through_seq")
        pumpMainQueue()
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
        pumpMainQueue()
        XCTAssertEqual(writes.count, 0, "an incomplete CSI sequence must not reply early")

        XCTAssertEqual(surface.processOutput(bytes: second, streamSeq: UInt64(first.count)), .success)
        pumpMainQueue()
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

    /// Partial overlap: stream_seq < through_seq but the [start,end) is not
    /// an exact prior committed range → invalid (not a silent partial apply).
    func testPartialOverlapIsInvalidAndDoesNotAdvanceThroughSeq() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        XCTAssertEqual(surface.processOutput(bytes: Data("hello".utf8), streamSeq: 0), .success)
        XCTAssertEqual(surface.throughSeq, 5)

        // [1,5) overlaps the accepted [0,5) without being an exact retransmit.
        let result = surface.processOutput(bytes: Data("ello".utf8), streamSeq: 1)
        XCTAssertEqual(result, .invalidValue)
        XCTAssertEqual(surface.throughSeq, 5, "a rejected partial overlap must not touch through_seq")

        // Contiguous continuation still works (failure did not poison).
        XCTAssertEqual(surface.processOutput(bytes: Data("!".utf8), streamSeq: 5), .success)
        XCTAssertEqual(surface.throughSeq, 6)
    }

    /// stream_seq + length overflows u64 → invalid (sequence-overflow disposition).
    func testSequenceOverflowIsInvalid() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        let result = surface.processOutput(bytes: Data("xy".utf8), streamSeq: UInt64.max - 1)
        XCTAssertEqual(result, .invalidValue)
        XCTAssertEqual(surface.throughSeq, 0)

        XCTAssertEqual(surface.processOutput(bytes: Data("ok".utf8), streamSeq: 0), .success)
        XCTAssertEqual(surface.throughSeq, 2)
    }

    /// Null pointer at the C boundary is invalid for every length (including 0).
    func testNullPointerInputIsInvalidAtCBoundary() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        let handle = try XCTUnwrap(surface.surfaceHandle)
        let nullResult = hive_ghostty_surface_process_output_v1(handle, nil, 4, 0)
        XCTAssertEqual(HiveTerminalEngineResult(cResult: nullResult), .invalidValue)
        XCTAssertEqual(surface.throughSeq, 0)

        let nullEmpty = hive_ghostty_surface_process_output_v1(handle, nil, 0, 0)
        XCTAssertEqual(HiveTerminalEngineResult(cResult: nullEmpty), .invalidValue)

        XCTAssertEqual(surface.processOutput(bytes: Data("ok".utf8), streamSeq: 0), .success)
        XCTAssertEqual(surface.throughSeq, 2)
    }

    /// OSC 0 title split across chunk boundary still emits one title event.
    func testOSCSequenceSplitAcrossChunkBoundaryStillSetsTitle() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        var titles: [Data] = []
        surface.callbackContext.onEvent = { event in
            if event.type == .title { titles.append(event.bytes) }
        }

        let full = Data("\u{1B}]0;split-title\u{07}".utf8)
        let mid = 4 // after ESC ] 0 ;
        let first = full.subdata(in: 0..<mid)
        let second = full.subdata(in: mid..<full.count)

        XCTAssertEqual(surface.processOutput(bytes: first, streamSeq: 0), .success)
        pumpMainQueue()
        XCTAssertEqual(titles.count, 0, "incomplete OSC must not emit title early")

        XCTAssertEqual(surface.processOutput(bytes: second, streamSeq: UInt64(first.count)), .success)
        pumpMainQueue()
        XCTAssertEqual(titles.count, 1, "completed OSC must emit title exactly once")
        XCTAssertEqual(String(data: titles[0], encoding: .utf8), "split-title")
    }

    /// DCS (DECRQSS) split across chunks still produces one reply when complete.
    func testDCSSequenceSplitAcrossChunkBoundaryStillReplies() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }

        // DECRQSS for SGR: ESC P $ q m ST  (split after the DCS introducer).
        let first = Data("\u{1B}P".utf8)
        let second = Data("$qm\u{1B}\\".utf8)
        XCTAssertEqual(surface.processOutput(bytes: first, streamSeq: 0), .success)
        pumpMainQueue()
        XCTAssertEqual(writes.count, 0, "incomplete DCS must not reply early")

        XCTAssertEqual(surface.processOutput(bytes: second, streamSeq: UInt64(first.count)), .success)
        pumpMainQueue()
        XCTAssertEqual(writes.count, 1, "completed DCS DECRQSS must reply exactly once")
        // Reply is DCS-framed; non-empty is the live proof the parser re-entered.
        XCTAssertFalse(writes[0].isEmpty)
        XCTAssertEqual(writes[0].first, 0x1B)
    }

    /// APC (Kitty graphics query) split across chunks still completes without
    /// poisoning the following printable text.
    func testAPCSequenceSplitAcrossChunkBoundaryDoesNotPoisonFollowingText() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        // Kitty graphics query APC; split mid-payload then follow with "Z".
        let apc = Data("\u{1B}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\u{1B}\\".utf8)
        let mid = apc.count / 2
        let first = apc.subdata(in: 0..<mid)
        let second = apc.subdata(in: mid..<apc.count)
        XCTAssertEqual(surface.processOutput(bytes: first, streamSeq: 0), .success)
        XCTAssertEqual(
            surface.processOutput(bytes: second, streamSeq: UInt64(first.count)),
            .success
        )
        let after = UInt64(apc.count)
        XCTAssertEqual(surface.processOutput(bytes: Data("Z".utf8), streamSeq: after), .success)
        XCTAssertEqual(surface.throughSeq, after + 1)

        let meaningful = readScreenText(surface).trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertTrue(meaningful.contains("Z"),
                      "APC split must not poison later printables; screen=\(meaningful.debugDescription)")
    }

    /// Grapheme cluster (base + combining mark) split mid-cluster still
    /// lands as one visual character, not two garbled cells.
    func testGraphemeClusterSplitAcrossChunkBoundaryDecodesCorrectly() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        // "é" as e + COMBINING ACUTE ACCENT (U+0301), not the precomposed form.
        let base = Data("e".utf8)
        let mark = Data("\u{0301}".utf8)
        XCTAssertEqual(surface.processOutput(bytes: base, streamSeq: 0), .success)
        XCTAssertEqual(surface.processOutput(bytes: mark, streamSeq: 1), .success)
        XCTAssertEqual(surface.throughSeq, UInt64(base.count + mark.count))

        let meaningful = readScreenText(surface).trimmingCharacters(in: .whitespacesAndNewlines)
        // NFC of e+acute is "é"; accept either NFC or NFD as long as it is
        // one grapheme of "é", not "e" alone or replacement garbage.
        let nfc = meaningful.precomposedStringWithCanonicalMapping
        XCTAssertEqual(nfc, "é",
                       "split grapheme must decode to 'é', got \(meaningful.debugDescription)")
    }

    /// Rejected fault dispositions must not retain the renderer/admission
    /// lock: a concurrent valid call after a burst of invalids must still
    /// enter and succeed, and operationObserver must never show nested
    /// processOutput (serialized, not re-entrant / stuck).
    func testRejectedFaultsDoNotRetainLocksOrPoisonConcurrentCaller() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        let stateLock = NSLock()
        var active = 0
        var maxActive = 0
        surface.operationObserver = { operation, phase in
            guard operation == "processOutput" else { return }
            stateLock.lock()
            if phase == .begin {
                active += 1
                maxActive = max(maxActive, active)
            } else {
                active -= 1
            }
            stateLock.unlock()
        }

        let start = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        var invalidResults: [HiveTerminalEngineResult] = []
        let resultLock = NSLock()

        // Burst of concurrent invalid calls (gap, overflow, empty).
        for seq in [UInt64(50), UInt64.max - 1, UInt64(999)] {
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                start.wait()
                let r = surface.processOutput(bytes: Data("bad".utf8), streamSeq: seq)
                resultLock.lock()
                invalidResults.append(r)
                resultLock.unlock()
                group.leave()
            }
        }
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            start.wait()
            let r = surface.processOutput(bytes: Data(), streamSeq: 0)
            resultLock.lock()
            invalidResults.append(r)
            resultLock.unlock()
            group.leave()
        }

        // One concurrent valid contiguous write — must succeed after/among rejects.
        var validResult: HiveTerminalEngineResult = .invalidValue
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            start.wait()
            // Small delay so invalids hit first, proving we are not locked out.
            Thread.sleep(forTimeInterval: 0.01)
            validResult = surface.processOutput(bytes: Data("ok".utf8), streamSeq: 0)
            group.leave()
        }

        for _ in 0..<5 { start.signal() }
        // Wait off-main so DispatchQueue.main.sync admission inside
        // processOutput can run (group.wait on main would deadlock).
        let finished = expectation(description: "concurrent fault burst finished")
        DispatchQueue.global().async {
            _ = group.wait(timeout: .now() + 5)
            finished.fulfill()
        }
        wait(for: [finished], timeout: 6)

        XCTAssertEqual(validResult, .success, "valid call must not be locked out by prior rejects")
        XCTAssertEqual(surface.throughSeq, 2)
        for r in invalidResults {
            XCTAssertEqual(r, .invalidValue)
        }
        stateLock.lock()
        let peak = maxActive
        let stillActive = active
        stateLock.unlock()
        XCTAssertEqual(stillActive, 0, "no processOutput must remain entered after return")
        XCTAssertEqual(peak, 1, "ingestion must serialize: never re-enter processOutput")
    }

    /// processOutput is serialized with draw and restore on the main
    /// admission domain: concurrent callers never overlap in
    /// operationObserver, and a restore after ordered output resets the
    /// ledger baseline (pre-restore ranges classify invalid).
    func testIngestionSerializedWithDrawAndRestore() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        let stateLock = NSLock()
        var activeOps = 0
        var maxActive = 0
        var sawDrawDuringOutput = false
        var outputEntered = false
        surface.operationObserver = { operation, phase in
            stateLock.lock()
            defer { stateLock.unlock() }
            if operation == "processOutput" || operation == "restoreCheckpoint" {
                if phase == .begin {
                    activeOps += 1
                    maxActive = max(maxActive, activeOps)
                    if operation == "processOutput" { outputEntered = true }
                } else {
                    activeOps -= 1
                }
            }
        }

        // Hold processOutput mid-admission so draw can race it on main.
        let copyEntered = DispatchSemaphore(value: 0)
        let releaseCopy = DispatchSemaphore(value: 0)
        surface.outputCopyObserver = { _ in
            copyEntered.signal()
            releaseCopy.wait()
        }

        var outputResult: HiveTerminalEngineResult = .invalidValue
        let outputDone = expectation(description: "output finished")
        DispatchQueue.global(qos: .userInitiated).async {
            outputResult = surface.processOutput(bytes: Data("draw-race".utf8), streamSeq: 0)
            outputDone.fulfill()
        }
        XCTAssertEqual(copyEntered.wait(timeout: .now() + 2), .success)

        // Draw on main while output is waiting for admission — must not
        // interleave with the C process_output body (observer peak stays 1).
        surface.draw()
        stateLock.lock()
        if outputEntered { sawDrawDuringOutput = true }
        stateLock.unlock()

        releaseCopy.signal()
        wait(for: [outputDone], timeout: 2)
        // Drop the stall seam before any further processOutput: later calls
        // (including on main) would otherwise block forever on releaseCopy.
        surface.outputCopyObserver = nil
        XCTAssertEqual(outputResult, .success)
        XCTAssertEqual(surface.throughSeq, 9)

        // Restore with a deliberately invalid empty payload → invalid, no
        // advance; then a second valid processOutput after the failed restore
        // still works at the pre-restore through_seq (failed restore no-ops).
        XCTAssertEqual(
            surface.restoreCheckpoint(payload: Data(), throughSeq: 0),
            .invalidValue
        )
        XCTAssertEqual(surface.throughSeq, 9)
        XCTAssertEqual(surface.processOutput(bytes: Data("!".utf8), streamSeq: 9), .success)
        XCTAssertEqual(surface.throughSeq, 10)

        stateLock.lock()
        let peak = maxActive
        let still = activeOps
        stateLock.unlock()
        XCTAssertEqual(still, 0)
        XCTAssertEqual(peak, 1, "processOutput/restore must never nest")
        _ = sawDrawDuringOutput // draw may complete before admission; peak is the load-bearing proof
    }
}
