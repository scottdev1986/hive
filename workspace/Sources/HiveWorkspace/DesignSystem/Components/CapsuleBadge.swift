import AppKit

/// A capsule badge: SF Symbol + short copy on a tinted fill. The design
/// system's one way of naming a state (Off, Stale reading, Near limit…).
///
/// Styles never rely on color alone — every badge carries its symbol and its
/// words, so the states survive Increase Contrast and color-blindness.
final class CapsuleBadge: NSView {

    enum Style {
        /// Calm information (Paid overflow off, Provisional).
        case neutral
        /// Deliberate can't-measure information (the unmetered provider).
        case info
        /// Needs attention (Near limit, Stale reading, provider off).
        case warning
        /// Critically low / plan limit reached.
        case critical

        var fill: NSColor {
            switch self {
            case .neutral: return Theme.neutralBadgeFill
            case .info: return Theme.infoBadgeFill
            case .warning: return Theme.warningBadgeFill
            case .critical: return Theme.criticalBadgeFill
            }
        }

        var tint: NSColor {
            switch self {
            case .neutral: return .secondaryLabelColor
            case .info: return .systemBlue
            case .warning: return .systemOrange
            case .critical: return .systemRed
            }
        }
    }

    private let label = NSTextField(labelWithString: "")
    private let icon = NSImageView()
    private let style: Style

    init(text: String, symbol: String? = nil, style: Style) {
        self.style = style
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = Theme.Metric.badgeCornerRadius
        layer?.cornerCurve = .continuous

        translatesAutoresizingMaskIntoConstraints = false
        label.translatesAutoresizingMaskIntoConstraints = false
        icon.translatesAutoresizingMaskIntoConstraints = false

        label.font = Theme.Font.badge
        label.stringValue = text
        label.textColor = style.tint
        label.lineBreakMode = .byTruncatingTail
        label.setContentCompressionResistancePriority(.init(460), for: .horizontal)

        var views: [NSView] = []
        if let symbol, let image = NSImage(
            systemSymbolName: symbol, accessibilityDescription: nil) {
            icon.image = image.withSymbolConfiguration(
                .init(pointSize: 9.5, weight: .semibold))
            icon.contentTintColor = style.tint
            views.append(icon)
        }
        views.append(label)

        let stack = NSStackView(views: views)
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .horizontal
        stack.spacing = Theme.Space.xs
        stack.alignment = .centerY
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 7),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -7),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 3),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -3),
        ])

        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel(text)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func updateLayer() {
        layer?.backgroundColor = style.fill.cgColor
    }
}
