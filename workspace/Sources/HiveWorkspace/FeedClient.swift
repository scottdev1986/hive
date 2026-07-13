import Foundation
import WorkspaceCore

/// Runs `hive workspace-feed --port <n>` (or the `--feed` override) as a
/// long-lived subprocess and turns its NDJSON stdout into agent snapshots.
///
/// Keeping this process alive is also what tells the daemon a workspace is
/// attached (so it stops opening external terminal windows); `stop()` is
/// called when the window closes or the app quits.
///
/// `onExit` fires only for an exit the app did not ask for (a kill, a crash, a
/// daemon that went away); `stop()` silences it. The app RESTARTS the feed on
/// that signal — it is an event, not proof the workspace is gone. This class
/// used to promise the opposite ("no auto-restart; the user relaunches via
/// `hive`") and that contract failed in the field on 2026-07-12; see
/// `AppDelegate.scheduleFeedRestart()` for what happened and why it is not
/// coming back.
final class FeedClient {

    private let process = Process()
    private let stdout = Pipe()
    // The feed treats end-of-stdin as its clean-shutdown signal (it surrenders
    // the daemon's viewer lease before exiting). The app therefore holds this
    // pipe's write end open for the feed's whole life; inheriting the app's
    // own stdin would hand the feed /dev/null under LaunchServices and stop it
    // the moment it starts.
    private let stdinPipe = Pipe()
    private var buffer = Data()
    private var stopped = false

    /// All callbacks are delivered on the main queue. The orchestrator snapshot
    /// is nil when the daemon reported no trustworthy status for the root; it is
    /// passed through as nil rather than dropped, because "we do not know" is a
    /// value the pane must act on, not an absence it may ignore.
    var onSnapshot: (([AgentSnapshot], OrchestratorSnapshot?) -> Void)?
    /// The daemon's live writer-autonomy dial ("sandboxed"/"dangerous"),
    /// fired for every snapshot line that carries it.
    var onAutonomy: ((String) -> Void)?
    var onError: ((String) -> Void)?
    var onExit: (() -> Void)?

    init(executable: String, arguments: [String], environment: [String: String]? = nil) {
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = environment
        process.standardInput = stdinPipe
        process.standardOutput = stdout
        process.standardError = FileHandle.standardError
    }

    func start() throws {
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async { self?.consume(data) }
        }
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, !self.stopped else { return }
                self.onExit?()
            }
        }
        try process.run()
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        stdout.fileHandleForReading.readabilityHandler = nil
        process.terminationHandler = nil
        // Closing stdin is the polite shutdown: the feed surrenders the viewer
        // lease and exits 0. SIGTERM stays as the backstop for a wedged feed;
        // its handler surrenders the lease too.
        try? stdinPipe.fileHandleForWriting.close()
        if process.isRunning {
            process.terminate()
        }
    }

    private func consume(_ data: Data) {
        buffer.append(data)
        while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let lineData = buffer[buffer.startIndex..<newline]
            buffer.removeSubrange(buffer.startIndex...newline)
            guard let line = String(data: lineData, encoding: .utf8),
                  let decoded = FeedLine.parse(line) else { continue }
            if let agents = decoded.agents {
                if let autonomy = decoded.autonomy {
                    onAutonomy?(autonomy)
                }
                onSnapshot?(agents, decoded.orchestrator)
            } else if let error = decoded.error {
                onError?(error)
            }
        }
    }
}
