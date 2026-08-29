import AppKit
import Foundation
@testable import HiveTerminalKit

extension GhosttyBridgeFactory {
    static func makeOwnedSurfaceForTesting(
        workingDirectory: String,
        command: String = "/bin/zsh -l -i",
        widthPx: UInt32 = 400,
        heightPx: UInt32 = 240
    ) throws -> GhosttyManualSurface {
        try performOnMainSync {
            let host = NSView(frame: NSRect(x: 0, y: 0, width: CGFloat(widthPx), height: CGFloat(heightPx)))
            return try makeOwnedSurfaceOnMain(
                hostView: host,
                launch: TerminalLaunch(
                    workingDirectory: workingDirectory,
                    command: command
                ),
                widthPx: widthPx,
                heightPx: heightPx,
                hiveConfigurationHeadless: true
            )
        }
    }
}
