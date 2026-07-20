import AppKit
import HiveGhosttyC
import XCTest
@testable import HiveTerminalKit

/// B2.3/A3 acceptance matrix — LIVE-PTY traversal for the encoder rows.
///
/// WHAT THIS ESTABLISHES, and why it is the substance of closure rather than a
/// formality: today's "live input proof"
/// (`LiveHostAttachTests.testLiveGate8InputRoundTrip`) drives a
/// `FakeManualSurface`, so it never exercises the real Gate 8 encoder at all.
/// The encoder rows, meanwhile, capture bytes at `onWrite` from a real
/// `GhosttyManualSurface` that never reaches a PTY. The two halves of the
/// input proof have therefore never been connected, and connecting them —
/// real encoder -> production UDS transport -> authenticated human claim ->
/// `INPUT_SUBMIT` -> real sessiond -> real PTY — is what these rows do.
///
/// THE CLAIM, stated exactly and not more strongly: each row's real encoder
/// bytes were WRITTEN TO A LIVE PTY, VERIFIED AT THE HOST WRITE BOUNDARY WITH
/// A CORRELATED `written-to-terminal` RECEIPT. This is deliberately NOT a
/// "byte-verbatim round-tripped" claim. Reading the bytes back would mean
/// echoing them through the proof child (`read -r` + `printf %s`), which is a
/// normalizer — it cannot carry NUL and would certify the normalizer rather
/// than the transport. The write-boundary claim has no normalizer in the path.
///
/// ATTRIBUTION: exactly one input event is driven per transaction, so the
/// receipt that comes back is attributable to that row's encoder bytes and
/// nothing else.
///
/// CONSTRAINTS discovered building this, all real and all load-bearing:
///
/// 1. ONE CLAIM, MANY ROWS. A human input claim is never stolen — when a
///    viewer drops it the arbiter ORPHANS it (row 2b's invariant, working as
///    designed), and `AttachReplayClient` has no release call (the
///    `claimRelease` frame type exists at FrameCodec.swift:23 but nothing
///    sends it). A second attach in the same session is denied with "input
///    owner lease expired", and a failed run leaves that session permanently
///    unusable for input. So every row shares ONE attach and ONE claim, and
///    each iteration needs a FRESH session.
///
/// 2. THE CLAIM LEASE IS SHORT. Long per-row waits outlive it and the run then
///    fails as "input claim expired" rather than as a missing byte — which
///    reads like a transport bug and is not one. Waits here are kept tight.
///
/// 3. THE HOST JOURNAL IS NOT A USABLE READBACK (recorded for whoever tries):
///    `journal.bin` is a small ROLLING window (~2.4 KB observed) and the proof
///    session runs a continuous ticker, so anything written rotates out within
///    seconds. Anchoring a search to a byte offset captured before the write
///    silently searches NOTHING once the window rotates past it — a false
///    negative indistinguishable from a missing byte.
///
/// 4. MODES CANNOT BE SET WITH `processOutput` ON A LIVE ATTACH. The
///    ordered-output engine owns the stream sequence, so a hand-fed frame at
///    an arbitrary seq is rejected as `invalidValue`. Rows needing DECSET —
///    4 (Kitty), 7/7b (paste), 8/8b/8c (mouse) — therefore need the PTY child
///    to emit the mode as real output, which is harness work and is NOT done
///    here. Those rows stay OPEN for closure.
///
/// Opt-in: requires `HIVE_B22_PROOF_HOME` naming a home prepared by
/// `scripts/b22-live-attach-proof.ts` (run it with `HIVE_B22_NO_APP=1`; the
/// rendered pane is not needed and the app carries a known blank-pane defect).
/// The harness port leaks between runs — wait for it to free before restarting.
final class B23LiveEncoderTraversalTests: XCTestCase {
    /// One live row: an input that needs no application mode, plus the matrix
    /// row it discharges.
    private struct LiveRow {
        let id: String
        let drive: (HiveTerminalView) -> Void
        let matrixRow: String
        /// Row 11 only: after the receipt, require that NO second transaction
        /// follows. A duplicate emission would author one.
        var requiresExactlyOneTransaction: Bool = false
    }

    private var rows: [LiveRow] {
        [
            // Positive control FIRST: plain ASCII through the same path. If
            // this fails, every later failure is unattributable — the claim or
            // transport is dead rather than the row being wrong.
            LiveRow(
                id: "control-plain",
                drive: { $0.insertText("plain", replacementRange: Self.noRange, associatedEvent: nil) },
                matrixRow: "positive control"
            ),
            LiveRow(
                id: "key-arrow-up",
                drive: { $0.keyDown(with: Self.arrowUpEvent()) },
                matrixRow: "3 (keys)"
            ),
            LiveRow(
                id: "ime-cjk-commit",
                drive: { $0.insertText("日本語", replacementRange: Self.noRange, associatedEvent: nil) },
                matrixRow: "6 (CJK IME)"
            ),
            LiveRow(
                id: "dead-key-commit",
                drive: { $0.insertText("é", replacementRange: Self.noRange, associatedEvent: nil) },
                matrixRow: "5 (dead key)"
            ),
            // Row 11: one text-producing key event must author exactly ONE
            // transaction. If the printable were emitted once as a key and
            // again as text, a SECOND transaction would follow — so this row
            // is checked by what does NOT arrive after the receipt, not only
            // by the receipt itself. See `settleAndCollectNewTransactions`.
            LiveRow(
                id: "printable-key-once",
                drive: { $0.keyDown(with: Self.printableKeyEvent()) },
                matrixRow: "11 (no-duplicate-input)",
                requiresExactlyOneTransaction: true
            ),
        ]
    }

    /// Drives every mode-free row through one attach and one human claim, and
    /// requires the host to report writing each one to the live PTY.
    func testEncoderBytesReachTheLivePtyAtTheWriteBoundary() throws {
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

        var transcript: [String] = []
        var seenTransactions: Set<String> = []

        for row in rows {
            // Exactly one input event per transaction, so the receipt below is
            // attributable to this row's encoder bytes and nothing else.
            row.drive(view)
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))

            var applied: (txn: String, stage: String)?
            let deadline = Date().addingTimeInterval(8)
            while Date() < deadline {
                if case .applied(let txn, let stage) = view.inputSubmissionState,
                   !seenTransactions.contains(txn) {
                    applied = (txn, stage)
                    break
                }
                do {
                    if let frame = try transport.receive(timeout: 0.5) {
                        view.pumpHostFrame(frame, frameBinding: binding)
                    }
                } catch WireError.receiveTimeout {
                    // fall through and re-check the submission state
                }
                RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            }

            guard let applied else {
                XCTFail(
                    "row \(row.id) [matrix \(row.matrixRow)]: no new correlated APPLIED "
                        + "receipt. Final state: \(view.inputSubmissionState)"
                )
                transcript.append("row \(row.id) [matrix \(row.matrixRow)]: NO RECEIPT")
                continue
            }
            seenTransactions.insert(applied.txn)
            XCTAssertEqual(
                applied.stage, "written-to-terminal",
                "row \(row.id) [matrix \(row.matrixRow)]: host did not report writing "
                    + "these bytes to the terminal"
            )
            var duplicateNote = ""
            if row.requiresExactlyOneTransaction {
                let extra = settleAndCollectNewTransactions(
                    view: view,
                    transport: transport,
                    binding: binding,
                    seen: seenTransactions
                )
                XCTAssertTrue(
                    extra.isEmpty,
                    "row \(row.id) [matrix \(row.matrixRow)]: one text-producing key "
                        + "event authored MORE THAN ONE transaction (\(extra)); the "
                        + "printable was emitted both as a key and as text."
                )
                duplicateNote = extra.isEmpty
                    ? " exactly-one-transaction=CONFIRMED"
                    : " DUPLICATE=\(extra)"
            }
            transcript.append(
                "row \(row.id) [matrix \(row.matrixRow)]: "
                    + "WRITTEN-TO-LIVE-PTY txn=\(applied.txn) stage=\(applied.stage)"
                    + duplicateNote
            )
        }

        XCTAssertEqual(
            seenTransactions.count, rows.count,
            "each row must produce its own distinct transaction; got "
                + "\(seenTransactions.count) for \(rows.count) rows"
        )

        print("B23-LIVE-TRAVERSAL-TRANSCRIPT")
        transcript.forEach { print($0) }
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

    /// Pumps for a settle window and reports any transaction id that appears
    /// beyond those already seen. Used to prove a NON-event: that no second
    /// submission followed a single key press.
    private func settleAndCollectNewTransactions(
        view: HiveTerminalView,
        transport: UdsHostTransport,
        binding: SurfaceBinding,
        seen: Set<String>
    ) -> [String] {
        var extra: [String] = []
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            if case .applied(let txn, _) = view.inputSubmissionState,
               !seen.contains(txn), !extra.contains(txn) {
                extra.append(txn)
            }
            do {
                if let frame = try transport.receive(timeout: 0.25) {
                    view.pumpHostFrame(frame, frameBinding: binding)
                }
            } catch {
                // keep settling; a receive timeout is expected here
            }
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        return extra
    }

    private static func printableKeyEvent() -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "a",
            charactersIgnoringModifiers: "a",
            isARepeat: false,
            keyCode: 0
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
