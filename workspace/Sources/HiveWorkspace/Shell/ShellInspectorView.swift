// ShellInspectorView.swift
//
// Renders the daemon-owned Task, Events, and Session projection beside Live Run.
// Missing values stay explicit; this view never derives workflow state from terminal text.

import AppKit
import WorkspaceCore

final class ShellInspectorView: NSView {

    private let onClose: () -> Void
    private let onSelectTab: (ShellInspectorTab) -> Void
    private(set) var closeButton: NSButton!
    private let bodyStack = NSStackView()

    init(
        projection: InspectorProjection?,
        tab: ShellInspectorTab,
        onSelectTab: @escaping (ShellInspectorTab) -> Void,
        onClose: @escaping () -> Void
    ) {
        self.onClose = onClose
        self.onSelectTab = onSelectTab
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
            root.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        let heading = NSStackView()
        heading.orientation = .vertical
        heading.alignment = .leading
        heading.spacing = 2
        let micro = NSTextField(labelWithString: "RUN INSPECTOR")
        micro.font = Theme.Font.sectionLabel
        micro.textColor = Theme.tertiaryText
        let title = NSTextField(labelWithString: "Inspector")
        title.font = Theme.Font.title
        title.textColor = Theme.primaryText
        heading.addArrangedSubview(micro)
        heading.addArrangedSubview(title)

        let close = ActionButton(title: "", symbol: "xmark", style: .neutral)
        close.setAccessibilityLabel("Close inspector")
        close.setAccessibilityIdentifier("shell-inspector-close")
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

        root.addArrangedSubview(tabStrip(selected: tab))
        root.addArrangedSubview(NSBox.hdsSeparator())

        bodyStack.orientation = .vertical
        bodyStack.alignment = .leading
        bodyStack.spacing = Theme.Space.s
        bodyStack.translatesAutoresizingMaskIntoConstraints = false

        let document = ShellInspectorDocumentView()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(bodyStack)
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.documentView = document
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
        scroll.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        root.addArrangedSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.widthAnchor.constraint(equalTo: header.widthAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            bodyStack.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            bodyStack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            bodyStack.topAnchor.constraint(equalTo: document.topAnchor),
            bodyStack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
        ])

        renderBody(projection: projection, tab: tab)

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Run inspector, \(tab.title) tab")
        setAccessibilityIdentifier("shell-inspector")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func tabStrip(selected: ShellInspectorTab) -> NSView {
        let strip = NSStackView()
        strip.orientation = .horizontal
        strip.spacing = Theme.Space.xs
        strip.distribution = .fillEqually
        for tab in ShellInspectorTab.allCases {
            let button = NSButton(title: tab.title, target: nil, action: nil)
            button.setButtonType(.momentaryPushIn)
            button.isBordered = false
            button.font = Theme.Font.chromeControl
            button.contentTintColor = tab == selected
                ? Theme.primaryText : Theme.secondaryText
            button.wantsLayer = true
            button.layer?.cornerRadius = Theme.Metric.buttonCornerRadius
            button.layer?.backgroundColor = tab == selected
                ? Theme.insetFill.cgColor : NSColor.clear.cgColor
            button.setAccessibilityIdentifier("shell-inspector-tab-\(tab.rawValue)")
            button.setAccessibilityLabel("\(tab.title) inspector tab")
            button.setAccessibilityRole(.button)
            button.setAccessibilityValue(tab == selected ? "selected" : "unselected")
            ShellButtonTarget.shared.register(button) { [weak self] in
                self?.onSelectTab(tab)
            }
            button.target = ShellButtonTarget.shared
            button.action = #selector(ShellButtonTarget.fire(_:))
            button.heightAnchor.constraint(
                greaterThanOrEqualToConstant: Theme.Metric.controlMinHeight).isActive = true
            strip.addArrangedSubview(button)
        }
        return strip
    }

    private func renderBody(projection: InspectorProjection?, tab: ShellInspectorTab) {
        for view in bodyStack.arrangedSubviews {
            bodyStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        guard let projection else {
            bodyStack.addArrangedSubview(paragraph(
                "No inspector projection has been observed. "
                    + "Nothing is inferred from the terminal.",
                identifier: "shell-inspector-absent"))
            return
        }

        for banner in projection.banners {
            let view = ShellBannerView(banner: banner)
            bodyStack.addArrangedSubview(view)
            view.widthAnchor.constraint(equalTo: bodyStack.widthAnchor).isActive = true
        }

        let head = projection.pane(for: tab)
        bodyStack.addArrangedSubview(microLabel(head.microLabel))
        let title = NSTextField(wrappingLabelWithString: head.title)
        title.font = Theme.Font.headline
        title.textColor = Theme.primaryText
        title.setAccessibilityIdentifier("shell-inspector-title")
        bodyStack.addArrangedSubview(title)
        bodyStack.addArrangedSubview(paragraph(head.explanation, identifier: "shell-inspector-explanation"))

        switch tab {
        case .task:
            renderFacts(projection.task.facts)
            renderFactList(
                title: "Route inspections",
                state: projection.task.routeInspections,
                emptyId: "shell-inspector-routes-empty",
                absentId: "shell-inspector-routes-absent")
            renderCriteria(projection.task.criteria)
            renderFactList(
                title: "Run-control decisions",
                state: projection.task.runDecisions,
                emptyId: "shell-inspector-decisions-empty",
                absentId: "shell-inspector-decisions-absent")
            renderContracts(projection.task.declaredContracts)
            renderFactList(
                title: "Channel delivery",
                state: projection.task.channelDelivery,
                emptyId: "shell-inspector-channel-empty",
                absentId: "shell-inspector-channel-absent")
            renderFactList(
                title: "Stranded WorkManifest",
                state: projection.task.stranded,
                emptyId: "shell-inspector-stranded-empty",
                absentId: "shell-inspector-stranded-absent")
        case .events:
            renderEvents(projection.events.events)
        case .session:
            renderFacts(projection.session.facts)
        }
    }

    private func renderFacts(_ facts: [InspectorFact]) {
        guard !facts.isEmpty else { return }
        let card = CardView()
        card.contentStack.spacing = 0
        for (index, fact) in facts.enumerated() {
            card.contentStack.addArrangedSubview(factRow(
                fact, showsSeparator: index < facts.count - 1))
        }
        bodyStack.addArrangedSubview(card)
        card.widthAnchor.constraint(equalTo: bodyStack.widthAnchor).isActive = true
    }

    private func renderCriteria(_ state: InspectorListState<InspectorCriterion>) {
        let header = microLabel("Acceptance criteria")
        bodyStack.addArrangedSubview(header)
        switch state {
        case .absent(let reason):
            bodyStack.addArrangedSubview(paragraph(
                reason, identifier: "shell-inspector-criteria-absent"))
        case .empty(let detail):
            bodyStack.addArrangedSubview(paragraph(
                detail, identifier: "shell-inspector-criteria-empty"))
        case .present(let items):
            let card = CardView()
            for item in items {
                let mark: String
                if let complete = item.complete {
                    mark = complete ? "✓" : "○"
                } else {
                    mark = "?"
                }
                let row = NSTextField(wrappingLabelWithString:
                    "\(mark) \(item.summary) · \(item.id)")
                row.font = Theme.Font.callout
                row.textColor = Theme.primaryText
                row.setAccessibilityIdentifier("shell-inspector-criterion")
                card.contentStack.addArrangedSubview(row)
            }
            bodyStack.addArrangedSubview(card)
            card.widthAnchor.constraint(equalTo: bodyStack.widthAnchor).isActive = true
        }
    }

    private func renderContracts(_ state: InspectorListState<InspectorDeclaredContract>) {
        bodyStack.addArrangedSubview(microLabel("Declared contract participants"))
        switch state {
        case .absent(let reason):
            bodyStack.addArrangedSubview(paragraph(
                reason, identifier: "shell-inspector-contracts-absent"))
        case .empty(let detail):
            bodyStack.addArrangedSubview(paragraph(
                detail, identifier: "shell-inspector-contracts-empty"))
        case .present(let contracts):
            let card = CardView()
            for contract in contracts {
                let title = NSTextField(wrappingLabelWithString:
                    "\(contract.contractId) · r\(contract.revision)")
                title.font = Theme.Font.headline
                title.textColor = Theme.primaryText
                let participants = NSTextField(wrappingLabelWithString:
                    "acceptedBy (declared): "
                        + (contract.acceptedBy.isEmpty
                            ? "empty list"
                            : contract.acceptedBy.joined(separator: ", ")))
                participants.font = Theme.Font.callout
                participants.textColor = Theme.secondaryText
                participants.setAccessibilityIdentifier("shell-inspector-accepted-by")
                card.contentStack.addArrangedSubview(title)
                card.contentStack.addArrangedSubview(participants)
            }
            bodyStack.addArrangedSubview(card)
            card.widthAnchor.constraint(equalTo: bodyStack.widthAnchor).isActive = true
        }
    }

    private func renderFactList(
        title: String,
        state: InspectorListState<InspectorFact>,
        emptyId: String,
        absentId: String
    ) {
        bodyStack.addArrangedSubview(microLabel(title))
        switch state {
        case .absent(let reason):
            bodyStack.addArrangedSubview(paragraph(reason, identifier: absentId))
        case .empty(let detail):
            bodyStack.addArrangedSubview(paragraph(detail, identifier: emptyId))
        case .present(let facts):
            renderFacts(facts)
        }
    }

    private func renderEvents(_ state: InspectorListState<InspectorEventRow>) {
        switch state {
        case .absent(let reason):
            bodyStack.addArrangedSubview(paragraph(
                reason, identifier: "shell-inspector-events-absent"))
        case .empty(let detail):
            bodyStack.addArrangedSubview(paragraph(
                detail, identifier: "shell-inspector-events-empty"))
        case .present(let rows):
            let card = CardView()
            for row in rows {
                let label = NSTextField(wrappingLabelWithString:
                    "\(row.occurredAt)  \(row.kind)  ·  \(row.summary)")
                label.font = Theme.Font.monoCaption
                label.textColor = Theme.primaryText
                label.setAccessibilityIdentifier("shell-inspector-event")
                card.contentStack.addArrangedSubview(label)
            }
            bodyStack.addArrangedSubview(card)
            card.widthAnchor.constraint(equalTo: bodyStack.widthAnchor).isActive = true
        }
    }

    private func factRow(
        _ fact: InspectorFact,
        showsSeparator: Bool
    ) -> NSView {
        let label = NSTextField(labelWithString: fact.label)
        label.font = Theme.Font.callout
        label.textColor = Theme.secondaryText
        label.compressHorizontally(priority: 470, toolTip: fact.label)
        label.widthAnchor.constraint(equalToConstant: Theme.Space.page * 3).isActive = true
        let value = NSTextField(wrappingLabelWithString: fact.value)
        value.font = Theme.Font.monoBody
        value.textColor = Theme.primaryText
        value.compressHorizontally(priority: 460, toolTip: fact.value)
        value.setAccessibilityIdentifier("shell-inspector-fact")
        let row = DataTableRowView(
            columns: [label, value],
            spacing: Theme.Space.s,
            showsSeparator: showsSeparator)
        value.setContentHuggingPriority(.defaultLow, for: .horizontal)
        row.setAccessibilityElement(true)
        row.setAccessibilityRole(.group)
        row.setAccessibilityLabel("\(fact.label): \(fact.value)")
        return row
    }

    private func microLabel(_ text: String) -> NSTextField {
        let field = NSTextField(labelWithString: text.uppercased())
        field.font = Theme.Font.sectionLabel
        field.textColor = Theme.tertiaryText
        return field
    }

    private func paragraph(_ text: String, identifier: String) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = Theme.Font.callout
        field.textColor = Theme.secondaryText
        field.setAccessibilityIdentifier(identifier)
        return field
    }
}

private final class ShellInspectorDocumentView: NSView {
    override var isFlipped: Bool { true }
}
