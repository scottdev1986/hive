// TaskRouterScreenView.swift The Task Router screen: one category's route in editable controls over the draft, with the observed projection panel beneath. The draft is state this view renders, never state it owns — a rejected apply rebuilds this view with the same draft and the daemon's competing revision named on screen. A category with no route offers no membership: choosing a mode is what creates one, so the editor cannot invent a router mode the user never picked.

import AppKit
import WorkspaceCore

final class TaskRouterScreenView: NSView {

    private static let unconfiguredMode = "Unconfigured — no route"

    private let editor: TaskRouterEditor
    private let categories: [TaskCategory]
    private let category: TaskCategory
    private let routing: WorkspaceRoutingPresentation
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
        rows = editor.rows(for: category, catalog: routing.catalog)
        self.onSelectCategory = onSelectCategory
        self.onEditRoute = onEditRoute
        self.onApply = onApply
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.s
        stack.translatesAutoresizingMaskIntoConstraints = false

        let panel = ShellAvailabilityPanel(
            route: .taskRouter, screen: screen, contentInset: 0)
        stack.addArrangedSubview(panel)
        stack.addArrangedSubview(categoryControl())
        stack.addArrangedSubview(modeControl())
        for status in statusLabels() { stack.addArrangedSubview(status) }
        weightRefusal.font = Theme.Font.callout
        weightRefusal.textColor = .systemOrange
        weightRefusal.maximumNumberOfLines = 0
        weightRefusal.isHidden = true
        weightRefusal.setAccessibilityIdentifier("task-router-weight-refusal")
        stack.addArrangedSubview(weightRefusal)
        let card = CardView()
        for (index, row) in rows.enumerated() {
            let view = membershipRow(row, index: index)
            card.contentStack.addArrangedSubview(view)
            card.pinToContentWidth(view)
        }
        if !rows.isEmpty {
            stack.addArrangedSubview(card)
            card.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        stack.addArrangedSubview(applyControl())

        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Theme.Space.page),
            stack.trailingAnchor.constraint(
                equalTo: trailingAnchor, constant: -Theme.Space.page),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: Theme.Space.page),
            stack.bottomAnchor.constraint(
                lessThanOrEqualTo: bottomAnchor, constant: -Theme.Space.page),
            panel.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

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
        let member = NSButton(checkboxWithTitle: key, target: self,
                              action: #selector(memberToggled(_:)))
        member.state = row.isMember ? .on : .off
        member.tag = index
        let isInCatalog = routing.catalog.contains {
            $0.provider == row.provider && $0.model == row.model
        }
        member.isEnabled = editor.mutationsAllowed && draftRoute != nil
            && (row.isMember || isInCatalog)
        member.setAccessibilityIdentifier("task-router-member-\(key)")

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

        var views: [NSView] = [member, weight, effort]
        if row.unresolvable {
            // Policy names this model; the live catalog does not. Badge it so a retired or never-discovered row is not silently invisible either.
            let badge = NSTextField(labelWithString: "not in live catalog")
            badge.font = Theme.Font.caption
            badge.textColor = .systemOrange
            badge.setAccessibilityIdentifier("task-router-unresolvable-\(key)")
            views.append(badge)
        }
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal
        stack.spacing = Theme.Space.s
        return stack
    }

    private func applyControl() -> NSView {
        let button = NSButton(title: "Apply route", target: self,
                              action: #selector(applyTapped(_:)))
        button.bezelStyle = .rounded
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
                color: .systemOrange))
        }
        if editor.hasDraft {
            labels.append(status(
                "task-router-draft", "Unsent draft edit.", color: .secondaryLabelColor))
        }
        if !sendable {
            labels.append(status(
                "task-router-empty-route",
                "This route has no members yet. Add at least one before sending.",
                color: .secondaryLabelColor))
        }
        if !editor.mutationsAllowed {
            labels.append(status(
                "task-router-readonly",
                "This projection is not current, so no route can be sent. "
                    + "The controls read the last observed policy.",
                color: .secondaryLabelColor))
        }
        return labels
    }

    @objc private func categoryChanged(_ sender: NSPopUpButton) {
        guard sender.indexOfSelectedItem >= 0,
              sender.indexOfSelectedItem < categories.count else { return }
        onSelectCategory(categories[sender.indexOfSelectedItem])
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
        label.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [label, control])
        stack.orientation = .horizontal
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
