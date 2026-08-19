// ShellDispatcher.swift The one command dispatcher. Every menu item and shortcut funnels through `dispatch(_:state:)`, which resolves the command through the registry and performs exactly one effect: a route change or one named local action.

import Foundation

public struct ShellDispatcher {
    public init() {}

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
             .local(.enterFullTerminal), .local(.attachLiveTerminal), .local(.detachTerminalView):
            // Responder-chain items carry their own selectors and never reach the dispatcher in production; About, detach, entering the full terminal, and attaching/detaching the live viewer are performed by the window controller when it observes this outcome.
            outcome = .localPerformed(command)
        case .local(.toggleAttentionDrawer):
            state.setAttentionDrawer(visible: !state.attentionDrawerVisible)
            outcome = .localPerformed(command)
        case .local(.toggleInspector):
            state.setInspector(visible: !state.inspectorVisible)
            outcome = .localPerformed(command)
        case .local(.unavailableSurface(let reason)):
            outcome = .surfaceUnavailable(command, reason: reason)
        }
        state.record(outcome: outcome)
        return outcome
    }
}
