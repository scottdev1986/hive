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
        XCTAssertEqual(copy, Data([0x01, 0x02, 0x03, 0x04]))
    }

    /// SF3: renames the old misnamed test — verifies enter()/leave() arm and clear
    /// `isInCallback` around a trampoline (does not trap on re-entry).
    func testInCallbackFlagArmedDuringTrampolineAndClearedAfter() {
        let ctx = BridgeCallbackContext()
        var sawInCallback = false
        ctx.onWrite = { _ in
            sawInCallback = ctx.isInCallback
        }
        let bytes: [UInt8] = [1]
        bytes.withUnsafeBufferPointer { buf in
            hiveBridgeWriteTrampoline(ctx.unownedContextPointer, buf.baseAddress, 1)
        }
        XCTAssertTrue(sawInCallback, "enter() must arm inCallback during trampoline")
        XCTAssertFalse(ctx.isInCallback, "leave() must clear after return")
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
        XCTAssertTrue(got)
    }
}
