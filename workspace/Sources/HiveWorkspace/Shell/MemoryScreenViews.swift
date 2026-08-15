// MemoryScreenViews.swift The four Memory screens. Each renders exactly one typed daemon projection and nothing else: no screen here opens a memory file, a database, or a directory, so a route with no observed projection renders its availability state alone rather than a plausible-looking store. Absent, empty and available stores get three different renderings — an absent store draws no counts at all, because a number for a store that is not wired would be this client's invention rather than the daemon's reading.

import AppKit
import WorkspaceCore

final class MemoryOverviewScreenView: NSView {
    init(screen: ShellScreenProjection, overview: MemoryOverviewProjection?) {
        super.init(frame: .zero)
        setAccessibilityIdentifier("memory-overview-screen")
        var sections: [NSView] = []
        if let overview {
            sections.append(MemoryScreenParts.section("Recall health", [
                MemoryScreenParts.storeCard(
                    name: "Wiki", identifier: "memory-store-wiki",
                    state: overview.wiki.state,
                    readings: [
                        ("Articles", String(overview.wiki.articles)),
                        ("Pitfalls", String(overview.wiki.pitfalls)),
                        ("Unverified pitfalls", String(overview.wiki.unverifiedPitfalls)),
                    ]),
            ] + overview.wiki.scopes.map { scope in
                MemoryScreenParts.storeCard(
                    name: "Wiki scope · \(scope.scope.rawValue)",
                    identifier: "memory-store-wiki-\(scope.scope.rawValue)",
                    state: scope.state,
                    readings: [
                        ("Articles", String(scope.articles)),
                        ("Pitfalls", String(scope.pitfalls)),
                        ("Unverified pitfalls", String(scope.unverifiedPitfalls)),
                        ("Raw observations", String(scope.rawObservations)),
                    ])
            } + [
                MemoryScreenParts.storeCard(
                    name: "Episodic", identifier: "memory-store-episodic",
                    state: overview.episodic.state,
                    readings: [
                        ("Events", String(overview.episodic.events)),
                        ("Facts", String(overview.episodic.facts)),
                        ("Digests", String(overview.episodic.digests)),
                    ]),
            ]))
            sections.append(MemoryScreenParts.section(
                "FTS and vectors",
                MemoryScreenParts.indexCards(overview.indexes)))
            sections.append(MemoryScreenParts.section(
                "Lifecycle policy",
                [MemoryScreenParts.configCard(overview.config)]))
            sections.append(MemoryScreenParts.section(
                "User attention",
                [MemoryScreenParts.gapsCard(overview.gaps)]))
            sections.append(MemoryScreenParts.section(
                "Recent memory operations",
                MemoryScreenParts.jobCards(overview.lastJobs)))
        }
        MemoryScreenLayout.install(
            controls: [],
            sections: sections,
            panel: ShellAvailabilityPanel(
                route: .memoryOverview, screen: screen, contentInset: 0),
            in: self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

final class MemoryLibraryScreenView: NSView {
    init(
        screen: ShellScreenProjection,
        pager: MemoryLibraryPager?,
        actionsEnabled: Bool,
        onPage: @escaping (MemoryLibraryStep) -> Void
    ) {
        super.init(frame: .zero)
        setAccessibilityIdentifier("memory-library-screen")
        var controls: [NSView] = []
        var sections: [NSView] = []
        if let pager {
            let page = pager.page
            sections.append(MemoryScreenParts.section("Library", [
                MemoryScreenParts.storeCard(
                    name: "Library", identifier: "memory-store-library",
                    state: page.state,
                    readings: [
                        ("Matching rows", String(page.total)),
                        ("Rows on this page", String(page.items.count)),
                        ("Page", String(pager.pageNumber)),
                    ]),
            ]))
            if !page.items.isEmpty {
                let card = CardView()
                card.setAccessibilityIdentifier("memory-library-rows")
                for item in page.items {
                    let display = item.display
                    let row = MemoryScreenParts.row(
                        "\(display.kind) · \(display.id)", display.value)
                    card.contentStack.addArrangedSubview(row)
                    card.pinToContentWidth(row)
                }
                sections.append(MemoryScreenParts.section("Rows", [card]))
            }
            controls.append(MemoryScreenParts.pageControls(
                pager: pager, enabled: actionsEnabled, onPage: onPage))
        }
        MemoryScreenLayout.install(
            controls: controls,
            sections: sections,
            panel: ShellAvailabilityPanel(
                route: .memoryLibrary, screen: screen, contentInset: 0),
            in: self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

final class MemoryRecallScreenView: NSView {
    init(
        screen: ShellScreenProjection,
        preview: MemoryRecallPreview?,
        actionsEnabled: Bool,
        onInspect: @escaping (String) -> Void
    ) {
        super.init(frame: .zero)
        setAccessibilityIdentifier("memory-recall-screen")
        let query = NSTextField(string: preview?.query ?? "")
        query.placeholderString = "Recall query"
        query.setAccessibilityIdentifier("memory-recall-query")
        let inspect = NSButton(title: "Inspect recall", target: nil, action: nil)
        inspect.isEnabled = actionsEnabled
        inspect.setAccessibilityIdentifier("memory-recall-inspect")
        ShellButtonTarget.shared.register(inspect) {
            let trimmed = query.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            onInspect(trimmed)
        }
        inspect.target = ShellButtonTarget.shared
        inspect.action = #selector(ShellButtonTarget.fire(_:))
        let controls = NSStackView(views: [query, inspect])
        controls.orientation = .horizontal
        controls.spacing = Theme.Space.s
        query.widthAnchor.constraint(greaterThanOrEqualToConstant: 260).isActive = true

        var sections: [NSView] = []
        if let preview {
            sections.append(MemoryScreenParts.section(
                "Preview", [MemoryScreenParts.recallSummaryCard(preview)]))
            sections.append(MemoryScreenParts.section(
                "Budget partitions", [MemoryScreenParts.partitionsCard(preview)]))
            if let trigger = preview.triggerPhrase {
                sections.append(MemoryScreenParts.note(
                    "A \(trigger.detected.rawValue) trigger phrase was detected in this "
                        + "query and treated as \(trigger.treatedAs.rawValue). "
                        + "It was reported, never executed.",
                    identifier: "memory-recall-trigger",
                    color: .systemOrange))
            }
            if let warning = preview.warning {
                sections.append(MemoryScreenParts.note(
                    warning, identifier: "memory-recall-warning", color: .systemOrange))
            }
            if preview.rows.isEmpty {
                sections.append(MemoryScreenParts.note(
                    "This query matched no rows within the budget.",
                    identifier: "memory-recall-no-rows",
                    color: .secondaryLabelColor))
            } else {
                let card = CardView()
                card.setAccessibilityIdentifier("memory-recall-rows")
                for row in preview.rows {
                    let flag = row.flag.map { " · \($0)" } ?? ""
                    let view = MemoryScreenParts.row(
                        "#\(row.rank) · \(row.class.rawValue)",
                        "\(row.scope)/\(row.topic)/\(row.id) · \(row.date) · "
                            + "\(row.status)\(flag) · \(row.title) — \(row.snippet)")
                    card.contentStack.addArrangedSubview(view)
                    card.pinToContentWidth(view)
                }
                sections.append(MemoryScreenParts.section("Results", [card]))
            }
        }
        MemoryScreenLayout.install(
            controls: [controls],
            sections: sections,
            panel: ShellAvailabilityPanel(
                route: .memoryRecallLab, screen: screen, contentInset: 0),
            in: self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

final class MemoryMaintenanceScreenView: NSView {
    init(
        screen: ShellScreenProjection,
        maintenance: MemoryMaintenanceProjection?,
        actionsEnabled: Bool,
        onStart: @escaping (MemoryJobKind) -> Void
    ) {
        super.init(frame: .zero)
        setAccessibilityIdentifier("memory-maintenance-screen")
        let controls = NSStackView()
        controls.orientation = .horizontal
        controls.spacing = Theme.Space.s
        for kind in MemoryJobKind.allCases {
            let button = NSButton(title: kind.title, target: nil, action: nil)
            button.isEnabled = actionsEnabled
            button.setAccessibilityIdentifier("memory-job-\(kind.rawValue)")
            ShellButtonTarget.shared.register(button) { onStart(kind) }
            button.target = ShellButtonTarget.shared
            button.action = #selector(ShellButtonTarget.fire(_:))
            controls.addArrangedSubview(button)
        }

        var sections: [NSView] = []
        if let maintenance {
            sections.append(MemoryScreenParts.section("FTS and vectors", [
                MemoryScreenParts.storeCard(
                    name: "Consolidation", identifier: "memory-store-consolidation",
                    state: maintenance.consolidation.state,
                    readings: [("Candidates", String(maintenance.consolidation.candidates))]),
            ] + MemoryScreenParts.indexCards(maintenance.indexes)))
            sections.append(MemoryScreenParts.section(
                "Lifecycle policy",
                [MemoryScreenParts.configCard(maintenance.config)]))
            sections.append(MemoryScreenParts.section("Jobs", [
                MemoryScreenParts.storeCard(
                    name: "Job receipts", identifier: "memory-store-jobs",
                    state: maintenance.jobs.state,
                    readings: [("Recorded", String(maintenance.jobs.recent.count))]),
            ] + MemoryScreenParts.jobCards(maintenance.jobs.recent)))
        }
        MemoryScreenLayout.install(
            controls: [controls],
            sections: sections,
            panel: ShellAvailabilityPanel(
                route: .memoryMaintenance, screen: screen, contentInset: 0),
            in: self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

enum MemoryScreenParts {

    /// One store's reading, in one of three shapes. Absent draws its reason and
    /// no counts; empty draws its measured zeros and says the store exists;
    /// available draws what was counted. The identifier carries the state so a
    /// collapse of two of them cannot pass unnoticed.
    static func storeCard(
        name: String,
        identifier: String,
        state: MemoryStoreState,
        readings: [(String, String)]
    ) -> CardView {
        let card = CardView()
        card.dashed = state == .absent
        card.setAccessibilityIdentifier("\(identifier)-\(state.rawValue)")
        let title = NSTextField(labelWithString: name)
        title.font = Theme.Font.headline
        card.contentStack.addArrangedSubview(title)
        let reading = NSTextField(
            wrappingLabelWithString: MemoryScreenPresenter.store(state))
        reading.font = Theme.Font.callout
        reading.textColor = state == .absent ? .tertiaryLabelColor : .secondaryLabelColor
        reading.maximumNumberOfLines = 0
        card.contentStack.addArrangedSubview(reading)
        card.pinToContentWidth(reading)
        guard state != .absent else { return card }
        for (label, value) in readings {
            let row = self.row(label, value)
            card.contentStack.addArrangedSubview(row)
            card.pinToContentWidth(row)
        }
        return card
    }

    static func indexCards(_ indexes: MemoryIndexHealth) -> [NSView] {
        [
            storeCard(
                name: "Full-text index", identifier: "memory-index-fts",
                state: indexes.fts.state,
                readings: [("Articles", String(indexes.fts.articles))]),
            storeCard(
                name: "Vector index", identifier: "memory-index-vectors",
                state: indexes.vectors.state,
                readings: [
                    ("Articles", String(indexes.vectors.articles)),
                    ("Facts", String(indexes.vectors.facts)),
                    ("Provider", indexes.vectors.provider.rawValue),
                    ("Model", indexes.vectors.model),
                    ("Runtime", indexes.vectors.runtime),
                ]),
        ]
    }

    static func configCard(_ config: MemoryConfigProjection) -> CardView {
        let card = CardView()
        card.setAccessibilityIdentifier("memory-config")
        for (label, value) in [
            ("Configuration revision", config.revision),
            ("Hot event retention", "\(config.eventsHotDays) days"),
            ("Article stale threshold", "\(config.staleAfterDays) days"),
            ("Sweep interval", "\(config.sweepIntervalHours) hours"),
            ("Wake budget", "\(config.wakeBudgetTokens) tokens"),
            ("Embeddings", "\(config.embeddingProvider.rawValue) · \(config.embeddingModel)"),
        ] {
            let row = self.row(label, value)
            card.contentStack.addArrangedSubview(row)
            card.pinToContentWidth(row)
        }
        return card
    }

    /// A gap is a named absence the daemon reported. An empty list says so in
    /// words: silence would read the same as "not asked".
    static func gapsCard(_ gaps: [MemoryOverviewProjection.Gap]) -> CardView {
        let card = CardView()
        card.setAccessibilityIdentifier(
            gaps.isEmpty ? "memory-gaps-none" : "memory-gaps")
        guard !gaps.isEmpty else {
            let none = NSTextField(
                labelWithString: "The daemon reported no gaps for this store.")
            none.font = Theme.Font.callout
            none.textColor = .secondaryLabelColor
            card.contentStack.addArrangedSubview(none)
            return card
        }
        for gap in gaps {
            let row = self.row(gap.code, gap.detail)
            card.contentStack.addArrangedSubview(row)
            card.pinToContentWidth(row)
        }
        return card
    }

    /// One receipt: what ran, how far it got, why it failed, and the readback it
    /// finished with. A failure is never summarised away, and a job with no
    /// readback says the readback is missing rather than showing nothing.
    static func jobCards(_ receipts: [MemoryJobReceipt]) -> [NSView] {
        guard !receipts.isEmpty else {
            let card = CardView()
            card.setAccessibilityIdentifier("memory-jobs-none")
            let none = NSTextField(
                labelWithString: "No memory job has been recorded for this store.")
            none.font = Theme.Font.callout
            none.textColor = .secondaryLabelColor
            card.contentStack.addArrangedSubview(none)
            return [card]
        }
        return receipts.map { receipt in
            let card = CardView()
            card.setAccessibilityIdentifier("memory-job-receipt-\(receipt.id)")
            let title = NSTextField(
                labelWithString: "\(receipt.kind.title) · \(receipt.state.rawValue)")
            title.font = Theme.Font.headline
            card.contentStack.addArrangedSubview(title)

            let total = receipt.progress.total.map(String.init) ?? "unknown"
            var readings = [
                ("Progress", "\(receipt.progress.step) · \(receipt.progress.done)/\(total)"),
                ("Requested by", receipt.requestedBy),
                ("Started", receipt.startedAt),
                ("Finished", receipt.finishedAt ?? "not yet"),
                ("Summary", receipt.summary),
            ]
            if let readback = receipt.readback {
                readings += readback.keys.sorted().map {
                    ("Readback · \($0)", readback[$0]?.display ?? "unknown")
                }
            } else {
                readings.append((
                    "Readback",
                    "none was recorded, so this job's final state is unread"))
            }
            for (label, value) in readings {
                let row = self.row(label, value)
                card.contentStack.addArrangedSubview(row)
                card.pinToContentWidth(row)
            }
            if let error = receipt.error {
                let failure = NSTextField(wrappingLabelWithString: error)
                failure.font = Theme.Font.callout
                failure.textColor = .systemRed
                failure.maximumNumberOfLines = 0
                failure.setAccessibilityIdentifier("memory-job-failure-\(receipt.id)")
                card.contentStack.addArrangedSubview(failure)
                card.pinToContentWidth(failure)
            }
            return card
        }
    }

    static func recallSummaryCard(_ preview: MemoryRecallPreview) -> CardView {
        let card = CardView()
        card.setAccessibilityIdentifier("memory-recall-summary")
        for (label, value) in [
            ("Query", preview.query),
            ("Purpose", preview.purpose.rawValue),
            ("Store", MemoryScreenPresenter.store(preview.state)),
            ("Search provenance", preview.semantic),
            ("Budget", "\(preview.tokens) of \(preview.budget) tokens"
                + (preview.truncated ? " · truncated to fit" : " · nothing was dropped for size")),
            ("Omitted", "\(preview.omitted) rows · \(preview.omittedPitfalls) pitfalls · "
                + "\(preview.omittedArticles) articles"),
            ("Mutation", "\(preview.mutation.rawValue) · the wake high-water "
                + (preview.highWaterAdvanced ? "advanced" : "did not advance")),
            ("Note", preview.note),
        ] {
            let row = self.row(label, value)
            card.contentStack.addArrangedSubview(row)
            card.pinToContentWidth(row)
        }
        return card
    }

    /// The per-class budget split. Pitfalls and articles are shown side by side
    /// with their own reserve so a class that ate the whole budget is visible as
    /// itself rather than as a short result list.
    static func partitionsCard(_ preview: MemoryRecallPreview) -> CardView {
        let card = CardView()
        card.setAccessibilityIdentifier("memory-recall-partitions")
        for partition in preview.partitions {
            let row = self.row(
                partition.class.rawValue,
                "\(partition.usedTokens) of \(partition.reservedTokens) reserved tokens · "
                    + "\(partition.kept) kept · \(partition.omitted) omitted")
            row.setAccessibilityIdentifier(
                "memory-recall-partition-\(partition.class.rawValue)")
            card.contentStack.addArrangedSubview(row)
            card.pinToContentWidth(row)
        }
        return card
    }

    static func pageControls(
        pager: MemoryLibraryPager,
        enabled: Bool,
        onPage: @escaping (MemoryLibraryStep) -> Void
    ) -> NSView {
        func button(
            _ title: String,
            _ identifier: String,
            _ step: MemoryLibraryStep?
        ) -> NSButton {
            let button = NSButton(title: title, target: nil, action: nil)
            button.bezelStyle = .rounded
            button.isEnabled = enabled && step != nil
            button.setAccessibilityIdentifier(identifier)
            if let step {
                ShellButtonTarget.shared.register(button) { onPage(step) }
                button.target = ShellButtonTarget.shared
                button.action = #selector(ShellButtonTarget.fire(_:))
            }
            return button
        }
        let position = NSTextField(labelWithString: "Page \(pager.pageNumber)")
        position.font = Theme.Font.caption
        position.textColor = .secondaryLabelColor
        position.setAccessibilityIdentifier("memory-library-page")
        let stack = NSStackView(views: [
            button("Previous page", "memory-library-previous", pager.previousStep),
            button("Next page", "memory-library-next", pager.nextStep),
            position,
        ])
        stack.orientation = .horizontal
        stack.spacing = Theme.Space.s
        return stack
    }

    static func section(_ title: String, _ views: [NSView]) -> NSView {
        let header = NSTextField(labelWithString: title.uppercased())
        header.font = Theme.Font.sectionLabel
        header.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [header] + views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.s
        for view in views {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        return stack
    }

    static func row(_ label: String, _ value: String) -> NSStackView {
        let name = NSTextField(labelWithString: label)
        name.font = Theme.Font.callout
        name.textColor = .secondaryLabelColor
        name.compressHorizontally(priority: 470, toolTip: label)
        let reading = NSTextField(wrappingLabelWithString: value)
        reading.font = Theme.Font.monoBody
        reading.textColor = .labelColor
        reading.compressHorizontally(priority: 460, toolTip: value)
        let row = NSStackView(views: [name, reading])
        row.orientation = .horizontal
        row.spacing = Theme.Space.s
        return row
    }

    static func note(_ text: String, identifier: String, color: NSColor) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = Theme.Font.callout
        label.textColor = color
        label.maximumNumberOfLines = 0
        label.setAccessibilityIdentifier(identifier)
        return label
    }
}

private enum MemoryScreenLayout {
    /// Sections and the availability panel are the page and take its width;
    /// controls keep their own size rather than stretching across the window.
    static func install(
        controls: [NSView],
        sections: [NSView],
        panel: ShellAvailabilityPanel,
        in host: NSView
    ) {
        host.translatesAutoresizingMaskIntoConstraints = false
        let stack = NSStackView(views: controls + sections + [panel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.m
        stack.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(
                equalTo: host.leadingAnchor, constant: Theme.Space.page),
            stack.trailingAnchor.constraint(
                equalTo: host.trailingAnchor, constant: -Theme.Space.page),
            stack.topAnchor.constraint(equalTo: host.topAnchor, constant: Theme.Space.page),
            stack.bottomAnchor.constraint(
                lessThanOrEqualTo: host.bottomAnchor, constant: -Theme.Space.page),
        ])
        for view in controls {
            view.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor).isActive = true
        }
        for view in sections + [panel] {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
    }
}
