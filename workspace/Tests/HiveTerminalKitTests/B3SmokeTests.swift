import AppKit
import HiveGhosttyC
import XCTest
@testable import HiveTerminalKit

/// B3 substrate smoke — the assertion half.
///
/// Proves the sessiond + HiveTerminalKit substrate end to end. The driver
/// half (`scripts/qa/b3-smoke.sh`) stands the stack up, runs this, and tears
/// it down.
///
/// Stage 3 proves bytes reached a RENDER-READY GRID — the terminal's semantic
/// snapshot contains them — NOT that pixels were drawn. It is a functional
/// substrate gate, not a visual one.
///
/// DELIBERATELY HEADLESS. GUI-bound checks (window becomes key, terminal owns
/// first responder, app activation) belong to an interactive sessiond proof.
/// Folding them in here would make this flaky and put an unlocked GUI
/// session on the critical path of every run.
///
/// DIRECT INPUT, NO RECEIPT. Interactive bytes use USER_INPUT rather than a
/// transaction. The session-unique split marker below proves those bytes took
/// Hive's input path, were interpreted by the shell, and reached the grid.
/// This smoke attaches once and never retries its one-use grant.
///
/// Opt-in: requires `HIVE_B3_SMOKE_HOME`, set by the driver script.
final class B3SmokeTests: XCTestCase {
    /// Stage results, printed as a transcript so a failure names its STAGE
    /// rather than leaving the reader to infer it from a wall of log.
    private var transcript: [String] = []

    func testSessiondSubstrateSmoke() throws {
        let (proof, _) = try loadProof()
        defer { printTranscript() }

        // ── STAGE 1: session create ───────────────────────────────────────
        // The driver created the session; this asserts it is addressable and
        // that the descriptor names a real, live host directory.
        let hostDir = URL(fileURLWithPath: proof.hostDirectory, isDirectory: true)
        var isDirectory: ObjCBool = false
        let hostExists = FileManager.default.fileExists(
            atPath: hostDir.path,
            isDirectory: &isDirectory
        )
        stage(1, "create", hostExists && isDirectory.boolValue,
              "session host directory exists for \(proof.locator.sessionId)")
        XCTAssertTrue(hostExists, "STAGE 1 create: no session host dir at \(hostDir.path)")

        // ── STAGE 2: attach ───────────────────────────────────────────────
        let viewerId = "b3-smoke"
        let grantLine = try issueGrant(proof, viewerId: viewerId)
        stage(2, "attach", grantLine.status == 0, "attach grant issued")
        XCTAssertEqual(grantLine.status, 0, "STAGE 2 attach: grant refused: \(grantLine.output)")
        let grant = try parseGrant(grantLine.output)
        XCTAssertTrue(
            grant.operations.contains("user-input"),
            "STAGE 2 attach: grant lacks user-input authority"
        )

        let surface = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        defer { surface.free() }
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 800, height: 480),
            engine: surface,
            viewerId: viewerId
        )
        let transport = try UdsHostTransport.connect(endpoint: grant.endpoint)
        let outcome = try view.attach(
            grant: grant,
            geometry: geometry,
            afterSeq: 0,
            transport: transport
        )
        guard case .firstCorrectFrame = outcome else {
            stage(2, "attach", false, "attach outcome \(outcome)")
            transport.close()
            return XCTFail("STAGE 2 attach: did not reach firstCorrectFrame: \(outcome)")
        }
        stage(2, "attach", true, "attached at first correct frame")
        let binding = try XCTUnwrap(view.binding)

        // ── STAGE 3: shell-interpreted input reaches the grid ─────────────
        // SPLIT MARKER: typed in a split form only a real shell will rejoin;
        // the assertion looks for the REJOINED form. Distinguishes "a shell
        // interpreted these bytes" from "the renderer echoed what I typed" —
        // without it a terminal that merely echoed input would pass.
        let unique = abs(proof.locator.sessionId.hashValue % 100000)
        let joined = "B3SMOKE\(unique)"
        let split = "B3SM''OKE\(unique)"
        // SUBMIT WITH A RETURN KEY, NOT A NEWLINE IN THE TEXT.
        //
        // The session runs a real zsh, which enables bracketed paste
        // (ESC[?2004h). Gate 8 therefore wraps insertText in ESC[200~/ESC[201~,
        // and a newline INSIDE a bracketed paste is literal text — the shell
        // highlights the line and never executes it. That is row 7b's
        // safe-paste behavior working as designed (an embedded newline must
        // not submit unseen), and it means a smoke that types "cmd\n" through
        // insertText will hang forever waiting for output that cannot come.
        //
        // A user types the text and then presses Return; the Return is a KEY
        // event, outside the paste, and that is what submits the line.
        view.insertText(
            "echo \(split)",
            replacementRange: NSRange(location: NSNotFound, length: 0),
            associatedEvent: nil
        )
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        view.keyDown(with: Self.returnKeyEvent())
        let marker = joined
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))

        var rendered = false
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if !rendered,
               let snapshot = surface.semanticSnapshot(),
               snapshot.text.contains(marker) {
                rendered = true
            }
            if rendered { break }
            do {
                if let frame = try transport.receive(timeout: 0.5) {
                    view.pumpHostFrame(frame, frameBinding: binding)
                }
            } catch {
                // receive timeout is expected while waiting; keep pumping
            }
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }

        transcript.append(
            "RETIRED STAGE 4 input receipt — interactive USER_INPUT has no transaction; "
                + "the session-unique rejoined marker is now the delivery evidence"
        )
        stage(3, "render-ready", rendered,
              "session-unique rejoined \(marker) proves Hive input reached the shell and grid")
        XCTAssertTrue(
            rendered,
            "STAGE 3 render-ready: the REJOINED marker \(marker) never reached the "
                + "terminal's semantic snapshot. Typed as \(split), so seeing the "
                + "rejoined form proves a real shell interpreted the bytes rather "
                + "than the renderer echoing them. This asserts a render-READY grid, "
                + "not drawn pixels."
        )
        // Note deliberately NOT asserted: that the SPLIT form is absent. A real
        // shell echoes the typed line, so the split form legitimately appears
        // alongside the rejoined one. The proof is the PRESENCE of the rejoined
        // form, which echo alone cannot produce — asserting the split form's
        // absence would fail against correct behavior.

        // ── STAGE 5: viewer detach ────────────────────────────────────────
        // Deliberately NOT asserted here: that the viewer leaves .live. Closing
        // the transport out from under the view is not something the view is
        // notified of, so nothing promises a state change and asserting one
        // fails against correct behavior.
        //
        // The AUTHORITATIVE teardown evidence is the driver's, taken from
        // outside this process once the viewer is gone: the session must still
        // be live right after detach (detach never kills), and final.json must
        // show survivors == 0 with waitObserved once the stack goes down. A
        // viewer cannot honestly attest to either — it is the thing going away.
        transport.close()
        stage(5, "detach", true, "viewer detached; teardown asserted by the driver")
    }

    // MARK: - Transcript

    private func stage(_ number: Int, _ name: String, _ ok: Bool, _ detail: String) {
        transcript.append("STAGE \(number) \(name): \(ok ? "PASS" : "FAIL") — \(detail)")
    }

    private func printTranscript() {
        print("B3-SMOKE-TRANSCRIPT")
        transcript.forEach { print($0) }
    }

    /// A Return key event — the submit path a user uses. Not a newline in
    /// pasted text, which a bracketed-paste-aware shell will not execute.
    private static func returnKeyEvent() -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "\r",
            charactersIgnoringModifiers: "\r",
            isARepeat: false,
            keyCode: 36
        )!
    }

    // MARK: - Proof plumbing
    //
    // Duplicated from the live-proof tests, matching the existing house
    // pattern (LiveHostAttachTests and B23LiveEncoderTraversalTests each carry
    // their own copy). Factoring all three onto one helper is a worthwhile
    // cleanup but is a refactor of already-reviewed code, so it is not done
    // here.

    private struct Proof: Decodable {
        let hiveCli: String
        let port: Int
        let agent: String
        let mode: String?
        let hostDirectory: String
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
        guard let home = ProcessInfo.processInfo.environment["HIVE_B3_SMOKE_HOME"] else {
            throw XCTSkip("HIVE_B3_SMOKE_HOME not set — run scripts/qa/b3-smoke.sh")
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
}
