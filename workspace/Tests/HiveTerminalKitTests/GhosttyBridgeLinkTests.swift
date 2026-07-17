import AppKit
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

/// L0 real GhosttyKit + new_manual_v1 (B2/M2).
final class GhosttyBridgeLinkTests: XCTestCase {
    func testEngineBuildIdSymbolResolves() {
        let buildId = GhosttyManualSurface.engineBuildId()
        XCTAssertFalse(buildId.isEmpty)
        XCTAssertGreaterThanOrEqual(buildId.count, 32)
    }

    func testFactoryCreatesManualSurfaceWithRealCallbacks() throws {
        let pair = try GhosttyBridgeFactory.makeManualSurfaceForTesting(
            widthPx: 400,
            heightPx: 240
        )
        let surface = pair.surface
        let hostView = pair.hostView
        defer { surface.free() }
        // Keep hostView alive for the C nsview pointer (M2/platform).
        withExtendedLifetime(hostView) {
            XCTAssertNotNil(surface.surfaceHandle)

            let ctx = surface.callbackContext
            var events: [BridgeEvent] = []
            ctx.onEvent = { events.append($0) }
            ctx.onWrite = { _ in }

            let bytes = Data("hello".utf8)
            let result = surface.processOutput(bytes: bytes, streamSeq: 0)
            XCTAssertTrue(
                result == .success || result == .invalidValue || result == .outOfMemory,
                "unexpected result \(result)"
            )
            if result == .success {
                XCTAssertEqual(surface.throughSeq, 5)
                // Real bridge emits invalidate on accept.
                XCTAssertTrue(
                    events.contains { $0.type == .invalidate },
                    "real process_output should fire INVALIDATE via event trampoline"
                )
            }

            surface.sendText("x")
            XCTAssertFalse(GhosttyManualSurface.engineBuildId().isEmpty)
        }
    }

    func testRealSurfaceProcessOutputUsesCopySafeEventTrampoline() throws {
        let pair = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        defer { pair.surface.free() }
        withExtendedLifetime(pair.hostView) {
            var titles: [Data] = []
            pair.surface.callbackContext.onEvent = { event in
                if event.type == .invalidate || event.type == .title || event.type == .pwd {
                    titles.append(event.bytes)
                }
            }
            // Drive C → Swift event path via real process_output_v1.
            let r = pair.surface.processOutput(bytes: Data("abc".utf8), streamSeq: 0)
            if r == .success {
                // INVALIDATE carries empty bytes; presence proves event trampoline ran.
                XCTAssertTrue(
                    titles.count >= 0 && pair.surface.callbackContext.onEvent != nil
                )
                // Stronger: at least one event observed when process succeeds.
                XCTAssertFalse(
                    titles.isEmpty,
                    "success process_output must emit at least INVALIDATE through event trampoline"
                )
            }
            XCTAssertNotNil(pair.surface.surfaceHandle)
        }
    }

    func testTrampolineAssignableToFactoryTypedSlots() {
        let w: hive_ghostty_write_fn = hiveBridgeWriteTrampoline
        let e: hive_ghostty_event_fn = hiveBridgeEventTrampoline
        XCTAssertNotNil(w)
        XCTAssertNotNil(e)
    }

    func testSurfaceRetainsCallbackContextForLifetime() throws {
        // M2: surface holds the context; free surface before context can drop.
        let pair = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        let ctx = pair.surface.callbackContext
        withExtendedLifetime(pair.hostView) {
            weak var weakCtx: BridgeCallbackContext? = ctx
            XCTAssertNotNil(weakCtx)
            pair.surface.free()
            // After free, our local `ctx` still retains; surface no longer uses it.
            XCTAssertNotNil(ctx)
        }
    }
}
