import Foundation

/// Workspace-visible identity for the exact B1-qualified renderer engine.
/// Upstream symbols and handles remain private to the Hive adapter.
public struct HiveTerminalEngineIdentity: Equatable, Sendable {
    public static let pinnedUpstreamCommit = "73534c4680a809398b396c94ac7f12fcccb7963d"

    public let upstreamCommit: String
    public let buildId: String

    public init(upstreamCommit: String, buildId: String) {
        self.upstreamCommit = upstreamCommit
        self.buildId = buildId
    }

    public static var current: HiveTerminalEngineIdentity {
        HiveTerminalEngineIdentity(
            upstreamCommit: pinnedUpstreamCommit,
            buildId: GhosttyManualSurface.engineBuildId()
        )
    }
}

/// Value-only render proof. It intentionally exposes no upstream layer,
/// surface handle, callback context, or lifetime token.
public struct HiveTerminalRenderEvidence: Equatable, Sendable {
    public let engine: HiveTerminalEngineIdentity
    public let locator: SessionLocator?
    public let highWater: UInt64
    public let drawCount: Int
    public let layerClass: String?
    public let hasPresentedContents: Bool

    public init(
        engine: HiveTerminalEngineIdentity,
        locator: SessionLocator?,
        highWater: UInt64,
        drawCount: Int,
        layerClass: String?,
        hasPresentedContents: Bool
    ) {
        self.engine = engine
        self.locator = locator
        self.highWater = highWater
        self.drawCount = drawCount
        self.layerClass = layerClass
        self.hasPresentedContents = hasPresentedContents
    }
}

public enum HiveTerminalBindingError: Error, Equatable, CustomStringConvertible, Sendable {
    case locatorChanged(expected: SessionLocator, attempted: SessionLocator)
    case closed

    public var description: String {
        switch self {
        case .locatorChanged(let expected, let attempted):
            return "HiveTerminalView is fixed to \(expected.sessionId)#\(expected.generation), not \(attempted.sessionId)#\(attempted.generation)"
        case .closed:
            return "HiveTerminalView is closed"
        }
    }
}
