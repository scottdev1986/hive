// TaskRouterScreenView.swift
//
// The Task Router is a ten-task, five-provider matrix over the observed
// policy document. Each row is one catalogued category with its V3 mode
// and one compact cell per vendor; members, effort, stored weight and
// inspection shares live in those cells. The selected row is the editor —
// the window controller still binds Apply and set-route to one category,
// so only that row's controls write. Catalog models that are not members
// stay available to join on the selected row; they do not flood the
// matrix as a candidate catalog.
//
// This view is only built when a typed routing projection exists. The
// generic availability paragraph is not a second presentation of that
// projection; the matrix is. When availability is not current, a badge
// keeps the observed time as a tooltip. When no typed projection
// exists, the shell keeps ShellAvailabilityPanel as the sole screen.
//
// Visual language comes from the design-system tokens and primitives.
// Expected share, refusal, and balance stay inspection facts when the
// projection supplied them; they are never computed here. Apply route
// is the compare-and-set write against the document revision. There is
// no separate Review V3 draft projection, so this screen does not
// invent that button.

import AppKit
import WorkspaceCore

final class TaskRouterScreenView: NSView {

    private static let unconfiguredMode = "Unconfigured — no route"
    private static let taskColumnWidth: CGFloat = 148
    private static let modeColumnWidth: CGFloat = 136

    private let editor: TaskRouterEditor
    private let categories: [TaskCategory]
    private let category: TaskCategory
    private let routing: WorkspaceRoutingPresentation
    private let screen: ShellScreenProjection
    private let providers: [String]
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
        providers = editor.matrixProviders(routing: routing)
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
            subtitle: "Every catalogued task category and every known vendor. "
                + "Inspection shares appear only when the daemon supplied them.",
            actions: [apply])
        stack.addArrangedSubview(header)
        header.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        if let banner = screen.banner {
            let bannerView = ShellBannerView(banner: banner, presentation: .inline)
            stack.addArrangedSubview(bannerView)
            bannerView.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

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

        let matrix = matrixCard()
        stack.addArrangedSubview(matrix)
        matrix.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        let observed = observedInspectionCard()
        stack.addArrangedSubview(observed)
        observed.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Theme.Space.page),
            stack.trailingAnchor.constraint(
                equalTo: trailingAnchor, constant: -Theme.Space.page),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: Theme.Space.page),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Theme.Space.page),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func summaryRow() -> NSView {
        let facts = editor.summaryFacts(categories: categories)
        let range = routing.weightRange
        let policy = editor.draft.policy

        let providerFact = facts.providersKnown
            ? "\(facts.enabledProviders) / \(facts.listedProviders) providers enabled"
            : "providers unknown"
        let memberFact = "\(facts.routeMembers) route members"
        let policyModelFact = "\(facts.enabledPolicyModels) policy models with state enabled"
        var bits = [
            memberFact,
            policyModelFact,
            "weights \(range.minimum)–\(range.maximum)",
            "schema \(policy.schemaVersion) revision \(policy.revision)",
            "updated \(policy.updatedAt)",
        ]
        if let global = policy.global {
            let mode = routing.mode(global.mode)?.label ?? global.mode
            bits.insert("global \(mode)", at: 0)
        } else {
            bits.insert("global unconfigured", at: 0)
        }
        let line = bits.joined(separator: "  ·  ")

        var badgeViews: [NSView] = [
            CapsuleBadge(
                text: "\(facts.configuredRoutes) / \(facts.totalRoutes) routes",
                style: facts.configuredRoutes == 0 ? .neutral : .positive),
            CapsuleBadge(
                text: providerFact,
                style: facts.providersKnown ? .positive : .neutral),
            CapsuleBadge(text: memberFact, style: .info),
        ]
        if screen.availability != .current {
            let state = CapsuleBadge(
                text: screen.stateHeadline,
                symbol: availabilitySymbol,
                style: availabilityStyle)
            if let observedAt = screen.observedAt {
                state.toolTip = "Observed at \(observedAt)"
            }
            state.setAccessibilityIdentifier("task-router-availability")
            badgeViews.insert(state, at: 0)
        }
        let badges = NSStackView(views: badgeViews)
        badges.orientation = .horizontal
        badges.alignment = .centerY
        badges.spacing = Theme.Space.s

        let category = labelled("Category", categoryControl())
        let top = NSStackView(views: [badges, NSView.spacer(), category])
        top.orientation = .horizontal
        top.alignment = .centerY
        top.spacing = Theme.Space.s

        let label = NSTextField(wrappingLabelWithString: line)
        label.font = Theme.Font.monoCaption
        label.textColor = Theme.secondaryText
        label.maximumNumberOfLines = 2
        label.compressHorizontally(priority: 430, toolTip: line)

        let panel = InsetPanelView()
        panel.contentStack.addArrangedSubview(top)
        panel.contentStack.addArrangedSubview(label)
        top.widthAnchor.constraint(equalTo: panel.contentStack.widthAnchor).isActive = true
        label.widthAnchor.constraint(equalTo: panel.contentStack.widthAnchor).isActive = true
        return panel
    }

    private func matrixCard() -> SectionCardView {
        let card = SectionCardView(
            title: "Task routes",
            subtitle: "One row per task, one cell per vendor. "
                + "The selected row is the editor.")
        card.setAccessibilityIdentifier("task-router-matrix")

        let header = matrixHeader()
        card.contentStack.addArrangedSubview(header)
        card.pinToContentWidth(header)

        for (index, item) in categories.enumerated() {
            let row = matrixRow(item, index: index)
            card.contentStack.addArrangedSubview(row)
            card.pinToContentWidth(row)
        }
        return card
    }

    private func matrixHeader() -> MatrixRowView {
        var columns: [NSView] = [
            columnHead("Task category"),
            columnHead("V3 mode"),
        ]
        columns += providers.map { columnHead(providerColumnTitle($0)) }
        return MatrixRowView(
            columns: columns,
            nameWidth: Self.taskColumnWidth,
            modeWidth: Self.modeColumnWidth,
            selected: false)
    }

    private func matrixRow(
        _ item: TaskCategory,
        index: Int
    ) -> MatrixRowView {
        let selected = item == category
        let name = taskNameColumn(item: item, index: index, selected: selected)
        let mode: NSView = selected
            ? modeControl()
            : modeBadge(for: item, index: index)
        let cells = providers.map { provider in
            providerCell(item: item, provider: provider, selected: selected)
        }
        let row = MatrixRowView(
            columns: [name, mode] + cells,
            nameWidth: Self.taskColumnWidth,
            modeWidth: Self.modeColumnWidth,
            selected: selected)
        row.setAccessibilityIdentifier("task-router-matrix-row-\(item.rawValue)")
        return row
    }

    private func modeBadge(for item: TaskCategory, index: Int) -> NSView {
        let route = editor.draft.policy.categories[item.rawValue]
        let modeLabel = route.flatMap { routing.mode($0.mode)?.label }
            ?? (route == nil ? Self.unconfiguredMode : route!.mode)
        let button = NSButton(
            title: modeLabel,
            target: self,
            action: #selector(categoryRowTapped(_:)))
        button.bezelStyle = .inline
        button.isBordered = false
        button.font = Theme.Font.chromeControl
        button.contentTintColor = route == nil ? Theme.secondaryText : Theme.positive
        button.tag = index
        button.setAccessibilityLabel("Select \(item.label)")
        button.lineBreakMode = .byTruncatingTail
        button.toolTip = modeLabel
        button.setContentCompressionResistancePriority(.init(440), for: .horizontal)
        return button
    }

    private func providerCell(
        item: TaskCategory,
        provider: String,
        selected: Bool
    ) -> NSView {
        let cellRows = selected
            ? editor.editorRows(for: item, provider: provider, catalog: routing.catalog)
            : editor.matrixMembers(for: item, provider: provider, catalog: routing.catalog)
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.xs
        stack.setAccessibilityIdentifier(
            "task-router-cell-\(item.rawValue)-\(provider)")
        if cellRows.isEmpty {
            let empty = NSTextField(labelWithString: "no member")
            empty.font = Theme.Font.caption
            empty.textColor = Theme.secondaryText
            empty.compressHorizontally(priority: 430, toolTip: "no member")
            stack.addArrangedSubview(empty)
        } else {
            for row in cellRows {
                stack.addArrangedSubview(
                    selected ? editorChip(row, category: item) : memberChip(row, category: item))
            }
        }
        return stack
    }

    private func memberChip(_ row: TaskRouterRow, category: TaskCategory) -> NSView {
        let model = NSTextField(labelWithString: row.model)
        model.font = Theme.Font.headline
        model.textColor = Theme.primaryText
        model.compressHorizontally(priority: 430, toolTip: row.model)

        let detail = NSTextField(labelWithString: compactDetail(row))
        detail.font = Theme.Font.monoCaption
        detail.textColor = Theme.accent
        detail.compressHorizontally(priority: 420, toolTip: compactDetail(row))

        let stack = NSStackView(views: [model, detail])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 1
        if let bar = shareBar(for: row, category: category) {
            stack.addArrangedSubview(bar)
            bar.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        if row.unresolvable {
            stack.addArrangedSubview(unresolvableBadge(row))
        }
        return stack
    }

    private func editorChip(_ row: TaskRouterRow, category: TaskCategory) -> NSView {
        guard let index = rows.firstIndex(where: {
            $0.provider == row.provider && $0.model == row.model
        }) else {
            return memberChip(row, category: category)
        }
        let member = membershipCheckbox(row, index: index)
        let model = NSTextField(labelWithString: row.model)
        model.font = Theme.Font.headline
        model.textColor = Theme.primaryText
        model.compressHorizontally(priority: 430, toolTip: row.model)
        let title = NSStackView(views: [member, model])
        title.orientation = .horizontal
        title.alignment = .centerY
        title.spacing = Theme.Space.xs

        let effort = effortControl(row, index: index)
        let weight = weightControl(row, index: index)
        let stack = NSStackView(views: [title, effort, weight])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.xs
        if let bar = shareBar(for: row, category: category) {
            stack.addArrangedSubview(bar)
            bar.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        if row.isMember, let fact = inspectionFact(for: row, category: category) {
            let value = NSTextField(wrappingLabelWithString: fact)
            value.font = Theme.Font.monoCaption
            value.textColor = Theme.primaryText
            value.maximumNumberOfLines = 3
            value.compressHorizontally(priority: 420, toolTip: fact)
            stack.addArrangedSubview(value)
        }
        if row.unresolvable {
            stack.addArrangedSubview(unresolvableBadge(row))
        }
        return stack
    }

    private func compactDetail(_ row: TaskRouterRow) -> String {
        let effort = effortLabel(row)
        guard let candidate = row.candidate else { return effort }
        let weightEditable = draftRoute
            .flatMap { routing.mode($0.mode) }?.weightEditable ?? false
        if weightEditable {
            return "\(effort) · weight \(candidate.weight)"
        }
        return effort
    }

    private func effortLabel(_ row: TaskRouterRow) -> String {
        guard let effort = row.candidate?.effort else { return "not a member" }
        let catalogEntry = routing.catalog.first {
            $0.provider == row.provider && $0.model == row.model
        }
        if let match = catalogEntry?.effortOptions.first(where: { $0.effort == effort }) {
            return match.label
        }
        return effort.asWireEffort.cliArgument
    }

    private func shareBar(for row: TaskRouterRow, category: TaskCategory) -> NSView? {
        guard row.isMember,
              let fact = inspectionFact(for: row, category: category),
              let percent = configuredPercent(in: fact) else { return nil }
        let bar = MeterBarView()
        bar.state = .fill(fraction: Double(percent) / 100, color: Theme.accent)
        bar.toolTip = fact
        return bar
    }

    private func configuredPercent(in fact: String) -> Int? {
        let marker = "configured "
        guard let range = fact.range(of: marker) else { return nil }
        let tail = fact[range.upperBound...]
        var digits = ""
        for character in tail {
            if character.isNumber { digits.append(character) } else { break }
        }
        return Int(digits)
    }

    private func unresolvableBadge(_ row: TaskRouterRow) -> NSView {
        let key = "\(row.provider)/\(row.model)"
        // Policy names this model; the live catalog does not. Badge it so a retired or never-discovered row is not silently invisible either.
        let badge = CapsuleBadge(
            text: "not in live catalog",
            symbol: "exclamationmark.triangle",
            style: .warning)
        badge.setAccessibilityIdentifier("task-router-unresolvable-\(key)")
        return badge
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

    private func taskNameColumn(
        item: TaskCategory, index: Int, selected: Bool
    ) -> NSView {
        let name = NSTextField(labelWithString: item.label)
        name.font = Theme.Font.headline
        name.textColor = selected ? Theme.accent : Theme.primaryText
        name.compressHorizontally(priority: 450, toolTip: item.label)
        let slug = NSTextField(labelWithString: item.rawValue)
        slug.font = Theme.Font.monoCaption
        slug.textColor = Theme.secondaryText
        slug.compressHorizontally(priority: 430, toolTip: item.rawValue)
        let copy = NSStackView(views: [name, slug])
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = 1
        let select = categorySelectButton(item: item, index: index, selected: selected)
        let stack = NSStackView(views: [copy, select])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.xs
        return stack
    }

    private func categorySelectButton(
        item: TaskCategory, index: Int, selected: Bool
    ) -> NSButton {
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
        select.lineBreakMode = .byTruncatingTail
        select.toolTip = item.label
        select.setContentCompressionResistancePriority(.init(450), for: .horizontal)
        return select
    }

    private func columnHead(_ text: String) -> NSView {
        let label = NSTextField(labelWithString: text)
        label.font = Theme.Font.sectionLabel
        label.textColor = Theme.secondaryText
        label.compressHorizontally(priority: 450, toolTip: text)
        return label
    }

    private func providerColumnTitle(_ provider: String) -> String {
        switch ProviderID(provider) {
        case .claude: return "Claude"
        case .codex: return "Codex"
        case .grok: return "Grok"
        case .kimi: return "Kimi"
        case .opencode: return "OpenCode"
        default: return ProviderBranding.title(for: ProviderID(provider))
        }
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
        return popup
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
        return popup
    }

    private func membershipCheckbox(_ row: TaskRouterRow, index: Int) -> NSButton {
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
        return member
    }

    private func weightControl(_ row: TaskRouterRow, index: Int) -> NSTextField {
        let key = "\(row.provider)/\(row.model)"
        let weightEditable = draftRoute
            .flatMap { routing.mode($0.mode) }?.weightEditable ?? false
        let weight = NSTextField(string: row.candidate.map { String($0.weight) } ?? "")
        weight.placeholderString = "weight"
        weight.font = Theme.Font.monoBody
        weight.textColor = Theme.primaryText
        weight.alignment = .right
        weight.tag = index
        weight.isEnabled = editor.mutationsAllowed && row.isMember && weightEditable
        weight.isHidden = !weightEditable
        weight.target = self
        weight.action = #selector(weightChanged(_:))
        weight.setAccessibilityIdentifier("task-router-weight-\(key)")
        weight.setAccessibilityLabel("Weight for \(key)")
        weight.widthAnchor.constraint(equalToConstant: 64).isActive = true
        return weight
    }

    private func effortControl(_ row: TaskRouterRow, index: Int) -> NSPopUpButton {
        let key = "\(row.provider)/\(row.model)"
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
        return effort
    }

    private func inspectionFact(
        for row: TaskRouterRow, category: TaskCategory
    ) -> String? {
        // Fixture inspection is one category. A candidate fact from another
        // route must not paint this cell — that would be someone else's share.
        let scoped = screen.facts.contains {
            $0.label == "Category" && $0.value == category.rawValue
        }
        guard scoped else { return nil }
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

/// One matrix row with a fixed task column, a fixed mode column, and equal
/// vendor cells. Column widths are pinned so labels, mode, and provider
/// chips stay on a grid as window width changes.
private final class MatrixRowView: NSView {

    let providerCells: [NSView]

    init(
        columns: [NSView],
        nameWidth: CGFloat,
        modeWidth: CGFloat,
        selected: Bool
    ) {
        providerCells = Array(columns.dropFirst(2))
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        if selected {
            layer?.backgroundColor = Theme.accentFill.cgColor
            layer?.cornerRadius = Theme.Metric.insetCornerRadius
            layer?.cornerCurve = .continuous
        }

        let stack = NSStackView(views: columns)
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .horizontal
        stack.alignment = .top
        stack.spacing = Theme.Space.s
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(
                equalTo: leadingAnchor, constant: Theme.Space.s),
            stack.trailingAnchor.constraint(
                equalTo: trailingAnchor, constant: -Theme.Space.s),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: Theme.Space.s),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Theme.Space.s),
        ])

        if columns.count >= 1 {
            columns[0].widthAnchor.constraint(equalToConstant: nameWidth).isActive = true
        }
        if columns.count >= 2 {
            columns[1].widthAnchor.constraint(equalToConstant: modeWidth).isActive = true
        }
        if let first = providerCells.first {
            for cell in providerCells.dropFirst() {
                cell.widthAnchor.constraint(equalTo: first.widthAnchor).isActive = true
            }
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}
