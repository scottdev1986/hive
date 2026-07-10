import XCTest
import CoreGraphics
@testable import WorkspaceCore

final class SpatialNavigationTests: XCTestCase {

    let bounds = CGRect(x: 0, y: 0, width: 1440, height: 900)

    func testMovesRightFromMasterIntoNearestSatellite() {
        var tree = LayoutTree()
        for pane in ["orchestrator", "a", "b"] as [PaneID] { tree.insert(pane, in: bounds) }
        let frames = tree.frames(in: bounds)
        let target = SpatialNavigator.pane(from: "orchestrator", in: frames, direction: .right)
        XCTAssertNotNil(target)
        XCTAssertNotEqual(target, "orchestrator")
    }

    func testMoveBackLeftReturnsToMaster() {
        var tree = LayoutTree()
        for pane in ["orchestrator", "a", "b"] as [PaneID] { tree.insert(pane, in: bounds) }
        let frames = tree.frames(in: bounds)
        let right = SpatialNavigator.pane(from: "orchestrator", in: frames, direction: .right)!
        XCTAssertEqual(SpatialNavigator.pane(from: right, in: frames, direction: .left), "orchestrator")
    }

    func testVerticalMovementBetweenStackedSatellites() {
        var tree = LayoutTree()
        for pane in ["orchestrator", "a", "b"] as [PaneID] { tree.insert(pane, in: bounds) }
        let frames = tree.frames(in: bounds)
        // a and b share the right column; whichever is on top navigates down
        // to the other and back up.
        let aFrame = frames[PaneID("a")]!
        let bFrame = frames[PaneID("b")]!
        let (top, bottom): (PaneID, PaneID) = aFrame.minY < bFrame.minY ? ("a", "b") : ("b", "a")
        XCTAssertEqual(SpatialNavigator.pane(from: top, in: frames, direction: .down), bottom)
        XCTAssertEqual(SpatialNavigator.pane(from: bottom, in: frames, direction: .up), top)
    }

    func testNoPaneBeyondEdgeReturnsNil() {
        var tree = LayoutTree()
        for pane in ["orchestrator", "a"] as [PaneID] { tree.insert(pane, in: bounds) }
        let frames = tree.frames(in: bounds)
        XCTAssertNil(SpatialNavigator.pane(from: "orchestrator", in: frames, direction: .left))
        XCTAssertNil(SpatialNavigator.pane(from: "a", in: frames, direction: .right))
    }

    func testDeterministicWithManyPanes() {
        var tree = LayoutTree()
        for pane in ["orchestrator", "a", "b", "c", "d", "e"] as [PaneID] { tree.insert(pane, in: bounds) }
        let frames = tree.frames(in: bounds)
        for direction in Direction.allCases {
            let first = SpatialNavigator.pane(from: "orchestrator", in: frames, direction: direction)
            let second = SpatialNavigator.pane(from: "orchestrator", in: frames, direction: direction)
            XCTAssertEqual(first, second)
        }
    }
}
