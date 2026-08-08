// SmokeSurface.swift The project window as a QA harness sees it: the reads and
// the synthetic events the headless end-to-end checks drive, and nothing else.
// The harness lives in its own module so the shipped binary never links it, and
// a separate module can only reach public declarations. Naming that reach as a
// protocol is what keeps ProjectWindowController's own members internal — the
// alternative was making fourteen production members public and widening the
// app's API for a test harness's benefit.

import AppKit
import HiveTerminalKit
import WorkspaceCore

public protocol SmokeSurface: AnyObject {
    var window: NSWindow? { get }
    var state: ProjectState { get }
    var paneViewCount: Int { get }
    func dispatch(_ command: WorkspaceCommand)
    func currentPaneFrames() -> [PaneID: CGRect]
    func terminalText(pane: PaneID) -> String
    func sendText(_ text: String, pane: PaneID)
    func postScrollWheel(deltaY: CGFloat, pane: PaneID) -> Bool
    func terminalChildRunning(pane: PaneID) -> Bool
    func sessiondTerminalView(pane: PaneID) -> HiveTerminalView?
    func sessiondTerminalHasStarted(pane: PaneID) -> Bool
    func postClick(pane: PaneID) -> Bool
    func focusIndicator(pane: PaneID) -> PaneFocusIndicator
    func firstResponderPane() -> PaneID?
}

// The conformance is internal, like the type: a witness only has to be as
// visible as the conformance, so every member above stays internal.
extension ProjectWindowController: SmokeSurface {}
