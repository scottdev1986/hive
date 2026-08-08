import AppKit
import Foundation
@testable import HiveTerminalKit

extension GhosttyBridgeFactory {
    /// Convenience for tests: host view is retained by the returned surface.
    static func makeManualSurfaceForTesting(
        widthPx: UInt32 = 800,
        heightPx: UInt32 = 480,
        terminalReplies: GhosttyTerminalReplyPolicy = .enabled
    ) throws -> GhosttyManualSurface {
        try performOnMainSync {
            let host = NSView(frame: NSRect(x: 0, y: 0, width: CGFloat(widthPx), height: CGFloat(heightPx)))
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

    static func makeManualSurfaceForClipboardTesting(
        widthPx: UInt32 = 800,
        heightPx: UInt32 = 480,
        terminalReplies: GhosttyTerminalReplyPolicy,
        clipboardContext: GhosttyClipboardContext
    ) throws -> GhosttyManualSurface {
        try performOnMainSync {
            let host = NSView(frame: NSRect(x: 0, y: 0, width: CGFloat(widthPx), height: CGFloat(heightPx)))
            let configURL = try HiveTerminalConfiguration.writeProcessFile(headless: true)
            return try configURL.path.withCString { configPath in
                try makeManualSurfaceOnMain(
                    hostView: host,
                    widthPx: widthPx,
                    heightPx: heightPx,
                    terminalReplies: terminalReplies,
                    configPolicyPath: configPath,
                    clipboardContext: clipboardContext,
                    hiveConfigurationHeadless: true
                )
            }
        }
    }

    /// Test mutation seam: loads an explicit generated policy file so tests
    /// can prove a viewer setting changes real engine behavior at its
    /// consumption site. Production always uses HiveTerminalConfiguration.
    static func makeManualSurfaceForConfigurationTesting(
        contents: String,
        clipboardContext: GhosttyClipboardContext = GhosttyClipboardContext()
    ) throws -> GhosttyManualSurface {
        try performOnMainSync {
            let configURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("hive-ghostty-policy-\(UUID().uuidString).conf")
            try Data(contents.utf8).write(to: configURL, options: .atomic)
            defer { try? FileManager.default.removeItem(at: configURL) }
            return try configURL.path.withCString { configPath in
                try makeManualSurfaceOnMain(
                    hostView: NSView(frame: NSRect(x: 0, y: 0, width: 800, height: 480)),
                    widthPx: 800,
                    heightPx: 480,
                    terminalReplies: .disabled,
                    configPolicyPath: configPath,
                    clipboardContext: clipboardContext,
                    hiveConfigurationHeadless: true
                )
            }
        }
    }
}
