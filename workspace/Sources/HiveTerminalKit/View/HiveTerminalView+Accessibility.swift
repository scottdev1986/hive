import AppKit
import HiveGhosttyC

/// Accessibility (M1-B1 gate 10): neither ghostty.h nor Ghostling supplies
/// Hive's AppKit accessibility contract, so this is a Hive-owned surface
/// ported field-for-field from the pinned Ghostty macOS app
/// (SurfaceView_AppKit.swift "MARK: Accessibility", ~2267-2360) and judged
/// against NSAccessibility, never against SwiftTerm. Screen content and
/// selection come from Ghostty's own read APIs (ghostty_surface_read_text /
/// read_selection) — the same source the renderer and clipboard use — so a
/// screen reader sees exactly what is on the terminal, never a guess.
///
/// Live-proof cells that need interactive infra (flagged to queen, tracked
/// on the M1-B1-MATRIX card, NOT claimed here): real VoiceOver navigation +
/// Accessibility Inspector semantic verification (matrix J), and the
/// selection-changed announcement wiring (NSAccessibility.post on a live
/// selection change) which requires a running a11y client to observe.
extension HiveTerminalView {
    /// Full screen text via Ghostty's own read API (GHOSTTY_POINT_SCREEN
    /// top-left → bottom-right, non-rectangle = whole screen), matching the
    /// real app's cachedScreenContents source exactly. Empty string when no
    /// surface is bound (degenerate but valid — never a crash).
    private func accessibilityScreenContents() -> String {
        guard let handle = engine.surfaceHandle else { return "" }
        var text = ghostty_text_s()
        let selection = ghostty_selection_s(
            top_left: ghostty_point_s(tag: GHOSTTY_POINT_SCREEN, coord: GHOSTTY_POINT_COORD_TOP_LEFT, x: 0, y: 0),
            bottom_right: ghostty_point_s(tag: GHOSTTY_POINT_SCREEN, coord: GHOSTTY_POINT_COORD_BOTTOM_RIGHT, x: 0, y: 0),
            rectangle: false
        )
        guard ghostty_surface_read_text(handle, selection, &text) else { return "" }
        defer { ghostty_surface_free_text(handle, &text) }
        return String(cString: text.text)
    }

    public override func isAccessibilityElement() -> Bool { true }

    /// .textArea: the terminal is an editable text area (commands in,
    /// output shown) — matches the pinned app's role choice.
    public override func accessibilityRole() -> NSAccessibility.Role? { .textArea }

    public override func accessibilityHelp() -> String? { "Terminal content area" }

    public override func accessibilityValue() -> Any? { accessibilityScreenContents() }

    public override func accessibilitySelectedTextRange() -> NSRange { selectedRange() }

    /// Selected text from Ghostty's own selection tracking — nil (not "")
    /// when nothing is selected, so a screen reader announces "no
    /// selection" rather than an empty read.
    public override func accessibilitySelectedText() -> String? {
        guard let handle = engine.surfaceHandle else { return nil }
        var text = ghostty_text_s()
        guard ghostty_surface_read_selection(handle, &text) else { return nil }
        defer { ghostty_surface_free_text(handle, &text) }
        let str = String(cString: text.text)
        return str.isEmpty ? nil : str
    }

    public override func accessibilityNumberOfCharacters() -> Int {
        accessibilityScreenContents().count
    }

    /// Terminals show all content as visible (no off-screen text model).
    public override func accessibilityVisibleCharacterRange() -> NSRange {
        NSRange(location: 0, length: accessibilityScreenContents().count)
    }

    public override func accessibilityLine(for index: Int) -> Int {
        let content = accessibilityScreenContents()
        let clamped = max(0, min(index, content.count))
        let prefix = String(content.prefix(clamped))
        return prefix.components(separatedBy: .newlines).count - 1
    }

    public override func accessibilityString(for range: NSRange) -> String? {
        let content = accessibilityScreenContents()
        guard let swiftRange = Range(range, in: content) else { return nil }
        return String(content[swiftRange])
    }
}
