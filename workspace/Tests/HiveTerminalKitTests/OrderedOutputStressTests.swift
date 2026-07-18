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
            return try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        } catch {
            XCTFail("real manual surface required for gate 5 live proof, got: \(error)")
            throw error
        }
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

        let blocks = 512
        // Each block: filler text, a UNIQUE numbered sentinel line
        // (ASCII "SENT<n>END"), and an alternating query (DA1 on even
        // blocks, DA2 on odd).
        var pending = Data()
        var expectedReplies: [Data] = []
        for i in 0..<blocks {
            pending.append(Data("\u{1B}[32mfiller row for ordered-stream stress block \(i)\u{1B}[0m\r\n".utf8))
            pending.append(Data("SENT\(i)END\r\n".utf8))
            let query = (i % 2 == 0) ? "\u{1B}[c" : "\u{1B}[>c"
            pending.append(Data(query.utf8))
            expectedReplies.append((i % 2 == 0) ? da1 : da2)
        }

        // Uneven chunk sizes that never align with block/query/sequence
        // boundaries — the parser must be indifferent to chunking (queries
        // and the UTF-8 sentinel get split mid-sequence).
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
        // DA1/DA2 sequence, in order. A dropped, duplicated, or reordered
        // reply changes this list — indistinguishable identical replies
        // could not catch that.
        XCTAssertEqual(writes.count, blocks, "each query must reply exactly once")
        XCTAssertEqual(writes, expectedReplies,
                       "the reply sequence must match the alternating DA1/DA2 query order byte-for-byte")

        // LOSSLESS CONTENT PROOF: the sentinels visible on the final screen
        // must be strictly increasing and end at the last block — proving the
        // tail landed in order and un-garbled, not merely that bytes were
        // accepted.
        let screen = readScreenText(surface)
        var sentinelNums: [Int] = []
        var rest = Substring(screen)
        while let start = rest.range(of: "SENT") {
            let after = rest[start.upperBound...]
            guard let end = after.range(of: "END") else { break }
            if let n = Int(after[after.startIndex..<end.lowerBound]) { sentinelNums.append(n) }
            rest = after[end.upperBound...]
        }
        XCTAssertFalse(sentinelNums.isEmpty, "the final screen must show sentinel lines, got \(screen.suffix(80).debugDescription)")
        XCTAssertEqual(sentinelNums, sentinelNums.sorted(),
                       "visible sentinels must be in strictly increasing order — a reorder/garble breaks this: \(sentinelNums)")
        XCTAssertEqual(sentinelNums.last, blocks - 1,
                       "the last visible sentinel must be the final block \(blocks - 1), got \(String(describing: sentinelNums.last))")

        // Still fully functional after the stress.
        writes.removeAll()
        XCTAssertEqual(surface.processOutput(bytes: Data("\u{1B}[c".utf8), streamSeq: seq), .success)
        XCTAssertEqual(writes, [da1], "post-stress DA1 must still answer byte-exactly")
    }
}
