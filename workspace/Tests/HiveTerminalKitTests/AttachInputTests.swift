import AppKit
import XCTest
@testable import HiveTerminalKit

final class AttachInputTests: XCTestCase {
    private let geometry = TerminalGeometry(
        columns: 80,
        rows: 24,
        widthPx: 800,
        heightPx: 480,
        cellWidthPx: 10,
        cellHeightPx: 20
    )

    func testGate8TextWaitsForClaimThenUsesFrozenInputSubmit() throws {
        let host = FakeHost(connectionId: "input-conn")
        let engine = FakeManualSurface()
        let view = try attachView(host: host, engine: engine)
        let binding = try XCTUnwrap(view.binding)

        view.insertText("typed-✓\n", replacementRange: NSRange(location: NSNotFound, length: 0), associatedEvent: nil)
        drainMainQueue()
        try host.harvestViewerFrames()

        let claim = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .claimAcquire })
        XCTAssertFalse(host.receivedFromViewer.contains { $0.type == .inputSubmit })
        let claimObject = try FrameCodec.parseJSONObject(claim.payload)
        XCTAssertEqual(claimObject["writer"] as? String, "input-viewer")
        XCTAssertEqual(claimObject["kind"] as? String, "human")
        let claimSession = try XCTUnwrap(claimObject["session"] as? [String: Any])
        XCTAssertEqual(claimSession["key"] as? String, binding.locator.sessionId)
        XCTAssertEqual(claimSession["incarnation"] as? String, String(binding.generation))

        let claimResult = try FrameCodec.jsonPayload([
            "schemaVersion": 1,
            "result": [
                "state": "granted",
                "claim": [
                    "token": "claim-exact-generation",
                    "writer": "input-viewer",
                    "kind": "human",
                    "leaseExpiresAt": "2099-01-01T00:00:00.000Z",
                ],
            ],
        ])
        view.pumpHostFrame(
            WireFrame(
                type: .claimResult,
                flags: [.response, .final],
                requestId: claim.requestId,
                payload: claimResult
            ),
            frameBinding: binding
        )
        try host.harvestViewerFrames()

        let input = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .inputSubmit })
        XCTAssertEqual(input.flags, [.contentSensitive])
        XCTAssertNotEqual(input.requestId, 0)
        XCTAssertFalse(host.receivedFromViewer.contains { $0.type == .humanInput })
        let inputObject = try FrameCodec.parseJSONObject(input.payload)
        XCTAssertEqual(inputObject["claimToken"] as? String, "claim-exact-generation")
        let inputSession = try XCTUnwrap(inputObject["session"] as? [String: Any])
        XCTAssertEqual(inputSession["key"] as? String, binding.locator.sessionId)
        XCTAssertEqual(inputSession["incarnation"] as? String, String(binding.generation))
        let operation = try XCTUnwrap(inputObject["operation"] as? [String: Any])
        XCTAssertEqual(operation["kind"] as? String, "bytes")
        XCTAssertEqual(operation["encoding"] as? String, "base64")
        XCTAssertEqual(
            Data(base64Encoded: try XCTUnwrap(operation["bytes"] as? String)),
            Data("typed-✓\n".utf8)
        )

        let transactionId = try XCTUnwrap(inputObject["transactionId"] as? String)
        let receipt = try FrameCodec.jsonPayload([
            "schemaVersion": 1,
            "resultKind": "input",
            "receipt": [
                "transactionId": transactionId,
                "stage": "written-to-terminal",
                "byteRange": ["start": "0", "endExclusive": "10"],
                "orderedAt": "1",
                "availableCreditBytes": FrameCodec.inputTransactionMaxBytes,
                "consumedByProcess": "not-claimed",
                "completeness": "complete",
                "diagnostic": NSNull(),
            ],
        ])
        view.pumpHostFrame(
            WireFrame(
                type: .applied,
                flags: [.response, .final],
                requestId: input.requestId,
                payload: receipt
            ),
            frameBinding: binding
        )
        XCTAssertEqual(
            view.inputSubmissionState,
            .applied(transactionId: transactionId, stage: "written-to-terminal")
        )
    }

    func testExpiredClaimRejectionReacquiresAndResubmitsInput() throws {
        let host = FakeHost(connectionId: "input-expired-claim")
        let engine = FakeManualSurface()
        let view = try attachView(host: host, engine: engine)
        let binding = try XCTUnwrap(view.binding)

        view.insertText("second-command\n", replacementRange: NSRange(location: NSNotFound, length: 0), associatedEvent: nil)
        drainMainQueue()
        try host.harvestViewerFrames()
        let claim = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .claimAcquire })
        let firstClaimObject = try FrameCodec.parseJSONObject(claim.payload)
        let firstClaimIdempotencyKey = try XCTUnwrap(
            firstClaimObject["idempotencyKey"] as? String)
        view.pumpHostFrame(
            WireFrame(
                type: .claimResult,
                flags: [.response, .final],
                requestId: claim.requestId,
                payload: try claimGrantedPayload(token: "claim-one")
            ),
            frameBinding: binding
        )
        try host.harvestViewerFrames()
        let input = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .inputSubmit })
        let inputObject = try FrameCodec.parseJSONObject(input.payload)
        let transactionId = try XCTUnwrap(inputObject["transactionId"] as? String)

        // The host rejects with "input claim expired" (claim outlived its
        // lease-clamped expiry): the client must re-claim and resubmit the
        // held bytes, not fence input permanently.
        view.pumpHostFrame(
            WireFrame(
                type: .applied,
                flags: [.response, .final],
                requestId: input.requestId,
                payload: try inputRejectedPayload(
                    transactionId: transactionId,
                    diagnostic: "input claim expired"
                )
            ),
            frameBinding: binding
        )
        try host.harvestViewerFrames()
        if case .refused(let code, _) = view.inputSubmissionState {
            XCTFail("expired claim must not fence input, got refusal \(code)")
        }
        let reclaim = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .claimAcquire })
        XCTAssertNotEqual(reclaim.requestId, claim.requestId)
        let reclaimObject = try FrameCodec.parseJSONObject(reclaim.payload)
        XCTAssertNotEqual(
            reclaimObject["idempotencyKey"] as? String,
            firstClaimIdempotencyKey,
            "an expired lease is a new acquisition, not an idempotent replay"
        )

        view.pumpHostFrame(
            WireFrame(
                type: .claimResult,
                flags: [.response, .final],
                requestId: reclaim.requestId,
                payload: try claimGrantedPayload(token: "claim-two")
            ),
            frameBinding: binding
        )
        try host.harvestViewerFrames()
        let resubmitted = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .inputSubmit })
        let resubmittedObject = try FrameCodec.parseJSONObject(resubmitted.payload)
        XCTAssertEqual(resubmittedObject["claimToken"] as? String, "claim-two")
        let operation = try XCTUnwrap(resubmittedObject["operation"] as? [String: Any])
        XCTAssertEqual(
            Data(base64Encoded: try XCTUnwrap(operation["bytes"] as? String)),
            Data("second-command\n".utf8)
        )

        // Even a second expiry is a completed rejection, not an unknown act.
        // Keep the same bytes buffered and claim again instead of refusing the
        // user's input.
        let resubmittedTransactionId = try XCTUnwrap(resubmittedObject["transactionId"] as? String)
        view.pumpHostFrame(
            WireFrame(
                type: .applied,
                flags: [.response, .final],
                requestId: resubmitted.requestId,
                payload: try inputRejectedPayload(
                    transactionId: resubmittedTransactionId,
                    diagnostic: "input claim expired"
                )
            ),
            frameBinding: binding
        )
        try host.harvestViewerFrames()
        if case .refused(let code, _) = view.inputSubmissionState {
            XCTFail("repeated claim expiry must not refuse input, got \(code)")
        }
        let thirdClaim = try XCTUnwrap(
            host.receivedFromViewer.last { $0.type == .claimAcquire })
        XCTAssertNotEqual(thirdClaim.requestId, reclaim.requestId)
    }

    private func claimGrantedPayload(token: String) throws -> Data {
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

    private func inputRejectedPayload(transactionId: String, diagnostic: String) throws -> Data {
        try FrameCodec.jsonPayload([
            "schemaVersion": 1,
            "resultKind": "input",
            "receipt": [
                "transactionId": transactionId,
                "stage": "rejected",
                "availableCreditBytes": FrameCodec.inputTransactionMaxBytes,
                "completeness": "complete",
                "diagnostic": diagnostic,
            ],
        ])
    }

    func testSupersededConnectionClaimCannotReleaseHeldInput() throws {
        let locator = makeTestLocator()
        let hostA = FakeHost(connectionId: "input-old")
        let engine = FakeManualSurface()
        let view = try attachView(host: hostA, engine: engine, locator: locator, output: "A")
        let oldBinding = try XCTUnwrap(view.binding)

        view.insertText("must-not-cross\n", replacementRange: NSRange(location: NSNotFound, length: 0), associatedEvent: nil)
        drainMainQueue()
        try hostA.harvestViewerFrames()
        let oldClaim = try XCTUnwrap(hostA.receivedFromViewer.last { $0.type == .claimAcquire })

        let hostB = FakeHost(connectionId: "input-new")
        try hostB.enqueueWelcome(instanceId: locator.instanceId, connectionId: "input-new")
        hostB.enqueueSnapshotEnvelope(throughSeq: view.highWater, enginePayload: Data("new-snapshot".utf8))
        hostB.enqueueOutput(streamSeq: view.highWater, bytes: Data("B".utf8))
        _ = try view.attach(
            grant: hostB.makeGrant(locator: locator),
            geometry: geometry,
            afterSeq: view.highWater,
            transport: hostB.clientTransport
        )
        let newBinding = try XCTUnwrap(view.binding)
        XCTAssertNotEqual(oldBinding.connectionId, newBinding.connectionId)

        let lateClaim = try FrameCodec.jsonPayload([
            "schemaVersion": 1,
            "result": [
                "state": "granted",
                "claim": [
                    "token": "late-old-token",
                    "writer": "input-viewer",
                    "kind": "human",
                    "leaseExpiresAt": "2099-01-01T00:00:00.000Z",
                ],
            ],
        ])
        view.pumpHostFrame(
            WireFrame(type: .claimResult, requestId: oldClaim.requestId, payload: lateClaim),
            frameBinding: oldBinding
        )
        try hostA.harvestViewerFrames()
        try hostB.harvestViewerFrames()
        XCTAssertFalse(hostA.receivedFromViewer.contains { $0.type == .inputSubmit })
        XCTAssertFalse(hostB.receivedFromViewer.contains { $0.type == .inputSubmit })
        XCTAssertEqual(view.binding, newBinding)
        XCTAssertEqual(view.claimPresentation, .free)
        XCTAssertEqual(view.inputSubmissionState, .idle)
    }

    func testReleaseClaimBestEffortSendsCancelClaimRelease() throws {
        let host = FakeHost(connectionId: "input-release")
        let engine = FakeManualSurface()
        let view = try attachView(host: host, engine: engine)
        let binding = try XCTUnwrap(view.binding)

        view.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0), associatedEvent: nil)
        drainMainQueue()
        try host.harvestViewerFrames()
        let claim = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .claimAcquire })
        let claimResult = try FrameCodec.jsonPayload([
            "schemaVersion": 1,
            "result": [
                "state": "granted",
                "claim": [
                    "token": "claim-to-release",
                    "writer": "input-viewer",
                    "kind": "human",
                    "leaseExpiresAt": "2099-01-01T00:00:00.000Z",
                ],
            ],
        ])
        view.pumpHostFrame(
            WireFrame(
                type: .claimResult,
                flags: [.response, .final],
                requestId: claim.requestId,
                payload: claimResult
            ),
            frameBinding: binding
        )
        XCTAssertEqual(view.claimPresentation, .humanOwned(viewerId: "input-viewer", claimId: "claim-to-release"))

        view.releaseClaimBestEffort()
        try host.harvestViewerFrames()
        let release = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .claimRelease })
        let object = try FrameCodec.parseJSONObject(release.payload)
        XCTAssertEqual(object["claimToken"] as? String, "claim-to-release")
        XCTAssertEqual(object["kind"] as? String, "cancel")
        let session = try XCTUnwrap(object["session"] as? [String: Any])
        XCTAssertEqual(session["key"] as? String, binding.locator.sessionId)
        XCTAssertEqual(view.claimPresentation, .free)
    }

    func testCompositionEndReleasesOnlyAfterItsPendingInputIsApplied() throws {
        let host = FakeHost(connectionId: "input-composition-end")
        let engine = FakeManualSurface()
        let view = try attachView(host: host, engine: engine)
        let binding = try XCTUnwrap(view.binding)

        // A composition begins a claim, then ends before the asynchronous
        // CLAIM_RESULT arrives. The encoder's committed bytes land behind
        // unmarkText; release must wait for both that submit and its receipt.
        view.setMarkedText("preedit", selectedRange: .init(location: 0, length: 0), replacementRange: .init(location: 0, length: 0))
        view.unmarkText()
        view.attachClient?.handleEncodedWrite(Data("committed".utf8))
        drainMainQueue()
        try host.harvestViewerFrames()
        let claim = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .claimAcquire })
        XCTAssertFalse(host.receivedFromViewer.contains { $0.type == .claimRelease })

        view.pumpHostFrame(
            WireFrame(
                type: .claimResult,
                flags: [.response, .final],
                requestId: claim.requestId,
                payload: try claimGrantedPayload(token: "claim-composition")
            ),
            frameBinding: binding
        )
        try host.harvestViewerFrames()
        let input = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .inputSubmit })
        XCTAssertFalse(host.receivedFromViewer.contains { $0.type == .claimRelease })
        let inputObject = try FrameCodec.parseJSONObject(input.payload)
        let transactionId = try XCTUnwrap(inputObject["transactionId"] as? String)

        view.pumpHostFrame(
            WireFrame(
                type: .applied,
                flags: [.response, .final],
                requestId: input.requestId,
                payload: try FrameCodec.jsonPayload([
                    "schemaVersion": 1,
                    "resultKind": "input",
                    "receipt": [
                        "transactionId": transactionId,
                        "stage": "written-to-terminal",
                        "byteRange": ["start": "0", "endExclusive": "9"],
                        "orderedAt": "1",
                        "availableCreditBytes": FrameCodec.inputTransactionMaxBytes,
                        "consumedByProcess": "not-claimed",
                        "completeness": "complete",
                        "diagnostic": NSNull(),
                    ],
                ])
            ),
            frameBinding: binding
        )
        try host.harvestViewerFrames()
        let release = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .claimRelease })
        let releaseObject = try FrameCodec.parseJSONObject(release.payload)
        XCTAssertEqual(releaseObject["claimToken"] as? String, "claim-composition")
        XCTAssertEqual(releaseObject["kind"] as? String, "cancel")
        XCTAssertEqual(view.claimPresentation, .free)
    }

    func testOversizeEncodedInputIsChunkedWithoutRefusal() throws {
        let host = FakeHost(connectionId: "input-oversize")
        let engine = FakeManualSurface()
        let view = try attachView(host: host, engine: engine)
        let binding = try XCTUnwrap(view.binding)
        let bytes = Data(repeating: 0x61, count: FrameCodec.inputTransactionMaxBytes + 1)

        view.attachClient?.handleEncodedWrite(bytes)
        try host.harvestViewerFrames()
        let claim = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .claimAcquire })
        view.pumpHostFrame(
            WireFrame(
                type: .claimResult,
                flags: [.response, .final],
                requestId: claim.requestId,
                payload: try claimGrantedPayload(token: "claim-chunked-input")
            ),
            frameBinding: binding
        )
        try host.harvestViewerFrames()

        if case .refused(let code, _) = view.inputSubmissionState {
            XCTFail("chunkable input must not be refused, got \(code)")
        }
        let submits = host.receivedFromViewer.filter { $0.type == .inputSubmit }
        XCTAssertEqual(submits.count, 2)
        let submittedBytes = try submits.reduce(into: Data()) { result, submit in
            let object = try FrameCodec.parseJSONObject(submit.payload)
            let operation = try XCTUnwrap(object["operation"] as? [String: Any])
            result.append(try XCTUnwrap(
                Data(base64Encoded: try XCTUnwrap(operation["bytes"] as? String))))
        }
        XCTAssertEqual(submittedBytes, bytes)
    }

    func testSubsequentResizeUsesFrozenExactSessionPayload() throws {
        let host = FakeHost(connectionId: "input-resize")
        let engine = FakeManualSurface()
        let view = try attachView(host: host, engine: engine)
        let binding = try XCTUnwrap(view.binding)

        try view.attachClient?.sendResize(geometry)
        try host.harvestViewerFrames()

        let resize = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .resize })
        let object = try FrameCodec.parseJSONObject(resize.payload)
        let session = try XCTUnwrap(object["session"] as? [String: Any])
        XCTAssertEqual(session["key"] as? String, binding.locator.sessionId)
        XCTAssertEqual(session["incarnation"] as? String, String(binding.generation))
        let window = try XCTUnwrap(object["window"] as? [String: Any])
        XCTAssertEqual(window["columns"] as? Int, geometry.columns)
        XCTAssertEqual(window["rows"] as? Int, geometry.rows)
        XCTAssertEqual(window["widthPixels"] as? Int, geometry.widthPx)
        XCTAssertEqual(window["heightPixels"] as? Int, geometry.heightPx)
        XCTAssertEqual(object["revision"] as? String, "2")
        XCTAssertNotNil(object["idempotencyKey"] as? String)
        XCTAssertNil(object["locator"])
        XCTAssertNil(object["geometry"])
    }

    func testResizeReceiptsAreCorrelatedAndObservable() throws {
        let host = FakeHost(connectionId: "input-resize-receipts")
        let engine = FakeManualSurface()
        let view = try attachView(host: host, engine: engine)
        let binding = try XCTUnwrap(view.binding)
        let receipts: [(expected: String, object: [String: Any])] = [
            (
                "applied 80x24",
                [
                    "schemaVersion": 1,
                    "resultKind": "resize",
                    "result": [
                        "state": "applied",
                        "readback": ["columns": 80, "rows": 24],
                    ],
                ]
            ),
            (
                "stale currentRevision=7",
                [
                    "schemaVersion": 1,
                    "resultKind": "resize",
                    "result": ["state": "stale", "currentRevision": "7"],
                ]
            ),
            (
                "unknown host lost resize",
                [
                    "schemaVersion": 1,
                    "resultKind": "resize",
                    "result": ["state": "unknown", "diagnostic": "host lost resize"],
                ]
            ),
            (
                "malformed ",
                ["schemaVersion": 1, "resultKind": "input"]
            ),
        ]

        for receipt in receipts {
            let resize = try sendResize(from: view, to: host)
            let payload = try FrameCodec.jsonPayload(receipt.object)
            view.pumpHostFrame(
                WireFrame(
                    type: .applied,
                    flags: [.response, .final],
                    requestId: resize.requestId,
                    payload: payload
                ),
                frameBinding: binding
            )
            XCTAssertEqual(view.attachClient?.lastResizeResult, receipt.expected)
        }
    }

    func testResizeErrorReplacesStaleSuccessAndClearsRequest() throws {
        let host = FakeHost(connectionId: "input-resize-error")
        let view = try attachView(host: host, engine: FakeManualSurface())
        let binding = try XCTUnwrap(view.binding)

        try recordSuccessfulResize(on: view, host: host, binding: binding)

        let failed = try sendResize(from: view, to: host)
        let error = try FrameCodec.jsonPayload([
            "schemaVersion": 1,
            "code": "CLOSED",
            "message": "resize rejected",
        ])
        view.pumpHostFrame(
            WireFrame(type: .error, requestId: failed.requestId, payload: error),
            frameBinding: binding
        )
        XCTAssertEqual(view.attachClient?.lastResizeResult, "error CLOSED: resize rejected")

        view.pumpHostFrame(
            WireFrame(
                type: .applied,
                requestId: failed.requestId,
                payload: try resizeAppliedPayload()
            ),
            frameBinding: binding
        )
        XCTAssertEqual(view.attachClient?.lastResizeResult, "error CLOSED: resize rejected")
    }

    func testMalformedResizeReceiptReplacesStaleSuccess() throws {
        let host = FakeHost(connectionId: "input-resize-malformed")
        let view = try attachView(host: host, engine: FakeManualSurface())
        let binding = try XCTUnwrap(view.binding)

        try recordSuccessfulResize(on: view, host: host, binding: binding)

        let malformed = try sendResize(from: view, to: host)
        view.pumpHostFrame(
            WireFrame(
                type: .applied,
                requestId: malformed.requestId,
                payload: Data("not-json".utf8)
            ),
            frameBinding: binding
        )
        XCTAssertEqual(view.attachClient?.lastResizeResult, "unknown malformed resize receipt")
    }

    func testRebindClearsResizeResultAndRejectsPriorBindingReceipt() throws {
        let host = FakeHost(connectionId: "input-resize-rebind")
        let view = try attachView(host: host, engine: FakeManualSurface())
        let binding = try XCTUnwrap(view.binding)

        try recordSuccessfulResize(on: view, host: host, binding: binding)

        let pending = try sendResize(from: view, to: host)
        let rebound = SurfaceBinding(
            locator: makeTestLocator(generation: 2),
            connectionId: "input-resize-rebound"
        )
        view.attachClient?.retarget(newBinding: rebound)
        XCTAssertNil(view.attachClient?.lastResizeResult)

        view.pumpHostFrame(
            WireFrame(
                type: .applied,
                requestId: pending.requestId,
                payload: try resizeAppliedPayload()
            ),
            frameBinding: rebound
        )
        XCTAssertNil(view.attachClient?.lastResizeResult)
    }

    private func sendResize(from view: HiveTerminalView, to host: FakeHost) throws -> WireFrame {
        try view.attachClient?.sendResize(geometry)
        try host.harvestViewerFrames()
        return try XCTUnwrap(host.receivedFromViewer.last { $0.type == .resize })
    }

    private func recordSuccessfulResize(
        on view: HiveTerminalView,
        host: FakeHost,
        binding: SurfaceBinding
    ) throws {
        let resize = try sendResize(from: view, to: host)
        view.pumpHostFrame(
            WireFrame(
                type: .applied,
                requestId: resize.requestId,
                payload: try resizeAppliedPayload()
            ),
            frameBinding: binding
        )
        XCTAssertEqual(view.attachClient?.lastResizeResult, "applied 80x24")
    }

    private func resizeAppliedPayload() throws -> Data {
        try FrameCodec.jsonPayload([
            "schemaVersion": 1,
            "resultKind": "resize",
            "result": [
                "state": "applied",
                "readback": ["columns": 80, "rows": 24],
            ],
        ])
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
        try host.enqueueWelcome(instanceId: locator.instanceId, connectionId: host.hostTransport.connectionId)
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
