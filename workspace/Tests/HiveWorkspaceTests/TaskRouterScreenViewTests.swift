// TaskRouterScreenViewTests.swift
//
// Pins the restyled Task Router against the frozen routing corpora without
// going through ShellFixtureStore.loadState — that path is currently blocked
// by a pre-existing snapshot digest mismatch outside this screen.

import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore

@MainActor
final class TaskRouterScreenViewTests: XCTestCase {

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

    private func makeView(
        category: TaskCategory? = nil,
        availability: ProjectionAvailability = .current,
        dense: Bool = false,
        probeState: ShellProviderProbeRefreshState = .idle,
        onProbe: @escaping () -> Void = {},
        onSelectCategory: @escaping (TaskCategory) -> Void = { _ in },
        onEditRoute: @escaping (RoutingPolicyDocument.WireRoute?) -> Void = { _ in },
        onApply: @escaping () -> Void = {}
    ) throws -> TaskRouterScreenView {
        let directory = dense ? denseFixtureDirectory : fixtureDirectory
        let policy: ClientProjection<RoutingPolicyDocument> = try loadRow(
            "routing-policy-corpus", from: directory)
        let modelControl: ClientProjection<WorkspaceModelControlView> = try loadRow(
            "model-control-corpus", from: directory)
        let inspection: ClientProjection<RouteInspection> = try loadRow(
            "routing-inspection-corpus", from: directory)
        let document = try XCTUnwrap(policy.value)
        let routing = try XCTUnwrap(modelControl.value?.routing)
        let selected = category ?? routing.categories.first!
        let facts = inspection.value.map { inspected -> [ShellScreenFact] in
            var rows = [
                ShellScreenFact(label: "Mode", value: inspected.mode ?? "unconfigured"),
            ]
            for candidate in inspected.candidates {
                var value = "\(candidate.candidate.provider)/\(candidate.candidate.model)"
                    + " · weight \(candidate.candidate.weight)"
                    + " · configured \(Int((candidate.configuredShare * 100).rounded()))%"
                    + " · live \(Int((candidate.liveShare * 100).rounded()))%"
                if let refusal = candidate.refusal {
                    value += " · \(refusal.gate): \(refusal.detail)"
                }
                rows.append(ShellScreenFact(label: "Candidate", value: value))
            }
            return rows
        } ?? []
        let frozen = inspection.frozenScreen(facts: facts)
        let screen = ShellScreenProjection(
            availability: availability,
            freshness: frozen.freshness,
            source: frozen.source,
            observedAt: "2026-07-29T20:00:00.000Z",
            evidence: frozen.evidence,
            contract: frozen.contract,
            facts: frozen.facts)
        return TaskRouterScreenView(
            screen: screen,
            editor: TaskRouterEditor(snapshot: TaskRouterSnapshot(policy: document)),
            categories: routing.categories,
            category: selected,
            routing: routing,
            probeState: probeState,
            onProbe: onProbe,
            onSelectCategory: onSelectCategory,
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

    private func startX(of child: NSView, in ancestor: NSView) -> CGFloat {
        ancestor.convert(child.bounds, from: child).minX
    }

    func testRestyleUsesDesignSystemPrimitivesAndKeepsTheEditor() throws {
        let view = try makeView()
        XCTAssertNotNil(find(view, "hds-page-header"))
        XCTAssertNotNil(find(view, "hds-section-card"))
        XCTAssertNotNil(find(view, "hds-data-row"))
        XCTAssertNotNil(find(view, "hds-capsule-badge"))
        XCTAssertNotNil(find(view, "task-router-apply") as? ActionButton)
        XCTAssertNotNil(find(view, "task-router-refresh") as? ActionButton)
        XCTAssertNotNil(find(view, "task-router-category") as? NSPopUpButton)
        XCTAssertNotNil(find(view, "task-router-mode") as? NSPopUpButton)
        XCTAssertNotNil(find(view, "task-router-matrix"))
    }

    func testEveryCataloguedCategoryIsListedAndSelectable() throws {
        var selected: TaskCategory?
        let modelControl: ClientProjection<WorkspaceModelControlView> = try loadRow(
            "model-control-corpus")
        let routing = try XCTUnwrap(modelControl.value?.routing)
        let view = try makeView(onSelectCategory: { selected = $0 })
        XCTAssertGreaterThanOrEqual(routing.categories.count, 2)
        for item in routing.categories {
            let row = try XCTUnwrap(
                find(view, "task-router-category-row-\(item.rawValue)") as? NSButton,
                "missing category row \(item.rawValue)")
            XCTAssertTrue(
                allText(in: view).contains(item.label),
                "missing category label \(item.label)")
            row.performClick(nil)
            XCTAssertEqual(selected, item)
        }
    }

    func testV3DocumentIsTheMatrixAndSharesStayInspectionFacts() throws {
        let view = try makeView()
        let text = allText(in: view)
        XCTAssertNil(find(view, "task-router-v3-gap"))
        XCTAssertFalse(text.contains("Policy V3 compare-and-set review is not in this projection"))
        XCTAssertFalse(text.contains("V3 review unavailable"))
        XCTAssertFalse(text.contains("Review V3 draft"))
        XCTAssertTrue(text.contains("schema 3 revision"))
        XCTAssertTrue(text.contains("5 route members"))
        XCTAssertTrue(text.contains("2 / 3 providers enabled"))
        XCTAssertTrue(text.contains("3 policy models with state enabled"))
        XCTAssertFalse(text.contains("1 enabled models"))
        XCTAssertTrue(text.contains("weight 60 · configured 60% · live 80%"))
        XCTAssertTrue(text.contains("weight 25 · configured 25% · live 0%"))
        XCTAssertTrue(text.contains("weight 15 · configured 15% · live 20%"))
        XCTAssertTrue(text.contains("pool-excluded"))
        XCTAssertTrue(text.contains("user-weighted"))
    }

    func testProjectionBackedCompositionOmitsTheRawAvailabilityPanel() throws {
        let view = try makeView()
        let text = allText(in: view)
        XCTAssertFalse(
            text.contains("The daemon projection for this screen is current"),
            "the generic availability paragraph is a second presentation")
        XCTAssertFalse(
            text.contains("full screen content ships with its own phase"),
            "the generic availability paragraph is a second presentation")
        XCTAssertFalse(
            text.contains("Observed at "),
            "projection timestamp does not keep a raw provenance row")
        XCTAssertTrue(text.contains("schema 3 revision"))
        XCTAssertTrue(text.contains("updated "))
        XCTAssertNil(find(view, "task-router-availability"))
        XCTAssertNotNil(find(view, "hds-capsule-badge"))
    }

    func testNonCurrentAvailabilityKeepsObservedTimeOnTheBadgeTooltip() throws {
        let view = try makeView(availability: .stale)
        XCTAssertFalse(allText(in: view).contains("Observed at "))
        let badge = try XCTUnwrap(find(view, "task-router-availability"))
        XCTAssertEqual(badge.toolTip, "Observed at 2026-07-29T20:00:00.000Z")
        XCTAssertTrue(allText(in: view).contains("Stale"))
    }

    func testMatrixListsEveryCategoryAndVendorBeforeInspection() throws {
        let view = try makeView()
        let stack = try XCTUnwrap(view.subviews.first as? NSStackView)
        let identifiers = stack.arrangedSubviews.compactMap { $0.accessibilityIdentifier() }
        let matrix = try XCTUnwrap(
            identifiers.firstIndex(of: "task-router-matrix"),
            "task/vendor matrix missing")
        XCTAssertNotNil(find(view, "task-router-category") as? NSPopUpButton)
        XCTAssertNotNil(find(view, "task-router-mode") as? NSPopUpButton)
        let modelControl: ClientProjection<WorkspaceModelControlView> = try loadRow(
            "model-control-corpus")
        let routing = try XCTUnwrap(modelControl.value?.routing)
        let policy: ClientProjection<RoutingPolicyDocument> = try loadRow(
            "routing-policy-corpus")
        let document = try XCTUnwrap(policy.value)
        let editor = TaskRouterEditor(snapshot: TaskRouterSnapshot(policy: document))
        let providers = editor.matrixProviders(routing: routing)
        XCTAssertEqual(providers, ["claude", "codex", "grok", "kimi", "opencode"])
        XCTAssertEqual(routing.categories.count, 10)
        for item in routing.categories {
            XCTAssertNotNil(
                find(view, "task-router-matrix-row-\(item.rawValue)"),
                "missing matrix row \(item.rawValue)")
            for provider in providers {
                XCTAssertNotNil(
                    find(view, "task-router-cell-\(item.rawValue)-\(provider)"),
                    "missing \(provider) cell on \(item.rawValue)")
            }
        }
        XCTAssertGreaterThan(identifiers.count, matrix)
    }

    func testProviderColumnsShareHeaderBodyAndEditorStartsAtEveryWindowWidth() throws {
        let view = try makeView(category: .complexCoding, dense: true)
        let providers = [
            (id: "claude", title: "Claude"),
            (id: "codex", title: "Codex"),
            (id: "grok", title: "Grok"),
            (id: "kimi", title: "Kimi"),
            (id: "opencode", title: "OpenCode"),
        ]

        for width: CGFloat in [940, 1_420, 1_728] {
            view.frame = NSRect(x: 0, y: 0, width: width, height: 3_000)
            view.layoutSubtreeIfNeeded()

            for provider in providers {
                let header = try XCTUnwrap(
                    find(view, "task-router-header-\(provider.id)"))
                let body = try XCTUnwrap(
                    find(view, "task-router-cell-code_review-\(provider.id)"))
                let editor = try XCTUnwrap(
                    find(view, "task-router-cell-complex_coding-\(provider.id)"))
                let headerX = startX(of: header, in: view)

                XCTAssertEqual(
                    startX(of: body, in: view), headerX, accuracy: 0.5,
                    "\(provider.title) body start drifted at \(width)pt")
                XCTAssertEqual(
                    startX(of: editor, in: view), headerX, accuracy: 0.5,
                    "\(provider.title) editor start drifted at \(width)pt")
            }
        }
    }

    func testDenseFixtureFactsRemainProjectionBacked() throws {
        let text = allText(in: try makeView(dense: true))
        XCTAssertTrue(text.contains("10 / 10 routes"))
        XCTAssertTrue(text.contains("4 / 5 providers enabled"))
        XCTAssertTrue(text.contains("5 route members"))
        XCTAssertTrue(text.contains("15 policy models with state enabled"))
    }

    func testNoMemberLabelsDoNotInstallDuplicateHelpTags() throws {
        let emptyLabels = textFields(in: try makeView(dense: true)).filter {
            $0.stringValue == "no member"
        }
        XCTAssertFalse(emptyLabels.isEmpty)
        XCTAssertTrue(emptyLabels.allSatisfy { $0.toolTip == nil })
    }

    func testEveryWeightedCandidateShowsItsStoredWeightTrackAndValue() throws {
        let view = try makeView(category: .complexCoding, dense: true)
        let weights = [
            ("simple_coding-codex/gpt-5.6-sol", 4),
            ("simple_coding-grok/grok-4.5", 1),
            ("complex_coding-claude/claude-opus-4-8", 3),
            ("complex_coding-codex/gpt-5.6-sol", 1),
            ("code_review-claude/claude-sonnet-5", 2),
            ("debugging-claude/claude-fable-5", 1),
        ]

        for (key, value) in weights {
            let weight = try XCTUnwrap(
                find(view, "task-router-stored-weight-\(key)"),
                "missing stored weight for \(key)")
            XCTAssertNotNil(find(weight, "hds-meter-bar"))
            let copy = allText(in: weight)
            XCTAssertTrue(copy.contains("Stored weight"))
            XCTAssertTrue(
                copy.contains("Stored weight \(value)")
                    || textFields(in: weight).contains { $0.stringValue == String(value) })
        }
    }

    func testEffortPresentationUsesOneSpellingForLabelsAndPopups() throws {
        let view = try makeView(
            category: TaskCategory(rawValue: "planning", label: "Planning"),
            dense: true)
        let text = allText(in: view)
        XCTAssertTrue(text.contains("Provider controlled"))
        XCTAssertTrue(text.contains("Hive decides"))
        XCTAssertFalse(text.contains("provider-controlled"))
        XCTAssertFalse(text.contains("hive-decides"))

        let popup = try XCTUnwrap(
            find(view, "task-router-effort-claude/claude-opus-4-8")
                as? NSPopUpButton)
        XCTAssertEqual(popup.selectedItem?.title, "Hive decides")
        XCTAssertTrue(popup.itemTitles.contains("Provider controlled"))
        XCTAssertFalse(popup.itemTitles.contains("provider-controlled"))
        XCTAssertFalse(popup.itemTitles.contains("hive-decides"))
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

    func testCataloglessMemberStatesWhyEffortCannotBeEdited() throws {
        let heavyResearch = TaskCategory(
            rawValue: "heavy_research", label: "Heavy research / synthesis")
        let view = try makeView(category: heavyResearch, dense: true)
        let popup = try XCTUnwrap(
            find(view, "task-router-effort-claude/claude-fable-5")
                as? NSPopUpButton)
        XCTAssertFalse(popup.isEnabled)
        XCTAssertEqual(popup.selectedItem?.title, "Provider controlled")
        let refusal = try XCTUnwrap(
            find(view, "task-router-effort-refusal-claude/claude-fable-5")
                as? NSTextField)
        XCTAssertTrue(refusal.stringValue.contains("not in the live routing catalog"))
        XCTAssertFalse(refusal.stringValue.contains("choose a substitute"))

        let collapsed = try makeView(dense: true)
        let collapsedCell = try XCTUnwrap(
            find(collapsed, "task-router-cell-heavy_research-claude"))
        XCTAssertTrue(allText(in: collapsedCell).contains("effort unavailable"))
    }

    func testExistingMembershipControlsStillWriteTheDraft() throws {
        var edited: RoutingPolicyDocument.WireRoute?
        let view = try makeView(
            category: .complexCoding,
            onEditRoute: { edited = $0 })
        let member = try XCTUnwrap(
            find(view, "task-router-member-grok/grok-composer-2.5-fast") as? NSButton)
        XCTAssertEqual(member.state, .off)
        member.performClick(nil)
        XCTAssertEqual(
            edited?.candidates.contains { $0.model == "grok-composer-2.5-fast" },
            true)

        let weight = try XCTUnwrap(
            find(view, "task-router-weight-claude/claude-opus-4-8") as? NSTextField)
        weight.stringValue = "40"
        weight.sendAction(weight.action, to: weight.target)
        XCTAssertEqual(
            edited?.candidates.first { $0.model == "claude-opus-4-8" }?.weight,
            40)
    }

    #if HIVE_QA_BUILD
    func testQAControlSelectsRouterModeByIndexAndWritesTheDraft() throws {
        let modelControl: ClientProjection<WorkspaceModelControlView> = try loadRow(
            "model-control-corpus")
        let routing = try XCTUnwrap(modelControl.value?.routing)
        var edited: RoutingPolicyDocument.WireRoute?
        let view = try makeView(onEditRoute: { edited = $0 })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1_200, height: 1_000),
                              styleMask: .titled, backing: .buffered, defer: false)
        window.contentView?.addSubview(view)

        let response = QAControl.process(
            verb: "select", identifier: "task-router-mode", input: nil,
            itemTitle: nil, itemIndex: 1,
            window: window, route: "router", requestId: "request")

        XCTAssertEqual(response.status, "ok")
        XCTAssertEqual(
            (find(view, "task-router-mode") as? NSPopUpButton)?.indexOfSelectedItem,
            1)
        XCTAssertEqual(edited?.mode, routing.modes[0].id)
    }
    #endif
}
