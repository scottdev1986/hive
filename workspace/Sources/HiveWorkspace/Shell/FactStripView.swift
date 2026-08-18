import AppKit

// FactStripView.swift
//
// One horizontal fact strip for Queen Provider and Live Run. Each pair hugs
// its label and value; leftover width goes between pairs so proximity binds
// a label to its own reading. A per-screen delimiter or fill is applied by
// the caller, never by forking this layout.

final class FactStripView: NSView {
    let stack = NSStackView()

    init(pairs: [NSView], identifier: String) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .horizontal
        stack.alignment = .firstBaseline
        stack.spacing = Theme.Space.xl
        stack.distribution = .equalSpacing
        pairs.forEach(stack.addArrangedSubview)
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityIdentifier(identifier)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    static func pair(label: String, value: NSView, identifier: String? = nil) -> NSStackView {
        let name = NSTextField(labelWithString: label)
        name.font = Theme.Font.screenSubtitle
        name.textColor = Theme.secondaryText
        name.compressHorizontally(priority: 470, toolTip: label)
        name.setContentHuggingPriority(.required, for: .horizontal)
        value.setContentHuggingPriority(.required, for: .horizontal)
        let row = NSStackView(views: [name, value])
        row.orientation = .horizontal
        row.alignment = .firstBaseline
        row.spacing = Theme.Space.s
        row.setContentHuggingPriority(.required, for: .horizontal)
        if let identifier { row.setAccessibilityIdentifier(identifier) }
        return row
    }

    static func pair(label: String, value: String, identifier: String? = nil) -> NSStackView {
        let reading = NSTextField(wrappingLabelWithString: value)
        reading.font = Theme.Font.monoCaption
        reading.textColor = Theme.primaryText
        reading.maximumNumberOfLines = 2
        reading.compressHorizontally(priority: 460, toolTip: value)
        return pair(label: label, value: reading, identifier: identifier)
    }
}
