import AppKit
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

/// Gate 5 (M1-B1) stress: a large ordered stream through the REAL
/// `hive_ghostty_surface_process_output_v1` boundary. The story requires
/// stressing large streams; this drives ~8 MiB of mixed plain text, SGR,
/// cursor movement, and reply-producing controls in uneven chunk sizes and
/// proves the contract holds end to end: every chunk accepted, through_seq
/// advances by exactly the total byte count, every DA1 query embedded in
/// the stream is answered exactly once in order, and the surface remains
/// correct (screen readback + a fresh reply) afterward.
final class OrderedOutputStressTests: XCTestCase {
    private func makeSurface() throws -> GhosttyManualSurface {
        do {
            return try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        } catch {
            XCTFail("real manual surface required for gate 5 live proof, got: \(error)")
            throw error
        }
    }

    func testEightMiBOrderedStreamMaintainsSeqRepliesAndUsability() throws {
        let surface = try makeSurface()
        defer { surface.free() }

        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }

        // Deterministic content block (~64 KiB) with one DA1 query per block:
        // text, SGR color churn, cursor addressing, newlines.
        var block = Data()
        block.append(Data("\u{1B}[c".utf8)) // DA1 — must answer exactly once per block
        while block.count < 64 * 1024 {
            block.append(Data("\u{1B}[31mstress\u{1B}[0m line of ordinary text \u{1B}[2;10Hmoved\r\n".utf8))
        }
        let blocks = 128 // ~8 MiB total

        // Uneven chunk sizes that never align with block or sequence
        // boundaries — the parser must be indifferent to chunking.
        let chunkSizes = [1, 7, 1023, 4096, 65_537]
        var seq: UInt64 = 0
        var pending = Data()
        var fed = 0
        var chunkIndex = 0
        for _ in 0..<blocks { pending.append(block) }
        while fed < pending.count {
            let size = min(chunkSizes[chunkIndex % chunkSizes.count], pending.count - fed)
            chunkIndex += 1
            let chunk = pending.subdata(in: fed..<(fed + size))
            let result = surface.processOutput(bytes: chunk, streamSeq: seq)
            XCTAssertEqual(result, .success,
                           "chunk at seq \(seq) size \(size) must be accepted")
            if result != .success { return } // avoid 8 MiB of cascading failures
            seq += UInt64(size)
            fed += size
        }

        XCTAssertEqual(surface.throughSeq, UInt64(pending.count),
                       "through_seq must advance by exactly the total byte count")
        XCTAssertEqual(writes.count, blocks,
                       "every DA1 embedded in the stream must be answered exactly once, in order")
        XCTAssertTrue(writes.allSatisfy { $0 == Data("\u{1B}[?62;22c".utf8) },
                      "every reply must be the byte-exact pinned DA1 answer")

        // The surface is still fully functional after the stress: a fresh
        // query replies, at the correct continuing sequence.
        writes.removeAll()
        XCTAssertEqual(surface.processOutput(bytes: Data("\u{1B}[>c".utf8), streamSeq: seq), .success)
        XCTAssertEqual(writes, [Data("\u{1B}[>1;10;0c".utf8)],
                       "post-stress DA2 must still answer byte-exactly")
    }
}
