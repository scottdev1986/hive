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
    private struct PendingInputBatch {
        let binding: SurfaceBinding
        let bytes: Data
    }

    private struct PendingInputRequest {
        let binding: SurfaceBinding
        let transactionId: String
        /// Retained so a transient rejection (expired claim) can be resubmitted
        /// under a fresh claim instead of dropping the user's keystrokes.
        let bytes: Data
    }

    private struct PendingResizeRequest {
        let binding: SurfaceBinding
        let geometry: TerminalGeometry
    }

    public private(set) var state: TerminalSurfaceState = .starting
    public private(set) var binding: SurfaceBinding?
    public private(set) var highWater: UInt64 = 0
    public private(set) var claimPresentation: InputClaimPresentation = .free
    public private(set) var inputSubmissionState: InputSubmissionState = .idle
    public private(set) var firstCorrectFramePresented = false
    public var onInputSubmissionStateChange: ((InputSubmissionState) -> Void)?

    public let viewerId: String
    public let applicator: OutputRangeApplicator
    private let engine: ManualSurfaceEngine
    private var transport: HostTransport?
    private var nextRequestId: UInt64 = 1
    private var snapshotBuffer = Data()
    private var snapshotStarted = false
    private var activeClaimToken: String?
    private var claimRequestId: UInt64?
    private var claimRetryScheduled = false
    private var pendingInputBatches: [PendingInputBatch] = []
    private var pendingInputRequests: [UInt64: PendingInputRequest] = [:]
    private var releaseAfterPendingInputRequested = false
    private var inputFenced = false
    private var inputSequence: UInt64 = 0
    private var resizeRevision: UInt64 = 0
    private var pendingResizeRequests: [UInt64: PendingResizeRequest] = [:]
    /// Last host answer to a RESIZE, e.g. "applied 61x39" or
    /// "stale currentRevision=2" — the host refuses resizes silently on the
    /// wire, so the outcome must be observable here.
    public private(set) var lastResizeResult: String?

    /// Handshake receive timeout (§09): fail closed rather than HOST_ATTACH blind.
    public var handshakeTimeout: TimeInterval = 5.0
    /// After WELCOME, idle gap means end of pre-queued attach stream (L3 UDS
    /// would keep reading; FakeHost finishes with idle).
    public var streamIdleTimeout: TimeInterval = 0.15

    public static let resizeQuiescenceNanos: UInt64 = 100_000_000
    private static let claimRetryDelay: TimeInterval = 0.05

    init(viewerId: String, engine: ManualSurfaceEngine) {
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
        // M3: fail CLOSED — never restore when local engine id is unknown or mismatched.
        let localEngine = HiveTerminalEngineIdentity.current.buildId
        if localEngine.isEmpty {
            state = .incompatibleEngine(evidence: "local engine build id unavailable")
            return .failed(state)
        }
        if grant.engineBuildId != localEngine {
            state = .incompatibleEngine(
                evidence: "grant \(grant.engineBuildId) != local \(localEngine)"
            )
            return .failed(state)
        }
        if let locEngine = grant.locator.engineBuildId, locEngine != localEngine {
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
        resetInputState()
        if !grant.operations.contains("human-input") {
            refuseInput(code: "FORBIDDEN", evidence: "attach grant does not authorize human input")
        }
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

    func retarget(newBinding: SurfaceBinding, highWater: UInt64 = 0) {
        releaseClaimBestEffort()
        transport?.close()
        transport = nil
        binding = newBinding
        resetInputState()
        applicator.bind(newBinding, highWater: highWater)
        self.highWater = highWater
        firstCorrectFramePresented = false
        state = .attaching
        snapshotBuffer = Data()
        snapshotStarted = false
    }

    func failDeferredPresentation(_ failure: TerminalSurfaceState) {
        releaseClaimBestEffort()
        transport?.close()
        transport = nil
        state = failure
        resetInputState()
    }

    /// Clean CLAIM_RELEASE (cancel) before closing the viewer transport (#40).
    /// Best-effort: transport may already be half-dead; host also clears on drop.
    public func releaseClaimBestEffort() {
        guard let token = activeClaimToken, let binding, transport != nil else {
            // A skip with a claim still held leaves the host holding a human
            // claim nobody will ever release, and every daemon inject is denied
            // HumanOrphaned from then on — the 2026-07-21 messaging regression.
            // Today no path reaches here holding one; if one ever does, it says
            // so instead of returning in silence.
            if let stranded = activeClaimToken {
                NSLog(
                    "hive claim: release SKIPPED with claim held token=%@ viewer=%@; host claim will orphan",
                    stranded,
                    viewerId
                )
            }
            return
        }
        let payload: [String: Any] = [
            "schemaVersion": 1,
            "session": sessionReference(binding.locator),
            "claimToken": token,
            "kind": "cancel",
        ]
        do {
            try sendJSON(.claimRelease, object: payload, requestId: nextRequestId)
            nextRequestId += 1
            NSLog("hive claim: release cancel token=%@ viewer=%@", token, viewerId)
        } catch {
            NSLog("hive claim: release send failed viewer=%@ error=%@", viewerId, "\(error)")
        }
        activeClaimToken = nil
        claimRequestId = nil
        claimPresentation = .free
    }

    /// End an IME composition without leaving its human claim behind. The
    /// release waits for both accepted input and an in-flight claim result so a
    /// late grant cannot become an orphaned host-side claim.
    public func releaseAfterPendingInput() {
        releaseAfterPendingInputRequested = true
        // The encoder callback may be queued just behind the NSTextInputClient
        // composition-end callback. Let that write enqueue before deciding a
        // cancellation had no committed input.
        DispatchQueue.main.async { [weak self] in
            self?.releaseClaimIfInputQuiescent()
        }
    }

    public func handleFrame(_ frame: WireFrame, frameBinding: SurfaceBinding) throws -> AttachReplayOutcome {
        guard let binding else { return .rejectedLateFrame }
        if frameBinding != binding { return .rejectedLateFrame }
        return try handleHostFrame(frame, binding: binding)
    }

    /// Gate 8 encoder output is held until this exact binding owns a human
    /// claim, then submitted through the frozen INPUT_SUBMIT JSON operation.
    public func handleEncodedWrite(_ bytes: Data) {
        guard !bytes.isEmpty, !inputFenced, let binding, transport != nil else { return }
        if bytes.count > FrameCodec.inputTransactionMaxBytes {
            var offset = 0
            while offset < bytes.count {
                let end = min(offset + FrameCodec.inputTransactionMaxBytes, bytes.count)
                handleEncodedWrite(bytes.subdata(in: offset..<end))
                offset = end
            }
            return
        }
        let batch = PendingInputBatch(binding: binding, bytes: bytes)
        if activeClaimToken == nil {
            pendingInputBatches.append(batch)
            do {
                try beginClaimAcquire()
            } catch {
                refuseInput(code: "CLAIM_FAILED", evidence: String(describing: error))
            }
            return
        }
        submitInput(batch)
    }

    public func beginClaimAcquire() throws {
        guard !inputFenced else { return }
        guard let binding, transport != nil else { throw WireError.notConnected }
        guard activeClaimToken == nil, claimRequestId == nil else { return }
        let requestId = nextRequestId
        let payload: [String: Any] = [
            "schemaVersion": 1,
            "session": sessionReference(binding.locator),
            "writer": viewerId,
            "kind": "human",
            "leaseMilliseconds": 60_000,
            "idempotencyKey": "claim-\(UUID().uuidString)",
        ]
        try sendJSON(.claimAcquire, object: payload, requestId: requestId)
        claimRequestId = requestId
        nextRequestId += 1
        setInputSubmissionState(.waitingForClaim)
    }

    /// The host orphaned this viewer's claim. It is the human's own claim and
    /// the host readmits a returning human through operatorResume, so the write
    /// path stays armed: the next keystroke re-acquires and resumes (#87).
    public func noteOrphaned(claimId: String) {
        activeClaimToken = nil
        claimPresentation = .humanOrphaned(viewerId: viewerId, claimId: claimId)
        setInputSubmissionState(pendingInputBatches.isEmpty ? .idle : .waitingForClaim)
        scheduleClaimRetry()
    }

    /// Frozen RESIZE request after geometry quiescence (M10).
    public func sendResize(_ geometry: TerminalGeometry) throws {
        guard let binding else { throw WireError.notConnected }
        guard geometry.isUsable else { return }
        resizeRevision += 1
        let object: [String: Any] = [
            "schemaVersion": 1,
            "session": sessionReference(binding.locator),
            "window": [
                "columns": geometry.columns,
                "rows": geometry.rows,
                "widthPixels": geometry.widthPx,
                "heightPixels": geometry.heightPx,
            ],
            "revision": String(resizeRevision),
            "idempotencyKey": "resize-\(viewerId)-\(binding.generation)-\(resizeRevision)",
        ]
        pendingResizeRequests[nextRequestId] = PendingResizeRequest(
            binding: binding,
            geometry: geometry
        )
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
            if let pending = pendingResizeRequests[frame.requestId],
               pending.binding == binding {
                pendingResizeRequests.removeValue(forKey: frame.requestId)
                lastResizeResult =
                    "error \(code): \(object["message"] as? String ?? "host refused terminal resize")"
                NSLog(
                    "hive-terminal RESIZE %dx%d result: %@",
                    pending.geometry.columns,
                    pending.geometry.rows,
                    lastResizeResult ?? "nil"
                )
                return .continueReplay
            }
            if frame.requestId == claimRequestId || pendingInputRequests[frame.requestId] != nil {
                if frame.requestId == claimRequestId {
                    claimRequestId = nil
                    pendingInputBatches.removeAll()
                }
                pendingInputRequests.removeValue(forKey: frame.requestId)
                activeClaimToken = nil
                refuseInput(
                    code: code,
                    evidence: object["message"] as? String ?? "host refused terminal input"
                )
                releaseClaimIfInputQuiescent()
                return .continueReplay
            }
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

            // M3: fail CLOSED — wire engineBuildId must equal local engine (no test sentinels).
            let local = HiveTerminalEngineIdentity.current.buildId
            if local.isEmpty {
                state = .incompatibleEngine(evidence: "local engine build id unavailable")
                return .failed(state)
            }
            let wireHex = envelope.engineBuildIdHex
            if wireHex != local {
                state = .incompatibleEngine(
                    evidence: "checkpoint engine \(wireHex) != \(local)"
                )
                return .failed(state)
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
            guard frame.requestId == claimRequestId else { return .continueReplay }
            claimRequestId = nil
            let object = try FrameCodec.parseJSONObject(frame.payload)
            guard let result = object["result"] as? [String: Any],
                  let claimState = result["state"] as? String else {
                refuseInput(code: "MALFORMED_CLAIM_RESULT", evidence: "claim result has no state")
                releaseClaimIfInputQuiescent()
                return .continueReplay
            }
            if claimState == "granted",
               let claim = result["claim"] as? [String: Any],
               let token = claim["token"] as? String {
                claimRetryScheduled = false
                activeClaimToken = token
                claimPresentation = .humanOwned(viewerId: viewerId, claimId: token)
                NSLog("hive claim: granted token=%@ viewer=%@", token, viewerId)
                let batches = pendingInputBatches
                pendingInputBatches.removeAll()
                for batch in batches where batch.binding == binding {
                    submitInput(batch)
                }
            } else if claimState == "denied" {
                activeClaimToken = nil
                claimPresentation = .free
                let diagnostic = result["diagnostic"] as? String ?? "human input is owned elsewhere"
                NSLog("hive claim: denied viewer=%@ diagnostic=%@", viewerId, diagnostic)
                setInputSubmissionState(.waitingForClaim)
                scheduleClaimRetry()
            } else {
                activeClaimToken = nil
                claimPresentation = .free
                let diagnostic = result["diagnostic"] as? String ?? "human input claim is unknown"
                NSLog("hive claim: unknown viewer=%@ diagnostic=%@", viewerId, diagnostic)
                setInputSubmissionState(.waitingForClaim)
                scheduleClaimRetry()
            }
            releaseClaimIfInputQuiescent()
            return .continueReplay

        case .applied:
            if let pending = pendingResizeRequests[frame.requestId],
               pending.binding == binding {
                pendingResizeRequests.removeValue(forKey: frame.requestId)
                guard let object = try? FrameCodec.parseJSONObject(frame.payload) else {
                    lastResizeResult = "unknown malformed resize receipt"
                    NSLog(
                        "hive-terminal RESIZE %dx%d result: %@",
                        pending.geometry.columns,
                        pending.geometry.rows,
                        lastResizeResult ?? "nil"
                    )
                    return .continueReplay
                }
                let result = (object["resultKind"] as? String == "resize")
                    ? object["result"] as? [String: Any]
                    : nil
                let state = result?["state"] as? String ?? "malformed"
                switch state {
                case "applied":
                    let readback = result?["readback"] as? [String: Any]
                    lastResizeResult = "applied \(readback?["columns"] ?? "?")x\(readback?["rows"] ?? "?")"
                case "stale":
                    lastResizeResult =
                        "stale currentRevision=\(result?["currentRevision"] as? String ?? "?")"
                default:
                    lastResizeResult =
                        "\(state) \(result?["diagnostic"] as? String ?? "")"
                }
                NSLog(
                    "hive-terminal RESIZE %dx%d result: %@",
                    pending.geometry.columns,
                    pending.geometry.rows,
                    lastResizeResult ?? "nil"
                )
                return .continueReplay
            }
            guard let pending = pendingInputRequests[frame.requestId],
                  pending.binding == binding else { return .continueReplay }
            let object = try FrameCodec.parseJSONObject(frame.payload)
            guard object["resultKind"] as? String == "input",
                  let receipt = object["receipt"] as? [String: Any],
                  let transactionId = receipt["transactionId"] as? String,
                  transactionId == pending.transactionId,
                  let stage = receipt["stage"] as? String else {
                pendingInputRequests.removeValue(forKey: frame.requestId)
                inputFenced = true
                setInputSubmissionState(.unknown(evidence: "malformed or uncorrelated input receipt"))
                return .continueReplay
            }
            pendingInputRequests.removeValue(forKey: frame.requestId)
            if stage == "rejected" {
                let diagnostic = receipt["diagnostic"] as? String ?? "host rejected terminal input"
                // Host claim races are complete rejections, not unknown acts:
                // retain the bytes and submit them under a fresh claim. The
                // host still arbitrates every re-acquire, so this never steals.
                if [
                    "input claim unavailable",
                    "input claim expired",
                    "input claim fenced",
                ].contains(diagnostic) {
                    NSLog("hive claim: %@; re-acquiring and resubmitting viewer=%@", diagnostic, viewerId)
                    activeClaimToken = nil
                    pendingInputBatches.append(PendingInputBatch(
                        binding: pending.binding,
                        bytes: pending.bytes
                    ))
                    do {
                        try beginClaimAcquire()
                    } catch {
                        refuseInput(code: "CLAIM_FAILED", evidence: String(describing: error))
                    }
                } else {
                    refuseInput(code: "INPUT_REJECTED", evidence: diagnostic)
                }
            } else if stage == "unknown" {
                inputFenced = true
                setInputSubmissionState(.unknown(
                    evidence: receipt["diagnostic"] as? String ?? "terminal input result is unknown"
                ))
            } else {
                setInputSubmissionState(.applied(transactionId: transactionId, stage: stage))
                releaseClaimIfInputQuiescent()
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

    private func submitInput(_ batch: PendingInputBatch) {
        guard !inputFenced,
              let binding,
              binding == batch.binding,
              let transport,
              transport.connectionId == binding.connectionId,
              let claimToken = activeClaimToken else { return }
        let sequence = inputSequence
        inputSequence += 1
        let transactionId = "input-\(viewerId)-\(binding.generation)-\(sequence)"
        let requestId = nextRequestId
        let object: [String: Any] = [
            "schemaVersion": 1,
            "session": sessionReference(binding.locator),
            "claimToken": claimToken,
            "transactionId": transactionId,
            "idempotencyKey": transactionId,
            "operation": [
                "kind": "bytes",
                "encoding": "base64",
                "bytes": batch.bytes.base64EncodedString(),
            ],
        ]
        do {
            try sendJSON(
                .inputSubmit,
                object: object,
                requestId: requestId,
                flags: [.contentSensitive]
            )
            pendingInputRequests[requestId] = PendingInputRequest(
                binding: binding,
                transactionId: transactionId,
                bytes: batch.bytes
            )
            nextRequestId += 1
            setInputSubmissionState(.pending(transactionId: transactionId))
        } catch {
            inputFenced = true
            setInputSubmissionState(.unknown(evidence: "input send failed: \(error)"))
        }
    }

    private func sessionReference(_ locator: SessionLocator) -> [String: Any] {
        [
            "key": locator.sessionId,
            "incarnation": String(locator.generation),
        ]
    }

    private func resetInputState() {
        activeClaimToken = nil
        claimRequestId = nil
        claimRetryScheduled = false
        pendingInputBatches.removeAll()
        pendingInputRequests.removeAll()
        releaseAfterPendingInputRequested = false
        pendingResizeRequests.removeAll()
        inputFenced = false
        claimPresentation = .free
        setInputSubmissionState(.idle)
        lastResizeResult = nil
    }

    private func refuseInput(code: String, evidence: String) {
        inputFenced = true
        setInputSubmissionState(.refused(code: code, evidence: evidence))
    }

    /// A claim can be denied while an automation transaction is between BEGIN
    /// and COMMIT. Keep the original human bytes queued and re-ask after that
    /// short exclusive window instead of requiring another keystroke. The
    /// binding check prevents a delayed retry from crossing a reattach.
    private func scheduleClaimRetry() {
        guard !claimRetryScheduled,
              !inputFenced,
              !pendingInputBatches.isEmpty,
              activeClaimToken == nil,
              claimRequestId == nil,
              let retryBinding = binding,
              transport != nil else { return }
        claimRetryScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.claimRetryDelay) { [weak self] in
            guard let self,
                  self.claimRetryScheduled,
                  self.binding == retryBinding else { return }
            self.claimRetryScheduled = false
            do {
                try self.beginClaimAcquire()
            } catch {
                self.refuseInput(code: "CLAIM_FAILED", evidence: String(describing: error))
            }
        }
    }

    private func releaseClaimIfInputQuiescent() {
        guard releaseAfterPendingInputRequested,
              claimRequestId == nil,
              pendingInputRequests.isEmpty,
              pendingInputBatches.isEmpty else { return }
        releaseAfterPendingInputRequested = false
        releaseClaimBestEffort()
    }

    private func setInputSubmissionState(_ newState: InputSubmissionState) {
        inputSubmissionState = newState
        onInputSubmissionStateChange?(newState)
    }

    /// §20 output acknowledgement — the frozen APPLIED output branch. The
    /// native header validator requires a nonzero client request id on
    /// non-unsolicited frames, so acks spend their own request ids.
    private func sendApplied(throughSeq: UInt64) throws {
        guard transport != nil else { return }
        let object: [String: Any] = [
            "schemaVersion": 1,
            "resultKind": "output",
            "throughSeq": String(throughSeq),
        ]
        try sendJSON(.applied, object: object, requestId: nextRequestId)
        nextRequestId += 1
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

    }
