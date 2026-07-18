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
/// - https://developer.apple.com/tutorials/data/documentation/quartzcore/cametallayer/drawablesize.json
/// - https://developer.apple.com/tutorials/data/documentation/appkit/nswindow/didchangescreennotification.json
/// - https://developer.apple.com/tutorials/data/documentation/appkit/nsworkspace/didwakenotification.json
///
/// Physical monitor moves, device loss/recreation, and Instruments
/// frame-pacing/memory measurements additionally require full-app live proof.
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
        XCTAssertEqual(view.appliedDrawableSize, view.convertToBacking(view.bounds.size))
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

    func testCloseCancelsDrawAlreadyQueuedByInvalidate() {
        let engine = FakeManualSurface()
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 240),
            engine: engine
        )

        engine.callbackContext.onEvent?(BridgeEvent(type: .invalidate))
        view.userClose()
        waitForMainQueue(delay: 0.05)

        XCTAssertEqual(engine.drawCount, 0)
        XCTAssertTrue(engine.freed)
    }

    func testResizeUsesGhosttyReportedCellGeometryExactly() throws {
        let view = try makeRealView()
        defer { view.userClose() }
        view.setFrameSize(NSSize(width: 503, height: 307))

        XCTAssertTrue(waitUntil { view.reportedGeometry != nil })
        guard let size = view.engine.reportedSize() else {
            return XCTFail("real surface disappeared before geometry readback")
        }
        let expected = TerminalGeometry(
            columns: Int(size.columns),
            rows: Int(size.rows),
            widthPx: Int(size.widthPx),
            heightPx: Int(size.heightPx),
            cellWidthPx: Double(size.cellWidthPx),
            cellHeightPx: Double(size.cellHeightPx)
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

    func testRenderingStateUsesMainConfinedEngineWrappers() {
        let engine = FakeManualSurface()
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 240),
            engine: engine
        )
        defer { view.userClose() }
        let window = ControlledWindow(
            contentRect: view.bounds,
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.controlledOcclusionState = [.visible]
        window.contentView = view
        view.viewDidChangeBackingProperties()

        XCTAssertEqual(engine.contentScaleCalls.last?.0, view.appliedContentScale.width)
        XCTAssertEqual(engine.contentScaleCalls.last?.1, view.appliedContentScale.height)
        XCTAssertEqual(engine.displayIDCalls.last, view.appliedDisplayID)
        XCTAssertEqual(engine.occlusionCalls.last, true)
    }

    func testLiveResizeCommitsEveryDistinctFramebufferBeforeQuiescence() {
        let engine = FakeManualSurface()
        engine.fakeReportedSize = ManualSurfaceSize(
            columns: 61,
            rows: 17,
            widthPx: 503,
            heightPx: 307,
            cellWidthPx: 8,
            cellHeightPx: 18
        )
        let view = HiveTerminalView(frame: .zero, engine: engine)
        defer { view.userClose() }

        view.setFrameSize(NSSize(width: 320, height: 180))
        view.setFrameSize(NSSize(width: 503, height: 307))

        XCTAssertEqual(engine.sizeCalls.count, 2)
        let backingSize = view.convertToBacking(view.bounds.size)
        XCTAssertEqual(view.appliedDrawableSize, backingSize)
        XCTAssertEqual(engine.sizeCalls.last?.0, UInt32(backingSize.width.rounded()))
        XCTAssertEqual(engine.sizeCalls.last?.1, UInt32(backingSize.height.rounded()))
        XCTAssertEqual(
            view.reportedGeometry,
            TerminalGeometry(
                columns: 61,
                rows: 17,
                widthPx: 503,
                heightPx: 307,
                cellWidthPx: 8,
                cellHeightPx: 18
            ),
            "cell geometry must be Ghostty's report, never derived from pixels"
        )
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
        XCTAssertEqual(engine.sizeCalls.count, 1, "positive control: nonzero resize must commit")

        view.setFrameSize(NSSize(width: 640, height: 360))
        XCTAssertEqual(engine.sizeCalls.count, 2, "live resize must not wait for quiescence")
        view.setFrameSize(.zero)
        waitForMainQueue(delay: 0.15)
        XCTAssertEqual(
            engine.sizeCalls.count,
            2,
            "zero/minimized geometry must cancel the pending nonzero resize"
        )
    }

    func testOcclusionSuppressesDrawAndPresentsOnePendingFrameWhenVisible() {
        let engine = FakeManualSurface()
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 240),
            engine: engine
        )
        defer { view.userClose() }
        let window = ControlledWindow(
            contentRect: view.bounds,
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView = view

        engine.callbackContext.onEvent?(BridgeEvent(type: .invalidate))
        engine.callbackContext.onEvent?(BridgeEvent(type: .invalidate))
        waitForMainQueue(delay: 0.05)
        XCTAssertEqual(engine.drawCount, 0)

        window.controlledOcclusionState = [.visible]
        NotificationCenter.default.post(name: NSWindow.didChangeOcclusionStateNotification, object: window)
        XCTAssertTrue(waitUntil { engine.drawCount == 1 })
        XCTAssertEqual(view.drawScheduledCount, 1)
    }

    func testSleepDefersPendingDrawAndWakeRefreshesExactlyOnce() {
        let engine = FakeManualSurface()
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 240),
            engine: engine
        )
        defer { view.userClose() }
        let window = ControlledWindow(
            contentRect: view.bounds,
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.controlledOcclusionState = [.visible]
        window.contentView = view

        NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.willSleepNotification, object: nil)
        engine.callbackContext.onEvent?(BridgeEvent(type: .invalidate))
        waitForMainQueue(delay: 0.05)
        XCTAssertEqual(engine.drawCount, 0)
        XCTAssertEqual(engine.occlusionCalls.last, false)

        NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.didWakeNotification, object: nil)
        XCTAssertTrue(waitUntil { engine.drawCount == 1 })
        XCTAssertEqual(engine.refreshCount, 1)
    }

    func testRendererHealthIsSurfaceScopedDeferredAndRecoverable() {
        let engine = FakeManualSurface()
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 240),
            engine: engine
        )
        defer { view.userClose() }
        var observed: [RendererHealth] = []
        view.onRendererHealthChange = { observed.append($0) }

        engine.callbackContext.enqueueRendererHealth(.unhealthy)
        XCTAssertTrue(waitUntil { view.rendererHealthy == false })
        XCTAssertEqual(observed, [.unhealthy])
        engine.callbackContext.onEvent?(BridgeEvent(type: .invalidate))
        waitForMainQueue(delay: 0.05)
        XCTAssertEqual(engine.drawCount, 0, "unhealthy surfaces must not submit more frames")

        engine.callbackContext.enqueueRendererHealth(.healthy)
        XCTAssertTrue(waitUntil { view.rendererHealthy })
        XCTAssertEqual(observed, [.unhealthy, .healthy])
        XCTAssertEqual(engine.refreshCount, 1)
        XCTAssertTrue(waitUntil { engine.drawCount == 1 }, "one pending frame must present after recovery")
    }

    func testRuntimeHealthActionTargetsOnlyItsRealSurface() throws {
        let first = try makeRealView()
        let second = try makeRealView()
        defer {
            first.userClose()
            second.userClose()
        }
        guard
            let firstSurface = first.engine as? GhosttyManualSurface,
            let firstHandle = firstSurface.surfaceHandle,
            let app = firstSurface.appOwner?.app
        else { return XCTFail("real registered surface required") }

        var firstHealth: [RendererHealth] = []
        var secondHealth: [RendererHealth] = []
        first.onRendererHealthChange = { firstHealth.append($0) }
        second.onRendererHealthChange = { secondHealth.append($0) }

        let wakeup = GhosttyAppWakeupContext()
        let runtime = GhosttyBridgeFactory.makeRuntimeConfig(wakeupContext: wakeup)
        guard let actionCallback = runtime.action_cb else {
            return XCTFail("real runtime action callback must be wired")
        }
        var target = ghostty_target_s()
        target.tag = GHOSTTY_TARGET_SURFACE
        target.target.surface = firstHandle
        var action = ghostty_action_s()
        action.tag = GHOSTTY_ACTION_RENDERER_HEALTH
        action.action.renderer_health = GHOSTTY_RENDERER_HEALTH_UNHEALTHY

        XCTAssertFalse(actionCallback(app, target, action))
        XCTAssertTrue(waitUntil { firstHealth == [.unhealthy] })
        XCTAssertTrue(secondHealth.isEmpty)
        XCTAssertFalse(first.rendererHealthy)
        XCTAssertTrue(second.rendererHealthy)
    }

    func testIdleSurfaceHasNoTimerDrivenOrAppKitDraws() {
        let engine = FakeManualSurface()
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 240),
            engine: engine
        )
        defer { view.userClose() }

        engine.callbackContext.onEvent?(BridgeEvent(type: .invalidate))
        XCTAssertTrue(waitUntil { engine.drawCount == 1 })
        waitForMainQueue(delay: 0.15)
        view.draw(view.bounds)
        XCTAssertEqual(engine.drawCount, 1)
    }

    /// Opt-in frozen-pin proof for hardware XCTest cannot manufacture. Run on
    /// a Mac with one Retina and one non-Retina display, then drag the window
    /// across displays when prompted. With PHYSICAL_SLEEP=1, sleep and wake the
    /// Mac once too. The default suite skips this rather than fabricating proof.
    func testPhysicalMonitorScaleAndSleepWakeQualification() throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["HIVE_GHOSTTY_GATE7_PHYSICAL"] == "1" else {
            throw XCTSkip("requires interactive multi-display qualification hardware")
        }
        XCTAssertGreaterThanOrEqual(NSScreen.screens.count, 2)

        let view = try makeRealView()
        defer { view.userClose() }
        let window = NSWindow(
            contentRect: view.bounds,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.contentView = view
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        guard
            waitUntil({ view.appliedDisplayID != nil }),
            let initialDisplayID = view.appliedDisplayID
        else { return XCTFail("initial display identity was not applied") }
        let initialScale = view.appliedContentScale

        print("GATE7 PHYSICAL: drag the qualification window to the other-scale display")
        XCTAssertTrue(waitUntil(timeout: 120) {
            view.appliedDisplayID != initialDisplayID && view.appliedContentScale != initialScale
        })
        XCTAssertEqual(view.appliedDrawableSize, view.convertToBacking(view.bounds.size))
        XCTAssertNotNil(view.reportedGeometry)

        let idleDraws = view.drawScheduledCount
        waitForMainQueue(delay: 2)
        XCTAssertEqual(view.drawScheduledCount, idleDraws, "idle surface must not schedule frames")

        if environment["HIVE_GHOSTTY_GATE7_PHYSICAL_SLEEP"] == "1" {
            let wakeCount = view.wakeTransitionCount
            print("GATE7 PHYSICAL: sleep and wake the Mac now")
            XCTAssertTrue(waitUntil(timeout: 600) { view.wakeTransitionCount > wakeCount })
            XCTAssertTrue(view.appliedOcclusionVisible ?? false)
        }
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
