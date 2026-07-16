import Foundation

/// Arguments the CLI passes at launch:
///
///     open -a HiveWorkspace --args --project <abs dir> --port <daemon port>
///       --instance-id <id> --instance-home <abs dir>
///       --hive <abs hive binary> --orchestrator-session <tmux session>
///       --tmux-socket <instance-scoped socket name>
///       [--orchestrator claude|codex|grok]
///
/// Plus two development/CI flags:
///     --smoke          headless end-to-end checks (offscreen windows, exits 0/1)
///     --feed <binary>  overrides the feed process (defaults to `<hive> workspace-feed`);
///                      the process-boundary seam the smoke harness uses.
///
/// A Dock launch shows the project-neutral home window. Bare `hive` opens the
/// current repository when there is one, and otherwise opens that same home.
struct LaunchConfig {
    var projectDirectory: String?
    var port: Int?
    var instanceID: String?
    var instanceHome: String?
    var hivePath: String?
    var orchestrator = "claude"
    var orchestratorSession: String?
    var tmuxSocket: String?
    var feedOverride: String?
    var smoke = false
    /// Open the Settings window (Model Control Center) at launch. A
    /// development/verification affordance; works with or without a project.
    var settings = false
    /// Which settings section to open ("tasks", "models", or "usage").
    var settingsPage: String?
    /// Force the app appearance ("light"/"dark") — screenshot/verification
    /// affordance; never changes the system setting.
    var appearance: String?
    /// Force the settings window width at launch (responsive verification).
    var settingsWidth: Double?

    /// A window can only open with the full contract; anything less gets the
    /// explainer window.
    var isComplete: Bool {
        projectDirectory != nil && port != nil && instanceID != nil
            && instanceHome != nil && hivePath != nil && tmuxSocket != nil
    }

    /// The feed subprocess invocation: the override binary verbatim, or
    /// `<hive> workspace-feed`, always with the daemon port appended.
    var feedInvocation: (executable: String, arguments: [String], environment: [String: String])? {
        guard let port, let instanceID, let instanceHome else { return nil }
        var environment = ProcessInfo.processInfo.environment
        environment["HIVE_HOME"] = instanceHome
        if let feedOverride {
            return (feedOverride, ["--port", String(port), "--instance-id", instanceID], environment)
        }
        guard let hivePath else { return nil }
        return (hivePath, ["workspace-feed", "--port", String(port),
                           "--instance-id", instanceID], environment)
    }

    static func parse(_ arguments: [String]) -> LaunchConfig {
        var config = LaunchConfig()
        var iterator = arguments.makeIterator()
        while let argument = iterator.next() {
            switch argument {
            case "--smoke":
                config.smoke = true
            case "--settings":
                config.settings = true
            case "--settings-page":
                config.settingsPage = iterator.next()
            case "--appearance":
                config.appearance = iterator.next()
            case "--settings-width":
                config.settingsWidth = iterator.next().flatMap(Double.init)
            case "--project":
                config.projectDirectory = iterator.next()
            case "--port":
                config.port = iterator.next().flatMap(Int.init)
            case "--instance-id":
                config.instanceID = iterator.next()
            case "--instance-home":
                config.instanceHome = iterator.next()
            case "--hive":
                config.hivePath = iterator.next()
            case "--orchestrator":
                if let tool = iterator.next(),
                   tool == "claude" || tool == "codex" || tool == "grok" {
                    config.orchestrator = tool
                }
            case "--orchestrator-session":
                config.orchestratorSession = iterator.next()
            case "--tmux-socket":
                config.tmuxSocket = iterator.next()
            case "--feed":
                config.feedOverride = iterator.next()
            default:
                break // unknown args (e.g. LaunchServices -psn_…) are ignored
            }
        }
        return config
    }
}
