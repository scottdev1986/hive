// ShellDispatcherTests.swift
//
// Drives every command through the one dispatcher and asserts its single
// effect: routes move the screen router, local actions do their one thing,
// and a surface this build does not have refuses honestly — never a stub
// success, never a silent no-op.

import XCTest
@testable import WorkspaceCore

final class ShellDispatcherTests: XCTestCase {

    private func makeState() -> ShellState {
        var state = ShellState()
        state.apply(
            screen: ShellScreenProjection(
                availability: .current,
                freshness: .current,
                source: ProjectionSource(revision: "8", generation: 1),
                observedAt: "2026-07-30T20:00:00.000Z",
                evidence: nil,
                contract: .frozen,
                facts: []),
            for: .liveRun)
        return state
    }

    // MARK: Routes

    func testRouteCommandsMoveTheRouterAndRecordTheOutcome() {
        let dispatcher = ShellDispatcher()
        var state = makeState()

        for (command, route) in [(ShellCommand.showTaskRouter, ShellRoute.taskRouter),
                                 (.memoryLibrary, .memoryLibrary),
                                 (.showQueenProvider, .queen),
                                 (.showLiveRun, .liveRun)] as [(ShellCommand, ShellRoute)] {
            let outcome = dispatcher.dispatch(command, state: &state)
            XCTAssertEqual(state.activeRoute, route)
            XCTAssertEqual(outcome, .routed(route))
            XCTAssertEqual(state.lastOutcome, .routed(route))
        }
    }

    func testSidebarNavigationUsesTheSameRoutePath() {
        let dispatcher = ShellDispatcher()
        var state = makeState()
        let outcome = dispatcher.navigate(to: .modelsQuota, state: &state)
        XCTAssertEqual(outcome, .routed(.modelsQuota))
        XCTAssertEqual(state.activeRoute, .modelsQuota)
        XCTAssertEqual(state.lastOutcome, .routed(.modelsQuota))
    }

    // MARK: Local actions

    /// The two surviving terminal commands resolve as honest local actions —
    /// pure at the dispatcher level, with no daemon wire to mint an intent
    /// against. The window controller performs the real attach/detach when it
    /// observes this outcome (proved in LiveRunWorkbenchViewTests).
    func testAttachAndDetachTerminalCommandsResolveAsLocalActions() {
        let dispatcher = ShellDispatcher()
        var state = makeState()

        XCTAssertEqual(ShellCommand.attachLiveTerminal.resolution, .local(.attachLiveTerminal))
        XCTAssertEqual(ShellCommand.detachTerminalView.resolution, .local(.detachTerminalView))
        XCTAssertEqual(
            dispatcher.dispatch(.attachLiveTerminal, state: &state),
            .localPerformed(.attachLiveTerminal))
        XCTAssertEqual(
            dispatcher.dispatch(.detachTerminalView, state: &state),
            .localPerformed(.detachTerminalView))
    }

    func testDrawerToggleFlipsState() {
        let dispatcher = ShellDispatcher()
        var state = makeState()

        dispatcher.dispatch(.toggleAttention, state: &state)
        XCTAssertTrue(state.attentionDrawerVisible)
        dispatcher.dispatch(.toggleAttention, state: &state)
        XCTAssertFalse(state.attentionDrawerVisible)
        XCTAssertEqual(state.lastOutcome, .localPerformed(.toggleAttention))
    }

    func testInspectorToggleFlipsState() {
        let dispatcher = ShellDispatcher()
        var state = makeState()

        dispatcher.dispatch(.toggleInspector, state: &state)
        XCTAssertTrue(state.inspectorVisible)
        dispatcher.dispatch(.toggleInspector, state: &state)
        XCTAssertFalse(state.inspectorVisible)
        XCTAssertEqual(state.lastOutcome, .localPerformed(.toggleInspector))
    }

    /// Enter Full Terminal used to refuse with a reason that sounded honest
    /// while describing a capability the app has: the Live Run workbench really
    /// does host the viewer. It is a real local destination now, and no command
    /// may claim a surface is unbuilt when it is not.
    func testEnterFullTerminalReachesTheViewerInsteadOfRefusingIt() {
        let dispatcher = ShellDispatcher()
        var state = makeState()

        let outcome = dispatcher.dispatch(.enterFullTerminal, state: &state)

        XCTAssertEqual(outcome, .localPerformed(.enterFullTerminal))
        XCTAssertEqual(ShellCommand.enterFullTerminal.resolution, .local(.enterFullTerminal))
        for command in ShellCommand.allCases {
            if case .local(.unavailableSurface) = command.resolution {
                XCTFail("\(command) still claims a surface this build has")
            }
        }
    }
}
