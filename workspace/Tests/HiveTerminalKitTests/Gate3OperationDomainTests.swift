import AppKit
import HiveGhosttyC
import XCTest
@testable import HiveTerminalKit

/// Gate 3: the Swift wrapper admits every Ghostty app/surface operation to
/// the main queue. Output and restore may originate off-main, but their bytes
/// are copied before admission; callback delivery occurs only after C returns.
final class Gate3OperationDomainTests: XCTestCase {
    func testOffMainOutputCopiesBeforeMainAdmissionAndCallsCOnMain() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        defer { surface.free() }

        let count = 64
        let storage = UnsafeMutablePointer<UInt8>.allocate(capacity: count)
        defer { storage.deallocate() }
        storage.initialize(repeating: 0x20, count: count)
        storage[0] = 0x48
        storage[1] = 0x69
        storage[2] = 0x76
        storage[3] = 0x65
        let source = Data(bytesNoCopy: storage, count: count, deallocator: .none)

        let copied = DispatchSemaphore(value: 0)
        let allowAdmission = DispatchSemaphore(value: 0)
        surface.outputCopyObserver = { owned in
            XCTAssertEqual(owned.prefix(4), Data("Hive".utf8))
            copied.signal()
            allowAdmission.wait()
        }

        var entryWasMain = false
        surface.operationObserver = { operation, phase in
            if operation == "processOutput", phase == .begin {
                entryWasMain = Thread.isMainThread
            }
        }

        var result: GhosttyBridgeResult?
        let finished = expectation(description: "off-main output finished")
        DispatchQueue.global(qos: .userInitiated).async {
            result = surface.processOutput(bytes: source, streamSeq: 0)
            finished.fulfill()
        }

        XCTAssertEqual(copied.wait(timeout: .now() + 2), .success)
        storage.update(repeating: 0x58, count: count)
        XCTAssertEqual(source, Data(repeating: 0x58, count: count), "positive control: caller storage changed")
        allowAdmission.signal()
        wait(for: [finished], timeout: 2)

        XCTAssertEqual(result, .success)
        XCTAssertTrue(entryWasMain)
        XCTAssertTrue(readScreen(surface).contains("Hive"))
        XCTAssertFalse(readScreen(surface).contains("XXXX"))
    }

    func testOutputAndFreeNeverOverlapAndNoCallbackArrivesAfterFree() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        let stateLock = NSLock()
        var activeOperations = 0
        var overlapDetected = false
        surface.operationObserver = { _, phase in
            stateLock.lock()
            if phase == .begin {
                activeOperations += 1
                overlapDetected = overlapDetected || activeOperations > 1
            } else {
                activeOperations -= 1
            }
            stateLock.unlock()
        }

        var deliveredAfterFree = 0
        surface.callbackContext.onEvent = { _ in deliveredAfterFree += 1 }
        let start = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        DispatchQueue.global().async(group: group) {
            start.wait()
            _ = surface.processOutput(bytes: Data("race".utf8), streamSeq: 0)
        }
        DispatchQueue.global().async(group: group) {
            start.wait()
            surface.free()
        }
        start.signal()
        start.signal()

        let finished = expectation(description: "output/free race finished")
        DispatchQueue.global().async {
            group.wait()
            finished.fulfill()
        }
        wait(for: [finished], timeout: 3)
        pumpMainQueue()

        stateLock.lock()
        let overlapped = overlapDetected
        let active = activeOperations
        stateLock.unlock()
        XCTAssertFalse(overlapped)
        XCTAssertEqual(active, 0)
        XCTAssertEqual(deliveredAfterFree, 0)
        XCTAssertNil(surface.surfaceHandle)
    }

    func testSurfaceThenAppThenConfigFreeOrdering() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        guard let owner = surface.appOwner else {
            return XCTFail("real surface must retain its app owner")
        }
        var order: [String] = []
        surface.operationObserver = { operation, phase in
            if operation == "surfaceFree", phase == .begin { order.append("surface") }
        }
        owner.operationObserver = { order.append($0) }

        surface.free()
        owner.free()

        XCTAssertEqual(order, ["surface", "app", "config"])
    }

    private func readScreen(_ surface: GhosttyManualSurface) -> String {
        surface.withUnsafeSurfaceHandle { handle in
            let selection = ghostty_selection_s(
                top_left: ghostty_point_s(
                    tag: GHOSTTY_POINT_SCREEN,
                    coord: GHOSTTY_POINT_COORD_TOP_LEFT,
                    x: 0,
                    y: 0
                ),
                bottom_right: ghostty_point_s(
                    tag: GHOSTTY_POINT_SCREEN,
                    coord: GHOSTTY_POINT_COORD_BOTTOM_RIGHT,
                    x: 0,
                    y: 0
                ),
                rectangle: false
            )
            var text = ghostty_text_s()
            guard ghostty_surface_read_text(handle, selection, &text) else { return "" }
            defer { ghostty_surface_free_text(handle, &text) }
            guard let bytes = text.text else { return "" }
            return String(cString: bytes)
        } ?? ""
    }

    private func pumpMainQueue() {
        let done = expectation(description: "main queue pumped")
        DispatchQueue.main.async { done.fulfill() }
        wait(for: [done], timeout: 1)
    }
}
