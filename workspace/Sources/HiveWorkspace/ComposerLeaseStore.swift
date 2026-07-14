import Foundation
import WorkspaceCore

/// Instance-local handshake between Workspace keyboard input and the daemon's
/// delivery layer. Marker creation is synchronous so no delivery can race the
/// user's first keystroke into the same terminal composer.
final class ComposerLeaseStore {
    private let directory: URL
    private var generations: [String: UInt64] = [:]
    private let submitGrace: TimeInterval

    init(instanceHome: String, submitGrace: TimeInterval = 0.75) {
        directory = URL(fileURLWithPath: instanceHome, isDirectory: true)
            .appendingPathComponent("runtime/composers", isDirectory: true)
        self.submitGrace = submitGrace
        clear()
        try? FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true)
    }

    deinit { clear() }

    func handle(recipient: String, action: ComposerInputAction) {
        switch action {
        case .editing:
            generations[recipient, default: 0] &+= 1
            let marker = markerURL(recipient)
            try? FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: marker.path, contents: Data())
        case .submitted:
            let generation = generations[recipient, default: 0]
            DispatchQueue.main.asyncAfter(deadline: .now() + submitGrace) { [weak self] in
                guard let self, self.generations[recipient] == generation else { return }
                self.remove(recipient)
            }
        case .cancelled:
            remove(recipient)
        case .ignored:
            break
        }
    }

    func isActive(_ recipient: String) -> Bool {
        FileManager.default.fileExists(atPath: markerURL(recipient).path)
    }

    func clear() {
        try? FileManager.default.removeItem(at: directory)
        generations.removeAll()
    }

    private func remove(_ recipient: String) {
        generations.removeValue(forKey: recipient)
        try? FileManager.default.removeItem(at: markerURL(recipient))
    }

    private func markerURL(_ recipient: String) -> URL {
        directory.appendingPathComponent("\(recipient).typing", isDirectory: false)
    }
}
