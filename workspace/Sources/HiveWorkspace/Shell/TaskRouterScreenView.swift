// TaskRouterScreenView.swift
//
// The Task Router is one card per catalogued task category, stacked down
// the page, every card editable in place. A card is that task's current
// route: one row per member candidate with vendor, exact model, effort,
// stored weight, the daemon's expected share, and Remove. Models that are
// not members stay off the card — they join through "Add model…", a
// single pull-down grouped by vendor with compact marks. Effort is set
// on the card after joining, not in the picker. The design source is the
// `.task-route-list` card list in docs/design/split-horizon-transition.html.
//
// This is a dumb view over the routing projection. Expected share is the
// daemon's `configuredShare` for the observed route and nothing else: a
// card whose draft differs from the last observation shows no share until
// Apply reads the daemon back, because the view does not compute routing
// arithmetic. Candidate status captions ("provider disabled", "not in live
// catalog") are the daemon's candidate states, never re-derived here.
//
// Every edit is a draft against one category; Apply sends one set-route
// per edited category through the write seam, which runs them in order.
// There is no separate Review V3 draft projection, so no such button.
//
// One card-owned column layout binds the column header and every row to
// the same widths. At the window's 940pt minimum the model column gives
// way and names truncate with the full id on the tooltip.

import AppKit
import WorkspaceCore

final class TaskRouterScreenView: NSView {

    /// The draft candidate a row control edits. Control tags index into `rowRefs`.
    private struct RowRef {
        let category: TaskCategory
        let provider: String
        let model: String
        var key: String { "\(provider)/\(model)" }
    }

    /// One rendered card row: a draft member, or a member of the last
    /// observation that the draft removed (shown dimmed, restorable).
    private struct CardRow {
        let ref: RowRef
        let candidate: RoutingPolicyDocument.WireRouteCandidate
        let isMember: Bool
        let unresolvable: Bool
    }

    private static let vendorWidth: CGFloat = 100
    private static let effortWidth: CGFloat = 128
    private static let weightWidth: CGFloat = 104
    private static let shareWidth: CGFloat = 100
    private static let routeWidth: CGFloat = 76

    private let editor: TaskRouterEditor
    private let categories: [TaskCategory]
    private let routing: WorkspaceRoutingPresentation
    private let screen: ShellScreenProjection
    private let providers: [String]
    private let onEditRoute: (TaskCategory, RoutingPolicyDocument.WireRoute?) -> Void
    private let onApply: () -> Void
    private var rowRefs: [RowRef] = []
    /// Live handles for the one refusal this view raises itself. A rejected weight changes no state, so nothing re-renders and these must be the views already on screen.
    private let weightRefusal = NSTextField(wrappingLabelWithString: "")
    private weak var applyButton: NSButton?

    init(
        screen: ShellScreenProjection,
        editor: TaskRouterEditor,
        categories: [TaskCategory],
        routing: WorkspaceRoutingPresentation,
        probeState: ShellProviderProbeRefreshState,
        onProbe: @escaping () -> Void,
        onEditRoute: @escaping (TaskCategory, RoutingPolicyDocument.WireRoute?) -> Void,
        onApply: @escaping () -> Void
    ) {
        self.editor = editor
        self.categories = categories
        self.routing = routing
        self.screen = screen
        providers = editor.matrixProviders(routing: routing)
        self.onEditRoute = onEditRoute
        self.onApply = onApply
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.m
        stack.translatesAutoresizingMaskIntoConstraints = false

        let refresh = refreshControl(state: probeState, onProbe: onProbe)
        let apply = applyControl()
        let header = PageHeaderView(
            title: "Task Router",
            subtitle: "All configured Hive task categories and every known vendor. "
                + "Every candidate row shows exact model, effort, stored weight, and the "
                + "daemon's expected share; scroll to edit any task.",
            actions: [refresh, apply])
        stack.addArrangedSubview(header)
        header.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        if let status = Self.probeStatus(probeState) {
            stack.addArrangedSubview(status)
            status.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

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

        let list = NSStackView()
        list.orientation = .vertical
        list.alignment = .leading
        list.spacing = Theme.Space.m
        list.setAccessibilityIdentifier("task-router-routes")
        for (index, category) in categories.enumerated() {
            let card = routeCard(for: category, index: index)
            list.addArrangedSubview(card)
            card.widthAnchor.constraint(equalTo: list.widthAnchor).isActive = true
        }
        stack.addArrangedSubview(list)
        list.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Theme.Space.page),
            stack.trailingAnchor.constraint(
                equalTo: trailingAnchor, constant: -Theme.Space.page),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: Theme.Space.page),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Theme.Space.page),
        ])
        compressesHorizontally(stack)
        compressesHorizontally(self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    // MARK: Summary

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

        let label = NSTextField(wrappingLabelWithString: line)
        label.font = Theme.Font.monoCaption
        label.textColor = Theme.secondaryText
        label.maximumNumberOfLines = 2
        label.compressHorizontally(priority: 430, toolTip: line)

        let panel = InsetPanelView()
        panel.contentStack.addArrangedSubview(badges)
        panel.contentStack.addArrangedSubview(label)
        label.widthAnchor.constraint(equalTo: panel.contentStack.widthAnchor).isActive = true
        return panel
    }

    // MARK: Route cards

    private func routeCard(for category: TaskCategory, index: Int) -> SectionCardView {
        let route = draftRoute(category)
        let rows = cardRows(for: category)
        let members = route?.candidates.count ?? 0
        let subtitle = route == nil
            ? "\(category.rawValue) · no route configured"
            : "\(category.rawValue) · \(members) current candidate\(members == 1 ? "" : "s")"

        var actionViews: [NSView] = []
        if isEdited(category) {
            let badge = CapsuleBadge(text: "unsent edit", symbol: "pencil", style: .warning)
            badge.setAccessibilityIdentifier("task-router-draft-\(category.rawValue)")
            actionViews.append(badge)
        }
        actionViews.append(modeControl(for: category, index: index))
        if route != nil {
            actionViews.append(clearControl(for: category, index: index))
        }
        actionViews.append(addControl(for: category, index: index))
        let actions = NSStackView(views: actionViews)
        actions.orientation = .horizontal
        actions.alignment = .centerY
        actions.spacing = Theme.Space.s

        let card = SectionCardView(title: category.label, subtitle: subtitle, trailingView: actions)
        card.setAccessibilityIdentifier("task-router-card-\(category.rawValue)")

        guard route != nil else {
            let copy = NSTextField(wrappingLabelWithString:
                "No route is configured for \(category.label); spawns in this category "
                    + "follow the global route. Configure one to choose its candidates.")
            copy.font = Theme.Font.callout
            copy.textColor = Theme.secondaryText
            copy.maximumNumberOfLines = 0
            let configure = ActionButton(
                title: "Configure route",
                symbol: "plus.circle",
                target: self,
                action: #selector(configureTapped(_:)))
            configure.tag = index
            configure.isEnabled = editor.mutationsAllowed
            configure.setAccessibilityIdentifier("task-router-configure-\(category.rawValue)")
            let row = NSStackView(views: [copy, NSView.spacer(), configure])
            row.orientation = .horizontal
            row.alignment = .centerY
            row.spacing = Theme.Space.m
            card.contentStack.addArrangedSubview(row)
            card.pinToContentWidth(row)
            return card
        }

        guard !rows.isEmpty else {
            let copy = NSTextField(wrappingLabelWithString:
                "This route has no members yet. Add at least one model before sending.")
            copy.font = Theme.Font.callout
            copy.textColor = Theme.secondaryText
            copy.maximumNumberOfLines = 0
            card.contentStack.addArrangedSubview(copy)
            card.pinToContentWidth(copy)
            return card
        }

        let columns = CardColumnLayout(
            owner: card,
            content: card.contentStack,
            fixedWidths: [
                Self.vendorWidth, nil, Self.effortWidth,
                Self.weightWidth, Self.shareWidth, Self.routeWidth,
            ],
            spacing: Theme.Space.m)

        let head = DataTableRowView(
            columns: ["Vendor", "Exact model", "Effort", "Stored weight", "Expected share", ""]
                .map(columnHead),
            showsSeparator: true)
        head.setAccessibilityIdentifier("task-router-columns-\(category.rawValue)")
        card.contentStack.addArrangedSubview(head)
        card.pinToContentWidth(head)
        columns.bind(head.columnStack.arrangedSubviews)

        for (position, row) in rows.enumerated() {
            let view = candidateRow(row, last: position + 1 == rows.count)
            card.contentStack.addArrangedSubview(view)
            card.pinToContentWidth(view)
            columns.bind(view.columnStack.arrangedSubviews)
        }
        return card
    }

    /// Draft members, then members of the last observation the draft removed.
    /// Vendor order follows the provider columns; models sort within a vendor.
    private func cardRows(for category: TaskCategory) -> [CardRow] {
        let draft = draftRoute(category)?.candidates ?? []
        let observed = editor.observedRoute(for: category)?.candidates ?? []
        let catalogKeys = Set(routing.catalog.map { "\($0.provider)/\($0.model)" })
        let hasCatalog = !routing.catalog.isEmpty
        var rows: [CardRow] = draft.map { candidate in
            CardRow(
                ref: RowRef(
                    category: category, provider: candidate.provider, model: candidate.model),
                candidate: candidate,
                isMember: true,
                unresolvable: hasCatalog
                    && !catalogKeys.contains("\(candidate.provider)/\(candidate.model)"))
        }
        for candidate in observed where !draft.contains(where: {
            $0.provider == candidate.provider && $0.model == candidate.model
        }) {
            rows.append(CardRow(
                ref: RowRef(
                    category: category, provider: candidate.provider, model: candidate.model),
                candidate: candidate,
                isMember: false,
                unresolvable: hasCatalog
                    && !catalogKeys.contains("\(candidate.provider)/\(candidate.model)")))
        }
        return rows.sorted { lhs, rhs in
            let left = providers.firstIndex(of: lhs.ref.provider) ?? providers.count
            let right = providers.firstIndex(of: rhs.ref.provider) ?? providers.count
            if left != right { return left < right }
            return lhs.ref.model < rhs.ref.model
        }
    }

    private func candidateRow(_ row: CardRow, last: Bool) -> DataTableRowView {
        let tag = rowRefs.count
        rowRefs.append(row.ref)
        let category = row.ref.category
        let route = draftRoute(category)
        let weightEditable = route.flatMap { routing.mode($0.mode) }?.weightEditable ?? false
        let editable = editor.mutationsAllowed && row.isMember

        let view = DataTableRowView(
            columns: [
                vendorCell(row),
                modelCell(row),
                effortCell(row, tag: tag, enabled: editable),
                weightCell(row, tag: tag, enabled: editable && weightEditable,
                           weightEditable: weightEditable),
                shareCell(row),
                memberControl(row, tag: tag),
            ],
            showsSeparator: !last)
        view.setAccessibilityIdentifier(
            "task-router-row-\(category.rawValue)-\(row.ref.key)")
        if !row.isMember { view.alphaValue = 0.55 }
        return view
    }

    // MARK: Cells

    private func vendorCell(_ row: CardRow) -> NSView {
        let id = ProviderID(row.ref.provider)
        let mark = ProviderMarkView(provider: id, size: Theme.Metric.chainMarkSize)
        let name = truncatingLabel(
            providerTitle(row.ref.provider),
            font: Theme.Font.chromeControl,
            color: Theme.primaryText,
            priority: 440)
        let stack = NSStackView(views: [mark, name])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = Theme.Space.xs
        if routing.providerState(id) != "enabled" {
            stack.toolTip = "\(providerTitle(row.ref.provider)) is not enabled"
        }
        compressesHorizontally(stack)
        return stack
    }

    private func modelCell(_ row: CardRow) -> NSView {
        let model = truncatingLabel(
            row.ref.model, font: Theme.Font.chromeProject, color: Theme.primaryText)
        let (captionText, captionColor) = statusCaption(row)
        let caption = truncatingLabel(
            captionText, font: Theme.Font.monoCaption, color: captionColor, priority: 420)
        caption.setAccessibilityIdentifier(
            "task-router-status-\(row.ref.category.rawValue)-\(row.ref.key)")
        let stack = NSStackView(views: [model, caption])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 1
        compressesHorizontally(stack)
        return stack
    }

    /// The daemon's word on this candidate. A row the draft added has no
    /// daemon state yet; a row the draft removed keeps the observed one.
    private func statusCaption(_ row: CardRow) -> (String, NSColor) {
        if !row.isMember { return ("removed in this draft", Theme.secondaryText) }
        if row.unresolvable { return ("not in live catalog", Theme.warning) }
        guard let state = routing.candidate(
            scope: row.ref.category.rawValue,
            provider: row.ref.provider,
            model: row.ref.model)
        else { return ("added · pending apply", Theme.secondaryText) }
        switch state.rendered {
        case .effective: return ("exact enabled model", Theme.tertiaryText)
        case .providerOff: return ("provider disabled", Theme.warning)
        case .modelDisabled: return ("model disabled", Theme.warning)
        case .awaitingConsent: return ("awaiting consent", Theme.warning)
        case .unresolvable: return ("not in live catalog", Theme.warning)
        }
    }

    private func effortCell(_ row: CardRow, tag: Int, enabled: Bool) -> NSView {
        let key = row.ref.key
        let category = row.ref.category
        let popup = NSPopUpButton()
        popup.font = Theme.Font.chromeControl
        let entry = routing.catalog.first {
            $0.provider == row.ref.provider && $0.model == row.ref.model
        }
        let options = entry?.effortOptions ?? []
        popup.addItems(withTitles: options.map { effortPresentation($0.effort) })
        let selected = options.firstIndex { $0.effort == row.candidate.effort }
        if let selected {
            popup.selectItem(at: selected)
        } else {
            popup.addItem(withTitle: effortPresentation(row.candidate.effort))
            popup.selectItem(at: options.count)
        }
        popup.tag = tag
        popup.isEnabled = enabled && selected != nil
        popup.target = self
        popup.action = #selector(effortChanged(_:))
        popup.setAccessibilityIdentifier("task-router-effort-\(category.rawValue)-\(key)")
        popup.setAccessibilityLabel("Effort for \(key) on \(category.label)")
        compressesHorizontally(popup)

        guard editor.mutationsAllowed, row.isMember, entry == nil else { return popup }
        let refusal = "Effort unavailable — \(key) is not in the live routing catalog, "
            + "so no legal choices were published."
        popup.toolTip = refusal
        let reason = NSTextField(wrappingLabelWithString: refusal)
        reason.font = Theme.Font.caption
        reason.textColor = Theme.secondaryText
        reason.maximumNumberOfLines = 3
        reason.setAccessibilityIdentifier(
            "task-router-effort-refusal-\(category.rawValue)-\(key)")
        reason.compressHorizontally(priority: 420)
        let stack = NSStackView(views: [popup, reason])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.xs
        popup.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        compressesHorizontally(stack)
        return stack
    }

    private func weightCell(
        _ row: CardRow, tag: Int, enabled: Bool, weightEditable: Bool
    ) -> NSView {
        let key = row.ref.key
        let category = row.ref.category
        let stepper = WeightStepperView(
            value: row.candidate.weight,
            target: self,
            down: #selector(weightStepDown(_:)),
            up: #selector(weightStepUp(_:)),
            typed: #selector(weightChanged(_:)))
        stepper.tag = tag
        stepper.isEnabled = enabled
        stepper.setAccessibilityIdentifier(
            "task-router-stored-weight-\(category.rawValue)-\(key)")
        stepper.field.setAccessibilityIdentifier(
            "task-router-weight-\(category.rawValue)-\(key)")
        stepper.field.setAccessibilityLabel("Weight for \(key) on \(category.label)")
        stepper.downButton.setAccessibilityIdentifier(
            "task-router-weight-down-\(category.rawValue)-\(key)")
        stepper.upButton.setAccessibilityIdentifier(
            "task-router-weight-up-\(category.rawValue)-\(key)")
        if !weightEditable {
            let mode = draftRoute(category).flatMap { routing.mode($0.mode) }
            stepper.toolTip = mode.map {
                "\($0.label) ignores stored weights; this one is kept for a weighted split."
            } ?? "Stored weight is not in use."
        }
        compressesHorizontally(stepper)
        return stepper
    }

    /// The daemon's configured share for the observed route. An edited card
    /// has no share to show until Apply reads the daemon back.
    private func shareCell(_ row: CardRow) -> NSView {
        let category = row.ref.category
        let observedShare = routing.candidate(
            scope: category.rawValue, provider: row.ref.provider, model: row.ref.model
        )?.configuredShare
        let share: Double? = (isEdited(category) || !row.isMember) ? nil : observedShare

        let value = NSTextField(labelWithString: share.map { "\(Int(($0 * 100).rounded()))%" } ?? "—")
        value.font = Theme.Font.monoDigits
        value.textColor = share == nil ? Theme.tertiaryText : Theme.primaryText
        let bar = MeterBarView()
        bar.state = .fill(fraction: share ?? 0, color: Theme.accent)
        let stack = NSStackView(views: [value, bar])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.xs
        stack.setAccessibilityIdentifier(
            "task-router-share-\(category.rawValue)-\(row.ref.key)")
        if share == nil {
            stack.toolTip = row.isMember
                ? "Expected share comes from the daemon after Apply."
                : "Not a member of this draft."
        } else {
            stack.toolTip = "Configured share from the daemon's last read"
        }
        bar.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        compressesHorizontally(stack)
        return stack
    }

    private func memberControl(_ row: CardRow, tag: Int) -> NSView {
        let button = ActionButton(
            title: row.isMember ? "Remove" : "Restore",
            style: row.isMember ? .destructive : .neutral,
            target: self,
            action: #selector(memberTapped(_:)))
        button.tag = tag
        button.isEnabled = editor.mutationsAllowed && draftRoute(row.ref.category) != nil
        button.setAccessibilityIdentifier(
            "task-router-member-\(row.ref.category.rawValue)-\(row.ref.key)")
        button.setAccessibilityLabel(
            "\(row.isMember ? "Remove" : "Restore") \(row.ref.key) on \(row.ref.category.label)")
        compressesHorizontally(button)
        return button
    }

    // MARK: Card-level controls

    private func modeControl(for category: TaskCategory, index: Int) -> NSView {
        let segmented = NSSegmentedControl(
            labels: routing.modes.map(\.label),
            trackingMode: .selectOne,
            target: self,
            action: #selector(modeChanged(_:)))
        segmented.segmentStyle = .rounded
        segmented.font = Theme.Font.chromeControl
        for (segment, mode) in routing.modes.enumerated() {
            segmented.setToolTip(mode.caption, forSegment: segment)
        }
        let route = draftRoute(category)
        if let mode = route.flatMap({ routing.mode($0.mode) }),
           let selected = routing.modes.firstIndex(of: mode) {
            segmented.selectedSegment = selected
        } else {
            segmented.selectedSegment = -1
        }
        segmented.tag = index
        segmented.isEnabled = editor.mutationsAllowed && route != nil
            && (route?.writable ?? true)
        segmented.setAccessibilityIdentifier("task-router-mode-\(category.rawValue)")
        segmented.setAccessibilityLabel("Router mode for \(category.label)")
        return segmented
    }

    private func clearControl(for category: TaskCategory, index: Int) -> NSView {
        let button = NSButton(
            title: "Clear route",
            target: self,
            action: #selector(clearTapped(_:)))
        button.bezelStyle = .inline
        button.isBordered = false
        button.font = Theme.Font.chromeControl
        button.contentTintColor = Theme.secondaryText
        button.tag = index
        button.isEnabled = editor.mutationsAllowed
        button.toolTip = "Unconfigure \(category.label); spawns follow the global route."
        button.setAccessibilityIdentifier("task-router-clear-\(category.rawValue)")
        return button
    }

    /// Pull-down of the live routing catalog, grouped by vendor in one list so
    /// adding a model is a click rather than a hover into a submenu. Models
    /// already on the route stay out. Joining takes the daemon's starting
    /// effort and default weight; it changes membership, not consent. Effort
    /// is not listed here — the card's effort control is where that is set.
    private func addControl(for category: TaskCategory, index: Int) -> NSView {
        let popup = NSPopUpButton(frame: .zero, pullsDown: true)
        popup.font = Theme.Font.chromeControl
        popup.addItem(withTitle: "Add model…")
        popup.menu?.autoenablesItems = false
        let members = Set((draftRoute(category)?.candidates ?? []).map { "\($0.provider)/\($0.model)" })
        var addable = 0
        var isFirstVendor = true
        for provider in providers {
            let entries = routing.catalog
                .filter { $0.provider == provider && !members.contains("\($0.provider)/\($0.model)") }
                .sorted { $0.model < $1.model }
            if !isFirstVendor {
                popup.menu?.addItem(.separator())
            }
            isFirstVendor = false
            popup.menu?.addItem(addMenuVendorHeader(provider, available: entries.count))
            if entries.isEmpty {
                let none = NSMenuItem(
                    title: routing.catalog.contains { $0.provider == provider }
                        ? "Every enabled model is on this route"
                        : "No enabled models",
                    action: nil, keyEquivalent: "")
                none.isEnabled = false
                none.indentationLevel = 1
                popup.menu?.addItem(none)
                continue
            }
            let mark = ProviderMarkView.menuMarkImage(for: ProviderID(provider))
            for entry in entries {
                let item = NSMenuItem(
                    title: entry.model,
                    action: #selector(addModelChosen(_:)),
                    keyEquivalent: "")
                item.target = self
                item.tag = index
                item.indentationLevel = 1
                item.image = mark
                item.representedObject = "\(entry.provider)/\(entry.model)"
                popup.menu?.addItem(item)
                addable += 1
            }
        }
        popup.isEnabled = editor.mutationsAllowed && draftRoute(category) != nil && addable > 0
        if draftRoute(category) == nil {
            popup.toolTip = "Configure a route first."
        } else if addable == 0 {
            popup.toolTip = "Every enabled model is already on this route."
        }
        popup.setAccessibilityIdentifier("task-router-add-\(category.rawValue)")
        popup.setAccessibilityLabel("Add model to \(category.label)")
        return popup
    }

    /// Native section label. Compact marks sit on the model rows, which are
    /// enabled — disabled header images are what went missing last time.
    private func addMenuVendorHeader(_ provider: String, available: Int) -> NSMenuItem {
        let header = NSMenuItem.sectionHeader(title: providerTitle(provider))
        header.toolTip = available == 0
            ? (routing.catalog.contains { $0.provider == provider }
                ? "Every enabled model is on this route"
                : "No enabled models")
            : "\(available) model\(available == 1 ? "" : "s") available"
        return header
    }

    // MARK: Header controls and status

    private func applyControl() -> NSView {
        let button = ActionButton(
            title: "Apply changes",
            symbol: "checkmark.circle",
            style: .primary,
            target: self,
            action: #selector(applyTapped(_:)))
        button.isEnabled = editor.mutationsAllowed && editor.hasDraft && allSendable
        button.setAccessibilityIdentifier("task-router-apply")
        applyButton = button
        return button
    }

    private func refreshControl(
        state: ShellProviderProbeRefreshState,
        onProbe: @escaping () -> Void
    ) -> NSView {
        let button = ActionButton(
            title: state == .refreshing ? "Refreshing provider probes…" : "Refresh",
            symbol: "arrow.clockwise",
            target: ShellButtonTarget.shared,
            action: #selector(ShellButtonTarget.fire(_:)))
        button.isEnabled = state != .refreshing
        button.setAccessibilityIdentifier("task-router-refresh")
        ShellButtonTarget.shared.register(button, action: onProbe)
        return button
    }

    private static func probeStatus(_ state: ShellProviderProbeRefreshState) -> NSView? {
        let message: String
        let style: CapsuleBadge.Style
        let symbol: String
        let identifier: String
        switch state {
        case .idle, .refreshing:
            return nil
        case .succeeded(let value):
            message = value
            style = .positive
            symbol = "checkmark.circle.fill"
            identifier = "task-router-probe-status"
        case .failed(let value):
            message = value
            style = .critical
            symbol = "exclamationmark.circle.fill"
            identifier = "task-router-probe-error"
        }
        let panel = InsetPanelView()
        let label = NSTextField(wrappingLabelWithString: message)
        let row = NSStackView(views: [
            CapsuleBadge(
                text: style == .positive ? "refreshed" : "refresh failed",
                symbol: symbol,
                style: style),
            label,
        ])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = Theme.Space.s
        label.font = Theme.Font.caption
        label.textColor = style == .positive ? Theme.secondaryText : Theme.critical
        label.maximumNumberOfLines = 0
        label.setAccessibilityIdentifier(identifier)
        panel.contentStack.addArrangedSubview(row)
        row.widthAnchor.constraint(equalTo: panel.contentStack.widthAnchor).isActive = true
        return panel
    }

    private var editedCategories: [TaskCategory] { editor.editedCategories(categories) }

    private var allSendable: Bool {
        editedCategories.allSatisfy { editor.isSendable($0) }
    }

    private func statusLabels() -> [NSView] {
        var labels: [NSView] = []
        if let competing = editor.competingRevision {
            labels.append(status(
                "task-router-conflict",
                "The daemon is at revision \(competing). Your edit was not "
                    + "applied and is kept in the cards below.",
                color: Theme.warning))
        }
        let edited = editedCategories
        if !edited.isEmpty {
            let names = edited.map(\.label).joined(separator: ", ")
            labels.append(status(
                "task-router-draft",
                "Unsent draft edit\(edited.count == 1 ? "" : "s"): \(names).",
                color: Theme.secondaryText))
        }
        for category in edited where !editor.isSendable(category) {
            labels.append(status(
                "task-router-empty-route",
                "\(category.label) has no members yet. Add at least one before sending.",
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

    // MARK: Actions

    @objc private func modeChanged(_ sender: NSSegmentedControl) {
        guard let category = category(for: sender.tag),
              routing.modes.indices.contains(sender.selectedSegment) else { return }
        let route = draftRoute(category)
        onEditRoute(category, RoutingPolicyDocument.WireRoute(
            mode: routing.modes[sender.selectedSegment].id,
            candidates: route?.candidates ?? []))
    }

    @objc private func clearTapped(_ sender: NSButton) {
        guard let category = category(for: sender.tag) else { return }
        onEditRoute(category, nil)
    }

    @objc private func configureTapped(_ sender: NSButton) {
        guard let category = category(for: sender.tag) else { return }
        onEditRoute(category, RoutingPolicyDocument.WireRoute(
            mode: routing.defaultMode, candidates: []))
    }

    @objc private func addModelChosen(_ sender: NSMenuItem) {
        guard let category = category(for: sender.tag),
              let key = sender.representedObject as? String,
              let route = draftRoute(category),
              let entry = routing.catalog.first(where: { "\($0.provider)/\($0.model)" == key }),
              !route.candidates.contains(where: {
                  $0.provider == entry.provider && $0.model == entry.model
              }) else { return }
        var candidates = route.candidates
        candidates.append(RoutingPolicyDocument.WireRouteCandidate(
            provider: entry.provider,
            model: entry.model,
            effort: entry.startingEffort,
            weight: routing.weightRange.defaultValue))
        onEditRoute(category, RoutingPolicyDocument.WireRoute(
            mode: route.mode, candidates: candidates))
    }

    /// Remove takes the candidate out of the draft; Restore puts the observed
    /// candidate back exactly as the daemon last had it.
    @objc private func memberTapped(_ sender: NSButton) {
        guard let ref = rowRef(for: sender),
              let route = draftRoute(ref.category) else { return }
        let isMember = route.candidates.contains {
            $0.provider == ref.provider && $0.model == ref.model
        }
        var candidates = route.candidates.filter {
            !($0.provider == ref.provider && $0.model == ref.model)
        }
        if !isMember {
            if let observed = editor.observedRoute(for: ref.category)?.candidates.first(where: {
                $0.provider == ref.provider && $0.model == ref.model
            }) {
                candidates.append(observed)
            } else if let entry = routing.catalog.first(where: {
                $0.provider == ref.provider && $0.model == ref.model
            }) {
                candidates.append(RoutingPolicyDocument.WireRouteCandidate(
                    provider: ref.provider,
                    model: ref.model,
                    effort: entry.startingEffort,
                    weight: routing.weightRange.defaultValue))
            } else {
                return
            }
        }
        onEditRoute(ref.category, RoutingPolicyDocument.WireRoute(
            mode: route.mode, candidates: candidates))
    }

    /// A weight the wire would refuse never becomes a draft. The field keeps what was typed, the reason is stated, and Apply goes dead until it is a number the daemon accepts.
    @objc private func weightChanged(_ sender: NSTextField) {
        guard let ref = rowRef(for: sender) else { return }
        let range = routing.weightRange
        guard let weight = Int(sender.stringValue),
              weight >= range.minimum, weight <= range.maximum else {
            weightRefusal.stringValue = "\(ref.key) on \(ref.category.label): a weight must "
                + "be a whole number from \(range.minimum) to "
                + "\(range.maximum). “\(sender.stringValue)” was not sent."
            weightRefusal.isHidden = false
            applyButton?.isEnabled = false
            return
        }
        edit(ref) { $0.weight = weight }
    }

    @objc private func weightStepDown(_ sender: NSButton) { step(sender, by: -1) }
    @objc private func weightStepUp(_ sender: NSButton) { step(sender, by: 1) }

    private func step(_ sender: NSButton, by delta: Int) {
        guard let ref = rowRef(for: sender),
              let current = draftRoute(ref.category)?.candidates.first(where: {
                  $0.provider == ref.provider && $0.model == ref.model
              })?.weight else { return }
        let range = routing.weightRange
        let next = min(range.maximum, max(range.minimum, current + delta))
        guard next != current else { return }
        edit(ref) { $0.weight = next }
    }

    @objc private func effortChanged(_ sender: NSPopUpButton) {
        guard let ref = rowRef(for: sender),
              let entry = routing.catalog.first(where: {
                  $0.provider == ref.provider && $0.model == ref.model
              }),
              entry.effortOptions.indices.contains(sender.indexOfSelectedItem) else { return }
        edit(ref) { $0.effort = entry.effortOptions[sender.indexOfSelectedItem].effort }
    }

    @objc private func applyTapped(_ sender: NSButton) {
        onApply()
    }

    // MARK: Draft access

    private func draftRoute(_ category: TaskCategory) -> RoutingPolicyDocument.WireRoute? {
        editor.draft.policy.categories[category.rawValue]
    }

    private func isEdited(_ category: TaskCategory) -> Bool {
        editor.draft.policy.categories[category.rawValue]
            != editor.observed.policy.categories[category.rawValue]
    }

    private func category(for tag: Int) -> TaskCategory? {
        categories.indices.contains(tag) ? categories[tag] : nil
    }

    private func rowRef(for sender: NSControl) -> RowRef? {
        rowRefs.indices.contains(sender.tag) ? rowRefs[sender.tag] : nil
    }

    private func edit(
        _ ref: RowRef,
        _ change: (inout RoutingPolicyDocument.WireRouteCandidate) -> Void
    ) {
        guard let route = draftRoute(ref.category) else { return }
        var candidates = route.candidates
        guard let index = candidates.firstIndex(where: {
            $0.provider == ref.provider && $0.model == ref.model
        }) else { return }
        change(&candidates[index])
        onEditRoute(ref.category, RoutingPolicyDocument.WireRoute(
            mode: route.mode, candidates: candidates))
    }

    // MARK: Presentation helpers

    private func effortPresentation(
        _ effort: RoutingPolicyDocument.CandidateEffort
    ) -> String {
        switch effort {
        case .hiveDecides: return "Hive decides"
        case .exact(let value): return value
        case .none: return "No effort setting"
        case .providerControlled: return "Provider controlled"
        case .unknown(let mode): return mode
        }
    }

    private func providerTitle(_ provider: String) -> String {
        switch ProviderID(provider) {
        case .claude: return "Claude"
        case .codex: return "Codex"
        case .grok: return "Grok"
        case .kimi: return "Kimi"
        case .opencode: return "OpenCode"
        default: return ProviderBranding.title(for: ProviderID(provider))
        }
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

    private func columnHead(_ text: String) -> NSView {
        let label = NSTextField(labelWithString: text.uppercased())
        label.font = Theme.Font.sectionLabel
        label.textColor = Theme.tertiaryText
        label.compressHorizontally(priority: 450, toolTip: text.isEmpty ? nil : text)
        compressesHorizontally(label)
        return label
    }

    private func status(_ identifier: String, _ text: String, color: NSColor) -> NSView {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = Theme.Font.callout
        label.textColor = color
        label.maximumNumberOfLines = 0
        label.setAccessibilityIdentifier(identifier)
        return label
    }

    private func truncatingLabel(
        _ text: String,
        font: NSFont,
        color: NSColor,
        priority: Float = 430
    ) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = font
        label.textColor = color
        label.lineBreakMode = .byTruncatingTail
        label.compressHorizontally(priority: priority, toolTip: text)
        return label
    }

    private func compressesHorizontally(_ view: NSView) {
        view.setContentCompressionResistancePriority(.init(250), for: .horizontal)
        view.setContentHuggingPriority(.init(1), for: .horizontal)
    }
}

/// A card's column widths. The header and every candidate row bind to these
/// guides so one long model name cannot push its row's columns out of line
/// with the rows around it. `nil` marks the one flexible column.
private final class CardColumnLayout {

    private let guides: [NSLayoutGuide]

    init(
        owner: NSView,
        content: NSView,
        fixedWidths: [CGFloat?],
        spacing: CGFloat
    ) {
        precondition(fixedWidths.count >= 2)
        guides = fixedWidths.map { _ in NSLayoutGuide() }
        for (index, guide) in guides.enumerated() {
            owner.addLayoutGuide(guide)
            NSLayoutConstraint.activate([
                guide.topAnchor.constraint(equalTo: owner.topAnchor),
                guide.heightAnchor.constraint(equalToConstant: 0),
            ])
            if index == 0 {
                guide.leadingAnchor.constraint(equalTo: content.leadingAnchor).isActive = true
            } else {
                guide.leadingAnchor.constraint(
                    equalTo: guides[index - 1].trailingAnchor, constant: spacing).isActive = true
            }
            if let width = fixedWidths[index] {
                let fixed = guide.widthAnchor.constraint(equalToConstant: width)
                fixed.priority = .defaultHigh
                fixed.isActive = true
            }
        }
        guides.last!.trailingAnchor.constraint(equalTo: content.trailingAnchor).isActive = true
    }

    func bind(_ columns: [NSView]) {
        precondition(columns.count == guides.count)
        for (column, guide) in zip(columns, guides) {
            column.setContentCompressionResistancePriority(.init(1), for: .horizontal)
            column.setContentHuggingPriority(.init(1), for: .horizontal)
            column.widthAnchor.constraint(equalTo: guide.widthAnchor).isActive = true
        }
    }
}

/// `− n +` for a stored weight. The field accepts typing so an exact value
/// is one edit; the buttons move it one step. The view's `tag` is mirrored
/// onto all three controls so one row reference serves them.
private final class WeightStepperView: NSControl {

    let field: NSTextField
    let downButton: NSButton
    let upButton: NSButton

    init(value: Int, target: AnyObject, down: Selector, up: Selector, typed: Selector) {
        field = NSTextField(string: String(value))
        downButton = NSButton(title: "−", target: target, action: down)
        upButton = NSButton(title: "+", target: target, action: up)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.cornerRadius = Theme.Metric.buttonCornerRadius
        layer?.cornerCurve = .continuous
        layer?.borderWidth = 1

        for button in [downButton, upButton] {
            button.bezelStyle = .inline
            button.isBordered = false
            button.font = Theme.Font.chromeControl
            button.contentTintColor = Theme.accent
            button.widthAnchor.constraint(equalToConstant: 24).isActive = true
        }
        downButton.setAccessibilityLabel("Decrease weight")
        upButton.setAccessibilityLabel("Increase weight")

        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.alignment = .center
        field.font = Theme.Font.monoDigits
        field.textColor = Theme.primaryText
        field.target = target
        field.action = typed

        let stack = NSStackView(views: [downButton, field, upButton])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 0
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightAnchor.constraint(equalToConstant: Theme.Metric.controlMinHeight),
        ])
        field.setContentCompressionResistancePriority(.init(250), for: .horizontal)
        field.setContentHuggingPriority(.init(1), for: .horizontal)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var tag: Int {
        didSet {
            field.tag = tag
            downButton.tag = tag
            upButton.tag = tag
        }
    }

    override var isEnabled: Bool {
        didSet {
            field.isEnabled = isEnabled
            field.isEditable = isEnabled
            downButton.isEnabled = isEnabled
            upButton.isEnabled = isEnabled
            alphaValue = isEnabled ? 1 : Theme.disabledContentAlpha
        }
    }

    override func updateLayer() {
        layer?.borderColor = Theme.buttonBorder.cgColor
        layer?.backgroundColor = Theme.insetFill.cgColor
    }
}
