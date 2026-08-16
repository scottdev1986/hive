// WorkspaceShellDelegate.swift The application delegate for the new shell launch. It resolves the shell state — the daemon for a live launch, a QA build's injected corpus loader otherwise — builds the one window controller and the menu bar, and — under HIVE_SHELL_PROOF=1 — prints the measured launch line the workspace-shell prototype greps instead of showing a window. Detach is the ordinary close: quitting this app never stops the daemon.

import AppKit
import WorkspaceCore

final class WorkspaceShellDelegate: NSObject, NSApplicationDelegate {

    private let config: LaunchConfig
    private let launch: WorkspaceShellLaunch
    private var controller: WorkspaceShellWindowController?
    private var liveRunFeed: FeedClient?
    private var liveRunControlGateway: LiveRunControlGateway?
    private let liveRunWorkspaceSessionID = "workspace-shell-\(UUID().uuidString)"
    private var liveRunInventoryRevision = 0

    init(config: LaunchConfig, launch: WorkspaceShellLaunch) {
        self.config = config
        self.launch = launch
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        Task { @MainActor in
            do {
                let state: ShellState
                if let fixtureState = launch.fixtureState {
                    state = try fixtureState(launch.scenario)
                } else {
                    state = try await ShellLiveStore(config: config).loadState()
                }
                await finishLaunch(state: state)
            } catch {
                failLaunch(error)
            }
        }
    }

    @MainActor
    private func finishLaunch(state: ShellState) async {
            let context = ShellSidebarView.Context(
                projectName: config.projectName ?? "No project",
                projectPath: config.projectDirectory,
                instanceLabel: config.instanceID.map { "instance · \($0)" }
                    ?? "development launch — no instance")
            let controller = WorkspaceShellWindowController(context: context, state: state)
            if launch.isLive {
                let workbench = LiveRunWorkbenchView(config: config)
                do {
                    liveRunControlGateway = LiveRunControlGateway(
                        client: try await ShellLiveStore(config: config).makeClient())
                } catch {
                    workbench.showControlUnavailable(error.localizedDescription)
                }
                controller.installLiveRunWorkbench(workbench)
                startLiveRunFeed(workbench: workbench)
                controller.memoryRecallHandler = { [weak self, weak controller] query in
                    guard let self else { return }
                    Task { @MainActor in
                        do {
                            let client = try await ShellLiveStore(config: self.config).makeClient()
                            let projection = try await MemoryRecallGateway(client: client)
                                .fetch(query: query)
                            controller?.apply {
                                let presented = MemoryScreenPresenter.recall(projection)
                                $0.apply(screen: MemoryScreenPresenter.retainingValue(
                                    from: $0.screens[.memoryRecallLab],
                                    on: presented), for: .memoryRecallLab)
                                if let preview = projection.value {
                                    $0.editMemory { $0.recall = preview }
                                }
                            }
                            controller?.showMemoryActionBanner(nil)
                        } catch MemoryRecallGateway.GatewayError
                            .refused(let status, let detail) {
                            let error = MemoryRecallGateway.GatewayError
                                .refused(status, detail)
                            controller?.showMemoryActionBanner(ShellBanner(
                                severity: .warning,
                                text: error.localizedDescription))
                        } catch {
                            controller?.apply {
                                $0.apply(screen: MemoryScreenPresenter.retainingValue(
                                    from: $0.screens[.memoryRecallLab],
                                    on: Self.lostScreen(error)), for: .memoryRecallLab)
                            }
                        }
                    }
                }
                controller.memoryLibraryPageHandler = {
                    [weak self, weak controller] step, filter in
                    guard let self else { return }
                    Task { @MainActor in
                        let store = ShellLiveStore(config: self.config)
                        do {
                            let client = try await store.makeClient()
                            let projection = await MemoryLibraryGateway(client: client)
                                .fetch(step: step, filter: filter)
                            controller?.apply {
                                let presented = MemoryScreenPresenter.library(projection)
                                $0.apply(screen: MemoryScreenPresenter.retainingValue(
                                    from: $0.screens[.memoryLibrary],
                                    on: presented), for: .memoryLibrary)
                                // A page that did not arrive leaves the walk where it
                                // was: the screen's availability already says the read
                                // failed, so replacing rows here would claim a page the
                                // daemon never served.
                                if let page = projection.value {
                                    $0.observe(
                                        libraryPage: page, from: store.project,
                                        step: step, filter: filter)
                                }
                            }
                        } catch {
                            controller?.apply {
                                $0.apply(screen: MemoryScreenPresenter.retainingValue(
                                    from: $0.screens[.memoryLibrary],
                                    on: Self.lostScreen(error)), for: .memoryLibrary)
                            }
                        }
                    }
                }
                controller.memoryJobHandler = { [weak self, weak controller] kind in
                    guard let self, let controller else { return }
                    Task { @MainActor in
                        do {
                            let client = try await ShellLiveStore(config: self.config).makeClient()
                            let result = try await MemoryMaintenanceGateway(client: client)
                                .submit(MemoryJobRequest(kind: kind))
                            controller.apply {
                                $0.apply(
                                    screen: MemoryScreenPresenter.maintenance(result.readBack),
                                    for: .memoryMaintenance)
                                $0.editMemory { $0.maintenance = result.readBack.value }
                            }
                            controller.showMemoryActionBanner(ShellBanner(
                                severity: .info,
                                text: "The daemon accepted \(kind.title.lowercased()) "
                                    + "as receipt \(result.receipt.id)."))
                        } catch MemoryMaintenanceGateway.GatewayError
                            .refused(let status, let detail) {
                            let error = MemoryMaintenanceGateway.GatewayError
                                .refused(status, detail)
                            controller.showMemoryActionBanner(ShellBanner(
                                severity: .warning,
                                text: error.localizedDescription))
                        } catch MemoryMaintenanceGateway.GatewayError
                            .postStateUnknown(let projection) {
                            controller.apply {
                                let presented = MemoryScreenPresenter.maintenance(projection)
                                $0.apply(screen: MemoryScreenPresenter.retainingValue(
                                    from: $0.screens[.memoryMaintenance],
                                    on: presented), for: .memoryMaintenance)
                                if let value = projection.value {
                                    $0.editMemory { $0.maintenance = value }
                                }
                            }
                            controller.showMemoryActionBanner(ShellBanner(
                                severity: .warning,
                                text: "The job may have started, but its queue could not be read back."))
                        } catch {
                            controller.apply {
                                $0.apply(screen: MemoryScreenPresenter.retainingValue(
                                    from: $0.screens[.memoryMaintenance],
                                    on: Self.lostScreen(error)), for: .memoryMaintenance)
                            }
                        }
                    }
                }
                controller.probeRefreshHandler = { [weak self, weak controller] in
                    guard let self, let controller else { return }
                    guard controller.beginProviderProbeRefresh() else { return }
                    Task { @MainActor in
                        do {
                            let refreshed = try await ShellLiveStore(config: self.config)
                                .refreshProviderProbes(previous: controller.currentState)
                            controller.apply { current in
                                Self.applyLiveRefresh(refreshed.state, to: &current)
                            }
                            if let failure = refreshed.failureSummary {
                                controller.finishProviderProbeRefresh(.failed(failure))
                            } else {
                                controller.finishProviderProbeRefresh(
                                    .succeeded(refreshed.successSummary))
                            }
                        } catch {
                            controller.finishProviderProbeRefresh(.failed(
                                error.localizedDescription))
                        }
                    }
                }
                controller.queenProviderSwapHandler = { [weak self, weak controller] in
                    guard let self else { return }
                    Task { @MainActor in
                        guard let controller,
                              let editor = controller.currentState.queenProvider,
                              let body = editor.body() else { return }
                        do {
                            let gateway = QueenProviderGateway(
                                client: try await ShellLiveStore(config: self.config).makeClient())
                            let result = try await gateway.submit(
                                body, intentID: UUID().uuidString)
                            controller.apply { current in
                                current.editQueenProvider { $0.apply(result) }
                                current.record(policyWriteRefusal: nil)
                            }
                        } catch let refusal as QueenProviderGateway.GatewayError {
                            controller.apply {
                                $0.record(policyWriteRefusal: refusal.localizedDescription)
                            }
                        } catch let error as WorkspaceDaemonClient.ResponseError {
                            controller.apply { current in
                                current.apply(screen: Self.screen(from: error), for: .queen)
                                current.editQueenProvider { $0.fence() }
                                current.record(policyWriteRefusal: error.localizedDescription)
                            }
                        } catch {
                            controller.apply { current in
                                current.apply(screen: Self.lostScreen(error), for: .queen)
                                current.editQueenProvider { $0.fence() }
                                current.record(
                                    policyWriteRefusal:
                                        "The Queen provider change was sent and may have been "
                                        + "applied, but the result could not be read back. "
                                        + "Refresh before changing it again.")
                            }
                        }
                    }
                }
                controller.policyWriteHandler = { [weak self, weak controller] write in
                    guard let self else { return }
                    Task { @MainActor in
                        guard let controller,
                              let editor = controller.currentState.router else { return }
                        do {
                            let result = try await self.send(write, editor: editor)
                            switch result.outcome {
                            case .accepted:
                                let refreshed = try await ShellLiveStore(config: self.config)
                                    .loadState(previous: controller.currentState)
                                controller.apply { current in
                                    Self.applyLiveRefresh(refreshed, to: &current)
                                    current.record(policyWriteRefusal: nil)
                                }
                            case .rejected:
                                controller.apply { current in
                                    current.editRouter { $0.apply(result) }
                                    current.record(policyWriteRefusal: nil)
                                }
                            }
                        } catch RoutingPolicyGateway.GatewayError.refused(let status) {
                            let refusal = RoutingPolicyGateway.GatewayError.refused(status)
                            controller.apply {
                                $0.record(policyWriteRefusal: refusal.localizedDescription)
                            }
                        } catch RoutingPolicyGateway.GatewayError
                            .postStateUnknown(let projection, let reason) {
                            controller.apply { current in
                                current.apply(
                                    screen: projection.frozenScreen(), for: .taskRouter)
                                current.editRouter { $0.fence() }
                                current.record(policyWriteRefusal: reason)
                            }
                        } catch let refusal as WriteRefused {
                            controller.apply {
                                $0.record(policyWriteRefusal: refusal.localizedDescription)
                            }
                        } catch {
                            controller.apply { current in
                                current.apply(screen: Self.lostScreen(error), for: .taskRouter)
                            }
                        }
                    }
                }
            }
            self.controller = controller
            NSApp.mainMenu = ShellMenuBuilder.build(target: controller)
            if launch.proofMode {
                await runProof(controller: controller, state: state)
            }
            controller.showWindow(nil)
            NSApp.activate(ignoringOtherApps: true)
            controller.window?.makeKeyAndOrderFront(nil)
            // Take the whole screen and stop drawing chrome, rather than going through toggleFullScreen. That call is asynchronous AND silently does nothing while another app is frontmost, so a screenshot run could not tell a window that was about to fill the screen from one that never would. Everything here is synchronous and true by the time this returns. The window stays titled so it still behaves like a window — it can take key, and it stays on screen — while the title bar is made transparent and empty, the traffic lights are hidden, and the toolbar is removed. What is left is content edge to edge: nothing that repaints when focus moves, which is what made captures disagree with each other.
            if launch.fullscreen, let window = controller.window,
               let screen = window.screen ?? NSScreen.main {
                window.toolbar = nil
                window.styleMask.insert(.fullSizeContentView)
                window.titlebarAppearsTransparent = true
                window.titleVisibility = .hidden
                for button: NSWindow.ButtonType in [
                    .closeButton, .miniaturizeButton, .zoomButton,
                ] {
                    window.standardWindowButton(button)?.isHidden = true
                }
                window.setFrame(screen.visibleFrame, display: true)
            }
    }

    @MainActor
    func startLiveRunFeed(workbench: LiveRunWorkbenchView) {
        guard let invocation = config.feedInvocation(
            workspaceSessionID: liveRunWorkspaceSessionID)
        else {
            workbench.showUnavailable(
                "Live Run requires the daemon port, instance identity, and Hive executable.")
            return
        }
        let feed = FeedClient(
            executable: invocation.executable,
            arguments: invocation.arguments,
            environment: invocation.environment)
        workbench.onVisibleSessionChanged = { [weak self, weak workbench] session in
            guard let self, let workbench else { return }
            publishVisibility(session, workbench: workbench)
            refreshLiveRunControls(session, workbench: workbench)
        }
        workbench.onControlRequested = { [weak self, weak workbench] operation, projection in
            guard let self, let workbench else { return }
            submitLiveRunControl(
                operation, projection: projection, workbench: workbench)
        }
        feed.onLine = { [weak workbench] line in
            do {
                workbench?.apply(try LiveRunProjection(feedLine: line))
            } catch {
                workbench?.showUnavailable(error.localizedDescription)
            }
        }
        feed.onMalformedLine = { [weak workbench] reason in
            workbench?.showUnavailable(reason)
        }
        feed.onExit = { [weak workbench] in
            workbench?.showUnavailable(
                "workspace-feed exited; every prior session status is now unknown.")
        }
        liveRunFeed = feed
        do {
            try feed.start()
            // Agent creation needs a live Workspace identity before the first terminal exists, so the initial full inventory is intentionally empty.
            publishVisibility(nil, workbench: workbench)
        } catch {
            workbench.showUnavailable(
                "workspace-feed could not start: \(error.localizedDescription)")
        }
    }

    @MainActor
    private func refreshLiveRunControls(
        _ session: LiveRunSessionSummary?,
        workbench: LiveRunWorkbenchView
    ) {
        let expectedLocator = session?.locator
        guard let agentID = session?.agentID else {
            workbench.showControlUnavailable(
                "No exact agent identity is available for process control.")
            return
        }
        guard let liveRunControlGateway else {
            workbench.showControlUnavailable(
                "The authenticated Live Run process-control gateway is unavailable.")
            return
        }
        Task { @MainActor [weak workbench] in
            let result = await liveRunControlGateway.fetch(agentID: agentID)
            guard let workbench else { return }
            guard workbench.selectedLocator == expectedLocator else { return }
            guard result.availability == .current, let projection = result.value else {
                workbench.showControlUnavailable(
                    "The daemon did not provide current process-control proof.")
                return
            }
            workbench.applyControlProjection(projection)
        }
    }

    @MainActor
    private func submitLiveRunControl(
        _ operation: LiveRunControlOperation,
        projection: LiveRunControlProjection,
        workbench: LiveRunWorkbenchView
    ) {
        guard let liveRunControlGateway else {
            workbench.showControlUnavailable(
                "The authenticated Live Run process-control gateway is unavailable.")
            return
        }
        Task { @MainActor [weak workbench] in
            do {
                let intentID = UUID().uuidString
                let result = try await liveRunControlGateway.submit(MutationIntent(
                    intentID: intentID,
                    expected: .epoch(String(projection.locator.generation)),
                    idempotencyKey: intentID,
                    body: try LiveRunControlBody(
                        operation: operation, projection: projection)))
                guard let workbench else { return }
                guard workbench.selectedLocator == projection.locator else { return }
                workbench.applyControlProjection(result.observedPostState)
                if case .rejected(let failure) = result.outcome {
                    workbench.showControlMessage(failure.message)
                }
            } catch {
                guard let workbench,
                      workbench.selectedLocator == projection.locator
                else { return }
                workbench.showControlUnavailable(error.localizedDescription)
            }
        }
    }

    @MainActor
    private func publishVisibility(
        _ session: LiveRunSessionSummary?,
        workbench: LiveRunWorkbenchView
    ) {
        guard let liveRunFeed else { return }
        liveRunInventoryRevision += 1
        let terminals: [WorkspaceVisibleTerminal]
        if let session, let agentID = session.agentID, let locator = session.locator {
            terminals = [WorkspaceVisibleTerminal(
                agentId: agentID,
                agentName: session.name,
                locator: locator,
                state: .attaching)]
        } else {
            terminals = []
        }
        do {
            try liveRunFeed.publishVisibility(WorkspaceVisibilityInventory(
                inventoryRevision: String(liveRunInventoryRevision),
                terminals: terminals))
        } catch {
            workbench.showUnavailable(
                "Workspace visibility could not be published: \(error.localizedDescription)")
        }
    }

    /// Sends one Model Control write over the routing wire. All three write shapes are routing-policy mutations against one revision, so they share the daemon's compare-and-set and its final read-back.
    private func send(
        _ write: ShellPolicyWrite,
        editor: TaskRouterEditor
    ) async throws -> MutationResult<RoutingPolicyDocument> {
        let gateway = RoutingPolicyGateway(
            client: try await ShellLiveStore(config: config).makeClient())
        let intentID = UUID().uuidString
        let revision = editor.observed.policy.revision
        switch write {
        case .route(let category):
            guard let intent = editor.mutation(for: category, intentID: intentID) else {
                throw WriteRefused.notCurrent
            }
            return try await gateway.submit(intent)
        case .provider(let provider, let enabled):
            return try await gateway.submit(MutationIntent(
                intentID: intentID,
                expected: .revision(String(revision)),
                idempotencyKey: intentID,
                body: ProviderEnablementMutationBody(
                    expectedRevision: revision,
                    provider: provider.rawValue,
                    enabled: enabled)))
        case .model(let provider, let model, let enabled):
            return try await gateway.submit(MutationIntent(
                intentID: intentID,
                expected: .revision(String(revision)),
                idempotencyKey: intentID,
                body: ModelEnablementMutationBody(
                    expectedRevision: revision,
                    provider: provider.rawValue,
                    model: model,
                    enabled: enabled)))
        }
    }

    private enum WriteRefused: LocalizedError {
        case notCurrent

        var errorDescription: String? {
            "The observed policy is not current, so nothing was sent."
        }
    }

    private static func lostScreen(_ error: Error) -> ShellScreenProjection {
        ShellScreenProjection(
            availability: .disconnected,
            freshness: .unknown,
            source: ProjectionSource(),
            observedAt: nil,
            evidence: .disconnected(transportLostAt: error.localizedDescription),
            contract: .frozen,
            facts: [])
    }

    static func screen(
        from error: WorkspaceDaemonClient.ResponseError
    ) -> ShellScreenProjection {
        ShellScreenProjection(
            availability: error.availability,
            freshness: .unknown,
            source: ProjectionSource(),
            observedAt: nil,
            evidence: error.evidence,
            contract: .frozen,
            facts: [])
    }

    static func applyLiveRefresh(_ refreshed: ShellState, to current: inout ShellState) {
        let failedRouteCategories = Set(
            (refreshed.inspector?.routeInspectionReads ?? []).compactMap { read in
                switch read.result {
                case .refused, .invalid:
                    return read.category
                case .projection(let projection):
                    return projection.value == nil ? read.category : nil
                }
            })
        let categories = refreshed.modelControlView?.routing.categories
            ?? current.modelControlView?.routing.categories ?? []
        for (route, screen) in refreshed.screens where route != .liveRun {
            let retained = MemoryScreenPresenter.retainingValue(
                from: current.screens[route], on: screen)
            let presented = route == .taskRouter && !failedRouteCategories.isEmpty
                ? retainingRouteCandidates(
                    from: current.screens[route],
                    on: retained,
                    failedCategories: failedRouteCategories,
                    categories: categories)
                : retained
            current.apply(screen: presented, for: route)
        }
        current.refresh(router: refreshed.router)
        current.refresh(queenProvider: refreshed.queenProvider)
        current.refresh(memory: refreshed.memory)
        current.apply(modelControl: refreshed.modelControlView)
        if let screen = refreshed.screens[.liveRun] {
            current.acceptOuterHorizon(
                screen: screen,
                snapshot: refreshed.outerHorizon?.snapshot,
                warning: refreshed.outerHorizonWarning)
        }
        current.refresh(inspector: refreshed.inspector)
    }

    private static func retainingRouteCandidates(
        from prior: ShellScreenProjection?,
        on refreshed: ShellScreenProjection,
        failedCategories: Set<String>,
        categories: [TaskCategory]
    ) -> ShellScreenProjection {
        guard let prior else { return refreshed }
        var priorCandidates: [String: [ShellScreenFact]] = [:]
        var category: String?
        for fact in prior.facts {
            if let match = categories.first(where: { $0.label == fact.label }) {
                category = match.rawValue
            } else if fact.label == "Candidate", let category {
                priorCandidates[category, default: []].append(fact)
            }
        }

        var facts: [ShellScreenFact] = []
        category = nil
        for fact in refreshed.facts {
            if let match = categories.first(where: { $0.label == fact.label }) {
                category = match.rawValue
                facts.append(fact)
                if failedCategories.contains(match.rawValue) {
                    facts.append(contentsOf: priorCandidates[match.rawValue] ?? [])
                }
            } else if fact.label == "Candidate",
                      let category,
                      failedCategories.contains(category) {
                continue
            } else {
                facts.append(fact)
            }
        }
        return ShellScreenProjection(
            availability: refreshed.availability,
            freshness: refreshed.freshness,
            source: refreshed.source,
            observedAt: refreshed.observedAt,
            evidence: refreshed.evidence,
            contract: refreshed.contract,
            facts: facts)
    }

    private func failLaunch(_ error: Error) {
        if launch.proofMode {
            print("SHELL-PROOF FAIL: \(error)")
            exit(1)
        }
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "The Workspace shell could not load its projection data"
        alert.informativeText = "\(error)"
        alert.runModal()
        NSApp.terminate(nil)
    }

    /// The measured launch line: one line, stable field order, values read from the built state and the laid-out window — never from the inputs.
    @MainActor
    private func runProof(
        controller: WorkspaceShellWindowController,
        state: ShellState
    ) async -> Never {
        controller.window?.layoutIfNeeded()
        // Only a declared screen whose projection is frozen counts. Counting any
        // frozen contract let an empty availability panel raise the score, which
        // made a hollow screen read as done.
        let wired = ShellScreenRegistry.screens.filter {
            state.screens[$0.route]?.contract == .frozen
        }.count
        // Active-screen banner kept for the existing proof greps. Live QA also needs every route's availability: activeRoute defaults to Live Run, which has no live endpoint and therefore never shows the false "disconnected" state that 404s raise on Task Router and siblings. Field name is availability-<route>, not banner-<route>, so a consumer cannot mistake the availability enum for rendered banner text.
        let banner = state.activeScreen?.banner != nil
            ? state.activeScreen?.availability.rawValue ?? "none"
            : "none"
        let drawer = state.attentionDrawerVisible ? "visible" : "hidden"
        // The authoritative screen list, emitted before the summary so a QA leg
        // consumes the registry rather than hardcoding slugs of its own.
        for screen in ShellScreenRegistry.proofLines { print(screen) }
        var line = "SHELL-PROOF routes=\(ShellRoute.allCases.count)"
            + " screens=\(ShellScreenRegistry.screens.count)"
            + " wired=\(wired)"
            + " scenario=\(launch.scenario.rawValue)"
            + " active=\(state.activeRoute.rawValue)"
            + " nav=\(controller.navButtonCount)"
            + " drawer=\(drawer)"
            + " banner=\(banner)"
        for route in ShellRoute.allCases {
            let availability = state.screens[route]?.availability.rawValue ?? "missing"
            line += " availability-\(route.rawValue)=\(availability)"
        }
        if launch.isLive,
           let policy = state.screens[.taskRouter]?.facts.first(where: {
               $0.label == "Policy"
           })?.value {
            line += " router=\(policy.replacingOccurrences(of: " ", with: "-"))"
        }
        if launch.isLive,
           let library = state.screens[.memoryLibrary]?.facts.first(where: {
               $0.label == "Library store"
           })?.value {
            line += " memory-library="
                + library.replacingOccurrences(of: " ", with: "-")
        }
        if let action = launch.proofMutation, launch.isLive {
            line += " \(await proveOneWrite(state: state, clearing: action == "clear"))"
        }
        print(line)
        // Printed last, and only here: a consumer that requires this line cannot
        // read success out of a run that died part-way through.
        print(ShellScreenRegistry.proofTerminator)
        exit(0)
    }

    /// One real write through the same path the Apply control uses, so the printed revisions are the daemon's own read-back rather than this process's belief about what it sent. Setting and clearing a category encode differently — a cleared route is an explicit null the wire requires — so the caller proves one per run.
    private func proveOneWrite(state: ShellState, clearing: Bool) async -> String {
        guard var editor = state.router else { return "mutation=no-observed-policy" }
        guard let category = state.modelControlView?.routing.categories.first(where: {
            $0.rawValue == "default"
        }) else { return "mutation=no-routing-category" }
        let route: RoutingPolicyDocument.WireRoute?
        if clearing {
            route = nil
        } else {
            guard let global = editor.observed.policy.global else {
                return "mutation=no-observed-route"
            }
            route = global
        }
        let before = editor.observed.policy.revision
        editor.setRoute(route, for: category)
        do {
            editor.apply(try await send(.route(category), editor: editor))
            let outcome = editor.competingRevision == nil ? "accepted" : "rejected"
            let configured = editor.observed.policy
                .categories[category.rawValue] != nil
            return "mutation=\(outcome) before=\(before)"
                + " after=\(editor.observed.policy.revision)"
                + " configured=\(configured)"
        } catch {
            return "mutation=failed(\(error))".replacingOccurrences(of: " ", with: "-")
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(
        _ sender: NSApplication
    ) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller?.detachLiveRunViewer()
        liveRunFeed?.stop()
        liveRunFeed = nil
    }

    /// Detach semantics: quitting the shell never stops the daemon or any session. Contrast with the pane era, whose quit drives `hive stop`.
    func applicationShouldTerminate(
        _ sender: NSApplication
    ) -> NSApplication.TerminateReply {
        .terminateNow
    }
}
