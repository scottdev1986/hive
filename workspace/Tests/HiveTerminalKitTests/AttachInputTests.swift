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

    func testTextSendsOneRawInputFrame() throws {
        let host = FakeHost(connectionId: "input-conn")
        let engine = FakeManualSurface()
        let view = try attachView(host: host, engine: engine)
        view.insertText("typed-✓\n", replacementRange: NSRange(location: NSNotFound, length: 0), associatedEvent: nil)
        drainMainQueue()
        try host.harvestViewerFrames()

        XCTAssertFalse(host.receivedFromViewer.contains { $0.type == .inputSubmit })
        let input = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .userInput })
        XCTAssertEqual(input.flags, [.contentSensitive])
        XCTAssertEqual(input.requestId, 0)
        XCTAssertEqual(input.payload, Data("typed-✓\n".utf8))
    }

    func testTerminalReplyUsesTheSameRawInputPath() throws {
        let host = FakeHost(connectionId: "terminal-reply")
        let engine = FakeManualSurface()
        let view = try attachView(host: host, engine: engine)

        view.attachClient?.handleEncodedWrite(Data("reply".utf8))
        try host.harvestViewerFrames()

        let input = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .userInput })
        XCTAssertEqual(input.payload, Data("reply".utf8))
    }

    func testOversizeEncodedInputIsChunkedWithoutRefusal() throws {
        let host = FakeHost(connectionId: "input-oversize")
        let engine = FakeManualSurface()
        let view = try attachView(host: host, engine: engine)
        let bytes = Data(repeating: 0x61, count: FrameCodec.streamChunkMaxBytes + 1)

        view.attachClient?.handleEncodedWrite(bytes)
        try host.harvestViewerFrames()

        let submits = host.receivedFromViewer.filter { $0.type == .userInput }
        XCTAssertEqual(submits.count, 2)
        let submittedBytes = submits.reduce(into: Data()) { result, submit in
            XCTAssertLessThanOrEqual(submit.payload.count, FrameCodec.streamChunkMaxBytes)
            result.append(submit.payload)
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
