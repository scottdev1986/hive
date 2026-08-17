import AppKit

// PageHeaderView.swift
//
// Owns the title, supporting copy, and right-aligned actions at the top of a
// Workspace screen. Screens supply their controls; this view owns alignment.

final class PageHeaderView: NSView {

    let actionStack = NSStackView()

    init(title: String, subtitle: String? = nil, actions: [NSView] = []) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = Theme.Font.largeTitle
        titleLabel.textColor = Theme.primaryText
        titleLabel.compressHorizontally(priority: 460, toolTip: title)

        let copy = NSStackView(views: [titleLabel])
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = Theme.Space.xs
        if let subtitle, !subtitle.isEmpty {
            let subtitleLabel = NSTextField(wrappingLabelWithString: subtitle)
            subtitleLabel.font = Theme.Font.screenSubtitle
            subtitleLabel.textColor = Theme.secondaryText
            subtitleLabel.maximumNumberOfLines = 2
            subtitleLabel.compressHorizontally(priority: 430, toolTip: subtitle)
            copy.addArrangedSubview(subtitleLabel)
        }

        actionStack.orientation = .horizontal
        actionStack.alignment = .centerY
        actionStack.spacing = Theme.Space.s
        actions.forEach(actionStack.addArrangedSubview)
        actionStack.isHidden = actions.isEmpty

        let row = NSStackView(views: [copy, NSView.spacer(), actionStack])
        row.translatesAutoresizingMaskIntoConstraints = false
        row.orientation = .horizontal
        row.alignment = .top
        row.spacing = Theme.Space.m
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityIdentifier("hds-page-header")
        setAccessibilityLabel(title)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func addAction(_ view: NSView) {
        actionStack.addArrangedSubview(view)
        actionStack.isHidden = false
    }
}
