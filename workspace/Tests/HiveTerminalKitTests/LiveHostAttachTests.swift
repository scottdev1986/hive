import AppKit
import XCTest
@testable import HiveTerminalKit

/// B2.2 opt-in LIVE wire proof: the production Swift attach path
/// (`UdsHostTransport` + `AttachReplayClient` + `HiveTerminalView` fencing)
/// against a REAL sessiond host serving a live session.
///
/// Skipped unless `HIVE_B22_PROOF_HOME` names a home prepared by
/// `scripts/b22-live-attach-proof.ts` (which writes `b22-proof.json`). The
/// Most legs use a fake engine; the geometry leg uses a real Ghostty surface.
/// Pixels-on-glass acceptance remains the recorded Workspace session.
final class LiveHostAttachTests: XCTestCase {
    private final class RecordingTransport: HostTransport {
        let base: HostTransport
        private(set) var sent: [WireFrame] = []
        private(set) var received: [WireFrame] = []

        init(base: HostTransport) {
            self.base = base
        }

        var connectionId: String { base.connectionId }
        var isClosed: Bool { base.isClosed }

        func send(_ frame: WireFrame) throws {
            sent.append(frame)
            try base.send(frame)
        }

        func receive(timeout: TimeInterval?) throws -> WireFrame? {
            let frame = try base.receive(timeout: timeout)
            if let frame { received.append(frame) }
            return frame
        }

        func close() {
            base.close()
        }
    }

    private struct Proof: Decodable {
        let hiveCli: String
        let port: Int
        let agent: String
        let mode: String?
        let locator: ProofLocator
    }

    private struct ProofLocator: Decodable {
        let schemaVersion: Int
        let instanceId: String
        let subject: ProofSubject
        let generation: Int
        let sessionId: String
        let hostKind: String
        let engineBuildId: String?
    }

    private struct ProofSubject: Decodable {
        let kind: String
        let agentId: String?
    }

    private func loadProof() throws -> (Proof, String) {
        guard let home = ProcessInfo.processInfo.environment["HIVE_B22_PROOF_HOME"] else {
            throw XCTSkip("HIVE_B22_PROOF_HOME not set — live host attach proof is opt-in")
        }
        let descriptor = URL(fileURLWithPath: home).appendingPathComponent("b22-proof.json")
        let proof = try JSONDecoder().decode(Proof.self, from: Data(contentsOf: descriptor))
        return (proof, home)
    }

    private let geometry = TerminalGeometry(
        columns: 80,
        rows: 24,
        widthPx: 800,
        heightPx: 480,
        cellWidthPx: 10,
        cellHeightPx: 20
    )

    private func geometryJSON(_ geometry: TerminalGeometry? = nil) throws -> String {
        String(
            data: try JSONSerialization.data(
                withJSONObject: (geometry ?? self.geometry).jsonObject(),
                options: [.sortedKeys]
            ),
            encoding: .utf8
        )!
    }

    private func locatorJSON(_ locator: ProofLocator) throws -> String {
        var subject: [String: Any] = ["kind": locator.subject.kind]
        if let agentId = locator.subject.agentId { subject["agentId"] = agentId }
        let object: [String: Any] = [
            "schemaVersion": locator.schemaVersion,
            "instanceId": locator.instanceId,
            "subject": subject,
            "generation": locator.generation,
            "sessionId": locator.sessionId,
            "hostKind": locator.hostKind,
            "engineBuildId": locator.engineBuildId as Any,
        ]
        return String(
            data: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
            encoding: .utf8
        )!
    }

    private func issueGrant(
        _ proof: Proof,
        viewerId: String,
        generationOverride: Int? = nil,
        geometryOverride: TerminalGeometry? = nil
    ) throws -> (status: Int32, output: String) {
        var locator = proof.locator
        _ = locator
        var locatorLine = try locatorJSON(proof.locator)
        if let generationOverride {
            var object = try JSONSerialization.jsonObject(
                with: Data(locatorLine.utf8)
            ) as! [String: Any]
            object["generation"] = generationOverride
            locatorLine = String(
                data: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
                encoding: .utf8
            )!
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: proof.hiveCli)
        process.arguments = [
            "workspace-attach", proof.agent,
            "--port", String(proof.port),
            "--session-locator", locatorLine,
            "--viewer-id", viewerId,
            "--geometry", try geometryJSON(geometryOverride),
        ]
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        process.waitUntilExit()
        let out = String(
            data: stdout.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        ) ?? ""
        let err = String(
            data: stderr.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        ) ?? ""
        return (process.terminationStatus, process.terminationStatus == 0 ? out : err)
    }

    private func parseGrant(_ line: String) throws -> AttachGrant {
        let object = try JSONSerialization.jsonObject(
            with: Data(line.trimmingCharacters(in: .whitespacesAndNewlines).utf8)
        ) as! [String: Any]
        return try AttachGrant.parse(object)
    }

    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            if let event = NSApp.nextEvent(
                matching: .any,
                until: Date().addingTimeInterval(0.01),
                inMode: .default,
                dequeue: true
            ) {
                NSApp.sendEvent(event)
            }
        }
        return condition()
    }

    private func sendInProcessKeys(_ text: String, to window: NSWindow) throws {
        for character in text {
            let isReturn = character == "\n"
            let characters = isReturn ? "\r" : String(character)
            let event = try XCTUnwrap(NSEvent.keyEvent(
                with: .keyDown,
                location: .zero,
                modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber,
                context: nil,
                characters: characters,
                charactersIgnoringModifiers: characters,
                isARepeat: false,
                keyCode: isReturn ? 36 : 0
            ))
            window.sendEvent(event)
        }
    }

    private func pumpUntilOutput(
        _ marker: Data,
        view: HiveTerminalView,
        transport: RecordingTransport,
        binding: SurfaceBinding,
        timeout: TimeInterval = 10
    ) throws -> Data {
        var output = Data()
        let deadline = Date().addingTimeInterval(timeout)
        while output.range(of: marker) == nil, Date() < deadline {
            do {
                guard let frame = try transport.receive(timeout: 1.0) else { break }
                if frame.type == .output { output.append(frame.payload) }
                view.pumpHostFrame(frame, frameBinding: binding)
                RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            } catch WireError.receiveTimeout {
                continue
            }
        }
        return output
    }

    /// One flow, §20/§26 end to end: attach + replay + live ordered output +
    /// acknowledgements, then a second one-use grant re-attaches the SAME
    /// exact generation at the acknowledged high-water (renderer recreation)
    /// and the first connection is superseded. Finally a wrong-generation
    /// grant request is refused before any transport exists.
    func testLiveAttachReplayReconnectAndFence() throws {
        let (proof, home) = try loadProof()

        // Attach A from zero: checkpoint/replay + live push.
        let grantLine = try issueGrant(proof, viewerId: "b22-live-test")
        XCTAssertEqual(grantLine.status, 0, "grant refused: \(grantLine.output)")
        let grant = try parseGrant(grantLine.output)
        XCTAssertEqual(grant.locator.generation, proof.locator.generation)

        let engine = FakeManualSurface()
        let view = HiveTerminalView(frame: .zero, engine: engine, viewerId: "b22-live-test")
        let transportA = try UdsHostTransport.connect(endpoint: grant.endpoint)
        let outcome = try view.attach(
            grant: grant,
            geometry: geometry,
            afterSeq: 0,
            transport: transportA
        )
        guard case .firstCorrectFrame = outcome else {
            return XCTFail("attach did not reach first correct frame: \(outcome)")
        }
        XCTAssertEqual(view.surfaceState, .live)
        let replayHighWater = view.highWater
        XCTAssertGreaterThan(replayHighWater, 0)

        // Live push: the ticker keeps writing; pump frames until the applied
        // high-water advances beyond the replay point.
        let liveDeadline = Date().addingTimeInterval(10)
        while view.highWater <= replayHighWater, Date() < liveDeadline {
            guard let frame = try transportA.receive(timeout: 2.0) else { break }
            view.pumpHostFrame(frame, frameBinding: view.binding!)
        }
        XCTAssertGreaterThan(view.highWater, replayHighWater, "no live output arrived")
        let fedBytes = engine.appliedRanges.reduce(Data()) { $0 + $1.bytes }
        XCTAssertTrue(
            String(decoding: fedBytes, as: UTF8.self).contains("B2.2 LIVE"),
            "live ticker output did not reach the surface"
        )

        // Ordered-output digest: the bytes the surface applied must be exactly
        // the journal's leading bytes on disk (16-byte header + raw journal).
        let journalURL = URL(fileURLWithPath: home)
            .appendingPathComponent("runtime/sessiond/hosts")
            .appendingPathComponent(proof.locator.sessionId)
            .appendingPathComponent("journal.bin")
        let journal = try Data(contentsOf: journalURL)
        XCTAssertGreaterThanOrEqual(journal.count, 16 + fedBytes.count)
        XCTAssertEqual(
            journal.subdata(in: 16..<(16 + fedBytes.count)),
            fedBytes,
            "wire bytes diverged from the host journal"
        )

        // Renderer recreation (§26): a fresh one-use grant re-attaches the
        // SAME exact generation at the acknowledged high-water on the SAME
        // surface; the old connection is superseded by the host.
        let reconnectLine = try issueGrant(proof, viewerId: "b22-live-test")
        XCTAssertEqual(reconnectLine.status, 0, "reconnect grant refused: \(reconnectLine.output)")
        let reconnectGrant = try parseGrant(reconnectLine.output)
        let transportB = try UdsHostTransport.connect(endpoint: reconnectGrant.endpoint)
        let resumeSeq = view.highWater
        let reattach = try view.attach(
            grant: reconnectGrant,
            geometry: geometry,
            afterSeq: resumeSeq,
            transport: transportB
        )
        switch reattach {
        case .firstCorrectFrame, .continueReplay:
            break
        default:
            XCTFail("re-attach failed: \(reattach)")
        }

        // The superseded connection ends; frames stop and the stream closes.
        let supersededDeadline = Date().addingTimeInterval(10)
        var supersededClosed = false
        while Date() < supersededDeadline {
            do {
                if try transportA.receive(timeout: 1.0) == nil {
                    supersededClosed = true
                    break
                }
            } catch let error as WireError {
                if case .receiveTimeout = error { continue }
                supersededClosed = true
                break
            }
        }
        XCTAssertTrue(supersededClosed, "old connection was not superseded")

        // Live output continues contiguously on the new connection.
        let resumeDeadline = Date().addingTimeInterval(10)
        while view.highWater <= resumeSeq, Date() < resumeDeadline {
            guard let frame = try transportB.receive(timeout: 2.0) else { break }
            view.pumpHostFrame(frame, frameBinding: view.binding!)
        }
        XCTAssertGreaterThan(view.highWater, resumeSeq, "no output after re-attach")
        XCTAssertEqual(view.surfaceState, .live)
        transportB.close()

        // Locator fence: a wrong-generation grant request is refused at the
        // daemon with a typed reason before any viewer transport exists.
        let wrong = try issueGrant(
            proof,
            viewerId: "b22-live-test-wrong",
            generationOverride: proof.locator.generation + 1
        )
        XCTAssertNotEqual(wrong.status, 0)
        XCTAssertTrue(
            wrong.output.contains("session-locator-mismatch"),
            "wrong-generation refusal missing typed reason: \(wrong.output)"
        )
    }

    /// A4 opt-in process-bound renderer probe. The qualification driver kills
    /// the reference invocation after this test reports its PID, then launches
    /// the replay invocation against the same exact generation. Keeping this
    /// as a separate process makes renderer death real rather than a simulated
    /// transport close.
    func testA4RendererKillReplayProbe() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let phase = environment["HIVE_A4_RENDERER_PHASE"],
              let outputPath = environment["HIVE_A4_RENDERER_OUTPUT"],
              let reportPath = environment["HIVE_A4_RENDERER_REPORT"] else {
            throw XCTSkip("A4 renderer-kill probe is opt-in")
        }
        let (proof, _) = try loadProof()
        let grantLine = try issueGrant(proof, viewerId: "a4-renderer-\(phase)")
        XCTAssertEqual(grantLine.status, 0, "renderer grant refused: \(grantLine.output)")
        let grant = try parseGrant(grantLine.output)
        let engine = FakeManualSurface()
        let view = HiveTerminalView(
            frame: .zero, engine: engine, viewerId: "a4-renderer-\(phase)")
        let transport = try UdsHostTransport.connect(endpoint: grant.endpoint)
        let outcome = try view.attach(
            grant: grant, geometry: geometry, afterSeq: 0, transport: transport)
        guard case .firstCorrectFrame = outcome else {
            return XCTFail("renderer attach did not reach first correct frame: \(outcome)")
        }
        let applied = engine.appliedRanges.reduce(Data()) { $0 + $1.bytes }
        XCTAssertFalse(applied.isEmpty, "renderer received no replay bytes")

        let captured: Data
        switch phase {
        case "reference":
            captured = applied
        case "replay":
            guard let referencePath = environment["HIVE_A4_RENDERER_REFERENCE"] else {
                return XCTFail("replay phase has no reference capture")
            }
            let reference = try Data(contentsOf: URL(fileURLWithPath: referencePath))
            XCTAssertGreaterThanOrEqual(applied.count, reference.count)
            captured = Data(applied.prefix(reference.count))
            XCTAssertEqual(captured, reference, "reconnected renderer replay changed bytes")
        default:
            return XCTFail("unsupported A4 renderer phase: \(phase)")
        }

        try captured.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
        let report: [String: Any] = [
            "phase": phase,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "highWater": view.highWater,
            "bytes": captured.count,
        ]
        try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
            .write(to: URL(fileURLWithPath: reportPath), options: .atomic)

        if phase == "reference" {
            while true {
                RunLoop.current.run(until: Date().addingTimeInterval(1))
            }
        }
        transport.close()
    }

    /// B2.3 opt-in headless proof through the production Swift attach socket:
    /// a Gate 8 NSTextInputClient commit is held for CLAIM_RESULT, submitted as
    /// INPUT_SUBMIT, written to the live PTY, and returned as ordered OUTPUT.
    func testLiveGate8InputRoundTrip() throws {
        let (proof, _) = try loadProof()
        let grantLine = try issueGrant(proof, viewerId: "b23-live-input")
        XCTAssertEqual(grantLine.status, 0, "input grant refused: \(grantLine.output)")
        let grant = try parseGrant(grantLine.output)
        XCTAssertTrue(grant.operations.contains("human-input"))

        let engine = FakeManualSurface()
        let view = HiveTerminalView(frame: .zero, engine: engine, viewerId: "b23-live-input")
        let transport = try UdsHostTransport.connect(endpoint: grant.endpoint)
        let outcome = try view.attach(
            grant: grant,
            geometry: geometry,
            afterSeq: 0,
            transport: transport
        )
        guard case .firstCorrectFrame = outcome else {
            return XCTFail("input proof attach failed: \(outcome)")
        }
        let binding = try XCTUnwrap(view.binding)
        let sent = proof.mode == "shell"
            ? "echo $((123456 + 654321))"
            : "b23-byte-round-trip"
        view.insertText(
            "\(sent)\n",
            replacementRange: NSRange(location: NSNotFound, length: 0),
            associatedEvent: nil
        )
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))

        let expectedResponse = Data(
            (proof.mode == "shell" ? "777777" : "B2.3 RESPONSE:\(sent)").utf8
        )
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            let applied = engine.appliedRanges.reduce(Data()) { $0 + $1.bytes }
            if applied.range(of: expectedResponse) != nil { break }
            do {
                guard let frame = try transport.receive(timeout: 1.0) else { break }
                view.pumpHostFrame(frame, frameBinding: binding)
                RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            } catch WireError.receiveTimeout {
                continue
            }
        }
        let applied = engine.appliedRanges.reduce(Data()) { $0 + $1.bytes }
        XCTAssertNotNil(
            applied.range(of: expectedResponse),
            "byte-exact PTY response did not return over OUTPUT"
        )
        guard case .applied(_, let stage) = view.inputSubmissionState else {
            transport.close()
            return XCTFail("input did not receive correlated APPLIED: \(view.inputSubmissionState)")
        }
        XCTAssertEqual(stage, "written-to-terminal")
        transport.close()
    }

    /// B2.4 pinned-vttest path through the real sessiond PTY and authenticated
    /// human-input claim. The harness command must be run-pinned-vttest-b24.sh.
    /// Output is retained in this process as it arrives; the rolling sessiond
    /// journal is not read later as though it were unbounded history.
    func testLivePinnedVttestAlternateScreenPath() throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["HIVE_B24_VTTEST_LIVE"] == "1" else {
            throw XCTSkip("set HIVE_B24_VTTEST_LIVE=1 for the pinned-vttest path")
        }
        let transcriptPath = try XCTUnwrap(environment["HIVE_B24_VTTEST_TRANSCRIPT_PATH"])
        let bytesPath = try XCTUnwrap(environment["HIVE_B24_VTTEST_BYTES_PATH"])
        let screenshotPath = try XCTUnwrap(environment["HIVE_B24_VTTEST_SCREENSHOT_PATH"])
        let (proof, _) = try loadProof()
        guard proof.mode == "shell" else {
            throw XCTSkip("pinned vttest requires the live-shell harness mode")
        }

        _ = NSApplication.shared
        let view = try HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 660, height: 448),
            viewerId: "b24-vttest-live"
        )
        let window = NSWindow(
            contentRect: view.frame,
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Hive B2.4 · vttest 20251205"
        window.isReleasedWhenClosed = false
        window.contentView = view
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        XCTAssertTrue(window.makeFirstResponder(view))
        defer {
            view.userClose()
            window.orderOut(nil)
            window.contentView = nil
        }

        let grantLine = try issueGrant(proof, viewerId: "b24-vttest-live")
        XCTAssertEqual(grantLine.status, 0, "vttest grant refused: \(grantLine.output)")
        let grant = try parseGrant(grantLine.output)
        let transport = try UdsHostTransport.connect(endpoint: grant.endpoint)
        defer { transport.close() }
        let outcome = try view.attach(
            grant: grant,
            geometry: geometry,
            afterSeq: 0,
            transport: transport
        )
        guard case .firstCorrectFrame = outcome else {
            return XCTFail("vttest attach failed: \(outcome)")
        }
        let binding = try XCTUnwrap(view.binding)
        let surface = try XCTUnwrap(view.engine as? GhosttyManualSurface)
        let liveDeadline = Date().addingTimeInterval(3)
        while view.surfaceState != .live, Date() < liveDeadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        XCTAssertEqual(view.surfaceState, .live)
        XCTAssertTrue(
            surface.semanticSnapshot()?.text.contains("VT100 test program, version 2.7 (20251205)") == true,
            "positive control: the pinned vttest main menu must be in the initial replay"
        )

        var returnedOutput = Data()
        func pump(until predicate: () -> Bool, timeout: TimeInterval = 5) throws -> Bool {
            let deadline = Date().addingTimeInterval(timeout)
            while !predicate(), Date() < deadline {
                do {
                    guard let frame = try transport.receive(timeout: 1) else { break }
                    if frame.type == .output { returnedOutput.append(frame.payload) }
                    view.pumpHostFrame(frame, frameBinding: binding)
                    RunLoop.main.run(until: Date().addingTimeInterval(0.01))
                } catch WireError.receiveTimeout {
                    continue
                }
            }
            return predicate()
        }
        func submit(_ text: String) throws {
            for character in text {
                let isReturn = character == "\n"
                let characters = isReturn ? "\r" : String(character)
                let event = try XCTUnwrap(NSEvent.keyEvent(
                    with: .keyDown,
                    location: .zero,
                    modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: window.windowNumber,
                    context: nil,
                    characters: characters,
                    charactersIgnoringModifiers: characters,
                    isARepeat: false,
                    keyCode: isReturn ? 36 : 0
                ))
                view.keyDown(with: event)
            }
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
            XCTAssertNotEqual(
                view.inputSubmissionState,
                .idle,
                "positive control: Ghostty key encoding must reach the claim-bound write callback"
            )
        }

        // main 11 → non-VT100 8 → XTERM 7 → alternate-screen 5 (1049).
        try submit("11\n")
        guard try pump(until: {
            surface.semanticSnapshot()?.text.contains("Non-VT100 Tests") == true
        }) else {
            return XCTFail("vttest did not enter non-VT100 menu; input=\(view.inputSubmissionState)")
        }
        try submit("8\n")
        guard try pump(until: {
            surface.semanticSnapshot()?.text.contains("XTERM special features") == true
        }) else {
            return XCTFail("vttest did not enter XTERM menu; input=\(view.inputSubmissionState)")
        }
        try submit("7\n")
        guard try pump(until: {
            surface.semanticSnapshot()?.text.contains("XTERM Alternate-Screen features") == true
        }) else {
            return XCTFail("vttest did not enter alternate-screen menu; input=\(view.inputSubmissionState)")
        }
        try submit("5\n")
        guard try pump(until: {
            surface.semanticSnapshot()?.text.contains("The next screen will be filled with E's") == true
        }) else {
            return XCTFail("vttest did not enter 1049 test; input=\(view.inputSubmissionState)")
        }

        try submit("\n")
        guard try pump(until: {
            let text = surface.semanticSnapshot()?.text ?? ""
            return text.filter { $0 == "E" }.count > 1_000
        }) else {
            return XCTFail("vttest did not fill alternate screen; input=\(view.inputSubmissionState)")
        }
        let alternateSnapshot = try XCTUnwrap(surface.semanticSnapshot())
        let alternateECount = alternateSnapshot.text.filter { $0 == "E" }.count
        XCTAssertGreaterThan(alternateECount, 1_000)

        let capture = Process()
        capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        capture.arguments = ["-x", "-l", String(window.windowNumber), screenshotPath]
        try capture.run()
        capture.waitUntilExit()
        XCTAssertEqual(capture.terminationStatus, 0)

        try submit("\n")
        guard try pump(until: {
            surface.semanticSnapshot()?.text.contains(
                "The original screen should be restored except for this line."
            ) == true
        }) else {
            return XCTFail("vttest did not restore primary screen; input=\(view.inputSubmissionState)")
        }
        XCTAssertNotNil(returnedOutput.range(of: Data("\u{1B}[?1049h".utf8)))
        XCTAssertNotNil(returnedOutput.range(of: Data("\u{1B}[?1049l".utf8)))
        guard case .applied(_, let inputStage) = view.inputSubmissionState else {
            return XCTFail("vttest input did not receive correlated APPLIED: \(view.inputSubmissionState)")
        }
        XCTAssertEqual(inputStage, "written-to-terminal")
        try returnedOutput.write(to: URL(fileURLWithPath: bytesPath), options: .atomic)

        let evidence = """
        qualification=M1-B2 B2.4 pinned vttest alternate-screen path
        vttest_version=VT100 test program, version 2.7 (20251205)
        terminal=xterm-ghostty
        launch_geometry=24x80.80
        rendered_geometry=\(alternateSnapshot.geometry.rows)x\(alternateSnapshot.geometry.columns)
        menu_path=11/8/7/5 (non-VT100/XTERM/alternate-screen/1049)
        input_path=authenticated human claim + INPUT_SUBMIT/APPLIED
        input_receipt=\(view.inputSubmissionState)
        launch_termios_handoff=stty sane (canonical CR-to-NL state normally inherited from an interactive shell)
        alternate_e_count=\(alternateECount)
        decset_1049=observed
        decrst_1049=observed
        primary_restore=observed
        captured_output_bytes=\(returnedOutput.count)
        screenshot=\(screenshotPath)
        pixel_disposition=inspect screenshot; semantic success is not pixel proof
        """
        try (evidence + "\n").write(toFile: transcriptPath, atomically: true, encoding: .utf8)
    }

    /// #40 live proof: unclean transport drop orphans the human claim; a
    /// returning human viewer re-acquires via the sanctioned resume path and
    /// can type again. Clean CLAIM_RELEASE (cancel) is covered unit-side.
    func testLiveClaimUncleanDropThenHumanResumeTypes() throws {
        let (proof, _) = try loadProof()
        guard proof.mode == "shell" else {
            throw XCTSkip("#40 claim drop-reattach requires HIVE_B22_REAL_SHELL=1 shell home")
        }

        // Unique viewer ids so host input-replay idempotency keys do not collide
        // across test re-runs against a long-lived shell session.
        let runId = String(UInt32.random(in: 100_000...999_999))
        let viewerAId = "claim-drop-a-\(runId)"
        let viewerBId = "claim-drop-b-\(runId)"

        // --- Viewer A: acquire claim and land one INPUT_SUBMIT ---
        let grantALine = try issueGrant(proof, viewerId: viewerAId)
        XCTAssertEqual(grantALine.status, 0, "viewer-a grant refused: \(grantALine.output)")
        let grantA = try parseGrant(grantALine.output)
        let engineA = FakeManualSurface()
        let viewA = HiveTerminalView(frame: .zero, engine: engineA, viewerId: viewerAId)
        let transportA = try UdsHostTransport.connect(endpoint: grantA.endpoint)
        let outcomeA = try viewA.attach(
            grant: grantA,
            geometry: geometry,
            afterSeq: 0,
            transport: transportA
        )
        guard case .firstCorrectFrame(let hwA, _) = outcomeA else {
            transportA.close()
            return XCTFail("viewer-a attach failed: \(outcomeA)")
        }
        let bindingA = try XCTUnwrap(viewA.binding)
        let markerA = "hive-claim-a-\(runId)"
        viewA.insertText(
            "echo \(markerA)\n",
            replacementRange: NSRange(location: NSNotFound, length: 0),
            associatedEvent: nil
        )
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        let deadlineA = Date().addingTimeInterval(10)
        while Date() < deadlineA {
            if case .applied = viewA.inputSubmissionState { break }
            do {
                guard let frame = try transportA.receive(timeout: 1.0) else { break }
                viewA.pumpHostFrame(frame, frameBinding: bindingA)
            } catch WireError.receiveTimeout {
                continue
            }
        }
        guard case .applied = viewA.inputSubmissionState else {
            transportA.close()
            return XCTFail("viewer-a never got APPLIED: \(viewA.inputSubmissionState)")
        }
        // Unclean drop: tear the socket without CLAIM_RELEASE.
        transportA.close()
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))

        // --- Viewer B: returning human must resume and type ---
        let grantBLine = try issueGrant(proof, viewerId: viewerBId)
        XCTAssertEqual(grantBLine.status, 0, "viewer-b grant refused: \(grantBLine.output)")
        let grantB = try parseGrant(grantBLine.output)
        let engineB = FakeManualSurface()
        let viewB = HiveTerminalView(frame: .zero, engine: engineB, viewerId: viewerBId)
        let transportB = try UdsHostTransport.connect(endpoint: grantB.endpoint)
        defer { transportB.close() }
        // Full journal replay on reattach (afterSeq=0): avoids REBASE_REQUIRED
        // when the dropped viewer and host high-water race; the claim path is
        // independent of the output cursor.
        let outcomeB = try viewB.attach(
            grant: grantB,
            geometry: geometry,
            afterSeq: 0,
            transport: transportB
        )
        guard case .firstCorrectFrame = outcomeB else {
            return XCTFail("viewer-b attach failed: \(outcomeB) (viewer-a hw was \(hwA))")
        }
        let bindingB = try XCTUnwrap(viewB.binding)
        let markerB = "hive-claim-b-\(runId)"
        viewB.insertText(
            "echo \(markerB)\n",
            replacementRange: NSRange(location: NSNotFound, length: 0),
            associatedEvent: nil
        )
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        let deadlineB = Date().addingTimeInterval(10)
        while Date() < deadlineB {
            if case .applied = viewB.inputSubmissionState { break }
            do {
                guard let frame = try transportB.receive(timeout: 1.0) else { break }
                viewB.pumpHostFrame(frame, frameBinding: bindingB)
            } catch WireError.receiveTimeout {
                continue
            }
        }
        guard case .applied(_, let stage) = viewB.inputSubmissionState else {
            return XCTFail(
                "viewer-b did not resume/type after unclean drop: \(viewB.inputSubmissionState)"
            )
        }
        XCTAssertEqual(stage, "written-to-terminal")
        // Drain a few more OUTPUT frames for the echo (best-effort observability).
        let drainDeadline = Date().addingTimeInterval(3)
        while Date() < drainDeadline {
            let appliedB = engineB.appliedRanges.reduce(Data()) { $0 + $1.bytes }
            if appliedB.range(of: Data(markerB.utf8)) != nil { break }
            do {
                guard let frame = try transportB.receive(timeout: 0.5) else { break }
                viewB.pumpHostFrame(frame, frameBinding: bindingB)
            } catch WireError.receiveTimeout {
                continue
            }
        }
        let appliedB = engineB.appliedRanges.reduce(Data()) { $0 + $1.bytes }
        // Claim resume + INPUT applied is the #40 contract; echo is corroboration.
        if appliedB.range(of: Data(markerB.utf8)) == nil {
            NSLog(
                "hive claim live: marker echo not observed in OUTPUT (applied=%@ stage=%@) — claim resume still GREEN",
                String(describing: viewB.inputSubmissionState),
                stage
            )
        }
    }

    /// B2.4 opt-in live geometry proof: the real Ghostty grid, not the session
    /// fixture's 80x24 default, is sent through authenticated RESIZE before
    /// the attached login shell accepts input.
    func testLiveShellInitialResizeMatchesRenderedGeometry() throws {
        let (proof, _) = try loadProof()
        guard proof.mode == "shell" else {
            throw XCTSkip("real-shell geometry proof requires HIVE_B22_REAL_SHELL=1")
        }

        _ = NSApplication.shared
        let view = try HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 613, height: 347),
            viewerId: "b24-live-geometry"
        )
        defer { view.userClose() }
        let provisionalGeometry = try XCTUnwrap(view.reportedGeometry)
        XCTAssertFalse(
            provisionalGeometry.columns == geometry.columns && provisionalGeometry.rows == geometry.rows,
            "positive control requires a real non-80x24 rendered grid"
        )

        let grantLine = try issueGrant(
            proof,
            viewerId: "b24-live-geometry",
            geometryOverride: provisionalGeometry
        )
        XCTAssertEqual(grantLine.status, 0, "geometry grant refused: \(grantLine.output)")
        let grant = try parseGrant(grantLine.output)
        let transport = RecordingTransport(
            base: try UdsHostTransport.connect(endpoint: grant.endpoint)
        )
        defer { transport.close() }
        let outcome = try view.attach(
            grant: grant,
            geometry: provisionalGeometry,
            afterSeq: 0,
            transport: transport
        )
        guard case .firstCorrectFrame = outcome else {
            return XCTFail("geometry proof attach failed: \(outcome)")
        }
        let liveDeadline = Date().addingTimeInterval(3)
        while view.surfaceState != .live, Date() < liveDeadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        XCTAssertEqual(view.surfaceState, .live)
        let renderedGeometry = try XCTUnwrap(view.reportedGeometry)
        let surface = try XCTUnwrap(view.engine as? GhosttyManualSurface)
        let semanticGeometry = try XCTUnwrap(surface.semanticSnapshot()).geometry
        XCTAssertEqual(semanticGeometry.columns, renderedGeometry.columns)
        XCTAssertEqual(semanticGeometry.rows, renderedGeometry.rows)
        let binding = try XCTUnwrap(view.binding)

        view.insertText(
            "stty size",
            replacementRange: NSRange(location: NSNotFound, length: 0),
            associatedEvent: nil
        )
        let returnKey = try XCTUnwrap(NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: 0,
            context: nil,
            characters: "\r",
            charactersIgnoringModifiers: "\r",
            isARepeat: false,
            keyCode: 36
        ))
        view.keyDown(with: returnKey)
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))

        let expectedSize = Data("\(renderedGeometry.rows) \(renderedGeometry.columns)".utf8)
        var returnedOutput = Data()
        let deadline = Date().addingTimeInterval(10)
        while returnedOutput.range(of: expectedSize) == nil, Date() < deadline {
            do {
                guard let frame = try transport.receive(timeout: 1.0) else { break }
                if frame.type == .output { returnedOutput.append(frame.payload) }
                view.pumpHostFrame(frame, frameBinding: binding)
                RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            } catch WireError.receiveTimeout {
                continue
            }
        }
        XCTAssertNotNil(
            returnedOutput.range(of: expectedSize),
            "stty output \(String(decoding: returnedOutput, as: UTF8.self)) " +
                "did not match rendered grid \(renderedGeometry.rows) \(renderedGeometry.columns)"
        )

        let initialResize = try XCTUnwrap(
            transport.sent.first { $0.type == .resize },
            "attach did not send an initial authenticated RESIZE"
        )
        let resizeObject = try FrameCodec.parseJSONObject(initialResize.payload)
        let window = try XCTUnwrap(resizeObject["window"] as? [String: Any])
        XCTAssertEqual(window["columns"] as? Int, renderedGeometry.columns)
        XCTAssertEqual(window["rows"] as? Int, renderedGeometry.rows)
        XCTAssertEqual(window["widthPixels"] as? Int, renderedGeometry.widthPx)
        XCTAssertEqual(window["heightPixels"] as? Int, renderedGeometry.heightPx)
        XCTAssertEqual(resizeObject["revision"] as? String, "1")
        XCTAssertEqual(view.resizeFramesSent, 1)
    }

    /// Regression proof for a user resize killing terminal input. This uses a
    /// key AppKit window and routes in-process NSEvents through sendEvent; a
    /// CGEvent post is silently discarded by the XCTest runner.
    func testLiveShellInputSurvivesWindowResize() throws {
        let (proof, _) = try loadProof()
        guard proof.mode == "shell" else {
            throw XCTSkip("real-shell resize/input proof requires HIVE_B22_REAL_SHELL=1")
        }

        _ = NSApplication.shared
        XCTAssertTrue(NSApp.setActivationPolicy(.regular))
        NSApp.finishLaunching()
        let view = try HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 613, height: 347),
            viewerId: "live-resize-input"
        )
        defer { view.userClose() }
        let window = NSWindow(
            contentRect: view.frame,
            styleMask: [.titled, .resizable],
            backing: .buffered,
            defer: false
        )
        window.contentView = view
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        defer {
            window.orderOut(nil)
            window.contentView = nil
        }
        XCTAssertTrue(waitUntil(timeout: 3) { window.isKeyWindow })
        XCTAssertTrue(window.makeFirstResponder(view))

        let provisionalGeometry = try XCTUnwrap(view.reportedGeometry)
        let grantLine = try issueGrant(
            proof,
            viewerId: "live-resize-input",
            geometryOverride: provisionalGeometry
        )
        XCTAssertEqual(grantLine.status, 0, "resize/input grant refused: \(grantLine.output)")
        let grant = try parseGrant(grantLine.output)
        let transport = RecordingTransport(
            base: try UdsHostTransport.connect(endpoint: grant.endpoint)
        )
        defer { transport.close() }
        let outcome = try view.attach(
            grant: grant,
            geometry: provisionalGeometry,
            afterSeq: 0,
            transport: transport
        )
        guard case .firstCorrectFrame = outcome else {
            return XCTFail("resize/input attach failed: \(outcome)")
        }
        let binding = try XCTUnwrap(view.binding)
        let pump = Thread {
            while !transport.isClosed {
                do {
                    guard let frame = try transport.receive(timeout: 1.0) else { return }
                    DispatchQueue.main.async {
                        view.pumpHostFrame(frame, frameBinding: binding)
                    }
                } catch WireError.receiveTimeout {
                    continue
                } catch {
                    return
                }
            }
        }
        pump.name = "live-resize-input-pump"
        pump.start()
        let inputSubmitsBeforeResize = transport.sent.filter { $0.type == .inputSubmit }.count
        XCTAssertEqual(inputSubmitsBeforeResize, 0)

        let beforeResize = try XCTUnwrap(view.reportedGeometry)
        let resizeFramesBefore = view.resizeFramesSent
        window.setContentSize(NSSize(
            width: window.contentLayoutRect.width + 160,
            height: window.contentLayoutRect.height + 90
        ))
        window.layoutIfNeeded()
        XCTAssertTrue(waitUntil(timeout: 3) {
            view.reportedGeometry != beforeResize &&
                view.resizeFramesSent > resizeFramesBefore
        })
        XCTAssertTrue(
            waitUntil(timeout: 3) { view.surfaceState == .live },
            "resize during C1 settle stranded the surface: \(view.surfaceState)"
        )
        window.makeKeyAndOrderFront(nil)
        XCTAssertTrue(waitUntil(timeout: 3) { window.isKeyWindow })
        XCTAssertTrue(window.firstResponder === view, "programmatic resize lost terminal focus")

        let markerText = "HIVE_RESIZE_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        try sendInProcessKeys("echo \(markerText)\n", to: window)

        let marker = Data(markerText.utf8)
        XCTAssertTrue(waitUntil(timeout: 10) {
            (view.engine as? GhosttyManualSurface)?.semanticSnapshot()?.text
                .contains(markerText) == true
        })
        let returnedOutput = transport.received
            .filter { $0.type == .output }
            .reduce(Data()) { $0 + $1.payload }
        let sentFrames = transport.sent.map { "\($0.type):\($0.requestId)" }
        let receivedFrames = transport.received.map { "\($0.type):\($0.requestId)" }
        XCTAssertGreaterThan(
            transport.sent.filter { $0.type == .inputSubmit }.count,
            inputSubmitsBeforeResize,
            "post-resize NSEvents never produced INPUT_SUBMIT; sent=\(sentFrames) " +
                "received=\(receivedFrames) state=\(view.inputSubmissionState)"
        )
        XCTAssertNotNil(
            returnedOutput.range(of: marker),
            "post-resize keystrokes did not reach the PTY/echo"
        )
    }

    /// Reconnect-churn robustness (§18/§26): a pane that repeatedly loses its
    /// transport and re-attaches keeps getting fresh one-use grants. Each cycle
    /// is a REAL reconnect — issue a grant, attach (which the host consumes via
    /// its own grant list), then drop the transport — so both the host's grant
    /// list and the broker's four-slot mirror must free per cycle. The broker
    /// previously retained the mirror slot until the 15 s expiry, exhausting it
    /// after four cycles; issueAttach now releases it on issue, so far more
    /// than capacity of rapid reconnect cycles succeed with no CAPACITY refusal.
    func testReconnectChurnNeverExhaustsGrantCapacity() throws {
        let (proof, _) = try loadProof()
        let engine = FakeManualSurface()
        let view = HiveTerminalView(frame: .zero, engine: engine, viewerId: "b22-churn")
        for i in 0..<20 {
            let line = try issueGrant(proof, viewerId: "b22-churn")
            XCTAssertEqual(
                line.status, 0,
                "reconnect-cycle \(i) grant refused (grant-slot exhaustion?): \(line.output)"
            )
            let grant = try parseGrant(line.output)
            let transport = try UdsHostTransport.connect(endpoint: grant.endpoint)
            // Attach makes the host consume its grant (orderedRemove); the
            // broker already released its mirror slot at issue.
            let outcome = try view.attach(
                grant: grant,
                geometry: geometry,
                afterSeq: view.highWater,
                transport: transport
            )
            if case .failed(let state) = outcome {
                XCTFail("reconnect-cycle \(i) attach failed: \(state)")
            }
            transport.close()
        }
    }
}
