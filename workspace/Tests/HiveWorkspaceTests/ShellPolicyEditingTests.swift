// ShellPolicyEditingTests.swift
//
// Drives the Model Control screens through their real controls in a real
// window: the router's category/mode/membership/weight/effort controls write
// the draft, Apply asks for the selected category, a rejected apply keeps the
// draft on screen beside the competing revision, a non-current projection
// disables every control, and the enablement checkboxes ask for the provider
// and model writes. Quota stays evidence — it offers no control at all.

import AppKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore
@testable import WorkspaceQAKit

@MainActor
final class ShellPolicyEditingTests: XCTestCase {

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

    /// Navigates to a screen the way a user does — the sidebar row.
    private func show(
        _ route: ShellRoute,
        in controller: WorkspaceShellWindowController
    ) throws {
        try view(controller, "shell-nav-\(route.rawValue)", as: NSButton.self).performClick(nil)
    }

    /// The fixture's `complex_coding` route: two members, weights 3 and 1.
    private func selectComplexCoding(
        in controller: WorkspaceShellWindowController
    ) throws {
        let categories = try view(controller, "task-router-category", as: NSPopUpButton.self)
        categories.selectItem(withTitle: TaskCategory.complexCoding.label)
        categories.sendAction(categories.action, to: categories.target)
    }

    private func draftRoute(
        _ controller: WorkspaceShellWindowController,
        _ category: TaskCategory = .complexCoding
    ) -> RoutingPolicyDocument.WireRoute? {
        controller.currentState.router?.draft.policy.categories[category.rawValue]
    }

    // MARK: Draft editing through the controls

    func testMembershipWeightAndEffortControlsWriteTheDraftRoute() throws {
        let controller = try makeController()
        try show(.taskRouter, in: controller)
        try selectComplexCoding(in: controller)
        XCTAssertEqual(draftRoute(controller)?.candidates.count, 2)

        // Membership: a model the daemon's live routing catalog offers but the
        // route does not yet contain.
        let member = try view(
            controller,
            "task-router-member-grok/grok-composer-2.5-fast",
            as: NSButton.self)
        XCTAssertEqual(member.state, .off)
        member.performClick(nil)
        let added = try XCTUnwrap(draftRoute(controller)?.candidates.first {
            $0.model == "grok-composer-2.5-fast"
        })
        // The daemon supplies the candidate's starting effort and weight.
        XCTAssertEqual(added.effort, .hiveDecides)
        XCTAssertEqual(added.weight, 1)

        let weight = try view(
            controller, "task-router-weight-claude/claude-opus-4-8", as: NSTextField.self)
        XCTAssertEqual(weight.stringValue, "3")
        weight.stringValue = "40"
        weight.sendAction(weight.action, to: weight.target)
        XCTAssertEqual(
            draftRoute(controller)?.candidates.first { $0.model == "claude-opus-4-8" }?.weight,
            40)

        let effort = try view(
            controller, "task-router-effort-claude/claude-opus-4-8", as: NSPopUpButton.self)
        effort.selectItem(withTitle: "Provider controlled")
        effort.sendAction(effort.action, to: effort.target)
        XCTAssertEqual(
            draftRoute(controller)?.candidates.first { $0.model == "claude-opus-4-8" }?.effort,
            .providerControlled)

        let mode = try view(controller, "task-router-mode", as: NSPopUpButton.self)
        mode.selectItem(withTitle: "Equal split")
        mode.sendAction(mode.action, to: mode.target)
        XCTAssertEqual(draftRoute(controller)?.mode, RouterMode.hiveEqual.rawValue)
        XCTAssertTrue(controller.currentState.router?.hasDraft ?? false)
        // Equal split must not present the stored weight as an editable control
        // (same gate RouteEditorView applies in the MCC settings editor).
        let equalWeight = try view(
            controller, "task-router-weight-claude/claude-opus-4-8", as: NSTextField.self)
        XCTAssertTrue(equalWeight.isHidden, "hive-equal hides the inert stored weight")
        XCTAssertFalse(equalWeight.isEnabled, "hive-equal must not accept weight edits")
    }

    func testWeightControlIsOnlyOfferedInUserWeightedMode() throws {
        let controller = try makeController()
        try show(.taskRouter, in: controller)
        try selectComplexCoding(in: controller)
        let weighted = try view(
            controller, "task-router-weight-claude/claude-opus-4-8", as: NSTextField.self)
        XCTAssertEqual(draftRoute(controller)?.mode, RouterMode.userWeighted.rawValue)
        XCTAssertFalse(weighted.isHidden)
        XCTAssertTrue(weighted.isEnabled)

        let mode = try view(controller, "task-router-mode", as: NSPopUpButton.self)
        mode.selectItem(withTitle: "Equal split")
        mode.sendAction(mode.action, to: mode.target)
        let equal = try view(
            controller, "task-router-weight-claude/claude-opus-4-8", as: NSTextField.self)
        XCTAssertTrue(equal.isHidden)
        XCTAssertFalse(equal.isEnabled)

        let restoredMode = try view(controller, "task-router-mode", as: NSPopUpButton.self)
        restoredMode.selectItem(withTitle: "Weighted split")
        restoredMode.sendAction(restoredMode.action, to: restoredMode.target)
        let restored = try view(
            controller, "task-router-weight-claude/claude-opus-4-8", as: NSTextField.self)
        XCTAssertFalse(restored.isHidden)
        XCTAssertTrue(restored.isEnabled)
    }

    func testClearingTheModeUnconfiguresTheCategoryAndClosesMembership() throws {
        let controller = try makeController()
        try show(.taskRouter, in: controller)
        try selectComplexCoding(in: controller)
        let mode = try view(controller, "task-router-mode", as: NSPopUpButton.self)
        mode.selectItem(at: 0)
        mode.sendAction(mode.action, to: mode.target)
        XCTAssertNil(draftRoute(controller), "an unconfigured category has no route")
        // With no route there is nothing to join, so membership cannot invent
        // a router mode the user never picked.
        XCTAssertFalse(try view(
            controller, "task-router-member-claude/claude-opus-4-8", as: NSButton.self).isEnabled)
    }

    func testAModeWithNoMembersIsNotSendable() throws {
        let controller = try makeController()
        try show(.taskRouter, in: controller)
        try selectComplexCoding(in: controller)
        for model in ["claude/claude-opus-4-8", "codex/gpt-5.6-sol"] {
            try view(controller, "task-router-member-\(model)", as: NSButton.self)
                .performClick(nil)
        }
        XCTAssertEqual(draftRoute(controller)?.candidates.count, 0)
        XCTAssertFalse(try view(controller, "task-router-apply", as: NSButton.self).isEnabled)
        XCTAssertNotNil(find(try content(controller), "task-router-empty-route"))
    }

    func testApplyAsksToSendTheSelectedCategoryOnly() throws {
        let controller = try makeController()
        var writes: [ShellPolicyWrite] = []
        controller.policyWriteHandler = { writes.append($0) }
        try show(.taskRouter, in: controller)
        try selectComplexCoding(in: controller)

        let apply = try view(controller, "task-router-apply", as: NSButton.self)
        XCTAssertFalse(apply.isEnabled, "an unedited route has nothing to send")

        let weight = try view(
            controller, "task-router-weight-claude/claude-opus-4-8", as: NSTextField.self)
        weight.stringValue = "40"
        weight.sendAction(weight.action, to: weight.target)
        try view(controller, "task-router-apply", as: NSButton.self).performClick(nil)
        XCTAssertEqual(writes, [.route(.complexCoding)])
    }

    /// The wire is `.min(1).max(100)`. Sending an out-of-range weight would
    /// earn a 400 — a round trip that changes nothing and costs the user their
    /// place — so the edit is refused at the control and named there.
    func testWeightsTheWireWouldRefuseAreNeverSendable() throws {
        for typed in ["0", "101", "abc"] {
            let controller = try makeController()
            try show(.taskRouter, in: controller)
            try selectComplexCoding(in: controller)
            let weight = try view(
                controller, "task-router-weight-claude/claude-opus-4-8", as: NSTextField.self)
            weight.stringValue = typed
            weight.sendAction(weight.action, to: weight.target)

            XCTAssertEqual(
                draftRoute(controller)?.candidates.first { $0.model == "claude-opus-4-8" }?.weight,
                3,
                "\(typed) must not reach the draft")
            XCTAssertFalse(
                try view(controller, "task-router-apply", as: NSButton.self).isEnabled,
                "\(typed) must leave nothing to send")
            let refusal = try view(
                controller, "task-router-weight-refusal", as: NSTextField.self)
            XCTAssertFalse(refusal.isHidden, "\(typed) must say why it was refused")
            XCTAssertTrue(refusal.stringValue.contains(typed))
            XCTAssertEqual(weight.stringValue, typed, "the typed text stays for correction")
        }
    }

    func testACorrectedWeightBecomesSendableAgain() throws {
        let controller = try makeController()
        try show(.taskRouter, in: controller)
        try selectComplexCoding(in: controller)
        let weight = try view(
            controller, "task-router-weight-claude/claude-opus-4-8", as: NSTextField.self)
        weight.stringValue = "101"
        weight.sendAction(weight.action, to: weight.target)
        let corrected = try view(
            controller, "task-router-weight-claude/claude-opus-4-8", as: NSTextField.self)
        corrected.stringValue = "100"
        corrected.sendAction(corrected.action, to: corrected.target)

        XCTAssertEqual(
            draftRoute(controller)?.candidates.first { $0.model == "claude-opus-4-8" }?.weight,
            100)
        XCTAssertTrue(try view(controller, "task-router-apply", as: NSButton.self).isEnabled)
        XCTAssertTrue(
            try view(controller, "task-router-weight-refusal", as: NSTextField.self).isHidden)
    }

    func testEditFromARebuiltRouterIsRefusedVisibly() throws {
        let controller = try makeController()
        try show(.taskRouter, in: controller)
        try selectComplexCoding(in: controller)
        let weight = try view(
            controller, "task-router-weight-claude/claude-opus-4-8", as: NSTextField.self)
        weight.stringValue = "40"

        var refreshed = try XCTUnwrap(controller.currentState.router?.observed.policy)
        refreshed.revision += 1
        var route = try XCTUnwrap(refreshed.categories[TaskCategory.complexCoding.rawValue])
        let candidate = try XCTUnwrap(route.candidates.firstIndex {
            $0.model == "claude-opus-4-8"
        })
        route.candidates[candidate].weight = 4
        refreshed.categories[TaskCategory.complexCoding.rawValue] = route
        controller.apply {
            $0.refresh(router: TaskRouterEditor(
                snapshot: TaskRouterSnapshot(policy: refreshed), availability: .current))
        }

        weight.sendAction(weight.action, to: weight.target)

        XCTAssertEqual(
            draftRoute(controller)?.candidates.first { $0.model == "claude-opus-4-8" }?.weight,
            4)
        XCTAssertFalse(try view(controller, "task-router-apply", as: NSButton.self).isEnabled)
        XCTAssertTrue(try view(
            controller, "task-router-weight-claude/claude-opus-4-8", as: NSTextField.self).isEnabled)
        XCTAssertEqual(
            controller.currentState.policyWriteRefusal,
            "The route changed before this edit could be applied. Review the current route and edit again.")
        XCTAssertTrue(allText(in: try content(controller)).contains(
            "The route changed before this edit could be applied."))
    }

    func testEditSurvivesAnUnchangedRouterRefresh() throws {
        let controller = try makeController()
        try show(.taskRouter, in: controller)
        try selectComplexCoding(in: controller)
        let weight = try view(
            controller, "task-router-weight-claude/claude-opus-4-8", as: NSTextField.self)
        weight.stringValue = "40"

        let observed = try XCTUnwrap(controller.currentState.router?.observed.policy)
        controller.apply {
            $0.refresh(router: TaskRouterEditor(
                snapshot: TaskRouterSnapshot(policy: observed), availability: .current))
        }

        weight.sendAction(weight.action, to: weight.target)

        XCTAssertEqual(
            draftRoute(controller)?.candidates.first { $0.model == "claude-opus-4-8" }?.weight,
            40)
        XCTAssertTrue(try view(controller, "task-router-apply", as: NSButton.self).isEnabled)
        XCTAssertNil(controller.currentState.policyWriteRefusal)
    }

    // MARK: The compare-and-set guard, on screen

    func testRejectedApplyKeepsTheDraftOnScreenAndNamesTheCompetingRevision() throws {
        let controller = try makeController()
        try show(.taskRouter, in: controller)
        try selectComplexCoding(in: controller)
        let weight = try view(
            controller, "task-router-weight-claude/claude-opus-4-8", as: NSTextField.self)
        weight.stringValue = "40"
        weight.sendAction(weight.action, to: weight.target)
        let draft = try XCTUnwrap(draftRoute(controller))

        // The daemon answers with a conflict: someone else moved the policy on.
        var competing = try XCTUnwrap(controller.currentState.router?.observed.policy)
        competing.revision += 1
        let rejection = try MutationResult(
            intentID: "intent-conflict",
            operationID: "operation-conflict",
            postStateToken: .revision(String(competing.revision)),
            outcome: .rejected(MutationFailure(
                code: "revision-conflict", message: "policy changed")),
            observedPostState: competing)
        controller.apply { $0.editRouter { $0.apply(rejection) } }

        XCTAssertEqual(draftRoute(controller), draft, "the rejected edit must survive")
        XCTAssertEqual(
            try view(
                controller,
                "task-router-weight-claude/claude-opus-4-8",
                as: NSTextField.self).stringValue,
            "40",
            "the control must still show the user's edit")
        let conflict = try view(controller, "task-router-conflict", as: NSTextField.self)
        XCTAssertTrue(
            conflict.stringValue.contains("revision \(competing.revision)"),
            "the competing revision must be named on screen: \(conflict.stringValue)")
        XCTAssertTrue(try view(controller, "task-router-apply", as: NSButton.self).isEnabled,
                      "a rejected edit stays retryable")
    }

    func testNonCurrentProjectionDisablesEveryRouterControl() throws {
        let controller = try makeController(scenario: .stale)
        try show(.taskRouter, in: controller)
        try selectComplexCoding(in: controller)
        for identifier in [
            "task-router-mode",
            "task-router-member-claude/claude-opus-4-8",
            "task-router-weight-claude/claude-opus-4-8",
            "task-router-effort-claude/claude-opus-4-8",
            "task-router-apply",
        ] {
            XCTAssertFalse(
                try view(controller, identifier, as: NSControl.self).isEnabled,
                "\(identifier) must not accept an edit against a stale read")
        }
        XCTAssertNotNil(find(try content(controller), "task-router-readonly"))
        // Disabled is not blanked: the last observed policy is still shown,
        // dated, so the user can read what is in force while unable to change it.
        XCTAssertEqual(
            try view(
                controller,
                "task-router-weight-claude/claude-opus-4-8",
                as: NSTextField.self).stringValue,
            "3")
        XCTAssertEqual(
            controller.currentState.activeScreen?.observedAt, "2026-07-29T20:00:00.000Z")
        // The dated read is on the availability badge tooltip, not a second
        // provenance row. Visible copy would re-introduce the raw panel.
        XCTAssertFalse(
            allText(in: try content(controller))
                .contains("Observed at 2026-07-29T20:00:00.000Z"))
        XCTAssertEqual(
            find(try content(controller), "task-router-availability")?.toolTip,
            "Observed at 2026-07-29T20:00:00.000Z")
    }

    /// What the user sees after a write whose outcome could not be read back:
    /// the edit is still theirs, the screen no longer claims to be current, and
    /// nothing can be sent against a revision that may already have moved.
    func testAWriteWithAnUnknownOutcomeFencesTheEditorWithoutLosingTheDraft() throws {
        let controller = try makeController()
        try show(.taskRouter, in: controller)
        try selectComplexCoding(in: controller)
        let weight = try view(
            controller, "task-router-weight-claude/claude-opus-4-8", as: NSTextField.self)
        weight.stringValue = "40"
        weight.sendAction(weight.action, to: weight.target)
        let draft = try XCTUnwrap(draftRoute(controller))

        controller.apply { current in
            current.apply(screen: ShellScreenProjection(
                availability: .disconnected,
                freshness: .unknown,
                source: ProjectionSource(),
                observedAt: nil,
                evidence: .disconnected(transportLostAt: "socket closed"),
                contract: .frozen,
                facts: []), for: .taskRouter)
            current.editRouter { $0.fence() }
            current.record(policyWriteRefusal: "may have been applied")
        }

        XCTAssertEqual(draftRoute(controller), draft, "the unsent edit is still the user's")
        XCTAssertEqual(
            try view(
                controller,
                "task-router-weight-claude/claude-opus-4-8",
                as: NSTextField.self).stringValue,
            "40")
        XCTAssertFalse(
            try view(controller, "task-router-apply", as: NSButton.self).isEnabled,
            "nothing may be compared against a revision that may have moved")
        let text = allText(in: try content(controller))
        XCTAssertTrue(text.contains("Daemon disconnected"), "the transport fact is shown")
        XCTAssertTrue(text.contains("may have been applied"), "the ambiguity is stated")
    }

    /// Refreshing is the only way out of a fence, so it must not cost the user
    /// the draft the fence existed to protect — and once a current read lands,
    /// the warning that demanded it has been answered. A screen that both
    /// permits a write and says a refresh is required is telling two stories.
    func testProbeSuccessfulRefreshResolvesTheFenceWithoutLosingTheUnappliedDraft() throws {
        let controller = try makeController()
        try show(.taskRouter, in: controller)
        try selectComplexCoding(in: controller)
        let weight = try view(
            controller, "task-router-weight-claude/claude-opus-4-8", as: NSTextField.self)
        weight.stringValue = "40"
        weight.sendAction(weight.action, to: weight.target)
        let draft = try XCTUnwrap(draftRoute(controller))
        controller.apply { current in
            current.editRouter { $0.fence() }
            current.record(policyWriteRefusal: "Refresh before editing again.")
        }

        // The refresh reads the daemon and finds the stored weight still 3 —
        // the user's 40 was never applied, so it is still theirs to send.
        let observed = try XCTUnwrap(controller.currentState.router?.observed.policy)
        XCTAssertEqual(
            observed.categories["complex_coding"]?.candidates
                .first { $0.model == "claude-opus-4-8" }?.weight,
            3)
        controller.apply {
            $0.refresh(router: TaskRouterEditor(
                snapshot: TaskRouterSnapshot(policy: observed), availability: .current))
        }

        XCTAssertTrue(
            controller.currentState.router?.mutationsAllowed ?? false,
            "a current read must lift the fence")
        XCTAssertEqual(draftRoute(controller), draft, "the unapplied edit must survive the refresh")
        XCTAssertEqual(
            try view(
                controller,
                "task-router-weight-claude/claude-opus-4-8",
                as: NSTextField.self).stringValue,
            "40")
        XCTAssertTrue(try view(controller, "task-router-apply", as: NSButton.self).isEnabled)
        XCTAssertNil(controller.currentState.policyWriteRefusal, "the warning was answered")
        XCTAssertFalse(
            allText(in: try content(controller)).contains("Refresh before editing again"))
    }

    /// The positive control for the clause above: a refresh that did NOT come
    /// back current leaves both the fence and the warning in place.
    func testARefreshThatIsNotCurrentLeavesTheFenceAndTheWarningStanding() throws {
        let controller = try makeController()
        try show(.taskRouter, in: controller)
        let observed = try XCTUnwrap(controller.currentState.router?.observed.policy)
        controller.apply { current in
            current.editRouter { $0.fence() }
            current.record(policyWriteRefusal: "Refresh before editing again.")
            current.refresh(router: TaskRouterEditor(
                snapshot: TaskRouterSnapshot(policy: observed), availability: .stale))
        }
        XCTAssertFalse(controller.currentState.router?.mutationsAllowed ?? true)
        XCTAssertEqual(
            controller.currentState.policyWriteRefusal, "Refresh before editing again.")
    }

    /// A refresh that read no policy at all must not take the editor — and the
    /// draft — down with it.
    func testARefreshWithNoPolicyKeepsTheEditorFencedRatherThanDroppingIt() throws {
        let controller = try makeController()
        try show(.taskRouter, in: controller)
        try selectComplexCoding(in: controller)
        let weight = try view(
            controller, "task-router-weight-claude/claude-opus-4-8", as: NSTextField.self)
        weight.stringValue = "40"
        weight.sendAction(weight.action, to: weight.target)
        let draft = try XCTUnwrap(draftRoute(controller))

        controller.apply { $0.refresh(router: nil) }

        XCTAssertEqual(draftRoute(controller), draft)
        XCTAssertFalse(controller.currentState.router?.mutationsAllowed ?? true)
    }

    // MARK: Models & Quota enablement

    func testProviderAndModelCheckboxesAskForTheirEnablementWrites() throws {
        let controller = try makeController()
        var writes: [ShellPolicyWrite] = []
        controller.policyWriteHandler = { writes.append($0) }
        try show(.modelsQuota, in: controller)

        // grok is disabled in the fixture policy; its checkbox asks to enable.
        let provider = try view(controller, "models-quota-provider-grok", as: NSButton.self)
        XCTAssertEqual(provider.state, .off)
        provider.performClick(nil)

        // claude is enabled, and so is its one catalogued model.
        let model = try view(
            controller, "models-quota-model-claude-claude-opus-4-8", as: NSButton.self)
        XCTAssertEqual(model.state, .on)
        model.performClick(nil)

        XCTAssertEqual(writes, [
            .provider(ProviderID("grok"), enabled: true),
            .model(ProviderID("claude"), model: "claude-opus-4-8", enabled: false),
        ])
    }

    func testProviderProbeRunsOnlyAfterTheButtonIsPressed() throws {
        let controller = try makeController()
        var attempts = 0
        controller.probeRefreshHandler = {
            attempts += 1
            XCTAssertTrue(controller.beginProviderProbeRefresh())
        }

        try show(.modelsQuota, in: controller)
        XCTAssertEqual(attempts, 0)

        let button = try view(
            controller, "models-quota-probe-refresh", as: NSButton.self)
        button.performClick(nil)
        XCTAssertEqual(attempts, 1)
        let refreshing = try view(
            controller, "models-quota-probe-refresh", as: NSButton.self)
        XCTAssertEqual(refreshing.title, "Refreshing provider probes…")
        XCTAssertFalse(refreshing.isEnabled)
        XCTAssertFalse(controller.beginProviderProbeRefresh())

        controller.finishProviderProbeRefresh(.succeeded(
            "Provider probes completed at 2026-08-15T15:55:01.000Z: grok."))
        let completed = try view(
            controller, "models-quota-probe-status", as: NSTextField.self)
        XCTAssertEqual(
            completed.stringValue,
            "Provider probes completed at 2026-08-15T15:55:01.000Z: grok.")
    }

    func testFailedProviderProbeKeepsMetersAndShowsTheError() throws {
        let controller = try makeController()
        try show(.modelsQuota, in: controller)
        XCTAssertTrue(controller.beginProviderProbeRefresh())

        controller.finishProviderProbeRefresh(.failed(
            "grok: fake Grok surface refused the probe"))

        let error = try view(
            controller, "models-quota-probe-error", as: NSTextField.self)
        XCTAssertEqual(error.stringValue, "grok: fake Grok surface refused the probe")
        let retry = try view(
            controller, "models-quota-probe-refresh", as: NSButton.self)
        // The control was renamed to "Refresh providers" when Models & Quota was
        // restyled; the assertion still pins that the retry control is present,
        // titled and enabled after a failed probe.
        XCTAssertEqual(retry.title, "Refresh providers")
        XCTAssertTrue(retry.isEnabled)
        XCTAssertNotNil(try view(
            controller, "models-quota-meter-claude-5 hour window", as: NSView.self))
    }

    /// A window the provider did not report must draw the indeterminate track,
    /// never a fill. A 0-fraction fill still paints a bar, which reads as a
    /// measured empty — the exact lie the unknown state exists to prevent.
    func testAnUnreadWindowDrawsTheIndeterminateTrackNotAnEmptyFill() throws {
        let controller = try makeController()
        try show(.modelsQuota, in: controller)

        let unknown = try view(
            controller, "models-quota-meter-claude-7 day window", as: NSView.self)
        XCTAssertEqual(try track(in: unknown).state, .indeterminate)

        // The positive control: the same screen's read window is a real fill,
        // so the assertion above is discriminating rather than vacuous.
        let measured = try view(
            controller, "models-quota-meter-claude-5 hour window", as: NSView.self)
        guard case .fill(let fraction, _) = try track(in: measured).state else {
            return XCTFail("the reported window must draw a determinate fill")
        }
        XCTAssertEqual(fraction, 0.63, accuracy: 0.001)
    }

    private func track(in view: NSView) throws -> MeterBarView {
        func find(_ view: NSView) -> MeterBarView? {
            if let track = view as? MeterBarView { return track }
            for subview in view.subviews {
                if let track = find(subview) { return track }
            }
            return nil
        }
        return try XCTUnwrap(find(view), "no meter track")
    }

    func testAProviderWithNoReadableCatalogShowsItsReasonInsteadOfNoModels() throws {
        let controller = try makeController()
        try show(.modelsQuota, in: controller)
        let reason = try view(controller, "models-quota-catalog-codex", as: NSTextField.self)
        XCTAssertEqual(reason.stringValue, "codex CLI not signed in")
    }

    func testUsageReadingsCarryNoWriteControl() throws {
        let controller = try makeController()
        try show(.modelsQuota, in: controller)
        let screen = try view(controller, "shell-screen-host", as: NSView.self)
        XCTAssertNotNil(try view(
            controller, "models-quota-meter-claude-5 hour window", as: NSView.self))
        XCTAssertNil(find(screen, "models-quota-evidence"))
        // Every button on this screen is either the probe read or an
        // enablement toggle. A usage preference has no control at all.
        for control in buttons(in: screen) {
            let identifier = control.accessibilityIdentifier()
            XCTAssertTrue(
                identifier.hasPrefix("models-quota-provider-")
                    || identifier.hasPrefix("models-quota-model-")
                    || identifier == "models-quota-probe-refresh",
                "unexpected control on Models & Quota: \(identifier)")
        }
    }

    private func buttons(in view: NSView) -> [NSButton] {
        var found: [NSButton] = []
        if let button = view as? NSButton { found.append(button) }
        for subview in view.subviews { found.append(contentsOf: buttons(in: subview)) }
        return found
    }
}
