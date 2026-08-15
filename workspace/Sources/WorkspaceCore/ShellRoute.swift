// ShellRoute.swift The screen destinations of the new Workspace shell. There is a case here only for a screen ShellScreenRegistry declares, so a destination the shell does not have — Communications, Gates, Show Projects, and now Tokens and Autonomy, whose services cannot supply an honest contract — cannot reappear as a side effect of adding a route: it has to be declared, deliberately, with the renderer and menu entry the compiler then demands.
//
// Title and nav group are not repeated here. They are read from the one
// declaration, so the sidebar, the menus and this enum cannot drift apart.

import Foundation

public enum ShellRoute: String, Codable, CaseIterable, Equatable, Hashable, Sendable {
    case liveRun = "run"
    case taskRouter = "router"
    case modelsQuota = "models"
    case queen
    case memoryOverview = "memory-overview"
    case memoryLibrary = "memory-library"
    case memoryRecallLab = "memory-recall"
    case memoryMaintenance = "memory-maintenance"

    public var title: String { ShellScreenRegistry.declaration(for: self).title }

    public var navGroup: ShellNavGroup {
        ShellScreenRegistry.declaration(for: self).group
    }

    /// The menu item that names this destination.
    public var command: ShellCommand {
        ShellScreenRegistry.declaration(for: self).command
    }
}

public enum ShellNavGroup: String, CaseIterable, Equatable, Sendable {
    case workspace = "Workspace"
    case modelControl = "Model Control"
    case runtime = "Runtime"
    case memory = "Memory"

    public var title: String { rawValue }

    /// The screens declared in this group. A group with none renders nothing.
    public var routes: [ShellRoute] { ShellScreenRegistry.routes(in: self) }
}
