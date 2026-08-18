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

    private func loadRow<Value: Decodable>(
        _ name: String
    ) throws -> ClientProjection<Value> {
        let url = fixtureDirectory.appendingPathComponent("\(name).json")
        let rows = try JSONDecoder().decode(
            [ClientProjection<Value>].self, from: Data(contentsOf: url))
        return try XCTUnwrap(rows.first { $0.availability == .current })
    }

    private func makeView(
        category: TaskCategory? = nil,
        availability: ProjectionAvailability = .current,
        onSelectCategory: @escaping (TaskCategory) -> Void = { _ in },
        onEditRoute: @escaping (RoutingPolicyDocument.WireRoute?) -> Void = { _ in },
        onApply: @escaping () -> Void = {}
    ) throws -> TaskRouterScreenView {
        let policy: ClientProjection<RoutingPolicyDocument> = try loadRow(
            "routing-policy-corpus")
        let modelControl: ClientProjection<WorkspaceModelControlView> = try loadRow(
            "model-control-corpus")
        let inspection: ClientProjection<RouteInspection> = try loadRow(
            "routing-inspection-corpus")
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

    func testRestyleUsesDesignSystemPrimitivesAndKeepsTheEditor() throws {
        let view = try makeView()
        XCTAssertNotNil(find(view, "hds-page-header"))
        XCTAssertNotNil(find(view, "hds-section-card"))
        XCTAssertNotNil(find(view, "hds-data-row"))
        XCTAssertNotNil(find(view, "hds-capsule-badge"))
        XCTAssertNotNil(find(view, "task-router-apply") as? ActionButton)
        XCTAssertNotNil(find(view, "task-router-category") as? NSPopUpButton)
        XCTAssertNotNil(find(view, "task-router-mode") as? NSPopUpButton)
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

    func testV3ReviewIsNamedUnavailableAndSharesStayInspectionFacts() throws {
        let view = try makeView()
        let text = allText(in: view)
        XCTAssertNotNil(find(view, "task-router-v3-gap"))
        XCTAssertTrue(text.contains("Policy V3 compare-and-set review is not in this projection"))
        XCTAssertTrue(text.contains("V3 review unavailable"))
        XCTAssertFalse(text.contains("Review V3 draft"))
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

    func testSelectedRouteEditorSitsAboveTheCategoryIndex() throws {
        let view = try makeView()
        let stack = try XCTUnwrap(view.subviews.first as? NSStackView)
        let identifiers = stack.arrangedSubviews.compactMap { $0.accessibilityIdentifier() }
        let editor = try XCTUnwrap(
            identifiers.firstIndex(of: "hds-section-card"),
            "selected route card missing")
        let others = try XCTUnwrap(
            identifiers.firstIndex(of: "task-router-other-routes"),
            "category cards missing")
        XCTAssertLessThan(
            editor, others,
            "edit controls must be a first-class card, not stranded below the index")
        XCTAssertNotNil(find(view, "task-router-category") as? NSPopUpButton)
        XCTAssertNotNil(find(view, "task-router-mode") as? NSPopUpButton)
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
}
