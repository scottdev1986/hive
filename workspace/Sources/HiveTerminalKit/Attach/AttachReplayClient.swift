import Foundation

public enum AttachReplayOutcome: Equatable, Sendable {
    case firstCorrectFrame(highWater: UInt64, connectionId: String)
    case failed(TerminalSurfaceState)
    case rejectedLateFrame
    case continueReplay
}

public final class AttachReplayClient {
    private struct PendingResizeRequest {
        let binding: SurfaceBinding
        let geometry: TerminalGeometry
    }

    public private(set) var state: TerminalSurfaceState = .starting
    public private(set) var binding: SurfaceBinding?
    public private(set) var highWater: UInt64 = 0
    public private(set) var inputSubmissionState: InputSubmissionState = .idle
    public private(set) var firstCorrectFramePresented = false
    public var onInputSubmissionStateChange: ((InputSubmissionState) -> Void)?

    public let viewerId: String
    public let applicator: OutputRangeApplicator
    private let engine: ManualSurfaceEngine
    private var transport: HostTransport?
    private var nextRequestId: UInt64 = 1
    private var attachRequestId: UInt64?
    private var snapshotBuffer = Data()
    private var snapshotStarted = false
    private var resizeRevision: UInt64 = 0
    private var pendingResizeRequests: [UInt64: PendingResizeRequest] = [:]
    private let inputRouteLock = NSLock()
    private var inputTransport: HostTransport?
    private var pendingInput = Data()
    /// Last host answer to a RESIZE, e.g. "applied 61x39" or "stale currentRevision=2" — the host refuses resizes silently on the wire, so the outcome must be observable here.
    public private(set) var lastResizeResult: String?

    /// Handshake receive timeout: fail closed rather than HOST_ATTACH blind.
    public var handshakeTimeout: TimeInterval = 5.0

    /// Serializes replay and UI state. Interactive input deliberately does not
    /// take this lock; it must not wait behind a large output chunk's VT parse.
    private let stateLock = NSRecursiveLock()

    /// UI-observable state, read atomically so the view can mirror it onto the main thread after an off-main frame application.
    struct UISnapshot {
        let state: TerminalSurfaceState
        let highWater: UInt64
        let inputSubmissionState: InputSubmissionState
    }

    func uiSnapshot() -> UISnapshot {
        locked {
            UISnapshot(
                state: state,
                highWater: highWater,
                inputSubmissionState: inputSubmissionState
            )
        }
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        stateLock.lock()
        defer { stateLock.unlock() }
        return try body()
    }

    init(viewerId: String, engine: ManualSurfaceEngine) {
        self.viewerId = viewerId
        self.engine = engine
        self.applicator = OutputRangeApplicator(engine: engine)
        engine.callbackContext.onWrite = { [weak self] bytes in
            self?.handleEncodedWrite(bytes)
        }
    }

    /// Attach using a grant already obtained (broker path is outside this client).
    @discardableResult
    public func attach(
        grant: AttachGrant,
        geometry: TerminalGeometry,
        afterSeq: UInt64,
        transport: HostTransport
    ) throws -> AttachReplayOutcome {
        stateLock.lock()
        defer { stateLock.unlock() }
        // Fail CLOSED — never restore when local engine id is unknown or mismatched.
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
        prepareInputRoute(for: grant.locator)
        self.binding = binding
        resetInputState()
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

        try requireWelcome()

        let hostAttach: [String: Any] = [
            "schemaVersion": 1,
            "locator": grant.locator.jsonObject(),
            "token": grant.token,
            "geometry": geometry.jsonObject(),
            "afterSeq": String(afterSeq),
        ]
        attachRequestId = nextRequestId
        try sendJSON(.hostAttach, object: hostAttach, requestId: nextRequestId)
        nextRequestId += 1
        state = .replaying

        var restoredCheckpoint = false
        while true {
            let frame: WireFrame
            do {
                guard let next = try transport.receive(timeout: handshakeTimeout) else {
                    break // closed
                }
                frame = next
            } catch WireError.receiveTimeout {
                break
            }
            let outcome = try autoreleasepool {
                try handleHostFrame(frame, binding: binding)
            }
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
        stateLock.lock()
        defer { stateLock.unlock() }
        transport?.close()
        transport = nil
        prepareInputRoute(for: newBinding.locator)
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
        stateLock.lock()
        defer { stateLock.unlock() }
        transport?.close()
        transport = nil
        deactivateInputRoute()
        state = failure
        resetInputState()
    }

    public func handleFrame(_ frame: WireFrame, frameBinding: SurfaceBinding) throws -> AttachReplayOutcome {
        stateLock.lock()
        defer { stateLock.unlock() }
        return try autoreleasepool {
            guard let binding else { return .rejectedLateFrame }
            if frameBinding != binding { return .rejectedLateFrame }
            return try handleHostFrame(frame, binding: binding)
        }
    }

    public func handleEncodedWrite(_ bytes: Data) {
        guard !bytes.isEmpty else { return }
        inputRouteLock.lock()
        defer { inputRouteLock.unlock() }
        guard let transport = inputTransport, !transport.isClosed else {
            pendingInput.append(bytes)
            return
        }
        if let unsent = sendInput(bytes, through: transport) {
            inputTransport = nil
            pendingInput.append(unsent)
        }
    }

    public func sendResize(_ geometry: TerminalGeometry) throws {
        stateLock.lock()
        defer { stateLock.unlock() }
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

    private func logResizeResult(_ geometry: TerminalGeometry) {
        NSLog(
            "hive-terminal RESIZE %dx%d result: %@",
            geometry.columns,
            geometry.rows,
            lastResizeResult ?? "nil"
        )
    }

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
        }
    }

    private func handleHostFrame(_ frame: WireFrame, binding: SurfaceBinding) throws -> AttachReplayOutcome {
        switch frame.type {
        case .welcome:
            return .continueReplay
        case .attachReady:
            guard frame.requestId == attachRequestId,
                  frame.flags == [.response, .final],
                  frame.payload.isEmpty else {
                throw WireError.malformedFrame("invalid ATTACH_READY")
            }
            return presentFirstCorrectFrame(binding: binding)
        case .error:
            let object = try FrameCodec.parseJSONObject(frame.payload)
            let code = object["code"] as? String ?? "INTERNAL"
            if let pending = pendingResizeRequests[frame.requestId],
               pending.binding == binding {
                pendingResizeRequests.removeValue(forKey: frame.requestId)
                lastResizeResult =
                    "error \(code): \(object["message"] as? String ?? "host refused terminal resize")"
                logResizeResult(pending.geometry)
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

            // Fail CLOSED — wire engineBuildId must equal local engine (no test sentinels).
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

        case .applied:
            if let pending = pendingResizeRequests[frame.requestId],
               pending.binding == binding {
                pendingResizeRequests.removeValue(forKey: frame.requestId)
                guard let object = try? FrameCodec.parseJSONObject(frame.payload) else {
                    lastResizeResult = "unknown malformed resize receipt"
                    logResizeResult(pending.geometry)
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
                logResizeResult(pending.geometry)
                return .continueReplay
            }
            return .continueReplay

        case .event:
            return .continueReplay

        default:
            return .continueReplay
        }
    }

    private func presentFirstCorrectFrame(binding: SurfaceBinding) -> AttachReplayOutcome {
        firstCorrectFramePresented = true
        state = .live
        if let transport, transport.connectionId == binding.connectionId {
            activateInputRoute(through: transport)
        }
        return .firstCorrectFrame(highWater: highWater, connectionId: binding.connectionId)
    }

    private func sessionReference(_ locator: SessionLocator) -> [String: Any] {
        [
            "key": locator.sessionId,
            "incarnation": String(locator.generation),
        ]
    }

    private func resetInputState() {
        pendingResizeRequests.removeAll()
        setInputSubmissionState(.idle)
        lastResizeResult = nil
    }

    private func prepareInputRoute(for locator: SessionLocator) {
        inputRouteLock.lock()
        inputTransport = nil
        if let currentLocator = binding?.locator, currentLocator != locator {
            pendingInput.removeAll(keepingCapacity: false)
        }
        inputRouteLock.unlock()
    }

    private func deactivateInputRoute() {
        inputRouteLock.lock()
        inputTransport = nil
        inputRouteLock.unlock()
    }

    private func activateInputRoute(through transport: HostTransport) {
        inputRouteLock.lock()
        defer { inputRouteLock.unlock() }
        guard !transport.isClosed else { return }
        inputTransport = transport
        guard !pendingInput.isEmpty else { return }

        let queued = pendingInput
        pendingInput.removeAll(keepingCapacity: true)
        if let unsent = sendInput(queued, through: transport) {
            inputTransport = nil
            pendingInput.append(unsent)
        }
    }

    /// Returns the suffix that was not accepted so reconnect can retry it
    /// without duplicating chunks already handed to the transport.
    private func sendInput(_ bytes: Data, through transport: HostTransport) -> Data? {
        var offset = 0
        while offset < bytes.count {
            let end = min(offset + FrameCodec.streamChunkMaxBytes, bytes.count)
            do {
                try transport.sendInput(bytes.subdata(in: offset..<end))
            } catch {
                return bytes.subdata(in: offset..<bytes.count)
            }
            offset = end
        }
        return nil
    }

    private func setInputSubmissionState(_ newState: InputSubmissionState) {
        inputSubmissionState = newState
        onInputSubmissionStateChange?(newState)
    }

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
