import AppKit

/// The pane's opaque content background. This must **not** be an `NSVisualEffectView`. Vibrancy is inherited by subviews and cannot be switched off by them; it is recommended only in leaf views and works best on grayscale content. Terminal output is full-color, arbitrary, and third-party, so the terminal surface must not descend from a vibrancy-enabled view. This view is what the surface descends from instead: a standard opaque content background, filled with a semantic color so light, dark, and accent changes resolve on every redraw.
final class PaneBackgroundView: NSView {

    override var isOpaque: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.controlBackgroundColor.setFill()
        dirtyRect.fill()
    }
}
