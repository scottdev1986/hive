// QueenProviderScreenView.swift The Queen Provider screen: which vendor runs the live Queen, and the one control that changes it. The vendor list is the projection's own, so a vendor that cannot launch here is offered and disabled with its reason rather than hidden — hiding it would read as "no such vendor". A refused swap rebuilds this view with the same selection still made and the competing revision named.

import AppKit
import WorkspaceCore

final class QueenProviderScreenView: NSView {

    private let editor: QueenProviderEditor
    private let onSelect: (ProviderID) -> Void
    private let onSwap: () -> Void

    init(
        screen: ShellScreenProjection,
        editor: QueenProviderEditor,
        onSelect: @escaping (ProviderID) -> Void,
        onSwap: @escaping () -> Void
    ) {
        self.editor = editor
        self.onSelect = onSelect
        self.onSwap = onSwap
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let stack = NSStackView(views: [
            PageHeaderView(
                title: "Queen Provider",
                subtitle: "Choose which vendor Hive uses for the live Queen. This setting is separate from worker routing."),
            Self.provenance(screen),
            currentQueenCard(),
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.m
        stack.translatesAutoresizingMaskIntoConstraints = false

        let vendorCards = editor.observed.vendorIDs.map(vendorCard)
        let options = NSGridView(views: [vendorCards])
        options.translatesAutoresizingMaskIntoConstraints = false
        options.columnSpacing = Theme.Space.m
        options.xPlacement = .fill
        options.yPlacement = .fill
        stack.addArrangedSubview(options)
        options.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        if let first = vendorCards.first {
            for card in vendorCards.dropFirst() {
                card.widthAnchor.constraint(equalTo: first.widthAnchor).isActive = true
            }
        }

        let confirmation = SectionCardView(
            title: "Set live Queen vendor",
            subtitle: selectionCopy(),
            trailingView: swapControl())
        let facts = observedFacts()
        if !facts.isEmpty {
            let factGrid = NSGridView(views: [facts.map { Self.factRow($0.label, $0.value) }])
            factGrid.translatesAutoresizingMaskIntoConstraints = false
            factGrid.columnSpacing = Theme.Space.l
            factGrid.xPlacement = .fill
            confirmation.contentStack.addArrangedSubview(factGrid)
            confirmation.pinToContentWidth(factGrid)
        }
        if let status = mutationStatus() {
            confirmation.contentStack.addArrangedSubview(status)
            confirmation.pinToContentWidth(status)
        }
        stack.addArrangedSubview(confirmation)
        confirmation.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Theme.Space.page),
            stack.trailingAnchor.constraint(
                equalTo: trailingAnchor, constant: -Theme.Space.page),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: Theme.Space.page),
            stack.bottomAnchor.constraint(
                lessThanOrEqualTo: bottomAnchor, constant: -Theme.Space.page),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func currentQueenCard() -> NSView {
        let card = CardView()
        let provider = editor.observed.liveProvider
        let mark: NSView = provider.map { ProviderMarkView(provider: $0) }
            ?? NSImageView(image: NSImage(
                systemSymbolName: "questionmark.circle", accessibilityDescription: nil)
                ?? NSImage())
        let title = NSTextField(labelWithString:
            provider.map { "\(ProviderBranding.title(for: $0)) · Queen" }
                ?? "No live Queen provider observed")
        title.font = Theme.Font.title
        title.textColor = Theme.primaryText
        let detail = NSTextField(labelWithString:
            "\(editor.observed.root.name) · \(editor.observed.root.instanceId) · \(editor.observed.healthDescription)")
        detail.font = Theme.Font.sectionMetadata
        detail.textColor = Theme.secondaryText
        detail.compressHorizontally()
        let copy = NSStackView(views: [title, detail])
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = Theme.Space.xs
        let health = CapsuleBadge(
            text: editor.observed.health?.label ?? "health unknown",
            symbol: editor.observed.contradicted
                ? "exclamationmark.triangle.fill" : "checkmark.circle.fill",
            style: editor.observed.contradicted ? .critical : .positive)
        let row = NSStackView(views: [mark, copy, NSView.spacer(), health])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = Theme.Space.m
        card.contentStack.addArrangedSubview(row)
        card.pinToContentWidth(row)
        card.setAccessibilityIdentifier("queen-provider-current")
        return card
    }

    /// When was this read, from which revision, and how fresh. The screen used
    /// to inherit these from the availability panel; they are the projection's
    /// own provenance, so they stay on the page after the panel left it.
    static func provenance(_ screen: ShellScreenProjection) -> NSView {
        let text = "Observed at \(screen.observedAt ?? "never") · "
            + "revision \(screen.source.revision ?? "unknown") · \(screen.freshness.rawValue)"
        let label = NSTextField(labelWithString: text)
        label.font = Theme.Font.chromeMetadata
        label.textColor = Theme.tertiaryText
        label.lineBreakMode = .byTruncatingTail
        label.compressHorizontally(priority: 440, toolTip: text)
        return label
    }

    private func observedFacts() -> [ShellScreenFact] {
        let vendorLabels = Set(editor.observed.vendorIDs.map { $0.rawValue })
        return editor.observed.facts.filter { !vendorLabels.contains($0.label) }
    }

    static func factRow(_ label: String, _ value: String) -> NSView {
        let name = NSTextField(labelWithString: label)
        name.font = Theme.Font.screenSubtitle
        name.textColor = Theme.secondaryText
        name.compressHorizontally(priority: 470, toolTip: label)
        name.widthAnchor.constraint(greaterThanOrEqualToConstant: 132).isActive = true
        let reading = NSTextField(wrappingLabelWithString: value)
        reading.font = Theme.Font.monoCaption
        reading.textColor = Theme.primaryText
        reading.maximumNumberOfLines = 2
        reading.compressHorizontally(priority: 460, toolTip: value)
        let row = NSStackView(views: [name, reading])
        row.orientation = .horizontal
        row.alignment = .firstBaseline
        row.spacing = Theme.Space.s
        return row
    }

    private func vendorCard(_ vendor: ProviderID) -> NSView {
        let available = editor.observed.vendors[vendor.rawValue]?.available == true
        let isSelected = selected == vendor
        let card = CardView()
        card.setAccessibilityIdentifier("queen-provider-card-\(vendor.rawValue)")
        card.dashed = !available
        let button = NSButton(
            radioButtonWithTitle: "", target: self,
            action: #selector(vendorPicked(_:)))
        button.state = isSelected ? .on : .off
        button.isEnabled = editor.mutationsAllowed && available
        button.identifier = NSUserInterfaceItemIdentifier(vendor.rawValue)
        button.setAccessibilityIdentifier("queen-provider-vendor-\(vendor.rawValue)")
        button.setAccessibilityLabel("Select \(ProviderBranding.title(for: vendor))")

        let mark = ProviderMarkView(provider: vendor)
        let title = NSTextField(labelWithString: ProviderBranding.title(for: vendor))
        title.font = Theme.Font.headline
        title.textColor = Theme.primaryText
        let vendorName = NSTextField(labelWithString: ProviderBranding.vendorName(for: vendor))
        vendorName.font = Theme.Font.sectionMetadata
        vendorName.textColor = Theme.secondaryText
        let badge = CapsuleBadge(
            text: available ? (isSelected ? "selected" : "available") : "unavailable",
            symbol: available ? "checkmark.circle.fill" : "xmark.circle.fill",
            style: available ? .positive : .warning)
        // The projection's own words for what this vendor can do here. A badge
        // alone would say "unavailable" without saying why, and why is the part
        // a reader can act on.
        let reason = NSTextField(wrappingLabelWithString:
            editor.observed.facts.first { $0.label == vendor.rawValue }?.value ?? "")
        reason.font = Theme.Font.caption
        reason.textColor = Theme.secondaryText
        reason.maximumNumberOfLines = 2
        reason.compressHorizontally(priority: 440)
        card.contentStack.addArrangedSubview(button)
        card.contentStack.addArrangedSubview(mark)
        card.contentStack.addArrangedSubview(title)
        card.contentStack.addArrangedSubview(vendorName)
        card.contentStack.addArrangedSubview(badge)
        card.contentStack.addArrangedSubview(reason)
        card.pinToContentWidth(reason)
        if isSelected {
            card.wantsLayer = true
            card.layer?.borderWidth = 2
            card.layer?.borderColor = Theme.accent.cgColor
            card.layer?.cornerRadius = Theme.Metric.cardCornerRadius
        }
        card.alphaValue = button.isEnabled || isSelected ? 1 : 0.72
        return card
    }

    private func swapControl() -> NSView {
        let button = ActionButton(
            title: "Set live Queen",
            symbol: "crown.fill",
            style: .primary,
            target: self,
            action: #selector(swapTapped(_:)))
        button.isEnabled = editor.body() != nil
        button.setAccessibilityIdentifier("queen-provider-swap")
        return button
    }

    private func selectionCopy() -> String {
        guard let selected else { return "No provider is selected." }
        if editor.hasDraft {
            return "\(ProviderBranding.title(for: selected)) is selected but has not been sent."
        }
        return "\(ProviderBranding.title(for: selected)) is the observed live provider."
    }

    private func mutationStatus() -> NSView? {
        var messages: [String] = []
        var style: CapsuleBadge.Style = .neutral
        var identifier = "queen-provider-idle"
        if let competing = editor.competingRevision {
            identifier = "queen-provider-conflict"
            style = .warning
            messages.append("Another change reached the Queen first (revision \(competing)). Nothing was launched or terminated, and your choice is kept below.")
        }
        switch editor.observed.change.state {
        case .pending:
            identifier = "queen-provider-pending"
            style = .info
            messages.append("A change was accepted and the requested provider has not been observed running yet.")
        case .failed:
            identifier = "queen-provider-failed"
            style = .critical
            messages.append(editor.observed.change.failure
                ?? "The last change failed. The prior provider was preserved.")
        case .idle:
            break
        case .unknown(let state):
            identifier = "queen-provider-unknown-state"
            style = .warning
            messages.append("The daemon reports a change state this build does not know: \(state). No claim is made about what is in flight.")
        }
        if editor.hasDraft {
            if messages.isEmpty {
                identifier = "queen-provider-draft"
                style = .info
            }
            messages.append("Unsent choice: \(selected?.rawValue ?? "none").")
        }
        if !editor.mutationsAllowed {
            if messages.isEmpty {
                identifier = "queen-provider-readonly"
                style = .warning
            }
            messages.append("This projection is not current, so no change can be sent. The vendors below are the last observed reading.")
        }
        guard !messages.isEmpty else { return nil }
        return status(identifier, messages.joined(separator: " "), style: style)
    }

    private var selected: ProviderID? {
        editor.draft ?? editor.observed.liveProvider
    }

    @objc private func vendorPicked(_ sender: NSButton) {
        guard let raw = sender.identifier?.rawValue else { return }
        onSelect(ProviderID(raw))
    }

    @objc private func swapTapped(_ sender: NSButton) {
        onSwap()
    }

    private func status(
        _ identifier: String,
        _ text: String,
        style: CapsuleBadge.Style
    ) -> NSView {
        let panel = InsetPanelView()
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = Theme.Font.callout
        label.textColor = style == .critical ? Theme.critical : Theme.secondaryText
        label.maximumNumberOfLines = 0
        label.setAccessibilityIdentifier(identifier)
        let badge = CapsuleBadge(
            text: style == .critical ? "failed" : style == .warning ? "attention" : "status",
            symbol: style == .critical
                ? "exclamationmark.circle.fill"
                : style == .warning ? "exclamationmark.triangle.fill" : "info.circle.fill",
            style: style)
        let row = NSStackView(views: [badge, label])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = Theme.Space.s
        panel.contentStack.addArrangedSubview(row)
        row.widthAnchor.constraint(equalTo: panel.contentStack.widthAnchor).isActive = true
        return panel
    }
}
