// OuterHorizonScreenView.swift Live Run's outer horizon: a virtualized semantic hierarchy beside the run, gate, budget, review, train, incident, and stranded-work projections that came from the same WorkspaceSnapshot v2 observation.

import AppKit
import WorkspaceCore

final class OuterHorizonScreenView: NSView, NSTableViewDataSource, NSTableViewDelegate {
    private let horizon: OuterHorizonScreenState
    private let rows: [OuterHorizonTreeRow]
    private let tableView = NSTableView()
    private let onSelect: (String) -> Void
    private let onToggleExpansion: (String) -> Void
    private var synchronizingSelection = false

    init(
        screen: ShellScreenProjection,
        horizon: OuterHorizonScreenState,
        onSelect: @escaping (String) -> Void,
        onToggleExpansion: @escaping (String) -> Void
    ) {
        self.horizon = horizon
        rows = horizon.visibleRows
        self.onSelect = onSelect
        self.onToggleExpansion = onToggleExpansion
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        setAccessibilityIdentifier("outer-horizon-screen")

        let hierarchy = makeHierarchyRail()
        hierarchy.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let hierarchyWidth = hierarchy.widthAnchor.constraint(equalToConstant: 292)
        hierarchyWidth.priority = NSLayoutConstraint.Priority(200)
        hierarchy.widthAnchor.constraint(lessThanOrEqualToConstant: 292).isActive = true
        let separator = NSBox.hdsSeparator()
        separator.widthAnchor.constraint(equalToConstant: 1).isActive = true
        let detail = makeDetailScroll(screen: screen)

        let row = NSStackView(views: [hierarchy, separator, detail])
        row.translatesAutoresizingMaskIntoConstraints = false
        row.orientation = .horizontal
        row.distribution = .fill
        row.spacing = 0
        row.alignment = .top
        row.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            hierarchyWidth,
            separator.heightAnchor.constraint(equalTo: row.heightAnchor),
        ])
        synchronizeSelection()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(
        _ tableView: NSTableView,
        viewFor tableColumn: NSTableColumn?,
        row: Int
    ) -> NSView? {
        let item = rows[row]
        let cell = OuterHorizonTreeCell(
            row: item,
            expanded: horizon.navigation.expandedNodeIds.contains(item.node.nodeId),
            target: self,
            action: #selector(toggleExpansion(_:)))
        cell.disclosure.tag = row
        return cell
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !synchronizingSelection,
              tableView.selectedRow >= 0,
              tableView.selectedRow < rows.count else { return }
        onSelect(rows[tableView.selectedRow].node.nodeId)
    }

    @objc private func toggleExpansion(_ sender: NSButton) {
        guard rows.indices.contains(sender.tag) else { return }
        onToggleExpansion(rows[sender.tag].node.nodeId)
    }

    @objc private func toggleSelectedExpansion(_ sender: Any?) {
        guard tableView.selectedRow >= 0,
              tableView.selectedRow < rows.count,
              rows[tableView.selectedRow].hasChildren else { return }
        onToggleExpansion(rows[tableView.selectedRow].node.nodeId)
    }

    private func synchronizeSelection() {
        guard let nodeId = horizon.navigation.visibleSelection(in: horizon.snapshot.nodes),
              let index = rows.firstIndex(where: { $0.node.nodeId == nodeId }) else {
            return
        }
        synchronizingSelection = true
        tableView.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
        tableView.scrollRowToVisible(index)
        synchronizingSelection = false
    }

    private func makeHierarchyRail() -> NSView {
        let title = NSTextField(labelWithString: "Run hierarchy")
        title.font = Theme.Font.title
        let topology = NSTextField(labelWithString: topologySummary)
        topology.font = Theme.Font.caption
        topology.textColor = .secondaryLabelColor
        topology.compressHorizontally(priority: 430, toolTip: topology.stringValue)

        let header = NSStackView(views: [title, topology])
        header.orientation = .vertical
        header.alignment = .leading
        header.spacing = Theme.Space.xs
        header.edgeInsets = NSEdgeInsets(
            top: Theme.Space.l,
            left: Theme.Space.l,
            bottom: Theme.Space.m,
            right: Theme.Space.l)

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("hierarchy"))
        column.resizingMask = .autoresizingMask
        tableView.addTableColumn(column)
        tableView.headerView = nil
        tableView.rowHeight = 44
        tableView.intercellSpacing = NSSize(width: 0, height: 1)
        tableView.selectionHighlightStyle = .regular
        tableView.allowsEmptySelection = true
        tableView.delegate = self
        tableView.dataSource = self
        tableView.target = self
        tableView.doubleAction = #selector(toggleSelectedExpansion(_:))
        tableView.setAccessibilityIdentifier("outer-horizon-hierarchy")

        let scroll = NSScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = tableView
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false

        let footer = NSTextField(labelWithString: budgetSummary)
        footer.font = Theme.Font.monoCaption
        footer.textColor = .secondaryLabelColor
        footer.maximumNumberOfLines = 2
        footer.lineBreakMode = .byWordWrapping
        let footerBox = NSStackView(views: [footer])
        footerBox.orientation = .vertical
        footerBox.alignment = .leading
        footerBox.edgeInsets = NSEdgeInsets(
            top: Theme.Space.m,
            left: Theme.Space.l,
            bottom: Theme.Space.l,
            right: Theme.Space.l)

        let rail = NSStackView(views: [header, NSBox.hdsSeparator(), scroll,
                                      NSBox.hdsSeparator(), footerBox])
        rail.translatesAutoresizingMaskIntoConstraints = false
        rail.orientation = .vertical
        rail.spacing = 0
        rail.alignment = .leading
        header.widthAnchor.constraint(equalTo: rail.widthAnchor).isActive = true
        scroll.widthAnchor.constraint(equalTo: rail.widthAnchor).isActive = true
        footerBox.widthAnchor.constraint(equalTo: rail.widthAnchor).isActive = true
        scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
        return rail
    }

    private func makeDetailScroll(screen: ShellScreenProjection) -> NSView {
        let scroll = NSScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = true
        scroll.backgroundColor = .windowBackgroundColor
        scroll.setAccessibilityIdentifier("outer-horizon-detail-scroll")

        let document = FlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = document

        let content = NSStackView()
        content.translatesAutoresizingMaskIntoConstraints = false
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = Theme.Space.l
        document.addSubview(content)
        NSLayoutConstraint.activate([
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            content.leadingAnchor.constraint(
                equalTo: document.leadingAnchor, constant: Theme.Space.l),
            content.trailingAnchor.constraint(
                equalTo: document.trailingAnchor, constant: -Theme.Space.l),
            content.topAnchor.constraint(
                equalTo: document.topAnchor, constant: Theme.Space.l),
            content.bottomAnchor.constraint(
                equalTo: document.bottomAnchor, constant: -Theme.Space.l),
        ])

        let heading = makeHeading(screen: screen)
        content.addArrangedSubview(heading)
        heading.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        for card in makeCards() {
            content.addArrangedSubview(card)
            card.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        }
        return scroll
    }

    private func makeHeading(screen: ShellScreenProjection) -> NSView {
        let title = NSTextField(labelWithString: "Outer horizon")
        title.font = Theme.Font.largeTitle
        let subtitle = NSTextField(labelWithString:
            "WorkspaceSnapshot v2 · revision \(horizon.snapshot.seq) · "
            + "\(horizon.snapshot.nodes.count) admitted / 19 target · 32 global cap")
        subtitle.font = Theme.Font.callout
        subtitle.textColor = .secondaryLabelColor
        subtitle.compressHorizontally(priority: 430, toolTip: subtitle.stringValue)
        let explanation = NSTextField(wrappingLabelWithString: screen.stateExplanation)
        explanation.font = Theme.Font.caption
        explanation.textColor = .secondaryLabelColor
        explanation.maximumNumberOfLines = 0
        explanation.compressHorizontally(priority: 200, toolTip: explanation.stringValue)
        let observed = screen.observedAt.map {
            let label = NSTextField(labelWithString: "Observed at \($0)")
            label.font = Theme.Font.caption
            label.textColor = .tertiaryLabelColor
            label.compressHorizontally(priority: 200, toolTip: $0)
            return label
        }
        let status = CapsuleBadge(
            text: screen.stateHeadline,
            symbol: screen.availability == .current ? "checkmark.circle.fill" : "clock.fill",
            style: screen.availability == .current ? .neutral : .info)

        let copy = NSStackView(
            views: [title, subtitle, explanation] + (observed.map { [$0] } ?? []))
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = Theme.Space.xs
        copy.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let row = NSStackView(views: [copy, NSView(), status])
        row.orientation = .horizontal
        row.alignment = .centerY
        return row
    }

    private func makeCards() -> [CardView] {
        var cards: [CardView] = []
        cards.append(contentsOf: runCards())
        cards.append(selectedNodeCard())
        cards.append(contentsOf: budgetCards())
        cards.append(collectionCard(title: "Reviews", rows: reviewFacts()))
        cards.append(collectionCard(title: "Incidents & ownership transfer", rows: incidentFacts()))
        cards.append(collectionCard(title: "Stranded work attention", rows: strandedFacts()))
        if !horizon.snapshot.unknownEntities.isEmpty {
            let rows = horizon.snapshot.unknownEntities.map {
                ShellScreenFact(
                    label: $0.kind,
                    value: "unrecognized entity kind · \($0.id) · revision \($0.entityRevision)")
            }
            cards.append(collectionCard(title: "Unknown entity kinds", rows: rows))
        }
        return cards
    }

    private func runCards() -> [CardView] {
        guard !horizon.snapshot.runs.isEmpty else {
            return [collectionCard(
                title: "Run control & gates",
                rows: [ShellScreenFact(
                    label: "Run entity",
                    value: "absent — no hierarchy-run entity was observed")])]
        }
        return horizon.snapshot.runs.map { run in
            collectionCard(title: "Run control & gates", rows: [
                ShellScreenFact(label: "Run", value: "\(run.runID) · revision \(run.entityRevision)"),
                ShellScreenFact(label: "Root", value: Self.field(run.root) {
                    "queen root · \($0.instanceId) · \($0.repo)"
                }),
                ShellScreenFact(label: "Phase", value: Self.field(run.phase) { $0.rawValue }),
                ShellScreenFact(label: "Lifecycle", value: Self.field(run.lifecycle) { $0.rawValue }),
                ShellScreenFact(label: "Topology", value: Self.field(run.topologyShape) { $0.rawValue }),
                ShellScreenFact(label: "Topology source", value: Self.field(run.topologySource) { $0.rawValue }),
                ShellScreenFact(label: "G2", value: Self.field(run.g2, render: Self.g2)),
            ])
        }
    }

    private func selectedNodeCard() -> CardView {
        guard let node = horizon.selectedNode else {
            let value = horizon.snapshot.nodes.isEmpty
                ? "observed empty — the snapshot contains no hierarchy nodes"
                : "selection unavailable — the remembered node is outside this snapshot"
            return collectionCard(
                title: "Selected hierarchy node",
                rows: [ShellScreenFact(label: "Selection", value: value)])
        }
        return collectionCard(title: "Selected hierarchy node", rows: [
            ShellScreenFact(label: "Node", value: "\(node.nodeId) · revision \(node.entityRevision)"),
            ShellScreenFact(label: "Agent binding", value: Self.field(node.binding) {
                "\($0.agentId) · generation \($0.generation)"
            }),
            ShellScreenFact(label: "Role", value: Self.field(node.organizationalRole) { $0.rawValue }),
            ShellScreenFact(label: "Assignment", value: Self.field(node.assignmentKind) { $0.rawValue }),
            ShellScreenFact(label: "Task scope", value: Self.field(node.taskScope) {
                $0.isEmpty ? "observed empty (present [])" : $0.joined(separator: ", ")
            }),
            ShellScreenFact(label: "Lifecycle", value: Self.field(node.lifecycle) { $0.rawValue }),
            ShellScreenFact(label: "Parent", value: Self.field(node.parentNodeId) {
                $0.value ?? "observed root (present null)"
            }),
            ShellScreenFact(label: "Owner", value: Self.field(node.ownerNodeId) {
                $0.value ?? "observed unowned (present null)"
            }),
        ])
    }

    private func budgetCards() -> [CardView] {
        guard !horizon.snapshot.budgets.isEmpty else {
            return [collectionCard(
                title: "Run budget",
                rows: [ShellScreenFact(
                    label: "Budget entity",
                    value: "absent — no hierarchy-budget entity was observed")])]
        }
        return horizon.snapshot.budgets.map { budget in
            var rows = [ShellScreenFact(
                label: "Budget",
                value: "\(budget.runID) · revision \(budget.entityRevision)")]
            switch budget.limits {
            case .absent(let reason, let detail):
                rows.append(ShellScreenFact(
                    label: "Limits",
                    value: "absent · \(reason.rawValue) — \(detail)"))
            case .present(let limits):
                rows.append(contentsOf: [
                    Self.limit("Active sessions", limits.activeSessions),
                    Self.limit("Total spawns", limits.totalSpawns),
                    Self.limit("Per-lead crew", limits.perLeadCrew),
                    Self.limit("Reviewer pool", limits.reviewerPool),
                    Self.limit("Vendor quota", limits.vendorQuota),
                    Self.limit("Tokens", limits.tokens),
                    Self.limit("Cost cents", limits.costCents),
                    Self.limit("Wall time ms", limits.wallTimeMs),
                    Self.limit("CI", limits.ci),
                    Self.limit("Wake budget", limits.wakeBudget),
                    Self.limit("Message budget", limits.messageBudget),
                ])
            }
            return collectionCard(title: "Run budget", rows: rows)
        }
    }

    private func reviewFacts() -> [ShellScreenFact] {
        guard !horizon.snapshot.reviews.isEmpty else {
            return [Self.absentEntity("hierarchy-review")]
        }
        return horizon.snapshot.reviews.flatMap { projection in
            switch projection.reviews {
            case .absent(let reason, let detail):
                return [Self.absentField("Reviews", reason: reason, detail: detail)]
            case .present([]):
                return [ShellScreenFact(label: "Reviews", value: "observed empty (present [])")]
            case .present(let reviews):
                return reviews.map { review in
                    let invalidation: String
                    switch review.invalidation {
                    case .current: invalidation = "current"
                    case .invalidated(let reason): invalidation = "invalidated · \(reason.rawValue)"
                    }
                    return ShellScreenFact(
                        label: "\(review.verdict.rawValue) · \(review.reviewId)",
                        value: "task \(review.taskId) · reviewer \(review.reviewer.agentId) · "
                            + "\(invalidation) · candidate \(review.candidate.commitSha)")
                }
            }
        }
    }

    private func incidentFacts() -> [ShellScreenFact] {
        guard !horizon.snapshot.incidents.isEmpty else {
            return [Self.absentEntity("hierarchy-incident")]
        }
        var rows: [ShellScreenFact] = []
        for incident in horizon.snapshot.incidents {
            rows.append(contentsOf: Self.incidentList(
                "Run decisions", field: incident.runDecision) { decision in
                    let outcome: String
                    switch decision.outcome {
                    case .accepted: outcome = "accepted"
                    case .rejected(let code): outcome = "rejected · \(code)"
                    }
                    return "\(outcome) · observed revision \(decision.observedRevision)"
                })
            rows.append(contentsOf: Self.incidentList(
                "Ownership transfer", field: incident.recovery) { transfer in
                    "\(transfer.lostOwnerNodeId) → \(transfer.successorNodeId) · "
                        + "\(transfer.reason.rawValue) · revision \(transfer.hierarchyRevision)"
                })
            rows.append(ShellScreenFact(
                label: "Breaker",
                value: "absent · source-absent — \(incident.breaker.detail)"))
        }
        return rows
    }

    private func strandedFacts() -> [ShellScreenFact] {
        guard !horizon.snapshot.strandedManifests.isEmpty else {
            return [Self.absentEntity("hierarchy-stranded-manifest")]
        }
        return horizon.snapshot.strandedManifests.flatMap { manifest in
            switch manifest.items {
            case .absent(let reason, let detail):
                return [Self.absentField("Stranded items", reason: reason, detail: detail)]
            case .present([]):
                return [ShellScreenFact(
                    label: "Stranded items",
                    value: "observed empty (present [])")]
            case .present(let items):
                return items.map { item in
                    ShellScreenFact(
                        label: item.branch,
                        value: "\(item.disposition.rawValue) · node \(item.nodeId ?? "unknown") · "
                            + "\(item.unmergedCommits) commits · \(item.dirtyFileCount) dirty files")
                }
            }
        }
    }

    private func collectionCard(
        title: String,
        rows: [ShellScreenFact]
    ) -> CardView {
        let card = CardView()
        let heading = NSTextField(labelWithString: title)
        heading.font = Theme.Font.title
        card.contentStack.addArrangedSubview(heading)
        card.pinToContentWidth(heading)
        for fact in rows {
            let row = NSStackView()
            row.orientation = .horizontal
            row.alignment = .firstBaseline
            row.spacing = Theme.Space.m
            let label = NSTextField(labelWithString: fact.label)
            label.font = Theme.Font.callout
            label.textColor = .secondaryLabelColor
            label.compressHorizontally(priority: 440, toolTip: fact.label)
            label.widthAnchor.constraint(equalToConstant: 132).isActive = true
            let value = NSTextField(wrappingLabelWithString: fact.value)
            value.font = Theme.Font.monoBody
            value.maximumNumberOfLines = 0
            value.compressHorizontally(priority: 200, toolTip: fact.value)
            row.addArrangedSubview(label)
            row.addArrangedSubview(value)
            card.contentStack.addArrangedSubview(row)
            card.pinToContentWidth(row)
        }
        card.setAccessibilityIdentifier(
            "outer-horizon-" + title.lowercased()
                .replacingOccurrences(of: " ", with: "-")
                .replacingOccurrences(of: "&", with: "and"))
        return card
    }

    private var topologySummary: String {
        let topology = horizon.snapshot.runs.first.map {
            Self.field($0.topologyShape) { $0.rawValue }
        } ?? "topology entity absent"
        return "\(topology) · \(rows.count) visible / \(horizon.snapshot.nodes.count) admitted"
    }

    private var budgetSummary: String {
        guard let budget = horizon.snapshot.budgets.first else {
            return "Run budget absent · 19 target / 32 global cap"
        }
        switch budget.limits {
        case .absent(let reason, let detail):
            return "Run budget absent · \(reason.rawValue) — \(detail)"
        case .present(let limits):
            return "Run budget · \(limits.activeSessions.used) used / "
                + "\(limits.activeSessions.soft) soft / \(limits.activeSessions.hard) hard"
        }
    }

    private static func field<Value>(
        _ field: HierarchyProjectionField<Value>,
        render: (Value) -> String
    ) -> String where Value: Codable & Equatable & Sendable {
        switch field {
        case .present(let value): return render(value)
        case .absent(let reason, let detail):
            return "absent · \(reason.rawValue) — \(detail)"
        }
    }

    private static func g2(_ state: HierarchyRun.G2State) -> String {
        switch state {
        case .pending: return "pending"
        case .approved(let approval):
            return "approved · \(approval.decider) · \(approval.runStageSha)"
        }
    }

    private static func limit(
        _ label: String,
        _ limit: HierarchyRunBudget.Limit
    ) -> ShellScreenFact {
        ShellScreenFact(
            label: label,
            value: "used \(limit.used) · reserved \(limit.reserved) · "
                + "soft \(limit.soft) · hard \(limit.hard)")
    }

    private static func absentEntity(_ kind: String) -> ShellScreenFact {
        ShellScreenFact(
            label: "Entity",
            value: "absent — no \(kind) entity was observed")
    }

    private static func absentField(
        _ label: String,
        reason: HierarchyAbsenceReason,
        detail: String
    ) -> ShellScreenFact {
        ShellScreenFact(
            label: label,
            value: "absent · \(reason.rawValue) — \(detail)")
    }

    private static func incidentList<Value>(
        _ label: String,
        field: HierarchyProjectionField<[Value]>,
        render: (Value) -> String
    ) -> [ShellScreenFact] where Value: Codable & Equatable & Sendable {
        switch field {
        case .absent(let reason, let detail):
            return [absentField(label, reason: reason, detail: detail)]
        case .present([]):
            return [ShellScreenFact(label: label, value: "observed empty (present [])")]
        case .present(let values):
            return values.map { ShellScreenFact(label: label, value: render($0)) }
        }
    }
}

private final class OuterHorizonTreeCell: NSTableCellView {
    let disclosure: NSButton

    init(
        row: OuterHorizonTreeRow,
        expanded: Bool,
        target: AnyObject,
        action: Selector
    ) {
        disclosure = NSButton()
        super.init(frame: .zero)
        identifier = NSUserInterfaceItemIdentifier("outer-horizon-tree-cell")
        disclosure.isBordered = false
        disclosure.image = NSImage(
            systemSymbolName: expanded ? "chevron.down" : "chevron.right",
            accessibilityDescription: expanded ? "Collapse" : "Expand")
        disclosure.target = target
        disclosure.action = action
        disclosure.isHidden = !row.hasChildren
        disclosure.translatesAutoresizingMaskIntoConstraints = false

        let binding = Self.present(row.node.binding) { $0.agentId } ?? row.node.nodeId
        let role = Self.present(row.node.organizationalRole) { $0.rawValue } ?? "role absent"
        let assignment = Self.present(row.node.assignmentKind) { $0.rawValue }
            ?? "assignment absent"
        let lifecycle = Self.present(row.node.lifecycle) { $0.rawValue } ?? "lifecycle absent"

        let title = NSTextField(labelWithString: binding)
        title.font = Theme.Font.headline
        title.lineBreakMode = .byTruncatingTail
        title.compressHorizontally(priority: 300, toolTip: binding)
        let detail = NSTextField(labelWithString:
            "\(row.node.nodeId) · \(role) / \(assignment) · \(lifecycle)")
        detail.font = Theme.Font.caption
        detail.textColor = .secondaryLabelColor
        detail.lineBreakMode = .byTruncatingTail
        detail.compressHorizontally(priority: 250, toolTip: detail.stringValue)
        let copy = NSStackView(views: [title, detail])
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = 2
        copy.translatesAutoresizingMaskIntoConstraints = false

        addSubview(disclosure)
        addSubview(copy)
        NSLayoutConstraint.activate([
            disclosure.leadingAnchor.constraint(
                equalTo: leadingAnchor,
                constant: Theme.Space.s + CGFloat(row.depth) * Theme.Space.l),
            disclosure.centerYAnchor.constraint(equalTo: centerYAnchor),
            disclosure.widthAnchor.constraint(equalToConstant: 16),
            disclosure.heightAnchor.constraint(equalToConstant: 20),
            copy.leadingAnchor.constraint(equalTo: disclosure.trailingAnchor, constant: Theme.Space.s),
            copy.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Theme.Space.s),
            copy.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.row)
        setAccessibilityIdentifier("outer-horizon-node-\(row.node.nodeId)")
        setAccessibilityLabel(
            "\(binding), \(role), \(assignment), \(lifecycle)"
                + (row.parentDiagnostic.map { ", \($0)" } ?? ""))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private static func present<Value>(
        _ field: HierarchyProjectionField<Value>,
        render: (Value) -> String
    ) -> String? where Value: Codable & Equatable & Sendable {
        guard case .present(let value) = field else { return nil }
        return render(value)
    }
}
