import XCTest
import CoreGraphics
@testable import WorkspaceCore

final class LayoutTreeTests: XCTestCase {

    let bounds = CGRect(x: 0, y: 0, width: 1440, height: 900)

    func makeTree(_ panes: [PaneID]) -> LayoutTree {
        var tree = LayoutTree()
        for pane in panes { tree.insert(pane, in: bounds) }
        return tree
    }

    func testFirstPaneBecomesMasterAndFillsBounds() {
        let tree = makeTree(["orchestrator"])
        XCTAssertEqual(tree.master, "orchestrator")
        XCTAssertEqual(tree.frames(in: bounds)["orchestrator"], bounds)
    }

    func testMasterRatioStaysInBlueprintBand() {
        for requested in [0.3, 0.55, 0.58, 0.60, 0.9] {
            let metrics = LayoutMetrics(masterRatio: requested)
            XCTAssertGreaterThanOrEqual(metrics.masterRatio, 0.55)
            XCTAssertLessThanOrEqual(metrics.masterRatio, 0.60)
        }
    }

    func testMasterOccupiesConfiguredRatioWithSatellites() {
        let tree = makeTree(["orchestrator", "a", "b"])
        let frames = tree.frames(in: bounds)
        let masterWidth = frames[PaneID("orchestrator")]!.width
        let ratio = masterWidth / (bounds.width - 8) // one gap between columns
        XCTAssertEqual(ratio, 0.58, accuracy: 0.01)
        XCTAssertEqual(frames[PaneID("orchestrator")]!.height, bounds.height)
    }

    func testLayoutIsDeterministic() {
        let a = makeTree(["orchestrator", "a", "b", "c", "d"])
        let b = makeTree(["orchestrator", "a", "b", "c", "d"])
        XCTAssertEqual(a, b)
        XCTAssertEqual(a.frames(in: bounds), b.frames(in: bounds))
        // And stable across repeated solves.
        XCTAssertEqual(a.frames(in: bounds), a.frames(in: bounds))
    }

    func testInsertionSplitsLargestSatelliteLeaf() {
        // With two satellites stacked in the right column, inserting a third
        // must split one of them (the largest), never shrink the master.
        var tree = makeTree(["orchestrator", "a", "b"])
        let before = tree.frames(in: bounds)[PaneID("orchestrator")]!
        tree.insert("c", in: bounds)
        let after = tree.frames(in: bounds)
        XCTAssertEqual(after[PaneID("orchestrator")]!, before, "master untouched by satellite insertion")
        XCTAssertEqual(Set(tree.paneIDs), Set(["orchestrator", "a", "b", "c"].map { PaneID($0) }))
    }

    func testFramesTileWithoutOverlap() {
        let tree = makeTree(["orchestrator", "a", "b", "c", "d", "e"])
        let frames = Array(tree.frames(in: bounds).values)
        for i in 0..<frames.count {
            for j in (i + 1)..<frames.count {
                XCTAssertFalse(frames[i].insetBy(dx: 1, dy: 1).intersects(frames[j].insetBy(dx: 1, dy: 1)),
                               "frames \(frames[i]) and \(frames[j]) overlap")
            }
        }
        for frame in frames {
            XCTAssertTrue(bounds.contains(frame), "frame \(frame) escapes bounds")
            XCTAssertGreaterThan(frame.width, 0)
            XCTAssertGreaterThan(frame.height, 0)
        }
    }

    func testCloseCollapsesOnlyParentSplit() {
        var tree = makeTree(["orchestrator", "a", "b", "c"])
        let beforeFrames = tree.frames(in: bounds)
        // Find c's sibling region: after closing c, the sibling absorbs c's
        // space while panes outside that split keep their frames.
        tree.close("c")
        let afterFrames = tree.frames(in: bounds)
        XCTAssertNil(afterFrames[PaneID("c")])
        XCTAssertEqual(afterFrames[PaneID("orchestrator")], beforeFrames[PaneID("orchestrator")],
                       "master frame unchanged when a satellite closes")
        XCTAssertEqual(Set(tree.paneIDs), Set(["orchestrator", "a", "b"].map { PaneID($0) }))
    }

    func testCloseMasterPullsPreferredReplacement() {
        var tree = makeTree(["orchestrator", "a", "b"])
        tree.promote("a") // a is master, orchestrator now a satellite
        XCTAssertEqual(tree.master, "a")
        tree.close("a", preferredMaster: "orchestrator")
        XCTAssertEqual(tree.master, "orchestrator")
        XCTAssertEqual(Set(tree.paneIDs), Set(["orchestrator", "b"].map { PaneID($0) }))
    }

    func testPromoteSwapsWithMasterPreservingSatelliteOrder() {
        var tree = makeTree(["orchestrator", "a", "b", "c"])
        let satelliteOrderBefore = tree.paneIDs.filter { $0 != tree.master }
        tree.promote("b")
        XCTAssertEqual(tree.master, "b")
        // The old master takes exactly b's old slot: satellite traversal order
        // is unchanged except b -> orchestrator.
        let expected = satelliteOrderBefore.map { $0 == PaneID("b") ? PaneID("orchestrator") : $0 }
        XCTAssertEqual(tree.paneIDs.filter { $0 != tree.master }, expected)
    }

    func testReturnOrchestratorToMasterIsPromoteRoundTrip() {
        var tree = makeTree(["orchestrator", "a", "b", "c"])
        let original = tree
        tree.promote("c")
        tree.promote("orchestrator") // Return Orchestrator to Master
        XCTAssertEqual(tree.master, "orchestrator")
        XCTAssertEqual(tree, original, "swap + swap-back restores the identical tree")
    }

    func testPromoteMasterIsNoOp() {
        var tree = makeTree(["orchestrator", "a"])
        let before = tree
        tree.promote("orchestrator")
        XCTAssertEqual(tree, before)
    }

    func testSinglePaneAfterClosingEverythingElse() {
        var tree = makeTree(["orchestrator", "a", "b"])
        tree.close("a")
        tree.close("b")
        XCTAssertEqual(tree.frames(in: bounds)[PaneID("orchestrator")], bounds)
        tree.close("orchestrator")
        XCTAssertTrue(tree.isEmpty)
    }
}
