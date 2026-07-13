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
        // and wide windows get a column, never a sprawl.
        let fullWidth = contentStack.widthAnchor.constraint(
            equalTo: documentView.widthAnchor, constant: -2 * Theme.Space.page)
        fullWidth.priority = .init(500)
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
        documentView.layoutSubtreeIfNeeded()
        scrollView.contentView.scroll(to: savedOrigin)
        scrollView.reflectScrolledClipView(scrollView.contentView)
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
        label.setContentCompressionResistancePriority(.init(600), for: .horizontal)

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
/// kind of work: which model, at which effort, in what fallback order, and
/// why. The atom is a (model @ effort) pair.
final class TasksSettingsController: SettingsPageController {

    override func buildContent() {
        addHeader(
            title: "Tasks",
            subtitle: "Which model handles each kind of work, at which effort, and in "
                + "what fallback order. " + MCCCopy.subtitleFallback)
        addBanners()

        guard dataSource.snapshot != nil else { return }

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
