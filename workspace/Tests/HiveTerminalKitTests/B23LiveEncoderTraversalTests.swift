import AppKit
import HiveGhosttyC
import XCTest
@testable import HiveTerminalKit

/// B2.3/A3 acceptance matrix — LIVE-PTY traversal for the encoder rows.
///
/// The encoder rows were recorded against a real `GhosttyManualSurface` with
/// bytes captured at `onWrite`. That proves Ghostty emits the right bytes. It
/// does NOT prove those bytes reach a PTY.
///
/// Nothing previously connected the two halves: the existing live input proof
/// (`LiveHostAttachTests.testLiveGate8InputRoundTrip`) drives a
/// `FakeManualSurface`, so the REAL encoder's output had never traversed
/// sessiond at all. This closes that gap — real Ghostty encoder -> production
/// UDS transport -> authenticated human claim -> `INPUT_SUBMIT` -> real
/// sessiond -> real PTY -> back out through the host journal on disk.
///
/// The expected strings are the SAME goldens the encoder-level rows pin, so a
/// divergence here means the TRANSPORT altered the bytes. That is the only new
/// claim these rows make.
///
/// STATUS: WORK IN PROGRESS — NOT GREEN, and no matrix row may cite it yet.
/// It skips unless `HIVE_B22_PROOF_HOME` is set, so it does not affect ordinary
/// runs. Against a live stack the rows currently report no echo and the run
/// ends with "input claim expired"; the cause is not yet isolated. The matrix
/// document therefore still lists these rows as OPEN for closure. Do NOT
/// promote any row on the strength of this file until it passes.
///
/// FOUR INFRASTRUCTURE CONSTRAINTS found while building it, all real and all
/// load-bearing for whoever finishes this:
///
/// 1. ONE CLAIM, MANY ROWS. A human input claim is never stolen — when a
///    viewer drops it the arbiter ORPHANS it rather than releasing it to the
///    next claimant (that is row 2b's invariant, working as designed), and
///    `AttachReplayClient` has no release call (the `claimRelease` frame type
///    exists at FrameCodec.swift:23 but nothing sends it). A second attach in
///    the same session is denied with "input owner lease expired", and a
///    failed run leaves the session permanently unusable for input. Every
///    iteration therefore needs a FRESH session, and all rows must share one
///    attach and one claim.
///
/// 2. THE CLAIM LEASE IS SHORT. Long per-row waits outlive it, and the run
///    then fails as "input claim expired" rather than as a missing byte —
///    which reads like a transport bug and is not one.
///
/// 3. THE HOST JOURNAL CANNOT BE THE READBACK. `journal.bin` is a small
///    ROLLING window (~2.4 KB observed) and the proof session runs a
///    continuous ticker, so it shrinks as well as grows and any echo rotates
///    out within seconds. Anchoring a search to a byte offset captured before
///    the write silently searches NOTHING once the window rotates past it —
///    a false negative that looks exactly like a missing byte. This file
///    accumulates the ordered OUTPUT frames instead.
///
/// 4. MODES CANNOT BE SET WITH `processOutput` ON A LIVE ATTACH. The
///    ordered-output engine owns the stream sequence, so a hand-fed frame at
///    an arbitrary seq is rejected as `invalidValue`. Setting DECSET
///    faithfully means having the PTY child emit it as real output.
///
/// Opt-in: requires `HIVE_B22_PROOF_HOME` naming a home prepared by
/// `scripts/b22-live-attach-proof.ts` (run it with `HIVE_B22_NO_APP=1`; the
/// rendered pane is not needed and the app carries a known blank-pane defect).
/// Note the port leaks between runs — wait for it to free before restarting.
final class B23LiveEncoderTraversalTests: XCTestCase {
    /// One live row: the input to drive, and the encoder golden that must come
    /// back from the PTY.
    private struct LiveRow {
        let id: String
        /// Terminal mode prologue, applied via the OUTPUT direction.
        let enable: String
        /// Drives input. Must NOT touch `onWrite` — the attach owns it.
        let drive: (HiveTerminalView) -> Void
        /// The pinned encoder golden the encoder-level row already asserts.
        let expected: String
        /// Which matrix row this discharges, for the evidence transcript.
        let matrixRow: String
    }

    private var rows: [LiveRow] {
        [
            // Positive control FIRST: plain ASCII through the same path. If
            // this fails, every later "did not arrive" is unattributable —
            // the child or transport is dead rather than the row being wrong.
            LiveRow(
                id: "control-plain",
                enable: "",
                drive: { $0.insertText("plain", replacementRange: Self.noRange, associatedEvent: nil) },
                expected: "plain",
                matrixRow: "positive control"
            ),
            // Row 3: a navigation key's CSI sequence.
            LiveRow(
                id: "key-arrow-up",
                enable: "",
                drive: { $0.keyDown(with: Self.arrowUpEvent()) },
                expected: "\u{1B}[A",
                matrixRow: "3 (keys)"
            ),
            // Row 6: multi-byte UTF-8 committed through NSTextInputClient.
            LiveRow(
                id: "ime-cjk-commit",
                enable: "",
                drive: { $0.insertText("日本語", replacementRange: Self.noRange, associatedEvent: nil) },
                expected: "日本語",
                matrixRow: "6 (CJK IME)"
            ),
        ]
    }
    // NOT YET LIVE: the mouse rows (8, 8b, 8c) and the paste rows (7, 7b).
    //
    // Mouse and paste rows need an application mode set first (DECSET 1000/
    // 1006/2004). A mode cannot be injected here with `processOutput` the way
    // the encoder-level rows do it: on a LIVE attach the ordered-output engine
    // already owns the stream sequence, so a hand-fed frame at an arbitrary
    // seq is rejected as `invalidValue`. Setting them faithfully means having
    // the PTY child emit the DECSET as real output. That is a further piece of
    // harness work, deliberately not bodged in here — see the matrix document
    // for what remains OPEN.

    /// Drives every row through one attach and one human claim, requiring each
    /// row's exact encoder bytes to come back out of the live PTY.
    func testEncoderBytesTraverseTheLivePty() throws {
        let (proof, _) = try loadProof()
        let viewerId = "b23-live-traversal"
        let grantLine = try issueGrant(proof, viewerId: viewerId)
        XCTAssertEqual(grantLine.status, 0, "grant refused: \(grantLine.output)")
        let grant = try parseGrant(grantLine.output)
        XCTAssertTrue(grant.operations.contains("human-input"), "no input authority in grant")

        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        defer { surface.free() }
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 300),
            engine: surface,
            viewerId: viewerId
        )
        let transport = try UdsHostTransport.connect(endpoint: grant.endpoint)
        defer { transport.close() }
        let outcome = try view.attach(
            grant: grant,
            geometry: geometry,
            afterSeq: 0,
            transport: transport
        )
        guard case .firstCorrectFrame = outcome else {
            return XCTFail("attach failed: \(outcome)")
        }
        let binding = try XCTUnwrap(view.binding)
        // Ordered OUTPUT bytes accumulated across the whole run.
        var received = Data()

        var transcript: [String] = []
        for (index, row) in rows.enumerated() {
            let nonce = "n\(index)x\(viewerId.count)zz"
            if !row.enable.isEmpty {
                XCTAssertEqual(
                    surface.processOutput(bytes: Data(row.enable.utf8), streamSeq: 0),
                    .success,
                    "row \(row.id): mode prologue rejected by the real parser"
                )
            }

            // Drive the REAL encoder. Its onWrite belongs to the attach, so the
            // bytes leave over INPUT_SUBMIT; this test never intercepts them,
            // which is what makes the round trip meaningful.
            row.drive(view)
            // Terminate the line the child should echo, tagged with the nonce.
            view.insertText(
                "\(nonce)\n",
                replacementRange: Self.noRange,
                associatedEvent: nil
            )
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))

            let needle = Data("\(row.expected)\(nonce)".utf8)
            var found = false
            // Deadline is deliberately short. The human input claim carries a
            // lease, and a long per-row wait outlives it — a slow row then
            // fails as "input claim expired" rather than as a missing byte,
            // which reads like a transport bug and is not one.
            let deadline = Date().addingTimeInterval(8)
            while Date() < deadline {
                if received.range(of: needle) != nil {
                    found = true
                    break
                }
                do {
                    if let frame = try transport.receive(timeout: 0.5) {
                        // Accumulate the ordered OUTPUT stream as it arrives.
                        // The host journal cannot be used for this: the proof
                        // session runs a continuous ticker, and journal.bin is
                        // a small rolling window (~2.4 KB observed), so an
                        // echo rotates out within seconds of being written.
                        if frame.type == .output {
                            received.append(frame.payload)
                        }
                        view.pumpHostFrame(frame, frameBinding: binding)
                    }
                } catch WireError.receiveTimeout {
                    // fall through and re-check what has arrived
                }
                RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            }

            XCTAssertTrue(
                found,
                "row \(row.id) [matrix \(row.matrixRow)]: the real encoder's bytes "
                    + "did not round-trip through the live PTY. Expected the child to "
                    + "echo \(row.expected.debugDescription) followed by nonce \(nonce)."
            )
            transcript.append(
                "row \(row.id) [matrix \(row.matrixRow)]: "
                    + (found ? "TRAVERSED" : "NOT FOUND")
                    + " expected=\(row.expected.debugDescription) nonce=\(nonce)"
            )
        }

        // The host's own record that it wrote to the PTY fd, in addition to the
        // byte-level echo above.
        guard case .applied(_, let stage) = view.inputSubmissionState else {
            return XCTFail("no correlated APPLIED: \(view.inputSubmissionState)")
        }
        XCTAssertEqual(stage, "written-to-terminal", "host did not report writing to the terminal")

        print("B23-LIVE-TRAVERSAL-TRANSCRIPT")
        transcript.forEach { print($0) }
        print("B23-LIVE-TRAVERSAL-RECEIPT stage=\(stage)")
    }

    // MARK: - Proof plumbing

    private static let noRange = NSRange(location: NSNotFound, length: 0)

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

    private let geometry = TerminalGeometry(
        columns: 80,
        rows: 24,
        widthPx: 800,
        heightPx: 480,
        cellWidthPx: 10,
        cellHeightPx: 20
    )

    private func loadProof() throws -> (Proof, String) {
        guard let home = ProcessInfo.processInfo.environment["HIVE_B22_PROOF_HOME"] else {
            throw XCTSkip("HIVE_B22_PROOF_HOME not set — live traversal proof is opt-in")
        }
        let descriptor = URL(fileURLWithPath: home).appendingPathComponent("b22-proof.json")
        let proof = try JSONDecoder().decode(Proof.self, from: Data(contentsOf: descriptor))
        return (proof, home)
    }

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
        viewerId: String
    ) throws -> (status: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: proof.hiveCli)
        process.arguments = [
            "workspace-attach", proof.agent,
            "--port", String(proof.port),
            "--session-locator", try locatorJSON(proof.locator),
            "--viewer-id", viewerId,
            "--geometry", try geometryJSON(),
        ]
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        process.waitUntilExit()
        let out = String(data: stdout.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let err = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (process.terminationStatus, process.terminationStatus == 0 ? out : err)
    }

    private func parseGrant(_ line: String) throws -> AttachGrant {
        let object = try JSONSerialization.jsonObject(
            with: Data(line.trimmingCharacters(in: .whitespacesAndNewlines).utf8)
        ) as! [String: Any]
        return try AttachGrant.parse(object)
    }

    private static func mouseEvent(_ type: NSEvent.EventType) -> NSEvent {
        NSEvent.mouseEvent(
            with: type,
            location: NSPoint(x: 25, y: 40),
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            eventNumber: 1,
            clickCount: 1,
            pressure: 1
        )!
    }

    private static func arrowUpEvent() -> NSEvent {
        let text = String(Character(UnicodeScalar(0xF700)!))
        return NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: text,
            charactersIgnoringModifiers: text,
            isARepeat: false,
            keyCode: 126
        )!
    }
}
