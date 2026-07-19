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
            try base.receive(timeout: timeout)
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
