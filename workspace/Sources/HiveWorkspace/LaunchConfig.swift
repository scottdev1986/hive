import Foundation

/// Arguments the CLI passes at launch:
///
///     open -a HiveWorkspace --args --project <abs dir> --port <daemon port>
///       --hive <abs hive binary> --orchestrator-session <tmux session>
///       [--orchestrator claude|codex|grok]
///
/// Plus two development/CI flags:
///     --smoke          headless end-to-end checks (offscreen windows, exits 0/1)
///     --feed <binary>  overrides the feed process (defaults to `<hive> workspace-feed`);
///                      the process-boundary seam the smoke harness uses.
///
/// Launched with no arguments (Dock click or bare `hive`), the standalone app
/// shows its project-neutral home window — never fixtures or cwd-derived data.
struct LaunchConfig {
    var projectDirectory: String?
    var port: Int?
    var hivePath: String?
    var orchestrator = "claude"
    var orchestratorSession: String?
    var feedOverride: String?
    var smoke = false
    /// Open the Settings window (Model Control Center) at launch. A
    /// development/verification affordance; works with or without a project.
    var settings = false
    /// Which settings section to open ("tasks" or "models").
    var settingsPage: String?
    /// Force the app appearance ("light"/"dark") — screenshot/verification
    /// affordance; never changes the system setting.
    var appearance: String?
    /// Force the settings window width at launch (responsive verification).
    var settingsWidth: Double?

    /// A window can only open with the full contract; anything less gets the
    /// explainer window.
    var isComplete: Bool {
        projectDirectory != nil && port != nil && hivePath != nil
    }

    /// The feed subprocess invocation: the override binary verbatim, or
    /// `<hive> workspace-feed`, always with the daemon port appended.
    var feedInvocation: (executable: String, arguments: [String])? {
        guard let port else { return nil }
        if let feedOverride {
            return (feedOverride, ["--port", String(port)])
        }
        guard let hivePath else { return nil }
        return (hivePath, ["workspace-feed", "--port", String(port)])
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
            case "--hive":
                config.hivePath = iterator.next()
            case "--orchestrator":
                if let tool = iterator.next(),
                   tool == "claude" || tool == "codex" || tool == "grok" {
                    config.orchestrator = tool
                }
            case "--orchestrator-session":
                config.orchestratorSession = iterator.next()
            case "--feed":
                config.feedOverride = iterator.next()
            default:
                break // unknown args (e.g. LaunchServices -psn_…) are ignored
            }
        }
        return config
    }
}
