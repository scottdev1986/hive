import AppKit
@testable import HiveTerminalKit

extension GhosttyBridgeFactory {
    /// Builds a headless manual surface for integration tests in this target.
    static func makeManualSurfaceForTesting(
        widthPx: UInt32 = 800,
        heightPx: UInt32 = 480,
        terminalReplies: GhosttyTerminalReplyPolicy = .enabled
    ) throws -> GhosttyManualSurface {
        try performOnMainSync {
            let host = NSView(
                frame: NSRect(
                    x: 0,
                    y: 0,
                    width: CGFloat(widthPx),
                    height: CGFloat(heightPx)
                )
            )
            let configURL = try HiveTerminalConfiguration.writeProcessFile(headless: true)
            return try configURL.path.withCString { configPath in
                try makeManualSurfaceOnMain(
                    hostView: host,
                    widthPx: widthPx,
                    heightPx: heightPx,
                    terminalReplies: terminalReplies,
                    configPolicyPath: configPath,
                    hiveConfigurationHeadless: true
                )
            }
        }
    }
}
