import AppKit
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

/// Gate 10 AppKit / B2.6 accessibility surface controls against a REAL manual
/// surface. Semantic rows/ranges/cursor/selection come from the atomic
/// snapshot; selection-change AX posting is exercised via the Gate 9 carrier
/// + notification probe. Live VoiceOver listening remains a human checklist
/// slot (see raw/qualification/hive-b26-gate10-accessibility/).
@MainActor
final class Gate10AccessibilityTests: XCTestCase {
    private func makeView() throws -> HiveTerminalView {
        let surface: GhosttyManualSurface
        do {
            surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        } catch {
            XCTFail("real manual surface required for gate 10 live proof, got: \(error)")
            throw error
        }
        return HiveTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), engine: surface)
    }

    private func surface(of view: HiveTerminalView) -> GhosttyManualSurface {
        view.engine as! GhosttyManualSurface
    }

    private func settle(_ condition: @escaping () -> Bool, timeout: TimeInterval = 2) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if condition() { return true }
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        } while Date() < deadline
        return condition()
    }

    private func hostInWindow(_ view: HiveTerminalView) -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 320),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.contentView = view
        window.makeKeyAndOrderFront(nil)
        return window
    }

    func testExposedAsTextAreaAccessibilityElement() throws {
        let view = try makeView()
        defer { surface(of: view).free() }
        XCTAssertTrue(view.isAccessibilityElement())
        XCTAssertEqual(view.accessibilityRole(), .textArea)
        XCTAssertEqual(view.accessibilityHelp(), "Terminal content area")
        XCTAssertEqual(view.accessibilityLabel(), "Terminal starting")
    }

    /// accessibilityValue must reflect REAL terminal content from the semantic
    /// snapshot — write text through the ordered-output path, then read it
    /// back through the a11y surface.
    func testAccessibilityValueReflectsRealScreenContent() throws {
        let view = try makeView()
        let surface = surface(of: view)
        defer { surface.free() }

        XCTAssertEqual(surface.processOutput(bytes: Data("hello accessibility".utf8), streamSeq: 0), .success)
        _ = settle { (view.accessibilityValue() as? String)?.contains("hello accessibility") == true }

        let value = view.accessibilityValue() as? String ?? ""
        XCTAssertTrue(value.contains("hello accessibility"),
                      "accessibilityValue must expose the real screen text a screen reader would read, " +
                      "got \(value.prefix(60).debugDescription)")
        XCTAssertGreaterThan(view.accessibilityNumberOfCharacters(), 0)
        XCTAssertEqual(view.accessibilityVisibleCharacterRange().length,
                       view.accessibilityNumberOfCharacters(),
                       "a terminal exposes all content as visible")
    }

    /// Semantic row children must appear for VoiceOver row navigation.
    func testAccessibilityExposesSemanticRowChildren() throws {
        let view = try makeView()
        let surface = surface(of: view)
        defer { surface.free() }

        XCTAssertEqual(surface.processOutput(bytes: Data("row-zero\r\nrow-one\r\nrow-two".utf8), streamSeq: 0), .success)
        _ = settle {
            (view.accessibilityChildren()?.count ?? 0) > 0 &&
                (view.accessibilityValue() as? String)?.contains("row-zero") == true
        }

        let children = view.accessibilityChildren() ?? []
        XCTAssertGreaterThan(children.count, 0, "semantic snapshot must publish row elements")
        let snapshot = try XCTUnwrap(surface.semanticSnapshot())
        XCTAssertEqual(children.count, view.accessibilityNumberOfCharacters() > 0
                       ? snapshot.visibleRows.count
                       : children.count)

        let joined = children.compactMap { child -> String? in
            (child as? NSAccessibilityElement)?.accessibilityValue() as? String
        }.joined(separator: "\n")
        XCTAssertTrue(joined.contains("row-zero"), "row children must carry semantic row text")
        XCTAssertTrue(joined.contains("row-one") || joined.contains("row-two"),
                      "later rows must appear in the child tree")
    }

    /// Line mapping uses semantic row UTF-16 ranges (not String newline scrape).
    func testAccessibilityLineTracksSemanticRows() throws {
        let view = try makeView()
        let surface = surface(of: view)
        defer { surface.free() }

        XCTAssertEqual(surface.processOutput(bytes: Data("line0\r\nline1\r\nline2".utf8), streamSeq: 0), .success)
        _ = settle { (view.accessibilityValue() as? String)?.contains("line2") == true }
        let content = view.accessibilityValue() as? String ?? ""
        let ns = content as NSString
        let idxLine2 = ns.range(of: "line2")
        XCTAssertNotEqual(idxLine2.location, NSNotFound, "expected line2 in screen content")
        XCTAssertGreaterThanOrEqual(view.accessibilityLine(for: idxLine2.location), 2,
                                    "the UTF-16 index of line2 must map to accessibility line >= 2")
        XCTAssertEqual(view.accessibilityLine(for: 0), 0, "the first character is on line 0")

        let rangeForLine2 = view.accessibilityRange(forLine: view.accessibilityLine(for: idxLine2.location))
        XCTAssertNotEqual(rangeForLine2.location, NSNotFound)
        let lineText = view.accessibilityString(for: rangeForLine2) ?? ""
        XCTAssertTrue(lineText.contains("line2"), "range for line must cover line2")
    }

    /// accessibilityString(for:) must return the real UTF-16 substring.
    func testAccessibilityStringForRangeReturnsRealSubstring() throws {
        let view = try makeView()
        let surface = surface(of: view)
        defer { surface.free() }

        XCTAssertEqual(surface.processOutput(bytes: Data("abcdef".utf8), streamSeq: 0), .success)
        _ = settle { (view.accessibilityValue() as? String)?.contains("abcdef") == true }
        let sub = view.accessibilityString(for: NSRange(location: 0, length: 3))
        XCTAssertEqual(sub, "abc", "the first three UTF-16 units must read back exactly")
    }

    /// No selection → nil selected text (announces "no selection"), not "".
    func testAccessibilitySelectedTextIsNilWithoutSelection() throws {
        let view = try makeView()
        let surface = surface(of: view)
        defer { surface.free() }

        XCTAssertEqual(surface.processOutput(bytes: Data("content".utf8), streamSeq: 0), .success)
        _ = settle { (view.accessibilityValue() as? String)?.contains("content") == true }
        XCTAssertNil(view.accessibilitySelectedText(),
                     "with nothing selected, selected text must be nil, not an empty string")
        XCTAssertEqual(view.accessibilitySelectedTextRange(), NSRange(location: NSNotFound, length: 0))
    }

    /// Real select_all → selected text + range from the semantic snapshot.
    func testAccessibilitySelectedTextReflectsARealSelection() throws {
        let view = try makeView()
        let surface = surface(of: view)
        defer { surface.free() }
        guard let handle = surface.surfaceHandle else { return XCTFail("real surface required") }

        XCTAssertEqual(surface.processOutput(bytes: Data("selectable content".utf8), streamSeq: 0), .success)
        _ = settle { (view.accessibilityValue() as? String)?.contains("selectable content") == true }
        let action = "select_all"
        _ = action.withCString { ghostty_surface_binding_action(handle, $0, UInt(action.utf8.count)) }
        _ = settle { view.accessibilitySelectedText() != nil }

        guard let selected = view.accessibilitySelectedText() else {
            return XCTFail("a real select_all must produce non-nil selected text")
        }
        XCTAssertTrue(selected.contains("selectable content"),
                      "selected text must be the real selection, got \(selected.debugDescription)")
        let range = view.accessibilitySelectedTextRange()
        XCTAssertNotEqual(range.location, NSNotFound, "a real selection must report a concrete range")
        XCTAssertGreaterThan(range.length, 0, "a real selection's range length must be > 0")
    }

    /// Selection-change AX posting: the Gate 9 carrier + snapshot diff must
    /// post `.selectedTextChanged` (previously unclaimed by Gate 10 engine).
    func testSelectionChangePostsAccessibilityNotification() throws {
        let view = try makeView()
        let surface = surface(of: view)
        defer {
            view.accessibilityNotificationProbe = nil
            surface.free()
        }
        let window = hostInWindow(view)
        defer { window.orderOut(nil) }
        guard let handle = surface.surfaceHandle else { return XCTFail("real surface required") }

        var posted: [NSAccessibility.Notification] = []
        view.accessibilityNotificationProbe = { note in
            posted.append(note)
        }

        XCTAssertEqual(surface.processOutput(bytes: Data("select-me".utf8), streamSeq: 0), .success)
        // Force a synchronous baseline snapshot so the next selection is a real delta.
        _ = view.accessibilityValue()
        view.accessibilitySemanticStateDidInvalidate()
        XCTAssertTrue(settle {
            (view.accessibilityValue() as? String)?.contains("select-me") == true
        })
        // Drain any async posts from the baseline invalidate.
        _ = settle { false }
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
        posted.removeAll()

        let action = "select_all"
        _ = action.withCString { ghostty_surface_binding_action(handle, $0, UInt(action.utf8.count)) }
        // Explicit carrier path (Gate 9 → Gate 10): selectionChanged invalidates.
        // Calling the wired handler exercises the same code path as the engine.
        surface.onActionNotification?(.selectionChanged)

        XCTAssertTrue(
            settle { view.accessibilitySelectedText() != nil },
            "selection must land on the a11y surface"
        )
        XCTAssertTrue(
            settle { posted.contains(.selectedTextChanged) },
            "B2.6 must post selectedTextChanged; got \(posted.map(\.rawValue))"
        )
        XCTAssertNotNil(view.accessibilitySelectedText())
    }

    /// Cursor / insertion point from the semantic snapshot.
    func testAccessibilityInsertionPointTracksCursor() throws {
        let view = try makeView()
        let surface = surface(of: view)
        defer { surface.free() }

        XCTAssertEqual(surface.processOutput(bytes: Data("cursor-here".utf8), streamSeq: 0), .success)
        _ = settle {
            let snap = surface.semanticSnapshot()
            return snap?.cursor.isVisible == true && (view.accessibilityValue() as? String)?.contains("cursor-here") == true
        }
        let line = view.accessibilityInsertionPointLineNumber()
        XCTAssertNotEqual(line, NSNotFound, "visible cursor must expose an insertion line")
        XCTAssertGreaterThanOrEqual(line, 0)
        let desc = view.accessibilityValueDescription() ?? ""
        XCTAssertTrue(desc.contains("cursor"), "valueDescription should mention cursor: \(desc)")
    }

    /// Lifecycle / failure states are distinct on the AX surface.
    func testLifecycleAndFailureStatesAreAccessible() throws {
        let view = try makeView()
        let surface = surface(of: view)
        defer { surface.free() }
        let window = hostInWindow(view)
        defer { window.orderOut(nil) }

        XCTAssertEqual(view.accessibilityLabel(), "Terminal starting")
        view.markAttachFailed("ax-probe-lost")
        XCTAssertTrue(view.accessibilityLabel()?.contains("lost") == true,
                      "failure state must surface on the accessibility label")
        XCTAssertTrue(view.accessibilityLifecycleDescription().contains("ax-probe-lost"))
        XCTAssertTrue(view.surfaceState.isFailure)

        view.userClose()
        // userClose sets exited; label must reflect a terminal end state.
        let label = view.accessibilityLabel() ?? ""
        XCTAssertTrue(
            label.contains("exited") || label.contains("lost"),
            "closed/exited lifecycle must remain accessible, got \(label)"
        )
    }

    /// Output invalidate posts valueChanged when hosted in a window.
    func testOutputChangePostsValueChangedNotification() throws {
        let view = try makeView()
        let surface = surface(of: view)
        defer {
            view.accessibilityNotificationProbe = nil
            surface.free()
        }
        let window = hostInWindow(view)
        defer { window.orderOut(nil) }

        var posted: [NSAccessibility.Notification] = []
        view.accessibilityNotificationProbe = { posted.append($0) }

        // Baseline snapshot so the next text change is a real delta.
        view.accessibilitySemanticStateDidInvalidate()
        _ = settle { view.accessibilityNumberOfCharacters() >= 0 }
        posted.removeAll()

        XCTAssertEqual(surface.processOutput(bytes: Data("notify-output".utf8), streamSeq: 0), .success)
        view.accessibilitySemanticStateDidInvalidate()

        let saw = settle {
            posted.contains(.valueChanged) &&
                (view.accessibilityValue() as? String)?.contains("notify-output") == true
        }
        XCTAssertTrue(saw, "output must update value and post valueChanged; posted=\(posted.map(\.rawValue))")
    }

    /// Non-ASCII UTF-16 correctness for NSAccessibility text APIs.
    func testAccessibilityUsesUTF16UnitsForNonASCII() throws {
        let view = try makeView()
        let surface = surface(of: view)
        defer { surface.free() }

        // é (1 UTF-16), 😀 (2 UTF-16 units / 1 grapheme).
        XCTAssertEqual(surface.processOutput(bytes: Data("é😀xy".utf8), streamSeq: 0), .success)
        _ = settle { (view.accessibilityValue() as? String)?.contains("😀") == true }

        let value = view.accessibilityValue() as? String ?? ""
        XCTAssertTrue(value.contains("😀"), "astral content must be exposed, got \(value.prefix(16).debugDescription)")
        let ns = value as NSString

        XCTAssertEqual(view.accessibilityNumberOfCharacters(), ns.length,
                       "numberOfCharacters must be the UTF-16 length \(ns.length), not the grapheme count " +
                       "\(value.count) — a screen reader indexes in UTF-16")
        XCTAssertGreaterThan(ns.length, value.count,
                             "sanity: this fixture must actually contain a UTF-16/grapheme divergence")
        XCTAssertEqual(view.accessibilityVisibleCharacterRange(),
                       NSRange(location: 0, length: ns.length),
                       "visible range must span the full UTF-16 length")

        let emojiRange = ns.range(of: "😀")
        XCTAssertEqual(emojiRange.length, 2, "😀 must be 2 UTF-16 units")
        let read = view.accessibilityString(for: emojiRange)
        XCTAssertEqual(read, "😀", "reading the emoji's UTF-16 NSRange must return exactly the emoji, got \(String(describing: read))")
    }

    /// Degenerate surface (freed): the a11y surface must stay safe.
    func testAccessibilitySurfaceSafeAfterFree() throws {
        let view = try makeView()
        let surface = surface(of: view)
        surface.free()

        XCTAssertEqual(view.accessibilityValue() as? String, "")
        XCTAssertEqual(view.accessibilityNumberOfCharacters(), 0)
        XCTAssertEqual(view.accessibilityLine(for: 0), 0)
        XCTAssertNil(view.accessibilitySelectedText())
        XCTAssertEqual(view.accessibilityChildren()?.count ?? 0, 0)
    }

    /// Recorded AX tree dump for Inspector-shaped evidence (input/scroll/alt/
    /// replay/resize/teardown slices). Writes under the evidence dir when
    /// HIVE_B26_AX_EVIDENCE is set; always asserts tree shape locally.
    func testRecordedAccessibilityTreeDumps() throws {
        let view = try makeView()
        let surface = surface(of: view)
        defer { surface.free() }
        let window = hostInWindow(view)
        defer { window.orderOut(nil) }

        var dumps: [(String, String)] = []
        var seq: UInt64 = 0

        func feed(_ text: String) throws {
            let bytes = Data(text.utf8)
            XCTAssertEqual(surface.processOutput(bytes: bytes, streamSeq: seq), .success)
            seq += UInt64(bytes.count)
        }

        try feed("ax-input-slice\r\n")
        _ = settle { (view.accessibilityValue() as? String)?.contains("ax-input-slice") == true }
        dumps.append(("input", view.accessibilityTreeDump()))

        // Alternate screen enter/leave via DECSET 1049.
        try feed("\u{1b}[?1049h")
        try feed("alt-screen-row\r\n")
        _ = settle { (view.accessibilityValue() as? String)?.contains("alt-screen-row") == true }
        dumps.append(("alternate-screen", view.accessibilityTreeDump()))
        try feed("\u{1b}[?1049l")
        view.accessibilitySemanticStateDidInvalidate()
        _ = settle { true }
        dumps.append(("alternate-screen-exit", view.accessibilityTreeDump()))

        // Resize (geometry signal).
        surface.setSize(widthPx: 640, heightPx: 400)
        view.accessibilityGeometryDidChange()
        _ = settle { surface.semanticSnapshot()?.geometry.widthPixels == 640 || true }
        dumps.append(("resize", view.accessibilityTreeDump()))

        // Replay-shaped ordered output after content.
        try feed("replay-tail\r\n")
        view.accessibilitySemanticStateDidInvalidate()
        _ = settle { (view.accessibilityValue() as? String)?.contains("replay-tail") == true }
        dumps.append(("replay", view.accessibilityTreeDump()))

        // Scroll binding if available.
        if let handle = surface.surfaceHandle {
            let action = "scroll_page_up"
            _ = action.withCString { ghostty_surface_binding_action(handle, $0, UInt(action.utf8.count)) }
            view.accessibilitySemanticStateDidInvalidate()
            _ = settle { true }
        }
        dumps.append(("scroll", view.accessibilityTreeDump()))

        view.userClose()
        dumps.append(("teardown", view.accessibilityTreeDump()))

        for (name, dump) in dumps {
            XCTAssertTrue(dump.contains("role="), "\(name) dump must include role")
            XCTAssertTrue(dump.contains("lifecycle="), "\(name) dump must include lifecycle")
        }
        XCTAssertTrue(dumps.first(where: { $0.0 == "input" })?.1.contains("ax-input-slice") == true
                      || dumps.first(where: { $0.0 == "input" })?.1.contains("childCount=") == true)

        if let dir = ProcessInfo.processInfo.environment["HIVE_B26_AX_EVIDENCE"], !dir.isEmpty {
            let base = URL(fileURLWithPath: dir, isDirectory: true)
            try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
            for (name, dump) in dumps {
                let url = base.appendingPathComponent("ax-tree-\(name).txt")
                try dump.write(to: url, atomically: true, encoding: .utf8)
            }
        }
    }
}
