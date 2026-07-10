import Foundation

/// The one shared command model. Every input surface — mouse clicks,
/// double-clicks, keyboard shortcuts, menu items, and accessibility custom
/// actions — constructs one of these and dispatches it through the same
/// reducer, so no two surfaces can disagree about what an action means.
///
/// Approvals and message sending are deliberately absent: panes are real
/// terminals, so those interactions happen inside the native claude/codex
/// TUIs by typing — the workspace only manages panes and attention.
public enum WorkspaceCommand: Equatable {
    // Focus (never acknowledges or clears attention)
    case focusPane(PaneID)
    case moveFocus(Direction)
    case focusOrchestrator

    // Layout
    case promotePane(PaneID)
    case returnOrchestratorToMaster
    case closePane(PaneID)

    // Attention resolution (always explicit; focus alone never triggers this)
    case acknowledgePane(PaneID)
}
