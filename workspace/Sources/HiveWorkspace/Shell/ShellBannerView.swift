import AppKit
import WorkspaceCore

// ShellBannerView.swift
//
// Presents shell notices as the compact bordered strip used across screens.
// Severity changes tint and fill; the message remains the primary state label.

final class ShellBannerView: NSView {

    private let fill: NSColor
    private let stroke: NSColor

    init(banner: ShellBanner) {
        switch banner.severity {
        case .info:
            fill = Theme.infoBadgeFill
            stroke = Theme.accent
        case .warning:
            fill = Theme.warningBadgeFill
            stroke = Theme.warning
        case .critical:
            fill = Theme.criticalBadgeFill
            stroke = Theme.critical
        }
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.cornerRadius = Theme.Metric.insetCornerRadius
        layer?.cornerCurve = .continuous
        layer?.borderWidth = 1

        let label = NSTextField(wrappingLabelWithString: banner.text)
        label.translatesAutoresizingMaskIntoConstraints = false
        label.font = Theme.Font.callout
        label.textColor = stroke
        label.maximumNumberOfLines = 3
        label.compressHorizontally(priority: 450, toolTip: banner.text)
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Theme.Space.m),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Theme.Space.m),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
        ])

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityIdentifier("shell-banner")
        setAccessibilityLabel(banner.text)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func updateLayer() {
        layer?.backgroundColor = fill.cgColor
        layer?.borderColor = stroke.withAlphaComponent(0.55).cgColor
    }
}
