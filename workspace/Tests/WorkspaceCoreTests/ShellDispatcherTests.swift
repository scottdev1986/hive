// ShellDispatcherTests.swift
//
// Drives every command through the one dispatcher and asserts its single
// effect: routes move the screen router, intents mint exactly one envelope
// with the registry's body, local actions do their one thing, and in-flight
// wires resolve as the envelope's structured rejection — never a stub
// success, never a silent no-op.

import XCTest
@testable import WorkspaceCore

final class ShellDispatcherTests: XCTestCase {

    /// A transport that records every intent it sees and answers with the
    /// build's honest unavailable rejection.
    private final class RecordingTransport {
        private(set) var sent: [(ShellCommand, MutationIntent<ShellIntentBody>)] = []

        var transport: ShellMutationTransport {
            { command, intent in
                self.sent.append((command, intent))
                return shellUnavailableTransport(command: command, intent: intent)
            }
        }
    }

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
        let transport = RecordingTransport()
        let dispatcher = ShellDispatcher(transport: transport.transport)
        var state = makeState()

        for (command, route) in [(ShellCommand.openSettings, ShellRoute.taskRouter),
                                 (.memoryLibrary, .memoryLibrary),
                                 (.showQueenProvider, .queen),
                                 (.showLiveRun, .liveRun)] as [(ShellCommand, ShellRoute)] {
            let outcome = dispatcher.dispatch(command, state: &state)
            XCTAssertEqual(state.activeRoute, route)
            XCTAssertEqual(outcome, .routed(route))
            XCTAssertEqual(state.lastOutcome, .routed(route))
        }
        XCTAssertTrue(transport.sent.isEmpty, "a route must never mint an intent")
    }

    func testSidebarNavigationUsesTheSameRoutePath() {
        let dispatcher = ShellDispatcher(transport: shellUnavailableTransport)
        var state = makeState()
        let outcome = dispatcher.navigate(to: .modelsQuota, state: &state)
        XCTAssertEqual(outcome, .routed(.modelsQuota))
        XCTAssertEqual(state.activeRoute, .modelsQuota)
        XCTAssertEqual(state.lastOutcome, .routed(.modelsQuota))
    }

    // MARK: Intents

    func testEveryIntentCommandMintsExactlyOneEnvelopeWithTheRegistryBody() {
        let intentCommands = ShellCommand.allCases.filter {
            if case .intent = $0.resolution { return true }
            return false
        }
        for command in intentCommands {
            let transport = RecordingTransport()
            let dispatcher = ShellDispatcher(transport: transport.transport)
            var state = makeState()

            let outcome = dispatcher.dispatch(command, state: &state)

            XCTAssertEqual(
                transport.sent.count, 1,
                "\(command) must mint exactly one intent")
            let (sentCommand, intent) = transport.sent[0]
            XCTAssertEqual(sentCommand, command)
            guard case .intent(let expectedBody) = command.resolution else {
                XCTFail("\(command) lost its intent resolution")
                return
            }
            XCTAssertEqual(
                intent.body, expectedBody,
                "\(command) must send the registry's body, not a paraphrase")
            XCTAssertEqual(
                intent.expected,
                .revisionAndEpoch(revision: "8", epoch: "1"),
                "\(command) must compare the observed workspace source")
            XCTAssertTrue(
                intent.idempotencyKey.hasPrefix("u2-shell.\(command.rawValue)."),
                "\(command)'s idempotency key must be namespaced to the command")
            XCTAssertFalse(intent.intentID.isEmpty)

            guard case .mutationResolved(let result) = outcome else {
                XCTFail("\(command) did not resolve as a mutation")
                return
            }
            XCTAssertEqual(result.intentID, intent.intentID)
            guard case .rejected(let failure) = result.outcome else {
                XCTFail("an in-flight wire must never report success")
                return
            }
            XCTAssertEqual(failure.code, "unavailable")
            XCTAssertTrue(failure.message.contains(command.title))
            XCTAssertEqual(
                result.observedPostState,
                ShellMutationPostState(
                    command: command,
                    source: ProjectionSource(revision: "8", generation: 1)),
                "the post-state names the state that remained in force")
            XCTAssertEqual(state.lastOutcome, outcome)
        }
    }

    func testEachDispatchIsADistinctOperation() {
        let transport = RecordingTransport()
        let dispatcher = ShellDispatcher(transport: transport.transport)
        var state = makeState()

        dispatcher.dispatch(.pauseRun, state: &state)
        dispatcher.dispatch(.pauseRun, state: &state)

        XCTAssertEqual(transport.sent.count, 2)
        XCTAssertNotEqual(
            transport.sent[0].1.intentID, transport.sent[1].1.intentID,
            "a repeated gesture is a new operation, never a replayed receipt")
        XCTAssertNotEqual(
            transport.sent[0].1.idempotencyKey, transport.sent[1].1.idempotencyKey)
    }

    func testIntentWithoutAnObservedSourceIsNeverSent() {
        let transport = RecordingTransport()
        let dispatcher = ShellDispatcher(transport: transport.transport)
        var state = ShellState() // nothing observed: no revision, no generation

        let outcome = dispatcher.dispatch(.abortRun, state: &state)

        XCTAssertTrue(
            transport.sent.isEmpty,
            "a mutation with nothing to compare must not leave the shell")
        guard case .surfaceUnavailable(let command, let reason) = outcome else {
            XCTFail("expected an honest unavailable outcome, got \(outcome)")
            return
        }
        XCTAssertEqual(command, .abortRun)
        XCTAssertTrue(reason.contains("not sent"))
    }

    // MARK: Local actions

    func testDrawerToggleFlipsStateAndNeverTouchesTheTransport() {
        let transport = RecordingTransport()
        let dispatcher = ShellDispatcher(transport: transport.transport)
        var state = makeState()

        dispatcher.dispatch(.toggleAttention, state: &state)
        XCTAssertTrue(state.attentionDrawerVisible)
        dispatcher.dispatch(.toggleAttention, state: &state)
        XCTAssertFalse(state.attentionDrawerVisible)
        XCTAssertTrue(transport.sent.isEmpty)
        XCTAssertEqual(state.lastOutcome, .localPerformed(.toggleAttention))
    }

    func testInspectorToggleFlipsStateAndNeverTouchesTheTransport() {
        let transport = RecordingTransport()
        let dispatcher = ShellDispatcher(transport: transport.transport)
        var state = makeState()

        dispatcher.dispatch(.toggleInspector, state: &state)
        XCTAssertTrue(state.inspectorVisible)
        dispatcher.dispatch(.toggleInspector, state: &state)
        XCTAssertFalse(state.inspectorVisible)
        XCTAssertTrue(transport.sent.isEmpty)
        XCTAssertEqual(state.lastOutcome, .localPerformed(.toggleInspector))
    }

    func testUnbuiltSurfacesReportWhyInsteadOfPretending() {
        let transport = RecordingTransport()
        let dispatcher = ShellDispatcher(transport: transport.transport)
        var state = makeState()

        for command in [ShellCommand.enterFullTerminal] {
            let outcome = dispatcher.dispatch(command, state: &state)
            guard case .surfaceUnavailable(let surfaced, let reason) = outcome else {
                XCTFail("\(command) must not succeed silently")
                return
            }
            XCTAssertEqual(surfaced, command)
            XCTAssertFalse(reason.isEmpty)
            XCTAssertTrue(transport.sent.isEmpty)
        }
    }

    func testCommandBannerSurfacesTheRejection() {
        let dispatcher = ShellDispatcher(transport: shellUnavailableTransport)
        var state = makeState()

        dispatcher.dispatch(.stopProvider, state: &state)

        let banner = state.commandBanner
        XCTAssertEqual(banner?.severity, .warning)
        XCTAssertTrue(banner?.text.contains("Stop Provider…") ?? false)
    }
}
