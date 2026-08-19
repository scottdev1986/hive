// ShellCommand.swift The complete command catalog of the new Workspace shell: every menu item in every menu, each resolving to exactly one screen route, one responder-chain selector, or one named local action. The enum switch IS the registry — a command cannot exist without its resolution, which makes the dispatcher total by construction and enumerable in tests. Retired pane-era commands (promote-to-master, return-Queen-to-master, Close Pane, Show Projects, a Navigate menu, a floating Attention window, Communications/Gates routes, a generic provider approval) have no case here and therefore no way to be reached. Neither do the eighteen dead menu-intent commands (Queen vendor picks, the Agent menu's provider/terminal/attention controls, the whole Run menu, and Memory's curate/reindex actions) — they never reached a daemon wire in this build and are gone rather than left half-wired. The Agent menu's two terminal commands (attach-live-terminal, detach-terminal-view) followed them when the owner ruled the whole menu out: route navigation already attaches the Live Run viewer on arrival and detaches it on departure, so the commands added no capability.

import Foundation

public enum ShellMenu: String, CaseIterable, Equatable, Sendable {
    case hive = "Hive"
    case edit = "Edit"
    case view = "View"
    case memory = "Memory"
    case queen = "Queen"
    case window = "Window"
}

public struct ShellKeyEquivalent: Equatable, Hashable, Sendable {
    public let key: String
    public let modifiers: ShellKeyModifiers

    public init(_ key: String, _ modifiers: ShellKeyModifiers = .command) {
        self.key = key
        self.modifiers = modifiers
    }
}

public struct ShellKeyModifiers: OptionSet, Equatable, Hashable, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let command = ShellKeyModifiers(rawValue: 1 << 0)
    public static let shift = ShellKeyModifiers(rawValue: 1 << 1)
    public static let option = ShellKeyModifiers(rawValue: 1 << 2)
    public static let control = ShellKeyModifiers(rawValue: 1 << 3)
}

public enum ShellLocalAction: Equatable, Sendable {
    case aboutPanel
    case detachWorkspace
    /// Hand the window to the terminal viewer the Live Run workbench hosts. The
    /// surface exists in live mode, so this is a real destination rather than a
    /// refusal that sounds honest while describing a capability the app has.
    case enterFullTerminal
    case toggleAttentionDrawer
    case toggleInspector
    case unavailableSurface(reason: String)
}

public enum ShellCommandResolution: Equatable, Sendable {
    case route(ShellRoute)
    /// A standard AppKit responder-chain selector (Edit and Window menus); handled by the responder chain, never by the dispatcher.
    case responderChain(action: String)
    case local(ShellLocalAction)
}

public enum ShellCommand: String, Codable, CaseIterable, Equatable, Hashable, Sendable {
    case aboutHive = "about-hive"
    case showTaskRouter = "show-task-router"
    case showModelsQuota = "show-models-quota"
    case openMemoryManager = "open-memory-manager"
    case detachWorkspace = "detach-workspace"
    case undo
    case redo
    case cut
    case copy
    case paste
    case selectAll = "select-all"
    case showLiveRun = "show-live-run"
    case toggleAttention = "toggle-attention"
    case toggleInspector = "toggle-inspector"
    case enterFullTerminal = "enter-full-terminal"
    case memoryOverview = "memory-overview"
    case memoryLibrary = "memory-library"
    case memoryRecallLab = "memory-recall-lab"
    case memoryMaintenance = "memory-maintenance"
    case showQueenProvider = "show-queen-provider"
    case minimizeWindow = "minimize-window"
    case zoomWindow = "zoom-window"

    public var menu: ShellMenu {
        switch self {
        case .aboutHive, .openMemoryManager, .detachWorkspace:
            return .hive
        case .showTaskRouter, .showModelsQuota:
            return .view
        case .undo, .redo, .cut, .copy, .paste, .selectAll:
            return .edit
        case .showLiveRun, .toggleAttention, .toggleInspector, .enterFullTerminal:
            return .view
        case .memoryOverview, .memoryLibrary, .memoryRecallLab, .memoryMaintenance:
            return .memory
        case .showQueenProvider:
            return .queen
        case .minimizeWindow, .zoomWindow:
            return .window
        }
    }

    public var title: String {
        switch self {
        case .aboutHive: return "About Hive Workspace"
        case .showTaskRouter: return "Task Router"
        case .showModelsQuota: return "Models & Quota"
        case .openMemoryManager: return "Memory Manager…"
        case .detachWorkspace: return "Detach Workspace"
        case .undo: return "Undo"
        case .redo: return "Redo"
        case .cut: return "Cut"
        case .copy: return "Copy"
        case .paste: return "Paste"
        case .selectAll: return "Select All"
        case .showLiveRun: return "Live Run"
        case .toggleAttention: return "Attention"
        case .toggleInspector: return "Toggle Inspector"
        case .enterFullTerminal: return "Enter Full Terminal"
        case .memoryOverview: return "Overview"
        case .memoryLibrary: return "Library"
        case .memoryRecallLab: return "Recall Lab"
        case .memoryMaintenance: return "Maintenance"
        case .showQueenProvider: return "Queen Provider"
        case .minimizeWindow: return "Minimize"
        case .zoomWindow: return "Zoom"
        }
    }

    public var keyEquivalent: ShellKeyEquivalent? {
        switch self {
        case .openMemoryManager, .memoryOverview: return ShellKeyEquivalent("M")
        case .detachWorkspace: return ShellKeyEquivalent("q")
        case .undo: return ShellKeyEquivalent("z")
        case .redo: return ShellKeyEquivalent("Z")
        case .cut: return ShellKeyEquivalent("x")
        case .copy: return ShellKeyEquivalent("c")
        case .paste: return ShellKeyEquivalent("v")
        case .selectAll: return ShellKeyEquivalent("a")
        case .showLiveRun: return ShellKeyEquivalent("1")
        case .showTaskRouter: return ShellKeyEquivalent("2")
        case .showModelsQuota: return ShellKeyEquivalent("3")
        case .toggleAttention: return ShellKeyEquivalent("a", [.command, .option])
        case .toggleInspector: return ShellKeyEquivalent("i", [.command, .option])
        case .enterFullTerminal: return ShellKeyEquivalent("f", [.command, .control])
        case .showQueenProvider: return ShellKeyEquivalent("Q")
        case .minimizeWindow: return ShellKeyEquivalent("m")
        default: return nil
        }
    }

    public var resolution: ShellCommandResolution {
        switch self {
        case .aboutHive: return .local(.aboutPanel)
        case .showTaskRouter: return .route(.taskRouter)
        case .showModelsQuota: return .route(.modelsQuota)
        case .openMemoryManager, .memoryOverview: return .route(.memoryOverview)
        case .detachWorkspace: return .local(.detachWorkspace)
        case .undo: return .responderChain(action: "undo:")
        case .redo: return .responderChain(action: "redo:")
        case .cut: return .responderChain(action: "cut:")
        case .copy: return .responderChain(action: "copy:")
        case .paste: return .responderChain(action: "paste:")
        case .selectAll: return .responderChain(action: "selectAll:")
        case .showLiveRun: return .route(.liveRun)
        case .toggleAttention: return .local(.toggleAttentionDrawer)
        case .toggleInspector: return .local(.toggleInspector)
        case .enterFullTerminal: return .local(.enterFullTerminal)
        case .memoryLibrary: return .route(.memoryLibrary)
        case .memoryRecallLab: return .route(.memoryRecallLab)
        case .memoryMaintenance: return .route(.memoryMaintenance)
        case .showQueenProvider: return .route(.queen)
        case .minimizeWindow: return .responderChain(action: "performMiniaturize:")
        case .zoomWindow: return .responderChain(action: "performZoom:")
        }
    }
}
