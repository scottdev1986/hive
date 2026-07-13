import AppKit
import WorkspaceCore

/// One provider: official mark, title, master toggle, billing chips, honest
/// usage block, and the disclosure into its model rows.
///
/// State matrix per spec §7.4. The usage block mounts exactly one of:
/// - `UsageMeterView`s (metered, with per-window unknown/stale states)
/// - a silent-feed unknown block (metered vendor, no reading)
/// - `UnmeteredPanelView` (vendor publishes no capacity — deliberate)
/// - an unknown block (Hive could not ask the daemon)
/// There is no code path that mounts a meter for an unmetered vendor.
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

    private var snapshot: ModelControlSnapshot? { dataSource.snapshot }

    private var catalog: ProviderCatalog? {
        snapshot?.providers[provider.rawValue]
    }

    private var providerAvailable: Bool {
        if case .available = catalog { return true }
        return false
    }

    private var providerEnabled: Bool {
        dataSource.providerMasterOn(provider)
    }

    /// False = no explicit row in the policy store: off by default, awaiting
    /// consent — an invitation, not a shutdown.
    private var providerConfigured: Bool {
        dataSource.providerConfigured(provider)
    }

    private func rebuild() {
        contentStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        dashed = !providerAvailable

        let title = ProviderBranding.title(for: provider)

        // ── Header: mark · title · badge · spacer · master switch
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
            // Two different off-reasons, two different looks: a deliberate
            // user off warns; an unconfigured provider (no consent yet)
            // invites.
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

        // ── Body: dims only for a DELIBERATE off — an awaiting-consent card
        // stays full strength.
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

    // MARK: Meta (plan + billing chips)

    private func buildMetaRow(into body: NSStackView) {
        var chips: [NSView] = []
        if let plan = MeterDerivation.planLabel(
            provider: provider, quota: snapshot?.quota) {
            let planText = plan.prefix(1).uppercased() + plan.dropFirst() + " plan"
            let label = NSTextField(labelWithString: planText)
            label.font = Theme.Font.callout
            label.textColor = .secondaryLabelColor
            label.compressHorizontally(toolTip: String(planText))
            chips.append(label)
        }
        let billing = snapshot?.billing[provider.rawValue] ?? nil
        switch BillingChip.derive(from: billing) {
        case .paidOverflowOff:
            // Calm: the wallet is safe. Never a nag (spec §3.4).
            chips.append(CapsuleBadge(
                text: MCCCopy.badgePaidOverflowOff, symbol: "lock", style: .neutral))
        case .creditsAvailable:
            chips.append(CapsuleBadge(
                text: MCCCopy.badgeCreditsAvailable, symbol: "creditcard", style: .neutral))
        case .unknown:
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

    // MARK: Usage

    private func buildUsageBlock(into body: NSStackView) {
        guard providerAvailable || snapshot != nil else { return }
        let usage = MeterDerivation.usage(
            provider: provider,
            surface: snapshot?.usageSurfaces[provider.rawValue],
            quota: snapshot?.quota,
            quotaError: snapshot?.quotaError)

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
            // A normally-metered vendor said nothing. Expected, named, and
            // NOT an outage: the provider stays enabled and spawnable.
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

    // MARK: Models

    private var disclosureButton: NSButton?
    private var modelsContainer: NSStackView?

    private func buildModelsSection(into body: NSStackView) {
        switch catalog {
        case .available(let models, _)?:
            let visible = models
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
            // Nil when spend is verified impossible (credits known off).
            let spendCaveat = SpendCaveat.derive(
                from: snapshot?.billing[provider.rawValue] ?? nil)
            for (index, model) in visible.enumerated() {
                if index > 0 {
                                        let separator = NSBox.hdsSeparator()
                    rows.addArrangedSubview(separator)
                    separator.widthAnchor.constraint(equalTo: rows.widthAnchor).isActive = true
                }
                // The policy store's grain is the canonical model id — a
                // context-window variant is not a different routing target.
                let modelId = model.canonicalId
                let hiddenByVendor = model.hidden.value == true
                let rowState = dataSource.rowState(
                    provider: provider, model: modelId,
                    available: !hiddenByVendor)
                let row = ModelRowView(
                    model: model,
                    rowState: rowState,
                    effortAxis: EffortAxis.derive(from: model),
                    effortSelection: dataSource.effortSelection(
                        provider: provider, model: modelId),
                    providerTitle: providerTitle,
                    poolExhausted: MeterDerivation.modelPoolExhausted(
                        provider: provider, canonicalId: model.canonicalId,
                        quota: snapshot?.quota),
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

        case .unavailable(let reason)?:
            let label = NSTextField(wrappingLabelWithString: reason)
            label.font = Theme.Font.caption
            label.textColor = .secondaryLabelColor
            label.compressHorizontally()
            body.addArrangedSubview(label)
            label.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true

        case nil:
            break
        }
    }

    // MARK: Actions

    @objc private func masterToggled(_ sender: NSSwitch) {
        let enabled = sender.state == .on
        // Instant local write; every child row flips to override chrome now.
        // Persistence follows through the daemon's CAS contract.
        dataSource.setProviderEnabled(provider, enabled)
    }

    /// Expand/collapse is local and fluid: the rows stay in the hierarchy and
    /// animate their layout change — no wholesale rebuild, no jolt. Reduce
    /// Motion collapses instantly.
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
            .withSymbolConfiguration(.init(pointSize: 9, weight: .semibold))
        disclosureButton?.setAccessibilityLabel(
            "\(expanded ? "Collapse" : "Expand") \(ProviderBranding.title(for: provider)) models")
    }
}

/// The unmetered vendor panel (spec §7.5): same card chrome as everyone else,
/// a muted inset, `info.circle`, and copy that names the condition. No hollow
/// meter track, no error red, no bare "N/A" — this vendor is a first-class
/// citizen with an unmeasurable surface, and the panel must look designed.
final class UnmeteredPanelView: InsetPanelView {

    init(vendorName: String) {
        super.init()

        let icon = NSImageView()
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.image = NSImage(
            systemSymbolName: "info.circle", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 12, weight: .medium))
        icon.contentTintColor = .systemBlue

        let title = NSTextField(labelWithString: MCCCopy.unmeteredTitle)
        title.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
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
