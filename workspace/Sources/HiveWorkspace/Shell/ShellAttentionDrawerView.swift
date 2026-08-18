// ShellAttentionDrawerView.swift
//
// Renders the shell's AttentionQueue in severity-then-age order. Empty is a
// visible state, and focusing an item never acknowledges it.

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
        Theme.paint(self, Theme.cardFill)

        let root = NSStackView()
        root.translatesAutoresizingMaskIntoConstraints = false
        root.orientation = .vertical
        root.alignment = .leading
        root.spacing = Theme.Space.s
        root.edgeInsets = NSEdgeInsets(
            top: Theme.Metric.cardInset, left: Theme.Metric.cardInset,
            bottom: Theme.Metric.cardInset, right: Theme.Metric.cardInset)
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
        micro.textColor = Theme.tertiaryText
        let title = NSTextField(labelWithString: "Attention")
        title.font = Theme.Font.title
        title.textColor = Theme.primaryText
        heading.addArrangedSubview(micro)
        heading.addArrangedSubview(title)

        let close = ActionButton(title: "", symbol: "xmark", style: .neutral)
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
            equalTo: root.widthAnchor, constant: -Theme.Metric.cardInset * 2
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
            empty.textColor = Theme.secondaryText
            empty.setAccessibilityIdentifier("shell-attention-empty")
            let panel = InsetPanelView()
            panel.contentStack.addArrangedSubview(empty)
            panel.contentStack.alignment = .leading
            panel.contentStack.spacing = Theme.Space.s
            itemsStack.addArrangedSubview(panel)
            panel.widthAnchor.constraint(equalTo: itemsStack.widthAnchor).isActive = true
        } else {
            for item in ordered {
                let row = Self.row(for: item)
                itemsStack.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: itemsStack.widthAnchor).isActive = true
            }
        }

        let note = NSTextField(wrappingLabelWithString:
            "Focusing never acknowledges. Items leave Attention only after their typed resolution.")
        note.font = Theme.Font.callout
        note.textColor = Theme.secondaryText
        let notePanel = InsetPanelView()
        notePanel.contentStack.addArrangedSubview(note)
        itemsStack.addArrangedSubview(notePanel)
        notePanel.widthAnchor.constraint(equalTo: itemsStack.widthAnchor).isActive = true

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
            .withSymbolConfiguration(.init(
                pointSize: Theme.Metric.chainMarkSize, weight: .semibold))
        symbol.contentTintColor = Theme.severityColor(for: item.severity)
        symbol.widthAnchor.constraint(
            equalToConstant: Theme.Metric.chainMarkSize).isActive = true
        symbol.heightAnchor.constraint(
            equalToConstant: Theme.Metric.chainMarkSize).isActive = true

        let title = NSTextField(labelWithString: item.title)
        title.font = Theme.Font.headline
        title.textColor = Theme.primaryText
        title.compressHorizontally(priority: 470, toolTip: item.title)
        let detail = NSTextField(wrappingLabelWithString: item.detail)
        detail.font = Theme.Font.callout
        detail.textColor = Theme.secondaryText
        let text = NSStackView(views: [title, detail])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 2

        let row = NSStackView(views: [symbol, text])
        row.orientation = .horizontal
        row.alignment = .top
        row.spacing = Theme.Space.s
        let card = CardView()
        card.contentStack.addArrangedSubview(row)
        card.pinToContentWidth(row)
        card.setAccessibilityElement(true)
        card.setAccessibilityRole(.group)
        card.setAccessibilityIdentifier("shell-attention-row")
        card.setAccessibilityLabel("\(item.title). \(item.detail)")
        return card
    }
}
