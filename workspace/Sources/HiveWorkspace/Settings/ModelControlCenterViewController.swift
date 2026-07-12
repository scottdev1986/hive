import AppKit
import WorkspaceCore

/// The Model Control Center page: header, global banners, the provider cards
/// and task-category chains, and the honesty footer — inside one properly
/// scrolling, properly resizing surface.
///
/// Responsive contract:
/// - ≥ 860 pt content width: two columns (providers ~55%, categories ~45%).
/// - below: one column — providers first, then categories — and every row's
///   labels truncate with a tail instead of pushing the layout apart.
/// - The whole page lives in one NSScrollView; cards expand in place with an
///   animated layout change, never a content jump.
///
/// Threading contract: every daemon read happens in ModelControlDataSource on
/// a background queue. This controller only ever touches the view tree on the
/// main thread, and a slow or dead `hive` binary renders as a visible loading
/// or failed state — never a beachball.
final class ModelControlCenterViewController: NSViewController {

    private let dataSource: ModelControlDataSource
    private let scrollView = NSScrollView()
    private let documentView = FlippedView()
    private let contentStack = NSStackView()
    private let columns = NSStackView()
    private let providersColumn = NSStackView()
    private let categoriesColumn = NSStackView()

    /// Which provider cards are expanded; survives data refreshes.
    private var expandedProviders: Set<ProviderID> = []
    private var seededExpansion = false
    private var rebuildScheduled = false
    private var lastColumnsWide: Bool?

    init(dataSource: ModelControlDataSource) {
        self.dataSource = dataSource
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func loadView() {
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = true
        scrollView.backgroundColor = .windowBackgroundColor
        scrollView.documentView = documentView
        scrollView.contentView.postsBoundsChangedNotifications = true

        documentView.translatesAutoresizingMaskIntoConstraints = false
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = Theme.Space.xl
        documentView.addSubview(contentStack)

        NSLayoutConstraint.activate([
            documentView.widthAnchor.constraint(
                equalTo: scrollView.contentView.widthAnchor),
            contentStack.leadingAnchor.constraint(
                equalTo: documentView.leadingAnchor, constant: Theme.Space.page),
            contentStack.trailingAnchor.constraint(
                equalTo: documentView.trailingAnchor, constant: -Theme.Space.page),
            contentStack.topAnchor.constraint(
                equalTo: documentView.topAnchor, constant: Theme.Space.page),
            contentStack.bottomAnchor.constraint(
                equalTo: documentView.bottomAnchor, constant: -Theme.Space.page),
        ])

        view = scrollView
        view.frame = NSRect(x: 0, y: 0, width: 1040, height: 760)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        dataSource.onChange = { [weak self] in
            self?.scheduleRebuild()
        }
        rebuild()
        dataSource.refresh()
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        // The breakpoint: reflow the two columns when the width crosses it.
        let wide = view.bounds.width - 2 * Theme.Space.page
            >= Theme.Metric.twoColumnBreakpoint
        if wide != lastColumnsWide {
            lastColumnsWide = wide
            applyColumnLayout(wide: wide)
        }
    }

    // MARK: Rebuild

    /// Coalesced to the next runloop turn so a control's own animation (an
    /// NSSwitch flip) completes before dependent chrome reconciles.
    private func scheduleRebuild() {
        guard !rebuildScheduled else { return }
        rebuildScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self else { return }
            self.rebuildScheduled = false
            self.rebuild()
        }
    }

    private func rebuild() {
        let savedOrigin = scrollView.contentView.bounds.origin
        contentStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        buildHeader()
        buildBanners()
        buildColumns()
        buildFooter()

        documentView.layoutSubtreeIfNeeded()
        scrollView.contentView.scroll(to: savedOrigin)
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    private func pinToContent(_ view: NSView) {
        view.widthAnchor.constraint(equalTo: contentStack.widthAnchor).isActive = true
    }

    private func buildHeader() {
        let title = NSTextField(labelWithString: MCCCopy.pageTitle)
        title.font = Theme.Font.largeTitle
        contentStack.addArrangedSubview(title)
        contentStack.setCustomSpacing(Theme.Space.s, after: title)

        let subtitle = NSTextField(wrappingLabelWithString: MCCCopy.pageSubtitle)
        subtitle.font = Theme.Font.callout
        subtitle.textColor = .secondaryLabelColor
        contentStack.addArrangedSubview(subtitle)
        pinToContent(subtitle)
    }

    private func buildBanners() {
        switch dataSource.loadState {
        case .loading where dataSource.snapshot == nil:
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .small
            spinner.startAnimation(nil)
            let label = NSTextField(
                labelWithString: "Reading providers, models, and usage from Hive…")
            label.font = Theme.Font.callout
            label.textColor = .secondaryLabelColor
            let row = NSStackView(views: [spinner, label])
            row.orientation = .horizontal
            row.spacing = Theme.Space.s
            contentStack.addArrangedSubview(row)
        case .failed(let reason):
            let panel = InsetPanelView()
            let title = NSTextField(
                labelWithString: "Hive could not be read")
            title.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
            let body = NSTextField(wrappingLabelWithString: reason)
            body.font = Theme.Font.caption
            body.textColor = .secondaryLabelColor
            let retry = NSButton(
                title: "Try Again", target: self, action: #selector(refreshTapped(_:)))
            retry.controlSize = .small
            panel.contentStack.addArrangedSubview(title)
            panel.contentStack.addArrangedSubview(body)
            panel.contentStack.addArrangedSubview(retry)
            body.widthAnchor.constraint(
                equalTo: panel.contentStack.widthAnchor).isActive = true
            contentStack.addArrangedSubview(panel)
            pinToContent(panel)
        default:
            break
        }

        guard let snapshot = dataSource.snapshot, let policy = dataSource.policy else {
            return
        }
        if policy.provisional {
            let banner = CapsuleBadge(
                text: MCCCopy.provisionalBanner, symbol: "info.circle", style: .info)
            contentStack.addArrangedSubview(banner)
        }
        for warning in PolicyWarning.derive(policy: policy, snapshot: snapshot) {
            let text: String
            switch warning {
            case .noProvidersEnabled: text = MCCCopy.warnNoProviders
            case .defaultChainEmpty: text = MCCCopy.warnDefaultChainEmpty
            }
            let banner = CapsuleBadge(
                text: text, symbol: "exclamationmark.triangle.fill", style: .warning)
            contentStack.addArrangedSubview(banner)
        }
    }

    private func buildColumns() {
        guard dataSource.snapshot != nil else { return }

        providersColumn.orientation = .vertical
        providersColumn.alignment = .leading
        providersColumn.spacing = Theme.Space.l
        providersColumn.arrangedSubviews.forEach { $0.removeFromSuperview() }

        categoriesColumn.orientation = .vertical
        categoriesColumn.alignment = .leading
        categoriesColumn.spacing = Theme.Space.l
        categoriesColumn.arrangedSubviews.forEach { $0.removeFromSuperview() }

        buildProvidersColumn()
        buildCategoriesColumn()

        columns.arrangedSubviews.forEach { columns.removeArrangedSubview($0); $0.removeFromSuperview() }
        columns.translatesAutoresizingMaskIntoConstraints = false
        columns.addArrangedSubview(providersColumn)
        columns.addArrangedSubview(categoriesColumn)
        contentStack.addArrangedSubview(columns)
        pinToContent(columns)

        lastColumnsWide = nil
        view.needsLayout = true
    }

    /// ≥ breakpoint: side-by-side, top-aligned, 55/45. Below: stacked.
    private func applyColumnLayout(wide: Bool) {
        columns.constraints.forEach { columns.removeConstraint($0) }
        if wide {
            columns.orientation = .horizontal
            columns.alignment = .top
            columns.spacing = Theme.Space.page
            providersColumn.widthAnchor.constraint(
                equalTo: columns.widthAnchor, multiplier: 0.55,
                constant: -Theme.Space.page).isActive = true
        } else {
            columns.orientation = .vertical
            columns.alignment = .leading
            columns.spacing = Theme.Space.xl
            providersColumn.widthAnchor.constraint(
                equalTo: columns.widthAnchor).isActive = true
            categoriesColumn.widthAnchor.constraint(
                equalTo: columns.widthAnchor).isActive = true
        }
    }

    private func buildProvidersColumn() {
        guard let snapshot = dataSource.snapshot else { return }
        providersColumn.addArrangedSubview(sectionLabel(MCCCopy.providersSection))

        if !seededExpansion {
            // First load: open every available provider so the models are
            // discoverable; the user's collapse choices stick afterwards.
            seededExpansion = true
            for id in snapshot.providerIDs {
                if case .available? = snapshot.providers[id.rawValue] {
                    expandedProviders.insert(id)
                }
            }
        }

        for id in snapshot.providerIDs {
            let card = ProviderCardView(
                provider: id,
                dataSource: dataSource,
                expanded: expandedProviders.contains(id),
                onExpandToggle: { [weak self] expanded in
                    if expanded {
                        self?.expandedProviders.insert(id)
                    } else {
                        self?.expandedProviders.remove(id)
                    }
                })
            providersColumn.addArrangedSubview(card)
            card.widthAnchor.constraint(
                equalTo: providersColumn.widthAnchor).isActive = true
        }
    }

    private func buildCategoriesColumn() {
        categoriesColumn.addArrangedSubview(sectionLabel(MCCCopy.categoriesSection))

        let subtitle = NSTextField(wrappingLabelWithString: MCCCopy.subtitleFallback)
        subtitle.font = Theme.Font.caption
        subtitle.textColor = .secondaryLabelColor
        categoriesColumn.addArrangedSubview(subtitle)
        subtitle.widthAnchor.constraint(
            equalTo: categoriesColumn.widthAnchor).isActive = true

        let card = CardView()
        for (index, category) in TaskCategory.allCases.enumerated() {
            if index > 0 {
                let separator = NSBox()
                separator.boxType = .separator
                separator.translatesAutoresizingMaskIntoConstraints = false
                card.contentStack.addArrangedSubview(separator)
                card.pinToContentWidth(separator)
            }
            let section = ChainSectionView(kind: .category(category), dataSource: dataSource)
            card.contentStack.addArrangedSubview(section)
            card.pinToContentWidth(section)
        }
        categoriesColumn.addArrangedSubview(card)
        card.widthAnchor.constraint(equalTo: categoriesColumn.widthAnchor).isActive = true

        // The Default chain: visually its own card — the one chain that must
        // not be empty, and the answer to every empty category above.
        let defaultCard = CardView()
        let section = ChainSectionView(kind: .defaultChain, dataSource: dataSource)
        defaultCard.contentStack.addArrangedSubview(section)
        defaultCard.pinToContentWidth(section)
        categoriesColumn.addArrangedSubview(defaultCard)
        defaultCard.widthAnchor.constraint(
            equalTo: categoriesColumn.widthAnchor).isActive = true
    }

    private func buildFooter() {
        let separator = NSBox()
        separator.boxType = .separator
        separator.translatesAutoresizingMaskIntoConstraints = false
        contentStack.addArrangedSubview(separator)
        pinToContent(separator)

        var footerText = MCCCopy.footerHonesty
        if let refreshed = dataSource.lastRefreshed {
            footerText = "Last refreshed \(UsageMeterView.relative(from: refreshed, to: Date())) ago · "
                + footerText
        }
        let label = NSTextField(wrappingLabelWithString: footerText)
        label.font = Theme.Font.caption
        label.textColor = .tertiaryLabelColor
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let refresh = NSButton(
            title: "Refresh", target: self, action: #selector(refreshTapped(_:)))
        refresh.controlSize = .small
        refresh.setAccessibilityLabel("Refresh providers and usage")
        if case .loading = dataSource.loadState {
            refresh.isEnabled = false
        }

        let row = NSStackView(views: [label, NSView.spacer(), refresh])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = Theme.Space.m
        contentStack.addArrangedSubview(row)
        pinToContent(row)
    }

    private func sectionLabel(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text.uppercased())
        label.font = Theme.Font.sectionLabel
        label.textColor = .secondaryLabelColor
        // Title case + tracking per spec §7.2.
        label.attributedStringValue = NSAttributedString(
            string: text.uppercased(),
            attributes: [
                .font: Theme.Font.sectionLabel,
                .foregroundColor: NSColor.secondaryLabelColor,
                .kern: 0.6,
            ])
        return label
    }

    @objc private func refreshTapped(_ sender: Any?) {
        // Re-probe. If a value that was known becomes unknown, the meter
        // changes state — the data source replaces the snapshot wholesale, so
        // nothing stale can keep wearing a fresh label (spec §14).
        dataSource.refresh()
    }
}

/// AppKit scroll content wants a flipped view so the page starts at the top.
final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}
