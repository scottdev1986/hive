import AppKit
import XCTest
@testable import HiveTerminalKit

/// #87 (M1 acceptance, user ruling 2026-07-21): the human write path must never
/// become permanently unavailable while a pane stays attached.
///
/// The freeze these rows pin was a viewer-side latch. `inputFenced` drops every
/// subsequent keystroke and is cleared only by a fresh attach/retarget, and the
/// claim-acquisition answers set it — so a single transient host "no" ended
/// typing for the life of the attach. Those answers are routinely transient:
/// `input_arbiter.zig:349-356` returns `InputBusy` while the arbiter is
/// mid-automation (i.e. every queen→agent inject), `HumanOrphaned` after an
/// unclean viewer drop, `NotReady` before the visibility lease is current. The
/// host readmits a returning human (`session_host.zig:2781-2811`), so the
/// viewer must keep the write path armed and re-acquire on the next keystroke.
///
/// #40 never-steal is untouched by these rows: every retry is another
/// CLAIM_ACQUIRE the host is free to deny again.
final class InputNeverFrozenTests: XCTestCase {
    private let geometry = TerminalGeometry(
        columns: 80,
        rows: 24,
        widthPx: 800,
        heightPx: 480,
        cellWidthPx: 10,
        cellHeightPx: 20
    )

    /// Types once, answers the resulting CLAIM_ACQUIRE with `firstClaimAnswer`,
    /// then types again and reports what the second keystroke produced. Rows
    /// and control share this reader.
    private func secondKeystroke(
        connectionId: String,
        firstClaimAnswer: (HiveTerminalView, SurfaceBinding, WireFrame) throws -> Void
    ) throws -> (
        view: HiveTerminalView,
        host: FakeHost,
        binding: SurfaceBinding,
        stateAfterAnswer: InputSubmissionState,
        claimsBefore: Int,
        claimsAfter: Int
    ) {
        let host = FakeHost(connectionId: connectionId)
        let view = try attachView(host: host, engine: FakeManualSurface())
        let binding = try XCTUnwrap(view.binding)

        view.insertText(
            "first\n",
            replacementRange: NSRange(location: NSNotFound, length: 0),
            associatedEvent: nil
        )
        drainMainQueue()
        try host.harvestViewerFrames()
        let claim = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .claimAcquire })

        try firstClaimAnswer(view, binding, claim)
        try host.harvestViewerFrames()
        // Read the refusal here: it is deliberately transient, so the second
        // keystroke below replaces it with waitingForClaim.
        let stateAfterAnswer = view.inputSubmissionState
        let claimsBefore = host.receivedFromViewer.filter { $0.type == .claimAcquire }.count

        view.insertText(
            "second\n",
            replacementRange: NSRange(location: NSNotFound, length: 0),
            associatedEvent: nil
        )
        drainMainQueue()
        try host.harvestViewerFrames()
        let claimsAfter = host.receivedFromViewer.filter { $0.type == .claimAcquire }.count

        return (view, host, binding, stateAfterAnswer, claimsBefore, claimsAfter)
    }

    /// The observed freeze: a human types while an automation inject holds the
    /// arbiter, the host denies with `InputBusy`, and typing again must still
    /// reach the terminal.
    func testDeniedClaimKeepsTheHumanWritePathArmed() throws {
        let result = try secondKeystroke(connectionId: "never-frozen-denied") { view, binding, claim in
            view.pumpHostFrame(
                WireFrame(
                    type: .claimResult,
                    flags: [.response, .final],
                    requestId: claim.requestId,
                    payload: try FrameCodec.jsonPayload([
                        "schemaVersion": 1,
                        "result": ["state": "denied", "diagnostic": "InputBusy"],
                    ])
                ),
                frameBinding: binding
            )
        }

        guard case .retryableRefusal(let code, let evidence) = result.stateAfterAnswer else {
            return XCTFail(
                "a denied claim must be a retryable refusal, got \(result.stateAfterAnswer)"
            )
        }
        XCTAssertEqual(code, "CLAIM_DENIED")
        XCTAssertEqual(evidence, "InputBusy")
        XCTAssertGreaterThan(
            result.claimsAfter, result.claimsBefore,
            "typing after a denied claim minted no new CLAIM_ACQUIRE: the human write path is frozen"
        )

        // Granting the retry must carry the keystrokes the user typed after the
        // denial all the way to INPUT_SUBMIT — a re-claim that submits nothing
        // is still a freeze.
        let retry = try XCTUnwrap(result.host.receivedFromViewer.last { $0.type == .claimAcquire })
        result.view.pumpHostFrame(
            WireFrame(
                type: .claimResult,
                flags: [.response, .final],
                requestId: retry.requestId,
                payload: try grantedClaimPayload(token: "claim-after-denial")
            ),
            frameBinding: result.binding
        )
        try result.host.harvestViewerFrames()

        let submit = try XCTUnwrap(result.host.receivedFromViewer.last { $0.type == .inputSubmit })
        let object = try FrameCodec.parseJSONObject(submit.payload)
        XCTAssertEqual(object["claimToken"] as? String, "claim-after-denial")
        let operation = try XCTUnwrap(object["operation"] as? [String: Any])
        XCTAssertEqual(
            Data(base64Encoded: try XCTUnwrap(operation["bytes"] as? String)),
            Data("second\n".utf8)
        )
    }

    /// The other transient state: the host orphaned this viewer's own claim.
    /// operatorResume readmits a returning human, so the next keystroke must
    /// re-acquire rather than find input fenced.
    func testOrphanedClaimKeepsTheHumanWritePathArmed() throws {
        let result = try secondKeystroke(connectionId: "never-frozen-orphan") { view, binding, claim in
            view.pumpHostFrame(
                WireFrame(
                    type: .claimResult,
                    flags: [.response, .final],
                    requestId: claim.requestId,
                    payload: try self.grantedClaimPayload(token: "claim-before-orphan")
                ),
                frameBinding: binding
            )
            view.pumpHostFrame(
                WireFrame(
                    type: .event,
                    payload: try FrameCodec.jsonPayload([
                        "schemaVersion": 1,
                        "kind": "HUMAN_ORPHANED",
                        "claimId": "claim-before-orphan",
                    ])
                ),
                frameBinding: binding
            )
        }

        guard case .retryableRefusal(let code, _) = result.stateAfterAnswer else {
            return XCTFail(
                "an orphaned claim must be a retryable refusal, got \(result.stateAfterAnswer)"
            )
        }
        XCTAssertEqual(code, "HUMAN_ORPHANED")
        XCTAssertGreaterThan(
            result.claimsAfter, result.claimsBefore,
            "typing after an orphan event minted no new CLAIM_ACQUIRE: the human write path is frozen"
        )
    }

    /// Negative control through the same reader. A malformed claim result is a
    /// protocol desync the viewer cannot retry its way out of, so it still
    /// fences — which is what proves the two rows above are reading a real
    /// difference rather than a reader that always sees another claim.
    func testControlMalformedClaimResultStillFencesInput() throws {
        let result = try secondKeystroke(connectionId: "never-frozen-control") { view, binding, claim in
            view.pumpHostFrame(
                WireFrame(
                    type: .claimResult,
                    flags: [.response, .final],
                    requestId: claim.requestId,
                    payload: try FrameCodec.jsonPayload(["schemaVersion": 1, "result": [:]])
                ),
                frameBinding: binding
            )
        }

        guard case .refused(let code, _) = result.stateAfterAnswer else {
            return XCTFail(
                "a malformed claim result must stay a terminal refusal, got "
                    + "\(result.stateAfterAnswer)"
            )
        }
        XCTAssertEqual(code, "MALFORMED_CLAIM_RESULT")
        XCTAssertEqual(
            result.claimsAfter, result.claimsBefore,
            "the reader saw a new CLAIM_ACQUIRE even after a fencing refusal; the rows above "
                + "are unattributable until this passes"
        )
    }

    /// The display half of the split (#87): only a refusal the viewer cannot
    /// recover from may latch a pane's sticky give-up badge. A retryable one
    /// carries no `failureEvidence`, so it cannot reach that latch, and it does
    /// carry `retryableEvidence` so the pane can still say something honest.
    func testRetryableRefusalCarriesNoGiveUpEvidence() {
        let retryable = InputSubmissionState.retryableRefusal(
            code: "CLAIM_DENIED", evidence: "InputBusy")
        XCTAssertNil(retryable.failureEvidence)
        XCTAssertEqual(retryable.retryableEvidence, "CLAIM_DENIED: InputBusy")

        let terminal = InputSubmissionState.refused(
            code: "MALFORMED_CLAIM_RESULT", evidence: "claim result has no state")
        XCTAssertEqual(
            terminal.failureEvidence, "MALFORMED_CLAIM_RESULT: claim result has no state")
        XCTAssertNil(terminal.retryableEvidence)
    }

    private func grantedClaimPayload(token: String) throws -> Data {
        try FrameCodec.jsonPayload([
            "schemaVersion": 1,
            "result": [
                "state": "granted",
                "claim": [
                    "token": token,
                    "writer": "input-viewer",
                    "kind": "human",
                    "leaseExpiresAt": "2099-01-01T00:00:00.000Z",
                ],
            ],
        ])
    }

    private func attachView(
        host: FakeHost,
        engine: FakeManualSurface,
        locator: SessionLocator = makeTestLocator()
    ) throws -> HiveTerminalView {
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 800, height: 480),
            engine: engine,
            viewerId: "input-viewer"
        )
        try host.enqueueWelcome(
            instanceId: locator.instanceId,
            connectionId: host.hostTransport.connectionId
        )
        host.enqueueSnapshotEnvelope(throughSeq: 0, enginePayload: Data("snapshot".utf8))
        host.enqueueOutput(streamSeq: 0, bytes: Data("ready".utf8))
        _ = try view.attach(
            grant: host.makeGrant(locator: locator),
            geometry: geometry,
            transport: host.clientTransport
        )
        return view
    }

    private func drainMainQueue() {
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }
}
