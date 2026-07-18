import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

final class Gate4ABIQualificationTests: XCTestCase {
    func testBridgeValuesLayoutAndCSignaturesAtRuntime() {
        XCTAssertEqual(GHOSTTY_SUCCESS.rawValue, 0)
        XCTAssertEqual(GHOSTTY_OUT_OF_MEMORY.rawValue, -1)
        XCTAssertEqual(GHOSTTY_INVALID_VALUE.rawValue, -2)
        XCTAssertEqual(GHOSTTY_OUT_OF_SPACE.rawValue, -3)
        XCTAssertEqual(GHOSTTY_NO_VALUE.rawValue, -4)

        XCTAssertEqual(HIVE_GHOSTTY_EVENT_INVALIDATE.rawValue, 1)
        XCTAssertEqual(HIVE_GHOSTTY_EVENT_TITLE.rawValue, 2)
        XCTAssertEqual(HIVE_GHOSTTY_EVENT_PWD.rawValue, 3)
        XCTAssertEqual(HIVE_GHOSTTY_EVENT_BELL.rawValue, 4)
        XCTAssertEqual(HIVE_GHOSTTY_EVENT_CLIPBOARD_DENIED.rawValue, 5)
        XCTAssertEqual(HIVE_GHOSTTY_EVENT_CLOSE_REQUEST.rawValue, 6)
        XCTAssertEqual(HIVE_GHOSTTY_TERMINAL_REPLIES_DISABLED, 0)
        XCTAssertEqual(HIVE_GHOSTTY_TERMINAL_REPLIES_ENABLED, 1)
        XCTAssertEqual(MemoryLayout<hive_ghostty_terminal_reply_policy_e>.size, 4)
        XCTAssertEqual(MemoryLayout<hive_ghostty_terminal_reply_policy_e>.alignment, 4)

        XCTAssertEqual(MemoryLayout<hive_ghostty_event_e>.size, 4)
        XCTAssertEqual(MemoryLayout<hive_ghostty_event_e>.alignment, 4)
        XCTAssertEqual(MemoryLayout<hive_ghostty_event_s>.size, 24)
        XCTAssertEqual(MemoryLayout<hive_ghostty_event_s>.stride, 24)
        XCTAssertEqual(MemoryLayout<hive_ghostty_event_s>.alignment, 8)
        XCTAssertEqual(MemoryLayout<hive_ghostty_event_s>.offset(of: \.type), 0)
        XCTAssertEqual(MemoryLayout<hive_ghostty_event_s>.offset(of: \.bytes), 8)
        XCTAssertEqual(MemoryLayout<hive_ghostty_event_s>.offset(of: \.length), 16)

        let buildID = String(cString: hive_ghostty_engine_build_id_v1())
        XCTAssertNotNil(buildID.range(of: "^[0-9a-f]{64}$", options: .regularExpression))

        XCTAssertNil(hive_ghostty_surface_new_manual_v1(
            nil, nil, HIVE_GHOSTTY_TERMINAL_REPLIES_DISABLED, nil, nil, nil, nil
        ))
        XCTAssertEqual(
            hive_ghostty_surface_process_output_v1(nil, nil, 0, 0),
            GHOSTTY_INVALID_VALUE
        )
        XCTAssertEqual(
            hive_ghostty_surface_restore_checkpoint_v1(nil, nil, 0, 0),
            GHOSTTY_INVALID_VALUE
        )
        var payload: UnsafeMutablePointer<UInt8>?
        var length = 0
        XCTAssertEqual(
            hive_ghostty_terminal_checkpoint_export_v1(nil, nil, nil, &payload, &length),
            GHOSTTY_INVALID_VALUE
        )
        XCTAssertNil(payload)
        XCTAssertEqual(length, 0)
        XCTAssertEqual(
            hive_ghostty_terminal_checkpoint_import_v1(nil, nil, 0),
            GHOSTTY_INVALID_VALUE
        )

        print(
            "SWIFT_ABI_OK pointer=\(MemoryLayout<UnsafeRawPointer>.size) " +
            "enum_size=\(MemoryLayout<hive_ghostty_event_e>.size) " +
            "enum_align=\(MemoryLayout<hive_ghostty_event_e>.alignment) " +
            "event_size=\(MemoryLayout<hive_ghostty_event_s>.size) " +
            "event_align=\(MemoryLayout<hive_ghostty_event_s>.alignment) " +
            "callconv=c symbols=6 build_id=\(buildID)"
        )
    }
}
