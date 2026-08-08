import AppKit
import WorkspaceCore

/// The shared scaffold for a settings page: one NSScrollView, one centered content column (max 720 pt, page margins, full-width below that), coalesced rebuilds that preserve scroll position, and the common banner/footer builders. Responsive contract: the column is width-bounded by constraints, every row truncates rather than pushing the layout apart, and nothing here ever forces the window wider — content that does not fit scrolls. Threading contract: every daemon read happens in ModelControlDataSource on a background queue; this controller touches the view tree on the main thread only. A slow or dead `hive` read renders as a visible loading or failed state — never a frozen window.
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

        // A centered reading column: at most 720 pt, at least the window minus margins — whichever is smaller. The soft full-width constraint yields to the hard cap, so narrow windows get margins and wide windows get a column, never a sprawl. Its priority sits BELOW NSLayoutPriorityWindowSizeStayPut (500): at 500 or above the layout pass resizes the WINDOW to satisfy it instead of shrinking the column, which can grow the window past the screen.
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
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.scrollView.contentView.scroll(to: savedOrigin)
            self.scrollView.reflectScrolledClipView(self.scrollView.contentView)
        }
    }

    func buildContent() {}

    func scrollToTop() {
        scrollView.contentView.scroll(to: .zero)
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    func pinToContent(_ view: NSView) {
        view.widthAnchor.constraint(equalTo: contentStack.widthAnchor).isActive = true
    }

    func addHeader(title: String, subtitle: String) {
        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = Theme.Font.largeTitle
        titleLabel.compressHorizontally()
        contentStack.addArrangedSubview(titleLabel)
        contentStack.setCustomSpacing(Theme.Space.s, after: titleLabel)

        let subtitleLabel = NSTextField(wrappingLabelWithString: subtitle)
        subtitleLabel.font = Theme.Font.callout
        subtitleLabel.textColor = .secondaryLabelColor
        subtitleLabel.compressHorizontally()
        contentStack.addArrangedSubview(subtitleLabel)
        pinToContent(subtitleLabel)
    }

    func addBanners() {
        switch dataSource.loadState {
        case .loading where dataSource.view == nil:
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .small
            spinner.startAnimation(nil)
            let label = NSTextField(
                labelWithString: "Reading providers, models, and usage from Hive…")
            label.font = Theme.Font.callout
            label.textColor = .secondaryLabelColor
            label.compressHorizontally()
            let row = NSStackView(views: [spinner, label])
            row.orientation = .horizontal
            row.spacing = Theme.Space.s
            contentStack.addArrangedSubview(row)
        case .failed(let reason):
            let panel = InsetPanelView()
            let title = NSTextField(labelWithString: "Hive could not be read")
            title.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
            title.compressHorizontally()
            let body = NSTextField(wrappingLabelWithString: reason)
            body.font = Theme.Font.caption
            body.textColor = .secondaryLabelColor
            body.compressHorizontally()
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

        guard dataSource.view != nil, dataSource.policyLoaded else {
            return
        }
        if let writeError = dataSource.policyWriteError {
            let banner = NSTextField(wrappingLabelWithString: writeError)
            banner.font = Theme.Font.callout
            banner.textColor = .systemOrange
            banner.compressHorizontally()
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
            case .noGlobalRoute: text = MCCCopy.warnNoGlobalRoute
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

    @objc func refreshTapped(_ sender: Any?) {
        // Re-probe. If a value that was known becomes unknown, the meter changes state — the snapshot is replaced wholesale, so nothing stale can keep wearing a fresh label.
        dataSource.refresh()
    }
}

final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

final class TasksSettingsController: SettingsPageController {

    override func buildContent() {
        addHeader(
            title: "Tasks",
            subtitle: "Which models handle each kind of work, at which effort, and in "
                + "what proportion. " + MCCCopy.routesSubtitle)
        addBanners()

        guard dataSource.view != nil, dataSource.policyLoaded else { return }

        let globalCard = CardView()
        let globalSection = RouteSectionView(kind: .global, dataSource: dataSource)
        globalCard.contentStack.addArrangedSubview(globalSection)
        globalCard.pinToContentWidth(globalSection)
        contentStack.addArrangedSubview(globalCard)
        pinToContent(globalCard)
        contentStack.setCustomSpacing(Theme.Space.xl, after: globalCard)

        for category in dataSource.categories {
            let card = CardView()
            let section = RouteSectionView(kind: .category(category), dataSource: dataSource)
            card.contentStack.addArrangedSubview(section)
            card.pinToContentWidth(section)
            contentStack.addArrangedSubview(card)
            pinToContent(card)
        }
    }
}

final class ModelsSettingsController: SettingsPageController {

    private var expandedProviders: Set<ProviderID> = []
    private var seededExpansion = false

    override func buildContent() {
        addHeader(
            title: "Models",
            subtitle: MCCCopy.pageSubtitle + " Enabling a model authorises Hive to use "
                + "it — and to spend real money where a vendor bills for use.")
        addBanners()

        guard dataSource.view != nil else { return }

        if !seededExpansion {
            seededExpansion = true
            for id in dataSource.providerIDs {
                if dataSource.providerPresentation(id)?.catalogState == "available" {
                    expandedProviders.insert(id)
                }
            }
        }

        for id in dataSource.providerIDs {
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
