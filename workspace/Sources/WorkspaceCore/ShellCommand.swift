// ShellCommand.swift The complete command catalog of the new Workspace shell: every menu item in every menu, each resolving to exactly one typed intent, one screen route, one responder-chain selector, or one named local action. The enum switch IS the registry — a command cannot exist without its resolution, which makes the dispatcher total by construction and enumerable in tests. Retired pane-era commands (promote-to-master, return-Queen-to-master, Close Pane, Show Projects, a Navigate menu, a floating Attention window, Communications/Gates routes, a generic provider approval) have no case here and therefore no way to be reached.

import Foundation

public enum ShellMenu: String, CaseIterable, Equatable, Sendable {
    case hive = "Hive"
    case edit = "Edit"
    case view = "View"
    case agent = "Agent"
    case run = "Run"
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
    case intent(ShellIntentBody)
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
    case stopHive = "stop-hive"
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
    case attachLiveTerminal = "attach-live-terminal"
    case detachTerminalView = "detach-terminal-view"
    case pauseProvider = "pause-provider"
    case resumeProvider = "resume-provider"
    case stopProvider = "stop-provider"
    case terminateTerminal = "terminate-terminal"
    case acknowledgeAttention = "acknowledge-attention"
    case closeAgent = "close-agent"
    case reviewG1Proposal = "review-g1-proposal"
    case approveG1Package = "approve-g1-package"
    case reviewG2Candidate = "review-g2-candidate"
    case approveG2Candidate = "approve-g2-candidate"
    case pauseRun = "pause-run"
    case resumeRun = "resume-run"
    case redirectThroughQueen = "redirect-through-queen"
    case abortRun = "abort-run"
    case memoryOverview = "memory-overview"
    case memoryLibrary = "memory-library"
    case memoryRecallLab = "memory-recall-lab"
    case newCuratedMemory = "new-curated-memory"
    case memoryMaintenance = "memory-maintenance"
    case reindexMemory = "reindex-memory"
    case selectQueenClaude = "select-queen-claude"
    case selectQueenCodex = "select-queen-codex"
    case selectQueenGrok = "select-queen-grok"
    case selectQueenKimi = "select-queen-kimi"
    case selectQueenOpenCode = "select-queen-opencode"
    case showQueenProvider = "show-queen-provider"
    case minimizeWindow = "minimize-window"
    case zoomWindow = "zoom-window"

    public var menu: ShellMenu {
        switch self {
        case .aboutHive, .openMemoryManager, .detachWorkspace, .stopHive:
            return .hive
        case .showTaskRouter, .showModelsQuota:
            return .view
        case .undo, .redo, .cut, .copy, .paste, .selectAll:
            return .edit
        case .showLiveRun, .toggleAttention, .toggleInspector, .enterFullTerminal:
            return .view
        case .attachLiveTerminal, .detachTerminalView, .pauseProvider, .resumeProvider,
             .stopProvider, .terminateTerminal, .acknowledgeAttention, .closeAgent:
            return .agent
        case .reviewG1Proposal, .approveG1Package, .reviewG2Candidate, .approveG2Candidate,
             .pauseRun, .resumeRun, .redirectThroughQueen, .abortRun:
            return .run
        case .memoryOverview, .memoryLibrary, .memoryRecallLab, .newCuratedMemory,
             .memoryMaintenance, .reindexMemory:
            return .memory
        case .selectQueenClaude, .selectQueenCodex, .selectQueenGrok, .selectQueenKimi,
             .selectQueenOpenCode, .showQueenProvider:
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
        case .stopHive: return "Stop Hive…"
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
        case .attachLiveTerminal: return "Attach Live Terminal"
        case .detachTerminalView: return "Detach Terminal View"
        case .pauseProvider: return "Pause Provider"
        case .resumeProvider: return "Resume Provider"
        case .stopProvider: return "Stop Provider…"
        case .terminateTerminal: return "Terminate Terminal…"
        case .acknowledgeAttention: return "Acknowledge Attention"
        case .closeAgent: return "Close Agent…"
        case .reviewG1Proposal: return "Review G1 Proposal…"
        case .approveG1Package: return "Approve G1 Package…"
        case .reviewG2Candidate: return "Review G2 Candidate…"
        case .approveG2Candidate: return "Approve G2 SHA…"
        case .pauseRun: return "Pause Run…"
        case .resumeRun: return "Resume Run…"
        case .redirectThroughQueen: return "Redirect Through Queen…"
        case .abortRun: return "Abort Run…"
        case .memoryOverview: return "Overview"
        case .memoryLibrary: return "Library"
        case .memoryRecallLab: return "Recall Lab"
        case .newCuratedMemory: return "New Curated Memory…"
        case .memoryMaintenance: return "Maintenance"
        case .reindexMemory: return "Reindex…"
        case .selectQueenClaude: return "Select Claude…"
        case .selectQueenCodex: return "Select Codex…"
        case .selectQueenGrok: return "Select Grok…"
        case .selectQueenKimi: return "Select Kimi Code…"
        case .selectQueenOpenCode: return "Select OpenCode…"
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
        case .attachLiveTerminal: return ShellKeyEquivalent("\r")
        case .acknowledgeAttention: return ShellKeyEquivalent("K")
        case .closeAgent: return ShellKeyEquivalent("W")
        case .newCuratedMemory: return ShellKeyEquivalent("n")
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
        case .stopHive: return .intent(.stopHive)
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
        case .attachLiveTerminal: return .intent(.attachViewer)
        case .detachTerminalView: return .intent(.detachViewer)
        case .pauseProvider: return .intent(.pauseProvider)
        case .resumeProvider: return .intent(.resumeProvider)
        case .stopProvider: return .intent(.stopProvider)
        case .terminateTerminal: return .intent(.terminateTerminal)
        case .acknowledgeAttention: return .intent(.acknowledgeAttention)
        case .closeAgent: return .intent(.closeAgentCascade)
        case .reviewG1Proposal: return .intent(.reviewG1Proposal)
        case .approveG1Package: return .intent(.approveG1Package)
        case .reviewG2Candidate: return .intent(.reviewG2Candidate)
        case .approveG2Candidate: return .intent(.approveG2Candidate)
        case .pauseRun: return .intent(.pauseRun)
        case .resumeRun: return .intent(.resumeRun)
        case .redirectThroughQueen: return .intent(.redirectThroughQueen)
        case .abortRun: return .intent(.abortRun)
        case .memoryLibrary: return .route(.memoryLibrary)
        case .memoryRecallLab: return .route(.memoryRecallLab)
        case .newCuratedMemory: return .intent(.newCuratedMemory)
        case .memoryMaintenance: return .route(.memoryMaintenance)
        case .reindexMemory: return .intent(.reindexMemory)
        case .selectQueenClaude: return .intent(.setLiveQueenProvider(.claude))
        case .selectQueenCodex: return .intent(.setLiveQueenProvider(.codex))
        case .selectQueenGrok: return .intent(.setLiveQueenProvider(.grok))
        case .selectQueenKimi: return .intent(.setLiveQueenProvider(.kimi))
        case .selectQueenOpenCode: return .intent(.setLiveQueenProvider(.opencode))
        case .showQueenProvider: return .route(.queen)
        case .minimizeWindow: return .responderChain(action: "performMiniaturize:")
        case .zoomWindow: return .responderChain(action: "performZoom:")
        }
    }
}
