import AppKit
import WorkspaceCore

/// One task category's ordered fallback chain — or the Default (global
/// fallback) chain, which is the same editor wearing a distinct header and no
/// exhaustion control.
///
/// The language is fallback language everywhere: rank labels are "Primary",
/// "2nd", "3rd"; nothing here ever says or implies "also run" or "ensemble"
/// (spec §8.2). An empty category is informational (it uses the Default
/// chain); an exhausted deliberate chain is a different fact with its own
/// per-category control (Refuse vs use Default), defaulting to Refuse.
final class ChainSectionView: NSView {

    enum Kind {
        case category(TaskCategory)
        case defaultChain
    }

    private let kind: Kind
    private let dataSource: ModelControlDataSource

    init(kind: Kind, dataSource: ModelControlDataSource) {
        self.kind = kind
        self.dataSource = dataSource
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        rebuild()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private var chain: [ChainEntry] {
        guard let policy = dataSource.policy else { return [] }
        switch kind {
        case .category(let category): return policy.categoryPolicy(category).chain
        case .defaultChain: return policy.defaultChain
        }
    }

    private func writeChain(_ chain: [ChainEntry]) {
        dataSource.mutatePolicy { policy in
            switch kind {
            case .category(let category):
                policy.setCategoryChain(category, chain: chain)
            case .defaultChain:
                policy.defaultChain = chain
                policy.provisional = false
            }
        }
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

        // ── Header
        let titleText: String
        var subtitleText: String?
        switch kind {
        case .category(let category):
            titleText = category.label
        case .defaultChain:
            titleText = MCCCopy.defaultChainTitle
            subtitleText = MCCCopy.defaultChainSubtitle
        }
        let title = NSTextField(labelWithString: titleText)
        title.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        stack.addArrangedSubview(title)
        if let subtitleText {
            let subtitle = NSTextField(wrappingLabelWithString: subtitleText)
            subtitle.font = Theme.Font.caption
            subtitle.textColor = .secondaryLabelColor
            stack.addArrangedSubview(subtitle)
            subtitle.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        let entries = chain
        guard let snapshot = dataSource.snapshot, let policy = dataSource.policy else {
            return
        }

        // ── Empty chain
        if entries.isEmpty {
            switch kind {
            case .category:
                // Informational, not an error: it walks the user's Default
                // chain, and never "any enabled model".
                let empty = NSTextField(labelWithString: MCCCopy.chainEmptyUsesDefault)
                empty.font = Theme.Font.caption
                empty.textColor = .secondaryLabelColor
                stack.addArrangedSubview(empty)
            case .defaultChain:
                let warning = CapsuleBadge(
                    text: MCCCopy.warnDefaultChainEmpty,
                    symbol: "exclamationmark.triangle.fill", style: .warning)
                stack.addArrangedSubview(warning)
            }
            stack.addArrangedSubview(makeAddButton())
            return
        }

        // ── Rows
        let statuses = entries.map {
            ChainLinkStatus.derive(entry: $0, policy: policy, snapshot: snapshot)
        }
        let allIneffective = !statuses.contains(.effective)
        for (index, entry) in entries.enumerated() {
            let row = ChainRowView(
                entry: entry, index: index, total: entries.count,
                status: statuses[index], snapshot: snapshot,
                struck: allIneffective,
                onMoveUp: index == 0 ? nil : { [weak self] in
                    guard let self else { return }
                    self.writeChain(ModelControlPolicy.move(
                        self.chain, from: index, to: index - 1))
                },
                onMoveDown: index == entries.count - 1 ? nil : { [weak self] in
                    guard let self else { return }
                    self.writeChain(ModelControlPolicy.move(
                        self.chain, from: index, to: index + 1))
                },
                onRemove: { [weak self] in
                    guard let self else { return }
                    var next = self.chain
                    next.remove(at: index)
                    self.writeChain(next)
                },
                onEffort: { [weak self] effort in
                    guard let self else { return }
                    var next = self.chain
                    next[index].effort = effort
                    self.writeChain(next)
                })
            stack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        if allIneffective {
            let note = NSTextField(wrappingLabelWithString:
                MCCCopy.chainAllIneffective + " " + exhaustionConsequence())
            note.font = Theme.Font.callout
            note.textColor = .systemOrange
            stack.addArrangedSubview(note)
            note.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        stack.addArrangedSubview(makeAddButton())

        // ── Exhaustion control (categories with a deliberate chain only)
        if case .category(let category) = kind {
            let behavior = policy.categoryPolicy(category).exhaustionBehavior
            let popup = NSPopUpButton(frame: .zero, pullsDown: false)
            popup.controlSize = .small
            popup.font = NSFont.systemFont(ofSize: 11)
            popup.addItem(withTitle: "Refuse")
            popup.addItem(withTitle: "Use Default chain")
            popup.selectItem(at: behavior == .refuse ? 0 : 1)
            popup.target = self
            popup.action = #selector(exhaustionChanged(_:))
            popup.setAccessibilityLabel("If every model above is unavailable")

            let label = NSTextField(labelWithString: "If every model above is unavailable:")
            label.font = Theme.Font.caption
            label.textColor = .secondaryLabelColor
            let row = NSStackView(views: [label, popup])
            row.orientation = .horizontal
            row.alignment = .centerY
            row.spacing = Theme.Space.s
            stack.addArrangedSubview(row)

            let consequence = NSTextField(wrappingLabelWithString: exhaustionConsequence())
            consequence.font = Theme.Font.caption
            consequence.textColor = .tertiaryLabelColor
            stack.addArrangedSubview(consequence)
            consequence.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
    }

    private func exhaustionConsequence() -> String {
        guard case .category(let category) = kind, let policy = dataSource.policy else {
            return ""
        }
        switch policy.categoryPolicy(category).exhaustionBehavior {
        case .refuse: return MCCCopy.chainExhaustionRefuse
        case .useGlobalFallback: return MCCCopy.chainExhaustionWiden
        }
    }

    @objc private func exhaustionChanged(_ sender: NSPopUpButton) {
        guard case .category(let category) = kind else { return }
        dataSource.mutatePolicy {
            $0.setExhaustionBehavior(
                category, sender.indexOfSelectedItem == 0 ? .refuse : .useGlobalFallback)
        }
    }

    // MARK: Add

    private func makeAddButton() -> NSView {
        let popup = NSPopUpButton(frame: .zero, pullsDown: true)
        popup.controlSize = .small
        popup.font = NSFont.systemFont(ofSize: 11)
        popup.addItem(withTitle: "Add model…")
        popup.setAccessibilityLabel("Add model to this chain")

        guard let snapshot = dataSource.snapshot else { return popup }
        for providerID in snapshot.providerIDs {
            guard case .available(let models, let effectiveDefault)? =
                snapshot.providers[providerID.rawValue] else { continue }
            let providerTitle = ProviderBranding.title(for: providerID)
            let header = NSMenuItem(title: providerTitle, action: nil, keyEquivalent: "")
            header.isEnabled = false
            popup.menu?.addItem(header)
            for model in models {
                let name = model.displayName ?? model.canonicalId
                let item = NSMenuItem(
                    title: "  \(name)", action: #selector(addEntry(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = ChainEntryBox(entry: ChainEntry(
                    target: .exact(
                        provider: providerID.rawValue,
                        model: model.canonicalId, variant: model.variant),
                    effort: .providerControlled))
                popup.menu?.addItem(item)
            }
            // The one labeled exception to exact targets: tracking the
            // vendor's moving default, opt-in and visibly volatile (§8.3).
            let currentDefault = effectiveDefault.model.value ?? "unknown"
            let item = NSMenuItem(
                title: "  Vendor default (currently \(currentDefault))",
                action: #selector(addEntry(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = ChainEntryBox(entry: ChainEntry(
                target: .vendorDefault(provider: providerID.rawValue),
                effort: .providerControlled))
            popup.menu?.addItem(item)
        }
        return popup
    }

    @objc private func addEntry(_ sender: NSMenuItem) {
        guard let box = sender.representedObject as? ChainEntryBox else { return }
        // No duplicate chain targets (governing doc §2.3 validation).
        guard !chain.contains(where: { $0.target == box.entry.target }) else { return }
        writeChain(chain + [box.entry])
    }
}

/// NSMenuItem.representedObject needs a class.
private final class ChainEntryBox {
    let entry: ChainEntry
    init(entry: ChainEntry) { self.entry = entry }
}

/// One chain link: rank label, vendor mark, target description, per-link
/// effort, reorder and remove controls, and the honest status badge when the
/// link cannot run.
final class ChainRowView: NSView {

    init(
        entry: ChainEntry, index: Int, total: Int,
        status: ChainLinkStatus,
        snapshot: ModelControlSnapshot,
        struck: Bool,
        onMoveUp: (() -> Void)?,
        onMoveDown: (() -> Void)?,
        onRemove: @escaping () -> Void,
        onEffort: @escaping (EffortTarget) -> Void
    ) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        self.onRemove = onRemove
        self.onMoveUpAction = onMoveUp
        self.onMoveDownAction = onMoveDown

        let providerID = ProviderID(entry.provider)
        let rank = CapsuleBadge(
            text: MCCCopy.rankLabel(index), symbol: nil,
            style: index == 0 ? .info : .neutral)

        let mark = ProviderMarkView(
            provider: providerID, size: Theme.Metric.chainMarkSize)

        // Resolve the target against the live catalog for display.
        var resolvedModel: DiscoveredModel?
        var text: String
        let providerTitle = ProviderBranding.title(for: providerID)
        switch entry.target {
        case .exact(_, let model, let variant):
            if case .available(let models, _)? = snapshot.providers[entry.provider] {
                resolvedModel = models.first {
                    $0.canonicalId == model && $0.variant == variant
                }
            }
            let name = resolvedModel?.displayName ?? model
            text = "\(providerTitle) · \(name)"
        case .vendorDefault:
            var current = "unknown"
            if case .available(let models, let effectiveDefault)? =
                snapshot.providers[entry.provider] {
                if let defaultId = effectiveDefault.model.value {
                    current = defaultId
                    resolvedModel = models.first { $0.canonicalId == defaultId }
                }
            }
            text = "\(providerTitle) · \(MCCCopy.chainVendorDefault(current))"
        }

        let label = NSTextField(labelWithString: text)
        label.font = Theme.Font.body
        label.lineBreakMode = .byTruncatingTail
        label.toolTip = {
            if case .vendorDefault = entry.target { return MCCCopy.chainVendorDefaultNote }
            return text
        }()
        label.setContentCompressionResistancePriority(.init(720), for: .horizontal)
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
        case .unresolvable:
            badge = CapsuleBadge(
                text: MCCCopy.badgeUnresolvable,
                symbol: "questionmark.diamond", style: .warning)
        }

        let effortAxis: EffortAxis = resolvedModel.map(EffortAxis.derive) ??
            .unknown(reason: "model not in the live catalog")
        let effort = EffortControlView(
            axis: effortAxis, selection: entry.effort, enabled: status == .effective)
        effort.onSelect = onEffort
        effort.setContentHuggingPriority(.defaultHigh, for: .horizontal)

        let up = makeArrowButton(
            symbol: "chevron.up", label: "Move up", enabled: onMoveUp != nil,
            action: #selector(moveUpTapped))
        let down = makeArrowButton(
            symbol: "chevron.down", label: "Move down", enabled: onMoveDown != nil,
            action: #selector(moveDownTapped))
        let remove = makeArrowButton(
            symbol: "minus.circle", label: "Remove from chain", enabled: true,
            action: #selector(removeTapped))

        var views: [NSView] = [rank, mark, label]
        if let badge { views.append(badge) }
        views.append(NSView.spacer())
        views.append(contentsOf: [effort, up, down, remove])
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
        setAccessibilityLabel(MCCCopy.a11yChainRank(text, index + 1, total))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private var onRemove: (() -> Void)?
    private var onMoveUpAction: (() -> Void)?
    private var onMoveDownAction: (() -> Void)?

    private func makeArrowButton(
        symbol: String, label: String, enabled: Bool, action: Selector
    ) -> NSButton {
        let button = NSButton(
            image: NSImage(systemSymbolName: symbol, accessibilityDescription: label)!
                .withSymbolConfiguration(.init(pointSize: 10, weight: .semibold))!,
            target: self, action: action)
        button.bezelStyle = .accessoryBarAction
        button.isBordered = false
        button.isEnabled = enabled
        button.contentTintColor = .secondaryLabelColor
        button.setAccessibilityLabel(label)
        return button
    }

    @objc private func moveUpTapped() { onMoveUpAction?() }
    @objc private func moveDownTapped() { onMoveDownAction?() }
    @objc private func removeTapped() { onRemove?() }
}
