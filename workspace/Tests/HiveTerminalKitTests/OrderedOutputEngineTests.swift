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

    /// APC (Kitty graphics) split across chunks completes EXACTLY as the
    /// unsplit feed. First assert a NON-EMPTY APC-specific Kitty reply on the
    /// unsplit baseline (so a dual-path discard stays red), then assert
    /// split==unsplit on through_seq / writes / screen.
    func testAPCSequenceSplitAcrossChunkBoundaryMatchesUnsplitBaseline() throws {
        // Upstream stream_terminal.zig "kitty graphics APC response":
        // ESC_G a=t,t=d,f=24,i=1,s=1,v=2,c=10,r=1;//////// ST  →  ESC_G i=1;OK ST
        let apc = Data("\u{1B}_Ga=t,t=d,f=24,i=1,s=1,v=2,c=10,r=1;////////\u{1B}\\".utf8)
        let expectedKittyReply = Data("\u{1B}_Gi=1;OK\u{1B}\\".utf8)
        let tail = Data("ZMARKER\r\n".utf8)
        let full = apc + tail

        func run(split: Bool) throws -> (through: UInt64, writes: [Data], screen: String) {
            let surface = try makeSurface()
            defer { surface.free() }
            var writes: [Data] = []
            surface.callbackContext.onWrite = { writes.append($0) }
            if split {
                let mid = apc.count / 2
                let first = full.subdata(in: 0..<mid)
                let second = full.subdata(in: mid..<full.count)
                XCTAssertEqual(surface.processOutput(bytes: first, streamSeq: 0), .success)
                XCTAssertEqual(
                    surface.processOutput(bytes: second, streamSeq: UInt64(first.count)),
                    .success
                )
            } else {
                XCTAssertEqual(surface.processOutput(bytes: full, streamSeq: 0), .success)
            }
            pumpMainQueue()
            let screen = readScreenText(surface).trimmingCharacters(in: .whitespacesAndNewlines)
            return (surface.throughSeq, writes, screen)
        }

        let unsplit = try run(split: false)

        // APC-specific effect MUST fire on the unsplit baseline — empty writes
        // would make split==unsplit vacuous under a dual-path discard.
        XCTAssertFalse(unsplit.writes.isEmpty,
                       "unsplit Kitty APC must produce a write-callback reply")
        XCTAssertEqual(unsplit.writes, [expectedKittyReply],
                       "unsplit APC must reply with the exact Kitty OK response, got \(unsplit.writes)")
        XCTAssertTrue(unsplit.screen.contains("ZMARKER"),
                      "unsplit baseline must still show the trailing marker")

        let split = try run(split: true)
        XCTAssertEqual(split.through, unsplit.through,
                       "split APC must advance through_seq identically to unsplit")
        XCTAssertEqual(split.writes, unsplit.writes,
                       "split APC must produce the same write-callback reply bytes as unsplit")
        XCTAssertEqual(split.screen, unsplit.screen,
                       "split APC must land identical screen content to unsplit — " +
                       "got split=\(split.screen.debugDescription) unsplit=\(unsplit.screen.debugDescription)")
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
    /// lock under FORCED concurrent contention: ready barrier + in-body hold
    /// so overlap is attempted, entry/exit sequence stamps prove serialization
    /// (not coincidental peak==1), and a concurrent valid call still succeeds.
    func testRejectedFaultsDoNotRetainLocksOrPoisonConcurrentCaller() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        let stateLock = NSLock()
        var active = 0
        var maxActive = 0
        var stampSeq = 0
        var stamps: [(seq: Int, op: String, phase: String)] = []
        let bodyEntered = DispatchSemaphore(value: 0)
        let releaseBody = DispatchSemaphore(value: 0)
        var holdArmed = true

        surface.operationObserver = { operation, phase in
            guard operation == "processOutput" else { return }
            stateLock.lock()
            stampSeq += 1
            let s = stampSeq
            let phaseName = phase == .begin ? "begin" : "end"
            stamps.append((s, operation, phaseName))
            if phase == .begin {
                active += 1
                maxActive = max(maxActive, active)
                let shouldHold = holdArmed
                if shouldHold { holdArmed = false }
                stateLock.unlock()
                if shouldHold {
                    bodyEntered.signal()
                    // In-body hold: other concurrent callers must queue on main
                    // while this critical section is live.
                    releaseBody.wait()
                }
            } else {
                active -= 1
                stateLock.unlock()
            }
        }

        // Jobs: 4 invalids + 1 valid. Ready barrier then simultaneous go.
        struct Job {
            let bytes: Data
            let seq: UInt64
        }
        let jobs: [Job] = [
            Job(bytes: Data("bad".utf8), seq: 50),
            Job(bytes: Data("bad".utf8), seq: UInt64.max - 1),
            Job(bytes: Data("bad".utf8), seq: 999),
            Job(bytes: Data(), seq: 0),
            Job(bytes: Data("ok".utf8), seq: 0),
        ]
        let workerCount = jobs.count
        let readyLock = NSLock()
        var readyCount = 0
        let allReady = DispatchSemaphore(value: 0)
        let go = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        var results: [HiveTerminalEngineResult] = []
        let resultLock = NSLock()

        // Caller-side ATTEMPTED counter: stamped after go.wait, BEFORE
        // processOutput — measures contention, not sleep-inferred overlap.
        var attempted = 0
        let allAttempted = DispatchSemaphore(value: 0)

        for job in jobs {
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                readyLock.lock()
                readyCount += 1
                if readyCount == workerCount { allReady.signal() }
                readyLock.unlock()
                go.wait()
                stateLock.lock()
                attempted += 1
                if attempted == workerCount { allAttempted.signal() }
                stateLock.unlock()
                let r = surface.processOutput(bytes: job.bytes, streamSeq: job.seq)
                resultLock.lock()
                results.append(r)
                resultLock.unlock()
                group.leave()
            }
        }

        // Coordinate off-main: bodyEntered.wait on main would deadlock with
        // processOutput's DispatchQueue.main.sync admission.
        let coordinated = expectation(description: "hold+release coordinated")
        var midActive = -1
        var midBeginCount = -1
        var midEndCount = -1
        var midAttempted = -1
        DispatchQueue.global(qos: .userInitiated).async {
            XCTAssertEqual(allReady.wait(timeout: .now() + 2), .success, "ready barrier")
            for _ in 0..<workerCount { go.signal() }
            XCTAssertEqual(bodyEntered.wait(timeout: .now() + 2), .success, "in-body hold must engage")
            // REQUIRE every contender has attempted (pre-admission) before release.
            XCTAssertEqual(allAttempted.wait(timeout: .now() + 2), .success,
                           "all callers must stamp ATTEMPTED before hold release")
            stateLock.lock()
            midActive = active
            midBeginCount = stamps.filter { $0.phase == "begin" }.count
            midEndCount = stamps.filter { $0.phase == "end" }.count
            midAttempted = attempted
            stateLock.unlock()
            releaseBody.signal()
            _ = group.wait(timeout: .now() + 5)
            coordinated.fulfill()
        }
        wait(for: [coordinated], timeout: 8)

        XCTAssertEqual(midAttempted, workerCount,
                       "forced overlap: every contender must have attempted during the hold")
        XCTAssertEqual(midActive, 1, "exactly one processOutput body must be live during forced hold")
        XCTAssertEqual(midBeginCount, 1,
                       "only one begin stamp before release — others must be queued, not entered")
        XCTAssertEqual(midEndCount, 0)

        let successes = results.filter { $0 == .success }.count
        let invalids = results.filter { $0 == .invalidValue }.count
        XCTAssertEqual(successes, 1, "exactly one valid accept among concurrent jobs")
        XCTAssertEqual(invalids, workerCount - 1)
        XCTAssertEqual(surface.throughSeq, 2)

        stateLock.lock()
        let peak = maxActive
        let stillActive = active
        let finalStamps = stamps
        stateLock.unlock()
        XCTAssertEqual(stillActive, 0, "no processOutput must remain entered after return")
        XCTAssertEqual(peak, 1, "forced concurrent callers must never nest processOutput")

        // Sequence stamps: begins and ends must strictly alternate (no nesting).
        var depth = 0
        var seenBegin = 0
        for stamp in finalStamps {
            if stamp.phase == "begin" {
                depth += 1
                seenBegin += 1
                XCTAssertEqual(depth, 1, "nested begin at stamp \(stamp.seq): \(finalStamps)")
            } else {
                XCTAssertEqual(depth, 1, "end without begin at stamp \(stamp.seq)")
                depth -= 1
            }
        }
        XCTAssertEqual(depth, 0)
        XCTAssertEqual(seenBegin, workerCount,
                       "every contending call must eventually enter (after hold release)")
    }

    /// processOutput is serialized with draw and restore: observe ALL three
    /// ops, force draw+restore to queue while processOutput is held IN body,
    /// and prove via entry/exit sequence stamps that nothing nested.
    func testIngestionSerializedWithDrawAndRestore() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        let stateLock = NSLock()
        var activeOps = 0
        var maxActive = 0
        var stampSeq = 0
        var stamps: [(seq: Int, op: String, phase: String)] = []
        let bodyEntered = DispatchSemaphore(value: 0)
        let releaseBody = DispatchSemaphore(value: 0)
        var holdArmed = true

        surface.operationObserver = { operation, phase in
            // Observe processOutput, restore, AND draw — a draw-only regression
            // must move the stamp stream.
            stateLock.lock()
            stampSeq += 1
            let s = stampSeq
            let phaseName = phase == .begin ? "begin" : "end"
            stamps.append((s, operation, phaseName))
            if phase == .begin {
                activeOps += 1
                maxActive = max(maxActive, activeOps)
                let hold = holdArmed && operation == "processOutput"
                if hold { holdArmed = false }
                stateLock.unlock()
                if hold {
                    bodyEntered.signal()
                    releaseBody.wait()
                }
            } else {
                activeOps -= 1
                stateLock.unlock()
            }
        }

        var outputResult: HiveTerminalEngineResult = .invalidValue
        var restoreResult: HiveTerminalEngineResult = .success
        var midActive = -1
        var midOps: [String] = []
        var midPhases: [String] = []

        // All coordination off-main so main can run processOutput's sync body
        // and the queued draw/restore without deadlocking on bodyEntered.wait.
        let raceDone = expectation(description: "draw/restore race finished")
        DispatchQueue.global(qos: .userInitiated).async {
            let outputDone = DispatchSemaphore(value: 0)
            DispatchQueue.global(qos: .userInitiated).async {
                outputResult = surface.processOutput(bytes: Data("draw-race".utf8), streamSeq: 0)
                outputDone.signal()
            }
            XCTAssertEqual(bodyEntered.wait(timeout: .now() + 2), .success,
                           "processOutput must enter its observed body so draw can race it")

            // Queue draw + restore on main WHILE processOutput body is held.
            let sideDone = DispatchSemaphore(value: 0)
            DispatchQueue.main.async {
                surface.draw()
                restoreResult = surface.restoreCheckpoint(payload: Data(), throughSeq: 0)
                sideDone.signal()
            }

            Thread.sleep(forTimeInterval: 0.05)
            stateLock.lock()
            midActive = activeOps
            midOps = stamps.map(\.op)
            midPhases = stamps.map(\.phase)
            stateLock.unlock()

            releaseBody.signal()
            _ = outputDone.wait(timeout: .now() + 3)
            _ = sideDone.wait(timeout: .now() + 3)
            raceDone.fulfill()
        }
        wait(for: [raceDone], timeout: 8)

        XCTAssertEqual(midActive, 1, "draw/restore must not enter while processOutput is held")
        XCTAssertEqual(midOps, ["processOutput"],
                       "only processOutput begin may exist before release: \(midOps)")
        XCTAssertEqual(midPhases, ["begin"])

        // Capture the race stamps BEFORE any follow-up processOutput so the
        // ordering proof is about the forced draw/restore contention only.
        stateLock.lock()
        let raceStamps = stamps
        let peak = maxActive
        let stillAfterRace = activeOps
        stateLock.unlock()

        XCTAssertEqual(outputResult, .success)
        XCTAssertEqual(surface.throughSeq, 9)
        XCTAssertEqual(restoreResult, .invalidValue, "empty restore is invalid and must not reset")
        XCTAssertEqual(surface.throughSeq, 9)
        XCTAssertEqual(stillAfterRace, 0)
        XCTAssertEqual(peak, 1, "processOutput/draw/restore must never nest")

        // Stamps on BOTH sides: processOutput begin/end, then draw begin/end,
        // then restore begin/end (or draw/restore order), never interleaved.
        var depth = 0
        var opsSeen = Set<String>()
        for stamp in raceStamps {
            opsSeen.insert(stamp.op)
            if stamp.phase == "begin" {
                depth += 1
                XCTAssertEqual(depth, 1,
                               "nesting detected at \(stamp): \(raceStamps)")
            } else {
                XCTAssertEqual(depth, 1, "unbalanced end at \(stamp)")
                depth -= 1
            }
        }
        XCTAssertEqual(depth, 0)
        XCTAssertTrue(opsSeen.contains("processOutput"))
        XCTAssertTrue(opsSeen.contains("draw"),
                      "draw must be stamped — a draw-blind control is vacuous: \(raceStamps)")
        XCTAssertTrue(opsSeen.contains("restoreCheckpoint"),
                      "restore must be stamped: \(raceStamps)")

        // Ordering: processOutput fully completes before draw and restore begin.
        let poEnd = raceStamps.lastIndex { $0.op == "processOutput" && $0.phase == "end" }
        let drawBegin = raceStamps.firstIndex { $0.op == "draw" && $0.phase == "begin" }
        let restoreBegin = raceStamps.firstIndex { $0.op == "restoreCheckpoint" && $0.phase == "begin" }
        XCTAssertNotNil(poEnd)
        XCTAssertNotNil(drawBegin)
        XCTAssertNotNil(restoreBegin)
        XCTAssertLessThan(poEnd!, drawBegin!,
                          "draw must not begin until processOutput ends: \(raceStamps)")
        XCTAssertLessThan(poEnd!, restoreBegin!,
                          "restore must not begin until processOutput ends: \(raceStamps)")

        // Follow-up accept after failed restore (poison check — not part of race stamps).
        XCTAssertEqual(surface.processOutput(bytes: Data("!".utf8), streamSeq: 9), .success)
        XCTAssertEqual(surface.throughSeq, 10)
    }
}
