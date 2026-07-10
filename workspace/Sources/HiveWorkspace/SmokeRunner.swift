import AppKit
import WorkspaceCore

/// Headless end-to-end checks against the REAL substrate: real SwiftTerm
/// terminals, a real feed subprocess (or the harness's process-boundary
/// stub), and real detached tmux sessions created by scripts/smoke.sh.
/// Windows stay offscreen (activation policy .accessory, never shown).
///
/// The harness communicates expectations through environment variables:
///   HIVE_SMOKE_AGENTS       comma list of name=marker for live agents whose
///                           pane buffers must eventually show `marker`
///   HIVE_SMOKE_CLOSED       comma list of agent names that must NOT get panes
///   HIVE_SMOKE_ORCH_MARKER  marker expected in the orchestrator buffer
///   HIVE_SMOKE_TYPE_INTO    agent name running an interactive shell for the
///                           keystroke round trip
///   HIVE_SMOKE_RT_MARKER    the round-trip marker; typed split ("S''MK…") so
///                           the shell's *output* is the only place the full
///                           marker can appear; the harness re-asserts it via
///                           `tmux capture-pane` after this process exits
///   HIVE_SMOKE_CLOSE        agent name whose pane is closed mid-test; the
///                           harness asserts its tmux session is still alive
///                           afterwards (closing a viewer never kills agents)
final class SmokeRunner {

    private let controller: ProjectWindowController
    private let config: LaunchConfig
    private var failures: [String] = []

    init(controller: ProjectWindowController, config: LaunchConfig) {
        self.controller = controller
        self.config = config
    }

    private func check(_ condition: Bool, _ label: String) {
        if !condition { failures.append(label) }
    }

    /// Pumps the main run loop until the condition holds or the timeout hits.
    /// Real subprocesses and ptys need real time; this is the only clock.
    @discardableResult
    private func waitUntil(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        return condition()
    }

    func run() {
        let env = ProcessInfo.processInfo.environment
        let expectedAgents: [(name: String, marker: String)] = (env["HIVE_SMOKE_AGENTS"] ?? "")
            .split(separator: ",")
            .compactMap { entry in
                let parts = entry.split(separator: "=", maxSplits: 1)
                guard parts.count == 2 else { return nil }
                return (String(parts[0]), String(parts[1]))
            }
        let closedAgents = (env["HIVE_SMOKE_CLOSED"] ?? "").split(separator: ",").map(String.init)
        let orchMarker = env["HIVE_SMOKE_ORCH_MARKER"]
        let typeInto = env["HIVE_SMOKE_TYPE_INTO"]
        let rtMarker = env["HIVE_SMOKE_RT_MARKER"]
        let closeTarget = env["HIVE_SMOKE_CLOSE"]

        // 1. Window created for the project.
        let projectName = ((config.projectDirectory ?? "") as NSString).lastPathComponent
        check(controller.window != nil, "project window exists")
        check(controller.window?.title == projectName, "window titled after the project directory")
        controller.window?.layoutIfNeeded()

        // 2. A pane per live agent in the feed, plus the orchestrator master.
        let expectedPaneCount = 1 + expectedAgents.count
        check(waitUntil(15) { self.controller.state.panes.count == expectedPaneCount
                              && self.controller.paneViewCount == expectedPaneCount },
              "pane per live agent + master (want \(expectedPaneCount), have \(controller.paneViewCount))")
        check(controller.state.layout.master == ProjectState.orchestratorPaneID,
              "orchestrator is master")
        for name in closedAgents {
            check(controller.state.panes[ProjectState.paneID(forAgent: name)] == nil,
                  "closed agent \(name) has no pane")
        }

        // 3. Panes are real terminals whose buffers show the tmux sessions'
        //    real output (spawn happens on committed geometry, so give it time).
        for (name, marker) in expectedAgents {
            let paneID = ProjectState.paneID(forAgent: name)
            check(waitUntil(20) { self.controller.terminalText(pane: paneID).contains(marker) },
                  "agent \(name) terminal shows real tmux output '\(marker)'")
            check(controller.terminalChildRunning(pane: paneID),
                  "agent \(name) attach client is running")
        }
        if let orchMarker {
            check(waitUntil(20) { self.controller.terminalText(pane: ProjectState.orchestratorPaneID).contains(orchMarker) },
                  "orchestrator terminal shows '\(orchMarker)'")
        }

        // 4. Layout solves master + satellites: master in the 55–60% band,
        //    satellites strictly to its right, nothing overlapping.
        let frames = controller.currentPaneFrames()
        check(frames.count == controller.state.panes.count, "solved frame per pane")
        if let masterFrame = frames[ProjectState.orchestratorPaneID], frames.count > 1 {
            let minX = frames.values.map(\.minX).min() ?? 0
            let maxX = frames.values.map(\.maxX).max() ?? 1
            let ratio = masterFrame.width / max(maxX - minX, 1)
            check((0.50...0.65).contains(ratio), "master width in band (ratio \(ratio))")
            for (paneID, frame) in frames where paneID != ProjectState.orchestratorPaneID {
                check(frame.minX >= masterFrame.maxX, "satellite \(paneID) right of master")
                check(frame.width > 0 && frame.height > 0, "satellite \(paneID) has geometry")
            }
        }

        // 5. Keystrokes reach the real tmux pane: type an echo whose *output*
        //    is the only place the full marker can appear.
        if let typeInto, let rtMarker, rtMarker.count > 2 {
            let paneID = ProjectState.paneID(forAgent: typeInto)
            let split = "\(rtMarker.prefix(1))''\(rtMarker.dropFirst())"
            controller.sendText("echo \(split)\r", pane: paneID)
            check(waitUntil(20) { self.controller.terminalText(pane: paneID).contains(rtMarker) },
                  "keystroke round trip through tmux ('\(rtMarker)')")
        }

        // 6. Closing a pane detaches: the attach client dies, the pane view
        //    goes away, and the harness asserts the session survived.
        if let closeTarget {
            let paneID = ProjectState.paneID(forAgent: closeTarget)
            let countBefore = controller.paneViewCount
            controller.dispatch(.closePane(paneID))
            check(controller.paneViewCount == countBefore - 1, "closed pane view removed")
            check(controller.state.panes[paneID] == nil, "closed pane left the reducer")
            check(waitUntil(10) { !self.controller.terminalChildRunning(pane: paneID) },
                  "attach client terminated on close")
            check(controller.currentPaneFrames().count == controller.state.panes.count,
                  "layout re-solved after close")
        }

        // Give SIGTERM'd children a beat to die before the harness inspects tmux.
        waitUntil(1.0) { false }

        if failures.isEmpty {
            print("SMOKE OK — \(controller.state.panes.count) panes over real tmux")
            exit(0)
        } else {
            print("SMOKE FAIL:\n  " + failures.joined(separator: "\n  "))
            exit(1)
        }
    }
}
