// ShellRoute.swift The ten screen destinations of the new Workspace shell. The sidebar and the menus both navigate through these identifiers, so a destination the shell does not have (Communications, Gates, Show Projects) cannot reappear as a side effect of adding a screen — it has to be added here, deliberately.

import Foundation

public enum ShellRoute: String, Codable, CaseIterable, Equatable, Hashable, Sendable {
    case liveRun = "run"
    case taskRouter = "router"
    case modelsQuota = "models"
    case tokens
    case queen
    case autonomy
    case memoryOverview = "memory-overview"
    case memoryLibrary = "memory-library"
    case memoryRecallLab = "memory-recall"
    case memoryMaintenance = "memory-maintenance"

    public var title: String {
        switch self {
        case .liveRun: return "Live Run"
        case .taskRouter: return "Task Router"
        case .modelsQuota: return "Models & Quota"
        case .tokens: return "Tokens"
        case .queen: return "Queen Provider"
        case .autonomy: return "Autonomy"
        case .memoryOverview: return "Memory Overview"
        case .memoryLibrary: return "Memory Library"
        case .memoryRecallLab: return "Recall Lab"
        case .memoryMaintenance: return "Memory Maintenance"
        }
    }
}

public enum ShellNavGroup: String, CaseIterable, Equatable, Sendable {
    case workspace = "Workspace"
    case modelControl = "Model Control"
    case runtime = "Runtime"
    case memory = "Memory"

    public var title: String { rawValue }

    public var routes: [ShellRoute] {
        switch self {
        case .workspace: return [.liveRun]
        case .modelControl: return [.taskRouter, .modelsQuota, .tokens]
        case .runtime: return [.queen, .autonomy]
        case .memory:
            return [.memoryOverview, .memoryLibrary, .memoryRecallLab, .memoryMaintenance]
        }
    }
}

extension ShellRoute {
    public var navGroup: ShellNavGroup {
        switch self {
        case .liveRun: return .workspace
        case .taskRouter, .modelsQuota, .tokens: return .modelControl
        case .queen, .autonomy: return .runtime
        case .memoryOverview, .memoryLibrary, .memoryRecallLab, .memoryMaintenance:
            return .memory
        }
    }
}
