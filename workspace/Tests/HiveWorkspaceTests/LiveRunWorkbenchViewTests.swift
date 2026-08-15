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

    @Test("Five background rows stay typed-only and unavailable controls say unknown")
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
        #expect(view.terminationFactText.contains("unknown"))
        #expect(view.terminationFactText.contains("process-tree-escapees-unaccounted"))
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

    @Test("Run hierarchy rows use a top-origin clip view")
    func railClipViewIsFlipped() throws {
        let view = LiveRunWorkbenchView(terminalFactory: nil)
        let scrollView = try #require(firstSubview(of: NSScrollView.self, in: view))

        #expect(scrollView.contentView.isFlipped)
    }

    @Test("Shell attach and detach commands consume the workbench's exact locator")
    func shellCommandsUseSelectedLocator() throws {
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
            state: ShellState(workspaceSource: ProjectionSource(revision: "7")))
        controller.installLiveRunWorkbench(workbench)

        controller.perform(ShellCommand.detachTerminalView)
        #expect(controller.installedLiveRunTerminalCount == 0)
        #expect(controller.currentState.activeRoute == .modelsQuota)
        controller.perform(ShellCommand.attachLiveTerminal)
        #expect(controller.installedLiveRunTerminalCount == 1)
        #expect(controller.selectedLiveRunLocator?.generation == 4)
    }

    private func projection(_ agents: [String]) throws -> LiveRunProjection {
        let line = try #require(FeedLine.parse(
            "{\"v\":1,\"agents\":[\(agents.joined(separator: ","))]}"))
        return try LiveRunProjection(feedLine: line)
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
