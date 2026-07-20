import AppKit
import XCTest
@testable import HiveTerminalKit

/// B2.3/A3 acceptance matrix — retry / unknown semantics.
///
/// Acceptance clause (planning/story-m1-b2-hive-terminal-view.md, "Input and
/// resize semantics"): retry repeats the same domain transaction and
/// idempotency key; it never invents a new act after an unknown result.
///
/// `real-host-golden.zig:882` proves the HOST side is idempotent under replay.
/// The client side had no row at all. It matters here because
/// `AttachReplayClient` derives `idempotencyKey` from `transactionId`, which
/// embeds a monotonic sequence (`AttachReplayClient.swift:512-519`) — so any
/// resend after an unknown result would necessarily mint a NEW key and thus a
/// new act. The client therefore satisfies the clause by fencing: after an
/// unknown outcome it writes no further input until a fresh attach.
///
/// These rows assert that fence, and bracket it with a positive control that
/// proves a second submission is observable when the outcome is not unknown.
final class B23UnknownRetryMatrixTests: XCTestCase {
    private let geometry = TerminalGeometry(
        columns: 80,
        rows: 24,
        widthPx: 800,
        heightPx: 480,
        cellWidthPx: 10,
        cellHeightPx: 20
    )

    /// Drives one input submission to a terminal receipt with `stage`, then
    /// types again and reports how many `INPUT_SUBMIT` frames existed before
    /// and after that second attempt. Rows and control share this reader.
    private func submissionsAfterSecondType(
        stage: String
    ) throws -> (before: Int, after: Int, state: InputSubmissionState) {
        let host = FakeHost(connectionId: "input-unknown")
        let engine = FakeManualSurface()
        let view = try attachView(host: host, engine: engine)
        let binding = try XCTUnwrap(view.binding)

        view.insertText(
            "first\n",
            replacementRange: NSRange(location: NSNotFound, length: 0),
            associatedEvent: nil
        )
        drainMainQueue()
        try host.harvestViewerFrames()

        let claim = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .claimAcquire })
        view.pumpHostFrame(
            WireFrame(
                type: .claimResult,
                flags: [.response, .final],
                requestId: claim.requestId,
                payload: try FrameCodec.jsonPayload([
                    "schemaVersion": 1,
                    "result": [
                        "state": "granted",
                        "claim": [
                            "token": "claim-unknown-row",
                            "writer": "input-viewer",
                            "kind": "human",
                            "leaseExpiresAt": "2099-01-01T00:00:00.000Z",
                        ],
                    ],
                ])
            ),
            frameBinding: binding
        )
        try host.harvestViewerFrames()

        let submit = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .inputSubmit })
        let submitObject = try FrameCodec.parseJSONObject(submit.payload)
        let transactionId = try XCTUnwrap(submitObject["transactionId"] as? String)

        // Answer the submission with the requested terminal stage.
        view.pumpHostFrame(
            WireFrame(
                type: .applied,
                flags: [.response, .final],
                requestId: submit.requestId,
                payload: try FrameCodec.jsonPayload([
                    "schemaVersion": 1,
                    "resultKind": "input",
                    "receipt": [
                        "transactionId": transactionId,
                        "stage": stage,
                    ],
                ])
            ),
            frameBinding: binding
        )
        try host.harvestViewerFrames()

        let before = host.receivedFromViewer.filter { $0.type == .inputSubmit }.count

        view.insertText(
            "second\n",
            replacementRange: NSRange(location: NSNotFound, length: 0),
            associatedEvent: nil
        )
        drainMainQueue()
        try host.harvestViewerFrames()

        let after = host.receivedFromViewer.filter { $0.type == .inputSubmit }.count
        return (before, after, view.inputSubmissionState)
    }

    /// After an unknown terminal result the client must not author a new act.
    func testUnknownResultFencesInputAndMintsNoNewTransaction() throws {
        let result = try submissionsAfterSecondType(stage: "unknown")

        guard case .unknown = result.state else {
            return XCTFail("unknown stage did not produce an unknown state, got \(result.state)")
        }
        XCTAssertEqual(
            result.after, result.before,
            "typing after an unknown result submitted \(result.after - result.before) "
                + "additional INPUT_SUBMIT frame(s); the clause forbids inventing a new act"
        )
    }

    /// Positive control through the same reader: a written-to-terminal receipt
    /// leaves the client unfenced, so the SAME code path does submit again.
    /// Without this, the zero above would be indistinguishable from a reader
    /// that simply never observes a second submission.
    func testPositiveControlWrittenReceiptAllowsASecondSubmission() throws {
        let result = try submissionsAfterSecondType(stage: "written-to-terminal")

        XCTAssertGreaterThan(
            result.after, result.before,
            "the reader saw no second INPUT_SUBMIT even on a healthy receipt; "
                + "the unknown-fence row above is unattributable until this passes"
        )
    }

    private func attachView(
        host: FakeHost,
        engine: FakeManualSurface,
        locator: SessionLocator = makeTestLocator(),
        output: String = "ready"
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
        host.enqueueOutput(streamSeq: 0, bytes: Data(output.utf8))
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
