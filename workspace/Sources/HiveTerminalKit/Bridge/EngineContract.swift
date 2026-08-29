import Foundation

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
            buildId: "ghostty-owned"
        )
    }
}

public struct HiveTerminalRenderEvidence: Equatable, Sendable {
    public let engine: HiveTerminalEngineIdentity
    public let drawCount: Int
    public let layerClass: String?
    public let hasPresentedContents: Bool

    public init(
        engine: HiveTerminalEngineIdentity,
        drawCount: Int,
        layerClass: String?,
        hasPresentedContents: Bool
    ) {
        self.engine = engine
        self.drawCount = drawCount
        self.layerClass = layerClass
        self.hasPresentedContents = hasPresentedContents
    }
}
