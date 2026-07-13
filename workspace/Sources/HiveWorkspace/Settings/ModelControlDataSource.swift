import AppKit
import WorkspaceCore

/// Loads the Model Control Center's data by running
/// `hive model-control-snapshot` as a subprocess — the app's one transport —
/// and holds the (placeholder, in-memory) policy.
///
/// Threading contract, non-negotiable: the subprocess runs and is parsed on a
/// background queue; `onChange` always fires on the main queue; nothing here
/// ever blocks the main thread on a read. Toggles mutate local policy
/// synchronously so a click registers instantly, with persistence to follow
/// when the daemon policy store (a later PR) replaces the placeholder.
final class ModelControlDataSource {

    enum LoadState {
        case idle
        case loading
        case loaded
        /// The read itself failed. The UI renders this as its own state —
        /// never as empty meters and never as a frozen window.
        case failed(String)
    }

    private(set) var snapshot: ModelControlSnapshot?
    private(set) var policy: ModelControlPolicy?
    private(set) var loadState: LoadState = .idle
    private(set) var lastRefreshed: Date?

    /// Fired on the main queue whenever snapshot, policy, or load state moved.
    /// Multicast: both settings pages observe one policy.
    private var observers: [() -> Void] = []

    func addObserver(_ handler: @escaping () -> Void) {
        observers.append(handler)
    }

    private let hivePath: String?
    private let workQueue = DispatchQueue(
        label: "dev.hive.workspace.model-control", qos: .userInitiated)
    private var refreshing = false

    init(hivePath: String?) {
        self.hivePath = hivePath
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

        workQueue.async { [weak self] in
            let result = Self.runSnapshot(hivePath: hivePath)
            DispatchQueue.main.async {
                guard let self else { return }
                self.refreshing = false
                switch result {
                case .success(let snapshot):
                    self.apply(snapshot: snapshot)
                case .failure(let error):
                    self.loadState = .failed(error.localizedDescription)
                }
                self.notify()
            }
        }
    }

    private func apply(snapshot: ModelControlSnapshot) {
        self.snapshot = snapshot
        self.lastRefreshed = Date()
        self.loadState = .loaded
        if policy == nil {
            // PLACEHOLDER: in-memory provisional policy seeded from the live
            // catalog. The daemon SQLite store (later PR) replaces this seam.
            policy = ProvisionalPolicyStore.seed(from: snapshot)
        }
    }

    // MARK: Writes (instant local state; placeholder persistence)

    func mutatePolicy(_ mutate: (inout ModelControlPolicy) -> Void) {
        guard var policy else { return }
        mutate(&policy)
        self.policy = policy
        notify()
    }

    private func notify() {
        for observer in observers { observer() }
    }

    // MARK: Subprocess

    private struct SnapshotError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// Runs on `workQueue` only. `waitUntilExit` and the full stdout read are
    /// exactly the calls that would freeze the UI on the main thread.
    private static func runSnapshot(
        hivePath: String
    ) -> Result<ModelControlSnapshot, Error> {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let process = Process()
        process.executableURL = URL(fileURLWithPath: hivePath)
        process.arguments = ["model-control-snapshot"]
        let stdout = Pipe()
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return .failure(SnapshotError(
                message: "Could not run hive: \(error.localizedDescription)"))
        }
        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            return .failure(SnapshotError(
                message: "hive model-control-snapshot exited with status \(process.terminationStatus)"))
        }
        do {
            return .success(try ModelControlSnapshot.decode(from: data))
        } catch {
            return .failure(SnapshotError(
                message: "Could not decode the model-control snapshot: \(error.localizedDescription)"))
        }
    }
}
