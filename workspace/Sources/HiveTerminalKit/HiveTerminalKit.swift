/// HiveTerminalKit — Swift/AppKit wrapper over the manual-I/O Ghostty surface.
///
/// Layers:
/// - **L0** `Bridge/` — seven `_v1` ABI symbols + stock surface APIs; copy-before-return callbacks
/// - **L1** `View/HiveTerminalView` — one surface, one SessionLocator/generation; focus/geometry/states
/// - **L2** `Attach/AttachReplayClient` — viewer wire attach/replay against injected HostTransport
///
/// **L3 SEAM**: production session-host UDS binding replaces FakeHost /
/// `InMemoryHostTransport` via the `HostTransport` protocol only.
public enum HiveTerminalKitInfo {
    public static let module = "HiveTerminalKit"
    public static let layersImplemented = "L0-L2"
    public static let l3Seam = "HostTransport"
}
