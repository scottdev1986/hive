import AppKit
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

/// Gate 5 (M1-B1) stress: a large ordered stream through the REAL
/// `hive_ghostty_surface_process_output_v1` boundary. Cross-vendor review
/// (2026-07-19 fraser) required: dense unique sentinels across the WHOLE
/// 100 MiB with sequence-stamped source/sink order (not a thin tail), and
/// concurrent serialization proven under forced overlap (ready barrier +
/// in-body hold + entry/exit stamps).
final class OrderedOutputStressTests: XCTestCase {
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

    /// 100 MiB class stream with FULL-STREAM dense SENT observation.
    /// Each block is a screenful of unique SENT lines; after feeding we read
    /// the screen and require EVERY stamp from that block (not a thin tail /
    /// OSC-only sink). Clear, then next block. Mutating any mid-stream SENT
    /// byte fails the per-block screen equality for that block.
    func testLargeOrderedStreamProvesReplyOrderAndLosslessContent() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        let da1 = Data("\u{1B}[?62;22c".utf8)
        let da2 = Data("\u{1B}[>1;10;0c".utf8)
        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }

        let minBytes = 100 * 1024 * 1024
        // Fit entirely in the default ~30-row viewport so every stamp is
        // observable via readScreen after the block (full-stream, per-block).
        let linesPerBlock = 24
        let chunkSizes = [1, 7, 1023, 4096, 65_537]
        var streamAbs = 0
        var seq: UInt64 = 0
        var blockIndex = 0
        var expectedReplies: [Data] = []
        var feedStamps: [(seq: UInt64, end: UInt64, size: Int)] = []
        var blocksVerified = 0
        var chunkIndex = 0

        func extractSentinels(_ screen: String) -> [String] {
            var out: [String] = []
            var rest = Substring(screen)
            while let start = rest.range(of: "SENT") {
                let from = rest[start.lowerBound...]
                guard let end = from.range(of: "END") else { break }
                out.append(String(from[from.startIndex..<end.upperBound]))
                rest = from[end.upperBound...]
            }
            return out
        }

        while streamAbs < minBytes {
            var block = Data()
            var stamps: [String] = []
            for line in 0..<linesPerBlock {
                let abs = streamAbs + block.count
                // Unique across the whole stream; dense printable content.
                let stamp = "SENT\(blockIndex).\(line)@\(abs)END"
                stamps.append(stamp)
                // Pad each line so volume accumulates quickly while remaining
                // a single screen row (truncate pad to keep stamp intact).
                let padLen = max(0, 72 - stamp.count)
                let pad = String(repeating: String(Character(UnicodeScalar(0x41 + (line % 26))!)), count: padLen)
                block.append(Data("\(stamp)\(pad)\r\n".utf8))
            }
            let even = (blockIndex % 2 == 0)
            block.append(Data((even ? "\u{1B}[c" : "\u{1B}[>c").utf8))
            expectedReplies.append(even ? da1 : da2)

            // Uneven chunks on every block — parser must reassemble dense SENT.
            var fed = 0
            while fed < block.count {
                let size = min(chunkSizes[chunkIndex % chunkSizes.count], block.count - fed)
                chunkIndex += 1
                let chunk = block.subdata(in: fed..<(fed + size))
                let result = surface.processOutput(bytes: chunk, streamSeq: seq)
                XCTAssertEqual(result, .success, "chunk at seq \(seq) size \(size) must be accepted")
                if result != .success { return }
                let end = seq + UInt64(size)
                feedStamps.append((seq, end, size))
                seq = end
                fed += size
            }
            streamAbs += block.count

            // FULL-STREAM SINK (per-block): every dense SENT line of THIS block
            // must appear on screen, exact ordered equality. A mutated mid-stream
            // printable fails here even if DA/throughSeq still advance.
            pumpMainQueue()
            let screen = readScreenText(surface)
            let found = extractSentinels(screen)
            XCTAssertEqual(found, stamps,
                           "block \(blockIndex) dense SENT sink must equal source stamps — " +
                           "mid-stream byte loss/mutation goes red here")
            blocksVerified += 1

            // Clear so the next block's stamps are the only ones on screen.
            let clear = Data("\u{1B}[2J\u{1B}[H".utf8)
            XCTAssertEqual(surface.processOutput(bytes: clear, streamSeq: seq), .success)
            seq += UInt64(clear.count)
            streamAbs += clear.count
            feedStamps.append((seq - UInt64(clear.count), seq, clear.count))
            blockIndex += 1
        }

        XCTAssertGreaterThanOrEqual(streamAbs, minBytes)
        XCTAssertGreaterThanOrEqual(blocksVerified, 100,
                                    "must verify many full-screen dense blocks across the stream")
        XCTAssertEqual(surface.throughSeq, seq)
        XCTAssertEqual(feedStamps.first?.seq, 0)
        for i in 1..<feedStamps.count {
            XCTAssertEqual(feedStamps[i].seq, feedStamps[i - 1].end,
                           "source feed stamps must be contiguous")
        }
        XCTAssertEqual(feedStamps.last?.end, seq)

        pumpMainQueue()
        XCTAssertEqual(writes.count, expectedReplies.count, "each query must reply exactly once")
        XCTAssertEqual(writes, expectedReplies,
                       "the reply sequence must match the alternating DA1/DA2 query order byte-for-byte")

        writes.removeAll()
        XCTAssertEqual(surface.processOutput(bytes: Data("\u{1B}[c".utf8), streamSeq: seq), .success)
        pumpMainQueue()
        XCTAssertEqual(writes, [da1], "post-stress DA1 must still answer byte-exactly")
    }

    /// Concurrent callers: ready barrier + in-body hold forces contention;
    /// entry/exit sequence stamps prove serialization (not coincidental peak).
    func testConcurrentCallersAreSerializedAndUncoordinatedGapsRejected() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        let stateLock = NSLock()
        var active = 0
        var maxActive = 0
        var stampSeq = 0
        var stamps: [(seq: Int, phase: String)] = []
        let bodyEntered = DispatchSemaphore(value: 0)
        let releaseBody = DispatchSemaphore(value: 0)
        var holdArmed = true

        surface.operationObserver = { operation, phase in
            guard operation == "processOutput" else { return }
            stateLock.lock()
            stampSeq += 1
            let s = stampSeq
            let phaseName = phase == .begin ? "begin" : "end"
            stamps.append((s, phaseName))
            if phase == .begin {
                active += 1
                maxActive = max(maxActive, active)
                let hold = holdArmed
                if hold { holdArmed = false }
                stateLock.unlock()
                if hold {
                    bodyEntered.signal()
                    releaseBody.wait()
                }
            } else {
                active -= 1
                stateLock.unlock()
            }
        }

        let workerCount = 8
        let readyLock = NSLock()
        var readyCount = 0
        let allReady = DispatchSemaphore(value: 0)
        let go = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        var results: [HiveTerminalEngineResult] = []
        let resultLock = NSLock()
        var attempted = 0
        let allAttempted = DispatchSemaphore(value: 0)

        // Eight concurrent writers all claim stream_seq=0 with different
        // payloads — at most one can accept; the rest are conflict/gap.
        for i in 0..<workerCount {
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                readyLock.lock()
                readyCount += 1
                if readyCount == workerCount { allReady.signal() }
                readyLock.unlock()
                go.wait()
                // Pre-admission ATTEMPTED stamp — measured overlap, not sleep.
                stateLock.lock()
                attempted += 1
                if attempted == workerCount { allAttempted.signal() }
                stateLock.unlock()
                let r = surface.processOutput(
                    bytes: Data("c\(i)".utf8),
                    streamSeq: 0
                )
                resultLock.lock()
                results.append(r)
                resultLock.unlock()
                group.leave()
            }
        }

        // Coordinate off-main — bodyEntered.wait on main deadlocks main.sync.
        let coordinated = expectation(description: "concurrent hold coordinated")
        var midActive = -1
        var midBegins = -1
        var midEnds = -1
        var midAttempted = -1
        DispatchQueue.global(qos: .userInitiated).async {
            XCTAssertEqual(allReady.wait(timeout: .now() + 2), .success, "ready barrier")
            for _ in 0..<workerCount { go.signal() }
            XCTAssertEqual(bodyEntered.wait(timeout: .now() + 2), .success, "in-body hold")
            XCTAssertEqual(allAttempted.wait(timeout: .now() + 2), .success,
                           "all callers must stamp ATTEMPTED before hold release")
            stateLock.lock()
            midActive = active
            midBegins = stamps.filter { $0.phase == "begin" }.count
            midEnds = stamps.filter { $0.phase == "end" }.count
            midAttempted = attempted
            stateLock.unlock()
            releaseBody.signal()
            _ = group.wait(timeout: .now() + 5)
            coordinated.fulfill()
        }
        wait(for: [coordinated], timeout: 8)

        XCTAssertEqual(midAttempted, workerCount,
                       "forced overlap: every contender must have attempted during the hold")
        XCTAssertEqual(midActive, 1, "forced hold: exactly one body live")
        XCTAssertEqual(midBegins, 1)
        XCTAssertEqual(midEnds, 0)

        let successes = results.filter { $0 == .success }.count
        let invalids = results.filter { $0 == .invalidValue }.count
        XCTAssertEqual(successes + invalids, workerCount)
        XCTAssertEqual(successes, 1, "exactly one concurrent claim of seq 0 may accept")
        XCTAssertEqual(invalids, workerCount - 1,
                       "the other callers must be rejected (conflict/duplicate-range mismatch)")

        stateLock.lock()
        let peak = maxActive
        let still = active
        let finalStamps = stamps
        stateLock.unlock()
        XCTAssertEqual(still, 0)
        XCTAssertEqual(peak, 1, "concurrent callers must serialize; never re-enter")

        var depth = 0
        var begins = 0
        for stamp in finalStamps {
            if stamp.phase == "begin" {
                depth += 1
                begins += 1
                XCTAssertEqual(depth, 1, "nested begin: \(finalStamps)")
            } else {
                XCTAssertEqual(depth, 1)
                depth -= 1
            }
        }
        XCTAssertEqual(depth, 0)
        XCTAssertEqual(begins, workerCount, "every contender must enter after hold release")

        // Surface remains usable: continue from the accepted through_seq.
        let next = surface.throughSeq
        XCTAssertGreaterThan(next, 0)
        XCTAssertEqual(surface.processOutput(bytes: Data("!".utf8), streamSeq: next), .success)
        XCTAssertEqual(surface.throughSeq, next + 1)
    }
}
