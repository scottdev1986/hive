import AppKit
import WorkspaceCore

/// One agent's typed events as the inspector draws them — category chips, a header per turn, a row per event — shared by the shell side panel and the Live Run rail so the two never describe the same history differently. Filter state belongs to the owner: the daemon's list is the same whichever chip is lit.
final class InspectorEventsListView: NSStackView {

    init(
        pane: InspectorEventsPane,
        filter: InspectorEventCategory?,
        onSelectFilter: @escaping (InspectorEventCategory?) -> Void
    ) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        orientation = .vertical
        alignment = .leading
        spacing = Theme.Space.s
        setAccessibilityIdentifier("shell-inspector-events")

        addArrangedSubview(Self.microLabel(pane.readFailed ? "Events · last observed" : "Events"))
        switch pane.events {
        case .absent(let reason):
            addArrangedSubview(Self.paragraph(reason, identifier: "shell-inspector-events-absent"))
        case .empty(let detail):
            addArrangedSubview(Self.paragraph(detail, identifier: "shell-inspector-events-empty"))
        case .present(let turns):
            let strip = Self.filterStrip(selected: filter, onSelect: onSelectFilter)
            addFullWidth(strip)
            if pane.readFailed {
                addArrangedSubview(Self.paragraph(
                    "The last events read failed; this list is the previous one, unchanged.",
                    identifier: "shell-inspector-events-retained"))
            }
            var drewRows = false
            for turn in turns {
                let rows = turn.rows.filter { filter == nil || $0.category == filter }
                guard !rows.isEmpty else { continue }
                drewRows = true
                addArrangedSubview(Self.turnHeader(turn))
                let card = CardView()
                card.contentStack.spacing = 0
                for (index, row) in rows.enumerated() {
                    card.contentStack.addArrangedSubview(Self.eventRow(
                        row, showsSeparator: index < rows.count - 1))
                }
                addFullWidth(card)
            }
            if !drewRows {
                addArrangedSubview(Self.paragraph(
                    "No \(filter?.title.lowercased() ?? "") events in this history.",
                    identifier: "shell-inspector-events-filtered-empty"))
            }
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func addFullWidth(_ view: NSView) {
        addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
    }

    /// The category chips reuse the tab strip's grammar — same font, same selected fill — so a lit chip reads like a lit tab rather than a second control vocabulary.
    private static func filterStrip(
        selected: InspectorEventCategory?,
        onSelect: @escaping (InspectorEventCategory?) -> Void
    ) -> NSView {
        let strip = NSStackView()
        strip.orientation = .horizontal
        strip.spacing = Theme.Space.xs
        strip.distribution = .fillEqually
        let choices: [(title: String, value: InspectorEventCategory?)] =
            [("All", nil)] + InspectorEventCategory.allCases.map { ($0.title, $0) }
        for choice in choices {
            let isSelected = choice.value == selected
            let button = NSButton(title: choice.title, target: nil, action: nil)
            button.setButtonType(.momentaryPushIn)
            button.isBordered = false
            button.font = Theme.Font.chromeControl
            button.contentTintColor = isSelected ? Theme.primaryText : Theme.secondaryText
            button.wantsLayer = true
            button.layer?.cornerRadius = Theme.Metric.buttonCornerRadius
            button.layer?.backgroundColor = isSelected
                ? Theme.insetFill.cgColor : NSColor.clear.cgColor
            let identifier = choice.value?.rawValue ?? "all"
            button.setAccessibilityIdentifier("shell-inspector-events-filter-\(identifier)")
            button.setAccessibilityLabel("Show \(choice.title.lowercased()) events")
            button.setAccessibilityRole(.button)
            button.setAccessibilityValue(isSelected ? "selected" : "unselected")
            let value = choice.value
            ShellButtonTarget.shared.register(button) { onSelect(value) }
            button.target = ShellButtonTarget.shared
            button.action = #selector(ShellButtonTarget.fire(_:))
            button.heightAnchor.constraint(
                greaterThanOrEqualToConstant: Theme.Metric.controlMinHeight).isActive = true
            strip.addArrangedSubview(button)
        }
        return strip
    }

    private static func turnHeader(_ turn: InspectorEventTurn) -> NSView {
        let label = NSTextField(labelWithString: turn.label.uppercased())
        label.font = Theme.Font.sectionLabel
        label.textColor = turn.wake ? Theme.accent : Theme.tertiaryText
        let time = NSTextField(labelWithString: InspectorEventProjection.clock(turn.occurredAt))
        time.font = Theme.Font.monoCaption
        time.textColor = Theme.tertiaryText
        let row = NSStackView(views: [label, time])
        row.orientation = .horizontal
        row.spacing = Theme.Space.s
        row.setAccessibilityIdentifier("shell-inspector-event-turn")
        row.setAccessibilityElement(true)
        row.setAccessibilityRole(.group)
        row.setAccessibilityLabel(
            "\(turn.label), \(turn.wake ? "started by a mail wake" : "started by a person")")
        return row
    }

    private static func eventRow(_ event: InspectorEventRow, showsSeparator: Bool) -> NSView {
        let time = NSTextField(labelWithString: InspectorEventProjection.clock(event.occurredAt))
        time.font = Theme.Font.monoCaption
        time.textColor = Theme.tertiaryText
        time.setContentHuggingPriority(.required, for: .horizontal)
        time.setContentCompressionResistancePriority(.required, for: .horizontal)
        let badge = CapsuleBadge(
            text: event.mark.word, symbol: event.mark.symbolName, style: badgeStyle(event.mark))
        let what = NSTextField(labelWithString: event.label
            + (event.subject.map { "  \($0)" } ?? ""))
        what.font = Theme.Font.callout
        what.textColor = Theme.primaryText
        what.compressHorizontally(priority: 470, toolTip: [event.label, event.subject]
            .compactMap { $0 }.joined(separator: " "))
        what.setContentHuggingPriority(.defaultLow, for: .horizontal)
        var columns: [NSView] = [time, badge, what]
        let detailText = [event.detail, event.shownInChat ? "shown in chat" : nil]
            .compactMap { $0 }.joined(separator: " · ")
        if !detailText.isEmpty {
            let detail = NSTextField(labelWithString: detailText)
            detail.font = Theme.Font.caption
            detail.textColor = Theme.secondaryText
            detail.compressHorizontally(priority: 460, toolTip: detailText)
            columns.append(detail)
        }
        let row = DataTableRowView(
            columns: columns, spacing: Theme.Space.s, showsSeparator: showsSeparator)
        row.setAccessibilityIdentifier("shell-inspector-event")
        row.setAccessibilityLabel(
            "\(event.mark.word): \(event.label)"
                + (event.subject.map { " \($0)" } ?? "")
                + (detailText.isEmpty ? "" : ", \(detailText)"))
        return row
    }

    private static func badgeStyle(_ mark: InspectorEventMark) -> CapsuleBadge.Style {
        switch mark {
        case .ok: return .positive
        case .failed: return .critical
        case .running, .mailIn, .mailOut, .mailReady: return .info
        case .status: return .neutral
        }
    }

    private static func microLabel(_ text: String) -> NSTextField {
        let field = NSTextField(labelWithString: text.uppercased())
        field.font = Theme.Font.sectionLabel
        field.textColor = Theme.tertiaryText
        return field
    }

    private static func paragraph(_ text: String, identifier: String) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = Theme.Font.callout
        field.textColor = Theme.secondaryText
        field.setAccessibilityIdentifier(identifier)
        return field
    }
}
