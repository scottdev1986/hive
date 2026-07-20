import AppKit
import HiveTerminalKit
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
///                           afterwards (detaching a client never kills agents)
final class SmokeRunner {

    private static let productionPaneMinimumHighWater: UInt64 = 1_024

    static func sessiondLiveResizeInputAgent(environment: [String: String]) -> String {
        environment["HIVE_B22_REAL_SHELL"] == "1" ? "terminal" : "aria"
    }

    static func productionPaneAgent(environment: [String: String]) -> String? {
        guard let agent = environment["HIVE_B25_PRODUCTION_PANE_AGENT"],
              !agent.isEmpty else { return nil }
        return agent
    }

    private let controller: ProjectWindowController
    private let config: LaunchConfig
    private var failures: [String] = []
    private var productionPaneSummary: String?

    init(controller: ProjectWindowController, config: LaunchConfig) {
        self.controller = controller
        self.config = config
    }

    private func check(_ condition: Bool, _ label: String) {
        if !condition { failures.append(label) }
    }

    /// Pumps the main run loop until the condition holds or the timeout hits.
    /// Real subprocesses and ptys need real time; this is the only clock.
    ///
    /// It pumps AppKit's event queue too, not just the run loop: window key
    /// status, clicks, and the first-responder changes they cause arrive as
    /// NSEvents, and nothing delivers those but `NSApp.sendEvent`. Draining the
    /// run loop alone leaves them sitting in the queue — which is why a shown,
    /// activated window still reported itself as not key.
    @discardableResult
    private func waitUntil(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            if let event = NSApp.nextEvent(
                matching: .any,
                until: Date().addingTimeInterval(0.05),
                inMode: .default,
                dequeue: true) {
                NSApp.sendEvent(event)
            }
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        return condition()
    }

    private func tmuxPaneIsInCopyMode(_ session: String) -> Bool {
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["tmux", "display-message", "-p", "-t", "=\(session):", "#{pane_in_mode}"]
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            return process.terminationStatus == 0
                && String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) == "1"
        } catch {
            return false
        }
    }

    private func sendInProcessKeys(_ text: String, to window: NSWindow) -> Bool {
        for character in text {
            let isReturn = character == "\n"
            let characters = isReturn ? "\r" : String(character)
            guard let event = NSEvent.keyEvent(
                with: .keyDown,
                location: .zero,
                modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber,
                context: nil,
                characters: characters,
                charactersIgnoringModifiers: characters,
                isARepeat: false,
                keyCode: isReturn ? 36 : 0
            ) else { return false }
            window.sendEvent(event)
        }
        return true
    }

    private func runSessiondLiveResizeInputProof(agent: String) {
        let paneID = ProjectState.paneID(forAgent: agent)
        let paneArrived = waitUntil(20) {
            self.controller.state.panes[paneID] != nil
                && self.controller.sessiondTerminalView(pane: paneID) != nil
        }
        check(paneArrived, "sessiond pane \(agent) appeared in the actual app")
        guard let window = controller.window,
              let terminal = controller.sessiondTerminalView(pane: paneID) else {
            finishSessiondLiveResizeInputProof()
            return
        }

        NSRunningApplication.current.activate(options: [.activateAllWindows])
        NSApp.activate(ignoringOtherApps: true)
        window.orderFrontRegardless()
        window.makeKey()
        if !window.isKeyWindow {
            let cocoaPoint = NSPoint(x: window.frame.midX, y: window.frame.maxY - 12)
            let mainDisplayHeight = CGDisplayBounds(CGMainDisplayID()).height
            let quartzPoint = CGPoint(x: cocoaPoint.x, y: mainDisplayHeight - cocoaPoint.y)
            for type in [CGEventType.leftMouseDown, .leftMouseUp] {
                if let event = CGEvent(
                    mouseEventSource: nil,
                    mouseType: type,
                    mouseCursorPosition: quartzPoint,
                    mouseButton: .left
                ) {
                    event.post(tap: .cghidEventTap)
                }
            }
        }
        check(waitUntil(10) { window.isKeyWindow }, "actual app window became key")
        check(waitUntil(10) { terminal.surfaceState == .live },
              "sessiond terminal reached live before resize (\(terminal.surfaceState))")
        controller.dispatch(.focusPane(paneID))
        check(waitUntil(3) { window.firstResponder === terminal },
              "sessiond terminal owns the actual app keyboard")

        let preResizeHighWater = terminal.highWater
        let preResizeMarker = "HIVE_BEFORE_RESIZE_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        check(sendInProcessKeys("echo \(preResizeMarker)\n", to: window),
              "constructed pre-resize in-process key events")
        check(waitUntil(10) {
            if case .applied(_, let stage) = terminal.inputSubmissionState {
                return stage == "written-to-terminal"
            }
            return false
        }, "pre-resize in-process keys were written to the terminal")
        check(waitUntil(10) { terminal.highWater > preResizeHighWater },
              "pre-resize command produced new PTY output")
        let preResizeTransaction: String?
        if case .applied(let transactionId, _) = terminal.inputSubmissionState {
            preResizeTransaction = transactionId
        } else {
            preResizeTransaction = nil
        }

        let geometryBefore = terminal.reportedGeometry
        let resizeFramesBefore = terminal.resizeFramesSent
        let frameBefore = window.frame
        var sawLiveResizeStart = false
        var sawLiveResizeEnd = false
        var sawInLiveResize = false
        let center = NotificationCenter.default
        let startObserver = center.addObserver(
            forName: NSWindow.willStartLiveResizeNotification,
            object: window,
            queue: .main
        ) { _ in
            sawLiveResizeStart = true
            sawInLiveResize = window.inLiveResize
        }
        let endObserver = center.addObserver(
            forName: NSWindow.didEndLiveResizeNotification,
            object: window,
            queue: .main
        ) { _ in
            sawLiveResizeEnd = true
        }

        let start = NSPoint(x: window.contentLayoutRect.maxX - 1, y: 1)
        let end = NSPoint(x: start.x + 160, y: start.y - 90)
        func mouseEvent(_ type: NSEvent.EventType, at point: NSPoint, number: Int) -> NSEvent? {
            NSEvent.mouseEvent(
                with: type,
                location: point,
                modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber,
                context: nil,
                eventNumber: number,
                clickCount: 1,
                pressure: type == .leftMouseDown ? 1 : 0
            )
        }
        if let down = mouseEvent(.leftMouseDown, at: start, number: 1),
           let dragged = mouseEvent(.leftMouseDragged, at: end, number: 2),
           let up = mouseEvent(.leftMouseUp, at: end, number: 3) {
            // The mouse-down enters AppKit's modal live-resize tracking loop;
            // it consumes the queued drag/up before sendEvent returns.
            NSApp.postEvent(dragged, atStart: false)
            NSApp.postEvent(up, atStart: false)
            window.sendEvent(down)
        } else {
            failures.append("constructed in-process live-resize mouse events")
        }
        center.removeObserver(startObserver)
        center.removeObserver(endObserver)

        check(sawLiveResizeStart && sawInLiveResize,
              "mouse drag entered NSWindow live resize with inLiveResize=true")
        check(sawLiveResizeEnd, "mouse drag completed NSWindow live resize")
        check(window.frame != frameBefore, "mouse drag changed the actual app window frame")
        check(waitUntil(5) {
            terminal.reportedGeometry != geometryBefore
                && terminal.resizeFramesSent > resizeFramesBefore
        }, "live resize changed Ghostty geometry and sent RESIZE")
        check(terminal.surfaceState == .live,
              "terminal remained live after resize (\(terminal.surfaceState))")
        check(window.firstResponder === terminal,
              "live resize preserved the sessiond terminal first responder")

        let highWaterBefore = terminal.highWater
        let marker = "HIVE_LIVE_RESIZE_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        check(sendInProcessKeys("echo \(marker)\n", to: window),
              "constructed post-resize in-process key events")
        check(waitUntil(10) {
            if case .applied(let transactionId, let stage) = terminal.inputSubmissionState {
                return transactionId != preResizeTransaction && stage == "written-to-terminal"
            }
            return false
        }, "post-resize in-process keys were written to the terminal")
        check(waitUntil(10) { terminal.highWater > highWaterBefore },
              "post-resize command produced new PTY output")

        print(
            "LIVE RESIZE INPUT PROOF: frame \(frameBefore) -> \(window.frame), "
                + "geometry \(String(describing: geometryBefore)) -> "
                + "\(String(describing: terminal.reportedGeometry)), marker \(marker), "
                + "input \(terminal.inputSubmissionState), highWater "
                + "\(highWaterBefore) -> \(terminal.highWater)"
        )
        finishSessiondLiveResizeInputProof()
    }

    private func finishSessiondLiveResizeInputProof() {
        if failures.isEmpty {
            print("LIVE RESIZE INPUT PROOF OK")
            exit(0)
        } else {
            print("LIVE RESIZE INPUT PROOF FAIL:\n  " + failures.joined(separator: "\n  "))
            exit(1)
        }
    }

    private func runProductionPaneProof(agent: String) {
        if let window = controller.window {
            NSRunningApplication.current.activate(options: [.activateAllWindows])
            NSApp.activate(ignoringOtherApps: true)
            window.orderFrontRegardless()
            window.makeKey()
        }
        let paneID = ProjectState.paneID(forAgent: agent)
        waitForProductionPane(agent: agent, paneID: paneID,
                              deadline: Date().addingTimeInterval(45))
    }

    private func captureProductionWindow(_ window: NSWindow, to path: String) -> Bool {
        guard let contentView = window.contentView else { return false }
        contentView.layoutSubtreeIfNeeded()
        guard let representation = contentView.bitmapImageRepForCachingDisplay(
            in: contentView.bounds) else { return false }
        contentView.cacheDisplay(in: contentView.bounds, to: representation)
        guard let png = representation.representation(using: .png, properties: [:]) else {
            return false
        }
        do {
            try png.write(to: URL(fileURLWithPath: path), options: .atomic)
            return true
        } catch {
            return false
        }
    }

    /// The production pane depends on feed callbacks dispatched to the main
    /// queue. A synchronous polling loop here starves those callbacks and makes
    /// the proof itself prevent the pane it is waiting for from being admitted.
    private func waitForProductionPane(agent: String, paneID: PaneID, deadline: Date) {
        guard let window = controller.window,
              let pane = controller.state.panes[paneID],
              let locator = pane.sessionLocator,
              let terminal = controller.sessiondTerminalView(pane: paneID) else {
            guard Date() < deadline else {
                check(false, "production pane \(agent) appeared in the real Workspace")
                finishProductionPaneProof()
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                self?.waitForProductionPane(agent: agent, paneID: paneID, deadline: deadline)
            }
            return
        }

        check(locator.hostKind == "sessiond",
              "production feed supplied a sessiond locator")
        let expectedLocator = SessionLocator(
            schemaVersion: locator.schemaVersion,
            instanceId: locator.instanceId,
            subjectKind: locator.subject.kind,
            agentId: locator.subject.agentId,
            generation: locator.generation,
            sessionId: locator.sessionId,
            hostKind: locator.hostKind,
            engineBuildId: locator.engineBuildId)
        waitForProductionSurface(
            agent: agent, paneID: paneID, locator: locator,
            expectedLocator: expectedLocator, terminal: terminal, window: window,
            deadline: Date().addingTimeInterval(60))
    }

    private func waitForProductionSurface(
        agent: String, paneID: PaneID, locator: AgentSessionLocator,
        expectedLocator: SessionLocator, terminal: HiveTerminalView,
        window: NSWindow, deadline: Date
    ) {
        let renderEvidence = terminal.renderEvidence
        let feedStatus = controller.state.panes[paneID]?.feedStatus
        guard terminal.surfaceState == .live,
              terminal.sessionLocator == expectedLocator,
              terminal.highWater >= Self.productionPaneMinimumHighWater,
              renderEvidence.drawCount > 0,
              renderEvidence.hasPresentedContents,
              feedStatus != nil,
              feedStatus != "spawning" else {
            guard Date() < deadline else {
                check(false, "HiveTerminalView reached its first correct frame on the exact locator")
                finishProductionPaneChecks(
                    agent: agent, paneID: paneID, locator: locator,
                    terminal: terminal, window: window)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                self?.waitForProductionSurface(
                    agent: agent, paneID: paneID, locator: locator,
                    expectedLocator: expectedLocator, terminal: terminal,
                    window: window, deadline: deadline)
            }
            return
        }
        finishProductionPaneChecks(
            agent: agent, paneID: paneID, locator: locator,
            terminal: terminal, window: window)
    }

    private func finishProductionPaneChecks(
        agent: String, paneID: PaneID, locator: AgentSessionLocator,
        terminal: HiveTerminalView, window: NSWindow
    ) {
        check(terminal.highWater > 0,
              "the production vendor TUI presented non-empty ordered output")
        check(terminal.highWater >= Self.productionPaneMinimumHighWater,
              "the production vendor TUI settled on substantive ordered output")
        check(terminal.renderEvidence.drawCount > 0
                && terminal.renderEvidence.hasPresentedContents,
              "the production renderer presented nonblank layer content")
        let feedStatus = controller.state.panes[paneID]?.feedStatus
        check(feedStatus != nil && feedStatus != "spawning",
              "the production pane header settled beyond spawning")
        check(terminal.window === controller.window && terminal.superview != nil,
              "HiveTerminalView is installed in the real Workspace window")
        check(terminal.bounds.width > 0 && terminal.bounds.height > 0,
              "the production pane has committed non-zero geometry")
        check(window.isVisible,
              "the real Workspace window is visible for evidence capture")
        check(!controller.terminalChildRunning(pane: paneID),
              "the renderer owns no hidden SwiftTerm child PTY")
        let screenshotPath = ProcessInfo.processInfo.environment[
            "HIVE_B25_PRODUCTION_PANE_SCREENSHOT"]
        check(screenshotPath != nil,
              "the production-pane qualification supplied a screenshot path")
        if let screenshotPath {
            check(captureProductionWindow(window, to: screenshotPath),
                  "the real Workspace wrote its own window PNG")
        }

        productionPaneSummary =
            "PRODUCTION PANE PROOF: agent=\(agent) instance=\(locator.instanceId) "
                + "session=\(locator.sessionId) "
                + "generation=\(locator.generation) engine=\(locator.engineBuildId ?? "missing") "
                + "highWater=\(terminal.highWater) frame=\(terminal.frame) "
                + "drawCount=\(terminal.renderEvidence.drawCount) "
                + "presented=\(terminal.renderEvidence.hasPresentedContents) "
                + "feedStatus=\(feedStatus ?? "missing") "
                + "window=\(window.windowNumber) visible=\(window.isVisible) "
                + "screenshot=\(screenshotPath ?? "missing")"
        finishProductionPaneProof()
    }

    private func finishProductionPaneProof() {
        let result = failures.isEmpty
            ? "PRODUCTION PANE PROOF OK"
            : "PRODUCTION PANE PROOF FAIL:\n  " + failures.joined(separator: "\n  ")
        let report = [productionPaneSummary, result].compactMap { $0 }.joined(separator: "\n") + "\n"
        if let path = ProcessInfo.processInfo.environment["HIVE_B25_PRODUCTION_PANE_RESULT"] {
            do {
                try report.write(toFile: path, atomically: true, encoding: .utf8)
            } catch {
                print("PRODUCTION PANE PROOF FAIL: could not write result: \(error)")
                return
            }
        }
        print(report, terminator: "")
    }

    func run() {
        let env = ProcessInfo.processInfo.environment
        if let agent = Self.productionPaneAgent(environment: env) {
            runProductionPaneProof(agent: agent)
            return
        }
        if env["HIVE_SMOKE_SESSIOND_LIVE_RESIZE_INPUT"] == "1" {
            runSessiondLiveResizeInputProof(
                agent: Self.sessiondLiveResizeInputAgent(environment: env))
            return
        }
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
        check(controller.window?.title == "Hive Workspace - \(projectName)",
              "window titled after the project directory")
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


        // 4. Agent panes encode wheel gestures for tmux, which can forward them
        // to a mouse-aware TUI. The orchestrator suppresses mouse reporting, so
        // Workspace keeps its explicit copy-mode path.
        if let agent = expectedAgents.first {
            check(controller.postScrollWheel(
                deltaY: 10,
                pane: ProjectState.paneID(forAgent: agent.name)),
                "agent wheel is sent through tmux mouse routing")
        }
        if let session = config.orchestratorSession {
            check(controller.postScrollWheel(
                deltaY: 10,
                pane: ProjectState.orchestratorPaneID),
                "orchestrator wheel uses Workspace copy-mode routing")
            check(waitUntil(5) { self.tmuxPaneIsInCopyMode(session) },
                  "orchestrator wheel enters tmux copy-mode")
        } else {
            failures.append("smoke launch provides orchestrator tmux session")
        }

        // 5. Layout solves master + satellites: master in the 55–60% band,
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

        // 6. The actual Pane menu actions reach the controller, swap the
        //    focused agent into the master slot, then restore the exact grid.
        //    Real terminal children stay attached across both PTY resizes.
        if let agent = expectedAgents.last {
            let paneID = ProjectState.paneID(forAgent: agent.name)
            let framesBefore = controller.currentPaneFrames()
            let paneMenu = NSApp.mainMenu?.items.compactMap(\.submenu).first { $0.title == "Pane" }
            if let paneMenu,
               let promoteIndex = paneMenu.items.firstIndex(where: { $0.title == "Promote to Master" }),
               let returnIndex = paneMenu.items.firstIndex(where: { $0.title == "Return Queen to Master" }) {
                let promoteItem = paneMenu.items[promoteIndex]
                let returnItem = paneMenu.items[returnIndex]
                check(paneMenu.autoenablesItems, "Pane menu uses automatic item validation")
                check(promoteItem.target === controller && returnItem.target === controller,
                      "Pane layout actions explicitly target the project controller")
                check((NSApp.target(forAction: promoteItem.action!,
                                    to: promoteItem.target as AnyObject?,
                                    from: promoteItem) as AnyObject?) === controller,
                      "AppKit resolves the Promote target")
                check((NSApp.target(forAction: returnItem.action!,
                                    to: returnItem.target as AnyObject?,
                                    from: returnItem) as AnyObject?) === controller,
                      "AppKit resolves the Return target")
                check(promoteItem.keyEquivalent == "\r"
                      && promoteItem.keyEquivalentModifierMask == [.command],
                      "Promote shortcut is Command-Return")
                check(returnItem.keyEquivalent == "\r"
                      && returnItem.keyEquivalentModifierMask == [.command, .shift],
                      "Return shortcut is Shift-Command-Return")

                controller.dispatch(.focusPane(paneID))
                paneMenu.update()
                check(promoteItem.isEnabled, "Promote is enabled for a focused satellite")
                check(!returnItem.isEnabled, "Return is disabled while orchestrator is master")
                paneMenu.performActionForItem(at: promoteIndex)
                check(waitUntil(2) { self.controller.state.layout.master == paneID },
                      "Pane > Promote to Master swaps the focused agent")
                check((controller.currentPaneFrames()[paneID]?.width ?? 0)
                      > (framesBefore[paneID]?.width ?? 0),
                      "promoted agent pane becomes wider")
                waitUntil(LayoutTransition.duration + 0.1) { false }
                check(controller.terminalChildRunning(pane: paneID),
                      "promoted agent terminal remains live after PTY resize")

                paneMenu.update()
                check(!promoteItem.isEnabled, "Promote is disabled for the current master")
                check(returnItem.isEnabled, "Return is enabled after promoting an agent")
                paneMenu.performActionForItem(at: returnIndex)
                check(waitUntil(2) {
                    self.controller.state.layout.master == ProjectState.orchestratorPaneID
                        && self.controller.currentPaneFrames() == framesBefore
                }, "Pane > Return Queen to Master restores the grid")
                waitUntil(LayoutTransition.duration + 0.1) { false }
                check(controller.terminalChildRunning(pane: ProjectState.orchestratorPaneID),
                      "orchestrator terminal remains live after PTY resize")
                paneMenu.update()
                check(promoteItem.isEnabled, "Promote re-enables after returning orchestrator")
                check(!returnItem.isEnabled, "Return disables after restoring orchestrator")
            } else {
                failures.append("Pane menu exposes promote and return actions")
            }
        }

        // 7. Keystrokes reach the real tmux pane: type an echo whose *output*
        //    is the only place the full marker can appear.
        if let typeInto, let rtMarker, rtMarker.count > 2 {
            let paneID = ProjectState.paneID(forAgent: typeInto)
            let split = "\(rtMarker.prefix(1))''\(rtMarker.dropFirst())"
            controller.sendText("echo \(split)\r", pane: paneID)
            check(waitUntil(20) { self.controller.terminalText(pane: paneID).contains(rtMarker) },
                  "keystroke round trip through tmux ('\(rtMarker)')")
        }

        // 8. The active-pane indicator tracks the REAL keyboard, not the last
        //    click: a click is delivered through the window's own event dispatch
        //    (hit-test → SwiftTerm takes first responder), and the indicator is
        //    read back off the pane VIEW — never off the reducer, which would
        //    prove only that the app agrees with itself.
        if let agent = expectedAgents.first {
            let paneID = ProjectState.paneID(forAgent: agent.name)
            let orchestrator = ProjectState.orchestratorPaneID

            // Activation is asynchronous: in visible mode the window is ordered
            // in and activated, but it is not key until the run loop has spun.
            // Wait for it, and FAIL if it never arrives — silently falling back
            // to the non-key branch would quietly delete the click coverage.
            let wantsKey = ProcessInfo.processInfo.environment["HIVE_SMOKE_VISIBLE"] == "1"
            let windowIsKey = wantsKey
                ? waitUntil(5) { self.controller.window?.isKeyWindow ?? false }
                : (controller.window?.isKeyWindow ?? false)
            if wantsKey {
                check(windowIsKey, "HIVE_SMOKE_VISIBLE window became key")
            }

            // Focus moves by keyboard, and the indicator follows the keyboard —
            // this holds whether or not the window is key.
            controller.dispatch(.focusPane(paneID))
            check(waitUntil(2) { self.controller.firstResponderPane() == paneID },
                  "a focus command hands the pane the real first responder")
            check(controller.focusIndicator(pane: paneID) != .none,
                  "the focused pane shows an indicator")
            check(controller.focusIndicator(pane: orchestrator) == .none,
                  "the pane that lost the keyboard drops its indicator")

            if windowIsKey {
                // Key window: a real click must move the keyboard AND the ring.
                check(controller.postClick(pane: orchestrator),
                      "click delivered to the orchestrator pane")
                check(waitUntil(2) { self.controller.firstResponderPane() == orchestrator },
                      "clicking a pane gives it the keyboard (first responder)")
                check(controller.focusIndicator(pane: orchestrator) == .active,
                      "the clicked pane shows the ACTIVE indicator in a key window")
                check(controller.focusIndicator(pane: paneID) == .none,
                      "the previously focused pane drops its indicator on click")
                check(controller.state.focusedPane == orchestrator,
                      "the reducer follows the real first responder after a click")
                controller.dispatch(.focusPane(paneID))
            } else {
                // A click into a non-key window is an ACTIVATION on macOS, not a
                // focus change, so click-to-focus cannot be asserted here. Say so
                // rather than let the coverage look complete.
                print("  (skipped: click-to-focus needs a key window — rerun with HIVE_SMOKE_VISIBLE=1)")

                // What this mode CAN prove is the honesty rule: the pane still
                // holds focus, and the indicator says so — but it must never
                // claim the vivid "keystrokes land here" state while none can.
                check(controller.focusIndicator(pane: paneID) == .inactive,
                      "a non-key window shows the dimmed indicator, never .active")
            }

            controller.dispatch(.focusOrchestrator)
            check(waitUntil(2) { self.controller.firstResponderPane() == orchestrator },
                  "keyboard focus move hands the keyboard to the orchestrator")
            check(controller.focusIndicator(pane: orchestrator) != .none
                  && controller.focusIndicator(pane: paneID) == .none,
                  "the indicator follows a keyboard focus move")
        }

        // 9. Closing a pane closes the AGENT: the workspace asks the daemon to
        //    kill it, the attach client dies, and the pane view goes away. The
        //    kill is recorded rather than sent — a smoke run must not end a real
        //    agent — so what is asserted here is that the close asks for one.
        if let closeTarget {
            let paneID = ProjectState.paneID(forAgent: closeTarget)
            let countBefore = controller.paneViewCount
            var killed: [String] = []
            controller.killAgent = { name, _ in killed.append(name) }
            // Close the pane that currently holds the keyboard: the indicator
            // must not survive on a dead pane, and exactly one live pane may
            // claim focus afterwards.
            controller.dispatch(.focusPane(paneID))
            check(waitUntil(2) { self.controller.firstResponderPane() == paneID },
                  "focused the pane that is about to close")
            controller.dispatch(.closePane(paneID))
            check(killed == [closeTarget], "closing a pane asks the daemon to kill its agent")
            check(controller.paneViewCount == countBefore - 1, "closed pane view removed")
            check(controller.state.panes[paneID] == nil, "closed pane left the reducer")
            check(waitUntil(10) { !self.controller.terminalChildRunning(pane: paneID) },
                  "attach client terminated on close")
            check(controller.currentPaneFrames().count == controller.state.panes.count,
                  "layout re-solved after close")

            let focused = controller.state.panes.keys.filter {
                controller.focusIndicator(pane: $0) != .none
            }
            check(focused.count == 1, "exactly one live pane shows the indicator after a close")
            check(controller.firstResponderPane() == focused.first,
                  "the indicator sits on the pane that really took the keyboard")
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
