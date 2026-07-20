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
    private var geometryPollTimer: Timer?

    /// §26 bounded recovery: consecutive failed attach attempts. Reset to 0 on
    /// each first-correct-frame so a later transient loss gets a fresh budget.
    private var failedAttempts = 0
    private(set) var gaveUp = false
    /// The terminal failure reason once recovery is exhausted (nil while live
    /// or still retrying).
    private(set) var lastFailure: String?
    let maxAttachAttempts = 6
    let baseRetryDelay: TimeInterval = 0.5
    let maxRetryDelay: TimeInterval = 8.0
    /// A single self-rescheduling recovery driver: each one-shot tick advances
    /// the give-up budget and reschedules the next tick at an EXPONENTIAL delay
    /// — independent of the attach outcome, so a raced/stalled attempt can
    /// never strand the pane before give-up fires.
    private var recoveryTimer: Timer?
    /// Test seam: a fixed tick delay so the give-up path runs without the
    /// exponential wall-clock. Production leaves this nil (real backoff).
    var recoveryIntervalOverride: TimeInterval?
    /// Fired once when recovery is exhausted (bounded give-up), with evidence.
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

    /// Begins attaching once the surface has measured a usable grid. Geometry
    /// is grant-bound (§19), so the attach waits for the engine's real
    /// font/grid measurement rather than guessing from bounds.
    func startWhenGeometryReady() {
        guard geometryPollTimer == nil, !detached else { return }
        let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] timer in
            guard let self else {
                timer.invalidate()
                return
            }
            if self.detached {
                timer.invalidate()
                self.geometryPollTimer = nil
                return
            }
            guard let geometry = self.view?.reportedGeometry, geometry.isUsable else { return }
            timer.invalidate()
            self.geometryPollTimer = nil
            // Apply C1 theme BEFORE attach so journal replay paints onto the
            // themed surface. applyHiveConfiguration after processOutput can
            // wipe the VT (blank pane while journal is full — hubert finding).
            self.view?.prepareThemeBeforeAttach()
            self.beginAttach(afterSeq: 0)
        }
        geometryPollTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    /// Renderer detach only: the logical pane, the session, and the daemon's
    /// close/kill authority are untouched (§26 — detach never claims close).
    func detach() {
        detached = true
        geometryPollTimer?.invalidate()
        geometryPollTimer = nil
        stopRecovery()
        // #40: clean release before transport close so host claim does not orphan.
        view?.releaseClaimBestEffort()
        transport?.close()
        transport = nil
    }

    // MARK: - Attach machinery

    private func beginAttach(afterSeq: UInt64) {
        guard !detached, !attachInFlight, !gaveUp else { return }
        guard let geometry = view?.reportedGeometry, geometry.isUsable else { return }
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
                    self.beginRecovery("\(error)")
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
                beginRecovery("attach failed: \(state)")
                return
            }
            // Live: a first-correct-frame ends recovery and clears the budget so
            // a later transient loss starts fresh.
            stopRecovery()
            failedAttempts = 0
            startPump(
                transport: transport,
                binding: SurfaceBinding(locator: grant.locator, connectionId: transport.connectionId)
            )
        } catch {
            NSLog("sessiond surface attach for %@ refused: %@", agentName, "\(error)")
            transport.close()
            beginRecovery("\(error)")
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
                self.beginRecovery("host transport lost")
            }
        }
        thread.name = "sessiond-pump-\(agentName)"
        thread.start()
    }

    /// Registers a failed attach attempt and reports whether another retry is
    /// authorized. After `maxAttachAttempts` consecutive failures it records a
    /// terminal, user-visible failure and returns false — never an infinite
    /// silent loop. Idempotent once given up.
    func registerFailedAttemptAndShouldRetry(_ evidence: String) -> Bool {
        guard !gaveUp, !detached else { return false }
        failedAttempts += 1
        if failedAttempts > maxAttachAttempts {
            failAttach(evidence)
            return false
        }
        return true
    }

    private func failAttach(_ evidence: String) {
        guard !gaveUp else { return }
        gaveUp = true
        lastFailure = evidence
        NSLog("sessiond pane %@ gave up after %d attach attempts: %@",
              agentName, maxAttachAttempts, evidence)
        view?.markAttachFailed(evidence)
        onFailure?(evidence)
    }

    /// Starts (or keeps) the single repeating recovery driver. Each tick counts
    /// one attempt toward the give-up budget and, when nothing is already in
    /// flight, kicks a fresh attach. Because the timer ticks independently of
    /// the attach chain, a stalled/raced individual attempt can never strand
    /// the pane — the budget still runs out and give-up fires visibly.
    /// Exponential backoff for the given zero-based attempt index (0.5, 1, 2,
    /// 4, 8, 8, …), capped at `maxRetryDelay`. Extracted so the escalating
    /// shape is deterministically unit-testable — a flat/fixed interval
    /// (the regression) fails the timing test.
    func retryDelay(forAttempt attempt: Int) -> TimeInterval {
        let scaled = baseRetryDelay * pow(2, Double(max(0, attempt)))
        return min(scaled, maxRetryDelay)
    }

    /// Test seam: drive recovery directly (no live attach needed).
    func startRecoveryForTesting(_ evidence: String) { beginRecovery(evidence) }

    private func beginRecovery(_ evidence: String) {
        guard !detached, !gaveUp, recoveryTimer == nil else { return }
        scheduleRecoveryTick(evidence)
    }

    private func scheduleRecoveryTick(_ evidence: String) {
        guard !detached, !gaveUp else { return }
        let delay = recoveryIntervalOverride ?? retryDelay(forAttempt: failedAttempts)
        let timer = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
            guard let self, !self.detached, !self.gaveUp else {
                self?.recoveryTimer = nil
                return
            }
            guard self.registerFailedAttemptAndShouldRetry(evidence) else {
                self.recoveryTimer = nil
                return // gave up — visible failure fired
            }
            if !self.attachInFlight {
                self.view?.prepareThemeBeforeAttach()
                self.beginAttach(afterSeq: self.view?.highWater ?? 0)
            }
            // Always reschedule the next tick, independent of the attach
            // outcome, at the escalating backoff for the next attempt.
            self.scheduleRecoveryTick(evidence)
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
