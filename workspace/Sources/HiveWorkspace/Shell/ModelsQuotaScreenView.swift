
import AppKit
import WorkspaceCore

enum ShellProviderProbeRefreshState: Equatable {
    case idle
    case refreshing
    case succeeded(String)
    case failed(String)
}

final class ModelsQuotaScreenView: NSView {
    init(
        screen: ShellScreenProjection,
        view: WorkspaceModelControlView?,
        mutationsAllowed: Bool,
        probeState: ShellProviderProbeRefreshState,
        onProbe: @escaping () -> Void,
        onWrite: @escaping (ShellPolicyWrite) -> Void
    ) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        let probe = ActionButton(
            title: probeState == .refreshing
                ? "Refreshing provider probes…"
                : "Refresh providers",
            symbol: "arrow.clockwise",
            target: ShellButtonTarget.shared,
            action: #selector(ShellButtonTarget.fire(_:)))
        probe.isEnabled = probeState != .refreshing
        probe.setAccessibilityIdentifier("models-quota-probe-refresh")
        ShellButtonTarget.shared.register(probe, action: onProbe)

        let stack = NSStackView(views: [
            PageHeaderView(
                title: "Models & Quota",
                subtitle: "Enablement is user consent. Usage is capacity evidence as published; it does not rank candidates or refuse a launch.",
                actions: [probe]),
            QueenProviderScreenView.provenance(screen),
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.m
        stack.translatesAutoresizingMaskIntoConstraints = false

        if let status = Self.probeStatus(probeState) {
            stack.addArrangedSubview(status)
            status.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        if let view {
            let cards = Self.providerCards(
                view: view,
                writable: mutationsAllowed,
                onWrite: onWrite)
            let grid = NSGridView(views: Self.gridRows(cards))
            grid.translatesAutoresizingMaskIntoConstraints = false
            grid.rowSpacing = Theme.Space.m
            grid.columnSpacing = Theme.Space.m
            grid.xPlacement = .fill
            grid.yPlacement = .fill
            stack.addArrangedSubview(grid)
            grid.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            Self.equalizeWidths(cards)

            if !screen.facts.isEmpty {
                let evidence = SectionCardView(
                    title: "Capacity evidence",
                    subtitle: "as published, never re-derived here")
                evidence.setAccessibilityIdentifier("models-quota-evidence")
                let rows = Self.compactEvidence(screen.facts).map(Self.evidenceRow)
                let evidenceGrid = NSGridView(views: Self.gridRows(rows, columns: 2))
                evidenceGrid.translatesAutoresizingMaskIntoConstraints = false
                evidenceGrid.rowSpacing = Theme.Space.s
                evidenceGrid.columnSpacing = Theme.Space.m
                evidenceGrid.xPlacement = .fill
                evidenceGrid.yPlacement = .fill
                evidence.contentStack.addArrangedSubview(evidenceGrid)
                evidence.pinToContentWidth(evidenceGrid)
                for row in rows {
                    row.widthAnchor.constraint(greaterThanOrEqualToConstant: 250).isActive = true
                }
                stack.addArrangedSubview(evidence)
                evidence.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            }
        } else {
            let panel = ShellAvailabilityPanel(
                route: .modelsQuota, screen: screen, contentInset: 0)
            stack.addArrangedSubview(panel)
            panel.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

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

    private static func providerCards(
        view: WorkspaceModelControlView,
        writable: Bool,
        onWrite: @escaping (ShellPolicyWrite) -> Void
    ) -> [NSView] {
        view.providerIDs.map { provider in
            let presentation = view.provider(provider)
            let state = view.routing.providerState(provider)
            let enabled = state == "enabled"
            let toggle = NSButton(
                checkboxWithTitle: "", target: nil, action: nil)
            toggle.state = enabled ? .on : .off
            toggle.isEnabled = writable
            toggle.setAccessibilityLabel("Toggle \(ProviderBranding.title(for: provider))")
            toggle.setAccessibilityIdentifier("models-quota-provider-\(provider.rawValue)")
            ShellButtonTarget.shared.register(toggle) {
                onWrite(.provider(provider, enabled: !enabled))
            }
            toggle.target = ShellButtonTarget.shared
            toggle.action = #selector(ShellButtonTarget.fire(_:))

            let card = SectionCardView(
                title: ProviderBranding.title(for: provider),
                subtitle: Self.providerSubtitle(presentation),
                trailingView: toggle)

            let identity = NSStackView(views: [
                ProviderMarkView(provider: provider),
                CapsuleBadge(
                    text: state ?? "policy unavailable",
                    symbol: enabled ? "checkmark.circle.fill" : "circle.slash",
                    style: state == nil ? .neutral : enabled ? .positive : .warning),
            ])
            identity.orientation = .horizontal
            identity.alignment = .centerY
            identity.spacing = Theme.Space.s
            card.contentStack.addArrangedSubview(identity)
            card.pinToContentWidth(identity)

            let usage = presentation?.usage.rendered
                ?? ProviderUsage.unknown(reason: "daemon presentation missing")
            for row in usageRows(provider: provider, usage: usage) {
                card.contentStack.addArrangedSubview(row)
                card.pinToContentWidth(row)
            }

            for row in modelRows(
                provider: provider,
                presentation: presentation,
                routing: view.routing,
                writable: writable,
                onWrite: onWrite)
            {
                card.contentStack.addArrangedSubview(row)
                card.pinToContentWidth(row)
            }
            return card
        }
    }

    private static func providerSubtitle(
        _ presentation: WorkspaceProviderPresentation?
    ) -> String? {
        guard let presentation else { return "provider projection unavailable" }
        return [presentation.planLabel, presentation.billingChip]
            .compactMap { value in
                guard let value, !value.isEmpty else { return nil }
                return value
            }
            .joined(separator: " · ")
    }

    private static func usageRows(provider: ProviderID, usage: ProviderUsage) -> [NSView] {
        guard case .metered(let windows) = usage else {
            let panel = InsetPanelView()
            let title = NSTextField(labelWithString: "Usage")
            title.font = Theme.Font.sectionLabel
            title.textColor = Theme.tertiaryText
            let detail = NSTextField(wrappingLabelWithString: describe(usage))
            detail.font = Theme.Font.caption
            detail.textColor = Theme.secondaryText
            detail.maximumNumberOfLines = 0
            detail.setAccessibilityIdentifier("models-quota-usage-\(provider.rawValue)")
            panel.contentStack.addArrangedSubview(title)
            panel.contentStack.addArrangedSubview(detail)
            detail.widthAnchor.constraint(equalTo: panel.contentStack.widthAnchor).isActive = true
            return [panel]
        }
        return windows.map { window in
            let meter = UsageMeterView()
            meter.apply(window: window)
            meter.setAccessibilityIdentifier(
                "models-quota-meter-\(provider.rawValue)-\(window.label)")
            return meter
        }
    }

    private static func modelRows(
        provider: ProviderID,
        presentation: WorkspaceProviderPresentation?,
        routing: WorkspaceRoutingPresentation,
        writable: Bool,
        onWrite: @escaping (ShellPolicyWrite) -> Void
    ) -> [NSView] {
        guard presentation?.catalogState == "available" else {
            guard presentation?.catalogState == "unavailable" else { return [] }
            let reason = NSTextField(wrappingLabelWithString:
                presentation?.catalogReason
                    ?? "The daemon did not provide a model catalog.")
            reason.font = Theme.Font.caption
            reason.textColor = Theme.secondaryText
            reason.maximumNumberOfLines = 0
            reason.setAccessibilityIdentifier("models-quota-catalog-\(provider.rawValue)")
            return [reason]
        }

        return (presentation?.models ?? []).enumerated().map { index, model in
            let reading = routing.modelState(provider: provider, model: model.canonicalId)
            let enabled = reading?.state == "enabled"
            let toggle = NSButton(checkboxWithTitle: "", target: nil, action: nil)
            toggle.state = enabled ? .on : .off
            toggle.isEnabled = writable
            toggle.setAccessibilityIdentifier(
                "models-quota-model-\(provider.rawValue)-\(model.canonicalId)")
            toggle.setAccessibilityLabel("Toggle \(model.canonicalId)")
            ShellButtonTarget.shared.register(toggle) {
                onWrite(.model(provider, model: model.canonicalId, enabled: !enabled))
            }
            toggle.target = ShellButtonTarget.shared
            toggle.action = #selector(ShellButtonTarget.fire(_:))

            let name = NSTextField(labelWithString: model.displayId)
            name.font = Theme.Font.monoCaption
            name.textColor = Theme.primaryText
            name.compressHorizontally(toolTip: model.canonicalId)
            let detail = NSTextField(labelWithString: modelDetail(model, reading: reading))
            detail.font = Theme.Font.sectionMetadata
            detail.textColor = Theme.secondaryText
            detail.compressHorizontally()
            let copy = NSStackView(views: [name, detail])
            copy.orientation = .vertical
            copy.alignment = .leading
            copy.spacing = Theme.Space.xs

            let badge = CapsuleBadge(
                text: model.poolExhausted ? "pool excluded" : enabled ? "enabled" : "disabled",
                symbol: model.poolExhausted
                    ? "exclamationmark.octagon.fill"
                    : enabled ? "checkmark.circle.fill" : "minus.circle.fill",
                style: model.poolExhausted ? .critical : enabled ? .positive : .neutral)
            let row = DataTableRowView(
                columns: [toggle, copy, NSView.spacer(), badge],
                showsSeparator: index < (presentation?.models.count ?? 0) - 1)
            return row
        }
    }

    private static func modelDetail(
        _ model: WorkspaceModelPresentation,
        reading: WorkspaceRoutingModelState?
    ) -> String {
        let policy = reading.map { "\($0.state) · \($0.source)" } ?? "policy unavailable"
        let effort: String
        switch model.effortAxis {
        case .known(let levels, let defaultLevel):
            effort = "effort \(defaultLevel ?? levels.joined(separator: "/"))"
        case .none:
            effort = "provider-controlled effort"
        case .unknown(let reason):
            effort = "effort unknown — \(reason)"
        }
        return "\(policy) · \(effort)"
    }

    private static func evidenceRow(_ fact: ShellScreenFact) -> NSView {
        let panel = InsetPanelView()
        let label = NSTextField(labelWithString: fact.label)
        label.font = Theme.Font.sectionLabel
        label.textColor = Theme.secondaryText
        label.compressHorizontally(toolTip: fact.label)
        let value = NSTextField(wrappingLabelWithString: fact.value)
        value.font = Theme.Font.caption
        value.textColor = Theme.primaryText
        value.maximumNumberOfLines = 2
        value.compressHorizontally(toolTip: fact.value)
        panel.contentStack.addArrangedSubview(label)
        panel.contentStack.addArrangedSubview(value)
        value.widthAnchor.constraint(equalTo: panel.contentStack.widthAnchor).isActive = true
        return panel
    }

    private static func compactEvidence(_ facts: [ShellScreenFact]) -> [ShellScreenFact] {
        var seen = Set<String>()
        return facts.filter { fact in
            let state = fact.value.split(separator: "·", maxSplits: 1)
                .first.map { String($0).trimmingCharacters(in: .whitespaces) }
                ?? fact.value
            let key = fact.label == "Generated" || fact.label == "Providers" || fact.label == "Quota"
                ? fact.label
                : state
            return seen.insert(key).inserted
        }
    }

    private static func gridRows(_ cards: [NSView], columns: Int = 3) -> [[NSView]] {
        stride(from: 0, to: cards.count, by: columns).map { index in
            (0..<columns).map { offset in
                guard index + offset < cards.count else { return NSView() }
                return cards[index + offset]
            }
        }
    }

    private static func equalizeWidths(_ views: [NSView]) {
        guard let first = views.first else { return }
        for view in views.dropFirst() {
            view.widthAnchor.constraint(equalTo: first.widthAnchor).isActive = true
        }
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
            identifier = "models-quota-probe-status"
        case .failed(let value):
            message = value
            style = .critical
            symbol = "exclamationmark.circle.fill"
            identifier = "models-quota-probe-error"
        }
        let panel = InsetPanelView()
        let label = NSTextField(wrappingLabelWithString: message)
        let row = NSStackView(views: [
            CapsuleBadge(text: style == .positive ? "refreshed" : "refresh failed", symbol: symbol, style: style),
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

    private static func describe(_ usage: ProviderUsage) -> String {
        switch usage {
        case .metered: return "metered"
        case .silent(let reason): return "No reading — \(reason)"
        case .unmetered: return "This vendor publishes no capacity surface. Routing is unconstrained by usage, not free."
        case .unknown(let reason): return "Unknown — \(reason)"
        }
    }
}
