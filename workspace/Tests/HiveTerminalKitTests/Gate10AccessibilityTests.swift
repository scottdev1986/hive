import AppKit
import XCTest
import HiveGhosttyC
@testable import HiveTerminalKit

/// Gate 10 (M1-B1) accessibility surface controls, against a REAL manual
/// surface. Proves the NSAccessibility contract reports Ghostty's actual
/// screen/selection state (semantic text, character count, line mapping),
/// not a placeholder. The live cells (VoiceOver navigation, Accessibility
/// Inspector, selection-changed announcements) are matrix-J interactive
/// work tracked separately; these are the scriptable positive controls.
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

    func testExposedAsTextAreaAccessibilityElement() throws {
        let view = try makeView()
        defer { surface(of: view).free() }
        XCTAssertTrue(view.isAccessibilityElement())
        XCTAssertEqual(view.accessibilityRole(), .textArea)
        XCTAssertEqual(view.accessibilityHelp(), "Terminal content area")
    }

    /// accessibilityValue must reflect REAL terminal content — write text
    /// through the ordered-output path, then read it back through the a11y
    /// surface. RED if the value is a placeholder or reads a different
    /// buffer than the renderer.
    func testAccessibilityValueReflectsRealScreenContent() throws {
        let view = try makeView()
        let surface = surface(of: view)
        defer { surface.free() }

        XCTAssertEqual(surface.processOutput(bytes: Data("hello accessibility".utf8), streamSeq: 0), .success)

        let value = view.accessibilityValue() as? String ?? ""
        XCTAssertTrue(value.contains("hello accessibility"),
                      "accessibilityValue must expose the real screen text a screen reader would read, " +
                      "got \(value.prefix(60).debugDescription)")
        XCTAssertGreaterThan(view.accessibilityNumberOfCharacters(), 0)
        XCTAssertEqual(view.accessibilityVisibleCharacterRange().length,
                       view.accessibilityNumberOfCharacters(),
                       "a terminal exposes all content as visible")
    }

    /// Line mapping must track real newlines, so VoiceOver line navigation
    /// lands on the right row.
    func testAccessibilityLineTracksRealNewlines() throws {
        let view = try makeView()
        let surface = surface(of: view)
        defer { surface.free() }

        XCTAssertEqual(surface.processOutput(bytes: Data("line0\r\nline1\r\nline2".utf8), streamSeq: 0), .success)
        let content = view.accessibilityValue() as? String ?? ""
        guard let idxLine2 = content.range(of: "line2")?.lowerBound else {
            return XCTFail("expected line2 in screen content, got \(content.debugDescription)")
        }
        let offset = content.distance(from: content.startIndex, to: idxLine2)
        XCTAssertGreaterThanOrEqual(view.accessibilityLine(for: offset), 2,
                                    "the character index of line2 must map to accessibility line >= 2")
        XCTAssertEqual(view.accessibilityLine(for: 0), 0, "the first character is on line 0")
    }

    /// accessibilityString(for:) must return the real substring, so
    /// range-based reading works.
    func testAccessibilityStringForRangeReturnsRealSubstring() throws {
        let view = try makeView()
        let surface = surface(of: view)
        defer { surface.free() }

        XCTAssertEqual(surface.processOutput(bytes: Data("abcdef".utf8), streamSeq: 0), .success)
        let sub = view.accessibilityString(for: NSRange(location: 0, length: 3))
        XCTAssertEqual(sub, "abc", "the first three characters must read back exactly")
    }

    /// No selection → nil selected text (announces "no selection"), not "".
    /// A degenerate range is still valid, never a crash.
    func testAccessibilitySelectedTextIsNilWithoutSelection() throws {
        let view = try makeView()
        let surface = surface(of: view)
        defer { surface.free() }

        XCTAssertEqual(surface.processOutput(bytes: Data("content".utf8), streamSeq: 0), .success)
        XCTAssertNil(view.accessibilitySelectedText(),
                     "with nothing selected, selected text must be nil, not an empty string")
        XCTAssertEqual(view.accessibilitySelectedTextRange(), NSRange(location: NSNotFound, length: 0))
    }

    /// POSITIVE control (cross-vendor review 2026-07-18 — the selection test
    /// was negative-only): make a REAL selection via Ghostty's own select_all
    /// binding action, then assert the a11y surface reports the real
    /// selected text and a non-empty range from ghostty_surface_read_selection
    /// — not the NSNotFound placeholder.
    func testAccessibilitySelectedTextReflectsARealSelection() throws {
        let view = try makeView()
        let surface = surface(of: view)
        defer { surface.free() }
        guard let handle = surface.surfaceHandle else { return XCTFail("real surface required") }

        XCTAssertEqual(surface.processOutput(bytes: Data("selectable content".utf8), streamSeq: 0), .success)
        let action = "select_all"
        _ = action.withCString { ghostty_surface_binding_action(handle, $0, UInt(action.utf8.count)) }

        guard let selected = view.accessibilitySelectedText() else {
            return XCTFail("a real select_all must produce non-nil selected text")
        }
        XCTAssertTrue(selected.contains("selectable content"),
                      "selected text must be the real selection, got \(selected.debugDescription)")
        let range = view.accessibilitySelectedTextRange()
        XCTAssertNotEqual(range.location, NSNotFound, "a real selection must report a concrete range")
        XCTAssertGreaterThan(range.length, 0, "a real selection's range length must be > 0")
    }

    /// Non-ASCII UTF-16 correctness (cross-vendor review 2026-07-18): the
    /// NSAccessibility text APIs are UTF-16-indexed (accessibilityString
    /// consumes NSRange), so numberOfCharacters MUST be the UTF-16 length,
    /// not the grapheme count — they diverge for astral characters (😀 is 1
    /// grapheme, 2 UTF-16 units). The earlier test compared two APIs that
    /// both used String.count (tautological) and read NSRange(0,1) which
    /// only covers 'é'. This asserts numberOfCharacters == (value as
    /// NSString).length and reads 😀 at its ACTUAL UTF-16 NSRange, so it
    /// goes RED if the implementation reverts to grapheme units.
    func testAccessibilityUsesUTF16UnitsForNonASCII() throws {
        let view = try makeView()
        let surface = surface(of: view)
        defer { surface.free() }

        // é (1 UTF-16), 😀 (2 UTF-16 units / 1 grapheme).
        XCTAssertEqual(surface.processOutput(bytes: Data("é😀xy".utf8), streamSeq: 0), .success)

        let value = view.accessibilityValue() as? String ?? ""
        XCTAssertTrue(value.contains("😀"), "astral content must be exposed, got \(value.prefix(16).debugDescription)")
        let ns = value as NSString

        // The a11y character count MUST be the UTF-16 length. For content
        // containing an emoji, UTF-16 length > grapheme count, so this fails
        // if numberOfCharacters returns String.count.
        XCTAssertEqual(view.accessibilityNumberOfCharacters(), ns.length,
                       "numberOfCharacters must be the UTF-16 length \(ns.length), not the grapheme count " +
                       "\(value.count) — a screen reader indexes in UTF-16")
        XCTAssertGreaterThan(ns.length, value.count,
                             "sanity: this fixture must actually contain a UTF-16/grapheme divergence")
        XCTAssertEqual(view.accessibilityVisibleCharacterRange(),
                       NSRange(location: 0, length: ns.length),
                       "visible range must span the full UTF-16 length")

        // Read the emoji at its REAL UTF-16 NSRange (location = UTF-16 index
        // of 😀, length = 2) and assert it round-trips to exactly "😀" — a
        // grapheme-indexed implementation would return the wrong slice.
        let emojiRange = ns.range(of: "😀")
        XCTAssertEqual(emojiRange.length, 2, "😀 must be 2 UTF-16 units")
        let read = view.accessibilityString(for: emojiRange)
        XCTAssertEqual(read, "😀", "reading the emoji's UTF-16 NSRange must return exactly the emoji, got \(String(describing: read))")
    }

    /// Degenerate surface (freed): the a11y surface must stay safe — empty
    /// content, zero counts, no crash. Proves the guards, not a happy path.
    func testAccessibilitySurfaceSafeAfterFree() throws {
        let view = try makeView()
        let surface = surface(of: view)
        surface.free()

        XCTAssertEqual(view.accessibilityValue() as? String, "")
        XCTAssertEqual(view.accessibilityNumberOfCharacters(), 0)
        XCTAssertEqual(view.accessibilityLine(for: 0), 0)
        XCTAssertNil(view.accessibilitySelectedText())
    }
}
