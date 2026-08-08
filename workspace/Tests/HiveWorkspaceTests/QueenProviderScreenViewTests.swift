// QueenProviderScreenViewTests.swift
//
// Drives the Queen Provider screen through its real controls in a real window:
// the vendor list is the projection's own, a refused swap keeps the selection
// and names the competing revision, a non-current read closes the control, and
// a change state this build cannot name is reported rather than read as idle.

import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore
@testable import WorkspaceQAKit

@MainActor
final class QueenProviderScreenViewTests: XCTestCase {

    private var fixtureDirectory: String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("WorkspaceCoreTests/Fixtures")
            .path
    }

    private func makeController(
        scenario: ProjectionAvailability = .current
    ) throws -> WorkspaceShellWindowController {
        _ = NSApplication.shared
        let controller = WorkspaceShellWindowController(
            context: ShellSidebarView.Context(
                projectName: "hive",
                projectPath: "/Users/test/Projects/hive",
                instanceLabel: "instance · instance-fixture"),
            state: try ShellFixtureStore(directory: fixtureDirectory)
                .loadState(scenario: scenario))
        controller.window?.makeKeyAndOrderFront(nil)
        controller.window?.layoutIfNeeded()
        try view(controller, "shell-nav-queen", as: NSButton.self).performClick(nil)
        return controller
    }

    private func content(_ controller: WorkspaceShellWindowController) throws -> NSView {
        try XCTUnwrap(controller.window?.contentView)
    }

    private func view<Kind: NSView>(
        _ controller: WorkspaceShellWindowController,
        _ identifier: String,
        as kind: Kind.Type = Kind.self
    ) throws -> Kind {
        try XCTUnwrap(find(try content(controller), identifier) as? Kind, identifier)
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

    // MARK: Rendering

    func testTheScreenRendersTheObservedRootAndItsLiveProvider() throws {
        let controller = try makeController()
        let text = allText(in: try content(controller))
        XCTAssertTrue(text.contains("queen · instance-fixture"))
        XCTAssertTrue(text.contains("claude"))
        XCTAssertTrue(text.contains("working"))
        // The revision is carried and shown as written, not narrowed.
        XCTAssertTrue(text.contains("18446744073709551615"))
    }

    /// A vendor that cannot launch here is offered and disabled. Hiding it
    /// would read as "no such vendor", which is a different claim.
    func testAVendorThatCannotLaunchIsShownDisabledRatherThanHidden() throws {
        let controller = try makeController()
        let unavailable = try view(
            controller, "queen-provider-vendor-kimi", as: NSButton.self)
        XCTAssertFalse(unavailable.isEnabled)
        XCTAssertTrue(
            allText(in: try content(controller)).contains("cannot launch a queen here right now"))
        XCTAssertTrue(
            try view(controller, "queen-provider-vendor-codex", as: NSButton.self).isEnabled)
    }

    func testAnUnobservedRootSaysSoRatherThanNamingAProvider() throws {
        let controller = try makeController(scenario: .conflicting)
        XCTAssertTrue(
            allText(in: try content(controller))
                .contains("none observed — no root foreground process"))
    }

    // MARK: Selecting and swapping

    func testPickingAVendorBecomesAnUnsentChoiceAndArmsTheSwap() throws {
        let controller = try makeController()
        var swaps = 0
        controller.queenProviderSwapHandler = { swaps += 1 }

        XCTAssertFalse(
            try view(controller, "queen-provider-swap", as: NSButton.self).isEnabled,
            "nothing to send before a choice is made")
        try view(controller, "queen-provider-vendor-codex", as: NSButton.self).performClick(nil)

        XCTAssertEqual(controller.currentState.queenProvider?.draft, ProviderID("codex"))
        XCTAssertTrue(controller.currentState.queenProvider?.hasDraft ?? false)
        XCTAssertTrue(allText(in: try content(controller)).contains("Unsent choice: codex"))
        try view(controller, "queen-provider-swap", as: NSButton.self).performClick(nil)
        XCTAssertEqual(swaps, 1)
    }

    func testPickingTheLiveProviderBackIsHowAChangeIsAbandoned() throws {
        let controller = try makeController()
        try view(controller, "queen-provider-vendor-codex", as: NSButton.self).performClick(nil)
        try view(controller, "queen-provider-vendor-claude", as: NSButton.self).performClick(nil)
        XCTAssertFalse(controller.currentState.queenProvider?.hasDraft ?? true)
        XCTAssertFalse(try view(controller, "queen-provider-swap", as: NSButton.self).isEnabled)
    }

    /// The load-bearing guard: a refused swap must leave the choice on screen
    /// with the revision that beat it, so the user can retry deliberately.
    func testARefusedSwapKeepsTheChoiceOnScreenAndNamesTheCompetingRevision() throws {
        let controller = try makeController()
        try view(controller, "queen-provider-vendor-codex", as: NSButton.self).performClick(nil)

        var competing = try XCTUnwrap(controller.currentState.queenProvider?.observed)
        competing.change = QueenProviderChange(state: .idle, revision: "99", failure: nil)
        competing.liveProvider = ProviderID("grok")
        controller.apply {
            $0.editQueenProvider {
                $0.apply(try! MutationResult(
                    intentID: "swap-1", operationID: "conflict.swap-1",
                    postStateToken: .revision("99"),
                    outcome: .rejected(MutationFailure(
                        code: "revision-conflict", message: "another change reached the Queen")),
                    observedPostState: competing))
            }
        }

        XCTAssertEqual(controller.currentState.queenProvider?.draft, ProviderID("codex"))
        XCTAssertEqual(
            try view(controller, "queen-provider-vendor-codex", as: NSButton.self).state, .on,
            "the choice is still selected on screen")
        XCTAssertTrue(
            try view(controller, "queen-provider-conflict", as: NSTextField.self)
                .stringValue.contains("revision 99"))
        XCTAssertTrue(try view(controller, "queen-provider-swap", as: NSButton.self).isEnabled,
                      "a refused change stays retryable")
    }

    func testANonCurrentReadClosesTheSwapButKeepsTheLastObservedReading() throws {
        let controller = try makeController(scenario: .stale)
        XCTAssertFalse(try view(controller, "queen-provider-swap", as: NSButton.self).isEnabled)
        XCTAssertFalse(
            try view(controller, "queen-provider-vendor-codex", as: NSButton.self).isEnabled)
        XCTAssertNotNil(find(try content(controller), "queen-provider-readonly"))
        let text = allText(in: try content(controller))
        XCTAssertTrue(text.contains("grok"), "the last observed provider is still shown")
        XCTAssertTrue(text.contains("Observed at 2026-07-29T20:00:00.000Z"))
    }

    // MARK: Change states

    func testAPendingChangeSaysTheProviderHasNotBeenObservedYet() throws {
        let controller = try makeController(scenario: .disconnected)
        XCTAssertTrue(
            try view(controller, "queen-provider-pending", as: NSTextField.self)
                .stringValue.contains("has not been observed running yet"))
    }

    func testAFailedChangeShowsWhyAndThatThePriorProviderSurvived() throws {
        let controller = try makeController(scenario: .replaced)
        let failed = try view(controller, "queen-provider-failed", as: NSTextField.self)
        XCTAssertTrue(failed.stringValue.contains("kimi could not launch a queen"))
        XCTAssertTrue(failed.stringValue.contains("prior provider was preserved"))
    }

    /// A state this build cannot name must be reported as itself. Rendering it
    /// as idle would assert nothing is in flight, which this build cannot know.
    func testAChangeStateThisBuildCannotNameIsReportedRatherThanReadAsIdle() throws {
        let controller = try makeController()
        var drifted = try XCTUnwrap(controller.currentState.queenProvider?.observed)
        drifted.change = QueenProviderChange(
            state: .unknown("handing-over"), revision: "7", failure: nil)
        controller.apply {
            $0.apply(queenProvider: QueenProviderEditor(projection: drifted))
        }
        let notice = try view(
            controller, "queen-provider-unknown-state", as: NSTextField.self)
        XCTAssertTrue(notice.stringValue.contains("handing-over"))
        XCTAssertNil(find(try content(controller), "queen-provider-pending"))
    }
}
