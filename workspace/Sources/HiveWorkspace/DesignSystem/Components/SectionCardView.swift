import AppKit

// SectionCardView.swift
//
// Adds the standard section heading and optional trailing control to CardView.
// Screen content continues in the inherited content stack below the divider.

final class SectionCardView: CardView {

    init(title: String, subtitle: String? = nil, trailingView: NSView? = nil) {
        super.init()

        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = Theme.Font.sectionTitle
        titleLabel.textColor = Theme.primaryText
        titleLabel.compressHorizontally(priority: 460, toolTip: title)

        let copy = NSStackView(views: [titleLabel])
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = 2
        if let subtitle, !subtitle.isEmpty {
            let subtitleLabel = NSTextField(labelWithString: subtitle)
            subtitleLabel.font = Theme.Font.sectionMetadata
            subtitleLabel.textColor = Theme.tertiaryText
            subtitleLabel.compressHorizontally(priority: 440, toolTip: subtitle)
            copy.addArrangedSubview(subtitleLabel)
        }

        let header = NSStackView(views: [copy, NSView.spacer()])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = Theme.Space.s
        if let trailingView { header.addArrangedSubview(trailingView) }
        contentStack.addArrangedSubview(header)
        pinToContentWidth(header)

        let separator = NSBox.hdsSeparator()
        contentStack.addArrangedSubview(separator)
        pinToContentWidth(separator)

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityIdentifier("hds-section-card")
        setAccessibilityLabel(title)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}
