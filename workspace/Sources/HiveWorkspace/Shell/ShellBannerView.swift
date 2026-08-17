import AppKit
import WorkspaceCore

// ShellBannerView.swift
//
// Presents shell notices as the compact bordered strip used across screens.
// Severity changes tint and fill; the message remains the primary state label.

final class ShellBannerView: NSView {

    enum Presentation {
        case global
        case inline
    }

    private let presentation: Presentation
    private let fill: NSColor
    private let stroke: NSColor
    private let border: NSColor

    init(banner: ShellBanner, presentation: Presentation = .inline) {
        self.presentation = presentation
        switch banner.severity {
        case .info:
            fill = Theme.positiveSurface
            stroke = Theme.positive
            border = Theme.positiveBannerBorder
        case .warning:
            fill = Theme.warningSurface
            stroke = Theme.warning
            border = Theme.warningButtonBorder
        case .critical:
            fill = Theme.criticalSurface
            stroke = Theme.critical
            border = Theme.criticalBannerBorder
        }
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.cornerRadius = presentation == .inline ? Theme.Metric.insetCornerRadius : 0
        layer?.cornerCurve = .continuous
        layer?.borderWidth = presentation == .inline ? 1 : 0

        let label = NSTextField(wrappingLabelWithString: banner.text)
        label.translatesAutoresizingMaskIntoConstraints = false
        label.font = presentation == .global
            ? Theme.Font.chromeMetadata
            : Theme.Font.screenSubtitle
        label.textColor = stroke
        label.alignment = presentation == .global ? .center : .natural
        label.maximumNumberOfLines = presentation == .global ? 2 : 3
        label.compressHorizontally(priority: 450, toolTip: banner.text)
        addSubview(label)
        let horizontalInset: CGFloat = presentation == .global ? 9 : 11
        let verticalInset: CGFloat = presentation == .global ? 5 : 9
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: horizontalInset),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -horizontalInset),
            label.topAnchor.constraint(equalTo: topAnchor, constant: verticalInset),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -verticalInset),
        ])

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityIdentifier(
            presentation == .global ? "shell-banner-global" : "shell-banner-inline")
        setAccessibilityLabel(banner.text)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func updateLayer() {
        layer?.backgroundColor = fill.cgColor
        layer?.borderColor = border.cgColor
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard presentation == .global else { return }
        border.setStroke()
        let path = NSBezierPath()
        path.move(to: NSPoint(x: bounds.minX, y: bounds.minY + 0.5))
        path.line(to: NSPoint(x: bounds.maxX, y: bounds.minY + 0.5))
        path.lineWidth = 1
        path.stroke()
    }
}
