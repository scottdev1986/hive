import Foundation
import WorkspaceCore

/// Runs `hive workspace-feed --port <n>` (or the `--feed` override) as a long-lived subprocess and turns its NDJSON stdout into agent snapshots. `onExit` fires only for an exit the app did not ask for (a kill, a crash, a daemon that went away); `stop()` silences it. The app restarts the feed on that signal because the last rendered statuses are stale after an exit.
final class FeedClient {

    private let process = Process()
    private let stdout = Pipe()
    private let stdinPipe = Pipe()
    private var buffer = Data()
    private var stopped = false

    /// All callbacks are delivered on the main queue. A nil orchestrator snapshot means its status channel failed; ProjectState renders that as disconnected rather than inventing a turn state.
    var onSnapshot: (([AgentSnapshot], OrchestratorSnapshot?) -> Void)?
    /// The strict shell adapter consumes the complete envelope so it can refuse an unsupported schema version before reading any agent fields. Legacy pane callers keep using `onSnapshot` below.
    var onLine: ((FeedLine) -> Void)?
    var onMalformedLine: ((String) -> Void)?
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
        try? stdinPipe.fileHandleForWriting.close()
        if process.isRunning {
            process.terminate()
        }
    }

    func publishVisibility(_ inventory: WorkspaceVisibilityInventory) throws {
        guard !stopped else { return }
        var data = try JSONEncoder().encode(inventory)
        data.append(UInt8(ascii: "\n"))
        try stdinPipe.fileHandleForWriting.write(contentsOf: data)
    }

    private func consume(_ data: Data) {
        buffer.append(data)
        while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let lineData = buffer[buffer.startIndex..<newline]
            buffer.removeSubrange(buffer.startIndex...newline)
            guard let line = String(data: lineData, encoding: .utf8) else {
                onMalformedLine?("workspace-feed emitted invalid UTF-8")
                continue
            }
            guard let decoded = FeedLine.parse(line) else {
                if !line.trimmingCharacters(in: .whitespaces).isEmpty {
                    onMalformedLine?("workspace-feed envelope could not be decoded")
                }
                continue
            }
            onLine?(decoded)
            if let agents = decoded.agents {
                onSnapshot?(agents, decoded.orchestrator)
            } else if let error = decoded.error {
                onError?(error)
            }
        }
    }
}
