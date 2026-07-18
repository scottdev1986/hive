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
