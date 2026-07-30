import AppKit
import WorkspaceCore

/// One task category's weighted route — or the Global route, which is the
/// same editor wearing a distinct header.
///
/// A route is an UNORDERED candidate set: there is no rank, no reordering,
/// and no fallback language anywhere. The controls are membership (add /
/// remove), the split mode (weighted vs equal), a per-candidate weight in
/// weighted mode, and an expected-share preview per candidate. An empty
/// category is informational (it uses the Global route); a route whose every
/// candidate is off or unavailable refuses — there is no quiet widening.
final class RouteSectionView: NSView {

    enum Kind {
        case category(TaskCategory)
        case global
    }

    private let kind: Kind
    private let dataSource: ModelControlDataSource

    init(kind: Kind, dataSource: ModelControlDataSource) {
        self.kind = kind
        self.dataSource = dataSource
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        // Sections keep their fitting height; a stretched card must never
        // pad out a section with dead space.
        setContentHuggingPriority(.required, for: .vertical)
        rebuild()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private var category: TaskCategory? {
        if case .category(let category) = kind { return category }
        return nil
    }

    private var route: RoutePolicy? {
        dataSource.route(category)
    }

    private func writeRoute(_ route: RoutePolicy?) {
        dataSource.setRoute(category, route)
    }

    private func rebuild() {
        subviews.forEach { $0.removeFromSuperview() }
        let stack = NSStackView()
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.s
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        let titleText: String
        var subtitleText: String?
        switch kind {
        case .category(let category):
            titleText = category.label
        case .global:
            titleText = MCCCopy.globalRouteTitle
            subtitleText = MCCCopy.globalRouteSubtitle
        }
        let title = NSTextField(labelWithString: titleText)
        title.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        title.compressHorizontally()
        stack.addArrangedSubview(title)
        if let subtitleText {
            let subtitle = NSTextField(wrappingLabelWithString: subtitleText)
            subtitle.font = Theme.Font.caption
            subtitle.textColor = .secondaryLabelColor
            subtitle.compressHorizontally()
            stack.addArrangedSubview(subtitle)
            subtitle.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        guard let snapshot = dataSource.snapshot, dataSource.policyLoaded else {
            return
        }

        // A stored route this build cannot read gets its reason, not controls
        // whose writes would rewrite what the user actually configured.
        if let reason = dataSource.routeUnreadableReason(category) {
            let note = NSTextField(wrappingLabelWithString: reason)
            note.font = Theme.Font.caption
            note.textColor = .secondaryLabelColor
            note.compressHorizontally()
            stack.addArrangedSubview(note)
            note.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            return
        }

        guard let route else {
            switch kind {
            case .category:
                // Informational, not an error: it resolves to the user's
                // Global route, and never "any enabled model".
                let empty = NSTextField(labelWithString: MCCCopy.routeEmptyUsesGlobal)
                empty.font = Theme.Font.caption
                empty.textColor = .secondaryLabelColor
                empty.compressHorizontally()
                stack.addArrangedSubview(empty)
            case .global:
                let warning = CapsuleBadge(
                    text: MCCCopy.warnNoGlobalRoute,
                    symbol: "exclamationmark.triangle.fill", style: .warning)
                stack.addArrangedSubview(warning)
            }
            stack.addArrangedSubview(makeAddButton())
            return
        }

        stack.addArrangedSubview(makeModeRow(route))

        let statuses = route.candidates.map { dataSource.candidateStatus($0) }
        let allIneffective = !statuses.contains(.effective)
        for (index, candidate) in route.candidates.enumerated() {
            let row = RouteCandidateRowView(
                candidate: candidate,
                sharePercent: Self.percent(route.expectedShare(of: candidate)),
                weightEditable: route.mode == .userWeighted,
                status: statuses[index], snapshot: snapshot,
                struck: allIneffective,
                onWeight: { [weak self] weight in
                    guard let self, var next = self.route else { return }
                    next.candidates[index].weight = weight
                    self.writeRoute(next)
                },
                onRemove: { [weak self] in
                    guard let self, var next = self.route else { return }
                    next.candidates.remove(at: index)
                    self.writeRoute(next.candidates.isEmpty ? nil : next)
                },
                onEffort: { [weak self] effort in
                    guard let self, var next = self.route else { return }
                    next.candidates[index].effort = effort
                    self.writeRoute(next)
                })
            stack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        if let aggregate = providerAggregateText(route) {
            let caption = NSTextField(labelWithString: aggregate)
            caption.font = Theme.Font.caption
            caption.textColor = .tertiaryLabelColor
            caption.lineBreakMode = .byTruncatingTail
            caption.toolTip = aggregate
            caption.setContentCompressionResistancePriority(.init(440), for: .horizontal)
            stack.addArrangedSubview(caption)
            caption.widthAnchor.constraint(
                lessThanOrEqualTo: stack.widthAnchor).isActive = true
        }

        if allIneffective {
            let note = NSTextField(wrappingLabelWithString: MCCCopy.routeAllIneffective)
            note.font = Theme.Font.callout
            note.textColor = .systemOrange
            note.compressHorizontally()
            stack.addArrangedSubview(note)
            note.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        stack.addArrangedSubview(makeAddButton())
    }

    static func percent(_ share: Double) -> Int {
        Int((share * 100).rounded())
    }

    /// The per-vendor sum of expected shares — shown only when some provider
    /// holds more than one candidate, where the per-row numbers stop being
    /// the per-vendor answer.
    private func providerAggregateText(_ route: RoutePolicy) -> String? {
        var counts: [String: Int] = [:]
        for candidate in route.candidates {
            counts[candidate.provider, default: 0] += 1
        }
        guard counts.values.contains(where: { $0 > 1 }) else { return nil }
        let shares = route.providerShares
            .sorted { ProviderID($0.key) < ProviderID($1.key) }
            .map { (ProviderBranding.title(for: ProviderID($0.key)), Self.percent($0.value)) }
        return MCCCopy.providerShares(shares.map { (title: $0.0, percent: $0.1) })
    }

    // MARK: Mode

    private func makeModeRow(_ route: RoutePolicy) -> NSView {
        let label = NSTextField(labelWithString: MCCCopy.modeControlLabel)
        label.font = Theme.Font.caption
        label.textColor = .secondaryLabelColor
        label.compressHorizontally()

        let popup = NSPopUpButton(frame: .zero, pullsDown: false)
        popup.controlSize = .small
        popup.font = NSFont.systemFont(ofSize: 11)
        for mode in RouterMode.allCases {
            popup.addItem(withTitle: MCCCopy.modeTitle(mode))
        }
        popup.selectItem(at: RouterMode.allCases.firstIndex(of: route.mode) ?? 0)
        popup.target = self
        popup.action = #selector(modeChanged(_:))
        popup.setAccessibilityLabel("How this route splits spawns")

        let caption = NSTextField(labelWithString: MCCCopy.modeCaption(route.mode))
        caption.font = Theme.Font.caption
        caption.textColor = .tertiaryLabelColor
        caption.lineBreakMode = .byTruncatingTail
        caption.toolTip = MCCCopy.modeCaption(route.mode)
        caption.setContentCompressionResistancePriority(.init(440), for: .horizontal)

        let row = NSStackView(views: [label, popup, caption])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = Theme.Space.s
        return row
    }

    @objc private func modeChanged(_ sender: NSPopUpButton) {
        guard var next = route,
              RouterMode.allCases.indices.contains(sender.indexOfSelectedItem) else { return }
        next.mode = RouterMode.allCases[sender.indexOfSelectedItem]
        writeRoute(next)
    }

    // MARK: Add

    /// The add picker. THE ATOM IS A (MODEL, EFFORT) PAIR: each model opens a
    /// submenu of its advertised efforts, so adding fable-5@low is one
    /// action and every advertised combination is reachable. Every item names
    /// an EXACT model — there is no vendor-default candidate and no "default"
    /// anywhere; the user chooses specific models. A model whose vendor
    /// states there is no effort axis adds directly (nothing to pick); one
    /// whose effort surface is unreadable adds with the flag omitted and the
    /// measured reason in its tooltip.
    private func makeAddButton() -> NSView {
        let popup = NSPopUpButton(frame: .zero, pullsDown: true)
        popup.controlSize = .small
        popup.font = NSFont.systemFont(ofSize: 11)
        popup.addItem(withTitle: "Add model…")
        popup.setAccessibilityLabel("Add a model and effort to this route")

        guard let snapshot = dataSource.snapshot else { return popup }
        for providerID in snapshot.providerIDs {
            guard case .available(let models, _)? =
                snapshot.providers[providerID.rawValue] else { continue }
            let providerTitle = ProviderBranding.title(for: providerID)
            let header = NSMenuItem(title: providerTitle, action: nil, keyEquivalent: "")
            header.isEnabled = false
            popup.menu?.addItem(header)
            for model in models {
                let name = model.humanName
                let item = NSMenuItem(title: "  \(name)", action: nil, keyEquivalent: "")
                item.toolTip = model.displayId
                switch EffortAxis.derive(from: model) {
                case .known(let levels, let defaultLevel):
                    let submenu = NSMenu(title: name)
                    for level in levels {
                        let suffix = level == defaultLevel ? "  (vendor recommends)" : ""
                        let levelItem = NSMenuItem(
                            title: "\(level)\(suffix)",
                            action: #selector(addCandidate(_:)), keyEquivalent: "")
                        levelItem.target = self
                        levelItem.representedObject = RouteCandidateBox(
                            candidate: RouteCandidate(
                                provider: providerID.rawValue,
                                model: model.canonicalId,
                                effort: .exact(level)))
                        submenu.addItem(levelItem)
                    }
                    item.submenu = submenu
                case .none:
                    item.title = "  \(name)  —  no effort setting"
                    item.action = #selector(addCandidate(_:))
                    item.target = self
                    item.representedObject = RouteCandidateBox(
                        candidate: RouteCandidate(
                            provider: providerID.rawValue,
                            model: model.canonicalId,
                            effort: EffortTarget.none))
                case .unknown(let reason):
                    item.title = "  \(name)  —  effort unknown"
                    item.toolTip = MCCCopy.effortUnknown(reason)
                    item.action = #selector(addCandidate(_:))
                    item.target = self
                    item.representedObject = RouteCandidateBox(
                        candidate: RouteCandidate(
                            provider: providerID.rawValue,
                            model: model.canonicalId,
                            effort: .providerControlled))
                }
                popup.menu?.addItem(item)
            }
        }
        return popup
    }

    @objc private func addCandidate(_ sender: NSMenuItem) {
        guard let box = sender.representedObject as? RouteCandidateBox else { return }
        let current = route ?? RoutePolicy(mode: .hiveEqual, candidates: [])
        guard !current.candidates.contains(where: {
            $0.targetKey == box.candidate.targetKey
        }) else { return }
        var next = current
        next.candidates.append(box.candidate)
        writeRoute(next)
    }
}

/// NSMenuItem.representedObject needs a class.
private final class RouteCandidateBox {
    let candidate: RouteCandidate
    init(candidate: RouteCandidate) { self.candidate = candidate }
}

/// One route candidate: vendor mark, target description, expected-share
/// preview, per-candidate effort and weight, a remove control, and the honest
/// status badge when the candidate cannot run.
final class RouteCandidateRowView: NSView {

    init(
        candidate: RouteCandidate,
        sharePercent: Int,
        weightEditable: Bool,
        status: RouteCandidateStatus,
        snapshot: ModelControlSnapshot,
        struck: Bool,
        onWeight: @escaping (Int) -> Void,
        onRemove: @escaping () -> Void,
        onEffort: @escaping (EffortTarget) -> Void
    ) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        self.onRemove = onRemove
        self.onWeight = onWeight

        let providerID = ProviderID(candidate.provider)
        let mark = ProviderMarkView(
            provider: providerID, size: Theme.Metric.chainMarkSize)

        // Resolve the exact target against the live catalog for display: the
        // vendor's own model name, with the launch identity in the tooltip so
        // there is never ambiguity about what will run.
        var resolvedModel: DiscoveredModel?
        let providerTitle = ProviderBranding.title(for: providerID)
        if case .available(let models, _)? = snapshot.providers[candidate.provider] {
            resolvedModel = models.first {
                $0.canonicalId == candidate.model
            }
        }
        let name = resolvedModel?.humanName ?? candidate.model
        let text = "\(providerTitle) · \(name)"

        let label = NSTextField(labelWithString: text)
        label.font = Theme.Font.body
        label.lineBreakMode = .byTruncatingTail
        label.toolTip = resolvedModel?.displayId ?? candidate.model
        label.setContentCompressionResistancePriority(.init(465), for: .horizontal)
        if struck {
            label.attributedStringValue = NSAttributedString(
                string: text,
                attributes: [
                    .strikethroughStyle: NSUnderlineStyle.single.rawValue,
                    .foregroundColor: NSColor.secondaryLabelColor,
                    .font: Theme.Font.body,
                ])
        }

        let share = NSTextField(labelWithString: MCCCopy.expectedShare(sharePercent))
        share.font = Theme.Font.caption
        share.textColor = .secondaryLabelColor
        share.toolTip = MCCCopy.expectedShareTooltip(sharePercent)
        share.setContentHuggingPriority(.required, for: .horizontal)

        var badge: CapsuleBadge?
        switch status {
        case .effective: break
        case .providerOff:
            badge = CapsuleBadge(
                text: MCCCopy.modelOverriddenByProvider(providerTitle),
                symbol: "power", style: .warning)
        case .modelDisabled:
            badge = CapsuleBadge(
                text: MCCCopy.modelDisabledSelf, symbol: "switch.2", style: .warning)
        case .awaitingConsent:
            badge = CapsuleBadge(
                text: MCCCopy.seededOffBadge, symbol: "shield", style: .info)
        case .unresolvable:
            badge = CapsuleBadge(
                text: MCCCopy.badgeUnresolvable,
                symbol: "questionmark.diamond", style: .warning)
        }

        let effortAxis: EffortAxis = resolvedModel.map(EffortAxis.derive) ??
            .unknown(reason: "model not in the live catalog")
        let effort = EffortControlView(
            axis: effortAxis, selection: candidate.effort, enabled: status == .effective)
        effort.onSelect = onEffort
        effort.setContentHuggingPriority(.defaultHigh, for: .horizontal)

        var views: [NSView] = [mark, label]
        if let badge { views.append(badge) }
        views.append(NSView.spacer())
        views.append(effort)
        if weightEditable {
            views.append(makeWeightControl(candidate.weight, model: text))
        }
        views.append(share)
        views.append(makeRemoveButton())
        let row = NSStackView(views: views)
        row.translatesAutoresizingMaskIntoConstraints = false
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = Theme.Space.s

        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightAnchor.constraint(
                greaterThanOrEqualToConstant: Theme.Metric.controlMinHeight),
        ])

        if status != .effective {
            alphaValue = Theme.disabledContentAlpha
        }

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(MCCCopy.a11yRouteCandidate(text, sharePercent))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private var onRemove: (() -> Void)?
    private var onWeight: ((Int) -> Void)?
    private let weightField = NSTextField()
    private let weightStepper = NSStepper()

    /// Weight 1–100, typed or stepped. Committed values are clamped; the
    /// route rewrite happens on commit, not per keystroke.
    private func makeWeightControl(_ weight: Int, model: String) -> NSView {
        weightField.translatesAutoresizingMaskIntoConstraints = false
        weightField.controlSize = .small
        weightField.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        weightField.alignment = .right
        weightField.stringValue = String(weight)
        weightField.target = self
        weightField.action = #selector(weightTyped(_:))
        weightField.setAccessibilityLabel(MCCCopy.a11yWeight(model))
        weightField.widthAnchor.constraint(equalToConstant: 36).isActive = true

        weightStepper.translatesAutoresizingMaskIntoConstraints = false
        weightStepper.controlSize = .small
        weightStepper.minValue = 1
        weightStepper.maxValue = 100
        weightStepper.increment = 1
        weightStepper.integerValue = weight
        weightStepper.target = self
        weightStepper.action = #selector(weightStepped(_:))
        weightStepper.setAccessibilityLabel(MCCCopy.a11yWeight(model))

        let control = NSStackView(views: [weightField, weightStepper])
        control.orientation = .horizontal
        control.alignment = .centerY
        control.spacing = 2
        return control
    }

    @objc private func weightTyped(_ sender: NSTextField) {
        let clamped = min(100, max(1, sender.integerValue))
        sender.stringValue = String(clamped)
        weightStepper.integerValue = clamped
        onWeight?(clamped)
    }

    @objc private func weightStepped(_ sender: NSStepper) {
        weightField.stringValue = String(sender.integerValue)
        onWeight?(sender.integerValue)
    }

    private func makeRemoveButton() -> NSButton {
        let button = NSButton(
            image: NSImage(
                systemSymbolName: "minus.circle",
                accessibilityDescription: "Remove from route")!
                .withSymbolConfiguration(.init(pointSize: 10, weight: .semibold))!,
            target: self, action: #selector(removeTapped))
        button.bezelStyle = .accessoryBarAction
        button.isBordered = false
        button.contentTintColor = .secondaryLabelColor
        button.setAccessibilityLabel("Remove from route")
        return button
    }

    @objc private func removeTapped() { onRemove?() }
}
