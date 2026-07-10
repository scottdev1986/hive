import Foundation

/// The one shared command model. Every input surface — mouse clicks,
/// double-clicks, keyboard shortcuts, menu items, and accessibility custom
/// actions — constructs one of these and dispatches it through the same
/// reducer, so no two surfaces can disagree about what an action means.
public enum WorkspaceCommand: Equatable {
    // Focus (never approves, dismisses, or clears attention)
    case focusPane(PaneID)
    case moveFocus(Direction)
    case focusOrchestrator

    // Layout
    case promotePane(PaneID)
    case returnOrchestratorToMaster
    case closePane(PaneID)

    // Attention / resolution (always explicit; focus alone never triggers these)
    case acknowledgePane(PaneID)
    case resolveApproval(approvalID: String, approved: Bool)
    case openFailure(PaneID)

    // Transcript interaction
    case toggleToolOutput(paneID: PaneID, itemID: String)
    case sendComposerText(paneID: PaneID, text: String)
}
