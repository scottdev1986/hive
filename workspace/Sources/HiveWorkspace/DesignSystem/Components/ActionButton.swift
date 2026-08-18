import AppKit

/// The shared Workspace action control. Style changes the claim a button makes;
/// target, action, and confirmation behavior stay with the screen that owns it.
final class ActionButton: NSButton {

    enum Style {
        case neutral
        case primary
        case warning
        case destructive
    }

    var style: Style {
        didSet {
            contentTintColor = foregroundColor
            needsDisplay = true
        }
    }

    private var tracking: NSTrackingArea?
    private var hovering = false

    init(
        title: String,
        symbol: String? = nil,
        style: Style = .neutral,
        target: AnyObject? = nil,
        action: Selector? = nil
    ) {
        self.style = style
        super.init(frame: .zero)
        self.title = title
        self.target = target
        self.action = action
        translatesAutoresizingMaskIntoConstraints = false
        isBordered = false
        bezelStyle = .inline
        font = Theme.Font.chromeControl
        contentTintColor = foregroundColor
        heightAnchor.constraint(
            greaterThanOrEqualToConstant: Theme.Metric.controlMinHeight).isActive = true
        heightAnchor.constraint(
            equalToConstant: Theme.Metric.chromeControlHeight).isActive = true

        if let symbol {
            // Sized off the button's own label token so the glyph and the
            // words stay in proportion when the ramp moves.
            image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
                .withSymbolConfiguration(
                    .init(pointSize: Theme.Font.chromeControl.pointSize, weight: .semibold))
            imagePosition = title.isEmpty ? .imageOnly : .imageLeading
        }

        setAccessibilityIdentifier("hds-action-button")
        if !title.isEmpty { setAccessibilityLabel(title) }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let tracking = NSTrackingArea(
            rect: bounds,
            options: [.activeInKeyWindow, .mouseEnteredAndExited],
            owner: self,
            userInfo: nil)
        addTrackingArea(tracking)
        self.tracking = tracking
    }

    override func mouseEntered(with event: NSEvent) {
        hovering = true
        needsDisplay = true
    }

    override func mouseExited(with event: NSEvent) {
        hovering = false
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(
            roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5),
            xRadius: Theme.Metric.buttonCornerRadius,
            yRadius: Theme.Metric.buttonCornerRadius)
        backgroundColor.setFill()
        path.fill()
        borderColor.setStroke()
        path.lineWidth = 1
        path.stroke()
        super.draw(dirtyRect)
    }

    private var foregroundColor: NSColor {
        switch style {
        case .neutral: return Theme.primaryText
        case .primary: return Theme.accentInk
        case .warning: return Theme.warning
        case .destructive: return Theme.critical
        }
    }

    private var backgroundColor: NSColor {
        if hovering, style == .neutral { return Theme.buttonHoverFill }
        switch style {
        case .neutral: return Theme.buttonFill
        case .primary: return Theme.accent
        case .warning: return Theme.warningSurface
        case .destructive: return Theme.criticalButtonFill
        }
    }

    private var borderColor: NSColor {
        if hovering, style == .neutral { return Theme.buttonHoverBorder }
        switch style {
        case .neutral: return Theme.buttonBorder
        case .primary: return .clear
        case .warning: return Theme.warningButtonBorder
        case .destructive: return Theme.criticalButtonBorder
        }
    }
}
