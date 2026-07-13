import AppKit
import WorkspaceCore

/// The shared scaffold for a settings page: one NSScrollView, one centered
/// content column (max 720 pt, page margins, full-width below that), coalesced
/// rebuilds that preserve scroll position, and the common banner/footer
/// builders.
///
/// Responsive contract: the column is width-bounded by constraints, every row
/// truncates rather than pushing the layout apart, and nothing here ever
/// forces the window wider — content that does not fit scrolls.
///
/// Threading contract: every daemon read happens in ModelControlDataSource on
/// a background queue; this controller touches the view tree on the main
/// thread only. A slow or dead `hive` read renders as a visible loading or
/// failed state — never a frozen window.
class SettingsPageController: NSViewController {

    let dataSource: ModelControlDataSource
    let scrollView = NSScrollView()
    let documentView = FlippedView()
    let contentStack = NSStackView()
    private var rebuildScheduled = false

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

        documentView.translatesAutoresizingMaskIntoConstraints = false
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = Theme.Space.l
        documentView.addSubview(contentStack)

        // A centered reading column: at most 720 pt, at least the window
        // minus margins — whichever is smaller. The soft full-width
        // constraint yields to the hard cap, so narrow windows get margins
        // and wide windows get a column, never a sprawl. Its priority sits
        // BELOW NSLayoutPriorityWindowSizeStayPut (500): at 500 or above the
        // layout pass resizes the WINDOW to satisfy it instead of shrinking
        // the column — which is how this window once grew past the screen.
        let fullWidth = contentStack.widthAnchor.constraint(
            equalTo: documentView.widthAnchor, constant: -2 * Theme.Space.page)
        fullWidth.priority = .init(490)
        NSLayoutConstraint.activate([
            documentView.widthAnchor.constraint(
                equalTo: scrollView.contentView.widthAnchor),
            contentStack.centerXAnchor.constraint(equalTo: documentView.centerXAnchor),
            contentStack.widthAnchor.constraint(lessThanOrEqualToConstant: 720),
            contentStack.leadingAnchor.constraint(
                greaterThanOrEqualTo: documentView.leadingAnchor, constant: Theme.Space.page),
            fullWidth,
            contentStack.topAnchor.constraint(
                equalTo: documentView.topAnchor, constant: Theme.Space.page),
            contentStack.bottomAnchor.constraint(
                equalTo: documentView.bottomAnchor, constant: -Theme.Space.page),
        ])

        view = scrollView
        view.frame = NSRect(x: 0, y: 0, width: 760, height: 720)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        dataSource.addObserver { [weak self] in
            self?.scheduleRebuild()
        }
        rebuild()
    }

    /// Coalesced so a control's own animation (an NSSwitch flip) completes
    /// before dependent chrome reconciles.
    private func scheduleRebuild() {
        guard !rebuildScheduled else { return }
        rebuildScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self else { return }
            self.rebuildScheduled = false
            self.rebuild()
        }
    }

    final func rebuild() {
        let savedOrigin = scrollView.contentView.bounds.origin
        contentStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        buildContent()
        buildFooter()
        // Scroll restoration waits for the normal layout pass. Forcing
        // layout here (layoutSubtreeIfNeeded) walks up to the window and
        // makes it adopt the content's fitting width — snapping the window
        // out of whatever size the user gave it, and once clean off the
        // screen.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.scrollView.contentView.scroll(to: savedOrigin)
            self.scrollView.reflectScrolledClipView(self.scrollView.contentView)
        }
    }

    /// Override: the page's sections, added to `contentStack`.
    func buildContent() {}

    /// AppKit scrolls the initial key view into view when the window becomes
    /// key; a settings page should open at its top regardless.
    func scrollToTop() {
        scrollView.contentView.scroll(to: .zero)
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    // MARK: Shared pieces

    func pinToContent(_ view: NSView) {
        view.widthAnchor.constraint(equalTo: contentStack.widthAnchor).isActive = true
    }

    func addHeader(title: String, subtitle: String) {
        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = Theme.Font.largeTitle
        contentStack.addArrangedSubview(titleLabel)
        contentStack.setCustomSpacing(Theme.Space.s, after: titleLabel)

        let subtitleLabel = NSTextField(wrappingLabelWithString: subtitle)
        subtitleLabel.font = Theme.Font.callout
        subtitleLabel.textColor = .secondaryLabelColor
        contentStack.addArrangedSubview(subtitleLabel)
        pinToContent(subtitleLabel)
    }

    /// Loading / failed states plus the provisional banner and policy
    /// warnings. Every page shows the same truth.
    func addBanners() {
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
            let title = NSTextField(labelWithString: "Hive could not be read")
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

        guard dataSource.snapshot != nil, dataSource.policyLoaded else {
            return
        }
        // A backend that cannot persist says so — a settings screen whose
        // switches silently do nothing is worse than one that warns.
        if let reason = dataSource.placeholderReason {
            let banner = NSTextField(wrappingLabelWithString:
                "Changes will not persist: \(reason)")
            banner.font = Theme.Font.callout
            banner.textColor = .systemOrange
            contentStack.addArrangedSubview(banner)
            pinToContent(banner)
        }
        if let writeError = dataSource.policyWriteError {
            let banner = NSTextField(wrappingLabelWithString: writeError)
            banner.font = Theme.Font.callout
            banner.textColor = .systemOrange
            contentStack.addArrangedSubview(banner)
            pinToContent(banner)
        }
        if dataSource.isProvisional {
            let banner = CapsuleBadge(
                text: MCCCopy.provisionalBanner, symbol: "info.circle", style: .info)
            contentStack.addArrangedSubview(banner)
        }
        for warning in dataSource.warnings {
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

    private func buildFooter() {
        let separator = NSBox.hdsSeparator()
        contentStack.addArrangedSubview(separator)
        pinToContent(separator)

        var footerText = MCCCopy.footerHonesty
        if let refreshed = dataSource.lastRefreshed {
            footerText = "Last refreshed \(UsageMeterView.relative(from: refreshed, to: Date())) ago · "
                + footerText
        }
        let label = NSTextField(labelWithString: footerText)
        label.font = Theme.Font.caption
        label.textColor = .tertiaryLabelColor
        label.lineBreakMode = .byTruncatingTail
        label.toolTip = footerText
        label.setContentCompressionResistancePriority(.init(420), for: .horizontal)

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

    func sectionLabel(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text.uppercased())
        label.attributedStringValue = NSAttributedString(
            string: text.uppercased(),
            attributes: [
                .font: Theme.Font.sectionLabel,
                .foregroundColor: NSColor.secondaryLabelColor,
                .kern: 0.6,
            ])
        return label
    }

    @objc func refreshTapped(_ sender: Any?) {
        // Re-probe. If a value that was known becomes unknown, the meter
        // changes state — the snapshot is replaced wholesale, so nothing
        // stale can keep wearing a fresh label (spec §14).
        dataSource.refresh()
    }
}

/// AppKit scroll content wants a flipped view so the page starts at the top.
final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// TASKS — the routing table, and the screen the window opens on. For each
/// kind of work: which models are good enough, at which effort. The atom is
/// a (model @ effort) pair; work SPREADS across a category's models by
/// remaining capacity — rank is preference and tie-break, not a strict walk.
final class TasksSettingsController: SettingsPageController {

    override func buildContent() {
        addHeader(
            title: "Tasks",
            subtitle: "Which models are good enough for each kind of work, and at which "
                + "effort. " + MCCCopy.subtitleSpread)
        addBanners()

        guard dataSource.snapshot != nil, dataSource.policyLoaded else { return }

        buildSpreadControl()

        for category in TaskCategory.allCases {
            let card = CardView()
            let section = ChainSectionView(kind: .category(category), dataSource: dataSource)
            card.contentStack.addArrangedSubview(section)
            card.pinToContentWidth(section)
            contentStack.addArrangedSubview(card)
            pinToContent(card)
        }

        contentStack.setCustomSpacing(Theme.Space.xl, after: contentStack.arrangedSubviews.last!)
        let defaultCard = CardView()
        let section = ChainSectionView(kind: .defaultChain, dataSource: dataSource)
        defaultCard.contentStack.addArrangedSubview(section)
        defaultCard.pinToContentWidth(section)
        contentStack.addArrangedSubview(defaultCard)
        pinToContent(defaultCard)
    }

    /// The one prominent distribution control: the global mode, plus the
    /// place per-category overrides are created (each overridden card then
    /// shows its own badge with a clear way back to global).
    private func buildSpreadControl() {
        let label = NSTextField(labelWithString: MCCCopy.spreadControlLabel)
        label.font = Theme.Font.headline

        let popup = NSPopUpButton(frame: .zero, pullsDown: false)
        popup.controlSize = .small
        popup.font = NSFont.systemFont(ofSize: 11)
        popup.addItem(withTitle: MCCCopy.spreadByCapacity)
        popup.addItem(withTitle: MCCCopy.spreadStrictOrder)
        popup.selectItem(at: dataSource.globalSpread == .spreadByCapacity ? 0 : 1)
        popup.target = self
        popup.action = #selector(globalSpreadChanged(_:))
        popup.setAccessibilityLabel("How Hive picks among a category's models")
        popup.isEnabled = dataSource.canEditSelection

        let overrides = NSPopUpButton(frame: .zero, pullsDown: true)
        overrides.controlSize = .small
        overrides.font = NSFont.systemFont(ofSize: 11)
        overrides.addItem(withTitle: "Category override…")
        overrides.isEnabled = dataSource.canEditSelection
        for category in TaskCategory.allCases {
            let item = NSMenuItem(title: category.label, action: nil, keyEquivalent: "")
            let submenu = NSMenu(title: category.label)
            for (title, mode) in [
                (MCCCopy.spreadByCapacity, SpreadMode.spreadByCapacity),
                (MCCCopy.spreadStrictOrder, SpreadMode.strictOrder),
            ] {
                let modeItem = NSMenuItem(
                    title: title, action: #selector(categoryOverridePicked(_:)),
                    keyEquivalent: "")
                modeItem.target = self
                modeItem.representedObject = [category.rawValue, mode.rawValue]
                modeItem.state = dataSource.spreadOverride(category) == mode ? .on : .off
                submenu.addItem(modeItem)
            }
            let clearItem = NSMenuItem(
                title: MCCCopy.spreadUseGlobal,
                action: #selector(categoryOverridePicked(_:)), keyEquivalent: "")
            clearItem.target = self
            clearItem.representedObject = [category.rawValue]
            clearItem.state = dataSource.spreadOverride(category) == nil ? .on : .off
            submenu.addItem(clearItem)
            item.submenu = submenu
            overrides.menu?.addItem(item)
        }

        let row = NSStackView(views: [label, popup, overrides, NSView.spacer()])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = Theme.Space.m
        contentStack.addArrangedSubview(row)
        pinToContent(row)

        var captionText = dataSource.globalSpread == .spreadByCapacity
            ? MCCCopy.spreadByCapacityCaption : MCCCopy.spreadStrictCaption
        if !dataSource.canEditSelection {
            captionText += " The running daemon does not support changing this yet — restart Hive after updating."
        }
        let caption = NSTextField(wrappingLabelWithString: captionText)
        caption.font = Theme.Font.caption
        caption.textColor = .tertiaryLabelColor
        contentStack.addArrangedSubview(caption)
        pinToContent(caption)
    }

    @objc private func globalSpreadChanged(_ sender: NSPopUpButton) {
        dataSource.setGlobalSpread(
            sender.indexOfSelectedItem == 0 ? .spreadByCapacity : .strictOrder)
    }

    @objc private func categoryOverridePicked(_ sender: NSMenuItem) {
        guard let payload = sender.representedObject as? [String],
              let rawCategory = payload.first,
              let category = TaskCategory(rawValue: rawCategory) else { return }
        let mode = payload.count > 1 ? SpreadMode(rawValue: payload[1]) : nil
        dataSource.setCategorySpread(category, mode)
    }
}

/// MODELS — the inventory and the consent surface: every provider, every
/// model, every advertised effort; usage meters and billing state. Enabling
/// a model here is what makes it assignable under Tasks — and it is the
/// user's authorisation to spend.
final class ModelsSettingsController: SettingsPageController {

    /// Which provider cards are expanded; survives data refreshes.
    private var expandedProviders: Set<ProviderID> = []
    private var seededExpansion = false

    override func buildContent() {
        addHeader(
            title: "Models",
            subtitle: MCCCopy.pageSubtitle + " Enabling a model authorises Hive to use "
                + "it — and to spend real money where a vendor bills for use.")
        addBanners()

        guard let snapshot = dataSource.snapshot else { return }

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
            contentStack.addArrangedSubview(card)
            pinToContent(card)
        }
    }
}
