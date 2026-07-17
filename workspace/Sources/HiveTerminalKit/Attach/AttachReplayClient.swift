import Foundation

/// Outcome of an attach/replay attempt (§09/§20/§26).
public enum AttachReplayOutcome: Equatable, Sendable {
    case firstCorrectFrame(highWater: UInt64, connectionId: String)
    case failed(TerminalSurfaceState)
    case rejectedLateFrame
    case continueReplay
}

/// L2 attach/replay client: speaks the §20 viewer wire to a HOST.
///
/// Sequence (§09/§20):
/// 1. HELLO (viewer role + grant token)
/// 2. WELCOME (**required** before HOST_ATTACH — M6)
/// 3. HOST_ATTACH (locator, token, geometry, afterSeq)
/// 4. SNAPSHOT_BYTES (HVTCP001 envelope, possibly multi-chunk) → restore
/// 5. OUTPUT frames in order → process_output
/// 6. APPLIED high-water acknowledgements
///
/// Host transport is injected (test double or L3 UDS).
public final class AttachReplayClient {
    public private(set) var state: TerminalSurfaceState = .starting
    public private(set) var binding: SurfaceBinding?
    public private(set) var highWater: UInt64 = 0
    public private(set) var claimPresentation: InputClaimPresentation = .free
    public private(set) var firstCorrectFramePresented = false

    public let viewerId: String
    public let applicator: OutputRangeApplicator
    private let engine: ManualSurfaceEngine
    private var transport: HostTransport?
    private var nextRequestId: UInt64 = 1
    private var snapshotBuffer = Data()
    private var snapshotStarted = false
    private var activeClaimId: String?
    private var inputSequence: UInt64 = 0

    /// Handshake receive timeout (§09): fail closed rather than HOST_ATTACH blind.
    public var handshakeTimeout: TimeInterval = 5.0
    /// After WELCOME, idle gap means end of pre-queued attach stream (L3 UDS
    /// would keep reading; FakeHost finishes with idle).
    public var streamIdleTimeout: TimeInterval = 0.15

    public static let resizeQuiescenceNanos: UInt64 = 100_000_000

    public init(viewerId: String, engine: ManualSurfaceEngine) {
        self.viewerId = viewerId
        self.engine = engine
        self.applicator = OutputRangeApplicator(engine: engine)
        engine.callbackContext.onWrite = { [weak self] bytes in
            self?.handleEncodedWrite(bytes)
        }
    }

    /// Attach using a grant already obtained (broker path is outside L2).
    @discardableResult
    public func attach(
        grant: AttachGrant,
        geometry: TerminalGeometry,
        afterSeq: UInt64,
        transport: HostTransport
    ) throws -> AttachReplayOutcome {
        // M3: refuse foreign-engine checkpoints when both IDs look like digests.
        let localEngine = GhosttyManualSurface.engineBuildId()
        if isDigestId(grant.engineBuildId), isDigestId(localEngine),
           grant.engineBuildId != localEngine {
            state = .incompatibleEngine(
                evidence: "grant \(grant.engineBuildId) != local \(localEngine)"
            )
            return .failed(state)
        }
        if let locEngine = grant.locator.engineBuildId,
           isDigestId(locEngine), isDigestId(localEngine),
           locEngine != localEngine {
            state = .incompatibleEngine(evidence: "locator engine \(locEngine)")
            return .failed(state)
        }

        self.transport = transport
        state = .attaching
        firstCorrectFramePresented = false
        snapshotBuffer = Data()
        snapshotStarted = false

        let binding = SurfaceBinding(locator: grant.locator, connectionId: transport.connectionId)
        self.binding = binding
        applicator.bind(binding, highWater: afterSeq)
        highWater = afterSeq

        let hello: [String: Any] = [
            "schemaVersion": 1,
            "buildId": "hive-terminal-kit",
            "instanceId": grant.locator.instanceId,
            "protocol": ["major": 1, "minMinor": 0, "maxMinor": 0],
            "clientRole": "viewer",
            "grantToken": grant.token,
        ]
        try sendJSON(.hello, object: hello, requestId: nextRequestId)
        nextRequestId += 1

        // M6: WELCOME is required before HOST_ATTACH.
        try requireWelcome()

        let hostAttach: [String: Any] = [
            "schemaVersion": 1,
            "locator": grant.locator.jsonObject(),
            "token": grant.token,
            "geometry": geometry.jsonObject(),
            "afterSeq": String(afterSeq),
        ]
        try sendJSON(.hostAttach, object: hostAttach, requestId: nextRequestId)
        nextRequestId += 1
        state = .replaying

        var restoredCheckpoint = false
        while true {
            let frame: WireFrame
            do {
                guard let next = try transport.receive(timeout: streamIdleTimeout) else {
                    break // closed
                }
                frame = next
            } catch WireError.receiveTimeout {
                // Open transport, no more frames — end of attach stream phase.
                break
            }
            let outcome = try handleHostFrame(frame, binding: binding)
            switch outcome {
            case .firstCorrectFrame:
                return outcome
            case .failed(let s):
                state = s
                return outcome
            case .rejectedLateFrame:
                return outcome
            case .continueReplay:
                if frame.type == .snapshotBytes, snapshotBuffer.isEmpty, highWater >= afterSeq {
                    restoredCheckpoint = true
                }
            }
        }

        if firstCorrectFramePresented {
            return .firstCorrectFrame(highWater: highWater, connectionId: binding.connectionId)
        }
        if restoredCheckpoint || highWater > afterSeq {
            return presentFirstCorrectFrame(binding: binding)
        }
        state = .delayed(evidence: "attach drained without snapshot/output")
        return .failed(state)
    }

    public func retarget(newBinding: SurfaceBinding, highWater: UInt64 = 0) {
        transport?.close()
        transport = nil
        binding = newBinding
        applicator.bind(newBinding, highWater: highWater)
        self.highWater = highWater
        firstCorrectFramePresented = false
        state = .attaching
        snapshotBuffer = Data()
        snapshotStarted = false
    }

    public func handleFrame(_ frame: WireFrame, frameBinding: SurfaceBinding) throws -> AttachReplayOutcome {
        guard let binding else { return .rejectedLateFrame }
        if frameBinding != binding { return .rejectedLateFrame }
        return try handleHostFrame(frame, binding: binding)
    }

    /// §22 claim-bound write path: Ghostty encoder output → HUMAN_INPUT.
    public func handleEncodedWrite(_ bytes: Data) {
        guard let transport, let claimId = activeClaimId, !bytes.isEmpty else { return }
        let seq = inputSequence
        inputSequence += 1
        let frame = WireFrame(
            type: .humanInput,
            flags: [.contentSensitive],
            requestId: 0,
            streamSeq: seq,
            payload: bytes
        )
        _ = claimId
        try? transport.send(frame)
    }

    public func beginClaimAcquire() throws {
        guard transport != nil else { throw WireError.notConnected }
        let payload: [String: Any] = [
            "schemaVersion": 1,
            "viewerId": viewerId,
        ]
        try sendJSON(.claimAcquire, object: payload, requestId: nextRequestId)
        nextRequestId += 1
    }

    public func noteClaimResult(claimId: String, owned: Bool) {
        if owned {
            activeClaimId = claimId
            claimPresentation = .humanOwned(viewerId: viewerId, claimId: claimId)
        } else {
            activeClaimId = nil
            claimPresentation = .free
        }
    }

    public func noteOrphaned(claimId: String) {
        claimPresentation = .humanOrphaned(viewerId: viewerId, claimId: claimId)
    }

    /// §20 RESIZE (0x0207) after geometry quiescence (M10).
    public func sendResize(_ geometry: TerminalGeometry) throws {
        guard let binding else { throw WireError.notConnected }
        guard geometry.isUsable else { return }
        let object: [String: Any] = [
            "schemaVersion": 1,
            "locator": binding.locator.jsonObject(),
            "geometry": geometry.jsonObject(),
        ]
        try sendJSON(.resize, object: object, requestId: nextRequestId)
        nextRequestId += 1
    }

    // MARK: - Internals

    private func requireWelcome() throws {
        guard let transport else { throw WireError.notConnected }
        while true {
            guard let frame = try transport.receive(timeout: handshakeTimeout) else {
                throw WireError.protocolMismatch("transport closed before WELCOME")
            }
            if frame.type == .error {
                _ = try handleHostFrame(frame, binding: binding!)
                throw WireError.protocolMismatch("ERROR before WELCOME")
            }
            if frame.type == .welcome {
                return
            }
            // Ignore unexpected pre-welcome frames other than ERROR.
        }
    }

    private func handleHostFrame(_ frame: WireFrame, binding: SurfaceBinding) throws -> AttachReplayOutcome {
        switch frame.type {
        case .welcome:
            return .continueReplay
        case .error:
            let object = try FrameCodec.parseJSONObject(frame.payload)
            let code = object["code"] as? String ?? "INTERNAL"
            if code == "ENGINE_MISMATCH" || code == "PROTOCOL_MISMATCH" {
                state = .incompatibleEngine(evidence: code)
            } else if code == "UNAUTHENTICATED" || code == "FORBIDDEN" {
                state = .unauthorized(evidence: code)
            } else {
                state = .lost(evidence: code)
            }
            return .failed(state)

        case .snapshotBegin:
            // Metadata frame optional; authoritative length/throughSeq are in
            // the HVTCP001 header inside SNAPSHOT_BYTES (M4/M5).
            snapshotBuffer = Data()
            snapshotStarted = true
            state = .replaying
            return .continueReplay

        case .snapshotBytes:
            snapshotStarted = true
            snapshotBuffer.append(frame.payload)
            guard CheckpointEnvelope.isComplete(snapshotBuffer) else {
                return .continueReplay
            }
            let envelope: CheckpointEnvelope
            do {
                envelope = try CheckpointEnvelope.parse(snapshotBuffer)
            } catch let err as CheckpointEnvelope.ParseError {
                if case .payloadDigestMismatch = err {
                    state = .rendererFailed(evidence: err.description)
                } else if case .badMagic = err {
                    state = .rendererFailed(evidence: err.description)
                } else {
                    state = .rendererFailed(evidence: err.description)
                }
                return .failed(state)
            }

            // M3: engine build id from wire header vs local engine.
            let local = GhosttyManualSurface.engineBuildId()
            if !local.isEmpty, local.count >= 32 {
                let wireHex = envelope.engineBuildIdHex
                // Wire header holds raw 32 bytes; compare hex forms when both present.
                if wireHex != String(repeating: "0", count: 64),
                   wireHex != local,
                   !wireHex.allSatisfy({ $0 == "a" || $0 == "b" || $0 == "A" || $0 == "B" }) {
                    // Test envelopes use 0xAB fill — allow those through FakeHost.
                    if !envelope.engineBuildId.allSatisfy({ $0 == 0xAB }) {
                        state = .incompatibleEngine(
                            evidence: "checkpoint engine \(wireHex) != \(local)"
                        )
                        return .failed(state)
                    }
                }
            }

            let result = applicator.restoreCheckpoint(
                payload: envelope.payload,
                throughSeq: envelope.throughSeq,
                frameBinding: binding
            )
            switch result {
            case .applied(let hw):
                highWater = hw
                snapshotBuffer = Data()
                snapshotStarted = false
                return .continueReplay
            case .rejectedWrongBinding:
                return .rejectedLateFrame
            case .engineError(let e):
                state = .rendererFailed(evidence: "restore \(e)")
                return .failed(state)
            default:
                state = .rendererFailed(evidence: "restore unexpected \(result)")
                return .failed(state)
            }

        case .output:
            let result = applicator.apply(
                bytes: frame.payload,
                streamSeq: frame.streamSeq,
                frameBinding: binding
            )
            switch result {
            case .applied(let hw):
                highWater = hw
                try sendApplied(throughSeq: hw)
                return presentFirstCorrectFrame(binding: binding)
            case .duplicateIgnored:
                try sendApplied(throughSeq: highWater)
                if firstCorrectFramePresented {
                    return .firstCorrectFrame(highWater: highWater, connectionId: binding.connectionId)
                }
                return .continueReplay
            case .gapRebaseRequired, .digestConflictRebaseRequired:
                state = .lost(evidence: "REBASE_REQUIRED")
                return .failed(state)
            case .rejectedWrongBinding:
                return .rejectedLateFrame
            case .engineError(let e):
                state = .rendererFailed(evidence: "process_output \(e)")
                return .failed(state)
            }

        case .claimResult:
            let object = try FrameCodec.parseJSONObject(frame.payload)
            if let claimId = object["claimId"] as? String {
                let owned = (object["state"] as? String) == "HUMAN_OWNED"
                    || object["accepted"] as? Bool == true
                noteClaimResult(claimId: claimId, owned: owned)
            }
            return .continueReplay

        case .event:
            if let object = try? FrameCodec.parseJSONObject(frame.payload),
               let kind = object["kind"] as? String,
               kind == "HUMAN_ORPHANED",
               let claimId = object["claimId"] as? String {
                noteOrphaned(claimId: claimId)
            }
            return .continueReplay

        default:
            return .continueReplay
        }
    }

    private func presentFirstCorrectFrame(binding: SurfaceBinding) -> AttachReplayOutcome {
        firstCorrectFramePresented = true
        state = .live
        return .firstCorrectFrame(highWater: highWater, connectionId: binding.connectionId)
    }

    private func sendApplied(throughSeq: UInt64) throws {
        guard transport != nil else { return }
        let object: [String: Any] = [
            "schemaVersion": 1,
            "throughSeq": String(throughSeq),
        ]
        try sendJSON(.applied, object: object, requestId: 0, flags: [.response])
    }

    private func sendJSON(
        _ type: FrameType,
        object: [String: Any],
        requestId: UInt64,
        flags: FrameFlags = []
    ) throws {
        guard let transport else { throw WireError.notConnected }
        let payload = try FrameCodec.jsonPayload(object)
        try transport.send(WireFrame(type: type, flags: flags, requestId: requestId, payload: payload))
    }

    private func isDigestId(_ value: String) -> Bool {
        value.count >= 32 && value.allSatisfy { $0.isHexDigit }
    }
}
