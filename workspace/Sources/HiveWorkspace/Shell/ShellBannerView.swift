
import AppKit
import WorkspaceCore

final class ShellBannerView: NSView {

    init(banner: ShellBanner) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.cornerRadius = Theme.Metric.insetCornerRadius
        layer?.cornerCurve = .continuous

        let tint: NSColor
        let fill: NSColor
        let symbol: String
        switch banner.severity {
        case .info:
            tint = .systemBlue
            fill = Theme.infoBadgeFill
            symbol = "info.circle.fill"
        case .warning:
            tint = .systemOrange
            fill = Theme.warningBadgeFill
            symbol = "exclamationmark.triangle.fill"
        case .critical:
            tint = .systemRed
            fill = Theme.criticalBadgeFill
            symbol = "xmark.octagon.fill"
        }

        let icon = NSImageView()
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 12, weight: .semibold))
        icon.contentTintColor = tint

        let label = NSTextField(wrappingLabelWithString: banner.text)
        label.translatesAutoresizingMaskIntoConstraints = false
        label.font = Theme.Font.callout
        label.textColor = .labelColor
        label.compressHorizontally(priority: 460, toolTip: banner.text)

        addSubview(icon)
        addSubview(label)
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Theme.Space.m),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: Theme.Space.s),
            label.trailingAnchor.constraint(
                equalTo: trailingAnchor, constant: -Theme.Space.m),
            label.topAnchor.constraint(equalTo: topAnchor, constant: Theme.Space.s),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Theme.Space.s),
        ])

        layer?.backgroundColor = fill.cgColor
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(banner.text)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}
