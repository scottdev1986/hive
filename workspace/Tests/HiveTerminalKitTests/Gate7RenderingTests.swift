import AppKit
import HiveGhosttyC
import XCTest
@testable import HiveTerminalKit

/// Gate 7 scriptable qualification for the real AppKit/Ghostty rendering
/// surface. Ghostty owns one IOSurface-backed layer and accepts framebuffer
/// pixels, content scale, display identity, occlusion, and draw requests from
/// the host. The host must relay those values without inventing terminal cells.
///
/// Contract sources:
/// - https://raw.githubusercontent.com/ghostty-org/ghostty/73534c4680a809398b396c94ac7f12fcccb7963d/include/ghostty.h
/// - https://github.com/ghostty-org/ghostty/blob/73534c4680a809398b396c94ac7f12fcccb7963d/src/renderer/Metal.zig
/// - https://developer.apple.com/documentation/appkit/nsview/viewdidchangebackingproperties()
/// - https://developer.apple.com/documentation/metal/managing-your-game-window-for-metal-in-macos
///
/// Physical monitor moves, OS sleep/wake, device failure/recreation, and
/// Instruments frame-pacing/memory measurements remain full-app live proofs.
final class Gate7RenderingTests: XCTestCase {
    func testProductionViewHostsPinnedGhosttyIOSurfaceLayer() throws {
        let view = try makeRealView()
        defer { view.userClose() }

        let layer = try requireRenderingLayer(view)
        let genericView = NSView(frame: view.bounds)
        genericView.wantsLayer = true

        XCTAssertNotNil(view.engine.surfaceHandle, "real Ghostty surface must be alive")
        XCTAssertTrue(view.subviews.contains { $0.layer === layer })
        XCTAssertTrue(
            String(describing: type(of: layer)).contains("IOSurfaceLayer"),
            "pinned Ghostty Metal renders into its IOSurface-backed CALayer"
        )
        XCTAssertFalse(
            genericView.layer.map { String(describing: type(of: $0)).contains("IOSurfaceLayer") } ?? false,
            "positive control: an ordinary layer-backed NSView must not satisfy the renderer assertion"
        )
    }

    func testRealOutputProducesGPUBackedLayerContents() throws {
        let view = try makeRealView()
        defer { view.userClose() }
        let layer = try requireRenderingLayer(view)

        let result = view.engine.processOutput(bytes: Data("gate-7-live-frame".utf8), streamSeq: 0)
        XCTAssertEqual(result, .success)
        XCTAssertTrue(waitUntil { view.drawScheduledCount == 1 })
        XCTAssertTrue(
            waitUntil(timeout: 2) { layer.contents != nil },
            "a real INVALIDATE draw must present an IOSurface into the renderer layer"
        )
    }

    func testInvalidateCoalescesAndNeverDrawsAgainThroughAppKitDraw() {
        let engine = FakeManualSurface()
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 240),
            engine: engine
        )
        defer { view.userClose() }

        engine.callbackContext.onEvent?(BridgeEvent(type: .invalidate))
        engine.callbackContext.onEvent?(BridgeEvent(type: .invalidate))
        engine.callbackContext.onEvent?(BridgeEvent(type: .invalidate))
        XCTAssertTrue(waitUntil { engine.drawCount == 1 })
        XCTAssertEqual(view.drawScheduledCount, 1)

        view.draw(view.bounds)
        XCTAssertEqual(
            engine.drawCount,
            1,
            "AppKit drawing must not duplicate Ghostty's already-scheduled draw"
        )

        engine.callbackContext.onEvent?(BridgeEvent(type: .invalidate))
        XCTAssertTrue(waitUntil { engine.drawCount == 2 }, "positive control: a later invalidate remains observable")
    }

    func testResizeUsesGhosttyReportedCellGeometryExactly() throws {
        let view = try makeRealView()
        defer { view.userClose() }
        view.setFrameSize(NSSize(width: 503, height: 307))

        XCTAssertTrue(waitUntil { view.reportedGeometry != nil })
        guard let surface = view.engine.surfaceHandle else {
            return XCTFail("real surface disappeared before geometry readback")
        }
        let size = ghostty_surface_size(surface)
        let expected = TerminalGeometry(
            columns: Int(size.columns),
            rows: Int(size.rows),
            widthPx: Int(size.width_px),
            heightPx: Int(size.height_px),
            cellWidthPx: Double(size.cell_width_px),
            cellHeightPx: Double(size.cell_height_px)
        )

        XCTAssertEqual(view.reportedGeometry, expected)
        XCTAssertGreaterThan(expected.columns, 0)
        XCTAssertGreaterThan(expected.rows, 0)
        XCTAssertGreaterThan(expected.cellWidthPx, 0)
        XCTAssertGreaterThan(expected.cellHeightPx, 0)
    }

    func testBackingDisplayAndOcclusionChangesReachRealSurface() throws {
        let view = try makeRealView()
        defer { view.userClose() }
        let window = ControlledWindow(
            contentRect: view.bounds,
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView = view
        view.viewDidChangeBackingProperties()

        let layer = try requireRenderingLayer(view)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.contentsScale = 0.5
        CATransaction.commit()
        view.viewDidChangeBackingProperties()

        let backingSize = view.convertToBacking(view.bounds.size)
        XCTAssertEqual(view.appliedContentScale.width, backingSize.width / view.bounds.width)
        XCTAssertEqual(view.appliedContentScale.height, backingSize.height / view.bounds.height)
        XCTAssertEqual(layer.contentsScale, window.backingScaleFactor)

        guard
            let screen = window.screen,
            let screenNumber = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        else { return XCTFail("a real screen is required for display-id qualification") }
        XCTAssertEqual(view.appliedDisplayID, screenNumber.uint32Value)

        window.controlledOcclusionState = [.visible]
        NotificationCenter.default.post(name: NSWindow.didChangeOcclusionStateNotification, object: window)
        XCTAssertTrue(waitUntil { view.appliedOcclusionVisible == true })
        window.controlledOcclusionState = []
        NotificationCenter.default.post(name: NSWindow.didChangeOcclusionStateNotification, object: window)
        XCTAssertTrue(waitUntil { view.appliedOcclusionVisible == false })
    }

    func testZeroSizeCancelsPendingResizeInsteadOfCommittingStalePixels() {
        let engine = FakeManualSurface()
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 240),
            engine: engine
        )
        defer { view.userClose() }
        _ = view.makeAttachClient()
        view.retarget(
            to: SurfaceBinding(locator: makeTestLocator(), connectionId: "gate-7-resize"),
            highWater: 0
        )

        view.setFrameSize(NSSize(width: 320, height: 180))
        XCTAssertTrue(waitUntil { engine.sizeCalls.count == 1 }, "positive control: nonzero resize must commit")
        let committedCount = engine.sizeCalls.count

        view.setFrameSize(NSSize(width: 640, height: 360))
        view.setFrameSize(.zero)
        waitForMainQueue(delay: 0.15)
        XCTAssertEqual(
            engine.sizeCalls.count,
            committedCount,
            "zero/minimized geometry must cancel the pending nonzero resize"
        )
    }

    func testRealViewAndRendererOwnerReleaseWithoutExplicitClose() throws {
        weak var weakView: HiveTerminalView?
        weak var weakEngine: GhosttyManualSurface?

        try autoreleasepool {
            let view = try makeRealView()
            weakView = view
            weakEngine = view.engine as? GhosttyManualSurface
            XCTAssertNotNil(weakEngine?.surfaceHandle, "positive control: live owner must hold the surface")
        }

        XCTAssertTrue(waitUntil { weakView == nil && weakEngine == nil })
        XCTAssertNil(weakView)
        XCTAssertNil(weakEngine)
    }

    private func makeRealView() throws -> HiveTerminalView {
        do {
            return try HiveTerminalView(
                frame: NSRect(x: 0, y: 0, width: 400, height: 240)
            )
        } catch {
            XCTFail("real manual surface required for gate 7 live proof, got: \(error)")
            throw error
        }
    }

    private func requireRenderingLayer(_ view: HiveTerminalView) throws -> CALayer {
        guard waitUntil({ view.ghosttyRenderingLayer != nil }), let layer = view.ghosttyRenderingLayer else {
            XCTFail("real Ghostty surface did not install its renderer layer")
            throw QualificationError.rendererLayerMissing
        }
        return layer
    }

    @discardableResult
    private func waitUntil(
        timeout: TimeInterval = 1,
        _ condition: @escaping () -> Bool
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        return condition()
    }

    private func waitForMainQueue(delay: TimeInterval) {
        let complete = expectation(description: "main queue delay")
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { complete.fulfill() }
        wait(for: [complete], timeout: max(1, delay + 0.5))
    }

    private enum QualificationError: Error {
        case rendererLayerMissing
    }

    private final class ControlledWindow: NSWindow {
        var controlledOcclusionState: NSWindow.OcclusionState = []

        override var occlusionState: NSWindow.OcclusionState {
            controlledOcclusionState
        }
    }
}
