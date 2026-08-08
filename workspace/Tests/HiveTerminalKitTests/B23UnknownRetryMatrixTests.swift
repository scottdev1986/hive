import AppKit
import XCTest
@testable import HiveTerminalKit

/// Interactive input follows the same contract as a conventional terminal:
/// encoder bytes are sent immediately, without waiting for a claim or receipt.
final class B23UnknownRetryMatrixTests: XCTestCase {
    private let geometry = TerminalGeometry(
        columns: 80,
        rows: 24,
        widthPx: 800,
        heightPx: 480,
        cellWidthPx: 10,
        cellHeightPx: 20
    )

    private func userInputAfterSecondType(interveningFrame: WireFrame?) throws -> [WireFrame] {
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

        if let interveningFrame {
            view.pumpHostFrame(interveningFrame, frameBinding: binding)
        }

        view.insertText(
            "second\n",
            replacementRange: NSRange(location: NSNotFound, length: 0),
            associatedEvent: nil
        )
        drainMainQueue()
        try host.harvestViewerFrames()

        return host.receivedFromViewer.filter { $0.type == .userInput }
    }

    func testLegacyUnknownReceiptCannotFreezeFutureInput() throws {
        let staleReceipt = WireFrame(
            type: .applied,
            flags: [.response, .final],
            requestId: 999,
            payload: try FrameCodec.jsonPayload([
                "schemaVersion": 1,
                "resultKind": "input",
                "receipt": ["transactionId": "retired-input-transaction", "stage": "unknown"],
            ])
        )
        let frames = try userInputAfterSecondType(interveningFrame: staleReceipt)

        XCTAssertEqual(frames.map(\.payload), [Data("first\n".utf8), Data("second\n".utf8)])
    }

    func testBackToBackInputDoesNotWaitForAReceipt() throws {
        let frames = try userInputAfterSecondType(interveningFrame: nil)

        XCTAssertEqual(frames.map(\.payload), [Data("first\n".utf8), Data("second\n".utf8)])
        XCTAssertTrue(frames.allSatisfy { $0.requestId == 0 })
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
