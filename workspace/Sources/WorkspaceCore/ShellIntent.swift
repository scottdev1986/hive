// ShellIntent.swift The typed bodies every shell command sends through the mutation envelope. One case per daemon-bound command — the dispatcher never builds an intent outside this list, so an unnamed mutation cannot leak past the menu registry.

import Foundation

/// The five vendors that can hold the live Queen. Client-side identity only: the compare-and-set itself is the daemon's.
public enum ShellQueenProvider: String, Codable, Equatable, Sendable {
    case claude
    case codex
    case grok
    case kimi
    case opencode
}

public enum ShellIntentBody: Codable, Equatable, Sendable {
    case stopHive
    case attachViewer
    case detachViewer
    case pauseProvider
    case resumeProvider
    case stopProvider
    case terminateTerminal
    case acknowledgeAttention
    case closeAgentCascade
    case pauseRun
    case resumeRun
    case redirectThroughQueen
    case abortRun
    case newCuratedMemory
    case reindexMemory
    case setLiveQueenProvider(ShellQueenProvider)
}

/// The observed post-state every shell mutation result carries. For a rejection this names the state that remained in force — the workspace revision/generation the intent compared against — rather than leaving the client to infer it from the failure.
public struct ShellMutationPostState: Codable, Equatable, Sendable {
    public let command: ShellCommand
    public let source: ProjectionSource

    public init(command: ShellCommand, source: ProjectionSource) {
        self.command = command
        self.source = source
    }
}

extension MutationFailure {
    public static func shellWireUnavailable(command: ShellCommand) -> MutationFailure {
        MutationFailure(
            code: "unavailable",
            message: "\(command.title) has no daemon wire in this build. "
                + "Nothing was sent and no state changed.")
    }
}
