// ShellAttentionDrawerView.swift The right-side Attention drawer. It renders the shell's AttentionQueue in its own order — severity, then age — and it is honest when empty: an acknowledged queue is a visible state, not a vanished panel. Focusing an item never acknowledges it; acknowledgement is only the typed command.

import AppKit
import WorkspaceCore

final class ShellAttentionDrawerView: NSView {

    private let onClose: () -> Void
    private let itemsStack = NSStackView()
    private(set) var closeButton: NSButton!

    init(queue: AttentionQueue, onClose: @escaping () -> Void) {
        self.onClose = onClose
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let root = NSStackView()
        root.translatesAutoresizingMaskIntoConstraints = false
        root.orientation = .vertical
        root.alignment = .leading
        root.spacing = Theme.Space.m
        root.edgeInsets = NSEdgeInsets(
            top: Theme.Space.l, left: Theme.Space.l,
            bottom: Theme.Space.l, right: Theme.Space.l)
        addSubview(root)
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: leadingAnchor),
            root.trailingAnchor.constraint(equalTo: trailingAnchor),
            root.topAnchor.constraint(equalTo: topAnchor),
            root.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor),
        ])

        let heading = NSStackView()
        heading.orientation = .vertical
        heading.alignment = .leading
        heading.spacing = 2
        let micro = NSTextField(labelWithString: "SEVERITY, THEN AGE")
        micro.font = Theme.Font.sectionLabel
        micro.textColor = .tertiaryLabelColor
        let title = NSTextField(labelWithString: "Attention")
        title.font = Theme.Font.title
        heading.addArrangedSubview(micro)
        heading.addArrangedSubview(title)

        let close = NSButton(title: "×", target: nil, action: nil)
        close.bezelStyle = .rounded
        close.showsBorderOnlyWhileMouseInside = true
        close.isBordered = false
        close.font = Theme.Font.title
        close.setAccessibilityLabel("Close attention drawer")
        close.setAccessibilityIdentifier("shell-attention-close")
        close.setAccessibilityRole(.button)
        close.target = ShellButtonTarget.shared
        close.action = #selector(ShellButtonTarget.fire(_:))
        ShellButtonTarget.shared.register(close) { [weak self] in self?.onClose() }
        closeButton = close

        let header = NSStackView(views: [heading, close])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.distribution = .equalCentering
        root.addArrangedSubview(header)
        close.trailingAnchor.constraint(equalTo: header.trailingAnchor).isActive = true
        header.widthAnchor.constraint(
            equalTo: root.widthAnchor, constant: -Theme.Space.l * 2
        ).isActive = true

        root.addArrangedSubview(NSBox.hdsSeparator())

        itemsStack.orientation = .vertical
        itemsStack.alignment = .leading
        itemsStack.spacing = Theme.Space.s
        itemsStack.translatesAutoresizingMaskIntoConstraints = false
        root.addArrangedSubview(itemsStack)
        itemsStack.widthAnchor.constraint(equalTo: header.widthAnchor).isActive = true

        let ordered = queue.ordered
        if ordered.isEmpty {
            let empty = NSTextField(wrappingLabelWithString:
                "No attention items. The queue stays visible after every item "
                + "is explicitly cleared — empty is a real state, not a hidden one.")
            empty.font = Theme.Font.callout
            empty.textColor = .secondaryLabelColor
            empty.setAccessibilityIdentifier("shell-attention-empty")
            itemsStack.addArrangedSubview(empty)
        } else {
            for item in ordered {
                itemsStack.addArrangedSubview(Self.row(for: item))
            }
        }

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Attention drawer, \(ordered.count) items")
        setAccessibilityIdentifier("shell-attention-drawer")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private static func row(for item: AttentionItem) -> NSView {
        let symbol = NSImageView()
        symbol.translatesAutoresizingMaskIntoConstraints = false
        symbol.image = NSImage(
            systemSymbolName: Theme.severitySymbol(for: item.severity),
            accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 12, weight: .semibold))
        symbol.contentTintColor = Theme.severityColor(for: item.severity)

        let title = NSTextField(labelWithString: item.title)
        title.font = Theme.Font.headline
        title.compressHorizontally(priority: 470, toolTip: item.title)
        let detail = NSTextField(wrappingLabelWithString: item.detail)
        detail.font = Theme.Font.callout
        detail.textColor = .secondaryLabelColor
        let text = NSStackView(views: [title, detail])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 2

        let row = NSStackView(views: [symbol, text])
        row.orientation = .horizontal
        row.alignment = .top
        row.spacing = Theme.Space.s
        row.setAccessibilityElement(true)
        row.setAccessibilityRole(.group)
        row.setAccessibilityIdentifier("shell-attention-row")
        row.setAccessibilityLabel("\(item.title). \(item.detail)")
        return row
    }
}
