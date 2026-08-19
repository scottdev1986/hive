import AppKit
import Testing
@testable import HiveWorkspace
@testable import WorkspaceCore

@MainActor
@Suite("Live Run workbench")
struct LiveRunWorkbenchViewTests {
    @Test("Switching sessions replaces one exact surface without closing a session")
    func exactGenerationSwitch() throws {
        var surfaces: [FakeSurface] = []
        let view = LiveRunWorkbenchView { session in
            let surface = FakeSurface(locator: session.locator!)
            surfaces.append(surface)
            return surface
        }
        view.setRouteVisible(true)
        view.apply(try projection([
            agent("a", provider: "claude", generation: 1),
            agent("b", provider: "codex", generation: 2),
        ]))

        #expect(surfaces.count == 1)
        #expect(view.installedTerminalCount == 1)
        #expect(view.selectedLocator?.generation == 1)
        #expect(
            surfaces[0].installedView?.contentCompressionResistancePriority(
                for: .vertical) == .defaultLow)

        view.apply(try projection([
            agent("a", provider: "claude", generation: 1),
            agent("b", provider: "codex", generation: 7),
        ]))
        #expect(surfaces.count == 1)

        view.selectSession(id: "id-b")
        #expect(surfaces.count == 2)
        #expect(surfaces[0].detached)
        #expect(!surfaces[0].closed)
        #expect(view.installedTerminalCount == 1)
        #expect(view.selectedLocator?.generation == 7)

        view.apply(try projection([
            agent("a", provider: "claude", generation: 1),
            agent("b", provider: "codex", generation: 8),
        ]))
        #expect(surfaces.count == 3)
        #expect(surfaces[1].detached)
        #expect(!surfaces[1].closed)
        #expect(view.installedTerminalCount == 1)
        #expect(view.selectedLocator?.generation == 8)
    }

    @Test("Five background rows stay typed-only and unproved controls stay absent")
    func fiveTypedRowsOneSurface() throws {
        var surfaceCount = 0
        let view = LiveRunWorkbenchView { session in
            surfaceCount += 1
            return FakeSurface(locator: session.locator!)
        }
        view.setRouteVisible(true)
        view.apply(try projection([
            agent("a", provider: "claude", generation: 1),
            agent("b", provider: "codex", generation: 1),
            agent("c", provider: "grok", generation: 1),
            agent("d", provider: "kimi", generation: 1),
            agent("e", provider: "opencode", generation: 1),
        ]))

        #expect(view.rowCount == 5)
        #expect(surfaceCount == 1)
        #expect(view.installedTerminalCount == 1)
        #expect(!view.stopProviderControlEnabled)
        #expect(!view.terminateTerminalControlEnabled)
        #expect(view.stopProviderControlHidden)
        #expect(view.terminateTerminalControlHidden)
        #expect(view.terminationFactText.contains("unknown"))
        #expect(view.terminationFactText.contains("process-tree-escapees-unaccounted"))
    }

    @Test("Verified controls are visible, distinct, and carry exact confirmation copy")
    func verifiedControls() throws {
        var confirmed: [LiveRunControlOperation] = []
        var requested: [LiveRunControlOperation] = []
        let view = LiveRunWorkbenchView(
            terminalFactory: { FakeSurface(locator: $0.locator!) },
            confirmControl: { operation, _ in
                confirmed.append(operation)
                return true
            })
        view.onControlRequested = { operation, _ in requested.append(operation) }
        view.setRouteVisible(true)
        view.apply(try projection([agent("a", provider: "codex", generation: 1)]))
        let control = try controlProjection()

        view.applyControlProjection(control)

        #expect(!view.stopProviderControlHidden)
        #expect(!view.terminateTerminalControlHidden)
        #expect(view.stopProviderControlEnabled)
        #expect(view.terminateTerminalControlEnabled)
        let stopCopy = view.controlConfirmation(for: .stopProvider, projection: control)
        #expect(stopCopy.title == "Stop Codex provider?")
        #expect(stopCopy.message.contains("ProviderRun 018f1e90"))
        #expect(stopCopy.message.contains("retained zsh pid 4000 stays running"))
        #expect(!stopCopy.message.contains("whole terminal"))
        let terminateCopy = view.controlConfirmation(
            for: .terminateTerminal, projection: control)
        #expect(terminateCopy.title == "Terminate terminal generation 1?")
        #expect(terminateCopy.message.contains("retained zsh pid 4000"))
        #expect(terminateCopy.message.contains("all 3 verified process-tree members"))
        #expect(terminateCopy.message.contains("ends the terminal"))

        let stopButton = try #require(
            findView(in: view, identifier: "live-run-stop-provider") as? NSButton)
        let terminateButton = try #require(
            findView(in: view, identifier: "live-run-terminate-terminal") as? NSButton)
        #expect(stopButton is ActionButton)
        #expect(terminateButton is ActionButton)
        stopButton.performClick(nil)
        view.applyControlProjection(control)
        terminateButton.performClick(nil)

        #expect(confirmed == [.stopProvider, .terminateTerminal])
        #expect(requested == [.stopProvider, .terminateTerminal])
    }

    @Test("Leaving Live Run detaches its viewer and returning creates a fresh one")
    func routeDetach() throws {
        var surfaces: [FakeSurface] = []
        let view = LiveRunWorkbenchView { session in
            let surface = FakeSurface(locator: session.locator!)
            surfaces.append(surface)
            return surface
        }
        view.setRouteVisible(true)
        view.apply(try projection([agent("a", provider: "claude", generation: 4)]))

        view.setRouteVisible(false)
        #expect(surfaces[0].detached)
        #expect(view.installedTerminalCount == 0)

        view.setRouteVisible(true)
        #expect(surfaces.count == 2)
        #expect(view.installedTerminalCount == 1)
        #expect(view.selectedLocator?.generation == 4)
    }

    @Test("An unavailable feed withdraws the visible exact terminal")
    func unavailableWithdrawsVisibility() throws {
        var surfaces: [FakeSurface] = []
        var visibility: [String] = []
        let view = LiveRunWorkbenchView { session in
            let surface = FakeSurface(locator: session.locator!)
            surfaces.append(surface)
            return surface
        }
        view.setRouteVisible(true)
        view.onVisibleSessionChanged = { visibility.append($0?.id ?? "none") }
        view.apply(try projection([agent("a", provider: "claude", generation: 4)]))

        view.showUnavailable("strict feed refused")

        #expect(visibility == ["id-a", "none"])
        #expect(surfaces[0].detached)
        #expect(view.installedTerminalCount == 0)
    }

    @Test("A mismatched locator subject never reaches the terminal factory")
    func mismatchedLocatorDoesNotAttach() throws {
        var surfaceCount = 0
        let view = LiveRunWorkbenchView { session in
            surfaceCount += 1
            return FakeSurface(locator: session.locator!)
        }
        view.setRouteVisible(true)
        let mismatched = agent("a", provider: "claude", generation: 4)
            .replacingOccurrences(of: #""agentId":"id-a""#, with: #""agentId":"id-b""#)

        view.apply(try projection([mismatched]))

        #expect(surfaceCount == 0)
        #expect(view.installedTerminalCount == 0)
    }

    @Test("Repeated snapshots keep rail rows and publish only exact identity changes")
    func repeatedSnapshotDoesNotChurnVisibility() throws {
        var visibility: [String] = []
        let view = LiveRunWorkbenchView { session in
            FakeSurface(locator: session.locator!)
        }
        view.onVisibleSessionChanged = { session in
            guard let session, let locator = session.locator else {
                visibility.append("none")
                return
            }
            visibility.append("\(session.id):\(locator.generation)")
        }
        view.setRouteVisible(true)
        let first = try projection([agent("a", provider: "claude", generation: 1)])

        view.apply(first)
        let firstRow = try #require(findView(in: view, identifier: "live-run-session-id-a"))
        view.apply(first)
        let repeatedRow = try #require(
            findView(in: view, identifier: "live-run-session-id-a"))

        #expect(repeatedRow === firstRow)
        #expect(visibility == ["id-a:1"])

        let changedStatus = agent("a", provider: "claude", generation: 1)
            .replacingOccurrences(of: #""status":"idle""#, with: #""status":"working""#)
        view.apply(try projection([changedStatus]))
        #expect(visibility == ["id-a:1"])

        view.apply(try projection([agent("a", provider: "claude", generation: 2)]))
        #expect(visibility == ["id-a:1", "id-a:2"])
    }

    @Test("Live session rows use a truthful label and top-origin clip view")
    func railClipViewIsFlipped() throws {
        let view = LiveRunWorkbenchView(terminalFactory: nil)
        let scrollView = try #require(firstSubview(of: NSScrollView.self, in: view))
        let labels = textFields(in: view).map(\.stringValue)

        #expect(scrollView.contentView.isFlipped)
        #expect(labels.contains("Run hierarchy"))
        #expect(!labels.contains("SESSIONS"))
    }

    @Test("Queen is selected and attached from the orchestrator snapshot")
    func queenIsSelectedAndAttached() throws {
        var surfaces: [FakeSurface] = []
        let view = LiveRunWorkbenchView { session in
            let surface = FakeSurface(locator: session.locator!)
            surfaces.append(surface)
            return surface
        }
        view.setRouteVisible(true)
        view.apply(try projection([
            agent("david", provider: "codex", generation: 2),
        ], orchestrator: queenOrchestrator(generation: 6)))

        #expect(view.rowCount == 2)
        #expect(view.selectedLocator?.subject.kind == "root")
        #expect(view.selectedLocator?.generation == 6)
        #expect(surfaces.count == 1)
        let labels = textFields(in: view).map(\.stringValue)
        #expect(labels.contains("queen"))
        #expect(labels.contains("gpt-5.6-sol"))
        #expect(!labels.contains { $0.contains("TUI") })
        #expect(labels.filter { $0 == "Run hierarchy" }.count == 1)
    }

    @Test("Live Run chrome matches Split Horizon without unbacked controls")
    func mockupChrome() throws {
        let view = LiveRunWorkbenchView { session in
            FakeSurface(locator: session.locator!)
        }
        view.setRouteVisible(true)
        view.apply(try projection([agent("david", provider: "codex", generation: 3)]))

        let labels = textFields(in: view).map(\.stringValue)
        #expect(labels.contains("Run hierarchy"))
        #expect(labels.contains("Viewed scope"))
        #expect(labels.contains("Keyboard focus"))
        #expect(labels.contains("Generation"))
        #expect(labels.contains("3 · exact"))
        #expect(labels.contains("Codex"))
        #expect(labels.contains("ATTACHED LIVE · G3"))
        #expect(labels.contains("Run budget · not projected"))
        #expect(!labels.contains { $0.contains("19 target") })
        #expect(!labels.contains { $0.contains("TUI") })
        #expect(findView(in: view, identifier: "live-run-control-strip") != nil)
        #expect(findView(in: view, identifier: "live-run-snapshot") == nil)
        #expect(findView(in: view, identifier: "live-run-release-input") == nil)
        #expect(findView(in: view, identifier: "live-run-attach") == nil)
        #expect(findView(in: view, identifier: "live-run-attachment-status") is CapsuleBadge)
        #expect(findView(in: view, identifier: "live-run-inspector-tab-task") != nil)
        #expect(findView(in: view, identifier: "live-run-inspector-tab-events") != nil)
        #expect(findView(in: view, identifier: "live-run-inspector-tab-session") != nil)
    }

    @Test("A projected task appears only in the inspector task section")
    func taskAppearsOnce() throws {
        let task = "Investigate the exact task rendering site"
        let view = LiveRunWorkbenchView { session in
            FakeSurface(locator: session.locator!)
        }
        view.setRouteVisible(true)
        view.apply(try projection([
            agent("david", provider: "codex", generation: 3)
                .replacingOccurrences(
                    of: #""status":"idle""#,
                    with: #""status":"idle","taskDescription":"\#(task)""#),
        ]))

        let rendered = textFields(in: view).filter { $0.stringValue == task }
        #expect(rendered.count == 1)
        #expect(findView(in: view, identifier: "live-run-session-id-david")?.toolTip != task)
    }

    /// The route, not a menu command, owns the viewer: navigating to Live Run
    /// attaches the exact-generation terminal and navigating away detaches it.
    /// This pins the capability the retired Agent menu commands only repeated.
    @Test("Route navigation alone attaches and detaches the Live Run viewer")
    func routeNavigationDrivesViewerAttachment() throws {
        let workbench = LiveRunWorkbenchView { session in
            FakeSurface(locator: session.locator!)
        }
        workbench.apply(try projection([
            agent("a", provider: "claude", generation: 4),
        ]))
        let controller = WorkspaceShellWindowController(
            context: .init(
                projectName: "Hive",
                projectPath: "/tmp/hive",
                instanceLabel: "rig"),
            state: ShellState())
        controller.installLiveRunWorkbench(workbench)

        // The default route is already Live Run, so installation attaches.
        #expect(controller.installedLiveRunTerminalCount == 1)
        #expect(controller.selectedLiveRunLocator?.generation == 4)
        controller.apply { $0.navigate(to: .modelsQuota) }
        #expect(controller.installedLiveRunTerminalCount == 0)
        controller.apply { $0.navigate(to: .liveRun) }
        #expect(controller.installedLiveRunTerminalCount == 1)
        #expect(controller.selectedLiveRunLocator?.generation == 4)
    }

    @Test("A renderer failure waits and appears automatically")
    func rendererFailureIsActionable() throws {
        let view = LiveRunWorkbenchView { session in
            FailingSurface(locator: session.locator!)
        }
        view.setRouteVisible(true)
        view.apply(try projection([agent("a", provider: "claude", generation: 1)]))

        let placeholder = try #require(
            findView(in: view, identifier: "live-run-terminal-placeholder") as? NSTextField)
        #expect(
            placeholder.stringValue ==
                "Terminal renderer unavailable: surface creation failed. The terminal is waiting and will appear automatically.")
    }

    private func projection(
        _ agents: [String],
        orchestrator: String? = nil
    ) throws -> LiveRunProjection {
        var json = "{\"v\":1,\"agents\":[\(agents.joined(separator: ","))]"
        if let orchestrator {
            json += ",\"orchestrator\":\(orchestrator)"
        }
        json += "}"
        let line = try #require(FeedLine.parse(json))
        return try LiveRunProjection(feedLine: line)
    }

    private func queenOrchestrator(generation: Int) -> String {
        """
        {"name":"queen","status":"working","tool":"codex","model":"gpt-5.6-sol",
         "host":"sessiond","hostState":"running",
         "sessionLocator":{"schemaVersion":1,"instanceId":"rig",
           "subject":{"kind":"root"},"generation":\(generation),
           "sessionId":"ses_018f1e90-7b5a-7cc0-8000-000000000099",
           "hostKind":"sessiond","engineBuildId":"engine"},
         "presentation":{"panePresence":"visible","terminalState":"live",
           "headerDetail":"working","paneStatus":{"kind":"running"},
           "activity":"working"}}
        """
    }

    private func agent(_ name: String, provider: String, generation: Int) -> String {
        """
        {"id":"id-\(name)","name":"\(name)","tool":"\(provider)","model":"model",
         "status":"idle","sessionLocator":{"schemaVersion":1,"instanceId":"rig",
         "subject":{"kind":"agent","agentId":"id-\(name)"},"generation":\(generation),
         "sessionId":"ses_018f1e90-7b5a-7cc0-8000-000000000001",
         "hostKind":"sessiond","engineBuildId":"engine"}}
        """
    }

    private func controlProjection() throws -> LiveRunControlProjection {
        try JSONDecoder().decode(LiveRunControlProjection.self, from: Data(#"""
        {"schemaVersion":1,"observedAt":"2026-08-15T20:00:00.000Z",
         "agentId":"id-a","agentName":"a","provider":"codex",
         "locator":{"schemaVersion":1,"instanceId":"rig",
           "subject":{"kind":"agent","agentId":"id-a"},"generation":1,
           "sessionId":"ses_018f1e90-7b5a-7cc0-8000-000000000001",
           "hostKind":"sessiond","engineBuildId":"engine"},
         "providerRun":{"state":"running","runId":"018f1e90-7b5a-7cc0-8000-000000000902",
           "provider":"codex","process":{"pid":4100,"startToken":"4100:1",
           "processGroupId":4100,"observedAt":"2026-08-15T20:00:00.000Z"}},
         "shell":{"state":"retained","root":{"pid":4000,"startToken":"4000:1",
           "processGroupId":4000},"foreground":"provider"},
         "processCensus":{"state":"complete","source":"sessiond-process-tree",
           "members":[{"pid":4000,"startToken":"4000:1"},{"pid":4100,"startToken":"4100:1"},
           {"pid":4200,"startToken":"4200:1"}],"observedAt":"2026-08-15T20:00:00.000Z"},
         "termination":{"state":"not-requested"},
         "controls":{"stopProvider":{"enabled":true,"reason":null},
           "terminateTerminal":{"enabled":true,"reason":null}}}
        """#.utf8))
    }

    private func findView(in view: NSView, identifier: String) -> NSView? {
        if view.accessibilityIdentifier() == identifier { return view }
        for subview in view.subviews {
            if let match = findView(in: subview, identifier: identifier) { return match }
        }
        return nil
    }

    private func firstSubview<T: NSView>(of type: T.Type, in view: NSView) -> T? {
        if let match = view as? T { return match }
        for subview in view.subviews {
            if let match = firstSubview(of: type, in: subview) { return match }
        }
        return nil
    }

    private func textFields(in view: NSView) -> [NSTextField] {
        let nested = view.subviews.flatMap { textFields(in: $0) }
        return (view as? NSTextField).map { [$0] } ?? nested
    }
}

@MainActor
private final class FakeSurface: LiveRunTerminalSurface {
    let locator: AgentSessionLocator
    private(set) var installedView: NSView?
    private(set) var detached = false
    private(set) var closed = false

    init(locator: AgentSessionLocator) {
        self.locator = locator
    }

    func makeView() throws -> NSView {
        let view = NSView()
        installedView = view
        return view
    }

    func start() {}
    func detach() { detached = true }
}

@MainActor
private final class FailingSurface: LiveRunTerminalSurface {
    let locator: AgentSessionLocator
    var installedView: NSView? { nil }

    init(locator: AgentSessionLocator) {
        self.locator = locator
    }

    func makeView() throws -> NSView {
        throw RendererFailure()
    }

    func start() {}
    func detach() {}
}

private struct RendererFailure: LocalizedError {
    var errorDescription: String? { "surface creation failed" }
}
