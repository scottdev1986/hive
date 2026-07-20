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

    /// The fill is a semantic color, so it re-resolves across light and dark on
    /// every redraw — that is what replaces the automatic material response
    /// `NSVisualEffectView` used to provide. No `viewDidChangeEffectiveAppearance`
    /// override is needed to schedule that redraw: AppKit's own implementation
    /// already invalidates the view. Mutation case
    /// `stop-repainting-on-appearance-change` demonstrated an explicit override
    /// here was dead code — neutering it changed nothing.
    override func draw(_ dirtyRect: NSRect) {
        NSColor.controlBackgroundColor.setFill()
        dirtyRect.fill()
    }
}
