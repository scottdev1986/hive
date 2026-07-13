import AppKit
import WorkspaceCore

/// The Model Control Center's data layer.
///
/// READS: two subprocesses per refresh, in parallel on a background queue —
/// `hive model-control-snapshot` (capabilities, billing, quota; always real)
/// and `hive routing export` (the daemon's policy document). When the policy
/// store answers, IT is the backend: every toggle persists through the
/// daemon's CAS contract. When it cannot (a daemon that predates the store),
/// the backend falls back to the loudly-labeled in-memory provisional policy
/// and the UI says so — changes then do not persist, and nothing pretends
/// they do.
///
/// WRITES: consent-is-enablement makes these financial controls, so they are
/// instant AND durable: the local document mutates immediately (the click
/// registers now), and a serialized queue persists each mutation via
/// `hive routing set-*` with the revision we hold. Every success returns the
/// full updated document; a rejected (stale) write triggers a reload and a
/// visible notice instead of a silent merge.
///
/// Threading contract, non-negotiable: subprocesses run on background queues
/// only (`dispatchPrecondition` guards them); observers fire on main.
final class ModelControlDataSource {

    enum LoadState {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    enum PolicyBackend {
        case daemon(RoutingPolicyDocument)
        /// PLACEHOLDER — in-memory only. `reason` is the measured explanation
        /// (usually: the running daemon predates the policy store).
        case placeholder(ModelControlPolicy, reason: String)
    }

    private(set) var snapshot: ModelControlSnapshot?
    private(set) var backend: PolicyBackend?
    private(set) var loadState: LoadState = .idle
    private(set) var lastRefreshed: Date?
    /// The last policy write failure, shown until a write succeeds or a
    /// refresh lands. A money-adjacent toggle must never fail silently.
    private(set) var policyWriteError: String?

    private var observers: [() -> Void] = []
    private let hivePath: String?
    private let daemonPort: Int?
    private let workQueue = DispatchQueue(
        label: "dev.hive.workspace.model-control", qos: .userInitiated)
    /// Writes persist strictly in order; each uses the revision produced by
    /// the one before it.
    private let persistQueue = DispatchQueue(
        label: "dev.hive.workspace.model-control.persist", qos: .userInitiated)
    private var refreshing = false
    private var pendingWrites = 0

    init(hivePath: String?, daemonPort: Int?) {
        self.hivePath = hivePath
        self.daemonPort = daemonPort
    }

    func addObserver(_ handler: @escaping () -> Void) {
        observers.append(handler)
    }

    private func notify() {
        for observer in observers { observer() }
    }

    // MARK: Facade reads (one honest surface over both backends)

    var policyLoaded: Bool { backend != nil }

    var isProvisional: Bool {
        switch backend {
        case .daemon(let document): return document.provisional
        case .placeholder(let policy, _): return policy.provisional
        case nil: return false
        }
    }

    /// Non-nil when changes cannot persist — the UI banners it.
    var placeholderReason: String? {
        if case .placeholder(_, let reason) = backend { return reason }
        return nil
    }

    func providerMasterOn(_ provider: ProviderID) -> Bool {
        switch backend {
        case .daemon(let document):
            return document.providerState(provider) == .enabled
        case .placeholder(let policy, _):
            return policy.providerEnabled(provider)
        case nil:
            return false
        }
    }

    /// False when the provider has no explicit row at all — off by default,
    /// awaiting consent, rendered as an invitation rather than a shutdown.
    func providerConfigured(_ provider: ProviderID) -> Bool {
        switch backend {
        case .daemon(let document):
            return document.providerState(provider) != .unconfigured
        case .placeholder, nil:
            return true
        }
    }

    func rowState(provider: ProviderID, model: String, available: Bool) -> ModelRowState {
        switch backend {
        case .daemon(let document):
            return document.rowState(provider: provider, model: model, available: available)
        case .placeholder(let policy, _):
            return policy.rowState(provider: provider, modelId: model, available: available)
        case nil:
            return .unavailable
        }
    }

    /// The user's standing effort choice; nil = not chosen yet. There is no
    /// "vendor decides" value — an unchosen effort renders as unchosen.
    func effortSelection(provider: ProviderID, model: String) -> EffortTarget? {
        switch backend {
        case .daemon(let document):
            return document.modelEffort(provider: provider, model: model)
        case .placeholder(let policy, _):
            let effort = policy.modelPolicy(provider: provider, modelId: model).effort
            if case .providerControlled = effort { return nil }
            return effort
        case nil:
            return nil
        }
    }

    /// nil category = the global fallback chain.
    func chainEntries(_ category: TaskCategory?) -> [ChainEntry] {
        switch backend {
        case .daemon(let document):
            let wire = category.map { document.chain(for: $0) } ?? document.defaultChain
            return wire.map {
                ChainEntry(provider: $0.provider, model: $0.model,
                           effort: $0.effort.asEffortTarget)
            }
        case .placeholder(let policy, _):
            return category.map { policy.categoryPolicy($0).chain } ?? policy.defaultChain
        case nil:
            return []
        }
    }

    func linkStatus(_ entry: ChainEntry) -> ChainLinkStatus {
        let resolved: Bool
        if case .available(let models, _)? = snapshot?.providers[entry.provider] {
            resolved = models.contains { $0.canonicalId == entry.model }
        } else {
            resolved = false
        }
        return ChainLinkStatus.derive(
            rowState: rowState(
                provider: ProviderID(entry.provider), model: entry.model,
                available: resolved),
            resolvedInCatalog: resolved)
    }

    var globalSelection: SelectionMode? {
        switch backend {
        case .daemon(let document): return document.globalSelection
        case .placeholder(let policy, _): return policy.globalSelection
        case nil: return nil
        }
    }

    func selectionOverride(_ category: TaskCategory) -> SelectionMode? {
        switch backend {
        case .daemon(let document): return document.selectionOverride(for: category)
        case .placeholder(let policy, _): return policy.categoryPolicy(category).selectionOverride
        case nil: return nil
        }
    }

    func effectiveSelection(_ category: TaskCategory) -> SelectionMode? {
        selectionOverride(category) ?? globalSelection
    }

    /// Whether the backend can PERSIST selection modes. A daemon that never
    /// sent the field — or one speaking a selection vocabulary this build
    /// cannot write — would reject the mutation, so the control disables with
    /// a reason instead of failing on every use.
    var canEditSelection: Bool {
        switch backend {
        case .daemon(let document): return document.selectionWritable
        case .placeholder: return true
        case nil: return false
        }
    }

    /// The exhaustion control persists only in the placeholder store today —
    /// the daemon document has no field for it yet, and a control that
    /// silently does not persist is a lie, so the UI hides it on the daemon
    /// backend until the store grows the field.
    var canEditExhaustion: Bool {
        if case .placeholder = backend { return true }
        return false
    }

    func exhaustionBehavior(_ category: TaskCategory) -> ExhaustionBehavior {
        if case .placeholder(let policy, _) = backend {
            return policy.categoryPolicy(category).exhaustionBehavior
        }
        return .refuse
    }

    var warnings: [PolicyWarning] {
        guard let snapshot else { return [] }
        let ids = snapshot.providerIDs
        var result: [PolicyWarning] = []
        if !ids.isEmpty, ids.allSatisfy({ !providerMasterOn($0) }) {
            result.append(.noProvidersEnabled)
        }
        if policyLoaded, chainEntries(nil).isEmpty {
            result.append(.defaultChainEmpty)
        }
        return result
    }

    // MARK: Writes — instant locally, durable through the daemon

    func setProviderEnabled(_ provider: ProviderID, _ enabled: Bool) {
        mutate(applyToDocument: { document in
            document.providers[provider.rawValue] = enabled ? "enabled" : "disabled"
        }, applyToPlaceholder: { policy in
            policy.setProviderEnabled(provider, enabled)
        }, persist: [
            "routing", "set-provider", provider.rawValue,
            enabled ? "enabled" : "disabled",
        ])
    }

    func setModelEnabled(provider: ProviderID, model: String, _ enabled: Bool) {
        mutate(applyToDocument: { document in
            Self.upsertRow(&document, provider: provider.rawValue, model: model) {
                $0.state = enabled ? "enabled" : "disabled"
            }
        }, applyToPlaceholder: { policy in
            policy.setModelEnabled(provider: provider, modelId: model, enabled)
        }, persist: [
            "routing", "set-model", provider.rawValue, model,
            enabled ? "enabled" : "disabled",
        ])
    }

    func setEffort(provider: ProviderID, model: String, _ effort: EffortTarget) {
        let wire = RoutingPolicyDocument.WireEffort(effort)
        mutate(applyToDocument: { document in
            Self.upsertRow(&document, provider: provider.rawValue, model: model) {
                $0.effort = wire
            }
        }, applyToPlaceholder: { policy in
            policy.setModelEffort(provider: provider, modelId: model, effort)
        }, persist: [
            "routing", "set-effort", provider.rawValue, model, wire.cliArgument,
        ])
    }

    /// nil category = the global fallback chain ("default" on the wire).
    func setChain(_ category: TaskCategory?, entries: [ChainEntry]) {
        let wire = entries.map {
            RoutingPolicyDocument.WireChainEntry(
                provider: $0.provider, model: $0.model,
                effort: RoutingPolicyDocument.WireEffort($0.effort))
        }
        // The chain CLI has no spelling for never-configured, hive-decides, or
        // a mode a newer daemon added. Rewriting such a link to the nearest
        // spelling would change routing the user never touched, so refuse the
        // whole write and say so.
        let arguments = wire.map(\.cliArgument)
        guard arguments.allSatisfy({ $0 != nil }) else {
            policyWriteError =
                "This chain contains an effort setting this version of Hive cannot write. "
                + "Update Hive to edit it — nothing was changed."
            notify()
            return
        }
        let key = category?.rawValue ?? "default"
        mutate(applyToDocument: { document in
            document.chains[key] = wire
        }, applyToPlaceholder: { policy in
            if let category {
                policy.setCategoryChain(category, chain: entries)
            } else {
                policy.defaultChain = entries
                policy.provisional = false
            }
        }, persist: ["routing", "set-chain", key] + arguments.compactMap { $0 })
    }

    func setGlobalSelection(_ mode: SelectionMode) {
        mutate(applyToDocument: { document in
            document.selection.global = mode.rawValue
        }, applyToPlaceholder: { policy in
            policy.setGlobalSelection(mode)
        }, persist: ["routing", "set-selection", mode.rawValue])
    }

    /// nil clears the override — back to the global mode ("unset" on the wire).
    func setCategorySelection(_ category: TaskCategory, _ mode: SelectionMode?) {
        mutate(applyToDocument: { document in
            document.selection.categories[category.rawValue] = mode?.rawValue
        }, applyToPlaceholder: { policy in
            policy.setCategorySelection(category, mode)
        }, persist: [
            "routing", "set-selection", mode?.rawValue ?? "unset",
            "--category", category.rawValue,
        ])
    }

    func setExhaustionBehavior(_ category: TaskCategory, _ behavior: ExhaustionBehavior) {
        // Placeholder-only until the daemon document carries the field.
        mutate(applyToDocument: { _ in }, applyToPlaceholder: { policy in
            policy.setExhaustionBehavior(category, behavior)
        }, persist: nil)
    }

    private static func upsertRow(
        _ document: inout RoutingPolicyDocument,
        provider: String, model: String,
        _ apply: (inout RoutingPolicyDocument.ModelRow) -> Void
    ) {
        if let index = document.models.firstIndex(where: {
            $0.provider == provider && $0.model == model
        }) {
            apply(&document.models[index])
        } else {
            var row = RoutingPolicyDocument.ModelRow(provider: provider, model: model)
            apply(&row)
            document.models.append(row)
        }
    }

    /// The write path: optimistic local application (both backends), then a
    /// serialized daemon persist when a daemon backend holds the policy.
    private func mutate(
        applyToDocument: (inout RoutingPolicyDocument) -> Void,
        applyToPlaceholder: (inout ModelControlPolicy) -> Void,
        persist arguments: [String]?
    ) {
        switch backend {
        case .daemon(var document):
            applyToDocument(&document)
            document.provisional = false
            backend = .daemon(document)
            notify()
            if let arguments { enqueuePersist(arguments) }
        case .placeholder(var policy, let reason):
            applyToPlaceholder(&policy)
            backend = .placeholder(policy, reason: reason)
            notify()
        case nil:
            break
        }
    }

    private func enqueuePersist(_ arguments: [String]) {
        guard let hivePath else { return }
        pendingWrites += 1
        persistQueue.async { [weak self] in
            guard let self else { return }
            // The revision the daemon holds right now: read on main so it
            // stays ordered with earlier completions.
            var revision = 0
            DispatchQueue.main.sync {
                if case .daemon(let document) = self.backend {
                    revision = document.revision
                }
            }
            let result = Self.run(
                hivePath: hivePath,
                arguments: ModelControlCommand.arguments(
                    arguments + ["--expect-revision", String(revision)],
                    daemonPort: self.daemonPort))
            DispatchQueue.main.async {
                self.pendingWrites -= 1
                switch result {
                case .success(let data):
                    guard case .daemon(var current) = self.backend,
                          let confirmed = try? RoutingPolicyDocument.decode(from: data) else {
                        return
                    }
                    if self.pendingWrites == 0 {
                        // Queue drained: the daemon's answer is authoritative.
                        self.backend = .daemon(confirmed)
                    } else {
                        // Later optimistic edits are still in flight; take
                        // the revision, keep the local view.
                        current.revision = confirmed.revision
                        self.backend = .daemon(current)
                    }
                    self.policyWriteError = nil
                    self.notify()
                case .failure(let error):
                    // Stale revision or validation refusal: reload the truth
                    // and say so — never merge blind.
                    self.policyWriteError =
                        "A change could not be saved: \(error.localizedDescription) — reloaded the stored policy."
                    self.refresh()
                }
            }
        }
    }

    // MARK: Reads

    func refresh() {
        guard !refreshing else { return }
        guard let hivePath else {
            loadState = .failed(
                "The Workspace was launched without a hive binary path. " +
                "Open it via `hive` from a project directory to see live data.")
            notify()
            return
        }
        refreshing = true
        loadState = .loading
        notify()

        let daemonPort = self.daemonPort
        workQueue.async { [weak self] in
            let snapshotResult = Self.run(
                hivePath: hivePath,
                arguments: ModelControlCommand.arguments(
                    ["model-control-snapshot"], daemonPort: daemonPort))
            let policyResult = Self.run(
                hivePath: hivePath,
                arguments: ModelControlCommand.arguments(
                    ["routing", "export"], daemonPort: daemonPort))
            DispatchQueue.main.async {
                guard let self else { return }
                self.refreshing = false
                switch snapshotResult {
                case .success(let data):
                    do {
                        self.apply(
                            snapshot: try ModelControlSnapshot.decode(from: data),
                            policyResult: policyResult)
                    } catch {
                        self.loadState = .failed(
                            "Could not decode the model-control snapshot: \(error.localizedDescription)")
                    }
                case .failure(let error):
                    self.loadState = .failed(error.localizedDescription)
                }
                self.notify()
            }
        }
    }

    private func apply(
        snapshot: ModelControlSnapshot,
        policyResult: Result<Data, Error>
    ) {
        self.snapshot = snapshot
        self.lastRefreshed = Date()
        self.loadState = .loaded

        // A write may still be in flight; do not clobber its optimistic view.
        if pendingWrites > 0 { return }

        switch policyResult {
        case .success(let data):
            if let document = try? RoutingPolicyDocument.decode(from: data) {
                backend = .daemon(document)
                return
            }
            fallBackToPlaceholder(
                snapshot: snapshot,
                reason: "The policy store answered with a document this app cannot read.")
        case .failure(let error):
            fallBackToPlaceholder(
                snapshot: snapshot,
                reason: "The policy store is unreachable (\(error.localizedDescription)). "
                    + "The running daemon likely predates it — restart Hive to persist changes.")
        }
    }

    /// PLACEHOLDER path: only when the daemon cannot hold policy. Keeps any
    /// edits the user already made in this session rather than re-seeding
    /// over them.
    private func fallBackToPlaceholder(snapshot: ModelControlSnapshot, reason: String) {
        if case .placeholder(let existing, _) = backend {
            backend = .placeholder(existing, reason: reason)
        } else {
            backend = .placeholder(
                ProvisionalPolicyStore.seed(from: snapshot), reason: reason)
        }
    }

    // MARK: Subprocess

    private struct CommandError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// Runs off the main thread only — `waitUntilExit` and the full stdout
    /// read are exactly the calls that would freeze the UI.
    private static func run(
        hivePath: String, arguments: [String]
    ) -> Result<Data, Error> {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let process = Process()
        process.executableURL = URL(fileURLWithPath: hivePath)
        process.arguments = arguments
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        do {
            try process.run()
        } catch {
            return .failure(CommandError(
                message: "Could not run hive: \(error.localizedDescription)"))
        }
        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        let errorData = stderr.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let detail = String(data: errorData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let lastLine = detail?.split(separator: "\n").last.map(String.init)
            return .failure(CommandError(
                message: (lastLine?.isEmpty == false)
                    ? lastLine!
                    : "hive \(arguments.joined(separator: " ")) exited with status \(process.terminationStatus)"))
        }
        return .success(data)
    }
}
