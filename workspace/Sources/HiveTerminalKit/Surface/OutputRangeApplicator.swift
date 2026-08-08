import Foundation

public enum OutputApplyResult: Equatable, Sendable {
    case applied(newHighWater: UInt64)
    case duplicateIgnored
    case gapRebaseRequired
    case digestConflictRebaseRequired
    /// Late frame: payload bound to a different locator/generation/connection.
    case rejectedWrongBinding(evidence: String)
    case engineError(HiveTerminalEngineResult)
}

/// Applies contiguous ordered OUTPUT ranges to a `ManualSurfaceEngine`. Rules: - streamSeq is the first-byte offset; next expected is streamSeq + length - duplicate-equal ranges are ignored - gap or digest conflict → rebase required (never invent fill) - a frame whose binding does not match the surface is **never** applied - at-least-once retransmit fully behind high-water is ignored, unless a stored digest conflicts
public final class OutputRangeApplicator {
    public private(set) var binding: SurfaceBinding?
    public private(set) var highWater: UInt64 = 0
    public private(set) var lastAppliedDigest: Data?
    private var lastCommittedRange: (streamSeq: UInt64, length: Int, digest: Data)?
    private let engine: ManualSurfaceEngine

    init(engine: ManualSurfaceEngine) {
        self.engine = engine
    }

    /// Bind or retarget. Cancels any prior binding; late frames for the old binding must be rejected after this call.
    public func bind(_ binding: SurfaceBinding, highWater: UInt64 = 0) {
        self.binding = binding
        self.highWater = highWater
        self.lastCommittedRange = nil
        self.lastAppliedDigest = nil
    }

    public func clearBinding() {
        binding = nil
        highWater = 0
        lastCommittedRange = nil
        lastAppliedDigest = nil
    }

    public func apply(
        bytes: Data,
        streamSeq: UInt64,
        frameBinding: SurfaceBinding
    ) -> OutputApplyResult {
        guard let binding else {
            return .rejectedWrongBinding(evidence: "no surface binding")
        }
        if frameBinding != binding {
            return .rejectedWrongBinding(
                evidence: "frame locator/generation/connection \(frameBinding.locator.sessionId)#\(frameBinding.generation)/\(frameBinding.connectionId) != bound \(binding.locator.sessionId)#\(binding.generation)/\(binding.connectionId)"
            )
        }
        if bytes.isEmpty {
            return .engineError(.invalidValue)
        }

        let digest = sha256(bytes)
        let end = streamSeq + UInt64(bytes.count)

        if let prior = lastCommittedRange,
           prior.streamSeq == streamSeq,
           prior.length == bytes.count {
            if prior.digest == digest {
                return .duplicateIgnored
            }
            return .digestConflictRebaseRequired
        }

        if end <= highWater {
            return .duplicateIgnored
        }

        if streamSeq != highWater {
            return .gapRebaseRequired
        }

        let result = engine.processOutput(bytes: bytes, streamSeq: streamSeq)
        switch result {
        case .success:
            if engine.throughSeq > highWater {
                highWater = engine.throughSeq
                lastCommittedRange = (streamSeq, bytes.count, digest)
                lastAppliedDigest = digest
                return .applied(newHighWater: highWater)
            }
            lastCommittedRange = (streamSeq, bytes.count, digest)
            return .duplicateIgnored
        case .invalidValue:
            return .digestConflictRebaseRequired
        default:
            return .engineError(result)
        }
    }

    public func restoreCheckpoint(
        payload: Data,
        throughSeq: UInt64,
        frameBinding: SurfaceBinding
    ) -> OutputApplyResult {
        guard let binding else {
            return .rejectedWrongBinding(evidence: "no surface binding")
        }
        if frameBinding != binding {
            return .rejectedWrongBinding(evidence: "checkpoint binding mismatch")
        }
        let result = engine.restoreCheckpoint(payload: payload, throughSeq: throughSeq)
        guard result == .success else {
            return .engineError(result)
        }
        highWater = throughSeq
        lastCommittedRange = nil
        lastAppliedDigest = nil
        return .applied(newHighWater: highWater)
    }
}
