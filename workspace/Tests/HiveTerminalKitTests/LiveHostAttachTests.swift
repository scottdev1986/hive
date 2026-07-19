import AppKit
import XCTest
@testable import HiveTerminalKit

/// B2.2 opt-in LIVE wire proof: the production Swift attach path
/// (`UdsHostTransport` + `AttachReplayClient` + `HiveTerminalView` fencing)
/// against a REAL sessiond host serving a live session.
///
/// Skipped unless `HIVE_B22_PROOF_HOME` names a home prepared by
/// `scripts/b22-live-attach-proof.ts` (which writes `b22-proof.json`). The
/// fake engine stands in for Ghostty so this runs headless; the pixels-on-
/// glass leg is the recorded Workspace session.
final class LiveHostAttachTests: XCTestCase {
    private struct Proof: Decodable {
        let hiveCli: String
        let port: Int
        let agent: String
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

    private func geometryJSON() throws -> String {
        String(
            data: try JSONSerialization.data(
                withJSONObject: geometry.jsonObject(),
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
        generationOverride: Int? = nil
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
            "--geometry", try geometryJSON(),
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
            view.pumpHostFrame(frame)
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
            view.pumpHostFrame(frame)
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

    /// Reconnect-churn robustness (§18): a pane that repeatedly loses its
    /// transport and re-attaches keeps getting fresh one-use grants. The
    /// broker's four-slot per-generation mirror must not exhaust while spent
    /// grants await their 15 s expiry — issueAttach releases the slot on issue,
    /// so far more than capacity succeed inside one host's grant window.
    func testReconnectChurnNeverExhaustsGrantCapacity() throws {
        let (proof, _) = try loadProof()
        for i in 0..<20 {
            let line = try issueGrant(proof, viewerId: "b22-churn-\(i)")
            XCTAssertEqual(
                line.status, 0,
                "churn grant \(i) refused (grant-slot exhaustion?): \(line.output)"
            )
        }
    }
}
