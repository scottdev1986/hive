import AppKit
import WorkspaceCore

/// The Model Control Center's data layer. Reads and writes are authenticated daemon contracts. A missing policy is unavailable, never a client-seeded substitute, and controls update only from the daemon's returned post-state. Writes are serialized so each compare-and-set uses the revision returned by the preceding write. Threading contract: daemon HTTP is asynchronous, credential acquisition never runs on main, and observers always fire on main.
final class ModelControlDataSource {

    enum LoadState {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    enum PolicyBackend {
        case daemon(RoutingPolicyDocument)
    }

    private(set) var view: WorkspaceModelControlView?
    private(set) var snapshot: ModelControlSnapshot?
    private(set) var backend: PolicyBackend?
    private(set) var loadState: LoadState = .idle
    private(set) var lastRefreshed: Date?
    /// The last policy write failure, shown until a write succeeds or a refresh lands. A money-adjacent toggle must never fail silently.
    private(set) var policyWriteError: String?

    private struct EffortMutationBody: Codable, Equatable, Sendable {
        let op: String
        let expectedRevision: Int
        let provider: String
        let model: String
        let effort: RoutingPolicyDocument.WireEffort

        init(
            expectedRevision: Int, provider: String, model: String,
            effort: RoutingPolicyDocument.WireEffort
        ) {
            op = "set-effort"
            self.expectedRevision = expectedRevision
            self.provider = provider
            self.model = model
            self.effort = effort
        }
    }

    private enum PolicyWrite {
        case provider(String, Bool)
        case model(String, String, Bool)
        case effort(String, String, RoutingPolicyDocument.WireEffort)
        case route(String, RoutingPolicyDocument.WireRoute?)

        func submit(
            client: WorkspaceDaemonClient,
            expectedRevision: Int
        ) async throws -> MutationResult<RoutingPolicyDocument> {
            let intentID = UUID().uuidString
            let expected = MutationExpectation.revision(String(expectedRevision))
            let gateway = RoutingPolicyGateway(client: client)
            switch self {
            case .provider(let provider, let enabled):
                return try await gateway.submit(MutationIntent(
                    intentID: intentID, expected: expected,
                    idempotencyKey: intentID,
                    body: ProviderEnablementMutationBody(
                        expectedRevision: expectedRevision,
                        provider: provider, enabled: enabled)))
            case .model(let provider, let model, let enabled):
                return try await gateway.submit(MutationIntent(
                    intentID: intentID, expected: expected,
                    idempotencyKey: intentID,
                    body: ModelEnablementMutationBody(
                        expectedRevision: expectedRevision,
                        provider: provider, model: model, enabled: enabled)))
            case .effort(let provider, let model, let effort):
                return try await gateway.submit(MutationIntent(
                    intentID: intentID, expected: expected,
                    idempotencyKey: intentID,
                    body: EffortMutationBody(
                        expectedRevision: expectedRevision,
                        provider: provider, model: model, effort: effort)))
            case .route(let scope, let route):
                return try await gateway.submit(MutationIntent(
                    intentID: intentID, expected: expected,
                    idempotencyKey: intentID,
                    body: RoutingPolicyMutationBody(
                        expectedRevision: expectedRevision,
                        scope: scope, route: route)))
            }
        }
    }

    private var observers: [() -> Void] = []
    private let makeDaemonClient: (() async throws -> WorkspaceDaemonClient)?
    private var daemonClient: WorkspaceDaemonClient?
    private var refreshing = false
    private var pendingWrites = 0
    private var daemonPersistTail: Task<Void, Never>?

    static let read = WorkspaceReadEndpoint<WorkspaceModelControlView>(
        path: "model-control/snapshot",
        source: { ProjectionSource(revision: String($0.routing.policy.revision)) },
        observedAt: { $0.observedAt })

    init(
        hivePath: String?, daemonPort: Int?, instanceHome: String? = nil,
        makeDaemonClient: (() async throws -> WorkspaceDaemonClient)? = nil
    ) {
        if let makeDaemonClient {
            self.makeDaemonClient = makeDaemonClient
        } else if let hivePath, let daemonPort, let instanceHome {
            self.makeDaemonClient = {
                let authorization = try await Task.detached {
                    try ShellLiveStore.userAuthorization(
                        hivePath: hivePath, instanceHome: instanceHome)
                }.value
                return WorkspaceDaemonClient(
                    baseURL: URL(string: "http://127.0.0.1:\(daemonPort)")!,
                    authorization: authorization)
            }
        } else {
            self.makeDaemonClient = nil
        }
    }

    func addObserver(_ handler: @escaping () -> Void) {
        observers.append(handler)
    }

    private func notify() {
        for observer in observers { observer() }
    }

    var policyLoaded: Bool { backend != nil }

    var categories: [TaskCategory] { view?.routing.categories ?? [] }

    var providerIDs: [ProviderID] { view?.providerIDs ?? [] }

    var routingCatalog: [WorkspaceRoutingCatalogEntry] {
        view?.routing.catalog ?? []
    }

    var routingModes: [WorkspaceRoutingModePresentation] {
        view?.routing.modes ?? []
    }

    var defaultRoutingMode: RouterMode? {
        view.flatMap { RouterMode(rawValue: $0.routing.defaultMode) }
    }

    var routingWeightRange: WorkspaceRoutingWeightRange? {
        view?.routing.weightRange
    }

    func routingMode(_ mode: RouterMode) -> WorkspaceRoutingModePresentation? {
        view?.routing.mode(mode.rawValue)
    }

    var isProvisional: Bool {
        switch backend {
        case .daemon(let document): return document.provisional
        case nil: return false
        }
    }

    func providerMasterOn(_ provider: ProviderID) -> Bool {
        view?.routing.providerState(provider) == "enabled"
    }

    /// False when the provider has no explicit row at all — off by default, awaiting consent, rendered as an invitation rather than a shutdown.
    func providerConfigured(_ provider: ProviderID) -> Bool {
        guard let state = view?.routing.providerState(provider) else { return false }
        return state != "unconfigured"
    }

    func rowState(provider: ProviderID, model: String) -> ModelRowState {
        view?.routing.modelState(provider: provider, model: model)?.rendered
            ?? .unavailable
    }

    func effortSelection(provider: ProviderID, model: String) -> EffortTarget? {
        switch backend {
        case .daemon(let document):
            return document.modelEffort(provider: provider, model: model)
        case nil:
            return nil
        }
    }

    private func wireRoute(_ category: TaskCategory?) -> RoutingPolicyDocument.WireRoute? {
        guard case .daemon(let document) = backend else { return nil }
        if let category { return document.categories[category.rawValue] }
        return document.global
    }

    /// nil category = the global route. nil = the scope is unconfigured, or (daemon backend) carries a router mode this build cannot name — see `routeUnreadableReason`.
    func route(_ category: TaskCategory?) -> RoutePolicy? {
        switch backend {
        case .daemon: return wireRoute(category)?.asRoutePolicy
        case nil:
            return nil
        }
    }

    /// Non-nil when a stored route exists that this build cannot read or rewrite (a newer daemon's router mode or effort mode). The editor shows the reason instead of controls whose writes would respell it.
    func routeUnreadableReason(_ category: TaskCategory?) -> String? {
        guard let wire = wireRoute(category), !wire.writable else { return nil }
        return MCCCopy.routeUnreadable
    }

    func candidateStatus(_ candidate: RouteCandidate) -> RouteCandidateStatus {
        view?.routing.candidates.first {
            $0.provider == candidate.provider && $0.model == candidate.model
        }?.rendered ?? .unresolvable
    }

    /// Whether a scope's route has its own configuration (rather than resolving to global). Distinct from `route(_:) != nil` so an unreadable stored route never masquerades as an unconfigured one.
    private func routeConfigured(_ category: TaskCategory?) -> Bool {
        switch backend {
        case .daemon: return wireRoute(category) != nil
        case nil:
            return false
        }
    }

    var warnings: [PolicyWarning] {
        view?.routing.renderedWarnings ?? []
    }

    func providerPresentation(_ provider: ProviderID) -> WorkspaceProviderPresentation? {
        view?.provider(provider)
    }

    func setProviderEnabled(_ provider: ProviderID, _ enabled: Bool) {
        enqueuePersist(.provider(provider.rawValue, enabled))
    }

    func setModelEnabled(provider: ProviderID, model: String, _ enabled: Bool) {
        enqueuePersist(.model(provider.rawValue, model, enabled))
    }

    func setEffort(provider: ProviderID, model: String, _ effort: EffortTarget) {
        let wire = RoutingPolicyDocument.WireEffort(effort)
        enqueuePersist(.effort(provider.rawValue, model, wire))
    }

    func setRoute(_ category: TaskCategory?, _ route: RoutePolicy?) {
        let route = route?.candidates.isEmpty == true ? nil : route
        // A stored route this build cannot fully spell must not be rewritten: respelling one candidate's effort is a routing change the user never made. Refuse the whole write and say so.
        guard wireRoute(category)?.writable != false else {
            policyWriteError = MCCCopy.routeUnreadable + " Nothing was changed."
            notify()
            return
        }
        let wire = route.map(RoutingPolicyDocument.WireRoute.init)
        let scope = category?.rawValue ?? "global"
        enqueuePersist(.route(scope, wire))
    }

    private func enqueuePersist(_ write: PolicyWrite) {
        guard let daemonClient else {
            policyWriteError = "A change could not be saved: the daemon connection is unavailable."
            notify()
            return
        }
        enqueueDaemonPersist(write, client: daemonClient)
    }

    private func enqueueDaemonPersist(
        _ write: PolicyWrite,
        client: WorkspaceDaemonClient
    ) {
        pendingWrites += 1
        let preceding = daemonPersistTail
        daemonPersistTail = Task { @MainActor [weak self] in
            await preceding?.value
            guard let self else { return }
            let revision: Int
            if case .daemon(let document) = self.backend {
                revision = document.revision
            } else {
                self.pendingWrites -= 1
                return
            }
            do {
                let result = try await write.submit(
                    client: client, expectedRevision: revision)
                if case .rejected(let failure) = result.outcome {
                    throw CommandError(message: failure.message)
                }
                let readBack = await client.fetch(Self.read)
                guard let view = readBack.value,
                      view.routing.policy.revision == result.observedPostState.revision else {
                    throw CommandError(
                        message: "the daemon did not return the matching Model Control view")
                }
                self.pendingWrites -= 1
                self.apply(view: view)
                self.policyWriteError = nil
                self.notify()
            } catch {
                self.pendingWrites -= 1
                self.policyWriteError =
                    "A change could not be saved: \(error.localizedDescription) — reloaded the stored policy."
                self.refresh()
            }
        }
    }

    func refresh() {
        guard !refreshing else { return }
        guard let makeDaemonClient else {
            loadState = .failed(
                "The Workspace has no authenticated daemon connection. " +
                "Open it via `hive` from a project directory to see live data.")
            notify()
            return
        }
        refreshFromDaemon(makeClient: makeDaemonClient)
    }

    private func refreshFromDaemon(
        makeClient: @escaping () async throws -> WorkspaceDaemonClient
    ) {
        refreshing = true
        loadState = .loading
        notify()

        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let client = try await makeClient()
                self.daemonClient = client
                let snapshotResult = await client.fetchResult(Self.read)
                self.refreshing = false
                switch snapshotResult {
                case .projection(let projection):
                    guard let view = projection.value else {
                        self.loadState = .failed(
                            "The daemon did not provide model-control data (\(projection.availability.rawValue)).")
                        self.notify()
                        return
                    }
                    if self.pendingWrites == 0 { self.apply(view: view) }
                case .refused(let status, _, let detail):
                    self.loadState = .failed(
                        "The daemon refused model-control data (HTTP \(status)): \(detail)")
                case .invalid(let detail):
                    self.loadState = .failed(
                        "Could not decode the daemon's model-control data: \(detail)")
                }
                self.notify()
            } catch {
                self.refreshing = false
                self.loadState = .failed(error.localizedDescription)
                self.notify()
            }
        }
    }

    private func apply(view: WorkspaceModelControlView) {
        self.view = view
        snapshot = view.snapshot
        self.lastRefreshed = Date()
        self.loadState = .loaded
        backend = .daemon(view.routing.policy)
    }

    private struct CommandError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
}
