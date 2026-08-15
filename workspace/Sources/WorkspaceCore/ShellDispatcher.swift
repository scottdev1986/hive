// ShellDispatcher.swift The one command dispatcher. Every menu item and shortcut funnels through `dispatch(_:state:)`, which resolves the command through the registry and performs exactly one effect: a route change, one typed intent through the mutation envelope, or one named local action. Intents are minted one per dispatch with a fresh idempotency key, so a retried gesture is a new operation and a double-fire can never reuse an old receipt.

import Foundation

public typealias ShellMutationTransport =
    (ShellCommand, MutationIntent<ShellIntentBody>) -> MutationResult<ShellMutationPostState>

public struct ShellDispatcher {
    private let transport: ShellMutationTransport

    public init(transport: @escaping ShellMutationTransport) {
        self.transport = transport
    }

    /// Route navigation for surfaces that carry a destination rather than a menu command (the sidebar). Same state writes as a routed command.
    @discardableResult
    public func navigate(
        to route: ShellRoute,
        state: inout ShellState
    ) -> ShellCommandOutcome {
        state.navigate(to: route)
        let outcome = ShellCommandOutcome.routed(route)
        state.record(outcome: outcome)
        return outcome
    }

    @discardableResult
    public func dispatch(
        _ command: ShellCommand,
        state: inout ShellState
    ) -> ShellCommandOutcome {
        let outcome: ShellCommandOutcome
        switch command.resolution {
        case .route(let route):
            return navigate(to: route, state: &state)
        case .responderChain, .local(.aboutPanel), .local(.detachWorkspace),
             .local(.enterFullTerminal):
            // Responder-chain items carry their own selectors and never reach the dispatcher in production; About, detach, and handing the window to the live terminal viewer are performed by the window controller when it observes this outcome.
            outcome = .localPerformed(command)
        case .local(.toggleAttentionDrawer):
            state.setAttentionDrawer(visible: !state.attentionDrawerVisible)
            outcome = .localPerformed(command)
        case .local(.toggleInspector):
            state.setInspector(visible: !state.inspectorVisible)
            outcome = .localPerformed(command)
        case .local(.unavailableSurface(let reason)):
            outcome = .surfaceUnavailable(command, reason: reason)
        case .intent(let body):
            guard let expected = state.mutationExpectation else {
                outcome = .surfaceUnavailable(
                    command,
                    reason: "No workspace state has been observed, so there is "
                        + "no revision to compare a mutation against. "
                        + "The command was not sent.")
                break
            }
            let intent = MutationIntent<ShellIntentBody>(
                intentID: UUID().uuidString,
                expected: expected,
                idempotencyKey: "u2-shell.\(command.rawValue).\(UUID().uuidString)",
                body: body)
            outcome = .mutationResolved(transport(command, intent))
        }
        state.record(outcome: outcome)
        return outcome
    }
}

public func shellUnavailableTransport(
    command: ShellCommand,
    intent: MutationIntent<ShellIntentBody>
) -> MutationResult<ShellMutationPostState> {
    // try! cannot throw: the operation ID derives from the intent's own UUID, which is never empty.
    try! MutationResult(
        intentID: intent.intentID,
        operationID: "unavailable.\(intent.intentID)",
        postStateToken: intent.expected,
        outcome: .rejected(.shellWireUnavailable(command: command)),
        observedPostState: ShellMutationPostState(
            command: command,
            source: ProjectionSource(expectation: intent.expected)))
}

extension ProjectionSource {
    /// Recovers the compared source from an expectation the shell built from one. Only the dispatcher's own token shape round-trips here.
    public init(expectation: MutationExpectation) {
        switch expectation {
        case .revision(let revision):
            self.init(revision: revision)
        case .epoch(let epoch):
            self.init(generation: Int(epoch))
        case .revisionAndEpoch(let revision, let epoch):
            self.init(revision: revision, generation: Int(epoch))
        }
    }
}
