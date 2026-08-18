// MemoryScreenViews.swift The four Memory screens. Each renders exactly one typed daemon projection and nothing else: no screen here opens a memory file, a database, or a directory, so a route with no observed projection renders its availability state alone rather than a plausible-looking store. Absent, empty and available stores get three different renderings — an absent store draws no counts at all, because a number for a store that is not wired would be this client's invention rather than the daemon's reading. The four share one page shell, one filter idiom and one result-row idiom, all built here from the design system's primitives.

import AppKit
import WorkspaceCore

final class MemoryOverviewScreenView: NSView {
    init(screen: ShellScreenProjection, overview: MemoryOverviewProjection?) {
        super.init(frame: .zero)
        setAccessibilityIdentifier("memory-overview-screen")
        var content: [NSView] = []
        if let overview {
            content.append(MemoryScreenParts.grid([
                MemoryScreenParts.metricCard(
                    value: MemoryScreenParts.count(overview.wiki.articles, overview.wiki.state),
                    caption: "curated articles · repo and global",
                    identifier: "memory-metric-articles"),
                MemoryScreenParts.metricCard(
                    value: MemoryScreenParts.count(
                        overview.episodic.events, overview.episodic.state),
                    caption: "episodic events · \(overview.config.eventsHotDays)-day hot tier",
                    identifier: "memory-metric-events"),
                MemoryScreenParts.metricCard(
                    value: MemoryScreenParts.count(
                        overview.episodic.facts, overview.episodic.state),
                    caption: "bi-temporal facts",
                    identifier: "memory-metric-facts"),
                MemoryScreenParts.metricCard(
                    value: MemoryScreenParts.count(
                        overview.wiki.unverifiedPitfalls, overview.wiki.state),
                    caption: "unverified pitfalls",
                    identifier: "memory-metric-unverified"),
            ], columns: 4))

            content.append(MemoryScreenParts.grid([
                MemoryScreenParts.storeCard(
                    name: "Curated wiki", identifier: "memory-store-wiki",
                    caption: "immutable observations and compiled entries",
                    state: overview.wiki.state,
                    readings: [
                        ("Articles", String(overview.wiki.articles)),
                        ("Pitfalls", String(overview.wiki.pitfalls)),
                        ("Unverified pitfalls", String(overview.wiki.unverifiedPitfalls)),
                    ],
                    role: .canonical),
                MemoryScreenParts.storeCard(
                    name: "Episodic store", identifier: "memory-store-episodic",
                    caption: "events, bi-temporal facts and digests",
                    state: overview.episodic.state,
                    readings: [
                        ("Events", String(overview.episodic.events)),
                        ("Facts", String(overview.episodic.facts)),
                        ("Digests", String(overview.episodic.digests)),
                    ],
                    role: .canonical),
                MemoryScreenParts.projectionCard(overview.indexes),
            ], columns: 3))

            content.append(MemoryScreenParts.grid([
                MemoryScreenParts.recallHealthCard(
                    indexes: overview.indexes, config: overview.config),
                MemoryScreenParts.operationsCard(overview.lastJobs),
            ], columns: 2))

            content.append(MemoryScreenParts.grid([
                MemoryScreenParts.configCard(overview.config),
                MemoryScreenParts.gapsCard(overview.gaps),
            ], columns: 2))

            content.append(MemoryScreenParts.scopesCard(overview.wiki.scopes))
        }
        MemoryPage.install(
            route: .memoryOverview,
            screen: screen,
            subtitle: "Health and counts from one daemon-owned overview projection. "
                + "Two canonical records and the one rebuildable projection over "
                + "them stay visibly different.",
            actions: [],
            content: content,
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
        onPage: @escaping (MemoryLibraryStep) -> Void,
        onFilter: @escaping (MemoryLibraryFilter) -> Void
    ) {
        super.init(frame: .zero)
        setAccessibilityIdentifier("memory-library-screen")
        var content: [NSView] = []
        var actions: [NSView] = []
        if let pager {
            // Refresh re-asks the daemon for the page already on screen, so it
            // reads the walk's own position rather than restarting it.
            let refresh = ActionButton(title: "Refresh", symbol: "arrow.clockwise")
            refresh.isEnabled = actionsEnabled
            refresh.setAccessibilityIdentifier("memory-library-refresh")
            ShellButtonTarget.shared.register(refresh) { onPage(pager.currentStep) }
            refresh.target = ShellButtonTarget.shared
            refresh.action = #selector(ShellButtonTarget.fire(_:))
            actions.append(refresh)

            content.append(MemoryScreenParts.filterControls(
                filter: pager.filter, enabled: actionsEnabled, onFilter: onFilter))
            let page = pager.page
            let rows = page.items.map(MemoryScreenPresenter.libraryRow)
            let selection = MemoryLibrarySelectionView(rows: rows)
            let table = MemoryScreenParts.sectionCard(
                title: "Library rows",
                subtitle: "ordered by row key, so a page walk cannot renumber "
                    + "under a concurrent write · this wire offers no title "
                    + "search and no sort",
                identifier: "memory-library-rows")
            table.add(MemoryScreenParts.resultHeader(columns: Self.columns))
            if rows.isEmpty {
                table.add(MemoryScreenParts.note(
                    "This page carries no rows.",
                    identifier: "memory-library-no-rows",
                    style: .quiet))
            } else {
                MemoryScreenParts.boundedRows(
                    into: table, count: rows.count, bound: 8,
                    noun: "rows on this page", identifier: "memory-library"
                ) { [weak selection] index in
                    let row = rows[index]
                    let view = MemoryScreenParts.resultRow(
                        leading: MemoryScreenParts.lifecycleBadge(row.status),
                        title: row.title,
                        detail: row.detail,
                        columns: [
                            MemoryScreenParts.Column(text: row.kind, width: Self.columns[0].width),
                            MemoryScreenParts.Column(text: row.scope, width: Self.columns[1].width),
                            MemoryScreenParts.Column(
                                text: row.updated, width: Self.columns[2].width, mono: true),
                        ],
                        identifier: "memory-library-row-\(row.id)")
                    view.addGestureRecognizer(
                        MemoryRowClick { selection?.select(index) })
                    return view
                }
            }
            table.add(MemoryScreenParts.pageControls(
                pager: pager, enabled: actionsEnabled, onPage: onPage))

            let aside = MemoryScreenParts.column([
                selection,
                MemoryScreenParts.storeCard(
                    name: "Library page", identifier: "memory-store-library",
                    caption: "the daemon's own page of this filtered list",
                    state: page.state,
                    readings: [
                        ("Matching rows", String(page.total)),
                        ("Rows on this page", String(page.items.count)),
                        ("Page", String(pager.pageNumber)),
                    ]),
                MemoryScreenParts.gapCard(
                    title: "Edit and delete",
                    identifier: "memory-library-inspector-gap",
                    detail: "The daemon has a guarded mutation wire — create, "
                        + "update and delete, each fenced by the revision the "
                        + "caller read — but this app has no client for it, so a "
                        + "row cannot be opened for change here. Rows are read "
                        + "exactly as the daemon listed them."),
            ])
            content.append(MemoryScreenParts.split(main: table, aside: aside))
        }
        MemoryPage.install(
            route: .memoryLibrary,
            screen: screen,
            subtitle: "Paginated daemon projection across curated articles, pitfalls, "
                + "current facts, session digests, and raw evidence references. "
                + "Scope and lifecycle are explicit.",
            actions: actions,
            content: content,
            in: self)
    }

    /// The table's own schema: kind, scope, and the update stamp sit in fixed
    /// columns while the title and its provenance take the space that is left.
    private static let columns: [MemoryScreenParts.Column] = [
        MemoryScreenParts.Column(text: "Kind", width: 92),
        MemoryScreenParts.Column(text: "Scope", width: 84),
        MemoryScreenParts.Column(text: "Updated", width: 132, mono: true),
    ]

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

/// The selected row's own reading, drawn from the page already on screen. It
/// shows every field the list projection carries for that row and names the two
/// the design asks for that this wire does not send, because an empty body and
/// an empty vector line would read as a record with nothing in it.
private final class MemoryLibrarySelectionView: NSView {
    private let rows: [MemoryScreenPresenter.LibraryRow]
    private let host = NSView()
    private var selected = 0

    init(rows: [MemoryScreenPresenter.LibraryRow]) {
        self.rows = rows
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        host.translatesAutoresizingMaskIntoConstraints = false
        addSubview(host)
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: leadingAnchor),
            host.trailingAnchor.constraint(equalTo: trailingAnchor),
            host.topAnchor.constraint(equalTo: topAnchor),
            host.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        render()
    }

    /// Takes the row the reader clicked. Selection is this view's own state: it
    /// picks between rows the daemon already served rather than asking for a
    /// reading the page does not contain.
    func select(_ index: Int) {
        guard rows.indices.contains(index), index != selected else { return }
        selected = index
        render()
    }

    private func render() {
        for view in host.subviews { view.removeFromSuperview() }
        let card = build()
        card.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(card)
        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            card.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            card.topAnchor.constraint(equalTo: host.topAnchor),
            card.bottomAnchor.constraint(equalTo: host.bottomAnchor),
        ])
    }

    private func build() -> CardView {
        guard rows.indices.contains(selected) else {
            let card = MemoryScreenParts.sectionCard(
                title: "Selected memory",
                subtitle: "nothing to select",
                identifier: "memory-library-selected-none")
            card.add(MemoryScreenParts.note(
                "This page carries no rows, so no memory is selected.",
                identifier: "memory-library-selected-none-detail",
                style: .quiet))
            return card
        }
        let row = rows[selected]
        let card = MemoryScreenParts.sectionCard(
            title: "Selected memory",
            subtitle: "row \(selected + 1) of \(rows.count) on this page",
            identifier: "memory-library-selected",
            trailingView: MemoryScreenParts.lifecycleBadge(row.status))
        let title = NSTextField(wrappingLabelWithString: row.title)
        title.font = Theme.Font.title
        title.textColor = Theme.primaryText
        title.maximumNumberOfLines = 0
        card.add(title)
        card.add(MemoryScreenParts.factRow("Kind", row.kind))
        card.add(MemoryScreenParts.factRow("Scope", row.scope))
        card.add(MemoryScreenParts.factRow("Identifier", row.id))
        for fact in row.facts {
            card.add(MemoryScreenParts.factRow(fact.label, fact.value))
        }
        card.add(MemoryScreenParts.note(
            "The list projection carries no body text and no per-row vector "
                + "state, so neither is shown here.",
            identifier: "memory-library-selected-absences",
            style: .quiet))
        return card
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

/// A click on a table row, delivered to the closure the row was built with. The
/// recognizer is its own target, so the handler lives exactly as long as the row
/// that owns it.
private final class MemoryRowClick: NSClickGestureRecognizer {
    private let handler: () -> Void

    init(_ handler: @escaping () -> Void) {
        self.handler = handler
        super.init(target: nil, action: nil)
        target = self
        action = #selector(fire)
    }

    @objc private func fire() { handler() }

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
        query.font = Theme.Font.body
        query.setAccessibilityIdentifier("memory-recall-query")
        let inspect = ActionButton(
            title: "Run recall", symbol: "magnifyingglass", style: .primary)
        inspect.isEnabled = actionsEnabled
        inspect.setAccessibilityIdentifier("memory-recall-inspect")
        ShellButtonTarget.shared.register(inspect) {
            let trimmed = query.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            onInspect(trimmed)
        }
        inspect.target = ShellButtonTarget.shared
        inspect.action = #selector(ShellButtonTarget.fire(_:))

        let form = MemoryScreenParts.sectionCard(
            title: "Query",
            subtitle: "read-only: this preview never advances a wake high-water",
            identifier: "memory-recall-form")
        form.add(query)
        form.add(inspect)
        if let preview {
            form.add(MemoryScreenParts.outcomePanel(preview))
            for (label, value) in [
                ("Purpose", preview.purpose.rawValue),
                ("Store", MemoryScreenPresenter.store(preview.state)),
                ("Search provenance", preview.semantic),
                ("Budget", "\(preview.tokens) of \(preview.budget) tokens"
                    + (preview.truncated
                        ? " · truncated to fit"
                        : " · nothing was dropped for size")),
                ("Omitted", "\(preview.omitted) rows · \(preview.omittedPitfalls) pitfalls · "
                    + "\(preview.omittedArticles) articles"),
                ("Mutation", "\(preview.mutation.rawValue) · the wake high-water "
                    + (preview.highWaterAdvanced ? "advanced" : "did not advance")),
                ("Note", preview.note),
            ] {
                form.add(MemoryScreenParts.factRow(label, value))
            }
        }

        var content: [NSView] = []
        if let preview {
            var results: [NSView] = []
            if let trigger = preview.triggerPhrase {
                results.append(MemoryScreenParts.note(
                    "A \(trigger.detected.rawValue) trigger phrase was detected in this "
                        + "query and treated as \(trigger.treatedAs.rawValue). "
                        + "It was reported, never executed.",
                    identifier: "memory-recall-trigger",
                    style: .attention))
            }
            if let warning = preview.warning {
                results.append(MemoryScreenParts.note(
                    warning, identifier: "memory-recall-warning", style: .attention))
            }

            let ranked = MemoryScreenParts.sectionCard(
                title: "Ranked results",
                subtitle: "\(preview.rows.count) rows inside the budget · "
                    + "\(preview.omitted) omitted for size",
                identifier: "memory-recall-rows")
            if preview.rows.isEmpty {
                ranked.add(MemoryScreenParts.note(
                    "This query matched no rows within the budget.",
                    identifier: "memory-recall-no-rows",
                    style: .quiet))
            } else {
                MemoryScreenParts.boundedRows(
                    into: ranked, count: preview.rows.count, bound: 6,
                    noun: "rows inside the budget", identifier: "memory-recall"
                ) { index in
                    let row = preview.rows[index]
                    let flag = row.flag.map { " · \($0)" } ?? ""
                    return MemoryScreenParts.resultRow(
                        leading: MemoryScreenParts.lifecycleBadge(row.status),
                        title: row.title,
                        detail: "\(row.snippet) · \(row.scope)/\(row.topic)/\(row.id)"
                            + "\(flag)",
                        columns: [
                            MemoryScreenParts.Column(text: row.date, width: 132, mono: true),
                        ],
                        trailing: CapsuleBadge(
                            text: "rank \(row.rank) · \(row.class.rawValue)",
                            symbol: "number",
                            style: .info),
                        identifier: "memory-recall-row-\(row.id)")
                }
            }
            results.append(ranked)

            let partitions = MemoryScreenParts.sectionCard(
                title: "Budget partitions",
                subtitle: "each class keeps its own reserve, so a starved class "
                    + "is visible as itself",
                identifier: "memory-recall-partitions")
            for partition in preview.partitions {
                partitions.add(MemoryScreenParts.factRow(
                    partition.class.rawValue,
                    "\(partition.usedTokens) of \(partition.reservedTokens) reserved tokens · "
                        + "\(partition.kept) kept · \(partition.omitted) omitted",
                    identifier: "memory-recall-partition-\(partition.class.rawValue)"))
            }
            results.append(partitions)
            content.append(MemoryScreenParts.split(
                main: MemoryScreenParts.column(results), aside: MemoryScreenParts.column([form]), asideLeads: true))
        } else {
            content.append(MemoryScreenParts.split(main: NSView(), aside: MemoryScreenParts.column([form]), asideLeads: true))
        }

        MemoryPage.install(
            route: .memoryRecallLab,
            screen: screen,
            subtitle: "Read-only preview of the exact bounded bundle Hive would produce. "
                + "It never advances an agent's wake high-water and never treats an "
                + "agent-authored trigger phrase as authority.",
            actions: [],
            content: content,
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

        func job(_ kind: MemoryJobKind, style: ActionButton.Style = .neutral) -> ActionButton {
            let button = ActionButton(title: kind.title, style: style)
            button.isEnabled = actionsEnabled
            button.setAccessibilityIdentifier("memory-job-\(kind.rawValue)")
            ShellButtonTarget.shared.register(button) { onStart(kind) }
            button.target = ShellButtonTarget.shared
            button.action = #selector(ShellButtonTarget.fire(_:))
            return button
        }

        var content: [NSView] = []
        if let maintenance {
            content.append(MemoryScreenParts.grid([
                MemoryScreenParts.projectionCard(
                    maintenance.indexes, action: job(.reindex, style: .primary)),
                MemoryScreenParts.storeCard(
                    name: "Consolidation", identifier: "memory-store-consolidation",
                    caption: "duplicate candidates the daemon scanned for",
                    state: maintenance.consolidation.state,
                    readings: [("Candidates", String(maintenance.consolidation.candidates))],
                    actions: [job(.consolidationDryRun), job(.consolidationApply)]),
                MemoryScreenParts.configCard(
                    maintenance.config, action: job(.retentionSweep)),
            ], columns: 3))

            // The newest receipt is the job this screen is about; the ones
            // behind it are history. They are the same rendering because they
            // are the same fact — only the reading order differs.
            let receipts = maintenance.jobs.recent
            content.append(MemoryScreenParts.jobsCard(
                title: "Latest job",
                subtitle: MemoryScreenPresenter.store(maintenance.jobs.state),
                identifier: "memory-store-jobs-\(maintenance.jobs.state.rawValue)",
                receipts: Array(receipts.prefix(1))))
            if receipts.count > 1 {
                content.append(MemoryScreenParts.jobsCard(
                    title: "Earlier receipts",
                    subtitle: "newest first, behind the latest job",
                    identifier: "memory-jobs-earlier",
                    receipts: Array(receipts.dropFirst()),
                    bound: 2))
            }
        }
        MemoryPage.install(
            route: .memoryMaintenance,
            screen: screen,
            subtitle: "Projection jobs, retention, and consolidation. Every operation "
                + "runs in the daemon with a job receipt and a final readback; a job "
                + "this build cannot name is not offered.",
            actions: [],
            content: content,
            in: self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

enum MemoryScreenParts {

    /// One right-hand table cell. The screen owns the widths because each table
    /// carries a different schema; the row owns everything else.
    struct Column {
        let text: String
        let width: CGFloat
        let mono: Bool

        init(text: String, width: CGFloat, mono: Bool = false) {
            self.text = text
            self.width = width
            self.mono = mono
        }
    }

    enum NoteStyle {
        case quiet
        case attention
    }

    /// A store's count, or the word for a store that has none to give. An absent
    /// store has no number at all: a zero here would be this client's invention.
    static func count(_ value: Int, _ state: MemoryStoreState) -> String {
        state == .absent ? "absent" : String(value)
    }

    /// The headline reading strip: one measured number and what it counts.
    static func metricCard(value: String, caption: String, identifier: String) -> NSView {
        let card = CardView()
        card.setAccessibilityIdentifier(identifier)
        let number = NSTextField(labelWithString: value)
        number.font = Theme.Font.title
        number.textColor = Theme.primaryText
        number.compressHorizontally(priority: 460, toolTip: value)
        let label = NSTextField(labelWithString: caption)
        label.font = Theme.Font.screenSubtitle
        label.textColor = Theme.secondaryText
        label.compressHorizontally(priority: 440, toolTip: caption)
        card.contentStack.spacing = Theme.Space.xs
        card.contentStack.addArrangedSubview(number)
        card.contentStack.addArrangedSubview(label)
        card.pinToContentWidth(number)
        card.pinToContentWidth(label)
        return card
    }

    /// One store's reading, in one of three shapes. Absent draws its reason and
    /// no counts; empty draws its measured zeros and says the store exists;
    /// available draws what was counted. The identifier carries the state so a
    /// collapse of two of them cannot pass unnoticed.
    static func storeCard(
        name: String,
        identifier: String,
        caption: String,
        state: MemoryStoreState,
        readings: [(String, String)],
        role: StoreRole? = nil,
        actions: [NSView] = []
    ) -> CardView {
        let trailing = NSStackView(
            views: (role.map { [roleBadge($0)] } ?? []) + [stateBadge(state)] + actions)
        trailing.orientation = .horizontal
        trailing.alignment = .centerY
        trailing.spacing = Theme.Space.s
        let card = sectionCard(
            title: name,
            subtitle: caption,
            identifier: "\(identifier)-\(state.rawValue)",
            trailingView: trailing)
        card.dashed = state == .absent
        let reading = NSTextField(
            wrappingLabelWithString: MemoryScreenPresenter.store(state))
        reading.font = Theme.Font.callout
        reading.textColor = state == .absent ? Theme.tertiaryText : Theme.secondaryText
        reading.maximumNumberOfLines = 0
        card.add(reading)
        guard state != .absent else { return card }
        for (label, value) in readings {
            card.add(factRow(label, value))
        }
        return card
    }

    /// The topology's third part: one disposable projection over the two
    /// canonical stores. FTS and vectors are rebuilt from the records rather
    /// than read as one, so they are one card and not two first-class stores —
    /// but each still reports its own state in its own words, because a wired
    /// full-text index beside an absent vector index is two readings and a
    /// single badge over both would be a third one nobody measured.
    static func projectionCard(
        _ indexes: MemoryIndexHealth,
        action: NSView? = nil
    ) -> CardView {
        let trailing = NSStackView(
            views: [roleBadge(.projection)] + (action.map { [$0] } ?? []))
        trailing.orientation = .horizontal
        trailing.alignment = .centerY
        trailing.spacing = Theme.Space.s
        let card = sectionCard(
            title: "FTS + vectors",
            subtitle: "rebuildable projection · never a record",
            identifier: "memory-index-projection",
            trailingView: trailing)
        card.dashed = indexes.fts.state == .absent && indexes.vectors.state == .absent
        card.add(indexReading(
            "Full-text", indexes.fts.state,
            counts: "\(indexes.fts.articles) articles",
            identifier: "memory-index-fts-\(indexes.fts.state.rawValue)"))
        card.add(indexReading(
            "Semantic", indexes.vectors.state,
            counts: "\(indexes.vectors.articles) articles · "
                + "\(indexes.vectors.facts) facts",
            identifier: "memory-index-vectors-\(indexes.vectors.state.rawValue)"))
        card.add(factRow(
            "Embeddings",
            "\(indexes.vectors.provider.rawValue) · \(indexes.vectors.model) · "
                + "runtime \(indexes.vectors.runtime)"))
        return card
    }

    /// One index's line inside the projection card. An absent index draws its
    /// reason and no counts: a number for an index that is not wired would be
    /// this client's invention rather than the daemon's reading.
    private static func indexReading(
        _ name: String,
        _ state: MemoryStoreState,
        counts: String,
        identifier: String
    ) -> NSStackView {
        factRow(
            name,
            state == .absent
                ? MemoryScreenPresenter.store(state)
                : "\(MemoryScreenPresenter.store(state)) · \(counts)",
            identifier: identifier)
    }

    /// Which part of the topology a card is. The design draws the difference
    /// between a record and a rebuildable projection as words on the card, so
    /// it is drawn rather than left to be inferred from position.
    enum StoreRole {
        case canonical
        case projection
    }

    static func roleBadge(_ role: StoreRole) -> CapsuleBadge {
        switch role {
        case .canonical:
            return CapsuleBadge(text: "canonical", symbol: "lock.doc.fill", style: .positive)
        case .projection:
            return CapsuleBadge(
                text: "projection", symbol: "arrow.triangle.2.circlepath", style: .neutral)
        }
    }

    /// Every wiki scope with its own state, because one scope with rows and one
    /// without are two readings and never an average of the two.
    static func scopesCard(_ scopes: [MemoryOverviewProjection.Scope]) -> NSView {
        let card = sectionCard(
            title: "Wiki scopes",
            subtitle: "each scope reports its own state and counts",
            identifier: "memory-store-wiki-scopes")
        guard !scopes.isEmpty else {
            card.add(note(
                "The daemon reported no wiki scope for this store.",
                identifier: "memory-store-wiki-scopes-none",
                style: .quiet))
            return card
        }
        card.add(resultHeader(columns: [
            Column(text: "Articles", width: 96),
            Column(text: "Pitfalls", width: 96),
            Column(text: "Unverified", width: 108),
            Column(text: "Raw observations", width: 132),
        ]))
        for scope in scopes {
            let absent = scope.state == .absent
            card.add(resultRow(
                leading: stateBadge(scope.state),
                title: scope.scope.rawValue,
                detail: MemoryScreenPresenter.store(scope.state),
                columns: [
                    Column(text: count(scope.articles, scope.state), width: 96, mono: true),
                    Column(text: count(scope.pitfalls, scope.state), width: 96, mono: true),
                    Column(
                        text: count(scope.unverifiedPitfalls, scope.state),
                        width: 108, mono: true),
                    Column(
                        text: count(scope.rawObservations, scope.state),
                        width: 132, mono: true),
                ],
                identifier: "memory-store-wiki-\(scope.scope.rawValue)-\(scope.state.rawValue)",
                dimmed: absent))
        }
        return card
    }

    /// What the recall path can answer with right now. The self-test line is an
    /// explicit absence: this daemon projects no self-test result, and a screen
    /// that quietly omitted the row would read as if none had ever been asked for.
    static func recallHealthCard(
        indexes: MemoryIndexHealth,
        config: MemoryConfigProjection
    ) -> NSView {
        let card = sectionCard(
            title: "Recall health",
            subtitle: "what a recall can draw on today",
            identifier: "memory-recall-health")
        card.add(factRow(
            "Full-text",
            "\(MemoryScreenPresenter.store(indexes.fts.state)) · "
                + "\(count(indexes.fts.articles, indexes.fts.state)) articles"))
        card.add(factRow(
            "Semantic",
            "\(MemoryScreenPresenter.store(indexes.vectors.state)) · "
                + "\(indexes.vectors.provider.rawValue) · \(indexes.vectors.model) · "
                + "\(count(indexes.vectors.articles, indexes.vectors.state)) articles · "
                + "\(count(indexes.vectors.facts, indexes.vectors.state)) facts"))
        card.add(factRow(
            "Last self-test",
            "not projected — this daemon records no self-test result"))
        card.add(factRow("Wake budget", "\(config.wakeBudgetTokens) tokens"))
        return card
    }

    static func configCard(
        _ config: MemoryConfigProjection,
        action: NSView? = nil
    ) -> CardView {
        let card = sectionCard(
            title: "Lifecycle policy",
            subtitle: "retention and sweep as the daemon holds them",
            identifier: "memory-config",
            trailingView: action)
        for (label, value) in [
            ("Configuration revision", config.revision),
            ("Hot event retention", "\(config.eventsHotDays) days"),
            ("Article stale threshold", "\(config.staleAfterDays) days"),
            ("Sweep interval", "\(config.sweepIntervalHours) hours"),
            ("Wake budget", "\(config.wakeBudgetTokens) tokens"),
            ("Embeddings", "\(config.embeddingProvider.rawValue) · \(config.embeddingModel)"),
        ] {
            card.add(factRow(label, value))
        }
        return card
    }

    /// A gap is a named absence the daemon reported. An empty list says so in
    /// words: silence would read the same as "not asked".
    static func gapsCard(_ gaps: [MemoryOverviewProjection.Gap]) -> CardView {
        let card = sectionCard(
            title: "Known integrity gaps",
            subtitle: "reported by the daemon, not inferred here",
            identifier: gaps.isEmpty ? "memory-gaps-none" : "memory-gaps")
        guard !gaps.isEmpty else {
            card.add(note(
                "The daemon reported no gaps for this store.",
                identifier: "memory-gaps-none-detail",
                style: .quiet))
            return card
        }
        boundedRows(
            into: card, count: gaps.count, bound: 4, noun: "reported gaps",
            identifier: "memory-gaps"
        ) { index in
            let gap = gaps[index]
            return resultRow(
                leading: CapsuleBadge(
                    text: "gap", symbol: "exclamationmark.triangle.fill", style: .warning),
                title: gap.code,
                detail: gap.detail,
                identifier: "memory-gap-\(gap.code)")
        }
        return card
    }

    /// The overview's reading of the receipts: one line each. The receipt with
    /// its progress and its readback belongs to Maintenance, and a second full
    /// rendering here would be a second place to fix — but a failure is never
    /// summarised away, so an error is carried into the line.
    static func operationsCard(_ receipts: [MemoryJobReceipt]) -> CardView {
        let card = sectionCard(
            title: "Recent memory operations",
            subtitle: "the latest receipt per operation · readbacks on Maintenance",
            identifier: "memory-operations")
        guard !receipts.isEmpty else {
            card.add(note(
                "No memory job has been recorded for this store.",
                identifier: "memory-operations-none",
                style: .quiet))
            return card
        }
        for receipt in receipts {
            let total = receipt.progress.total.map(String.init) ?? "unknown"
            let detail = "\(receipt.progress.step) · \(receipt.progress.done)/\(total)"
                + (receipt.summary.isEmpty ? "" : " · \(receipt.summary)")
                + (receipt.error.map { " · \($0)" } ?? "")
            card.add(resultRow(
                leading: jobBadge(receipt.state),
                title: receipt.kind.title,
                detail: detail,
                columns: [Column(text: receipt.startedAt, width: 168, mono: true)],
                identifier: "memory-operation-\(receipt.id)"))
        }
        return card
    }

    /// One receipt: what ran, how far it got, why it failed, and the readback it
    /// finished with. A failure is never summarised away, and a job with no
    /// readback says the readback is missing rather than showing nothing.
    static func jobsCard(
        title: String,
        subtitle: String,
        identifier: String? = nil,
        receipts: [MemoryJobReceipt],
        bound: Int? = nil
    ) -> NSView {
        let card = sectionCard(
            title: title,
            subtitle: subtitle,
            identifier: identifier ?? "memory-jobs")
        guard !receipts.isEmpty else {
            card.add(note(
                "No memory job has been recorded for this store.",
                identifier: "memory-jobs-none",
                style: .quiet))
            return card
        }
        boundedRows(
            into: card, count: receipts.count, bound: bound ?? receipts.count,
            noun: "receipts", identifier: identifier ?? "memory-jobs"
        ) { index in
            let receipt = receipts[index]
            let total = receipt.progress.total.map(String.init) ?? "unknown"
            let entry = NSStackView()
            entry.orientation = .vertical
            entry.alignment = .leading
            entry.spacing = Theme.Space.xs
            entry.setAccessibilityIdentifier("memory-job-receipt-\(receipt.id)")
            entry.addArrangedSubview(resultRow(
                leading: jobBadge(receipt.state),
                title: receipt.kind.title,
                detail: "\(receipt.progress.step) · \(receipt.progress.done)/\(total) · "
                    + "requested by \(receipt.requestedBy) · \(receipt.summary)",
                columns: [
                    Column(text: receipt.startedAt, width: 168, mono: true),
                    Column(text: receipt.finishedAt ?? "not yet", width: 168, mono: true),
                ],
                identifier: "memory-job-progress-\(receipt.id)",
                showsSeparator: false))
            var detail: [NSView] = []
            if let readback = receipt.readback {
                for key in readback.keys.sorted() {
                    detail.append(factRow(
                        "Readback · \(key)", readback[key]?.display ?? "unknown"))
                }
            } else {
                detail.append(factRow(
                    "Readback",
                    "none was recorded, so this job's final state is unread"))
            }
            if let error = receipt.error {
                detail.append(note(
                    error,
                    identifier: "memory-job-failure-\(receipt.id)",
                    style: .attention,
                    critical: true))
            }
            // Indented to the row's name column, so a readback reads as this
            // job's own rather than as another reading of the card.
            entry.addArrangedSubview(
                indent(column(detail), by: stateSlotWidth + Theme.Space.m))
            for view in entry.arrangedSubviews {
                view.widthAnchor.constraint(equalTo: entry.widthAnchor).isActive = true
            }
            return entry
        }
        return card
    }

    /// The recall outcome in one line, the way the design states it: provenance,
    /// how many rows survived, and what the bundle cost against its budget.
    static func outcomePanel(_ preview: MemoryRecallPreview) -> NSView {
        let panel = InsetPanelView()
        panel.setAccessibilityIdentifier("memory-recall-outcome")
        let text = "\(preview.semantic) · \(preview.rows.count) rows · "
            + "\(preview.tokens) of \(preview.budget) tokens · "
            + (preview.truncated ? "truncated" : "not truncated")
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = Theme.Font.monoCaption
        label.textColor = preview.truncated ? Theme.warning : Theme.positive
        label.maximumNumberOfLines = 0
        panel.contentStack.addArrangedSubview(label)
        label.widthAnchor.constraint(
            equalTo: panel.contentStack.widthAnchor).isActive = true
        return panel
    }

    /// One popup per filter the wire accepts, each carrying the daemon's own
    /// vocabulary. There is no sort control and no free-text search: the library
    /// is ordered by row key so a page walk cannot renumber under a concurrent
    /// write, and offering a query the wire refuses would be offering something
    /// that does not exist.
    static func filterControls(
        filter: MemoryLibraryFilter,
        enabled: Bool,
        onFilter: @escaping (MemoryLibraryFilter) -> Void
    ) -> NSView {
        func popup(
            _ identifier: String,
            _ everyRowTitle: String,
            _ options: [String],
            _ selected: Set<String>,
            _ apply: @escaping (Set<String>) -> MemoryLibraryFilter
        ) -> NSPopUpButton {
            let button = NSPopUpButton(frame: .zero, pullsDown: false)
            button.addItems(withTitles: [everyRowTitle] + options)
            button.selectItem(at: selected.sorted().first.flatMap {
                options.firstIndex(of: $0).map { $0 + 1 }
            } ?? 0)
            button.isEnabled = enabled
            button.font = Theme.Font.chromeControl
            button.controlSize = .small
            button.setAccessibilityIdentifier(identifier)
            ShellButtonTarget.shared.register(button) { [weak button] in
                guard let index = button?.indexOfSelectedItem else { return }
                onFilter(apply(index == 0 ? [] : [options[index - 1]]))
            }
            button.target = ShellButtonTarget.shared
            button.action = #selector(ShellButtonTarget.fire(_:))
            return button
        }
        let caption = NSTextField(labelWithString: "Filters")
        caption.font = Theme.Font.sectionLabel
        caption.textColor = Theme.tertiaryText
        let stack = NSStackView(views: [
            caption,
            popup(
                "memory-library-filter-kind", "All kinds",
                MemoryLibraryFilter.kindOptions, filter.kinds,
                { MemoryLibraryFilter(
                    kinds: $0, scopes: filter.scopes, statuses: filter.statuses) }),
            popup(
                "memory-library-filter-scope", "All scopes",
                MemoryLibraryFilter.scopeOptions, filter.scopes,
                { MemoryLibraryFilter(
                    kinds: filter.kinds, scopes: $0, statuses: filter.statuses) }),
            popup(
                "memory-library-filter-status", "Any status",
                MemoryLibraryFilter.statusOptions, filter.statuses,
                { MemoryLibraryFilter(
                    kinds: filter.kinds, scopes: filter.scopes, statuses: $0) }),
            NSView.spacer(),
        ])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = Theme.Space.s
        return stack
    }

    static func pageControls(
        pager: MemoryLibraryPager,
        enabled: Bool,
        onPage: @escaping (MemoryLibraryStep) -> Void
    ) -> NSView {
        func button(
            _ title: String,
            _ symbol: String,
            _ identifier: String,
            _ step: MemoryLibraryStep?
        ) -> NSButton {
            let button = ActionButton(title: title, symbol: symbol)
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
        position.font = Theme.Font.monoCaption
        position.textColor = Theme.secondaryText
        position.setAccessibilityIdentifier("memory-library-page")
        let stack = NSStackView(views: [
            button("Previous page", "chevron.left", "memory-library-previous", pager.previousStep),
            button("Next page", "chevron.right", "memory-library-next", pager.nextStep),
            position,
        ])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = Theme.Space.s
        return stack
    }

    // MARK: - The shared row, header and note idioms

    /// The one result row every Memory list draws: a state badge, the row's own
    /// name with its provenance beneath, the schema's fixed columns, and an
    /// optional trailing state. Two lists of memory rows cannot drift into two
    /// idioms while they both come from here.
    static func resultRow(
        leading: NSView? = nil,
        title: String,
        detail: String,
        columns: [Column] = [],
        trailing: NSView? = nil,
        identifier: String,
        showsSeparator: Bool = true,
        dimmed: Bool = false
    ) -> DataTableRowView {
        let name = NSTextField(labelWithString: title)
        name.font = Theme.Font.body
        name.textColor = dimmed ? Theme.tertiaryText : Theme.primaryText
        name.lineBreakMode = .byTruncatingTail
        name.compressHorizontally(priority: 460, toolTip: title)
        let provenance = NSTextField(labelWithString: detail)
        provenance.font = Theme.Font.caption
        provenance.textColor = Theme.secondaryText
        provenance.lineBreakMode = .byTruncatingTail
        provenance.compressHorizontally(priority: 440, toolTip: detail)
        let names = NSStackView(views: [name, provenance])
        names.orientation = .vertical
        names.alignment = .leading
        names.spacing = 2

        var views: [NSView] = [slot(leading, width: Self.stateSlotWidth), names]
        views += columns.map(cell)
        if let trailing { views.append(slot(trailing, width: Self.stateSlotWidth)) }
        let row = DataTableRowView(
            columns: views, spacing: Theme.Space.m, showsSeparator: showsSeparator)
        fill(names, in: row, besides: views, columns: columns, hasTrailing: trailing != nil)
        row.setAccessibilityIdentifier(identifier)
        return row
    }

    /// The column captions above a table, in the same widths as its rows: the
    /// same leading state slot and the same flexible name column, so a caption
    /// sits over the cells it names.
    static func resultHeader(columns: [Column], hasTrailingState: Bool = false) -> NSView {
        let cells = columns.map { column -> NSView in
            let label = NSTextField(labelWithString: column.text.uppercased())
            label.font = Theme.Font.sectionLabel
            label.textColor = Theme.tertiaryText
            label.lineBreakMode = .byTruncatingTail
            label.widthAnchor.constraint(equalToConstant: column.width).isActive = true
            return label
        }
        let flexible = NSView()
        flexible.translatesAutoresizingMaskIntoConstraints = false
        flexible.heightAnchor.constraint(equalToConstant: 1).isActive = true
        var views: [NSView] = [slot(nil, width: Self.stateSlotWidth), flexible]
        views += cells
        if hasTrailingState { views.append(slot(nil, width: Self.stateSlotWidth)) }
        let row = DataTableRowView(
            columns: views, spacing: Theme.Space.m, showsSeparator: true)
        fill(flexible, in: row, besides: views, columns: columns, hasTrailing: hasTrailingState)
        row.setAccessibilityIdentifier("memory-table-head")
        return row
    }

    /// The name column takes the width the fixed cells leave. A stack decides
    /// that from hugging priorities, and a nested stack does not answer to the
    /// content hugging its caller sets — so the row states the arithmetic itself
    /// and a caption always lands over the cells it names.
    private static func fill(
        _ flexible: NSView,
        in row: NSView,
        besides views: [NSView],
        columns: [Column],
        hasTrailing: Bool
    ) {
        let slots = stateSlotWidth * (hasTrailing ? 2 : 1)
        let cells = columns.reduce(0) { $0 + $1.width }
        let gaps = Theme.Space.m * CGFloat(views.count - 1)
        flexible.widthAnchor.constraint(
            equalTo: row.widthAnchor, constant: -(slots + cells + gaps)).isActive = true
    }

    /// A fixed-width home for a badge. A capsule takes its width from its own
    /// text, so without a slot every row would indent its title differently and
    /// the columns would step in and out along the table.
    private static func slot(_ view: NSView?, width: CGFloat) -> NSView {
        let holder = NSView()
        holder.translatesAutoresizingMaskIntoConstraints = false
        holder.widthAnchor.constraint(equalToConstant: width).isActive = true
        guard let view else {
            holder.heightAnchor.constraint(equalToConstant: 1).isActive = true
            return holder
        }
        holder.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: holder.leadingAnchor),
            view.trailingAnchor.constraint(lessThanOrEqualTo: holder.trailingAnchor),
            view.topAnchor.constraint(equalTo: holder.topAnchor),
            view.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
        ])
        return holder
    }

    private static let stateSlotWidth: CGFloat = 108

    static func factRow(
        _ label: String,
        _ value: String,
        identifier: String? = nil
    ) -> NSStackView {
        let name = NSTextField(labelWithString: label)
        name.font = Theme.Font.screenSubtitle
        name.textColor = Theme.secondaryText
        name.compressHorizontally(priority: 470, toolTip: label)
        name.widthAnchor.constraint(greaterThanOrEqualToConstant: 132).isActive = true
        let reading = NSTextField(wrappingLabelWithString: value)
        reading.font = Theme.Font.monoCaption
        reading.textColor = Theme.primaryText
        reading.maximumNumberOfLines = 2
        reading.compressHorizontally(priority: 460, toolTip: value)
        let row = NSStackView(views: [name, reading])
        row.orientation = .horizontal
        row.alignment = .firstBaseline
        row.spacing = Theme.Space.s
        if let identifier { row.setAccessibilityIdentifier(identifier) }
        return row
    }

    static func note(
        _ text: String,
        identifier: String,
        style: NoteStyle,
        critical: Bool = false
    ) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = Theme.Font.callout
        switch style {
        case .quiet: label.textColor = Theme.secondaryText
        case .attention: label.textColor = critical ? Theme.critical : Theme.warning
        }
        label.maximumNumberOfLines = 0
        label.setAccessibilityIdentifier(identifier)
        return label
    }

    /// Adds a list to a card that draws only its first `bound` rows and always
    /// says how many there are. Bounding is not hiding: the count line names the
    /// true total and the control that lifts the bound names how many it will
    /// draw, so a short view can never be read as the whole set. A list no
    /// longer than its bound draws every row and no count line, because there is
    /// nothing there to mistake for completeness.
    static func boundedRows(
        into card: CardView,
        count: Int,
        bound: Int,
        noun: String,
        identifier: String,
        row: @escaping (Int) -> NSView
    ) {
        card.add(MemoryBoundedListView(
            count: count, bound: bound, noun: noun, slug: identifier, row: row))
    }

    /// A control the daemon does not offer yet, named as the absence it is.
    static func gapCard(title: String, identifier: String, detail: String) -> NSView {
        let card = sectionCard(
            title: title,
            subtitle: "contract gap",
            identifier: identifier,
            trailingView: CapsuleBadge(
                text: "not wired", symbol: "questionmark.circle.fill", style: .neutral))
        card.dashed = true
        card.add(note(detail, identifier: "\(identifier)-detail", style: .quiet))
        return card
    }

    static func stateBadge(_ state: MemoryStoreState) -> CapsuleBadge {
        switch state {
        case .absent:
            return CapsuleBadge(
                text: "absent", symbol: "questionmark.circle.fill", style: .neutral)
        case .empty:
            return CapsuleBadge(text: "empty", symbol: "tray", style: .info)
        case .ok:
            return CapsuleBadge(
                text: "available", symbol: "checkmark.circle.fill", style: .positive)
        }
    }

    /// A memory row's lifecycle, badged by what it claims about itself.
    static func lifecycleBadge(_ status: String) -> CapsuleBadge {
        switch status {
        case "verified", "current":
            return CapsuleBadge(
                text: status, symbol: "checkmark.seal.fill", style: .positive)
        case "unverified", "stale":
            return CapsuleBadge(
                text: status, symbol: "exclamationmark.triangle.fill", style: .warning)
        case "conflicted":
            return CapsuleBadge(text: status, symbol: "arrow.triangle.branch", style: .critical)
        default:
            return CapsuleBadge(text: status, symbol: "circle.fill", style: .neutral)
        }
    }

    static func jobBadge(_ state: MemoryJobState) -> CapsuleBadge {
        switch state {
        case .running:
            return CapsuleBadge(text: state.rawValue, symbol: "clock.fill", style: .info)
        case .succeeded:
            return CapsuleBadge(
                text: state.rawValue, symbol: "checkmark.circle.fill", style: .positive)
        case .failed:
            return CapsuleBadge(
                text: state.rawValue, symbol: "xmark.octagon.fill", style: .critical)
        }
    }

    // MARK: - Layout

    static func sectionCard(
        title: String,
        subtitle: String? = nil,
        identifier: String,
        trailingView: NSView? = nil
    ) -> SectionCardView {
        let card = SectionCardView(
            title: title, subtitle: subtitle, trailingView: trailingView)
        card.setAccessibilityIdentifier(identifier)
        // A card in a grid row is as tall as the tallest card beside it, and the
        // surplus height would otherwise be shared out between the rows inside
        // it — pushing the last ones off the page. The filler takes the surplus
        // instead, so the readings stay together at the top of every card, and
        // `add` keeps inserting above it.
        let filler = MemoryCardFiller()
        filler.translatesAutoresizingMaskIntoConstraints = false
        filler.heightAnchor.constraint(greaterThanOrEqualToConstant: 0).isActive = true
        filler.setContentHuggingPriority(.init(1), for: .vertical)
        filler.setContentCompressionResistancePriority(.init(1), for: .vertical)
        card.contentStack.addArrangedSubview(filler)
        return card
    }

    static func indent(_ view: NSView, by leading: CGFloat) -> NSView {
        let host = NSView()
        host.translatesAutoresizingMaskIntoConstraints = false
        view.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: host.leadingAnchor, constant: leading),
            view.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            view.topAnchor.constraint(equalTo: host.topAnchor),
            view.bottomAnchor.constraint(equalTo: host.bottomAnchor),
        ])
        return host
    }

    /// A column of cards that keeps every card at its own height. A stack pours
    /// surplus height into whichever card hugs least, which reads as one card
    /// swelling and the ones under it falling off the page.
    static func column(_ views: [NSView]) -> NSView {
        let host = NSView()
        host.translatesAutoresizingMaskIntoConstraints = false
        var previous: NSView?
        for view in views {
            view.translatesAutoresizingMaskIntoConstraints = false
            host.addSubview(view)
            NSLayoutConstraint.activate([
                view.leadingAnchor.constraint(equalTo: host.leadingAnchor),
                view.trailingAnchor.constraint(equalTo: host.trailingAnchor),
                previous.map {
                    view.topAnchor.constraint(
                        equalTo: $0.bottomAnchor, constant: Theme.Space.m)
                } ?? view.topAnchor.constraint(equalTo: host.topAnchor),
            ])
            previous = view
        }
        guard let last = previous else { return host }
        last.bottomAnchor.constraint(lessThanOrEqualTo: host.bottomAnchor).isActive = true
        let natural = last.bottomAnchor.constraint(equalTo: host.bottomAnchor)
        natural.priority = .init(250)
        natural.isActive = true
        return host
    }

    /// Equal columns with a shared rhythm. A short last row keeps the column
    /// width of a full one rather than stretching its cards across the page.
    static func grid(_ views: [NSView], columns: Int) -> NSView {
        var rows: [NSView] = []
        for start in stride(from: 0, to: views.count, by: columns) {
            var slice = Array(views[start..<min(start + columns, views.count)])
            while slice.count < columns { slice.append(NSView()) }
            let row = NSStackView(views: slice)
            row.orientation = .horizontal
            row.alignment = .top
            row.distribution = .fillEqually
            row.spacing = Theme.Space.m
            rows.append(row)
        }
        let stack = NSStackView(views: rows)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.m
        for row in rows {
            row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        return stack
    }

    /// The two-column reading order the design uses for a list and its context:
    /// the narrow column keeps its width and the wide one takes the rest, stated
    /// as arithmetic because a stack left to its own devices packs both columns
    /// against the leading edge and leaves the page half empty.
    static func split(main: NSView, aside: NSView, asideLeads: Bool = false) -> NSView {
        let stack = NSStackView(views: asideLeads ? [aside, main] : [main, aside])
        stack.orientation = .horizontal
        stack.alignment = .top
        stack.spacing = Theme.Space.m
        aside.widthAnchor.constraint(equalToConstant: asideWidth).isActive = true
        main.widthAnchor.constraint(
            equalTo: stack.widthAnchor,
            constant: -(asideWidth + Theme.Space.m)).isActive = true
        return stack
    }

    private static let asideWidth: CGFloat = 320

    private static func cell(_ column: Column) -> NSView {
        let label = NSTextField(labelWithString: column.text)
        label.font = column.mono ? Theme.Font.monoCaption : Theme.Font.caption
        label.textColor = Theme.secondaryText
        label.lineBreakMode = .byTruncatingTail
        label.compressHorizontally(priority: 450, toolTip: column.text)
        label.widthAnchor.constraint(equalToConstant: column.width).isActive = true
        return label
    }
}

/// A list that draws a bounded number of its rows and names the total either
/// way. The bound is a reading aid, so lifting it is a click rather than a
/// second screen, and the count line is part of the list rather than an
/// ornament beside it.
private final class MemoryBoundedListView: NSView {
    private let stack = NSStackView()
    private let count: Int
    private let bound: Int
    private let noun: String
    private let slug: String
    private let row: (Int) -> NSView
    private var expanded = false

    init(
        count: Int,
        bound: Int,
        noun: String,
        slug: String,
        row: @escaping (Int) -> NSView
    ) {
        self.count = count
        self.bound = bound
        self.noun = noun
        self.slug = slug
        self.row = row
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.xs
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        render()
    }

    private func render() {
        for view in stack.arrangedSubviews {
            stack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        let shown = expanded ? count : min(count, bound)
        for index in 0..<shown { append(row(index), fullWidth: true) }
        guard count > bound else { return }
        append(
            MemoryScreenParts.note(
                expanded
                    ? "Showing all \(count) \(noun)."
                    : "Showing \(shown) of \(count) \(noun).",
                identifier: "\(slug)-count",
                style: .quiet),
            fullWidth: true)
        let button = ActionButton(
            title: expanded ? "Show \(bound)" : "Show all \(count)",
            symbol: expanded ? "chevron.up" : "chevron.down")
        button.setAccessibilityIdentifier("\(slug)-expand")
        ShellButtonTarget.shared.register(button) { [weak self] in
            guard let self else { return }
            expanded.toggle()
            render()
        }
        button.target = ShellButtonTarget.shared
        button.action = #selector(ShellButtonTarget.fire(_:))
        append(button, fullWidth: false)
    }

    private func append(_ view: NSView, fullWidth: Bool) {
        stack.addArrangedSubview(view)
        guard fullWidth else { return }
        view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

/// The empty last row that absorbs a stretched card's surplus height.
private final class MemoryCardFiller: NSView {}

private extension CardView {
    /// Adds one full-width row to a card's content, above the filler that holds
    /// the readings at the top. Every Memory row spans its card, so the width
    /// constraint belongs with the add rather than at each call site.
    func add(_ view: NSView) {
        if contentStack.arrangedSubviews.last is MemoryCardFiller {
            contentStack.insertArrangedSubview(
                view, at: contentStack.arrangedSubviews.count - 1)
        } else {
            contentStack.addArrangedSubview(view)
        }
        pinToContentWidth(view)
    }
}

private enum MemoryPage {
    /// Every Memory screen opens the same way: the registry's title, the copy
    /// that says what the screen is, the projection's own state, and then its
    /// cards. The state block is read from the screen projection alone, so a
    /// screen cannot claim a health its projection never reported, and a screen
    /// with no observed value still says what it cannot show.
    static func install(
        route: ShellRoute,
        screen: ShellScreenProjection,
        subtitle: String,
        actions: [NSView],
        content: [NSView],
        in host: NSView
    ) {
        host.translatesAutoresizingMaskIntoConstraints = false
        let badge = CapsuleBadge(
            text: screen.stateHeadline,
            symbol: symbol(for: screen),
            style: style(for: screen))
        badge.setAccessibilityIdentifier("memory-screen-state-\(route.rawValue)")
        let header = PageHeaderView(
            title: route.title, subtitle: subtitle, actions: actions + [badge])

        var views: [NSView] = [header, provenance(screen)]
        if screen.availability != .current {
            let explanation = MemoryScreenParts.note(
                screen.stateExplanation,
                identifier: "memory-screen-explanation-\(route.rawValue)",
                style: .quiet)
            let panel = InsetPanelView()
            panel.contentStack.addArrangedSubview(explanation)
            explanation.widthAnchor.constraint(
                equalTo: panel.contentStack.widthAnchor).isActive = true
            views.append(panel)
        }
        views += content

        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.Space.l
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
        for view in views {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
    }

    /// The provenance of what is on the page: when it was observed, which
    /// revision it came from, and how fresh that read is. An unknown field says
    /// so rather than reading as a value.
    private static func provenance(_ screen: ShellScreenProjection) -> NSView {
        let text = "Observed at \(screen.observedAt ?? "never") · "
            + "revision \(screen.source.revision ?? "unknown") · "
            + "\(screen.freshness.rawValue)"
        let label = NSTextField(labelWithString: text)
        label.font = Theme.Font.chromeMetadata
        label.textColor = Theme.tertiaryText
        label.lineBreakMode = .byTruncatingTail
        label.compressHorizontally(priority: 440, toolTip: text)
        return label
    }

    /// Severity comes from the projection's own banner, which WorkspaceCore
    /// already derives, so this screen does not hold a second opinion about what
    /// an availability means.
    private static func style(for screen: ShellScreenProjection) -> CapsuleBadge.Style {
        switch screen.banner?.severity {
        case .none: return screen.availability == .current ? .positive : .neutral
        case .info?: return .info
        case .warning?: return .warning
        case .critical?: return .critical
        }
    }

    private static func symbol(for screen: ShellScreenProjection) -> String {
        switch screen.banner?.severity {
        case .none:
            return screen.availability == .current
                ? "checkmark.circle.fill"
                : "questionmark.circle.fill"
        case .info?: return "info.circle.fill"
        case .warning?: return "exclamationmark.triangle.fill"
        case .critical?: return "xmark.octagon.fill"
        }
    }
}
