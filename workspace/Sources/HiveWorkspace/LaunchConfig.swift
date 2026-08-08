import Foundation

public struct LaunchConfig {
    public var projectDirectory: String?
    public var projectID: String?
    public var projectName: String?
    var port: Int?
    var instanceID: String?
    var instanceHome: String?
    var hivePath: String?
    var feedOverride: String?
    public var smoke = false
    var settings = false
    var settingsPage: String?
    /// Force the app appearance ("light"/"dark") — screenshot/verification affordance; never changes the system setting.
    var appearance: String?
    var settingsWidth: Double?

    var isComplete: Bool {
        projectDirectory != nil && projectID != nil && projectName != nil
            && port != nil && instanceID != nil
            && instanceHome != nil && hivePath != nil
    }

    func feedInvocation(
        workspaceSessionID: String
    ) -> (executable: String, arguments: [String], environment: [String: String])? {
        guard let port, let instanceID, let instanceHome else { return nil }
        var environment = ProcessInfo.processInfo.environment
        environment["HIVE_HOME"] = instanceHome
        if let feedOverride {
            return (feedOverride, ["--port", String(port), "--instance-id", instanceID,
                                   "--workspace-session-id", workspaceSessionID], environment)
        }
        guard let hivePath else { return nil }
        return (hivePath, ["workspace-feed", "--port", String(port),
                           "--instance-id", instanceID,
                           "--workspace-session-id", workspaceSessionID], environment)
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
            case "--project-id":
                config.projectID = iterator.next()
            case "--project-name":
                config.projectName = iterator.next()
            case "--port":
                config.port = iterator.next().flatMap(Int.init)
            case "--instance-id":
                config.instanceID = iterator.next()
            case "--instance-home":
                config.instanceHome = iterator.next()
            case "--hive":
                config.hivePath = iterator.next()
            case "--feed":
                config.feedOverride = iterator.next()
            default:
                break // unknown args (e.g. LaunchServices -psn_…) are ignored
            }
        }
        return config
    }
}
