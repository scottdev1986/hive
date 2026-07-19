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

    /// Build one full-width volume row where EVERY column is load-bearing
    /// unique content (no strip-able padding). Mutating any byte changes the
    /// row string that the sink compares.
    private func volumeRow(block: Int, line: Int, absBase: Int, cols: Int) -> String {
        precondition(cols > 8)
        var out = ""
        out.reserveCapacity(cols)
        let prefix = "B\(block)L\(line)@"
        out.append(prefix)
        var i = 0
        while out.utf8.count < cols {
            // Every position depends on abs/line/block/index — no free padding.
            let v = (absBase &+ line &* 131 &+ i &* 17 &+ block &* 3) % 62
            if v < 10 {
                out.append(Character(UnicodeScalar(48 + v)!))
            } else if v < 36 {
                out.append(Character(UnicodeScalar(55 + v)!))
            } else {
                out.append(Character(UnicodeScalar(61 + v)!))
            }
            i += 1
        }
        // Exact column width (truncate if a multi-byte edge ever appears).
        while out.utf8.count > cols { out.removeLast() }
        while out.utf8.count < cols { out.append("0") }
        return out
    }

    /// Screen rows: take the first `count` lines as returned by read_text.
    /// Trailing spaces the grid may append beyond `cols` are trimmed only past
    /// `cols` — interior volume bytes are never stripped.
    private func screenVolumeRows(_ screen: String, count: Int, cols: Int) -> [String] {
        let raw = screen.split(separator: "\n", omittingEmptySubsequences: false)
        var rows: [String] = []
        for part in raw {
            if rows.count >= count { break }
            var line = String(part)
            if line.hasSuffix("\r") { line.removeLast() }
            // Terminal cells may pad shorter lines with spaces to width; keep
            // exactly `cols` of content we own (full-width rows use all cols).
            if line.utf8.count > cols {
                let idx = line.index(line.startIndex, offsetBy: cols)
                line = String(line[..<idx])
            }
            rows.append(line)
        }
        return rows
    }

    /// 100 MiB class stream: every VOLUME byte is part of the asserted sink.
    /// Each block is a screenful of full-width unique rows (no SENT-only strip);
    /// after feed, readScreen rows must equal the full generated rows
    /// byte-for-byte. Clear; next. Any mutated/dropped volume byte fails.
    func testLargeOrderedStreamProvesReplyOrderAndLosslessContent() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        let da1 = Data("\u{1B}[?62;22c".utf8)
        let da2 = Data("\u{1B}[>1;10;0c".utf8)
        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }

        // Geometry from the live surface. Use cols-1 so a full row does not
        // auto-wrap before the explicit CR/LF (filling all cols wraps).
        surface.setSize(widthPx: 800, heightPx: 480)
        pumpMainQueue()
        let size = try XCTUnwrap(surface.reportedSize(), "surface must report cell geometry")
        let cols = Int(size.columns)
        XCTAssertGreaterThanOrEqual(cols, 40, "need a usable column width, got \(cols)")
        let rowWidth = cols - 1
        // Leave a margin below the viewport edge so all volume rows stay on-screen.
        let linesPerBlock = min(24, max(8, Int(size.rows) - 2))
        XCTAssertGreaterThanOrEqual(linesPerBlock, 8)

        let minBytes = 100 * 1024 * 1024
        let chunkSizes = [1, 7, 1023, 4096, 65_537]
        var streamAbs = 0
        var seq: UInt64 = 0
        var blockIndex = 0
        var expectedReplies: [Data] = []
        var feedStamps: [(seq: UInt64, end: UInt64, size: Int)] = []
        var blocksVerified = 0
        var chunkIndex = 0
        var volumeBytesAsserted = 0

        while streamAbs < minBytes {
            var block = Data()
            var expectedRows: [String] = []
            for line in 0..<linesPerBlock {
                let abs = streamAbs + block.count
                let row = volumeRow(block: blockIndex, line: line, absBase: abs, cols: rowWidth)
                XCTAssertEqual(row.utf8.count, rowWidth)
                expectedRows.append(row)
                // Full row + CR/LF — every volume byte is in the row body;
                // the terminator is observed as a hard row boundary.
                block.append(Data((row + "\r\n").utf8))
            }
            let even = (blockIndex % 2 == 0)
            block.append(Data((even ? "\u{1B}[c" : "\u{1B}[>c").utf8))
            expectedReplies.append(even ? da1 : da2)

            // Uneven chunks — parser must reassemble full rows.
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

            // FULL-VOLUME SINK: entire rows (every column of volume), not tokens.
            pumpMainQueue()
            let screen = readScreenText(surface)
            let gotRows = screenVolumeRows(screen, count: linesPerBlock, cols: rowWidth)
            XCTAssertEqual(gotRows.count, linesPerBlock,
                           "block \(blockIndex): expected \(linesPerBlock) volume rows on screen")
            XCTAssertEqual(gotRows, expectedRows,
                           "block \(blockIndex): full volume rows must match source byte-for-byte " +
                           "(any volume-byte mutation fails here)")
            volumeBytesAsserted += expectedRows.reduce(0) { $0 + $1.utf8.count }
            blocksVerified += 1

            // Clear so the next block's volume is the only on-screen content.
            let clear = Data("\u{1B}[2J\u{1B}[H".utf8)
            XCTAssertEqual(surface.processOutput(bytes: clear, streamSeq: seq), .success)
            seq += UInt64(clear.count)
            streamAbs += clear.count
            feedStamps.append((seq - UInt64(clear.count), seq, clear.count))
            blockIndex += 1
        }

        XCTAssertGreaterThanOrEqual(streamAbs, minBytes)
        XCTAssertGreaterThanOrEqual(blocksVerified, 100,
                                    "must verify many full-screen volume blocks across the stream")
        // Every asserted volume column across the run — the bulk of the 100 MiB.
        XCTAssertGreaterThan(volumeBytesAsserted, 50 * 1024 * 1024,
                             "asserted volume bytes must be the bulk of the stream, got \(volumeBytesAsserted)")
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

    /// Negative control for the 100 MiB volume sink: a single mutated volume
    /// byte (what used to be "padding") MUST make full-row equality fail.
    /// Proves the control bites on the fraser counterexample.
    func testVolumeByteLossControlFailsOnSingleVolumeByteMutation() throws {
        let surface = try makeSurface()
        defer { surface.free() }
        surface.setSize(widthPx: 800, heightPx: 480)
        pumpMainQueue()
        let size = try XCTUnwrap(surface.reportedSize())
        let rowWidth = Int(size.columns) - 1
        let lines = 4

        var expectedRows: [String] = []
        var block = Data()
        for line in 0..<lines {
            let row = volumeRow(block: 0, line: line, absBase: block.count, cols: rowWidth)
            expectedRows.append(row)
            block.append(Data((row + "\r\n").utf8))
        }

        // Positive: intact block matches full rows.
        XCTAssertEqual(surface.processOutput(bytes: block, streamSeq: 0), .success)
        pumpMainQueue()
        let good = screenVolumeRows(readScreenText(surface), count: lines, cols: rowWidth)
        XCTAssertEqual(good, expectedRows, "positive control: intact volume must match")

        // Mutate ONE byte in the middle of a middle row (former padding region).
        var mutated = block
        // Past first "row\r\n", mid second row body.
        let flipAt = (rowWidth + 2) + rowWidth / 2
        XCTAssertLessThan(flipAt, mutated.count)
        let original = mutated[flipAt]
        mutated[flipAt] = original &+ 1
        if mutated[flipAt] == original { mutated[flipAt] = original &- 1 }
        XCTAssertNotEqual(mutated[flipAt], original)

        // Fresh surface so we compare the mutated feed cleanly.
        let surface2 = try makeSurface()
        defer { surface2.free() }
        surface2.setSize(widthPx: 800, heightPx: 480)
        pumpMainQueue()
        XCTAssertEqual(surface2.processOutput(bytes: mutated, streamSeq: 0), .success)
        pumpMainQueue()
        let bad = screenVolumeRows(readScreenText(surface2), count: lines, cols: rowWidth)
        XCTAssertNotEqual(bad, expectedRows,
                          "NEGATIVE CONTROL: single volume-byte mutation must fail full-row sink equality")
        XCTAssertEqual(bad.count, lines)
        XCTAssertNotEqual(bad[1], expectedRows[1],
                          "the mutated row specifically must differ")
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
