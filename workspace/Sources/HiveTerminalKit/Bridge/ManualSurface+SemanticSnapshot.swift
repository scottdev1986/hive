import AppKit
import Darwin
import Foundation
import HiveGhosttyC

public struct ManualSurfaceSemanticRow: Equatable {
    public let utf8Range: NSRange
    public let utf16Range: NSRange
    public let lineBreakUTF8Length: Int
    public let lineBreakUTF16Length: Int
    public let cellUTF16Offsets: [Int]
}

public struct ManualSurfaceSemanticSelection: Equatable {
    public let text: String
    public let visibleUTF16Range: NSRange?
    public let isRectangular: Bool
    public let rangeIsClipped: Bool
}

public struct ManualSurfaceSemanticCursor: Equatable {
    public let utf16Offset: Int?
    public let line: Int?
    public let column: Int
    public let row: Int
    public let framePixels: NSRect
    public let isVisible: Bool
    public let isPendingWrap: Bool
}

public struct ManualSurfaceSemanticViewport: Equatable {
    public let total: UInt64
    public let offset: UInt64
    public let length: UInt64
    public let followsBottom: Bool
}

public struct ManualSurfaceSemanticGeometry: Equatable {
    public let columns: Int
    public let rows: Int
    public let widthPixels: Int
    public let heightPixels: Int
    public let cellWidthPixels: Int
    public let cellHeightPixels: Int
    public let paddingTopPixels: Int
    public let paddingBottomPixels: Int
    public let paddingRightPixels: Int
    public let paddingLeftPixels: Int
}

public struct ManualSurfaceSemanticSnapshot: Equatable {
    public let generation: UInt64
    public let text: String
    public let textUTF16Length: Int
    public let visibleRows: [ManualSurfaceSemanticRow]
    public let selection: ManualSurfaceSemanticSelection?
    public let cursor: ManualSurfaceSemanticCursor
    public let viewport: ManualSurfaceSemanticViewport
    public let geometry: ManualSurfaceSemanticGeometry
}

/// Gate 10 read seam. Production snapshots cross the seventh Hive bridge
/// export; fakes may provide deterministic snapshots without a C surface.
public protocol ManualSurfaceSemanticSnapshotProviding: AnyObject {
    /// Main-thread only and never callable from a native Ghostty callback.
    /// Gate 3 defers callback delivery before Gate 10 reaches this method.
    func semanticSnapshot() -> ManualSurfaceSemanticSnapshot?
}

private let manualSurfaceSemanticAllocator: hive_ghostty_alloc_fn = { _, length, alignment in
    guard length > 0 else { return nil }
    let pointerAlignment = MemoryLayout<UnsafeRawPointer>.alignment
    let requestedAlignment = max(pointerAlignment, alignment)
    guard requestedAlignment.nonzeroBitCount == 1 else { return nil }
    var allocation: UnsafeMutableRawPointer?
    guard posix_memalign(&allocation, requestedAlignment, length) == 0 else { return nil }
    return allocation
}

extension GhosttyManualSurface: ManualSurfaceSemanticSnapshotProviding {
    func semanticSnapshot() -> ManualSurfaceSemanticSnapshot? {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let surface = surfaceHandle else { return nil }

        var raw = hive_ghostty_semantic_snapshot_s()
        let result = hive_ghostty_surface_semantic_snapshot_v1(
            surface,
            manualSurfaceSemanticAllocator,
            nil,
            &raw
        )
        guard HiveTerminalEngineResult(cResult: result) == .success else { return nil }
        defer { Darwin.free(raw.allocation) }

        return ManualSurfaceSemanticSnapshot(raw: raw)
    }
}

private extension ManualSurfaceSemanticSnapshot {
    init?(raw: hive_ghostty_semantic_snapshot_s) {
        guard
            let textLength = Int(exactly: raw.text_length),
            let textUTF16Length = Int(exactly: raw.text_utf16_length),
            let rowCount = Int(exactly: raw.visible_row_count),
            let cellOffsetCount = Int(exactly: raw.cell_utf16_offset_count),
            let textData = Self.copyBytes(raw.text, count: textLength),
            let text = String(data: textData, encoding: .utf8),
            (text as NSString).length == textUTF16Length,
            let rawRows = Self.copyRows(raw.visible_rows, count: rowCount),
            let rawCellOffsets = Self.copyCellOffsets(raw.cell_utf16_offsets, count: cellOffsetCount)
        else { return nil }

        var rows: [ManualSurfaceSemanticRow] = []
        rows.reserveCapacity(rawRows.count)
        for row in rawRows {
            guard
                let utf8Range = Self.range(
                    offset: row.utf8_offset,
                    length: row.utf8_length,
                    upperBound: textLength
                ),
                let utf16Range = Self.range(
                    offset: row.utf16_offset,
                    length: row.utf16_length,
                    upperBound: textUTF16Length
                ),
                let lineBreakUTF8Length = Int(exactly: row.line_break_utf8_length),
                let lineBreakUTF16Length = Int(exactly: row.line_break_utf16_length),
                let cellIndex = Int(exactly: row.cell_utf16_offset_index),
                let cellCount = Int(exactly: row.cell_count),
                cellIndex <= rawCellOffsets.count,
                cellCount < rawCellOffsets.count - cellIndex
            else { return nil }

            let cellOffsets = Array(rawCellOffsets[cellIndex ... cellIndex + cellCount])
            guard
                cellOffsets.first == utf16Range.location,
                cellOffsets.last == NSMaxRange(utf16Range),
                zip(cellOffsets, cellOffsets.dropFirst()).allSatisfy({ $0 <= $1 })
            else { return nil }

            rows.append(ManualSurfaceSemanticRow(
                utf8Range: utf8Range,
                utf16Range: utf16Range,
                lineBreakUTF8Length: lineBreakUTF8Length,
                lineBreakUTF16Length: lineBreakUTF16Length,
                cellUTF16Offsets: cellOffsets
            ))
        }

        let selection: ManualSurfaceSemanticSelection?
        if raw.has_selection != 0 {
            guard
                let selectedLength = Int(exactly: raw.selected_text_length),
                let selectedData = Self.copyBytes(raw.selected_text, count: selectedLength),
                let selectedText = String(data: selectedData, encoding: .utf8)
            else { return nil }
            let visibleRange = Self.optionalRange(
                offset: raw.selection_utf16_offset,
                length: raw.selection_utf16_length,
                upperBound: textUTF16Length
            )
            if raw.selection_is_rectangular != 0 {
                guard raw.selection_utf16_offset == UInt64.max, visibleRange == nil else { return nil }
            } else if
                raw.selection_utf16_offset != UInt64.max,
                visibleRange == nil {
                return nil
            }
            selection = ManualSurfaceSemanticSelection(
                text: selectedText,
                visibleUTF16Range: visibleRange,
                isRectangular: raw.selection_is_rectangular != 0,
                rangeIsClipped: raw.selection_range_clipped != 0
            )
        } else {
            selection = nil
        }

        let cursorOffset = Self.optionalIndex(raw.cursor_utf16_offset, upperBound: textUTF16Length)
        let cursorLine = Self.optionalLine(raw.cursor_line, lineCount: rows.count)
        let cursorVisible = raw.cursor_visible != 0
        guard !cursorVisible || (cursorOffset != nil && cursorLine != nil) else { return nil }

        guard
            let cursorColumn = Int(exactly: raw.cursor_column),
            let cursorRow = Int(exactly: raw.cursor_row),
            let cursorX = Int(exactly: raw.cursor_x_px),
            let cursorY = Int(exactly: raw.cursor_y_px),
            let cursorWidth = Int(exactly: raw.cursor_width_px),
            let cursorHeight = Int(exactly: raw.cursor_height_px),
            let columns = Int(exactly: raw.columns),
            let gridRows = Int(exactly: raw.rows),
            let width = Int(exactly: raw.width_px),
            let height = Int(exactly: raw.height_px),
            let cellWidth = Int(exactly: raw.cell_width_px),
            let cellHeight = Int(exactly: raw.cell_height_px),
            let paddingTop = Int(exactly: raw.padding_top_px),
            let paddingBottom = Int(exactly: raw.padding_bottom_px),
            let paddingRight = Int(exactly: raw.padding_right_px),
            let paddingLeft = Int(exactly: raw.padding_left_px),
            rows.count == gridRows
        else { return nil }

        generation = raw.generation
        self.text = text
        self.textUTF16Length = textUTF16Length
        visibleRows = rows
        self.selection = selection
        cursor = ManualSurfaceSemanticCursor(
            utf16Offset: cursorOffset,
            line: cursorLine,
            column: cursorColumn,
            row: cursorRow,
            framePixels: NSRect(x: cursorX, y: cursorY, width: cursorWidth, height: cursorHeight),
            isVisible: cursorVisible,
            isPendingWrap: raw.cursor_pending_wrap != 0
        )
        viewport = ManualSurfaceSemanticViewport(
            total: raw.scroll_total,
            offset: raw.scroll_offset,
            length: raw.scroll_length,
            followsBottom: raw.viewport_follows_bottom != 0
        )
        geometry = ManualSurfaceSemanticGeometry(
            columns: columns,
            rows: gridRows,
            widthPixels: width,
            heightPixels: height,
            cellWidthPixels: cellWidth,
            cellHeightPixels: cellHeight,
            paddingTopPixels: paddingTop,
            paddingBottomPixels: paddingBottom,
            paddingRightPixels: paddingRight,
            paddingLeftPixels: paddingLeft
        )
    }

    static func copyBytes(_ pointer: UnsafePointer<UInt8>?, count: Int) -> Data? {
        if count == 0 { return Data() }
        guard let pointer else { return nil }
        return Data(bytes: pointer, count: count)
    }

    static func copyRows(
        _ pointer: UnsafePointer<hive_ghostty_semantic_row_s>?,
        count: Int
    ) -> [hive_ghostty_semantic_row_s]? {
        if count == 0 { return [] }
        guard let pointer else { return nil }
        return Array(UnsafeBufferPointer(start: pointer, count: count))
    }

    static func copyCellOffsets(_ pointer: UnsafePointer<UInt64>?, count: Int) -> [Int]? {
        if count == 0 { return [] }
        guard let pointer else { return nil }
        var result: [Int] = []
        result.reserveCapacity(count)
        for value in UnsafeBufferPointer(start: pointer, count: count) {
            guard let converted = Int(exactly: value) else { return nil }
            result.append(converted)
        }
        return result
    }

    static func range(offset: UInt64, length: UInt64, upperBound: Int) -> NSRange? {
        guard
            let offset = Int(exactly: offset),
            let length = Int(exactly: length),
            offset <= upperBound,
            length <= upperBound - offset
        else { return nil }
        return NSRange(location: offset, length: length)
    }

    static func optionalRange(offset: UInt64, length: UInt64, upperBound: Int) -> NSRange? {
        guard offset != UInt64.max else { return nil }
        return range(offset: offset, length: length, upperBound: upperBound)
    }

    static func optionalIndex(_ value: UInt64, upperBound: Int) -> Int? {
        guard value != UInt64.max, let index = Int(exactly: value), index <= upperBound else { return nil }
        return index
    }

    static func optionalLine(_ value: UInt64, lineCount: Int) -> Int? {
        guard value != UInt64.max, let line = Int(exactly: value), line >= 0, line < lineCount else { return nil }
        return line
    }
}
