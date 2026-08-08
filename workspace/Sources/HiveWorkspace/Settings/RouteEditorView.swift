import AppKit
import WorkspaceCore

/// One task category's weighted route — or the Global route, which is the same editor wearing a distinct header. A route is an UNORDERED candidate set: there is no rank, no reordering, and no fallback language anywhere. Swift edits membership, mode, and weights; effective shares and candidate eligibility come only from daemon projections.
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
        // Sections keep their fitting height; a stretched card must never pad out a section with dead space.
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

        guard dataSource.view != nil, dataSource.policyLoaded else {
            return
        }

        // A stored route this build cannot read gets its reason, not controls whose writes would rewrite what the user actually configured.
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
                // Informational, not an error: it resolves to the user's Global route, and never "any enabled model".
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
                weightEditable: dataSource.routingMode(route.mode)?.weightEditable ?? false,
                weightRange: dataSource.routingWeightRange,
                status: statuses[index],
                presentation: dataSource.providerPresentation(
                    ProviderID(candidate.provider))?.models.first {
                        $0.canonicalId == candidate.model
                    },
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

    private func makeModeRow(_ route: RoutePolicy) -> NSView {
        let label = NSTextField(labelWithString: MCCCopy.modeControlLabel)
        label.font = Theme.Font.caption
        label.textColor = .secondaryLabelColor
        label.compressHorizontally()

        let popup = NSPopUpButton(frame: .zero, pullsDown: false)
        popup.controlSize = .small
        popup.font = NSFont.systemFont(ofSize: 11)
        let modes = dataSource.routingModes.compactMap { presentation in
            RouterMode(rawValue: presentation.id).map { (presentation, $0) }
        }
        for (presentation, _) in modes {
            popup.addItem(withTitle: presentation.label)
        }
        popup.selectItem(at: modes.firstIndex { $0.1 == route.mode } ?? 0)
        popup.target = self
        popup.action = #selector(modeChanged(_:))
        popup.setAccessibilityLabel("How this route splits spawns")

        let modeCaption = dataSource.routingMode(route.mode)?.caption ?? ""
        let caption = NSTextField(labelWithString: modeCaption)
        caption.font = Theme.Font.caption
        caption.textColor = .tertiaryLabelColor
        caption.lineBreakMode = .byTruncatingTail
        caption.toolTip = modeCaption
        caption.setContentCompressionResistancePriority(.init(440), for: .horizontal)

        let row = NSStackView(views: [label, popup, caption])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = Theme.Space.s
        return row
    }

    @objc private func modeChanged(_ sender: NSPopUpButton) {
        let modes = dataSource.routingModes.compactMap {
            RouterMode(rawValue: $0.id)
        }
        guard var next = route,
              modes.indices.contains(sender.indexOfSelectedItem) else { return }
        next.mode = modes[sender.indexOfSelectedItem]
        writeRoute(next)
    }

    private func makeAddButton() -> NSView {
        let popup = NSPopUpButton(frame: .zero, pullsDown: true)
        popup.controlSize = .small
        popup.font = NSFont.systemFont(ofSize: 11)
        popup.addItem(withTitle: "Add model…")
        popup.setAccessibilityLabel("Add a model and effort to this route")

        guard let defaultWeight = dataSource.routingWeightRange?.defaultValue else {
            popup.isEnabled = false
            return popup
        }

        let catalog = Dictionary(grouping: dataSource.routingCatalog, by: \.provider)
        for providerID in dataSource.providerIDs {
            guard let models = catalog[providerID.rawValue], !models.isEmpty else { continue }
            let providerTitle = ProviderBranding.title(for: providerID)
            let header = NSMenuItem(title: providerTitle, action: nil, keyEquivalent: "")
            header.isEnabled = false
            popup.menu?.addItem(header)
            for model in models {
                guard let presentation = dataSource.providerPresentation(providerID)?
                    .model(canonicalID: model.model) else { continue }
                let name = presentation.name
                let item = NSMenuItem(title: "  \(name)", action: nil, keyEquivalent: "")
                item.toolTip = presentation.displayId
                let options = model.addEffortOptions
                if options.count > 1 {
                    let submenu = NSMenu(title: name)
                    for option in options {
                        let levelItem = NSMenuItem(
                            title: option.label,
                            action: #selector(addCandidate(_:)), keyEquivalent: "")
                        levelItem.target = self
                        levelItem.representedObject = RouteCandidateBox(
                            candidate: RouteCandidate(
                                provider: providerID.rawValue,
                                model: model.model,
                                effort: option.effort.asEffortTarget,
                                weight: defaultWeight))
                        submenu.addItem(levelItem)
                    }
                    item.submenu = submenu
                } else if let option = options.first {
                    item.title = "  \(name)  —  \(option.label)"
                    item.action = #selector(addCandidate(_:))
                    item.target = self
                    item.representedObject = RouteCandidateBox(
                        candidate: RouteCandidate(
                            provider: providerID.rawValue,
                            model: model.model,
                            effort: option.effort.asEffortTarget,
                            weight: defaultWeight))
                } else {
                    item.isEnabled = false
                }
                popup.menu?.addItem(item)
            }
        }
        return popup
    }

    @objc private func addCandidate(_ sender: NSMenuItem) {
        guard let box = sender.representedObject as? RouteCandidateBox,
              let defaultMode = dataSource.defaultRoutingMode else { return }
        let current = route ?? RoutePolicy(mode: defaultMode, candidates: [])
        guard !current.candidates.contains(where: {
            $0.targetKey == box.candidate.targetKey
        }) else { return }
        var next = current
        next.candidates.append(box.candidate)
        writeRoute(next)
    }
}

private final class RouteCandidateBox {
    let candidate: RouteCandidate
    init(candidate: RouteCandidate) { self.candidate = candidate }
}

/// One route candidate: vendor mark, target description, expected-share preview, per-candidate effort and weight, a remove control, and the honest status badge when the candidate cannot run.
final class RouteCandidateRowView: NSView {

    init(
        candidate: RouteCandidate,
        weightEditable: Bool,
        weightRange: WorkspaceRoutingWeightRange?,
        status: RouteCandidateStatus,
        presentation: WorkspaceModelPresentation?,
        struck: Bool,
        onWeight: @escaping (Int) -> Void,
        onRemove: @escaping () -> Void,
        onEffort: @escaping (EffortTarget) -> Void
    ) {
        self.weightRange = weightRange
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        self.onRemove = onRemove
        self.onWeight = onWeight

        let providerID = ProviderID(candidate.provider)
        let mark = ProviderMarkView(
            provider: providerID, size: Theme.Metric.chainMarkSize)

        let providerTitle = ProviderBranding.title(for: providerID)
        let name = presentation?.name ?? candidate.model
        let text = "\(providerTitle) · \(name)"

        let label = NSTextField(labelWithString: text)
        label.font = Theme.Font.body
        label.lineBreakMode = .byTruncatingTail
        label.toolTip = presentation?.displayId ?? candidate.model
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

        let effortAxis = presentation?.effortAxis.rendered
            ?? EffortAxis.unknown(reason: "model not in the live catalog")
        let effort = EffortControlView(
            axis: effortAxis, selection: candidate.effort, enabled: status == .effective)
        effort.onSelect = onEffort
        effort.setContentHuggingPriority(.defaultHigh, for: .horizontal)

        var views: [NSView] = [mark, label]
        if let badge { views.append(badge) }
        views.append(NSView.spacer())
        views.append(effort)
        if weightEditable && weightRange != nil {
            views.append(makeWeightControl(candidate.weight, model: text))
        }
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
        setAccessibilityLabel("\(text), weight \(candidate.weight)")
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private var onRemove: (() -> Void)?
    private var onWeight: ((Int) -> Void)?
    private let weightRange: WorkspaceRoutingWeightRange?
    private let weightField = NSTextField()
    private let weightStepper = NSStepper()

    private func makeWeightControl(_ weight: Int, model: String) -> NSView {
        guard let weightRange else { return NSView() }
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
        weightStepper.minValue = Double(weightRange.minimum)
        weightStepper.maxValue = Double(weightRange.maximum)
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
        guard let weightRange else { return }
        let clamped = min(weightRange.maximum, max(weightRange.minimum, sender.integerValue))
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
