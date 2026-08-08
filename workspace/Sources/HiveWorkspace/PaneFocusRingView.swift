import AppKit
import WorkspaceCore

/// The active-pane indicator: a ring drawn around the pane that currently owns the keyboard. It is a *view*, deliberately, and it is added last so it sits above the pane's background. A CAShapeLayer added straight to `PaneView.layer` (what this replaces) is painted underneath the layers of the pane's own subviews — including the opaque `NSVisualEffectView` background — so it never appeared on screen at all. Drawing in `draw(_:)` with semantic `NSColor`s also means light/dark and the user's accent color come for free: AppKit resolves them against the view's effective appearance every time it redraws.
final class PaneFocusRingView: NSView {

    var indicator: PaneFocusIndicator = .none {
        didSet {
            guard indicator != oldValue else { return }
            needsDisplay = true
        }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        NotificationCenter.default.addObserver(
            self, selector: #selector(colorsChanged),
            name: NSColor.systemColorsDidChangeNotification, object: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override var isOpaque: Bool { false }

    @objc private func colorsChanged() {
        needsDisplay = true
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let stroke: NSColor
        let width: CGFloat
        switch indicator {
        case .none:
            return
        case .active:
            stroke = .keyboardFocusIndicatorColor
            width = PaneFocusRing.activeWidth
        case .inactive:
            stroke = .secondaryLabelColor
            width = PaneFocusRing.inactiveWidth
        }

        let inset = width / 2
        let path = NSBezierPath(
            roundedRect: bounds.insetBy(dx: inset, dy: inset),
            xRadius: PaneFocusRing.cornerRadius - inset,
            yRadius: PaneFocusRing.cornerRadius - inset)
        path.lineWidth = width
        stroke.setStroke()
        path.stroke()
    }
}

enum PaneFocusRing {
    static let cornerRadius: CGFloat = 10

    static var activeWidth: CGFloat {
        NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast ? 5 : 3
    }

    static var inactiveWidth: CGFloat { 2 }

    static func headerTint(for indicator: PaneFocusIndicator) -> NSColor {
        switch indicator {
        case .none: return .clear
        case .active: return NSColor.controlAccentColor.withAlphaComponent(0.28)
        case .inactive: return NSColor.secondaryLabelColor.withAlphaComponent(0.12)
        }
    }
}
