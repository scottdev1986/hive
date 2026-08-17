// TaskRouterScreenView.swift
//
// The Task Router screen: every catalogued category as a dense route card,
// with the selected category's draft in editable controls. The draft is
// state this view renders, never state it owns — a rejected apply rebuilds
// this view with the same draft and the daemon's competing revision named
// on screen. A category with no route offers no membership: choosing a mode
// is what creates one, so the editor cannot invent a router mode the user
// never picked.
//
// Visual language comes from the design-system tokens and primitives.
// Expected share, refusal, and balance stay inspection facts when the
// projection supplied them; they are never computed here. Policy V3
// compare-and-set review is named as unavailable rather than mocked.

import AppKit
import WorkspaceCore

final class TaskRouterScreenView: NSView {

    private static let unconfiguredMode = "Unconfigured — no route"

    private let editor: TaskRouterEditor
    private let categories: [TaskCategory]
    private let category: TaskCategory
    private let routing: WorkspaceRoutingPresentation
    private let screen: ShellScreenProjection
    private let rows: [TaskRouterRow]
    private let onSelectCategory: (TaskCategory) -> Void
    private let onEditRoute: (RoutingPolicyDocument.WireRoute?) -> Void
    private let onApply: () -> Void
    /// Live handles for the one refusal this view raises itself. A rejected weight changes no state, so nothing re-renders and these must be the views already on screen.
    private let weightRefusal = NSTextField(wrappingLabelWithString: "")
    private weak var applyButton: NSButton?

    init(
        screen: ShellScreenProjection,
        editor: TaskRouterEditor,
        categories: [TaskCategory],
        category: TaskCategory,
        routing: WorkspaceRoutingPresentation,
        onSelectCategory: @escaping (TaskCategory) -> Void,
        onEditRoute: @escaping (RoutingPolicyDocument.WireRoute?) -> Void,
        onApply: @escaping () -> Void
    ) {
        self.editor = editor
        self.categories = categories
        self.category = category
        self.routing = routing
        self.screen = screen
        rows = editor.rows(for: category, catalog: routing.catalog)
        self.onSelectCategory = onSelectCategory
        self.onEditRoute = onEditRoute
        self.onApply = onApply
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.m
        stack.translatesAutoresizingMaskIntoConstraints = false

        let apply = applyControl()
        let header = PageHeaderView(
            title: "Task Router",
            subtitle: "Every catalogued task category. Edit the selected route. "
                + "Inspection shares appear only when the daemon supplied them.",
            actions: [apply])
        stack.addArrangedSubview(header)
        header.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        stack.addArrangedSubview(availabilityRow())
        if let banner = screen.banner {
            let bannerView = ShellBannerView(banner: banner, presentation: .inline)
            stack.addArrangedSubview(bannerView)
            bannerView.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        let v3Gap = ShellBannerView(
            banner: ShellBanner(
                severity: .warning,
                text: "Policy V3 compare-and-set review is not in this projection. "
                    + "Apply route still sends the current set-route mutation. "
                    + "Do not read this screen as a V3 review."),
            presentation: .inline)
        stack.addArrangedSubview(v3Gap)
        v3Gap.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        v3Gap.setAccessibilityIdentifier("task-router-v3-gap")

        for status in statusLabels() { stack.addArrangedSubview(status) }
        weightRefusal.font = Theme.Font.callout
        weightRefusal.textColor = Theme.warning
        weightRefusal.maximumNumberOfLines = 0
        weightRefusal.isHidden = true
        weightRefusal.setAccessibilityIdentifier("task-router-weight-refusal")
        stack.addArrangedSubview(weightRefusal)

        let summary = summaryRow()
        stack.addArrangedSubview(summary)
        summary.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        let routes = routesCard()
        stack.addArrangedSubview(routes)
        routes.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        let editorCard = selectedRouteCard()
        stack.addArrangedSubview(editorCard)
        editorCard.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        let observed = observedInspectionCard()
        stack.addArrangedSubview(observed)
        observed.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

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

    private func availabilityRow() -> NSView {
        let badge = CapsuleBadge(
            text: screen.stateHeadline,
            symbol: availabilitySymbol,
            style: availabilityStyle)
        let explanation = NSTextField(wrappingLabelWithString: screen.stateExplanation)
        explanation.font = Theme.Font.screenSubtitle
        explanation.textColor = Theme.secondaryText
        explanation.maximumNumberOfLines = 2
        explanation.compressHorizontally(priority: 430, toolTip: screen.stateExplanation)

        var views: [NSView] = [badge, explanation, NSView.spacer()]
        if let observedAt = screen.observedAt {
            let observed = NSTextField(labelWithString: "Observed at \(observedAt)")
            observed.font = Theme.Font.monoCaption
            observed.textColor = Theme.tertiaryText
            observed.compressHorizontally(priority: 460, toolTip: observedAt)
            views.insert(observed, at: 2)
        }
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = Theme.Space.s
        return row
    }

    private var availabilityStyle: CapsuleBadge.Style {
        switch screen.availability {
        case .current: return .positive
        case .unknown, .stale, .replaced: return .info
        case .disconnected, .conflicting: return .warning
        case .unauthorized: return .critical
        }
    }

    private var availabilitySymbol: String {
        switch screen.availability {
        case .current: return "checkmark.circle.fill"
        case .unknown: return "questionmark.circle.fill"
        case .stale: return "clock.fill"
        case .disconnected: return "bolt.horizontal.circle.fill"
        case .unauthorized: return "lock.fill"
        case .conflicting: return "arrow.triangle.branch"
        case .replaced: return "arrow.uturn.right.circle.fill"
        }
    }

    private func summaryRow() -> NSView {
        let configured = categories.filter {
            editor.draft.policy.categories[$0.rawValue] != nil
        }.count
        let enabledProviders = routing.providers.values.filter {
            $0.state == "enabled"
        }.count
        let enabledModels = routing.models.filter { $0.rendered == .enabled }.count
        let range = routing.weightRange

        let providerFact = routing.providers.isEmpty
            ? "providers unknown"
            : "\(enabledProviders) / \(routing.providers.count) providers enabled"
        let modelFact = routing.models.isEmpty
            ? "enabled models unknown"
            : "\(enabledModels) enabled models"
        let line = "\(configured) / \(categories.count) routes  ·  \(providerFact)  ·  "
            + "\(modelFact)  ·  weights \(range.minimum)–\(range.maximum)  ·  "
            + "V3 review unavailable"
        let panel = InsetPanelView()
        let label = NSTextField(wrappingLabelWithString: line)
        label.font = Theme.Font.monoCaption
        label.textColor = Theme.secondaryText
        label.maximumNumberOfLines = 2
        label.compressHorizontally(priority: 430, toolTip: line)
        panel.contentStack.addArrangedSubview(label)
        label.widthAnchor.constraint(equalTo: panel.contentStack.widthAnchor).isActive = true
        return panel
    }

    private func routesCard() -> SectionCardView {
        let card = SectionCardView(
            title: "All task categories",
            subtitle: "\(categories.count) catalogued · select one to edit")
        for (index, item) in categories.enumerated() {
            let route = editor.draft.policy.categories[item.rawValue]
            let modeLabel = route.flatMap { routing.mode($0.mode)?.label }
                ?? (route == nil ? Self.unconfiguredMode : route!.mode)
            let members = route?.candidates.count ?? 0
            let selected = item == category

            let name = NSTextField(labelWithString: item.label)
            name.font = Theme.Font.headline
            name.textColor = Theme.primaryText
            name.compressHorizontally(priority: 460, toolTip: item.label)
            let slug = NSTextField(labelWithString: item.rawValue)
            slug.font = Theme.Font.monoCaption
            slug.textColor = Theme.tertiaryText
            slug.compressHorizontally(priority: 440, toolTip: item.rawValue)
            let title = NSStackView(views: [name, slug])
            title.orientation = .vertical
            title.alignment = .leading
            title.spacing = 1

            let mode = NSTextField(labelWithString: modeLabel)
            mode.font = Theme.Font.badge
            mode.textColor = route == nil
                ? Theme.tertiaryText
                : (selected ? Theme.accent : Theme.positive)
            mode.compressHorizontally(priority: 450, toolTip: modeLabel)
            mode.setContentHuggingPriority(.required, for: .horizontal)
            let count = NSTextField(labelWithString: "\(members) candidates")
            count.font = Theme.Font.monoCaption
            count.textColor = Theme.secondaryText
            count.alignment = .right
            count.setContentHuggingPriority(.required, for: .horizontal)
            count.widthAnchor.constraint(equalToConstant: 96).isActive = true

            let select = NSButton(
                title: selected ? "Editing" : "Edit",
                target: self,
                action: #selector(categoryRowTapped(_:)))
            select.bezelStyle = .inline
            select.isBordered = false
            select.font = Theme.Font.chromeControl
            select.contentTintColor = selected ? Theme.accent : Theme.secondaryText
            select.tag = index
            select.setAccessibilityIdentifier("task-router-category-row-\(item.rawValue)")
            select.setAccessibilityLabel("\(selected ? "Editing" : "Edit") \(item.label)")
            select.setContentHuggingPriority(.required, for: .horizontal)

            let row = DataTableRowView(
                columns: [title, NSView.spacer(), mode, count, select],
                showsSeparator: index + 1 < categories.count)
            title.widthAnchor.constraint(greaterThanOrEqualToConstant: 140).isActive = true
            card.contentStack.addArrangedSubview(row)
            card.pinToContentWidth(row)
        }
        return card
    }

    private func selectedRouteCard() -> SectionCardView {
        let memberCount = draftRoute?.candidates.count ?? 0
        let card = SectionCardView(
            title: category.label,
            subtitle: "\(category.rawValue) · \(memberCount) current candidates")
        let controls = NSStackView(views: [categoryControl(), modeControl()])
        controls.orientation = .horizontal
        controls.alignment = .centerY
        controls.spacing = Theme.Space.l
        card.contentStack.addArrangedSubview(controls)
        card.pinToContentWidth(controls)

        let head = DataTableRowView(
            columns: [
                columnHead("Route"),
                columnHead("Vendor"),
                columnHead("Exact model"),
                columnHead("Effort"),
                columnHead("Stored weight"),
                columnHead("Inspection"),
            ],
            spacing: Theme.Space.s)
        card.contentStack.addArrangedSubview(head)
        card.pinToContentWidth(head)

        for (index, row) in rows.enumerated() {
            let view = membershipRow(row, index: index)
            card.contentStack.addArrangedSubview(view)
            card.pinToContentWidth(view)
        }
        if rows.isEmpty {
            let empty = NSTextField(
                wrappingLabelWithString: "No catalog or policy models to offer on this route.")
            empty.font = Theme.Font.callout
            empty.textColor = Theme.secondaryText
            empty.maximumNumberOfLines = 0
            card.contentStack.addArrangedSubview(empty)
            card.pinToContentWidth(empty)
        }
        return card
    }

    private func columnHead(_ text: String) -> NSView {
        let label = NSTextField(labelWithString: text)
        label.font = Theme.Font.sectionLabel
        label.textColor = Theme.tertiaryText
        label.compressHorizontally(priority: 450, toolTip: text)
        return label
    }

    private func observedInspectionCard() -> SectionCardView {
        let subtitle = screen.facts.isEmpty
            ? "No routing-inspection facts on this projection"
            : "Daemon-supplied facts, not client-computed shares"
        let card = SectionCardView(title: "Observed inspection", subtitle: subtitle)
        if screen.facts.isEmpty {
            let empty = NSTextField(
                wrappingLabelWithString: "Routing inspection unavailable.")
            empty.font = Theme.Font.callout
            empty.textColor = Theme.secondaryText
            card.contentStack.addArrangedSubview(empty)
            card.pinToContentWidth(empty)
            return card
        }
        for (index, fact) in screen.facts.enumerated() {
            let label = NSTextField(labelWithString: fact.label)
            label.font = Theme.Font.callout
            label.textColor = Theme.secondaryText
            label.compressHorizontally(priority: 470, toolTip: fact.label)
            label.setContentHuggingPriority(.defaultHigh, for: .horizontal)
            let value = NSTextField(wrappingLabelWithString: fact.value)
            value.font = Theme.Font.monoCaption
            value.textColor = Theme.primaryText
            value.maximumNumberOfLines = 0
            value.compressHorizontally(priority: 460, toolTip: fact.value)
            let row = DataTableRowView(
                columns: [label, value],
                showsSeparator: index + 1 < screen.facts.count)
            label.widthAnchor.constraint(equalToConstant: 120).isActive = true
            card.contentStack.addArrangedSubview(row)
            card.pinToContentWidth(row)
        }
        return card
    }

    private func categoryControl() -> NSView {
        let popup = NSPopUpButton()
        popup.addItems(withTitles: categories.map(\.label))
        popup.selectItem(at: categories.firstIndex(of: category) ?? 0)
        popup.setAccessibilityIdentifier("task-router-category")
        popup.setAccessibilityLabel("Task category")
        popup.target = self
        popup.action = #selector(categoryChanged(_:))
        return labelled("Category", popup)
    }

    private func modeControl() -> NSView {
        let popup = NSPopUpButton()
        popup.addItems(withTitles: [Self.unconfiguredMode] + routing.modes.map(\.label))
        if let mode = draftRoute.flatMap({ routing.mode($0.mode) }),
           let index = routing.modes.firstIndex(of: mode) {
            popup.selectItem(at: index + 1)
        } else {
            popup.selectItem(at: 0)
        }
        popup.isEnabled = editor.mutationsAllowed && (draftRoute?.writable ?? true)
        popup.setAccessibilityIdentifier("task-router-mode")
        popup.setAccessibilityLabel("Router mode")
        popup.target = self
        popup.action = #selector(modeChanged(_:))
        return labelled("Mode", popup)
    }

    private func membershipRow(
        _ row: TaskRouterRow,
        index: Int
    ) -> NSView {
        let key = "\(row.provider)/\(row.model)"
        let member = NSButton(checkboxWithTitle: "", target: self,
                              action: #selector(memberToggled(_:)))
        member.state = row.isMember ? .on : .off
        member.tag = index
        let isInCatalog = routing.catalog.contains {
            $0.provider == row.provider && $0.model == row.model
        }
        member.isEnabled = editor.mutationsAllowed && draftRoute != nil
            && (row.isMember || isInCatalog)
        member.setAccessibilityIdentifier("task-router-member-\(key)")
        member.setAccessibilityLabel("Member \(key)")

        let mark = ProviderMarkView(
            provider: ProviderID(row.provider),
            size: Theme.Metric.chainMarkSize)
        let vendor = NSTextField(labelWithString: ProviderBranding.title(for: ProviderID(row.provider)))
        vendor.font = Theme.Font.headline
        vendor.textColor = Theme.primaryText
        vendor.compressHorizontally(priority: 450, toolTip: row.provider)
        let vendorStack = NSStackView(views: [mark, vendor])
        vendorStack.orientation = .horizontal
        vendorStack.alignment = .centerY
        vendorStack.spacing = Theme.Space.xs

        let model = NSTextField(labelWithString: row.model)
        model.font = Theme.Font.monoBody
        model.textColor = Theme.primaryText
        model.compressHorizontally(priority: 440, toolTip: row.model)

        let weightEditable = draftRoute
            .flatMap { routing.mode($0.mode) }?.weightEditable ?? false
        let weight = NSTextField(string: row.candidate.map { String($0.weight) } ?? "")
        weight.placeholderString = "weight"
        weight.font = Theme.Font.monoBody
        weight.alignment = .right
        weight.tag = index
        weight.isEnabled = editor.mutationsAllowed && row.isMember && weightEditable
        weight.isHidden = !weightEditable
        weight.target = self
        weight.action = #selector(weightChanged(_:))
        weight.setAccessibilityIdentifier("task-router-weight-\(key)")
        weight.setAccessibilityLabel("Weight for \(key)")
        weight.widthAnchor.constraint(equalToConstant: 64).isActive = true

        let effort = NSPopUpButton()
        let catalogEntry = routing.catalog.first {
            $0.provider == row.provider && $0.model == row.model
        }
        let options = catalogEntry?.effortOptions ?? []
        effort.addItems(withTitles: options.map(\.label))
        let selectedOption = row.candidate.flatMap { candidate in
            options.firstIndex { $0.effort == candidate.effort }
        }
        if let selectedOption {
            effort.selectItem(at: selectedOption)
        } else if let current = row.candidate?.effort.asWireEffort.cliArgument {
            effort.addItem(withTitle: current)
            effort.selectItem(at: options.count)
        }
        effort.tag = index
        // An effort this build cannot name must not be respelled by a control.
        effort.isEnabled = editor.mutationsAllowed && row.isMember
            && selectedOption != nil
        effort.target = self
        effort.action = #selector(effortChanged(_:))
        effort.setAccessibilityIdentifier("task-router-effort-\(key)")
        effort.setAccessibilityLabel("Effort for \(key)")

        let inspection = inspectionColumn(for: row, key: key)
        let rowView = DataTableRowView(
            columns: [member, vendorStack, model, effort, weight, inspection],
            spacing: Theme.Space.s,
            showsSeparator: true)
        member.widthAnchor.constraint(equalToConstant: Theme.Metric.controlMinHeight).isActive = true
        vendorStack.widthAnchor.constraint(greaterThanOrEqualToConstant: 88).isActive = true
        return rowView
    }

    private func inspectionColumn(for row: TaskRouterRow, key: String) -> NSView {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.xs
        if let fact = inspectionFact(for: row) {
            let value = NSTextField(wrappingLabelWithString: fact)
            value.font = Theme.Font.monoCaption
            value.textColor = Theme.secondaryText
            value.maximumNumberOfLines = 3
            value.compressHorizontally(priority: 430, toolTip: fact)
            stack.addArrangedSubview(value)
        } else {
            let unknown = NSTextField(labelWithString: "share unknown")
            unknown.font = Theme.Font.monoCaption
            unknown.textColor = Theme.tertiaryText
            unknown.compressHorizontally(priority: 430, toolTip: "share unknown")
            stack.addArrangedSubview(unknown)
        }
        if row.unresolvable {
            // Policy names this model; the live catalog does not. Badge it so a retired or never-discovered row is not silently invisible either.
            let badge = CapsuleBadge(
                text: "not in live catalog",
                symbol: "exclamationmark.triangle",
                style: .warning)
            badge.setAccessibilityIdentifier("task-router-unresolvable-\(key)")
            stack.addArrangedSubview(badge)
        }
        return stack
    }

    private func inspectionFact(for row: TaskRouterRow) -> String? {
        let prefix = "\(row.provider)/\(row.model)"
        return screen.facts.first {
            $0.label == "Candidate" && $0.value.hasPrefix(prefix)
        }?.value
    }

    private func applyControl() -> NSView {
        let button = ActionButton(
            title: "Apply route",
            symbol: "checkmark.circle",
            style: .primary,
            target: self,
            action: #selector(applyTapped(_:)))
        button.isEnabled = editor.mutationsAllowed && editor.hasDraft && sendable
        button.setAccessibilityIdentifier("task-router-apply")
        applyButton = button
        return button
    }

    private var sendable: Bool {
        draftRoute.map { !$0.candidates.isEmpty } ?? true
    }

    private func statusLabels() -> [NSView] {
        var labels: [NSView] = []
        if let competing = editor.competingRevision {
            labels.append(status(
                "task-router-conflict",
                "The daemon is at revision \(competing). Your edit was not "
                    + "applied and is kept in the controls below.",
                color: Theme.warning))
        }
        if editor.hasDraft {
            labels.append(status(
                "task-router-draft", "Unsent draft edit.", color: Theme.secondaryText))
        }
        if !sendable {
            labels.append(status(
                "task-router-empty-route",
                "This route has no members yet. Add at least one before sending.",
                color: Theme.secondaryText))
        }
        if !editor.mutationsAllowed {
            labels.append(status(
                "task-router-readonly",
                "This projection is not current, so no route can be sent. "
                    + "The controls read the last observed policy.",
                color: Theme.secondaryText))
        }
        return labels
    }

    @objc private func categoryChanged(_ sender: NSPopUpButton) {
        guard sender.indexOfSelectedItem >= 0,
              sender.indexOfSelectedItem < categories.count else { return }
        onSelectCategory(categories[sender.indexOfSelectedItem])
    }

    @objc private func categoryRowTapped(_ sender: NSButton) {
        guard categories.indices.contains(sender.tag) else { return }
        onSelectCategory(categories[sender.tag])
    }

    @objc private func modeChanged(_ sender: NSPopUpButton) {
        let index = sender.indexOfSelectedItem - 1
        guard routing.modes.indices.contains(index) else {
            onEditRoute(nil)
            return
        }
        onEditRoute(RoutingPolicyDocument.WireRoute(
            mode: routing.modes[index].id,
            candidates: draftRoute?.candidates ?? []))
    }

    @objc private func memberToggled(_ sender: NSButton) {
        guard let route = draftRoute, let row = row(for: sender) else { return }
        var candidates = route.candidates.filter {
            !($0.provider == row.provider && $0.model == row.model)
        }
        if sender.state == .on {
            guard let catalogEntry = routing.catalog.first(where: {
                $0.provider == row.provider && $0.model == row.model
            }) else { return }
            candidates.append(RoutingPolicyDocument.WireRouteCandidate(
                provider: row.provider,
                model: row.model,
                effort: catalogEntry.startingEffort,
                weight: routing.weightRange.defaultValue))
        }
        onEditRoute(RoutingPolicyDocument.WireRoute(mode: route.mode, candidates: candidates))
    }

    /// A weight the wire would refuse never becomes a draft. The field keeps what was typed, the reason is stated, and Apply goes dead until it is a number the daemon accepts.
    @objc private func weightChanged(_ sender: NSTextField) {
        guard let row = row(for: sender) else { return }
        let range = routing.weightRange
        guard let weight = Int(sender.stringValue),
              weight >= range.minimum, weight <= range.maximum else {
            weightRefusal.stringValue = "\(row.provider)/\(row.model): a weight must be a "
                + "whole number from \(range.minimum) to "
                + "\(range.maximum). “\(sender.stringValue)” was not sent."
            weightRefusal.isHidden = false
            applyButton?.isEnabled = false
            return
        }
        edit(row) { $0.weight = weight }
    }

    @objc private func effortChanged(_ sender: NSPopUpButton) {
        guard let row = row(for: sender),
              let entry = routing.catalog.first(where: {
                  $0.provider == row.provider && $0.model == row.model
              }),
              entry.effortOptions.indices.contains(sender.indexOfSelectedItem) else { return }
        edit(row) { $0.effort = entry.effortOptions[sender.indexOfSelectedItem].effort }
    }

    @objc private func applyTapped(_ sender: NSButton) {
        onApply()
    }

    private var draftRoute: RoutingPolicyDocument.WireRoute? {
        editor.draft.policy.categories[category.rawValue]
    }

    private func row(for sender: NSControl) -> TaskRouterRow? {
        rows.indices.contains(sender.tag) ? rows[sender.tag] : nil
    }

    private func edit(
        _ row: TaskRouterRow,
        _ change: (inout RoutingPolicyDocument.WireRouteCandidate) -> Void
    ) {
        guard let route = draftRoute else { return }
        var candidates = route.candidates
        guard let index = candidates.firstIndex(where: {
            $0.provider == row.provider && $0.model == row.model
        }) else { return }
        change(&candidates[index])
        onEditRoute(RoutingPolicyDocument.WireRoute(mode: route.mode, candidates: candidates))
    }

    private func labelled(_ text: String, _ control: NSView) -> NSView {
        let label = NSTextField(labelWithString: text)
        label.font = Theme.Font.callout
        label.textColor = Theme.secondaryText
        let stack = NSStackView(views: [label, control])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = Theme.Space.s
        return stack
    }

    private func status(_ identifier: String, _ text: String, color: NSColor) -> NSView {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = Theme.Font.callout
        label.textColor = color
        label.maximumNumberOfLines = 0
        label.setAccessibilityIdentifier(identifier)
        return label
    }
}
