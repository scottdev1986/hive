import Foundation

/// Outcome of an attach/replay attempt (§09/§20/§26).
public enum AttachReplayOutcome: Equatable, Sendable {
    case firstCorrectFrame(highWater: UInt64, connectionId: String)
    case failed(TerminalSurfaceState)
    case rejectedLateFrame
    /// Frame handled; attach/replay continues (not a terminal outcome).
    case continueReplay
}

/// L2 attach/replay client: speaks the §20 viewer wire to a HOST.
///
/// Sequence (§09/§20):
/// 1. HELLO (viewer role + grant token)
/// 2. WELCOME
/// 3. HOST_ATTACH (locator, token, geometry, afterSeq)
/// 4. SNAPSHOT_BEGIN + SNAPSHOT_BYTES → `restore_checkpoint_v1`
/// 5. OUTPUT frames in order → `process_output_v1`
/// 6. APPLIED high-water acknowledgements
///
/// Built against an injected `HostTransport` (FakeHost in tests). The real
/// WP4 host binding is the L3 seam on `HostTransport` — not this type.
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
    private var snapshotThroughSeq: UInt64?
    private var snapshotExpectedLength: Int?
    private var activeClaimId: String?
    private var inputSequence: UInt64 = 0

    /// Resize quiescence: §26 one host resize after 100 ms.
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
    /// `transport` is the host connection for this attach (FakeHost or L3 UDS).
    @discardableResult
    public func attach(
        grant: AttachGrant,
        geometry: TerminalGeometry,
        afterSeq: UInt64,
        transport: HostTransport
    ) throws -> AttachReplayOutcome {
        self.transport = transport
        state = .attaching
        firstCorrectFramePresented = false
        snapshotBuffer = Data()
        snapshotThroughSeq = nil
        snapshotExpectedLength = nil

        let binding = SurfaceBinding(locator: grant.locator, connectionId: transport.connectionId)
        self.binding = binding
        applicator.bind(binding, highWater: afterSeq)
        highWater = afterSeq

        // HELLO
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

        // Drain until WELCOME (FakeHost responds synchronously via queued frames).
        try drain(until: { frame in frame.type == .welcome })

        // HOST_ATTACH
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

        // Process snapshot + output until first correct frame (high-water advances
        // through checkpoint and/or contiguous output).
        var restoredCheckpoint = false
        while true {
            guard let frame = try transport.receive() else { break }
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
                // Snapshot complete when buffer was restored (handleHostFrame clears it).
                if frame.type == .snapshotBytes,
                   snapshotThroughSeq != nil,
                   snapshotBuffer.isEmpty {
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
        // Empty host with only welcome — still no correct frame evidence.
        state = .delayed(evidence: "attach drained without snapshot/output")
        return .failed(state)
    }

    /// Retarget: new binding invalidates old connection frames (§26).
    public func retarget(newBinding: SurfaceBinding, highWater: UInt64 = 0) {
        transport?.close()
        transport = nil
        binding = newBinding
        applicator.bind(newBinding, highWater: highWater)
        self.highWater = highWater
        firstCorrectFramePresented = false
        state = .attaching
        snapshotBuffer = Data()
        snapshotThroughSeq = nil
        snapshotExpectedLength = nil
    }

    /// Deliver a host frame after attach (live stream). Late frames for an
    /// obsolete binding are rejected and never applied.
    public func handleFrame(_ frame: WireFrame, frameBinding: SurfaceBinding) throws -> AttachReplayOutcome {
        guard let binding else {
            return .rejectedLateFrame
        }
        if frameBinding != binding {
            return .rejectedLateFrame
        }
        return try handleHostFrame(frame, binding: binding)
    }

    /// §22 claim-bound write path: Ghostty encoder output → HUMAN_INPUT.
    public func handleEncodedWrite(_ bytes: Data) {
        guard let transport, let binding, let claimId = activeClaimId else { return }
        // Claim-bound HUMAN_INPUT is raw bytes with streamSeq = claim-local sequence.
        let seq = inputSequence
        inputSequence += 1
        let frame = WireFrame(
            type: .humanInput,
            flags: [.contentSensitive],
            requestId: 0,
            streamSeq: seq,
            payload: bytes
        )
        // Tag is conceptual: host validates claim; we still only send on owned claim.
        _ = claimId
        _ = binding
        try? transport.send(frame)
    }

    /// Acquire human claim before authoring input (§22).
    public func beginClaimAcquire() throws {
        guard let transport else { throw WireError.notConnected }
        let payload: [String: Any] = [
            "schemaVersion": 1,
            "viewerId": viewerId,
        ]
        try sendJSON(.claimAcquire, object: payload, requestId: nextRequestId)
        nextRequestId += 1
        _ = transport
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

    // MARK: - Internals

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
            let object = try FrameCodec.parseJSONObject(frame.payload)
            guard let throughString = object["throughSeq"] as? String,
                  let through = UInt64(throughString)
            else {
                throw WireError.malformedPayload("SNAPSHOT_BEGIN.throughSeq")
            }
            snapshotThroughSeq = through
            snapshotBuffer = Data()
            if let length = object["payloadLength"] as? Int {
                snapshotExpectedLength = length
            } else if let length = object["payloadLength"] as? NSNumber {
                snapshotExpectedLength = length.intValue
            } else {
                snapshotExpectedLength = nil
            }
            state = .replaying
            return .continueReplay

        case .snapshotBytes:
            snapshotBuffer.append(frame.payload)
            if let expected = snapshotExpectedLength, snapshotBuffer.count < expected {
                return .continueReplay
            }
            guard let through = snapshotThroughSeq else {
                throw WireError.malformedPayload("SNAPSHOT_BYTES without BEGIN")
            }
            let result = applicator.restoreCheckpoint(
                payload: snapshotBuffer,
                throughSeq: through,
                frameBinding: binding
            )
            switch result {
            case .applied(let hw):
                highWater = hw
                snapshotBuffer = Data()
                // First correct frame may wait for trailing OUTPUT; if host ends
                // at checkpoint, attach() presents after drain.
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
            // Session events may project orphaned claim (§22).
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
        // §26: first correct frame does NOT steal first responder.
        return .firstCorrectFrame(highWater: highWater, connectionId: binding.connectionId)
    }

    private func sendApplied(throughSeq: UInt64) throws {
        // Live-only path after retarget may have no transport; applying still
        // advances high-water — APPLIED is best-effort on the open connection.
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

    private func drain(until predicate: (WireFrame) -> Bool) throws {
        guard let transport else { throw WireError.notConnected }
        while let frame = try transport.receive() {
            if frame.type == .error {
                _ = try handleHostFrame(frame, binding: binding!)
                throw WireError.protocolMismatch("error during handshake")
            }
            if predicate(frame) { return }
        }
    }
}
