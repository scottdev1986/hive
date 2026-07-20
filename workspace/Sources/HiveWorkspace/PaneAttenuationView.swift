import AppKit
import WorkspaceCore

/// Focus by attenuation: the focused pane renders normally and every unfocused
/// pane is dimmed by a uniform semi-transparent overlay. Nothing is added to
/// the focused pane. This reads at any pane count and survives color-blindness
/// and grayscale, because it is a luminance difference rather than a hue one.
///
/// Like `PaneFocusRingView` and `PaneStatusBorderView` this must be a sibling
/// **view**, never a `CALayer` sublayer: AppKit paints a view's own layer and
/// its sublayers *beneath* the layers of that view's subviews, so a dimming
/// sublayer under the opaque pane background is not subtle — it is absent.
/// `C13PaneChromeTests` demonstrates that failure rather than asserting it.
///
/// It sits above the pane background but *below* the status border and focus
/// ring: attenuation is an aesthetic focus cue, while pane status is a
/// correctness signal that must stay legible on every pane at once.
final class PaneAttenuationView: NSView {

    /// Dim applied to an unfocused pane. The engine dims its own unfocused
    /// splits to 0.7 opacity; this is the same treatment expressed as the
    /// complementary overlay alpha, so Hive chrome and engine splits match.
    static let dimAlpha: CGFloat = 0.3

    var indicator: PaneFocusIndicator = .none {
        didSet {
            guard indicator != oldValue else { return }
            needsDisplay = true
        }
    }

    /// A pane is attenuated only when it is not the focused pane. `.inactive`
    /// still *is* the focused pane — the window merely is not key — so it is
    /// not dimmed; dimming it would claim focus had moved when it had not.
    var isAttenuated: Bool { indicator == .none }

    override var isOpaque: Bool { false }

    /// Chrome never takes a click away from the terminal underneath.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard isAttenuated else { return }
        NSColor.windowBackgroundColor.withAlphaComponent(Self.dimAlpha).setFill()
        dirtyRect.fill()
    }
}
