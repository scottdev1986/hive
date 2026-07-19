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

    /// 100 MiB class stream: every block carries a DENSE unique sentinel
    /// stamped with absolute source offset; the sink observes every block
    /// via OSC title events (full-stream, not viewport tail). Dropping or
    /// mutating any block loses/scrambles a title stamp and goes RED.
    func testLargeOrderedStreamProvesReplyOrderAndLosslessContent() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        let da1 = Data("\u{1B}[?62;22c".utf8)
        let da2 = Data("\u{1B}[>1;10;0c".utf8)
        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }

        // SINK stamps: one OSC title per block, payload = "B{index}@{absOffset}".
        // Titles survive scrollback; the viewport cannot hold 100 MiB.
        var titleSink: [String] = []
        let titleLock = NSLock()
        surface.callbackContext.onEvent = { event in
            guard event.type == .title else { return }
            let s = String(data: event.bytes, encoding: .utf8) ?? ""
            titleLock.lock()
            titleSink.append(s)
            titleLock.unlock()
        }

        let minBytes = 100 * 1024 * 1024
        let blockTarget = 16 * 1024
        var pending = Data()
        var expectedReplies: [Data] = []
        var expectedTitles: [String] = []
        // Source stamps: (blockIndex, absStart, absEnd exclusive) for every block.
        var sourceBlocks: [(index: Int, start: Int, end: Int, title: String)] = []
        var blockIndex = 0

        while pending.count < minBytes {
            let absStart = pending.count
            // Dense unique body: many distinct lines per block (not bulk identical
            // filler). Any dropped line changes block length/title offset chain.
            var block = Data()
            var line = 0
            while block.count < blockTarget - 64 {
                // SENT{block}.{line}@{absolute}END — unique across the whole stream.
                let abs = absStart + block.count
                block.append(Data("SENT\(blockIndex).\(line)@\(abs)END\r\n".utf8))
                line += 1
            }
            let title = "B\(blockIndex)@\(absStart)"
            // OSC 0 title is the full-stream sink stamp for this block.
            block.append(Data("\u{1B}]0;\(title)\u{07}".utf8))
            let even = (blockIndex % 2 == 0)
            block.append(Data((even ? "\u{1B}[c" : "\u{1B}[>c").utf8))
            expectedReplies.append(even ? da1 : da2)
            expectedTitles.append(title)
            pending.append(block)
            sourceBlocks.append((blockIndex, absStart, pending.count, title))
            blockIndex += 1
        }
        let volumeBytes = pending.count
        XCTAssertGreaterThanOrEqual(volumeBytes, minBytes,
                                    "the stress stream must be at least 100 MiB, was \(volumeBytes)")
        XCTAssertGreaterThanOrEqual(sourceBlocks.count, 100,
                                    "dense per-block sentinels required across the stream")

        // Uneven chunk sizes that never align with block/query/sentinel or
        // sequence boundaries — the parser must be indifferent to chunking.
        let chunkSizes = [1, 7, 1023, 4096, 65_537]
        var seq: UInt64 = 0
        var fed = 0
        var chunkIndex = 0
        // Source feed stamps: each accepted chunk's [streamSeq, end).
        var feedStamps: [(seq: UInt64, end: UInt64, size: Int)] = []
        while fed < pending.count {
            let size = min(chunkSizes[chunkIndex % chunkSizes.count], pending.count - fed)
            chunkIndex += 1
            let chunk = pending.subdata(in: fed..<(fed + size))
            let result = surface.processOutput(bytes: chunk, streamSeq: seq)
            XCTAssertEqual(result, .success, "chunk at seq \(seq) size \(size) must be accepted")
            if result != .success { return }
            let end = seq + UInt64(size)
            feedStamps.append((seq, end, size))
            seq = end
            fed += size
        }

        XCTAssertEqual(surface.throughSeq, UInt64(pending.count),
                       "through_seq must advance by exactly the total byte count")

        // Source order: every feed stamp is contiguous (no gap/overlap in what we sent).
        XCTAssertEqual(feedStamps.first?.seq, 0)
        for i in 1..<feedStamps.count {
            XCTAssertEqual(feedStamps[i].seq, feedStamps[i - 1].end,
                           "source feed stamps must be contiguous")
        }
        XCTAssertEqual(feedStamps.last?.end, UInt64(pending.count))

        // ORDER PROOF: alternating DA1/DA2 reply sequence.
        pumpMainQueue()
        // Drain deferred title deliveries.
        for _ in 0..<3 { pumpMainQueue() }

        XCTAssertEqual(writes.count, expectedReplies.count, "each query must reply exactly once")
        XCTAssertEqual(writes, expectedReplies,
                       "the reply sequence must match the alternating DA1/DA2 query order byte-for-byte")

        // FULL-STREAM SINK: every block's OSC title must arrive, in order.
        // Dropping a block or mutating away its OSC loses a stamp; reordering
        // mismatches the expectedTitles sequence.
        titleLock.lock()
        let titles = titleSink
        titleLock.unlock()
        XCTAssertEqual(titles.count, expectedTitles.count,
                       "sink title count must equal source block count — lost/extra block: " +
                       "got \(titles.count) expected \(expectedTitles.count)")
        XCTAssertEqual(titles, expectedTitles,
                       "sink title sequence must equal source block stamps exactly")

        // Viewport still shows a contiguous ascending suffix of dense SENT markers
        // (tail integrity, complementary to full-stream titles).
        let screen = readScreenText(surface)
        var sentinelPairs: [(block: Int, line: Int)] = []
        var rest = Substring(screen)
        while let start = rest.range(of: "SENT") {
            let after = rest[start.upperBound...]
            guard let dot = after.firstIndex(of: "."),
                  let at = after.firstIndex(of: "@"),
                  let end = after.range(of: "END"),
                  let b = Int(after[after.startIndex..<dot]),
                  let line = Int(after[after.index(after: dot)..<at]) else { break }
            sentinelPairs.append((b, line))
            rest = after[end.upperBound...]
        }
        XCTAssertGreaterThanOrEqual(sentinelPairs.count, 2,
                                    "viewport must show multiple dense sentinels, got \(screen.suffix(160).debugDescription)")
        // Contiguous in the order they appear (no reorder/garble of visible tail).
        for i in 1..<sentinelPairs.count {
            let prev = sentinelPairs[i - 1]
            let cur = sentinelPairs[i]
            let ordered = (cur.block > prev.block) ||
                (cur.block == prev.block && cur.line == prev.line + 1)
            XCTAssertTrue(ordered,
                          "visible dense sentinels must stay ordered: \(sentinelPairs)")
        }

        // Still fully functional after the stress.
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
        DispatchQueue.global(qos: .userInitiated).async {
            XCTAssertEqual(allReady.wait(timeout: .now() + 2), .success, "ready barrier")
            for _ in 0..<workerCount { go.signal() }
            XCTAssertEqual(bodyEntered.wait(timeout: .now() + 2), .success, "in-body hold")
            Thread.sleep(forTimeInterval: 0.05)
            stateLock.lock()
            midActive = active
            midBegins = stamps.filter { $0.phase == "begin" }.count
            midEnds = stamps.filter { $0.phase == "end" }.count
            stateLock.unlock()
            releaseBody.signal()
            _ = group.wait(timeout: .now() + 5)
            coordinated.fulfill()
        }
        wait(for: [coordinated], timeout: 8)

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
