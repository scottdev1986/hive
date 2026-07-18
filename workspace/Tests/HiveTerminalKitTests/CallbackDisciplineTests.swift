import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

/// Positive controls: copy-before-return + real ABI trampolines (§23 B1/B3).
///
/// B3: mutate the **same** storage the callback saw (not reassign Swift array).
final class CallbackDisciplineTests: XCTestCase {
    func testWriteTrampolineCopiesBeforeReturn_sameStorageOverwrite() {
        let ctx = BridgeCallbackContext()
        var observed: Data?
        ctx.onWrite = { observed = $0 }

        let n = 4
        let ptr = UnsafeMutablePointer<UInt8>.allocate(capacity: n)
        defer { ptr.deallocate() }
        ptr[0] = 0x48; ptr[1] = 0x69; ptr[2] = 0x76; ptr[3] = 0x65 // Hive
        let original = Data(bytes: ptr, count: n)

        hiveBridgeWriteTrampoline(ctx.unownedContextPointer, UnsafePointer(ptr), n)
        ptr.update(repeating: 0xFF, count: n)

        waitUntil { observed != nil }

        XCTAssertEqual(observed, original, "copy must survive same-address overwrite")
        XCTAssertNotEqual(observed, Data(bytes: ptr, count: n),
                          "positive control: storage was actually overwritten")
    }

    func testEventTrampolineCopiesBeforeReturn_sameStorageOverwrite() {
        let ctx = BridgeCallbackContext()
        var observed: BridgeEvent?
        ctx.onEvent = { observed = $0 }

        let n = 8
        let ptr = UnsafeMutablePointer<UInt8>.allocate(capacity: n)
        defer { ptr.deallocate() }
        let text = Array("pwd:/tmp".utf8)
        for i in 0..<n { ptr[i] = text[i] }
        let original = Data(bytes: ptr, count: n)

        var event = hive_ghostty_event_s(
            type: HIVE_GHOSTTY_EVENT_PWD,
            bytes: UnsafePointer(ptr),
            length: n
        )
        hiveBridgeEventTrampoline(ctx.unownedContextPointer, &event)
        ptr.update(repeating: 0xFF, count: n)

        waitUntil { observed != nil }

        XCTAssertEqual(observed?.type, .pwd)
        XCTAssertEqual(observed?.bytes, original)
        XCTAssertNotEqual(observed?.bytes, Data(bytes: ptr, count: n))
    }

    func testRetainedPointerWouldFail_afterSameStorageOverwrite() {
        let n = 4
        let ptr = UnsafeMutablePointer<UInt8>.allocate(capacity: n)
        defer { ptr.deallocate() }
        ptr[0] = 0x01; ptr[1] = 0x02; ptr[2] = 0x03; ptr[3] = 0x04

        let retainedPointer: UnsafePointer<UInt8> = UnsafePointer(ptr)
        let retainedLength = n
        ptr.update(repeating: 0xFF, count: n)

        let whatRetainedSees = Data(bytes: retainedPointer, count: retainedLength)
        XCTAssertEqual(whatRetainedSees, Data(repeating: 0xFF, count: n),
                       "positive control: retained pointer observes mutated storage")
        XCTAssertNotEqual(whatRetainedSees, Data([0x01, 0x02, 0x03, 0x04]))

        let ctx = BridgeCallbackContext()
        var copy: Data?
        ctx.onWrite = { copy = $0 }
        ptr[0] = 0x01; ptr[1] = 0x02; ptr[2] = 0x03; ptr[3] = 0x04
        hiveBridgeWriteTrampoline(ctx.unownedContextPointer, UnsafePointer(ptr), n)
        ptr.update(repeating: 0xFF, count: n)
        waitUntil { copy != nil }
        XCTAssertEqual(copy, Data([0x01, 0x02, 0x03, 0x04]))
    }

    func testHandlerRunsOnMainOnlyAfterTrampolineCallbackScopeEnds() {
        let ctx = BridgeCallbackContext()
        var sawInCallback: Bool?
        var sawMainThread = false
        ctx.onWrite = { _ in
            sawInCallback = ctx.isInCallback
            sawMainThread = Thread.isMainThread
        }
        let bytes: [UInt8] = [1]
        bytes.withUnsafeBufferPointer { buf in
            hiveBridgeWriteTrampoline(ctx.unownedContextPointer, buf.baseAddress, 1)
        }
        XCTAssertNil(sawInCallback, "host delivery must be deferred until the C callback returns")
        XCTAssertFalse(ctx.isInCallback, "leave() must clear after return")
        waitUntil { sawInCallback != nil }
        XCTAssertEqual(sawInCallback, false, "host code must never run inside the C callback scope")
        XCTAssertTrue(sawMainThread, "all host callback delivery is main-thread confined")
    }

    func testTeardownDropsDeliveryAlreadyQueuedBeforeFree() {
        let ctx = BridgeCallbackContext()
        var deliveries = 0
        ctx.onWrite = { _ in deliveries += 1 }
        let bytes: [UInt8] = [1]

        bytes.withUnsafeBufferPointer { buf in
            hiveBridgeWriteTrampoline(ctx.unownedContextPointer, buf.baseAddress, 1)
        }
        ctx.beginTeardown()
        pumpMainQueue()

        XCTAssertEqual(deliveries, 0, "queued callbacks must self-drop once teardown closes admission")
    }

    func testTeardownAlsoDropsQueuedRendererHealthDelivery() {
        let ctx = BridgeCallbackContext()
        var deliveries = 0
        ctx.onRendererHealth = { _ in deliveries += 1 }

        ctx.enqueueRendererHealth(.unhealthy)
        ctx.beginTeardown()
        pumpMainQueue()

        XCTAssertEqual(deliveries, 0, "renderer-health actions cannot arrive after surface teardown")
    }

    func testSurfaceFreeWaitsForCallbackCopyAlreadyInFlight() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        surface.callbackContext.callbackCopyObserver = {
            entered.signal()
            release.wait()
        }
        var deliveries = 0
        surface.callbackContext.onWrite = { _ in deliveries += 1 }

        let byte = UnsafeMutablePointer<UInt8>.allocate(capacity: 1)
        byte.initialize(to: 0x41)
        defer { byte.deallocate() }

        let callbackDone = expectation(description: "callback returned")
        DispatchQueue.global(qos: .userInitiated).async {
            hiveBridgeWriteTrampoline(
                surface.callbackContext.unownedContextPointer,
                UnsafePointer(byte),
                1
            )
            callbackDone.fulfill()
        }
        XCTAssertEqual(entered.wait(timeout: .now() + 1), .success)

        let freeDone = expectation(description: "surface free returned")
        DispatchQueue.global(qos: .userInitiated).async {
            surface.free()
            freeDone.fulfill()
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) {
            release.signal()
        }

        wait(for: [callbackDone, freeDone], timeout: 3)
        pumpMainQueue()
        XCTAssertNil(surface.surfaceHandle)
        XCTAssertEqual(deliveries, 0, "delivery queued by the completed copy must drop after teardown")
    }

    func testCallbackMayRequestFreeOnlyAfterTrampolineReturns() {
        let ctx = BridgeCallbackContext()
        let engine = FakeManualSurface(callbackContext: ctx)
        ctx.onWrite = { _ in
            XCTAssertFalse(ctx.isInCallback)
            engine.free()
        }
        let bytes: [UInt8] = [1]

        bytes.withUnsafeBufferPointer { buf in
            hiveBridgeWriteTrampoline(ctx.unownedContextPointer, buf.baseAddress, 1)
        }
        XCTAssertFalse(engine.freed, "destruction must not re-enter the C callback")
        waitUntil { engine.freed }
    }

    func testEventTrampolineABI_isTwoParamStructPointer() {
        let fn: hive_ghostty_event_fn = hiveBridgeEventTrampoline
        XCTAssertNotNil(fn)
        let ctx = BridgeCallbackContext()
        var got = false
        ctx.onEvent = { e in
            got = e.type == .bell
        }
        var event = hive_ghostty_event_s(
            type: HIVE_GHOSTTY_EVENT_BELL,
            bytes: nil,
            length: 0
        )
        fn(ctx.unownedContextPointer, &event)
        waitUntil { got }
        XCTAssertTrue(got)
    }

    private func waitUntil(
        timeout: TimeInterval = 1,
        _ condition: @escaping () -> Bool
    ) {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        XCTAssertTrue(condition())
    }

    private func pumpMainQueue() {
        let done = expectation(description: "main queue pumped")
        DispatchQueue.main.async { done.fulfill() }
        wait(for: [done], timeout: 1)
    }
}
