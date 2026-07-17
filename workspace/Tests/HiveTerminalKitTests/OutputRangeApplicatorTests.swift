import XCTest
@testable import HiveTerminalKit

/// Ordered-range application including gap/duplicate (§20/§23).
/// Uses: FakeManualSurface (no GhosttyKit).
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
        let a = Data("abc".utf8)
        let b = Data("def".utf8)
        XCTAssertEqual(
            applicator.apply(bytes: a, streamSeq: 0, frameBinding: binding),
            .applied(newHighWater: 3)
        )
        XCTAssertEqual(
            applicator.apply(bytes: b, streamSeq: 3, frameBinding: binding),
            .applied(newHighWater: 6)
        )
        XCTAssertEqual(applicator.highWater, 6)
        XCTAssertEqual(engine.appliedRanges.count, 2)
    }

    func testDuplicateEqualIgnored() {
        let a = Data("abc".utf8)
        XCTAssertEqual(
            applicator.apply(bytes: a, streamSeq: 0, frameBinding: binding),
            .applied(newHighWater: 3)
        )
        let again = applicator.apply(bytes: a, streamSeq: 0, frameBinding: binding)
        XCTAssertEqual(again, .duplicateIgnored)
        XCTAssertEqual(applicator.highWater, 3)
        // Engine may also see the second call only if applicator forwards —
        // duplicate is short-circuited in applicator before engine.
        XCTAssertEqual(engine.appliedRanges.count, 1)
    }

    func testDuplicateDigestConflictRequiresRebase() {
        let a = Data("abc".utf8)
        XCTAssertEqual(
            applicator.apply(bytes: a, streamSeq: 0, frameBinding: binding),
            .applied(newHighWater: 3)
        )
        let conflict = applicator.apply(
            bytes: Data("abd".utf8),
            streamSeq: 0,
            frameBinding: binding
        )
        XCTAssertEqual(conflict, .digestConflictRebaseRequired)
        XCTAssertEqual(applicator.highWater, 3, "high-water must not advance on conflict")
    }

    func testGapRequiresRebase() {
        let a = Data("abc".utf8)
        XCTAssertEqual(
            applicator.apply(bytes: a, streamSeq: 0, frameBinding: binding),
            .applied(newHighWater: 3)
        )
        // Gap: next expected is 3, frame starts at 4.
        let gap = applicator.apply(
            bytes: Data("x".utf8),
            streamSeq: 4,
            frameBinding: binding
        )
        XCTAssertEqual(gap, .gapRebaseRequired)
        XCTAssertEqual(engine.appliedRanges.count, 1, "gap must not call engine accept path")
    }

    func testEmptyBytesRejected() {
        let result = applicator.apply(bytes: Data(), streamSeq: 0, frameBinding: binding)
        XCTAssertEqual(result, .engineError(.invalidValue))
    }
}
