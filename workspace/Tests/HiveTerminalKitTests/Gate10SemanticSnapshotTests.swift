import AppKit
import Darwin
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

private let gate10TestSnapshotAllocator: hive_ghostty_alloc_fn = { _, length, _ in
    malloc(length)
}

@MainActor
final class Gate10SemanticSnapshotTests: XCTestCase {
    private func makeSurface(
        width: UInt32 = 800,
        height: UInt32 = 480
    ) throws -> GhosttyManualSurface {
        do {
            return try GhosttyBridgeFactory.makeManualSurfaceForTesting(
                widthPx: width,
                heightPx: height
            )
        } catch {
            XCTFail("real manual surface required for gate 10: \(error)")
            throw error
        }
    }

    private func waitUntil(
        timeout: TimeInterval = 2,
        _ condition: () -> Bool
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if condition() { return true }
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        } while Date() < deadline
        return condition()
    }

    private func performBinding(_ action: String, on surface: GhosttyManualSurface) -> Bool {
        guard let handle = surface.surfaceHandle else { return false }
        return action.withCString {
            ghostty_surface_binding_action(handle, $0, UInt(action.utf8.count))
        }
    }

    private func dragSelection(
        on surface: GhosttyManualSurface,
        from start: (column: Int, row: Int),
        to end: (column: Int, row: Int),
        modifiers: TerminalModifiers = []
    ) throws {
        guard let handle = surface.surfaceHandle else {
            throw NSError(domain: "Gate10SemanticSnapshotTests", code: 1)
        }
        // Mouse input is a Gate 8 stock-surface operation, so author the
        // gesture with the stock surface's reported input cell geometry and
        // C1 balanced padding. The snapshot itself deliberately uses the
        // locked Terminal commit.
        let inputGeometry = ghostty_surface_size(handle)
        let horizontalSpace = Int(inputGeometry.width_px) -
            Int(inputGeometry.columns) * Int(inputGeometry.cell_width_px)
        let verticalSpace = Int(inputGeometry.height_px) -
            Int(inputGeometry.rows) * Int(inputGeometry.cell_height_px)
        let leftPadding = max(0, horizontalSpace / 2)
        let balancedTop = max(0, verticalSpace / 2)
        let cappedTop = (2 * HiveTerminalConfiguration.horizontalPaddingPoints +
            Int(inputGeometry.cell_width_px)) / 2
        let topPadding = min(balancedTop, cappedTop)
        func point(_ cell: (column: Int, row: Int)) -> NSPoint {
            NSPoint(
                x: leftPadding + cell.column * Int(inputGeometry.cell_width_px) +
                    Int(inputGeometry.cell_width_px) / 2,
                y: topPadding + cell.row * Int(inputGeometry.cell_height_px) +
                    Int(inputGeometry.cell_height_px) / 2
            )
        }

        let startPoint = point(start)
        surface.sendMousePos(x: startPoint.x, y: startPoint.y, modifiers: modifiers)
        _ = surface.sendMouseButton(state: .press, button: .left, modifiers: modifiers)
        let endPoint = point(end)
        surface.sendMousePos(x: endPoint.x, y: endPoint.y, modifiers: modifiers)
        _ = surface.sendMouseButton(state: .release, button: .left, modifiers: modifiers)
    }

    private func rawSnapshotSummary(_ surface: GhosttyManualSurface) -> String {
        guard let handle = surface.surfaceHandle else { return "no surface" }
        var raw = hive_ghostty_semantic_snapshot_s()
        let result = hive_ghostty_surface_semantic_snapshot_v1(
            handle,
            gate10TestSnapshotAllocator,
            nil,
            &raw
        )
        defer { Darwin.free(raw.allocation) }
        return "result=\(result.rawValue) rows=\(raw.visible_row_count)/\(raw.rows) " +
            "cursor=\(raw.cursor_visible):\(raw.cursor_utf16_offset):\(raw.cursor_line) " +
            "selection=\(raw.has_selection):\(raw.selection_utf16_offset):\(raw.selection_utf16_length) " +
            "rectangle=\(raw.selection_is_rectangular) clipped=\(raw.selection_range_clipped)"
    }

    private func assertInternallyConsistent(
        _ snapshot: ManualSurfaceSemanticSnapshot,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(snapshot.textUTF16Length, (snapshot.text as NSString).length, file: file, line: line)
        XCTAssertEqual(snapshot.visibleRows.count, snapshot.geometry.rows, file: file, line: line)
        for row in snapshot.visibleRows {
            XCTAssertEqual(row.cellUTF16Offsets.count, snapshot.geometry.columns + 1, file: file, line: line)
            XCTAssertEqual(row.cellUTF16Offsets.first, row.utf16Range.location, file: file, line: line)
            XCTAssertEqual(row.cellUTF16Offsets.last, NSMaxRange(row.utf16Range), file: file, line: line)
            XCTAssertTrue(zip(row.cellUTF16Offsets, row.cellUTF16Offsets.dropFirst()).allSatisfy(<=),
                          file: file, line: line)
        }
        if snapshot.cursor.isVisible {
            XCTAssertNotNil(snapshot.cursor.utf16Offset, file: file, line: line)
            XCTAssertNotNil(snapshot.cursor.line, file: file, line: line)
            XCTAssertLessThanOrEqual(snapshot.cursor.utf16Offset!, snapshot.textUTF16Length, file: file, line: line)
            XCTAssertTrue(snapshot.visibleRows.indices.contains(snapshot.cursor.line!), file: file, line: line)
        }
        if let range = snapshot.selection?.visibleUTF16Range {
            XCTAssertLessThanOrEqual(NSMaxRange(range), snapshot.textUTF16Length, file: file, line: line)
        }
    }

    func testSnapshotUsesOneUTF16SpaceForRowsCellsCursorAndSelection() throws {
        let surface = try makeSurface()
        defer { surface.free() }
        guard let initial = surface.semanticSnapshot() else { return XCTFail("initial snapshot") }

        let bytes = Data("A😀界e\u{301}\r\nsecond".utf8)
        XCTAssertEqual(surface.processOutput(bytes: bytes, streamSeq: 0), .success)
        guard let snapshot = surface.semanticSnapshot() else { return XCTFail("semantic snapshot") }

        assertInternallyConsistent(snapshot)
        XCTAssertGreaterThan(snapshot.generation, initial.generation)
        XCTAssertTrue(snapshot.text.contains("A😀界e\u{301}"))
        XCTAssertEqual(snapshot.cursor.utf16Offset, ("A😀界e\u{301}\nsecond" as NSString).length)
        XCTAssertEqual(snapshot.cursor.line, 1)

        let repeated = surface.semanticSnapshot()
        XCTAssertEqual(repeated, snapshot, "an unchanged all-field digest must not advance generation")

        XCTAssertTrue(performBinding("select_all", on: surface))
        guard let selected = surface.semanticSnapshot() else { return XCTFail("selected snapshot") }
        XCTAssertGreaterThan(selected.generation, snapshot.generation)
        XCTAssertTrue(selected.selection?.text.contains("A😀界e\u{301}") == true)
        assertInternallyConsistent(selected)
    }

    func testPendingWrapAndHiddenCursorHaveDefinedFallbacks() throws {
        let surface = try makeSurface(width: 320, height: 160)
        defer { surface.free() }
        guard let initial = surface.semanticSnapshot(), initial.geometry.columns > 0 else {
            return XCTFail("initial geometry")
        }

        let fullRow = Data(String(repeating: "x", count: initial.geometry.columns).utf8)
        XCTAssertEqual(surface.processOutput(bytes: fullRow, streamSeq: 0), .success)
        guard let wrapped = surface.semanticSnapshot() else { return XCTFail("pending-wrap snapshot") }
        XCTAssertTrue(wrapped.cursor.isVisible)
        XCTAssertTrue(wrapped.cursor.isPendingWrap)
        XCTAssertEqual(wrapped.cursor.utf16Offset, NSMaxRange(wrapped.visibleRows[0].utf16Range))

        let hide = Data("\u{1b}[?25l".utf8)
        XCTAssertEqual(surface.processOutput(bytes: hide, streamSeq: UInt64(fullRow.count)), .success)
        guard let hidden = surface.semanticSnapshot() else { return XCTFail("hidden-cursor snapshot") }
        XCTAssertFalse(hidden.cursor.isVisible)
        XCTAssertNil(hidden.cursor.utf16Offset)
        XCTAssertNil(hidden.cursor.line)
        assertInternallyConsistent(hidden)
    }

    func testOffViewportCursorAndSelectionRemainTruthful() throws {
        let surface = try makeSurface(width: 400, height: 160)
        defer { surface.free() }

        let corpus = (0 ..< 80).map { "line-\($0)\r\n" }.joined()
        let bytes = Data(corpus.utf8)
        XCTAssertEqual(surface.processOutput(bytes: bytes, streamSeq: 0), .success)
        XCTAssertTrue(waitUntil {
            guard let value = surface.semanticSnapshot() else { return false }
            return value.viewport.total > value.viewport.length
        }, "fixture must create scrollback")

        XCTAssertTrue(performBinding("select_all", on: surface))
        guard let selected = surface.semanticSnapshot() else { return XCTFail("selected snapshot") }
        XCTAssertTrue(selected.selection?.text.contains("line-0") == true)
        XCTAssertTrue(selected.selection?.rangeIsClipped == true,
                      "a scrollback-spanning selection must identify its viewport range as clipped")

        XCTAssertTrue(performBinding("scroll_to_selection", on: surface))
        guard let scrolled = surface.semanticSnapshot() else {
            return XCTFail("scrolled snapshot: \(rawSnapshotSummary(surface))")
        }
        XCTAssertFalse(scrolled.viewport.followsBottom)
        XCTAssertFalse(scrolled.cursor.isVisible)
        XCTAssertNil(scrolled.cursor.utf16Offset)
        XCTAssertNil(scrolled.cursor.line)
        assertInternallyConsistent(scrolled)
    }

    func testReverseSelectionMapsWideAndCombiningEndpointsIntoOneUTF16Range() throws {
        let surface = try makeSurface(width: 400, height: 160)
        defer { surface.free() }

        let text = "A😀界e\u{301}Z"
        XCTAssertEqual(surface.processOutput(bytes: Data(text.utf8), streamSeq: 0), .success)
        // Grid: A@0, 😀@1-2, 界@3-4, e\u{301}@5, Z@6. The gesture's higher
        // endpoint is exclusive on the current input stack, so a reverse drag
        // from cell 7 back to 界's lead cell selects exactly 界e\u{301}Z.
        try dragSelection(on: surface, from: (7, 0), to: (3, 0))
        guard
            let snapshot = surface.semanticSnapshot(),
            let selection = snapshot.selection,
            let range = selection.visibleUTF16Range
        else { return XCTFail("reverse wide/grapheme selection") }

        XCTAssertFalse(selection.isRectangular)
        XCTAssertFalse(selection.rangeIsClipped)
        XCTAssertEqual((snapshot.text as NSString).substring(with: range), selection.text)
        XCTAssertEqual(selection.text, "界e\u{301}Z")
        assertInternallyConsistent(snapshot)
    }

    func testRectangularSelectionReturnsExactTextWithoutFabricatedRange() throws {
        let surface = try makeSurface(width: 400, height: 160)
        defer { surface.free() }

        let bytes = Data("abcdefgh\r\n01234567".utf8)
        XCTAssertEqual(surface.processOutput(bytes: bytes, streamSeq: 0), .success)
        try dragSelection(on: surface, from: (1, 0), to: (3, 1), modifiers: .option)
        guard let selection = surface.semanticSnapshot()?.selection else {
            return XCTFail("rectangular selection")
        }

        XCTAssertTrue(selection.isRectangular)
        XCTAssertNil(selection.visibleUTF16Range)
        XCTAssertFalse(selection.rangeIsClipped)
        XCTAssertFalse(selection.text.isEmpty)
    }

    func testResizeWorkerCannotTearLockedGeometryFromRows() throws {
        let surface = try makeSurface(width: 640, height: 360)
        defer { surface.free() }
        let bytes = Data((0 ..< 30).map { "row-\($0)\r\n" }.joined().utf8)
        XCTAssertEqual(surface.processOutput(bytes: bytes, streamSeq: 0), .success)

        var priorGeneration: UInt64 = 0
        for index in 0 ..< 200 {
            let width: UInt32 = index.isMultiple(of: 2) ? 420 : 760
            let height: UInt32 = index.isMultiple(of: 3) ? 220 : 420
            surface.setSize(widthPx: width, heightPx: height)
            guard let snapshot = surface.semanticSnapshot() else { return XCTFail("snapshot \(index)") }
            assertInternallyConsistent(snapshot)
            XCTAssertGreaterThanOrEqual(snapshot.generation, priorGeneration)
            priorGeneration = snapshot.generation
        }
    }
}
