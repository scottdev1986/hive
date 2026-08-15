// ShellScreenRegistry.swift The one declaration of which screens the shell has. Route identity, sidebar placement, menu destination and renderer all read this list, so a screen cannot be reachable from one surface and missing from another — the disagreement that let one screen be filtered out of the sidebar while another with the same missing contract stayed visible.
//
// A screen with no honest contract is not declared here, and that is the whole
// mechanism: there is no availability flag, no skip list and no per-screen
// exception anywhere. Because `ShellRoute` carries a case only for a declared
// screen, the compiler rejects a menu command that names a screen the shell does
// not have, and the renderer's exhaustive switch rejects a route with no view.

import Foundation

/// One screen's whole existence. Everything four surfaces need to agree about a
/// screen lives in one value.
public struct ShellScreenDeclaration: Equatable, Sendable {
    public let route: ShellRoute
    public let title: String
    public let group: ShellNavGroup
    /// The menu item that names this destination. Every declared screen has one,
    /// so a screen is never reachable from the sidebar but unnameable in a menu.
    public let command: ShellCommand

    public init(
        route: ShellRoute,
        title: String,
        group: ShellNavGroup,
        command: ShellCommand
    ) {
        self.route = route
        self.title = title
        self.group = group
        self.command = command
    }
}

public enum ShellScreenRegistry {

    /// Every screen the shell has, in sidebar order. Screens omitted from this
    /// list do not exist: Autonomy (its config document carries no revision, so
    /// an honest compare-and-set is impossible), Tokens (the usage service
    /// declares its own attribution a control lower bound and three of the nine
    /// required attribution states have no source), and Memory Self-test (no
    /// daemon projection or route carries a self-test reading).
    public static let screens: [ShellScreenDeclaration] = [
        ShellScreenDeclaration(
            route: .liveRun, title: "Live Run",
            group: .workspace, command: .showLiveRun),
        ShellScreenDeclaration(
            route: .taskRouter, title: "Task Router",
            group: .modelControl, command: .showTaskRouter),
        ShellScreenDeclaration(
            route: .modelsQuota, title: "Models & Quota",
            group: .modelControl, command: .showModelsQuota),
        ShellScreenDeclaration(
            route: .queen, title: "Queen Provider",
            group: .runtime, command: .showQueenProvider),
        ShellScreenDeclaration(
            route: .memoryOverview, title: "Memory Overview",
            group: .memory, command: .memoryOverview),
        ShellScreenDeclaration(
            route: .memoryLibrary, title: "Memory Library",
            group: .memory, command: .memoryLibrary),
        ShellScreenDeclaration(
            route: .memoryRecallLab, title: "Recall Lab",
            group: .memory, command: .memoryRecallLab),
        ShellScreenDeclaration(
            route: .memoryMaintenance, title: "Memory Maintenance",
            group: .memory, command: .memoryMaintenance),
    ]

    /// The declaration for a route. Total by construction: `ShellRoute` has a
    /// case only for a declared screen, so this never returns nil for a route
    /// the shell can actually hold.
    public static func declaration(for route: ShellRoute) -> ShellScreenDeclaration {
        guard let declaration = screens.first(where: { $0.route == route }) else {
            // Unreachable while every route is declared, and the enumeration test
            // proves that. Trapping here rather than inventing a placeholder keeps
            // an undeclared screen from rendering as a plausible empty one.
            preconditionFailure("no declaration for route \(route.rawValue)")
        }
        return declaration
    }

    public static func routes(in group: ShellNavGroup) -> [ShellRoute] {
        screens.filter { $0.group == group }.map(\.route)
    }

    /// The nav groups that actually hold a screen, in declaration order. A group
    /// whose every screen was omitted does not render as an empty heading.
    public static var groups: [ShellNavGroup] {
        var seen: [ShellNavGroup] = []
        for screen in screens where !seen.contains(screen.group) {
            seen.append(screen.group)
        }
        return seen
    }
}
