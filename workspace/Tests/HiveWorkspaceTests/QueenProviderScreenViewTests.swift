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
        XCTAssertTrue(text.contains("Working"))
        // The revision is carried and shown as written, not narrowed.
        XCTAssertTrue(text.contains("18446744073709551615"))
    }

    func testTheFiveVendorCardsHaveEqualWidthsAndTheLiveVendorIsOutlined() throws {
        let controller = try makeController()
        let cards = try ["claude", "codex", "grok", "kimi", "opencode"].map {
            try view(controller, "queen-provider-card-\($0)")
        }
        XCTAssertEqual(Set(cards.map { Int($0.frame.width.rounded()) }).count, 1)
        XCTAssertEqual(cards[0].layer?.borderWidth, 2)
        XCTAssertEqual(cards[1].layer?.borderWidth, 0)
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

    // MARK: Fact-strip grouping

    /// Proximity must bind each label to its own value. The defect this
    /// guards stretched leftover width *inside* each pair, so `claude` sat
    /// closer to `Health` than to `Live provider`.
    func testFactStripBindsEachLabelToItsOwnValue() throws {
        let controller = try makeController()
        controller.window?.layoutIfNeeded()
        let strip = try view(controller, "queen-provider-facts", as: FactStripView.self)
        XCTAssertGreaterThanOrEqual(strip.stack.arrangedSubviews.count, 2)

        var previousPair: NSView?
        for pair in strip.stack.arrangedSubviews {
            let stack = try XCTUnwrap(pair as? NSStackView)
            XCTAssertEqual(stack.spacing, Theme.Space.s)
            XCTAssertGreaterThanOrEqual(stack.arrangedSubviews.count, 2)
            let childrenWidth = stack.arrangedSubviews.reduce(CGFloat(0)) {
                $0 + $1.alignmentRect(forFrame: $1.frame).width
            }
            let internalSpacing = stack.spacing * CGFloat(max(stack.arrangedSubviews.count - 1, 0))
            XCTAssertEqual(
                stack.frame.width, childrenWidth + internalSpacing, accuracy: 2,
                "fact pair must hug its label and value; leftover width inside the pair is the mis-grouping")

            if let previous = previousPair {
                let previousFrame = previous.convert(previous.bounds, to: strip)
                let pairFrame = pair.convert(pair.bounds, to: strip)
                let between = pairFrame.minX - previousFrame.maxX
                XCTAssertGreaterThan(
                    between,
                    stack.spacing + 1,
                    "between-pair gap \(between) must exceed within-pair spacing \(stack.spacing)")
                XCTAssertGreaterThanOrEqual(between, Theme.Space.xl - 1)
            }
            previousPair = pair
        }
    }

    // MARK: Models & Quota status pills

    /// Same provider state must paint the same compact pill. Stretching the
    /// tinted badge to the card width made `enabled` Claude a green band and
    /// `enabled` Codex a small pill.
    func testStatusPillsStayCompactAndEqualForTheSameState() throws {
        let controller = try makeController()
        try view(controller, "shell-nav-models", as: NSButton.self).performClick(nil)
        controller.window?.layoutIfNeeded()

        var widthByState: [String: [Int]] = [:]
        for id in ["claude", "codex", "grok", "kimi", "opencode"] {
            let card = try view(controller, "models-quota-card-\(id)")
            let badge = try view(controller, "models-quota-status-\(id)")
            XCTAssertEqual(
                badge.frame.width, badge.fittingSize.width, accuracy: 2,
                "\(id) status pill is not sized to its content")
            XCTAssertLessThan(
                badge.frame.width, card.frame.width * 0.5,
                "\(id) status pill stretched into a card-width band")
            let state = try XCTUnwrap(badge.accessibilityLabel())
            widthByState[state, default: []].append(Int(badge.frame.width.rounded()))
        }
        for (state, widths) in widthByState {
            XCTAssertEqual(
                Set(widths).count, 1,
                "state \(state) painted distinct pill widths \(widths)")
        }
    }

    func testModelCardsStayCompactAndScrollTheirCompleteBodies() throws {
        let controller = try makeController()
        try view(controller, "shell-nav-models", as: NSButton.self).performClick(nil)
        controller.window?.layoutIfNeeded()

        for id in ["claude", "codex", "grok", "kimi", "opencode"] {
            let card = try view(controller, "models-quota-card-\(id)")
            let scroll = try view(
                controller, "models-quota-card-scroll-\(id)", as: NSScrollView.self)
            XCTAssertEqual(card.frame.height, 215, accuracy: 1)
            XCTAssertTrue(scroll.hasVerticalScroller)
            XCTAssertTrue(scroll.autohidesScrollers)
            XCTAssertLessThan(scroll.frame.height, card.frame.height)
            XCTAssertNotNil(scroll.documentView)
        }

        let claudeScroll = try view(
            controller, "models-quota-card-scroll-claude", as: NSScrollView.self)
        let document = try XCTUnwrap(claudeScroll.documentView)
        XCTAssertNotNil(find(document, "models-quota-meter-claude-5 hour window"))
        XCTAssertNotNil(find(document, "models-quota-model-claude-claude-opus-4-8"))
        XCTAssertGreaterThan(
            document.frame.height,
            claudeScroll.contentView.bounds.height,
            "overflowing provider content must remain reachable inside its card")

        let screenScroll = try view(controller, "shell-screen-scroll", as: NSScrollView.self)
        let screenDocument = try XCTUnwrap(screenScroll.documentView)
        XCTAssertEqual(
            screenDocument.bounds.height,
            screenScroll.contentView.bounds.height,
            accuracy: 1,
            "provider catalogs should scroll inside their cards, not lengthen the page")
    }
}
