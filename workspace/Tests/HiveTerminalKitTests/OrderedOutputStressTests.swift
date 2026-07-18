import AppKit
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

/// Gate 5 (M1-B1) stress: a large ordered stream through the REAL
/// `hive_ghostty_surface_process_output_v1` boundary. Cross-vendor review
/// (2026-07-18) flagged the first version as not proving ordered/lossless
/// content — 128 IDENTICAL DA1 replies are permutation-indistinguishable
/// (any reordering yields the same reply list), and through_seq alone is a
/// success-mirror. This version makes order OBSERVABLE two ways: the reply
/// stream ALTERNATES DA1/DA2 so its exact sequence encodes the query order
/// (a reordering mismatches), and each block writes a UNIQUE numbered
/// sentinel whose values must appear on the final screen strictly
/// increasing (a content readback proving the tail landed in order,
/// losslessly — not garbled or permuted).
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

    func testLargeOrderedStreamProvesReplyOrderAndLosslessContent() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        let da1 = Data("\u{1B}[?62;22c".utf8)
        let da2 = Data("\u{1B}[>1;10;0c".utf8)
        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }

        // PHASE 1 — VOLUME + REPLY ORDER. Blocks of ~16 KiB filler each,
        // each ending in an alternating query (DA1 even, DA2 odd), until the
        // stream exceeds 8 MiB. The filler bulks the volume; the alternating
        // queries make reply ORDER observable (the reply array encodes the
        // query order — identical replies could not).
        let minBytes = 8 * 1024 * 1024
        let fillerRow = "\u{1B}[32mfiller row of ordered-stream stress content padding the volume\u{1B}[0m\r\n"
        var pending = Data()
        var expectedReplies: [Data] = []
        var blockIndex = 0
        while pending.count < minBytes {
            var block = Data()
            while block.count < 16 * 1024 { block.append(Data(fillerRow.utf8)) }
            pending.append(block)
            let even = (blockIndex % 2 == 0)
            pending.append(Data((even ? "\u{1B}[c" : "\u{1B}[>c").utf8))
            expectedReplies.append(even ? da1 : da2)
            blockIndex += 1
        }
        let volumeBytes = pending.count
        XCTAssertGreaterThanOrEqual(volumeBytes, minBytes,
                                    "the stress stream must be at least 8 MiB, was \(volumeBytes)")

        // PHASE 2 — LOSSLESS ORDERED CONTENT. A dense run of unique numbered
        // sentinels (no filler between them) so the last full screen is a
        // contiguous suffix of them — the readback proves ordered, lossless
        // landing, not merely accepted bytes.
        let sentinelCount = 48
        for i in 0..<sentinelCount {
            pending.append(Data("SENT\(i)END\r\n".utf8))
        }

        // Uneven chunk sizes that never align with block/query/sentinel or
        // sequence boundaries — the parser must be indifferent to chunking.
        let chunkSizes = [1, 7, 1023, 4096, 65_537]
        var seq: UInt64 = 0
        var fed = 0
        var chunkIndex = 0
        while fed < pending.count {
            let size = min(chunkSizes[chunkIndex % chunkSizes.count], pending.count - fed)
            chunkIndex += 1
            let chunk = pending.subdata(in: fed..<(fed + size))
            let result = surface.processOutput(bytes: chunk, streamSeq: seq)
            XCTAssertEqual(result, .success, "chunk at seq \(seq) size \(size) must be accepted")
            if result != .success { return }
            seq += UInt64(size)
            fed += size
        }

        XCTAssertEqual(surface.throughSeq, UInt64(pending.count),
                       "through_seq must advance by exactly the total byte count")

        // ORDER PROOF: the reply stream must be EXACTLY the alternating
        // DA1/DA2 sequence — a dropped, duplicated, or reordered reply
        // changes this list; identical replies could not catch that.
        pumpMainQueue()
        XCTAssertEqual(writes.count, expectedReplies.count, "each query must reply exactly once")
        XCTAssertEqual(writes, expectedReplies,
                       "the reply sequence must match the alternating DA1/DA2 query order byte-for-byte")

        // LOSSLESS CONTENT PROOF: the visible sentinels must form a
        // CONTIGUOUS ascending run (each exactly +1 — no duplicates, no gaps)
        // ending at the final sentinel. `== sorted()` alone would permit
        // duplicates/gaps; adjacency +1 does not.
        let screen = readScreenText(surface)
        var sentinelNums: [Int] = []
        var rest = Substring(screen)
        while let start = rest.range(of: "SENT") {
            let after = rest[start.upperBound...]
            guard let end = after.range(of: "END") else { break }
            if let n = Int(after[after.startIndex..<end.lowerBound]) { sentinelNums.append(n) }
            rest = after[end.upperBound...]
        }
        XCTAssertGreaterThanOrEqual(sentinelNums.count, 2,
                                    "the final screen must show multiple sentinel lines, got \(screen.suffix(120).debugDescription)")
        for i in 1..<sentinelNums.count {
            XCTAssertEqual(sentinelNums[i], sentinelNums[i - 1] + 1,
                           "visible sentinels must be contiguous (+1 each) — a gap/dup/reorder breaks this: \(sentinelNums)")
        }
        XCTAssertEqual(sentinelNums.last, sentinelCount - 1,
                       "the last visible sentinel must be the final one \(sentinelCount - 1), got \(String(describing: sentinelNums.last))")

        // Still fully functional after the stress.
        writes.removeAll()
        XCTAssertEqual(surface.processOutput(bytes: Data("\u{1B}[c".utf8), streamSeq: seq), .success)
        pumpMainQueue()
        XCTAssertEqual(writes, [da1], "post-stress DA1 must still answer byte-exactly")
    }
}
