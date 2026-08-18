import AppKit
import WorkspaceCore

/// One provider: official mark, title, master toggle, billing chips, honest usage block, and the disclosure into its model rows. The usage block mounts exactly one of: - `UsageMeterView`s (metered, with per-window unknown/stale states) - a silent-feed unknown block (metered vendor, no reading) - `UnmeteredPanelView` (vendor publishes no capacity — deliberate) - an unknown block (Hive could not ask the daemon) There is no code path that mounts a meter for an unmetered vendor.
final class ProviderCardView: CardView {

    private let provider: ProviderID
    private let dataSource: ModelControlDataSource
    private var expanded: Bool
    private let onExpandToggle: (Bool) -> Void

    init(
        provider: ProviderID,
        dataSource: ModelControlDataSource,
        expanded: Bool,
        onExpandToggle: @escaping (Bool) -> Void
    ) {
        self.provider = provider
        self.dataSource = dataSource
        self.expanded = expanded
        self.onExpandToggle = onExpandToggle
        super.init()
        rebuild()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private var providerAvailable: Bool {
        presentation?.catalogState == "available"
    }

    private var providerEnabled: Bool {
        dataSource.providerMasterOn(provider)
    }

    private var providerConfigured: Bool {
        dataSource.providerConfigured(provider)
    }

    private var presentation: WorkspaceProviderPresentation? {
        dataSource.providerPresentation(provider)
    }

    private func rebuild() {
        contentStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        dashed = !providerAvailable

        let title = ProviderBranding.title(for: provider)

        let mark = ProviderMarkView(provider: provider)
        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = Theme.Font.title
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.compressHorizontally(toolTip: title)

        let master = NSSwitch()
        master.state = providerEnabled ? .on : .off
        master.isEnabled = providerAvailable
        master.target = self
        master.action = #selector(masterToggled(_:))
        master.setAccessibilityLabel(MCCCopy.a11yProviderToggle(title))

        var headerViews: [NSView] = [mark, titleLabel]
        if !providerAvailable {
            headerViews.append(CapsuleBadge(
                text: MCCCopy.badgeNotAvailable, symbol: "bolt.horizontal.circle",
                style: .warning))
        } else if !providerEnabled {
            headerViews.append(providerConfigured
                ? CapsuleBadge(
                    text: MCCCopy.badgeProviderOff, symbol: "power",
                    style: .warning)
                : CapsuleBadge(
                    text: MCCCopy.badgeProviderOffByDefault, symbol: "shield",
                    style: .info))
        }
        headerViews.append(NSView.spacer())
        headerViews.append(master)
        let header = NSStackView(views: headerViews)
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = Theme.Space.s
        header.setCustomSpacing(Theme.Space.s, after: mark)
        contentStack.addArrangedSubview(header)
        pinToContentWidth(header)

        let body = NSStackView()
        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = Theme.Space.m
        contentStack.addArrangedSubview(body)
        pinToContentWidth(body)
        if !providerEnabled && providerConfigured {
            body.alphaValue = Theme.disabledContentAlpha
        }

        buildMetaRow(into: body)
        buildUsageBlock(into: body)
        buildModelsSection(into: body)
    }

    private func buildMetaRow(into body: NSStackView) {
        var chips: [NSView] = []
        if let plan = presentation?.planLabel {
            let planText = plan.prefix(1).uppercased() + plan.dropFirst() + " plan"
            let label = NSTextField(labelWithString: planText)
            label.font = Theme.Font.callout
            label.textColor = .secondaryLabelColor
            label.compressHorizontally(toolTip: String(planText))
            chips.append(label)
        }
        switch presentation?.billingChip {
        case "paid-overflow-off":
            // Calm: the wallet is safe. Never a nag.
            chips.append(CapsuleBadge(
                text: MCCCopy.badgePaidOverflowOff, symbol: "lock", style: .neutral))
        case "credits-available":
            chips.append(CapsuleBadge(
                text: MCCCopy.badgeCreditsAvailable, symbol: "creditcard", style: .neutral))
        default:
            chips.append(CapsuleBadge(
                text: MCCCopy.badgeBillingUnknown, symbol: "questionmark.circle",
                style: .neutral))
        }
        guard !chips.isEmpty else { return }
        let row = NSStackView(views: chips)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = Theme.Space.s
        body.addArrangedSubview(row)
    }

    private func buildUsageBlock(into body: NSStackView) {
        guard providerAvailable || dataSource.view != nil else { return }
        let usage = presentation?.usage.rendered
            ?? ProviderUsage.unknown(reason: "the daemon omitted provider presentation")

        switch usage {
        case .metered(let windows):
            let meters = NSStackView()
            meters.orientation = .vertical
            meters.alignment = .leading
            meters.spacing = Theme.Space.m
            for window in windows {
                let meter = UsageMeterView()
                meter.apply(window: window)
                meters.addArrangedSubview(meter)
                meter.widthAnchor.constraint(equalTo: meters.widthAnchor).isActive = true
            }
            body.addArrangedSubview(meters)
            meters.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true

        case .silent(let reason):
            let meter = UsageMeterView()
            meter.apply(window: MeterWindow(
                label: "Usage", state: .unknown(reason: reason)))
            body.addArrangedSubview(meter)
            meter.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
            let silent = NSTextField(
                wrappingLabelWithString: MCCCopy.meterSilentFeed(
                    ProviderBranding.title(for: provider)))
            silent.font = Theme.Font.caption
            silent.textColor = .secondaryLabelColor
            silent.compressHorizontally()
            body.addArrangedSubview(silent)
            silent.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true

        case .unmetered:
            let panel = UnmeteredPanelView(vendorName: ProviderBranding.vendorName(for: provider))
            body.addArrangedSubview(panel)
            panel.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true

        case .unknown(let reason):
            let meter = UsageMeterView()
            meter.apply(window: MeterWindow(
                label: "Usage", state: .unknown(reason: reason)))
            body.addArrangedSubview(meter)
            meter.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
        }
    }

    private var disclosureButton: NSButton?
    private var modelsContainer: NSStackView?

    private func buildModelsSection(into body: NSStackView) {
        switch presentation?.catalogState {
        case "available":
            let visible = presentation?.models ?? []
            let disclose = NSButton(
                title: "\(visible.count) model\(visible.count == 1 ? "" : "s")",
                target: self, action: #selector(disclosureToggled(_:)))
            disclose.bezelStyle = .inline
            disclose.isBordered = false
            disclose.font = Theme.Font.callout
            disclose.contentTintColor = .secondaryLabelColor
            disclose.imagePosition = .imageLeading
            disclosureButton = disclose
            updateDisclosureChevron()
            body.addArrangedSubview(disclose)

            let rows = NSStackView()
            rows.orientation = .vertical
            rows.alignment = .leading
            rows.spacing = 0
            let providerTitle = ProviderBranding.title(for: provider)
            let spendCaveat = presentation?.spendCaveat
            for (index, modelPresentation) in visible.enumerated() {
                if index > 0 {
                                        let separator = NSBox.hdsSeparator()
                    rows.addArrangedSubview(separator)
                    separator.widthAnchor.constraint(equalTo: rows.widthAnchor).isActive = true
                }
                let modelId = modelPresentation.canonicalId
                let rowState = dataSource.rowState(
                    provider: provider, model: modelId)
                let row = ModelRowView(
                    presentation: modelPresentation,
                    rowState: rowState,
                    effortSelection: dataSource.effortSelection(
                        provider: provider, model: modelId),
                    providerTitle: providerTitle,
                    poolExhausted: modelPresentation.poolExhausted,
                    spendCaveat: spendCaveat,
                    onToggle: { [weak self] enabled in
                        guard let self else { return }
                        self.dataSource.setModelEnabled(
                            provider: self.provider, model: modelId, enabled)
                    },
                    onEffort: { [weak self] effort in
                        guard let self else { return }
                        self.dataSource.setEffort(
                            provider: self.provider, model: modelId, effort)
                    })
                rows.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: rows.widthAnchor).isActive = true
            }
            body.addArrangedSubview(rows)
            rows.widthAnchor.constraint(
                equalTo: body.widthAnchor, constant: -Theme.Space.l).isActive = true
            rows.isHidden = !expanded
            modelsContainer = rows

        case "unavailable":
            let label = NSTextField(wrappingLabelWithString:
                presentation?.catalogReason ?? "The daemon did not provide a model catalog.")
            label.font = Theme.Font.caption
            label.textColor = .secondaryLabelColor
            label.compressHorizontally()
            body.addArrangedSubview(label)
            label.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true

        default:
            break
        }
    }

    @objc private func masterToggled(_ sender: NSSwitch) {
        let enabled = sender.state == .on
        dataSource.setProviderEnabled(provider, enabled)
    }

    @objc private func disclosureToggled(_ sender: NSButton) {
        expanded.toggle()
        onExpandToggle(expanded)
        updateDisclosureChevron()
        guard let modelsContainer else { return }
        if Theme.reduceMotion {
            modelsContainer.isHidden = !expanded
        } else {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = Theme.Motion.standard
                context.allowsImplicitAnimation = true
                modelsContainer.isHidden = !expanded
                window?.layoutIfNeeded()
            }
        }
    }

    private func updateDisclosureChevron() {
        disclosureButton?.image = NSImage(
            systemSymbolName: expanded ? "chevron.down" : "chevron.right",
            accessibilityDescription: expanded ? "Collapse" : "Expand")?
            // Sized off the disclosure button's own label token so the
            // chevron and the count stay in proportion when the ramp moves.
            .withSymbolConfiguration(
                .init(pointSize: Theme.Font.callout.pointSize, weight: .semibold))
        disclosureButton?.setAccessibilityLabel(
            "\(expanded ? "Collapse" : "Expand") \(ProviderBranding.title(for: provider)) models")
    }
}

final class UnmeteredPanelView: InsetPanelView {

    init(vendorName: String) {
        super.init()

        let icon = NSImageView()
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.image = NSImage(
            systemSymbolName: "info.circle", accessibilityDescription: nil)?
            // Sized off the title beside it so the glyph and the words stay
            // in proportion when the ramp moves.
            .withSymbolConfiguration(
                .init(pointSize: Theme.Font.headline.pointSize, weight: .medium))
        icon.contentTintColor = .systemBlue

        let title = NSTextField(labelWithString: MCCCopy.unmeteredTitle)
        title.font = Theme.Font.headline
        title.lineBreakMode = .byWordWrapping
        title.maximumNumberOfLines = 2
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let titleRow = NSStackView(views: [icon, title])
        titleRow.orientation = .horizontal
        titleRow.alignment = .firstBaseline
        titleRow.spacing = Theme.Space.s

        let body = NSTextField(wrappingLabelWithString: MCCCopy.unmeteredBody(vendorName))
        body.font = Theme.Font.caption
        body.textColor = .secondaryLabelColor
        body.compressHorizontally()

        contentStack.addArrangedSubview(titleRow)
        contentStack.addArrangedSubview(body)
        titleRow.widthAnchor.constraint(equalTo: contentStack.widthAnchor).isActive = true
        body.widthAnchor.constraint(equalTo: contentStack.widthAnchor).isActive = true

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("\(vendorName): \(MCCCopy.unmeteredTitle)")
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}
