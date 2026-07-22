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
/// viewer must keep the original bytes queued and re-acquire internally.
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

    /// The raised #87 bar: the key event that collides with an automation
    /// inject is itself retained and submitted. The user must not have to type
    /// a second key to retry, and no refusal state may be published while the
    /// host arbitrates the ordered writers.
    func testInProcessKeyEventDuringInjectRetriesAndLandsWithoutRefusal() throws {
        _ = NSApplication.shared
        let host = FakeHost(connectionId: "never-refused-inject-race")
        let engine = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        defer { engine.free() }
        let view = try attachView(host: host, engine: engine, snapshotPayload: nil)
        let binding = try XCTUnwrap(view.binding)
        var states: [InputSubmissionState] = []
        view.onInputSubmissionStateChange = { states.append($0) }

        view.keyDown(with: Self.shiftEnterEvent())
        try waitForFrames(host, type: .claimAcquire, count: 1)
        // Ghostty's key encoder drains on its IO thread. Let its write callback
        // reach the main queue before the host answers the claim.
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))

        let firstClaim = try XCTUnwrap(
            host.receivedFromViewer.last { $0.type == .claimAcquire })
        view.pumpHostFrame(
            WireFrame(
                type: .claimResult,
                flags: [.response, .final],
                requestId: firstClaim.requestId,
                payload: try FrameCodec.jsonPayload([
                    "schemaVersion": 1,
                    "result": ["state": "denied", "diagnostic": "InputBusy"],
                ])
            ),
            frameBinding: binding
        )

        try waitForFrames(host, type: .claimAcquire, count: 2)
        let retryWhileBusy = try XCTUnwrap(
            host.receivedFromViewer.last { $0.type == .claimAcquire })
        view.pumpHostFrame(
            WireFrame(
                type: .claimResult,
                flags: [.response, .final],
                requestId: retryWhileBusy.requestId,
                payload: try FrameCodec.jsonPayload([
                    "schemaVersion": 1,
                    "result": ["state": "unknown", "diagnostic": "NotReady"],
                ])
            ),
            frameBinding: binding
        )

        try waitForFrames(host, type: .claimAcquire, count: 3)
        let retry = try XCTUnwrap(
            host.receivedFromViewer.last { $0.type == .claimAcquire })
        view.pumpHostFrame(
            WireFrame(
                type: .claimResult,
                flags: [.response, .final],
                requestId: retry.requestId,
                payload: try grantedClaimPayload(token: "claim-after-inject")
            ),
            frameBinding: binding
        )
        try waitForFrames(host, type: .inputSubmit, count: 1)

        let submit = try XCTUnwrap(
            host.receivedFromViewer.last { $0.type == .inputSubmit })
        let object = try FrameCodec.parseJSONObject(submit.payload)
        let operation = try XCTUnwrap(object["operation"] as? [String: Any])
        XCTAssertEqual(
            Data(base64Encoded: try XCTUnwrap(operation["bytes"] as? String)),
            Data("\u{1B}[27;2;13~".utf8),
            "the original in-process NSEvent was lost or reordered during claim arbitration"
        )
        XCTAssertFalse(states.contains { state in
            switch state {
            case .refused, .unknown: return true
            default: return false
            }
        }, "recoverable inject contention surfaced an input refusal: \(states)")
    }

    /// Types before and after a host answer and reports whether the second
    /// keystroke can still acquire a claim. The orphan and fencing control use
    /// the same reader.
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

        XCTAssertEqual(result.stateAfterAnswer, .idle)
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

    func testOnlyTerminalRefusalCarriesGiveUpEvidence() {
        XCTAssertNil(InputSubmissionState.waitingForClaim.failureEvidence)
        let terminal = InputSubmissionState.refused(
            code: "MALFORMED_CLAIM_RESULT", evidence: "claim result has no state")
        XCTAssertEqual(
            terminal.failureEvidence, "MALFORMED_CLAIM_RESULT: claim result has no state")
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
        engine: ManualSurfaceEngine,
        locator: SessionLocator = makeTestLocator(),
        snapshotPayload: Data? = Data("snapshot".utf8)
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
        if let snapshotPayload {
            host.enqueueSnapshotEnvelope(throughSeq: 0, enginePayload: snapshotPayload)
        }
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

    private func waitForFrames(
        _ host: FakeHost,
        type: FrameType,
        count: Int,
        timeout: TimeInterval = 2
    ) throws {
        let deadline = Date().addingTimeInterval(timeout)
        while host.receivedFromViewer.filter({ $0.type == type }).count < count,
              Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            try host.harvestViewerFrames()
        }
        XCTAssertGreaterThanOrEqual(
            host.receivedFromViewer.filter { $0.type == type }.count,
            count,
            "timed out waiting for \(count) \(type) frame(s)"
        )
    }

    private static func shiftEnterEvent() -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [.shift],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "\r",
            charactersIgnoringModifiers: "\r",
            isARepeat: false,
            keyCode: 36
        )!
    }
}
