import XCTest
@testable import HiveTerminalKit

final class OutputRangeApplicatorTests: XCTestCase {
    private var engine: FakeManualSurface!
    private var applicator: OutputRangeApplicator!
    private var binding: SurfaceBinding!

    override func setUp() {
        super.setUp()
        engine = FakeManualSurface()
        applicator = OutputRangeApplicator(engine: engine)
        binding = SurfaceBinding(locator: makeTestLocator(), connectionId: "conn-1")
        applicator.bind(binding, highWater: 0)
    }

    func testContiguousOrderedRangesAdvanceHighWater() {
        XCTAssertEqual(
            applicator.apply(bytes: Data("abc".utf8), streamSeq: 0, frameBinding: binding),
            .applied(newHighWater: 3)
        )
        XCTAssertEqual(
            applicator.apply(bytes: Data("def".utf8), streamSeq: 3, frameBinding: binding),
            .applied(newHighWater: 6)
        )
    }

    func testDuplicateEqualIgnored() {
        XCTAssertEqual(
            applicator.apply(bytes: Data("abc".utf8), streamSeq: 0, frameBinding: binding),
            .applied(newHighWater: 3)
        )
        XCTAssertEqual(
            applicator.apply(bytes: Data("abc".utf8), streamSeq: 0, frameBinding: binding),
            .duplicateIgnored
        )
        XCTAssertEqual(engine.appliedRanges.count, 1)
    }

    func testDuplicateDigestConflictRequiresRebase() {
        XCTAssertEqual(
            applicator.apply(bytes: Data("abc".utf8), streamSeq: 0, frameBinding: binding),
            .applied(newHighWater: 3)
        )
        XCTAssertEqual(
            applicator.apply(bytes: Data("abd".utf8), streamSeq: 0, frameBinding: binding),
            .digestConflictRebaseRequired
        )
    }

    func testGapRequiresRebase() {
        XCTAssertEqual(
            applicator.apply(bytes: Data("abc".utf8), streamSeq: 0, frameBinding: binding),
            .applied(newHighWater: 3)
        )
        XCTAssertEqual(
            applicator.apply(bytes: Data("x".utf8), streamSeq: 4, frameBinding: binding),
            .gapRebaseRequired
        )
    }

    func testPostRestoreRetransmitIgnored() {
        XCTAssertEqual(
            applicator.restoreCheckpoint(payload: Data("snap".utf8), throughSeq: 10, frameBinding: binding),
            .applied(newHighWater: 10)
        )
        // Fully behind high-water after restore — at-least-once retransmit (M7).
        XCTAssertEqual(
            applicator.apply(bytes: Data("old-bytes".utf8), streamSeq: 0, frameBinding: binding),
            .duplicateIgnored
        )
        XCTAssertEqual(applicator.highWater, 10)
        XCTAssertEqual(engine.appliedRanges.count, 0)
    }

    func testEmptyBytesRejected() {
        XCTAssertEqual(
            applicator.apply(bytes: Data(), streamSeq: 0, frameBinding: binding),
            .engineError(.invalidValue)
        )
    }
}
