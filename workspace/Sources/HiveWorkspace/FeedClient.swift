import Foundation
import WorkspaceCore

/// Runs `hive workspace-feed --port <n>` (or the `--feed` override) as a
/// long-lived subprocess and turns its NDJSON stdout into agent snapshots.
///
/// Keeping this process alive is also what tells the daemon a workspace is
/// attached (so it stops opening external terminal windows); `stop()` is
/// called when the window closes or the app quits.
///
/// There is deliberately no auto-restart: if the feed dies the workspace
/// marks agent panes disconnected and the user relaunches via `hive`.
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

    /// All callbacks are delivered on the main queue.
    var onSnapshot: (([AgentSnapshot]) -> Void)?
    /// The daemon's live writer-autonomy dial ("sandboxed"/"dangerous"),
    /// fired for every snapshot line that carries it.
    var onAutonomy: ((String) -> Void)?
    var onError: ((String) -> Void)?
    var onExit: (() -> Void)?

    init(executable: String, arguments: [String]) {
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
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
                onSnapshot?(agents)
            } else if let error = decoded.error {
                onError?(error)
            }
        }
    }
}
