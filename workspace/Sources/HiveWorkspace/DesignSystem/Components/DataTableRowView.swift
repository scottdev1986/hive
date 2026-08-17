import AppKit

// DataTableRowView.swift
//
// Provides the common density, alignment, and divider for a data-table row.
// Column sizing remains with the screen because each table carries different
// data, but every row gets the same vertical rhythm and separation.

final class DataTableRowView: NSView {

    let columnStack: NSStackView

    init(
        columns: [NSView],
        spacing: CGFloat = Theme.Space.m,
        showsSeparator: Bool = true
    ) {
        columnStack = NSStackView(views: columns)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        columnStack.translatesAutoresizingMaskIntoConstraints = false
        columnStack.orientation = .horizontal
        columnStack.alignment = .centerY
        columnStack.spacing = spacing
        addSubview(columnStack)
        var constraints = [
            columnStack.leadingAnchor.constraint(equalTo: leadingAnchor),
            columnStack.trailingAnchor.constraint(equalTo: trailingAnchor),
            columnStack.topAnchor.constraint(equalTo: topAnchor, constant: Theme.Space.s),
        ]
        if showsSeparator {
            let separator = NSBox.hdsSeparator()
            addSubview(separator)
            constraints += [
                columnStack.bottomAnchor.constraint(
                    equalTo: separator.topAnchor, constant: -Theme.Space.s),
                separator.leadingAnchor.constraint(equalTo: leadingAnchor),
                separator.trailingAnchor.constraint(equalTo: trailingAnchor),
                separator.bottomAnchor.constraint(equalTo: bottomAnchor),
            ]
        } else {
            constraints.append(columnStack.bottomAnchor.constraint(
                equalTo: bottomAnchor, constant: -Theme.Space.s))
        }
        NSLayoutConstraint.activate(constraints)

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityIdentifier("hds-data-row")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}
