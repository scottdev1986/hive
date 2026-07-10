import XCTest
import CoreGraphics
@testable import WorkspaceCore

final class LayoutTransitionTests: XCTestCase {

    func testDurationIsRoughly180ms() {
        XCTAssertEqual(LayoutTransition.duration, 0.18, accuracy: 0.001)
    }

    func testProgressClampsAndEases() {
        XCTAssertEqual(LayoutTransition.progress(elapsed: -1), 0)
        XCTAssertEqual(LayoutTransition.progress(elapsed: 0), 0)
        XCTAssertEqual(LayoutTransition.progress(elapsed: 0.09), 0.5, accuracy: 0.01)
        XCTAssertEqual(LayoutTransition.progress(elapsed: 0.18), 1)
        XCTAssertEqual(LayoutTransition.progress(elapsed: 10), 1)
        // Monotonic
        var previous = -0.1
        for step in stride(from: 0.0, through: 0.18, by: 0.01) {
            let p = LayoutTransition.progress(elapsed: step)
            XCTAssertGreaterThanOrEqual(p, previous)
            previous = p
        }
    }

    func testInterpolationEndpoints() {
        let from = CGRect(x: 0, y: 0, width: 100, height: 100)
        let to = CGRect(x: 50, y: 20, width: 300, height: 200)
        XCTAssertEqual(LayoutTransition.interpolate(from: from, to: to, progress: 0), from)
        XCTAssertEqual(LayoutTransition.interpolate(from: from, to: to, progress: 1), to)
        let mid = LayoutTransition.interpolate(from: from, to: to, progress: 0.5)
        XCTAssertEqual(mid.minX, 25, accuracy: 0.001)
        XCTAssertEqual(mid.width, 200, accuracy: 0.001)
    }

    func testInterruptionRetargetsFromPresentationValue() {
        // Simulate: animate A→B, interrupt halfway, retarget to C. The new
        // transition must start exactly at the interrupted presentation frame.
        let a = CGRect(x: 0, y: 0, width: 100, height: 100)
        let b = CGRect(x: 200, y: 0, width: 100, height: 100)
        let c = CGRect(x: 0, y: 300, width: 50, height: 50)
        let midProgress = LayoutTransition.progress(elapsed: 0.09)
        let presentation = LayoutTransition.interpolate(from: a, to: b, progress: midProgress)
        let retargetStart = LayoutTransition.interpolate(from: presentation, to: c, progress: 0)
        XCTAssertEqual(retargetStart, presentation)
        XCTAssertEqual(LayoutTransition.interpolate(from: presentation, to: c, progress: 1), c)
    }
}
