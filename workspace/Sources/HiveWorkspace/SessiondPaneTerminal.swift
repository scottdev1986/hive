import AppKit
import HiveTerminalKit
import WorkspaceCore

/// Drives one pane's `HiveTerminalView` against the pane's EXACT sessiond
/// session (B2.2: attach + live output; input is B2.3).
///
/// The fence is the invariant: every attach uses the exact `sessionLocator`
/// held by the pane — never a name lookup — and a grant whose locator differs
/// from the pane's is refused before any byte reaches the surface. Renderer
/// recreation re-attaches to the SAME exact generation with a fresh one-use
/// grant, resuming at the acknowledged high-water.
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
    /// Reserved for conditions retrying cannot fix. A recoverable loss must
    /// never land here: a resting "renderer disconnected" pane is the defect
    /// #90 rules out.
    private(set) var gaveUp = false
    /// The current failure reason while degraded or given up (nil while live).
    private(set) var lastFailure: String?
    let failuresBeforeDegraded = 6
    let reconnectDelay: TimeInterval = 1.0
    private var recoveryTimer: Timer?
    /// Fired once after repeated completed failures. Retrying continues.
    var onDegraded: ((String) -> Void)?
    /// Fired when an attach goes live again after a degraded stretch.
    var onRecovered: (() -> Void)?
    /// Fired once for a condition retrying cannot fix, with evidence.
    var onFailure: ((String) -> Void)?

    /// Grant acquisition, overridable by the smoke harness: runs
    /// `hive workspace-attach` and returns the raw grant JSON line.
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

    /// The pane's exact locator projected onto the wire locator type.
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

    /// Creates the production surface. Throws when the pinned engine library
    /// cannot be loaded; the pane then keeps its native failure representation.
    func makeView() throws -> HiveTerminalView {
        let terminal = try HiveTerminalView(frame: .zero, viewerId: viewerId)
        terminal.autoresizingMask = [.width, .height]
        view = terminal
        return terminal
    }

    /// Starts immediately with the surface's current size or a conventional
    /// 80×24 terminal. Later layout changes use the normal resize path.
    func start() {
        guard !hasStarted, !detached else { return }
        hasStarted = true
        // Apply C1 theme BEFORE attach so journal replay paints onto the
        // themed surface. applyHiveConfiguration after processOutput can
        // wipe the VT (blank pane while journal is full — hubert finding).
        view?.prepareThemeBeforeAttach()
        beginAttach(afterSeq: 0)
    }

    /// Renderer detach only: the logical pane, the session, and the daemon's
    /// close/kill authority are untouched (§26 — detach never claims close).
    func detach() {
        detached = true
        stopRecovery()
        // #40: clean release before transport close so host claim does not orphan.
        view?.releaseClaimBestEffort()
        transport?.close()
        transport = nil
    }

    // MARK: - Attach machinery

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
                // Client-side fence: the grant must name the pane's exact
                // locator (the daemon already fenced; verify anyway).
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
            let outcome = try view.attach(
                grant: grant,
                geometry: geometry,
                afterSeq: afterSeq,
                transport: transport
            )
            if case .failed(let state) = outcome {
                transport.close()
                NSLog("sessiond surface attach for %@ failed: %@", agentName, "\(state)")
                if case .incompatibleEngine(let evidence) = state {
                    // The app's engine build id cannot change while the app
                    // runs, so no number of retries can make this grant match.
                    failAttach("incompatible engine: \(evidence)")
                    return
                }
                recordRecoverableFailure("attach failed: \(state)")
                return
            }
            noteLiveAttach()
            startPump(
                transport: transport,
                binding: SurfaceBinding(locator: grant.locator, connectionId: transport.connectionId)
            )
        } catch {
            NSLog("sessiond surface attach for %@ refused: %@", agentName, "\(error)")
            transport.close()
            recordRecoverableFailure("\(error)")
        }
    }

    /// Cap on frames applied per main-queue turn: bounds how long one
    /// coalesced output burst occupies the main queue before a keystroke
    /// block can interleave (32 × 64 KiB = 2 MiB worst case per turn).
    private static let maxFramesPerMainQueueTurn = 32

    /// Background frame pump: live OUTPUT keeps flowing after the attach
    /// handshake returns. Frames apply on the main thread through the
    /// locator-fenced view entry; transport loss triggers a re-attach to the
    /// SAME exact generation at the applied high-water.
    private func startPump(transport: UdsHostTransport, binding: SurfaceBinding) {
        let thread = Thread { [weak self] in
            while true {
                guard let self, !self.detached, !transport.isClosed else { return }
                do {
                    guard let first = try transport.receive(timeout: 1.0) else {
                        break // orderly close
                    }
                    // Coalesce: drain everything already buffered behind
                    // `first` and apply it in ONE main-queue block. Per-frame
                    // dispatch let a scrollback flood queue hundreds of blocks
                    // ahead of keystrokes, which also take a main-queue hop.
                    // Order is preserved and acks still fire from
                    // pumpHostFrame in applied order — only the main-queue
                    // block count changes.
                    let batch = transport.drainAvailableFrames(
                        first: first,
                        maxFrames: Self.maxFramesPerMainQueueTurn
                    )
                    DispatchQueue.main.async {
                        for frame in batch.frames {
                            self.view?.pumpHostFrame(frame, frameBinding: binding)
                        }
                    }
                    if batch.hostClosed { break }
                } catch let error as WireError {
                    if case .receiveTimeout = error { continue }
                    break
                } catch {
                    break
                }
            }
            guard let self else { return }
            transport.close()
            DispatchQueue.main.async {
                guard !self.detached, self.transport === transport else { return }
                self.recordRecoverableFailure("host transport lost")
            }
        }
        thread.name = "sessiond-pump-\(agentName)"
        thread.start()
    }

    private func recordRecoverableFailure(_ evidence: String) {
        guard !gaveUp, !detached else { return }
        // Before the first live attach there is nothing to reconnect. The
        // daemon publishes a root as running only after host creation, so an
        // initial refusal is a real launch/contract failure and retrying it
        // forever merely hides the evidence.
        guard hasAttachedSuccessfully else {
            failAttach(evidence)
            return
        }
        reconnectFailures += 1
        lastFailure = evidence
        if reconnectFailures >= failuresBeforeDegraded, !degraded {
            degraded = true
            NSLog(
                "sessiond pane %@ degraded after %d failed attaches: %@; retrying every %.0fs",
                agentName, reconnectFailures, evidence, reconnectDelay
            )
            onDegraded?(evidence)
        }
        scheduleReconnect()
    }

    /// Test seam for the small recovery state machine.
    func recordReconnectFailureForTesting(_ evidence: String) {
        recordRecoverableFailure(evidence)
    }

    /// An attach went live. Clears the budget so a later transient loss starts
    /// fresh, and lifts a degraded pane back to healthy.
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

    /// One completed failure schedules one fresh-grant reconnect. The attempt
    /// itself schedules the next retry only if it fails, so there is no second
    /// timer-driven state machine racing the attach chain.
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

    // MARK: - Grant subprocess

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

enum SessiondPaneTerminalError: Error, CustomStringConvertible {
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
}
