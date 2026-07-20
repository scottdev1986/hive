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

    func testOversizeEncodedInputIsTypedRefusalAndSendsZeroInputFrames() throws {
        let host = FakeHost(connectionId: "input-oversize")
        let engine = FakeManualSurface()
        let view = try attachView(host: host, engine: engine)

        view.attachClient?.handleEncodedWrite(
            Data(repeating: 0x61, count: FrameCodec.inputTransactionMaxBytes + 1)
        )
        try host.harvestViewerFrames()

        guard case .refused(let code, _) = view.inputSubmissionState else {
            return XCTFail("oversize input did not produce a typed refusal")
        }
        XCTAssertEqual(code, "PAYLOAD_TOO_LARGE")
        XCTAssertFalse(host.receivedFromViewer.contains { $0.type == .claimAcquire })
        XCTAssertFalse(host.receivedFromViewer.contains { $0.type == .inputSubmit })
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
