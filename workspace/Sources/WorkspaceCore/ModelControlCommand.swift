public enum ModelControlCommand {
    /// Pins every MCC subprocess to the daemon that owns its Workspace window.
    /// With no daemon (for example a bare Dock launch), there is nothing to pin.
    public static func arguments(_ arguments: [String], daemonPort: Int?) -> [String] {
        guard let daemonPort else { return arguments }
        return arguments + ["--port", String(daemonPort)]
    }
}
