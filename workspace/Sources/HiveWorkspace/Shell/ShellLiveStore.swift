// ShellLiveStore.swift Builds the same shell state as the fixture store from authenticated daemon reads. Live mode is selected explicitly and never consults fixture files.

import Foundation
import WorkspaceCore

struct ProviderProbeRefreshReport: Codable, Equatable, Sendable {
    enum Status: String, Codable, Equatable, Sendable {
        case ok
        case unavailable
        case skipped
        case rateLimited = "rate-limited"
    }

    enum Delivery: String, Codable, Equatable, Sendable {
        case started
        case queued
        case coalesced
        case rateLimited = "rate-limited"
    }

    let provider: String
    let status: Status
    let pools: Int
    let reason: String?
    let observedAt: String?
    let startedAt: String?
    let completedAt: String?
    let retryAt: String?
    let delivery: Delivery?
}

struct ShellProviderProbeRefreshResult {
    let state: ShellState
    let reports: [ProviderProbeRefreshReport]

    var failureSummary: String? {
        if reports.isEmpty {
            return "The daemon returned no provider probe results."
        }
        let failures = reports.compactMap { report -> String? in
            switch report.status {
            case .ok:
                return nil
            case .unavailable:
                return "\(report.provider) at \(evidenceTime(report)): "
                    + (report.reason ?? "probe unavailable")
            case .skipped:
                return "\(report.provider): probe was skipped"
            case .rateLimited:
                return "\(report.provider): \(report.reason ?? "probe was rate-limited")"
                    + (report.retryAt.map { "; retry at \($0)" } ?? "")
            }
        }
        return failures.isEmpty ? nil : failures.joined(separator: "; ")
    }

    var successSummary: String {
        let providers = reports.filter { $0.status == .ok }.map(\.provider)
        let completedAt = reports.filter { $0.status == .ok }
            .map { evidenceTime($0) }.max() ?? "unknown time"
        let coordination = reports.compactMap { report -> String? in
            switch report.delivery {
            case .queued:
                return "\(report.provider) queued behind an earlier probe."
            case .coalesced:
                return "\(report.provider) shared a queued probe."
            case .rateLimited:
                return "\(report.provider) was rate-limited."
            case .started, nil:
                return nil
            }
        }
        return "Provider probes completed at \(completedAt): "
            + "\(providers.joined(separator: ", "))."
            + (coordination.isEmpty ? "" : " \(coordination.joined(separator: " "))")
    }

    private func evidenceTime(_ report: ProviderProbeRefreshReport) -> String {
        report.observedAt ?? report.completedAt ?? "unknown time"
    }
}

private struct ProviderProbeRefreshRequest: Encodable {}

struct ShellLiveStore {
    let config: LaunchConfig

    enum LiveError: LocalizedError {
        case incompleteLaunch
        case credential(String)
        case probeRefused(status: Int, detail: String)

        var errorDescription: String? {
            switch self {
            case .incompleteLaunch:
                return "Live shell mode requires --port, --hive, and --instance-home."
            case .credential(let detail):
                return "Could not obtain the user credential: \(detail)"
            case .probeRefused(let status, let detail):
                return "The daemon refused the provider probe refresh (HTTP \(status)): \(detail)"
            }
        }
    }

    /// The authenticated client every live read and write goes through. The user credential comes from the helper subprocess; nothing else in the shell talks to the daemon.
    func makeClient() async throws -> WorkspaceDaemonClient {
        guard let port = config.port, let hivePath = config.hivePath,
              let instanceHome = config.instanceHome else {
            throw LiveError.incompleteLaunch
        }
        let authorization = try await Task.detached {
            try Self.userAuthorization(hivePath: hivePath, instanceHome: instanceHome)
        }.value
        return WorkspaceDaemonClient(
            baseURL: URL(string: "http://127.0.0.1:\(port)")!,
            authorization: authorization)
    }

    func loadState(previous: ShellState? = nil) async throws -> ShellState {
        let client = try await makeClient()
        return await loadState(client: client, previous: previous)
    }

    func refreshProviderProbes(
        previous: ShellState? = nil
    ) async throws -> ShellProviderProbeRefreshResult {
        let client = try await makeClient()
        return try await refreshProviderProbes(client: client, previous: previous)
    }

    func refreshProviderProbes(
        client: WorkspaceDaemonClient,
        previous: ShellState? = nil
    ) async throws -> ShellProviderProbeRefreshResult {
        let (data, response) = try await client.send(
            path: "model-control/probe-refresh",
            method: "POST",
            body: ProviderProbeRefreshRequest())
        guard (200..<300).contains(response.statusCode) else {
            let refusal = RefusalBody(data: data)
            throw LiveError.probeRefused(
                status: response.statusCode, detail: refusal.detail)
        }
        let reports = try client.decode(
            [ProviderProbeRefreshReport].self, from: data)
        let state = await loadState(client: client, previous: previous)
        return ShellProviderProbeRefreshResult(state: state, reports: reports)
    }

    /// Loads endpoints independently. A refusal from one screen is rendered on that screen and never aborts the shell or reclassifies a sibling.
    func loadState(
        client: WorkspaceDaemonClient,
        previous: ShellState? = nil
    ) async -> ShellState {
        var state = ShellState()

        let outerHorizon = await OuterHorizonGateway(client: client)
            .fetch(previous: previous)
        state.acceptOuterHorizon(
            screen: outerHorizon.screen,
            snapshot: outerHorizon.snapshot,
            warning: outerHorizon.warning)

        let modelControl = await client.fetch(ModelControlDataSource.read)
        let policy = modelControl.map { $0.routing.policy }
        let categories = modelControl.value?.routing.categories ?? []
        var inspections: [RouteInspection] = []
        var inspectorRouteReads: [InspectorRouteInspectionRead] = []
        for category in categories {
            let result = await client.fetchResult(WorkspaceReadEndpoint<RouteInspection>(
                path: "routing/inspect",
                queryItems: [URLQueryItem(name: "category", value: category.rawValue)],
                source: { ProjectionSource(revision: String($0.policyRevision)) },
                observedAt: { $0.inspectedAt }))
            switch result {
            case .projection(let projection):
                if let value = projection.value,
                   value.category != category.rawValue {
                    inspectorRouteReads.append(InspectorRouteInspectionRead(
                        category: category.rawValue,
                        result: .invalid(detail:
                            "requested \(category.rawValue), received \(value.category)")))
                } else {
                    if let value = projection.value { inspections.append(value) }
                    inspectorRouteReads.append(InspectorRouteInspectionRead(
                        category: category.rawValue,
                        result: .projection(projection)))
                }
            case .refused(let status, let code, let detail):
                inspectorRouteReads.append(InspectorRouteInspectionRead(
                    category: category.rawValue,
                    result: .refused(
                        detail: "HTTP \(status) · \(code.displayValue) · \(detail)")))
            case .invalid(let detail):
                inspectorRouteReads.append(InspectorRouteInspectionRead(
                    category: category.rawValue,
                    result: .invalid(detail: detail)))
            }
        }
        state.apply(
            screen: policy.frozenScreen(
                facts: routerFacts(policy.value?.revision, categories, inspections)),
            for: .taskRouter)
        if let document = policy.value {
            state.apply(router: TaskRouterEditor(
                snapshot: TaskRouterSnapshot(policy: document),
                availability: policy.availability))
        }

        state.apply(
            screen: modelControl.frozenScreen(facts: modelFacts(modelControl.value)),
            for: .modelsQuota)
        state.apply(modelControl: modelControl.value)

        let queenProvider = await QueenProviderGateway(client: client).fetch()
        state.apply(
            screen: queenProvider.frozenScreen(facts: queenProvider.value?.facts ?? []),
            for: .queen)
        if let projection = queenProvider.value {
            state.apply(queenProvider: QueenProviderEditor(
                projection: projection, availability: queenProvider.availability))
        }

        let memoryOverview = await MemoryOverviewGateway(client: client).fetch()
        state.apply(
            screen: MemoryScreenPresenter.overview(memoryOverview),
            for: .memoryOverview)
        let memoryLibrary = await MemoryLibraryGateway(client: client).fetch()
        state.apply(
            screen: MemoryScreenPresenter.library(memoryLibrary),
            for: .memoryLibrary)
        do {
            let memoryRecall = try await MemoryRecallGateway(client: client)
                .fetch(query: "memory")
            state.apply(
                screen: MemoryScreenPresenter.recall(memoryRecall),
                for: .memoryRecallLab)
        } catch MemoryRecallGateway.GatewayError.refused(let status, let detail) {
            state.apply(
                screen: MemoryScreenPresenter.recallRefusal(
                    status: status, detail: detail),
                for: .memoryRecallLab)
        } catch {
            state.apply(
                screen: MemoryScreenPresenter.recallRefusal(
                    status: nil, detail: error.localizedDescription),
                for: .memoryRecallLab)
        }
        let memoryMaintenance = await MemoryMaintenanceGateway(client: client).fetch()
        state.apply(
            screen: MemoryScreenPresenter.maintenance(memoryMaintenance),
            for: .memoryMaintenance)

        state.apply(inspector: ShellInspectorPresenter.present(
            ShellInspectorPresenter.Inputs(
                snapshotAvailability: .unknown,
                routeInspectionReads: inspectorRouteReads,
                eventsAvailability: .unknown,
                contractsAvailability: .unknown,
                criteriaAvailability: .unknown)))

        for route in ShellRoute.allCases where state.screens[route] == nil {
            state.apply(screen: .notFrozen(
                "This live screen has no projection endpoint in this build."), for: route)
        }
        return state
    }

    private func routerFacts(
        _ policyRevision: Int?,
        _ categories: [TaskCategory],
        _ inspections: [RouteInspection]
    ) -> [ShellScreenFact] {
        guard let policyRevision else { return [] }
        var facts = [ShellScreenFact(
            label: "Policy", value: "revision \(policyRevision)")]
        for category in categories {
            guard let inspection = inspections.first(where: {
                $0.category == category.rawValue
            }) else {
                facts.append(ShellScreenFact(
                    label: category.label,
                    value: "routing inspection unavailable"))
                continue
            }
            let routeSummary: String
            if let refusal = inspection.refusal {
                switch refusal {
                case .neverConfigured(let detail), .noCandidate(let detail):
                    routeSummary = detail
                }
            } else {
                routeSummary = "\(inspection.mode ?? "unknown") · "
                    + "\(inspection.candidates.count) candidates · "
                    + "scope \(inspection.scope ?? "unknown")"
            }
            facts.append(ShellScreenFact(
                label: category.label,
                value: routeSummary))
            for candidate in inspection.candidates {
                var value = "\(candidate.candidate.provider)/\(candidate.candidate.model)"
                    + " · weight \(candidate.candidate.weight)"
                    + " · configured \(Self.percent(candidate.configuredShare))"
                    + " · live \(Self.percent(candidate.liveShare))"
                if let refusal = candidate.refusal {
                    value += " · \(refusal.gate): \(refusal.detail)"
                }
                facts.append(ShellScreenFact(label: "Candidate", value: value))
            }
        }
        return facts
    }

    private func modelFacts(
        _ view: WorkspaceModelControlView?
    ) -> [ShellScreenFact] {
        guard let view else { return [] }
        var facts = [ShellScreenFact(label: "Generated", value: view.observedAt)]
        for provider in view.providerIDs {
            let state = view.routing.providerState(provider) ?? "policy unavailable"
            facts.append(ShellScreenFact(
                label: provider.rawValue,
                value: "enablement \(state) · explicit probe result present"))
            guard let presentation = view.provider(provider) else { continue }
            switch presentation.usage {
            case .metered(let windows):
                for window in windows {
                    facts.append(ShellScreenFact(
                        label: "\(provider.rawValue) \(window.label)",
                        value: Self.meter(window.meter)))
                }
            case .silent(let reason), .unknown(let reason):
                facts.append(ShellScreenFact(
                    label: "\(provider.rawValue) usage", value: reason))
            case .unmetered:
                facts.append(ShellScreenFact(
                    label: "\(provider.rawValue) usage", value: "not metered"))
            }
        }
        return facts
    }

    private static func meter(_ meter: WorkspaceMeterState) -> String {
        switch meter {
        case .measured(let used, let resetsAt, let observedAt, let confidence):
            return "\(Int(used.rounded()))% used · \(confidence)"
                + " · observed \(observedAt ?? "unknown")"
                + " · reset \(resetsAt ?? "unknown")"
        case .stale(let used, let resetsAt, let observedAt):
            return "\(Int(used.rounded()))% used · stale"
                + " · observed \(observedAt ?? "unknown")"
                + " · reset \(resetsAt ?? "unknown")"
        case .unknown(let reason):
            return "unknown · \(reason)"
        case .notMetered:
            return "not metered"
        }
    }

    private static func percent(_ value: Double) -> String {
        "\(Int((value * 100).rounded()))%"
    }

    static func userAuthorization(
        hivePath: String,
        instanceHome: String
    ) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: hivePath)
        process.arguments = ["credential", "--agent", "user"]
        var environment = ProcessInfo.processInfo.environment
        environment["HIVE_HOME"] = instanceHome
        process.environment = environment
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        let error = stderr.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let authorization = object["Authorization"] else {
            throw LiveError.credential(
                String(data: error, encoding: .utf8) ?? "credential helper failed")
        }
        return authorization
    }
}
