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
        let surface: GhosttyManualSurface
        do {
            surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting(
                widthPx: 400,
                heightPx: 240
            )
        } catch {
            throw XCTSkip("manual surface unavailable in this environment: \(error)")
        }
        defer { surface.free() }

        XCTAssertNotNil(surface.surfaceHandle)
        XCTAssertNotNil(surface.hostView, "SF1: surface must retain hostView")

        var events: [BridgeEvent] = []
        surface.callbackContext.onEvent = { events.append($0) }
        surface.callbackContext.onWrite = { _ in }

        let bytes = Data("hello".utf8)
        let result = surface.processOutput(bytes: bytes, streamSeq: 0)
        // MF3: unconditional — green means the C boundary ran successfully.
        XCTAssertEqual(result, .success, "process_output_v1 must succeed on a live manual surface")
        XCTAssertEqual(surface.throughSeq, 5)
        XCTAssertTrue(
            events.contains { $0.type == .invalidate },
            "real process_output must fire INVALIDATE via event trampoline"
        )
        surface.sendText("x")
        XCTAssertFalse(GhosttyManualSurface.engineBuildId().isEmpty)
    }

    func testRealSurfaceProcessOutputUsesCopySafeEventTrampoline() throws {
        let surface: GhosttyManualSurface
        do {
            surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        } catch {
            throw XCTSkip("manual surface unavailable in this environment: \(error)")
        }
        defer { surface.free() }

        var observed: [BridgeEvent] = []
        surface.callbackContext.onEvent = { observed.append($0) }

        let r = surface.processOutput(bytes: Data("abc".utf8), streamSeq: 0)
        XCTAssertEqual(r, .success, "MF3: C boundary must execute")
        XCTAssertTrue(
            observed.contains { $0.type == .invalidate },
            "INVALIDATE must arrive through the copy-safe event trampoline"
        )
        XCTAssertNotNil(surface.surfaceHandle)
    }

    func testTrampolineAssignableToFactoryTypedSlots() {
        let w: hive_ghostty_write_fn = hiveBridgeWriteTrampoline
        let e: hive_ghostty_event_fn = hiveBridgeEventTrampoline
        XCTAssertNotNil(w)
        XCTAssertNotNil(e)
    }

    func testSurfaceStronglyRetainsHostViewAndCallbackContext() throws {
        // SF1/SF2: drop external strong refs; surface must keep both alive.
        var externalHost: NSView? = NSView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 240)
        )
        weak var weakHost = externalHost

        let surface: GhosttyManualSurface
        do {
            surface = try GhosttyBridgeFactory.makeManualSurface(
                hostView: externalHost!,
                widthPx: 400,
                heightPx: 240
            )
        } catch {
            throw XCTSkip("manual surface unavailable: \(error)")
        }
        defer { surface.free() }

        weak var weakCtx = surface.callbackContext
        externalHost = nil // only surface should hold the view now

        XCTAssertNotNil(weakHost, "SF1: surface must strongly retain hostView after external drop")
        XCTAssertTrue(surface.hostView === weakHost)
        XCTAssertNotNil(weakCtx, "SF2: surface must strongly retain callbackContext")
        XCTAssertTrue(surface.callbackContext === weakCtx)
    }
}
