import AppKit
import HiveTerminalKit
import WorkspaceCore

/// Drives one pane's `HiveTerminalView` against the pane's EXACT sessiond session, including attach, live output, and input. The fence is the invariant: every attach uses the exact `sessionLocator` held by the pane — never a name lookup — and a grant whose locator differs from the pane's is refused before any byte reaches the surface. Renderer recreation re-attaches to the SAME exact generation with a fresh one-use grant, resuming at the acknowledged high-water.
final class SessiondPaneTerminal {
    let agentName: String
    let paneLocator: AgentSessionLocator
    private let hivePath: String
    private let daemonPort: Int
    private let instanceHome: String
    private let viewerId: String

    private(set) var view: HiveTerminalView?
    private var transport: UdsHostTransport?
    private var detached = false
    private var attachInFlight = false
    private(set) var hasStarted = false

    private var reconnectFailures = 0
    private var hasAttachedSuccessfully = false
    private(set) var degraded = false
    /// Reserved for conditions retrying cannot fix. A recoverable loss must never land here: a resting "renderer disconnected" pane is a defect. Retryable failures remain visible without permanently giving up.
    private(set) var gaveUp = false
    private(set) var lastFailure: String?
    let failuresBeforeDegraded = 6
    let reconnectDelay: TimeInterval = 1.0
    private var recoveryTimer: Timer?
    var onDegraded: ((String) -> Void)?
    var onRecovered: (() -> Void)?
    /// Fired once for a condition retrying cannot fix, with evidence.
    var onFailure: ((String) -> Void)?

    var requestGrant: (_ geometryJSON: String) throws -> String

    init(
        agentName: String,
        locator: AgentSessionLocator,
        hivePath: String,
        daemonPort: Int,
        instanceHome: String
    ) {
        self.agentName = agentName
        self.paneLocator = locator
        self.hivePath = hivePath
        self.daemonPort = daemonPort
        self.instanceHome = instanceHome
        self.viewerId = "workspace-pane-\(agentName)"
        self.requestGrant = { _ in "" }
        self.requestGrant = { [weak self] geometryJSON in
            guard let self else { throw SessiondPaneTerminalError.detached }
            return try self.runWorkspaceAttach(geometryJSON: geometryJSON)
        }
    }

    deinit {
        detach()
    }

    var wireLocator: SessionLocator {
        SessionLocator(
            schemaVersion: paneLocator.schemaVersion,
            instanceId: paneLocator.instanceId,
            subjectKind: paneLocator.subject.kind,
            agentId: paneLocator.subject.agentId,
            generation: paneLocator.generation,
            sessionId: paneLocator.sessionId,
            hostKind: paneLocator.hostKind,
            engineBuildId: paneLocator.engineBuildId
        )
    }

    /// Creates the production surface. Throws when the pinned engine library cannot be loaded; the pane then keeps its native failure representation.
    func makeView() throws -> HiveTerminalView {
        let terminal = try HiveTerminalView(frame: .zero, viewerId: viewerId)
        terminal.autoresizingMask = [.width, .height]
        view = terminal
        return terminal
    }

    func start() {
        guard !hasStarted, !detached else { return }
        hasStarted = true
        view?.prepareThemeBeforeAttach()
        beginAttach(afterSeq: 0)
    }

    /// Renderer detach only: the logical pane, the session, and the daemon's close/kill authority are untouched. Detach never claims close.
    func detach() {
        detached = true
        stopRecovery()
        transport?.close()
        transport = nil
    }

    private func beginAttach(afterSeq: UInt64) {
        guard !detached, !attachInFlight, !gaveUp else { return }
        let reported = view?.reportedGeometry
        let geometry = reported?.isUsable == true ? reported! : Self.defaultGeometry
        attachInFlight = true
        let geometryJSON = Self.encodeGeometry(geometry)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let grantLine = try self.requestGrant(geometryJSON)
                let grant = try Self.parseGrant(grantLine)
                // Client-side fence: the grant must name the pane's exact locator (the daemon already fenced; verify anyway).
                guard grant.locator == self.wireLocator else {
                    throw SessiondPaneTerminalError.grantLocatorMismatch
                }
                let transport = try UdsHostTransport.connect(endpoint: grant.endpoint)
                DispatchQueue.main.async {
                    self.completeAttach(
                        grant: grant,
                        geometry: geometry,
                        afterSeq: afterSeq,
                        transport: transport
                    )
                }
            } catch {
                NSLog("sessiond attach for %@ failed: %@", self.agentName, "\(error)")
                DispatchQueue.main.async {
                    self.attachInFlight = false
                    self.recordRecoverableFailure("\(error)")
                }
            }
        }
    }

    private func completeAttach(
        grant: AttachGrant,
        geometry: TerminalGeometry,
        afterSeq: UInt64,
        transport: UdsHostTransport
    ) {
        attachInFlight = false
        guard !detached, let view else {
            transport.close()
            return
        }
        self.transport?.close()
        self.transport = transport
        do {
            // The handshake runs OFF main. `AttachReplayClient.attach` blocks in `transport.receive` until the host sends a frame or the 5 second handshake timeout expires, and a terminal that has produced nothing yet sends nothing — so on main that is a five-second frozen workspace per pane, serially. Measured with real vendor TUIs on real PTYs (prototypes/terminal, proto-viewer): two such panes stalled the main queue for 10,000 ms; off main the worst stall in the same run was 1.9 ms. Only the fence and publish stay on main so panes attach concurrently.
            let client = try view.prepareAttach(
                grant: grant,
                afterSeq: afterSeq,
                transport: transport
            )
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let result = Result {
                    try client.attach(
                        grant: grant,
                        geometry: geometry,
                        afterSeq: afterSeq,
                        transport: transport
                    )
                }
                DispatchQueue.main.async {
                    self?.publishAttach(
                        result,
                        client: client,
                        grant: grant,
                        geometry: geometry,
                        transport: transport
                    )
                }
            }
        } catch {
            NSLog("sessiond surface attach for %@ refused: %@", agentName, "\(error)")
            transport.close()
            recordRecoverableFailure("\(error)")
        }
    }

    private func publishAttach(
        _ result: Result<AttachReplayOutcome, Error>,
        client: AttachReplayClient,
        grant: AttachGrant,
        geometry: TerminalGeometry,
        transport: UdsHostTransport
    ) {
        guard !detached, let view, self.transport === transport else {
            transport.close()
            return
        }
        do {
            let outcome = try result.get()
            try view.finishAttach(outcome, client: client, geometry: geometry)
            if case .failed(let state) = outcome {
                transport.close()
                NSLog("sessiond surface attach for %@ failed: %@", agentName, "\(state)")
                if case .incompatibleEngine(let evidence) = state {
                    // The app's engine build id cannot change while the app runs, so no number of retries can make this grant match.
                    failAttach("incompatible engine: \(evidence)")
                    return
                }
                recordRecoverableFailure("attach failed: \(state)")
                return
            }
            noteLiveAttach()
            startPump(
                transport: transport,
                binding: SurfaceBinding(locator: grant.locator, connectionId: transport.connectionId),
                view: view
            )
        } catch {
            NSLog("sessiond surface attach for %@ refused: %@", agentName, "\(error)")
            transport.close()
            recordRecoverableFailure("\(error)")
        }
    }

    /// Background frame pump: live OUTPUT keeps flowing after the attach handshake returns. Frames apply on THIS thread through the locator-fenced view entry; transport loss triggers a re-attach to the SAME exact generation at the applied high-water. `view` is captured here, on the main thread, rather than read from `self.view` inside the loop: the pump applies frames on its own thread and must not touch main-thread-owned properties.
    private func startPump(
        transport: UdsHostTransport,
        binding: SurfaceBinding,
        view: HiveTerminalView
    ) {
        let thread = Thread { [weak self, weak view] in
            var disconnectEvidence = "host transport ended"
            while true {
                guard let self, !self.detached else { return }
                // Weak so a live pump thread cannot outlive and retain the pane view; a torn-down view ends the pump like a transport loss.
                guard let view else { return }
                if transport.isClosed {
                    disconnectEvidence =
                        transport.failureEvidence ?? "host transport closed without EOF"
                    break
                }
                do {
                    guard let first = try transport.receive(timeout: 1.0) else {
                        disconnectEvidence =
                            transport.failureEvidence ?? "host closed the viewer stream (EOF)"
                        break // orderly close
                    }
                    // Apply on THIS thread. The VT parse is the expensive part (~milliseconds per 64 KiB chunk) and it no longer touches the main queue at all, so output volume cannot delay a keystroke. pumpHostFrame mirrors the cheap UI state to main on its own. Do not coalesce frames off the main queue: applying one at a time keeps the client's lock hold short so a keystroke can overtake queued output instead of waiting out a batch.
                    view.pumpHostFrame(first, frameBinding: binding)
                } catch let error as WireError {
                    if case .receiveTimeout = error { continue }
                    disconnectEvidence =
                        transport.failureEvidence ?? "viewer read failed: \(error)"
                    break
                } catch {
                    disconnectEvidence = "viewer read failed: \(error)"
                    break
                }
            }
            guard let self else { return }
            transport.close()
            let finalDisconnectEvidence = disconnectEvidence
            DispatchQueue.main.async {
                guard !self.detached, self.transport === transport else { return }
                let evidence =
                    "\(finalDisconnectEvidence); connection=\(transport.connectionId); " +
                    "highWater=\(self.view?.highWater ?? 0)"
                NSLog("sessiond viewer transport for %@ lost: %@", self.agentName, evidence)
                self.recordRecoverableFailure(evidence)
            }
        }
        thread.name = "sessiond-pump-\(agentName)"
        thread.start()
    }

    private func recordRecoverableFailure(_ evidence: String) {
        guard !gaveUp, !detached else { return }
        lastFailure = evidence
        // Before the first successful frame this is still the initial attach, not a disconnected renderer. Keep it pending and retry without presenting a false reconnect state.
        if hasAttachedSuccessfully {
            reconnectFailures += 1
            if reconnectFailures >= failuresBeforeDegraded, !degraded {
                degraded = true
                NSLog(
                    "sessiond pane %@ degraded after %d failed attaches: %@; retrying every %.0fs",
                    agentName, reconnectFailures, evidence, reconnectDelay
                )
                onDegraded?(evidence)
            }
        }
        scheduleReconnect()
    }

    func recordReconnectFailureForTesting(_ evidence: String) {
        recordRecoverableFailure(evidence)
    }

    /// An attach went live. Clears the budget so a later transient loss starts fresh, and lifts a degraded pane back to healthy.
    func noteLiveAttach() {
        hasAttachedSuccessfully = true
        stopRecovery()
        reconnectFailures = 0
        lastFailure = nil
        guard degraded else { return }
        degraded = false
        NSLog("sessiond pane %@ recovered", agentName)
        onRecovered?()
    }

    /// Stops for good. Reserved for conditions retrying cannot fix.
    private func failAttach(_ evidence: String) {
        guard !gaveUp else { return }
        gaveUp = true
        lastFailure = evidence
        stopRecovery()
        NSLog("sessiond pane %@ cannot recover: %@", agentName, evidence)
        view?.markAttachFailed(evidence)
        onFailure?(evidence)
    }

    /// One completed failure schedules one fresh-grant reconnect. The attempt itself schedules the next retry only if it fails, so there is no second timer-driven state machine racing the attach chain.
    private func scheduleReconnect() {
        guard !detached, !gaveUp, recoveryTimer == nil else { return }
        let timer = Timer(timeInterval: reconnectDelay, repeats: false) { [weak self] _ in
            guard let self, !self.detached, !self.gaveUp else {
                self?.recoveryTimer = nil
                return
            }
            self.recoveryTimer = nil
            if !self.attachInFlight {
                self.view?.prepareThemeBeforeAttach()
                self.beginAttach(afterSeq: self.view?.highWater ?? 0)
            }
        }
        recoveryTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func stopRecovery() {
        recoveryTimer?.invalidate()
        recoveryTimer = nil
    }

    private func runWorkspaceAttach(geometryJSON: String) throws -> String {
        guard let encoded = try? JSONEncoder().encode(paneLocator),
              let locatorJSON = String(data: encoded, encoding: .utf8) else {
            throw SessiondPaneTerminalError.locatorEncodingFailed
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: hivePath)
        process.arguments = [
            "workspace-attach", agentName,
            "--port", String(daemonPort),
            "--session-locator", locatorJSON,
            "--viewer-id", viewerId,
            "--geometry", geometryJSON,
        ]
        var environment = ProcessInfo.processInfo.environment
        environment["HIVE_HOME"] = instanceHome
        process.environment = environment
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let reason = String(
                data: stderr.fileHandleForReading.readDataToEndOfFile(),
                encoding: .utf8
            ) ?? ""
            throw SessiondPaneTerminalError.grantRefused(reason)
        }
        let output = String(
            data: stdout.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        ) ?? ""
        guard let line = output.split(whereSeparator: \.isNewline).last else {
            throw SessiondPaneTerminalError.grantRefused("empty grant output")
        }
        return String(line)
    }

    private static func parseGrant(_ line: String) throws -> AttachGrant {
        guard let data = line.data(using: .utf8),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SessiondPaneTerminalError.grantRefused("grant is not a JSON object")
        }
        return try AttachGrant.parse(object)
    }

    private static func encodeGeometry(_ geometry: TerminalGeometry) -> String {
        let object: [String: Any] = geometry.jsonObject()
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
            ?? Data("{}".utf8)
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    private static let defaultGeometry = TerminalGeometry(
        columns: 80,
        rows: 24,
        widthPx: 800,
        heightPx: 480,
        cellWidthPx: 10,
        cellHeightPx: 20
    )
}

enum SessiondPaneTerminalError: Error, LocalizedError, CustomStringConvertible {
    case detached
    case locatorEncodingFailed
    case grantLocatorMismatch
    case grantRefused(String)

    var description: String {
        switch self {
        case .detached: return "sessiond terminal is detached"
        case .locatorEncodingFailed: return "could not encode the pane's session locator"
        case .grantLocatorMismatch:
            return "attach grant names a different session generation than this pane"
        case .grantRefused(let reason): return "attach grant refused: \(reason)"
        }
    }

    var errorDescription: String? { description }
}
