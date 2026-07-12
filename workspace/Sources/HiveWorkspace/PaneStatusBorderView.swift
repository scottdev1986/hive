import AppKit
import WorkspaceCore

/// A hit-test-transparent status overlay drawn above the pane background.
/// Like PaneFocusRingView, this must be a sibling view rather than a sublayer
/// of PaneView, whose opaque visual-effect subview would bury it.
final class PaneStatusBorderView: NSView {

    var statusAppearance = AgentActivity.unknown.appearance {
        didSet {
            guard statusAppearance != oldValue else { return }
            needsDisplay = true
        }
    }
    var subdued = false {
        didSet {
            guard subdued != oldValue else { return }
            needsDisplay = true
        }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        NotificationCenter.default.addObserver(
            self, selector: #selector(colorsChanged),
            name: NSColor.systemColorsDidChangeNotification, object: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var isOpaque: Bool { false }

    @objc private func colorsChanged() { needsDisplay = true }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let width: CGFloat = NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast ? 4 : 2
        let inset: CGFloat = 4
        let path = NSBezierPath(
            roundedRect: bounds.insetBy(dx: inset, dy: inset),
            xRadius: 10 - inset, yRadius: 10 - inset)
        path.lineWidth = width
        if statusAppearance.border == .dashed { path.setLineDash([6, 4], count: 2, phase: 0) }
        Theme.statusColor(for: statusAppearance.color, subdued: subdued).setStroke()
        path.stroke()
    }

    func startPulse() {
        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue = 1.0
        pulse.toValue = 0.25
        pulse.duration = StatusMotion.waitingPulseCycleSeconds / 2
        pulse.autoreverses = true
        pulse.repeatCount = Float(StatusMotion.waitingPulseCycles)
        pulse.isRemovedOnCompletion = true
        layer?.add(pulse, forKey: "waiting-pulse")
    }

    func stopPulse() {
        layer?.removeAnimation(forKey: "waiting-pulse")
    }
}
