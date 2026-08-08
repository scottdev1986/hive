public enum ModelControlCommand {
    public static func arguments(_ arguments: [String], daemonPort: Int?) -> [String] {
        guard let daemonPort else { return arguments }
        return arguments + ["--port", String(daemonPort)]
    }
}
