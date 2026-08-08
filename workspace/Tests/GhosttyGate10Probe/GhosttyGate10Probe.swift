import AppKit
import Darwin
import Foundation
import HiveGhosttyC

// Gate 10 (M1-B1) engine-scope probe: exercises the seventh bridge export,
// hive_ghostty_surface_semantic_snapshot_v1, at the C ABI boundary. Proves
// argument validation, single-call caller-owned allocation with exact bounds
// and alignment, and atomic row/text/cursor/selection/geometry consistency
// under interleaved output, resize, and selection mutation. The AppKit
// accessibility layer is deliberately absent: it is renderer-blocked and
// qualified separately.

private func fail(_ message: String) -> Never {
    emit(stage: "failed", facts: ["error": message])
    Darwin.exit(1)
}

private func emit(stage: String, facts: [String: Any] = [:]) {
    var object = facts
    object["stage"] = stage
    object["pid"] = ProcessInfo.processInfo.processIdentifier
    guard let bytes = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let line = String(data: bytes, encoding: .utf8) else {
        FileHandle.standardError.write(Data("GATE10_PROBE_FAIL encode \(stage)\n".utf8))
        Darwin.exit(1)
    }
    print(line)
    fflush(stdout)
}

/// Counting allocator context: proves alloc is invoked exactly once per
/// successful snapshot, with the requested alignment and length visible.
private final class AllocationLog {
    var calls = 0
    var lastLength = 0
    var lastAlignment = 0
    var failNext = false
}

private let countingAllocator: hive_ghostty_alloc_fn = { context, length, alignment in
    guard let context else { return nil }
    let log = Unmanaged<AllocationLog>.fromOpaque(context).takeUnretainedValue()
    log.calls += 1
    log.lastLength = length
    log.lastAlignment = alignment
    if log.failNext { return nil }
    var allocation: UnsafeMutableRawPointer?
    guard posix_memalign(&allocation, max(alignment, MemoryLayout<UnsafeRawPointer>.alignment), length) == 0 else {
        return nil
    }
    return allocation
}

private func process(_ surface: ghostty_surface_t, _ data: Data, at sequence: UInt64) -> ghostty_result_e {
    data.withUnsafeBytes { raw in
        hive_ghostty_surface_process_output_v1(
            surface,
            raw.bindMemory(to: UInt8.self).baseAddress,
            raw.count,
            sequence
        )
    }
}

private func binding(_ surface: ghostty_surface_t, _ action: String) -> Bool {
    action.withCString {
        ghostty_surface_binding_action(surface, $0, UInt(action.utf8.count))
    }
}

/// Validates one raw snapshot's internal consistency and, when captured via
/// the counting allocator, its allocation layout contract. Returns the UTF-16
/// text length for cursor cross-checks.
private func validate(
    _ raw: hive_ghostty_semantic_snapshot_s,
    context: String
) -> Int {
    guard let textLength = Int(exactly: raw.text_length),
          let utf16Length = Int(exactly: raw.text_utf16_length),
          let rowCount = Int(exactly: raw.visible_row_count),
          let cellOffsetCount = Int(exactly: raw.cell_utf16_offset_count) else {
        fail("\(context): snapshot scalar overflow")
    }
    guard rowCount == Int(raw.rows) else {
        fail("\(context): visible_row_count \(rowCount) != rows \(raw.rows) (torn geometry)")
    }
    guard cellOffsetCount == rowCount * (Int(raw.columns) + 1) else {
        fail("\(context): cell offset count \(cellOffsetCount) != rows*(columns+1) (torn cell map)")
    }

    let textData: Data = raw.text.map { Data(bytes: $0, count: textLength) } ?? Data()
    guard textData.count == textLength, let text = String(data: textData, encoding: .utf8) else {
        fail("\(context): snapshot text is not valid UTF-8")
    }
    guard (text as NSString).length == utf16Length else {
        fail("\(context): text_utf16_length disagrees with decoded text")
    }

    let rows: [hive_ghostty_semantic_row_s] = raw.visible_rows.map {
        Array(UnsafeBufferPointer(start: $0, count: rowCount))
    } ?? []
    let cellOffsets: [UInt64] = raw.cell_utf16_offsets.map {
        Array(UnsafeBufferPointer(start: $0, count: cellOffsetCount))
    } ?? []
    guard rows.count == rowCount, cellOffsets.count == cellOffsetCount else {
        fail("\(context): row/cell buffers missing while counts are nonzero")
    }

    var expectedUTF8: UInt64 = 0
    var expectedUTF16: UInt64 = 0
    for (index, row) in rows.enumerated() {
        guard row.utf8_offset == expectedUTF8, row.utf16_offset == expectedUTF16 else {
            fail("\(context): row \(index) ranges are not contiguous (torn rows)")
        }
        expectedUTF8 = row.utf8_offset + row.utf8_length + UInt64(row.line_break_utf8_length)
        expectedUTF16 = row.utf16_offset + row.utf16_length + UInt64(row.line_break_utf16_length)
        guard row.cell_count == raw.columns else {
            fail("\(context): row \(index) cell_count != columns (torn geometry)")
        }
        let base = Int(row.cell_utf16_offset_index)
        guard base + Int(row.cell_count) < cellOffsetCount + 1,
              cellOffsets[base] == row.utf16_offset,
              cellOffsets[base + Int(row.cell_count)] == row.utf16_offset + row.utf16_length else {
            fail("\(context): row \(index) cell map does not bracket its UTF-16 range")
        }
        for cell in base ..< (base + Int(row.cell_count)) where cellOffsets[cell] > cellOffsets[cell + 1] {
            fail("\(context): row \(index) cell offsets are not monotonic")
        }
    }
    guard expectedUTF8 == raw.text_length, expectedUTF16 == raw.text_utf16_length else {
        fail("\(context): row ranges do not cover the text buffers (torn text)")
    }

    if raw.cursor_visible != 0 {
        guard raw.cursor_utf16_offset != UInt64.max, raw.cursor_utf16_offset <= raw.text_utf16_length,
              raw.cursor_line != UInt64.max, raw.cursor_line < raw.visible_row_count else {
            fail("\(context): visible cursor is outside the snapshot's own text (torn cursor)")
        }
    } else {
        guard raw.cursor_utf16_offset == UInt64.max, raw.cursor_line == UInt64.max else {
            fail("\(context): hidden cursor leaked a UTF-16 position")
        }
    }
    if raw.has_selection != 0, raw.selection_utf16_offset != UInt64.max {
        guard raw.selection_utf16_offset + raw.selection_utf16_length <= raw.text_utf16_length else {
            fail("\(context): selection range exceeds snapshot text (torn selection)")
        }
    }
    if raw.has_selection == 0, raw.selected_text_length != 0 {
        fail("\(context): selected_text_length without has_selection")
    }
    guard raw.scroll_offset <= raw.scroll_total, raw.scroll_length <= raw.scroll_total else {
        fail("\(context): scrollbar state inconsistent")
    }
    return utf16Length
}

private func validateAllocationLayout(
    _ raw: hive_ghostty_semantic_snapshot_s,
    log: AllocationLog,
    context: String
) {
    guard let base = raw.allocation else { fail("\(context): missing allocation") }
    guard log.calls == 1 else { fail("\(context): allocator invoked \(log.calls) times, contract is exactly once") }
    guard log.lastAlignment == 8 else { fail("\(context): requested alignment \(log.lastAlignment) != 8") }
    guard UInt(bitPattern: base) % 8 == 0 else { fail("\(context): allocation is not 8-aligned") }

    let rowBytes = Int(raw.visible_row_count) * 48
    let cellBytes = Int(raw.cell_utf16_offset_count) * 8
    let expected = rowBytes + cellBytes + Int(raw.text_length) + Int(raw.selected_text_length)
    guard Int(raw.allocation_length) == expected, log.lastLength == expected else {
        fail("\(context): allocation_length \(raw.allocation_length) != layout sum \(expected)")
    }
    guard UnsafeRawPointer(raw.visible_rows!) == UnsafeRawPointer(base) else {
        fail("\(context): rows are not at the allocation base")
    }
    guard UnsafeRawPointer(raw.cell_utf16_offsets!) == UnsafeRawPointer(base).advanced(by: rowBytes) else {
        fail("\(context): cell map is not immediately after rows")
    }
    guard UnsafeRawPointer(raw.text!) == UnsafeRawPointer(base).advanced(by: rowBytes + cellBytes) else {
        fail("\(context): text is not immediately after the cell map")
    }
    if raw.selected_text_length > 0 {
        guard let selected = raw.selected_text,
              UnsafeRawPointer(selected) ==
              UnsafeRawPointer(base).advanced(by: rowBytes + cellBytes + Int(raw.text_length)) else {
            fail("\(context): selected text is outside the single allocation")
        }
    }
}

setbuf(stdout, nil)

_ = ghostty_init(0, nil)
guard let config = ghostty_config_new() else { fail("ghostty_config_new") }
ghostty_config_finalize(config)

var runtime = ghostty_runtime_config_s(
    userdata: nil,
    supports_selection_clipboard: false,
    wakeup_cb: { _ in },
    action_cb: { _, _, _ in false },
    read_clipboard_cb: { _, _, _ in false },
    confirm_read_clipboard_cb: { _, _, _, _ in },
    write_clipboard_cb: { _, _, _, _, _ in },
    close_surface_cb: { _, _ in }
)
guard let app = ghostty_app_new(&runtime, config) else { fail("ghostty_app_new") }

let hostView = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 360))
var surfaceConfig = ghostty_surface_config_new()
surfaceConfig.platform_tag = GHOSTTY_PLATFORM_MACOS
surfaceConfig.platform = ghostty_platform_u(
    macos: ghostty_platform_macos_s(nsview: Unmanaged.passUnretained(hostView).toOpaque())
)
surfaceConfig.scale_factor = 2
surfaceConfig.font_size = 13

guard let surface = hive_ghostty_surface_new_manual_v1(
    app,
    &surfaceConfig,
    UInt32(HIVE_GHOSTTY_TERMINAL_REPLIES_DISABLED),
    { _, _, _ in },
    nil,
    { _, _ in },
    nil
) else { fail("manual surface creation failed") }
ghostty_surface_set_size(surface, 640, 360)

private let allocationLog = AllocationLog()
private let allocationContext = Unmanaged.passUnretained(allocationLog).toOpaque()

// Stage 1: argument validation. Null surface, allocator, and out-pointer are
// each rejected without invoking the allocator or leaking an allocation.
var rejected = hive_ghostty_semantic_snapshot_s()
rejected.allocation = UnsafeMutableRawPointer(bitPattern: 0xdead)
guard hive_ghostty_surface_semantic_snapshot_v1(nil, countingAllocator, allocationContext, &rejected)
    == GHOSTTY_INVALID_VALUE else { fail("null surface accepted") }
guard rejected.allocation == nil else { fail("rejected snapshot was not zeroed") }
guard hive_ghostty_surface_semantic_snapshot_v1(surface, nil, nil, &rejected)
    == GHOSTTY_INVALID_VALUE else { fail("null allocator accepted") }
guard hive_ghostty_surface_semantic_snapshot_v1(surface, countingAllocator, allocationContext, nil)
    == GHOSTTY_INVALID_VALUE else { fail("null out-snapshot accepted") }
guard allocationLog.calls == 0 else { fail("argument rejection invoked the allocator") }
emit(stage: "null-arguments", facts: ["allocatorCalls": allocationLog.calls])

// Stage 2: alloc ownership/bounds/alignment on real content, selection on.
let fixture = Data("gate10-row-A😀界e\u{301}\r\nsecond-row\u{1b}[7mreverse\u{1b}[0m\r\nthird 界界界\r\n".utf8)
guard process(surface, fixture, at: 0) == GHOSTTY_SUCCESS else { fail("fixture output rejected") }
guard binding(surface, "select_all") else { fail("select_all binding rejected") }

allocationLog.calls = 0
var snapshot = hive_ghostty_semantic_snapshot_s()
guard hive_ghostty_surface_semantic_snapshot_v1(surface, countingAllocator, allocationContext, &snapshot)
    == GHOSTTY_SUCCESS else { fail("content snapshot failed") }
_ = validate(snapshot, context: "alloc-contract")
validateAllocationLayout(snapshot, log: allocationLog, context: "alloc-contract")
guard snapshot.has_selection != 0, snapshot.selected_text_length > 0 else {
    fail("alloc-contract: select_all produced no selection in the snapshot")
}
free(snapshot.allocation)
emit(stage: "alloc-contract", facts: [
    "allocationLength": Int(snapshot.allocation_length),
    "rows": Int(snapshot.rows),
    "columns": Int(snapshot.columns),
    "generation": Int(snapshot.generation),
])

// Stage 3: allocator failure surfaces as out-of-memory with a zeroed result.
allocationLog.calls = 0
allocationLog.failNext = true
var starved = hive_ghostty_semantic_snapshot_s()
guard hive_ghostty_surface_semantic_snapshot_v1(surface, countingAllocator, allocationContext, &starved)
    == GHOSTTY_OUT_OF_MEMORY else { fail("allocator failure not reported as out-of-memory") }
guard starved.allocation == nil, starved.text == nil, starved.visible_rows == nil else {
    fail("failed snapshot leaked pointers")
}
allocationLog.failNext = false
emit(stage: "failing-allocator", facts: ["allocatorCalls": allocationLog.calls])

// Stage 4: atomic consistency under interleaved output, resize, and
// selection churn. Every intermediate state must be internally consistent
// and generation must never move backward.
let stressChunk = Data((
    "stress-hard-row\r\nwrap-界界界-e\u{301}e\u{301}-😀😀 " +
    "\u{1b}[3Ccursor\u{1b}[2D\u{1b}[38;5;27mcolor\u{1b}[0m\r\n"
).utf8)
var streamSeq = UInt64(fixture.count)
var priorGeneration: UInt64 = 0
var snapshots = 0
let iterations = 300
for iteration in 0 ..< iterations {
    guard process(surface, stressChunk, at: streamSeq) == GHOSTTY_SUCCESS else {
        fail("stress output rejected at iteration \(iteration)")
    }
    streamSeq += UInt64(stressChunk.count)
    if iteration % 7 == 3 {
        ghostty_surface_set_size(surface, iteration % 2 == 0 ? 420 : 760, iteration % 3 == 0 ? 220 : 420)
    }
    if iteration % 13 == 5 {
        guard binding(surface, "select_all") else { fail("stress select_all rejected") }
    }

    allocationLog.calls = 0
    var stressed = hive_ghostty_semantic_snapshot_s()
    guard hive_ghostty_surface_semantic_snapshot_v1(surface, countingAllocator, allocationContext, &stressed)
        == GHOSTTY_SUCCESS else { fail("stress snapshot failed at iteration \(iteration)") }
    _ = validate(stressed, context: "stress[\(iteration)]")
    validateAllocationLayout(stressed, log: allocationLog, context: "stress[\(iteration)]")
    guard stressed.generation >= priorGeneration else {
        fail("generation moved backward at iteration \(iteration)")
    }
    priorGeneration = stressed.generation
    free(stressed.allocation)
    snapshots += 1
}
emit(stage: "stress", facts: [
    "iterations": iterations,
    "snapshots": snapshots,
    "bytesProcessed": Int(streamSeq),
    "finalGeneration": Int(priorGeneration),
])

ghostty_surface_free(surface)
ghostty_app_free(app)
ghostty_config_free(config)
emit(stage: "complete", facts: [
    "snapshots": snapshots + 1,
    "engineBuildId": String(cString: hive_ghostty_engine_build_id_v1()),
])
