import AppKit

/// The pane's opaque content background.
///
/// C1.3: this must **not** be an `NSVisualEffectView`. Vibrancy is inherited by
/// subviews and cannot be switched off by them; it is recommended only in leaf
/// views and works best on grayscale content. Terminal output is full-color,
/// arbitrary, and third-party, so the terminal surface must not descend from a
/// vibrancy-enabled view. This view is what the surface descends from instead:
/// a standard opaque content background, filled with a semantic color so light,
/// dark, and accent changes resolve on every redraw.
///
/// The previous background here *was* an `NSVisualEffectView`, which put the
/// terminal surface inside a vibrancy-enabled ancestor. See
/// `C13PaneChromeTests.testTerminalContentHasNoVibrancyEnabledAncestor`.
final class PaneBackgroundView: NSView {

    override var isOpaque: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.controlBackgroundColor.setFill()
        dirtyRect.fill()
    }

    /// Semantic colors are resolved at draw time, so a light/dark switch has to
    /// repaint. Matches `PaneFocusRingView`.
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}
