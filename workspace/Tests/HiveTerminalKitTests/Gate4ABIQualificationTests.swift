import AppKit
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

final class Gate4ABIQualificationTests: XCTestCase {
    private func pumpMainQueue() {
        let delivered = expectation(description: "main-thread callback delivery")
        DispatchQueue.main.async { delivered.fulfill() }
        wait(for: [delivered], timeout: 1)
    }

    func testEnabledPolicyCreatesLiveSurfaceAndReplies() throws {
        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting(terminalReplies: .enabled)
        defer { surface.free() }
        var writes: [Data] = []
        surface.callbackContext.onWrite = { writes.append($0) }
        XCTAssertEqual(surface.processOutput(bytes: Data("\u{1B}[c".utf8), streamSeq: 0), .success)
        pumpMainQueue()
        XCTAssertEqual(writes, [Data("\u{1B}[?62;22c".utf8)])
    }

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

        XCTAssertEqual(MemoryLayout<hive_ghostty_semantic_row_s>.size, 48)
        XCTAssertEqual(MemoryLayout<hive_ghostty_semantic_row_s>.stride, 48)
        XCTAssertEqual(MemoryLayout<hive_ghostty_semantic_row_s>.alignment, 8)
        XCTAssertEqual(MemoryLayout<hive_ghostty_semantic_row_s>.offset(of: \.utf8_offset), 0)
        XCTAssertEqual(MemoryLayout<hive_ghostty_semantic_row_s>.offset(of: \.utf16_offset), 16)
        XCTAssertEqual(
            MemoryLayout<hive_ghostty_semantic_row_s>.offset(of: \.line_break_utf8_length),
            32
        )
        XCTAssertEqual(
            MemoryLayout<hive_ghostty_semantic_row_s>.offset(of: \.cell_utf16_offset_index),
            40
        )

        XCTAssertEqual(MemoryLayout<hive_ghostty_semantic_snapshot_s>.size, 224)
        XCTAssertEqual(MemoryLayout<hive_ghostty_semantic_snapshot_s>.stride, 224)
        XCTAssertEqual(MemoryLayout<hive_ghostty_semantic_snapshot_s>.alignment, 8)
        XCTAssertEqual(
            MemoryLayout<hive_ghostty_semantic_snapshot_s>.offset(of: \.visible_rows),
            32
        )
        XCTAssertEqual(
            MemoryLayout<hive_ghostty_semantic_snapshot_s>.offset(of: \.cell_utf16_offsets),
            48
        )
        XCTAssertEqual(
            MemoryLayout<hive_ghostty_semantic_snapshot_s>.offset(of: \.selected_text),
            64
        )
        XCTAssertEqual(
            MemoryLayout<hive_ghostty_semantic_snapshot_s>.offset(of: \.scroll_total),
            112
        )
        XCTAssertEqual(MemoryLayout<hive_ghostty_semantic_snapshot_s>.offset(of: \.columns), 136)
        XCTAssertEqual(
            MemoryLayout<hive_ghostty_semantic_snapshot_s>.offset(of: \.cursor_column),
            176
        )
        XCTAssertEqual(
            MemoryLayout<hive_ghostty_semantic_snapshot_s>.offset(of: \.has_selection),
            200
        )
        XCTAssertEqual(MemoryLayout<hive_ghostty_semantic_snapshot_s>.offset(of: \.allocation), 208)

        let buildID = String(cString: hive_ghostty_engine_build_id_v1())
        XCTAssertNotNil(buildID.range(of: "^[0-9a-f]{64}$", options: .regularExpression))

        XCTAssertNil(hive_ghostty_surface_new_manual_v1(
            nil, nil, hive_ghostty_terminal_reply_policy_e(HIVE_GHOSTTY_TERMINAL_REPLIES_DISABLED), nil, nil, nil, nil
        ))
        XCTAssertEqual(
            hive_ghostty_surface_process_output_v1(nil, nil, 0, 0),
            GHOSTTY_INVALID_VALUE
        )
        XCTAssertEqual(
            hive_ghostty_surface_restore_checkpoint_v1(nil, nil, 0, 0),
            GHOSTTY_INVALID_VALUE
        )
        var semanticSnapshot = hive_ghostty_semantic_snapshot_s()
        XCTAssertEqual(
            hive_ghostty_surface_semantic_snapshot_v1(nil, nil, nil, &semanticSnapshot),
            GHOSTTY_INVALID_VALUE
        )
        XCTAssertNil(semanticSnapshot.allocation)
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
            "row_size=\(MemoryLayout<hive_ghostty_semantic_row_s>.size) " +
            "snapshot_size=\(MemoryLayout<hive_ghostty_semantic_snapshot_s>.size) " +
            "callconv=c symbols=7 build_id=\(buildID)"
        )
    }
}
