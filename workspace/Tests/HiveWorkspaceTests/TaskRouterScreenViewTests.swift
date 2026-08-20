// TaskRouterScreenViewTests.swift
//
// Pins the card-list Task Router against the frozen routing corpora without
// going through ShellFixtureStore.loadState — that path is currently blocked
// by a pre-existing snapshot digest mismatch outside this screen.
//
// The screen is a dumb view: every card is the daemon's route for one task,
// expected share is the daemon's configured share and vanishes on an unsent
// edit, and the add menu is the daemon's routing catalog minus the members.

import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore

@MainActor
final class TaskRouterScreenViewTests: XCTestCase {

    private typealias WireRoute = RoutingPolicyDocument.WireRoute

    private var fixtureDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("WorkspaceCoreTests/Fixtures")
    }

    private var denseFixtureDirectory: URL {
        fixtureDirectory.deletingLastPathComponent().appendingPathComponent("Fixtures-dense")
    }

    private func loadRow<Value: Decodable>(
        _ name: String,
        from directory: URL? = nil
    ) throws -> ClientProjection<Value> {
        let url = (directory ?? fixtureDirectory).appendingPathComponent("\(name).json")
        let rows = try JSONDecoder().decode(
            [ClientProjection<Value>].self, from: Data(contentsOf: url))
        return try XCTUnwrap(rows.first { $0.availability == .current })
    }

    private func fixturePolicy(dense: Bool = false) throws -> RoutingPolicyDocument {
        let policy: ClientProjection<RoutingPolicyDocument> = try loadRow(
            "routing-policy-corpus", from: dense ? denseFixtureDirectory : fixtureDirectory)
        return try XCTUnwrap(policy.value)
    }

    private func fixtureRouting(dense: Bool = false) throws -> WorkspaceRoutingPresentation {
        let modelControl: ClientProjection<WorkspaceModelControlView> = try loadRow(
            "model-control-corpus", from: dense ? denseFixtureDirectory : fixtureDirectory)
        return try XCTUnwrap(modelControl.value?.routing)
    }

    /// An editor whose draft has moved away from the fixture observation.
    private func editedEditor(
        dense: Bool = false,
        _ edit: (inout TaskRouterEditor) throws -> Void
    ) throws -> TaskRouterEditor {
        var editor = TaskRouterEditor(
            snapshot: TaskRouterSnapshot(policy: try fixturePolicy(dense: dense)))
        try edit(&editor)
        return editor
    }

    private func makeView(
        availability: ProjectionAvailability = .current,
        dense: Bool = false,
        editor: TaskRouterEditor? = nil,
        probeState: ShellProviderProbeRefreshState = .idle,
        onProbe: @escaping () -> Void = {},
        onEditRoute: @escaping (TaskCategory, WireRoute?) -> Void = { _, _ in },
        onApply: @escaping () -> Void = {}
    ) throws -> TaskRouterScreenView {
        let directory = dense ? denseFixtureDirectory : fixtureDirectory
        let inspection: ClientProjection<RouteInspection> = try loadRow(
            "routing-inspection-corpus", from: directory)
        let routing = try fixtureRouting(dense: dense)
        let frozen = inspection.frozenScreen(facts: [])
        let screen = ShellScreenProjection(
            availability: availability,
            freshness: frozen.freshness,
            source: frozen.source,
            observedAt: "2026-07-29T20:00:00.000Z",
            evidence: frozen.evidence,
            contract: frozen.contract,
            facts: frozen.facts)
        let resolvedEditor = try editor ?? TaskRouterEditor(
            snapshot: TaskRouterSnapshot(policy: try fixturePolicy(dense: dense)),
            availability: availability)
        return TaskRouterScreenView(
            screen: screen,
            editor: resolvedEditor,
            categories: routing.categories,
            routing: routing,
            probeState: probeState,
            onProbe: onProbe,
            onEditRoute: onEditRoute,
            onApply: onApply)
    }

    private func find(_ view: NSView, _ identifier: String) -> NSView? {
        if view.accessibilityIdentifier() == identifier { return view }
        for subview in view.subviews {
            if let match = find(subview, identifier) { return match }
        }
        return nil
    }

    private func findAll(_ view: NSView, prefix: String) -> [NSView] {
        var found: [NSView] = []
        if view.accessibilityIdentifier().hasPrefix(prefix) { found.append(view) }
        for subview in view.subviews { found += findAll(subview, prefix: prefix) }
        return found
    }

    private func allText(in view: NSView) -> String {
        var found: [String] = []
        if let field = view as? NSTextField { found.append(field.stringValue) }
        for subview in view.subviews { found.append(allText(in: subview)) }
        return found.joined(separator: "\n")
    }

    private func textFields(in view: NSView) -> [NSTextField] {
        var fields = view.subviews.flatMap(textFields(in:))
        if let field = view as? NSTextField { fields.insert(field, at: 0) }
        return fields
    }

    /// Alignment-rect start, so a label's 2pt bezel inset does not read as drift.
    private func shareText(_ view: NSView, _ category: String, _ key: String) throws -> String {
        let share = try XCTUnwrap(find(view, "task-router-share-\(category)-\(key)"))
        return try XCTUnwrap(textFields(in: share).first).stringValue
    }

    private func startX(of child: NSView, in ancestor: NSView) -> CGFloat {
        let aligned = child.alignmentRect(forFrame: child.frame)
        return (child.superview ?? child).convert(aligned, to: ancestor).minX
    }

    private func addMenuItem(
        in view: NSView, category: String, key: String
    ) throws -> NSMenuItem {
        let popup = try XCTUnwrap(
            find(view, "task-router-add-\(category)") as? NSPopUpButton)
        return try XCTUnwrap(
            popup.menu?.items.compactMap(\.submenu).flatMap(\.items).first {
                $0.representedObject as? String == key
            },
            "\(key) must be offered on \(category)")
    }

    private let complexCoding = TaskCategory.complexCoding.rawValue
    private let opus = "claude/claude-opus-4-8"
    private let sol = "codex/gpt-5.6-sol"

    // MARK: Composition

    func testCardListUsesDesignSystemPrimitivesAndDropsTheMatrixAndInspection() throws {
        let view = try makeView()
        XCTAssertNotNil(find(view, "hds-page-header"))
        XCTAssertNotNil(find(view, "task-router-card-\(complexCoding)") as? SectionCardView)
        XCTAssertNotNil(
            find(view, "task-router-row-\(complexCoding)-\(opus)") as? DataTableRowView)
        XCTAssertNotNil(find(view, "hds-capsule-badge"))
        XCTAssertNotNil(find(view, "task-router-apply") as? ActionButton)
        XCTAssertNotNil(find(view, "task-router-refresh") as? ActionButton)
        XCTAssertNotNil(find(view, "task-router-routes"))
        XCTAssertNil(find(view, "task-router-matrix"), "the task/vendor matrix is gone")
        XCTAssertNil(find(view, "task-router-category"), "every card edits in place")
        let text = allText(in: view)
        XCTAssertFalse(text.contains("Observed inspection"))
        XCTAssertFalse(text.contains("Routing inspection unavailable"))
        XCTAssertFalse(text.contains("Review V3 draft"))
        XCTAssertFalse(text.contains("The selected row is the editor"))
    }

    func testSummaryStaysProjectionBacked() throws {
        let text = allText(in: try makeView())
        XCTAssertTrue(text.contains("schema 3 revision"))
        XCTAssertTrue(text.contains("5 route members"))
        XCTAssertTrue(text.contains("2 / 3 providers enabled"))
        XCTAssertTrue(text.contains("3 policy models with state enabled"))
        XCTAssertTrue(text.contains("weights 1–100"))
        XCTAssertFalse(text.contains("1 enabled models"))
        XCTAssertFalse(text.contains("Observed at "))

        let dense = allText(in: try makeView(dense: true))
        XCTAssertTrue(dense.contains("10 / 10 routes"))
        XCTAssertTrue(dense.contains("4 / 5 providers enabled"))
        XCTAssertTrue(dense.contains("5 route members"))
        XCTAssertTrue(dense.contains("15 policy models with state enabled"))
    }

    func testNonCurrentAvailabilityKeepsObservedTimeOnTheBadgeTooltip() throws {
        let view = try makeView(availability: .stale)
        XCTAssertFalse(allText(in: view).contains("Observed at "))
        let badge = try XCTUnwrap(find(view, "task-router-availability"))
        XCTAssertEqual(badge.toolTip, "Observed at 2026-07-29T20:00:00.000Z")
        XCTAssertTrue(allText(in: view).contains("Stale"))
        XCTAssertNotNil(find(view, "task-router-readonly"))
        let editing = [
            "task-router-mode-", "task-router-add-", "task-router-clear-",
            "task-router-configure-", "task-router-member-", "task-router-effort-",
            "task-router-weight-", "task-router-stored-weight-", "task-router-apply",
        ]
        let controls = findAll(view, prefix: "task-router-").compactMap { $0 as? NSControl }
            .filter { control in
                control.accessibilityIdentifier() != "task-router-weight-refusal"
                    && editing.contains { control.accessibilityIdentifier().hasPrefix($0) }
            }
        XCTAssertGreaterThan(controls.count, 20)
        for control in controls {
            XCTAssertFalse(
                control.isEnabled,
                "\(control.accessibilityIdentifier()) must not accept an edit against a stale read")
        }
    }

    // MARK: Cards

    func testEveryCategoryIsOneCardWhoseRowsAreExactlyItsMembers() throws {
        let view = try makeView(dense: true)
        let routing = try fixtureRouting(dense: true)
        let policy = try fixturePolicy(dense: true)
        XCTAssertEqual(routing.categories.count, 10)
        let catalogKeys = Set(routing.catalog.map { "\($0.provider)/\($0.model)" })

        for category in routing.categories {
            let card = try XCTUnwrap(
                find(view, "task-router-card-\(category.rawValue)"),
                "missing card \(category.rawValue)")
            XCTAssertTrue(allText(in: card).contains(category.label))
            XCTAssertTrue(allText(in: card).contains(category.rawValue))
            XCTAssertNotNil(
                find(card, "task-router-mode-\(category.rawValue)") as? NSSegmentedControl)
            XCTAssertNotNil(
                find(card, "task-router-add-\(category.rawValue)") as? NSPopUpButton)
            XCTAssertNil(
                find(card, "task-router-draft-\(category.rawValue)"),
                "an unedited card carries no draft badge")

            let members = policy.categories[category.rawValue]?.candidates ?? []
            let rows = findAll(card, prefix: "task-router-row-\(category.rawValue)-")
            XCTAssertEqual(
                rows.count, members.count,
                "\(category.rawValue) renders its members and nothing else")
            for candidate in members {
                let key = "\(candidate.provider)/\(candidate.model)"
                XCTAssertNotNil(find(card, "task-router-row-\(category.rawValue)-\(key)"))
                XCTAssertEqual(
                    (find(card, "task-router-member-\(category.rawValue)-\(key)")
                        as? NSButton)?.title,
                    "Remove")
            }
            // Catalog models that are not members are offered by the menu,
            // never flooded onto the card.
            for key in catalogKeys where !members.contains(where: {
                "\($0.provider)/\($0.model)" == key
            }) {
                XCTAssertNil(find(card, "task-router-row-\(category.rawValue)-\(key)"))
            }
        }
    }

    func testColumnsShareOneLayoutAcrossHeaderAndRowsAtEveryWidth() throws {
        let view = try makeView(dense: true)
        let head = try XCTUnwrap(
            find(view, "task-router-columns-\(complexCoding)") as? DataTableRowView)
        let rows = [opus, sol].map {
            find(view, "task-router-row-\(complexCoding)-\($0)") as? DataTableRowView
        }
        for width: CGFloat in [940, 1_420, 1_728] {
            view.frame = NSRect(x: 0, y: 0, width: width, height: 4_000)
            view.layoutSubtreeIfNeeded()
            for row in rows {
                let row = try XCTUnwrap(row)
                for (column, headColumn) in zip(
                    row.columnStack.arrangedSubviews, head.columnStack.arrangedSubviews
                ) {
                    XCTAssertEqual(
                        startX(of: column, in: view), startX(of: headColumn, in: view),
                        accuracy: 0.5, "column drifted at \(width)pt")
                }
            }
        }
    }

    // MARK: Expected share and status are the daemon's

    func testExpectedShareIsTheDaemonsConfiguredShareAndVanishesOnAnUnsentEdit() throws {
        let observed = try makeView()
        XCTAssertEqual(try shareText(observed, complexCoding, opus), "75%")
        XCTAssertEqual(try shareText(observed, complexCoding, sol), "25%")

        let edited = try makeView(editor: try editedEditor { editor in
            var route = try XCTUnwrap(editor.draft.policy.categories[self.complexCoding])
            route.candidates[0].weight = 40
            editor.setRoute(route, for: .complexCoding)
        })
        for key in [opus, sol] {
            let share = try XCTUnwrap(find(edited, "task-router-share-\(complexCoding)-\(key)"))
            XCTAssertEqual(try shareText(edited, complexCoding, key), "—",
                           "the view computes no share of its own")
            XCTAssertEqual(share.toolTip, "Expected share comes from the daemon after Apply.")
        }
        XCTAssertNotNil(find(edited, "task-router-draft-\(complexCoding)"))
        // Other cards keep their daemon share.
        XCTAssertEqual(try shareText(edited, "planning", opus), "100%")
    }

    func testCandidateStatusCaptionsComeFromTheDaemon() throws {
        let view = try makeView()
        XCTAssertEqual(
            (find(view, "task-router-status-\(complexCoding)-\(opus)") as? NSTextField)?.stringValue,
            "exact enabled model")
        XCTAssertEqual(
            (find(view, "task-router-status-\(complexCoding)-\(sol)") as? NSTextField)?.stringValue,
            "not in live catalog")
    }

    // MARK: Membership

    func testAddMenuOffersOnlyCatalogNonMembersGroupedByVendor() throws {
        var edited: (TaskCategory, WireRoute?)?
        let view = try makeView(onEditRoute: { edited = ($0, $1) })
        let routing = try fixtureRouting()
        let popup = try XCTUnwrap(
            find(view, "task-router-add-\(complexCoding)") as? NSPopUpButton)
        XCTAssertTrue(popup.pullsDown)
        XCTAssertEqual(popup.itemTitles.first, "Add model…")
        XCTAssertEqual(
            popup.menu?.items.dropFirst().map(\.title),
            ["Claude", "Codex", "Grok", "Kimi", "OpenCode"])

        let offered = Set(popup.menu?.items.compactMap(\.submenu).flatMap(\.items)
            .compactMap { $0.representedObject as? String } ?? [])
        let members = Set(try XCTUnwrap(routing.policy.categories[complexCoding])
            .candidates.map { "\($0.provider)/\($0.model)" })
        let expected = Set(routing.catalog.map { "\($0.provider)/\($0.model)" })
            .subtracting(members)
        XCTAssertEqual(offered, expected, "offers the catalog minus the members")
        XCTAssertFalse(offered.isEmpty)

        let item = try addMenuItem(in: view, category: complexCoding, key: "grok/grok-composer-2.5-fast")
        XCTAssertTrue(NSApp.sendAction(try XCTUnwrap(item.action), to: item.target, from: item))
        let (category, route) = try XCTUnwrap(edited)
        XCTAssertEqual(category, .complexCoding)
        let added = try XCTUnwrap(route?.candidates.first { $0.model == "grok-composer-2.5-fast" })
        let entry = try XCTUnwrap(routing.catalog.first { $0.model == "grok-composer-2.5-fast" })
        XCTAssertEqual(added.effort, entry.startingEffort, "the daemon's starting effort")
        XCTAssertEqual(added.weight, routing.weightRange.defaultValue, "the daemon's default weight")
        XCTAssertEqual(route?.candidates.count, 3, "existing members are kept")
    }

    func testRemoveDropsTheCandidateAndRestorePutsTheObservedOneBack() throws {
        var edited: (TaskCategory, WireRoute?)?
        let view = try makeView(onEditRoute: { edited = ($0, $1) })
        let remove = try XCTUnwrap(
            find(view, "task-router-member-\(complexCoding)-\(opus)") as? NSButton)
        XCTAssertEqual(remove.title, "Remove")
        remove.performClick(nil)
        let removed = try XCTUnwrap(edited?.1)
        XCTAssertFalse(removed.candidates.contains { $0.model == "claude-opus-4-8" })
        XCTAssertEqual(removed.candidates.count, 1)

        var restored: (TaskCategory, WireRoute?)?
        let afterRemove = try makeView(
            editor: try editedEditor { $0.setRoute(removed, for: .complexCoding) },
            onEditRoute: { restored = ($0, $1) })
        let row = try XCTUnwrap(
            find(afterRemove, "task-router-row-\(complexCoding)-\(opus)"),
            "a removed observed member stays on the card until Apply")
        XCTAssertLessThan(row.alphaValue, 1)
        XCTAssertEqual(
            (find(afterRemove, "task-router-status-\(complexCoding)-\(opus)") as? NSTextField)?
                .stringValue,
            "removed in this draft")
        XCTAssertFalse(
            try XCTUnwrap(find(afterRemove, "task-router-effort-\(complexCoding)-\(opus)")
                as? NSControl).isEnabled)
        let restore = try XCTUnwrap(
            find(afterRemove, "task-router-member-\(complexCoding)-\(opus)") as? NSButton)
        XCTAssertEqual(restore.title, "Restore")
        restore.performClick(nil)
        let observed = try XCTUnwrap(try fixturePolicy().categories[complexCoding]?
            .candidates.first { $0.model == "claude-opus-4-8" })
        XCTAssertEqual(
            restored?.1?.candidates.first { $0.model == "claude-opus-4-8" },
            observed,
            "restore is the daemon's candidate, effort and weight included")
    }

    // MARK: Weight, effort, mode

    func testWeightStepperAndTypedWeightWriteTheDraft() throws {
        var edited: WireRoute?
        let view = try makeView(onEditRoute: { edited = $1 })
        let weightOf = { (route: WireRoute?) in
            route?.candidates.first { $0.model == "claude-opus-4-8" }?.weight
        }
        let field = try XCTUnwrap(
            find(view, "task-router-weight-\(complexCoding)-\(opus)") as? NSTextField)
        XCTAssertEqual(field.stringValue, "3")
        XCTAssertTrue(field.isEnabled)

        try XCTUnwrap(find(view, "task-router-weight-up-\(complexCoding)-\(opus)") as? NSButton)
            .performClick(nil)
        XCTAssertEqual(weightOf(edited), 4)
        try XCTUnwrap(find(view, "task-router-weight-down-\(complexCoding)-\(opus)") as? NSButton)
            .performClick(nil)
        XCTAssertEqual(weightOf(edited), 2)

        field.stringValue = "40"
        field.sendAction(field.action, to: field.target)
        XCTAssertEqual(weightOf(edited), 40)

        edited = nil
        field.stringValue = "abc"
        field.sendAction(field.action, to: field.target)
        XCTAssertNil(edited, "a refused weight never becomes a draft")
        let refusal = try XCTUnwrap(find(view, "task-router-weight-refusal") as? NSTextField)
        XCTAssertFalse(refusal.isHidden)
        XCTAssertTrue(refusal.stringValue.contains("abc"))
        XCTAssertFalse(try XCTUnwrap(find(view, "task-router-apply") as? NSButton).isEnabled)
    }

    func testEqualSplitKeepsTheStoredWeightLegibleButNotEditable() throws {
        let view = try makeView(dense: true)
        let planning = "planning"
        let stepper = try XCTUnwrap(find(view, "task-router-stored-weight-\(planning)-\(opus)"))
        let field = try XCTUnwrap(
            find(view, "task-router-weight-\(planning)-\(opus)") as? NSTextField)
        XCTAssertFalse(field.isHidden)
        XCTAssertFalse(field.isEnabled)
        XCTAssertEqual(field.stringValue, "1")
        XCTAssertTrue(try XCTUnwrap(stepper.toolTip).contains("ignores stored weights"))
        XCTAssertFalse(
            try XCTUnwrap(find(view, "task-router-weight-up-\(planning)-\(opus)") as? NSButton)
                .isEnabled)
    }

    func testModeSwitchOffersTheDaemonsModesAndWritesTheDraft() throws {
        var edited: (TaskCategory, WireRoute?)?
        let view = try makeView(onEditRoute: { edited = ($0, $1) })
        let routing = try fixtureRouting()
        let mode = try XCTUnwrap(
            find(view, "task-router-mode-\(complexCoding)") as? NSSegmentedControl)
        let labels = (0..<mode.segmentCount).map { mode.label(forSegment: $0) ?? "" }
        XCTAssertEqual(labels, routing.modes.map(\.label))
        XCTAssertEqual(labels[mode.selectedSegment], "Weighted split")

        mode.selectedSegment = try XCTUnwrap(labels.firstIndex(of: "Equal split"))
        mode.sendAction(mode.action, to: mode.target)
        XCTAssertEqual(edited?.0, .complexCoding)
        XCTAssertEqual(edited?.1?.mode, RouterMode.hiveEqual.rawValue)
        XCTAssertEqual(edited?.1?.candidates.count, 2, "switching mode keeps the members")
    }

    func testEffortPresentationUsesOneSpellingForLabelsAndPopups() throws {
        let view = try makeView(dense: true)
        let popup = try XCTUnwrap(
            find(view, "task-router-effort-planning-\(opus)") as? NSPopUpButton)
        XCTAssertEqual(popup.selectedItem?.title, "Hive decides")
        XCTAssertTrue(popup.itemTitles.contains("Provider controlled"))
        XCTAssertFalse(popup.itemTitles.contains("provider-controlled"))
        XCTAssertFalse(popup.itemTitles.contains("hive-decides"))
        let text = allText(in: view)
        XCTAssertFalse(text.contains("provider-controlled"))
        XCTAssertFalse(text.contains("hive-decides"))
    }

    func testCataloglessMemberStatesWhyEffortCannotBeEdited() throws {
        let view = try makeView(dense: true)
        let key = "claude/claude-fable-5"
        let popup = try XCTUnwrap(
            find(view, "task-router-effort-heavy_research-\(key)") as? NSPopUpButton)
        XCTAssertFalse(popup.isEnabled)
        XCTAssertEqual(popup.selectedItem?.title, "Provider controlled")
        let refusal = try XCTUnwrap(
            find(view, "task-router-effort-refusal-heavy_research-\(key)") as? NSTextField)
        XCTAssertTrue(refusal.stringValue.contains("not in the live routing catalog"))
        XCTAssertEqual(
            (find(view, "task-router-status-heavy_research-\(key)") as? NSTextField)?.stringValue,
            "not in live catalog")
    }

    // MARK: Route lifecycle and Apply

    func testClearUnconfiguresAndConfigureStartsFromTheDaemonsDefaultMode() throws {
        var edited: (TaskCategory, WireRoute?)?
        let view = try makeView(onEditRoute: { edited = ($0, $1) })
        try XCTUnwrap(find(view, "task-router-clear-\(complexCoding)") as? NSButton)
            .performClick(nil)
        XCTAssertEqual(edited?.0, .complexCoding)
        XCTAssertNil(try XCTUnwrap(edited).1, "clearing sends an unconfigured route")

        var configured: (TaskCategory, WireRoute?)?
        let cleared = try makeView(
            editor: try editedEditor { $0.setRoute(nil, for: .complexCoding) },
            onEditRoute: { configured = ($0, $1) })
        let card = try XCTUnwrap(find(cleared, "task-router-card-\(complexCoding)"))
        XCTAssertTrue(allText(in: card).contains("no route configured"))
        XCTAssertTrue(findAll(card, prefix: "task-router-row-").isEmpty)
        XCTAssertNil(find(card, "task-router-clear-\(complexCoding)"))
        XCTAssertFalse(
            try XCTUnwrap(find(card, "task-router-add-\(complexCoding)") as? NSControl).isEnabled)
        XCTAssertFalse(
            try XCTUnwrap(find(card, "task-router-mode-\(complexCoding)") as? NSControl).isEnabled)
        try XCTUnwrap(find(card, "task-router-configure-\(complexCoding)") as? NSButton)
            .performClick(nil)
        XCTAssertEqual(
            configured?.1,
            WireRoute(mode: try fixtureRouting().defaultMode, candidates: []))
    }

    func testApplyWaitsForEveryEditedRouteToBeSendable() throws {
        var applied = 0
        let clean = try makeView(onApply: { applied += 1 })
        XCTAssertFalse(try XCTUnwrap(find(clean, "task-router-apply") as? NSButton).isEnabled)

        let emptied = try makeView(editor: try editedEditor {
            $0.setRoute(WireRoute(mode: "user-weighted", candidates: []), for: .complexCoding)
        })
        XCTAssertFalse(try XCTUnwrap(find(emptied, "task-router-apply") as? NSButton).isEnabled)
        let empty = try XCTUnwrap(find(emptied, "task-router-empty-route") as? NSTextField)
        XCTAssertTrue(empty.stringValue.contains(TaskCategory.complexCoding.label))
        // The observed members stay on the card as restorable rows, so the
        // user can see what "empty" removed.
        for key in [opus, sol] {
            XCTAssertEqual(
                (find(emptied, "task-router-member-\(complexCoding)-\(key)") as? NSButton)?.title,
                "Restore")
        }

        let ready = try makeView(
            editor: try editedEditor { editor in
                var route = try XCTUnwrap(editor.draft.policy.categories[self.complexCoding])
                route.candidates[0].weight = 40
                editor.setRoute(route, for: .complexCoding)
            },
            onApply: { applied += 1 })
        let apply = try XCTUnwrap(find(ready, "task-router-apply") as? NSButton)
        XCTAssertTrue(apply.isEnabled)
        XCTAssertTrue(allText(in: ready).contains("Unsent draft edit: \(TaskCategory.complexCoding.label)"))
        apply.performClick(nil)
        XCTAssertEqual(applied, 1)
    }

    func testRefreshUsesTheExistingProbeActionAndState() throws {
        var refreshes = 0
        let idle = try makeView(onProbe: { refreshes += 1 })
        let refresh = try XCTUnwrap(
            find(idle, "task-router-refresh") as? ActionButton)
        XCTAssertEqual(refresh.title, "Refresh")
        XCTAssertTrue(refresh.isEnabled)
        refresh.performClick(nil)
        XCTAssertEqual(refreshes, 1)

        let refreshing = try makeView(probeState: .refreshing)
        let pending = try XCTUnwrap(
            find(refreshing, "task-router-refresh") as? ActionButton)
        XCTAssertEqual(pending.title, "Refreshing provider probes…")
        XCTAssertFalse(pending.isEnabled)

        let succeeded = try makeView(probeState: .succeeded("2 providers refreshed"))
        XCTAssertEqual(
            (find(succeeded, "task-router-probe-status") as? NSTextField)?.stringValue,
            "2 providers refreshed")
        let failed = try makeView(probeState: .failed("probe request failed"))
        XCTAssertEqual(
            (find(failed, "task-router-probe-error") as? NSTextField)?.stringValue,
            "probe request failed")
    }

    #if HIVE_QA_BUILD
    func testQAControlSelectsTheModeSegmentByTitleAndWritesTheDraft() throws {
        var edited: WireRoute?
        let view = try makeView(onEditRoute: { edited = $1 })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1_200, height: 1_000),
                              styleMask: .titled, backing: .buffered, defer: false)
        window.contentView?.addSubview(view)

        let response = QAControl.process(
            verb: "select", identifier: "task-router-mode-\(complexCoding)", input: nil,
            itemTitle: "Equal split", itemIndex: nil,
            window: window, route: "router", requestId: "request")

        XCTAssertEqual(response.status, "ok")
        XCTAssertEqual(edited?.mode, RouterMode.hiveEqual.rawValue)
    }
    #endif
}
