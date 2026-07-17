/// HiveTerminalKit — Swift/AppKit wrapper over the manual-I/O Ghostty surface.
///
/// Layers (WP5 L0–L2):
/// - **L0** `Bridge/` — six `_v1` ABI symbols + stock surface APIs; copy-before-return callbacks
/// - **L1** `View/HiveTerminalView` — one surface, one SessionLocator/generation; focus/geometry/states
/// - **L2** `Attach/AttachReplayClient` — §20 viewer wire attach/replay against injected HostTransport
///
/// **L3 SEAM** (later spawn, OUT OF SCOPE): real WP4 session-host UDS binding replaces
/// FakeHost/`InMemoryHostTransport` via the `HostTransport` protocol only.
///
/// Design authority: docs/design/terminal-stack-transition.html §§06/09/20/22/23/26.
public enum HiveTerminalKitInfo {
    public static let module = "HiveTerminalKit"
    public static let layersImplemented = "L0-L2"
    public static let l3Seam = "HostTransport"
}
