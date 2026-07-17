import XCTest
@testable import HiveTerminalKit

/// First-correct-frame after attach against FakeHost (§09/§20/§26).
/// Uses: FakeHost + FakeManualSurface (no GhosttyKit for attach logic).
final class AttachReplayTests: XCTestCase {
    func testFirstCorrectFrameAfterAttach() throws {
        let host = FakeHost(connectionId: "attach-conn-1")
        let locator = makeTestLocator()
        let grant = host.makeGrant(locator: locator, checkpointSeq: 0, outputSeq: 0)
        let engine = FakeManualSurface()
        let client = AttachReplayClient(viewerId: "viewer-1", engine: engine)

        // Host→viewer stream ready before attach drains.
        try host.enqueueWelcome(instanceId: locator.instanceId, connectionId: host.hostTransport.connectionId)
        let checkpoint = Data("CHECKPOINT-PAYLOAD-v1".utf8)
        try host.enqueueSnapshot(throughSeq: 10, payload: checkpoint)
        host.enqueueOutput(streamSeq: 10, bytes: Data("hello-from-pty".utf8))

        let outcome = try client.attach(
            grant: grant,
            geometry: makeGeometry(),
            afterSeq: 0,
            transport: host.clientTransport
        )

        guard case .firstCorrectFrame(let highWater, let connectionId) = outcome else {
            XCTFail("expected firstCorrectFrame, got \(outcome)")
            return
        }
        XCTAssertEqual(connectionId, host.clientTransport.connectionId)
        XCTAssertGreaterThanOrEqual(highWater, 10)
        XCTAssertTrue(client.firstCorrectFramePresented)
        XCTAssertEqual(client.state, .live)
        XCTAssertEqual(engine.restored.count, 1)
        XCTAssertEqual(engine.restored.first?.throughSeq, 10)
        XCTAssertEqual(engine.restored.first?.payload, checkpoint)
        // Output after checkpoint applied.
        XCTAssertTrue(engine.appliedRanges.contains { $0.bytes == Data("hello-from-pty".utf8) })

        // Viewer must have sent APPLIED high-water.
        try host.harvestViewerFrames()
        let applied = host.receivedFromViewer.filter { $0.type == .applied }
        XCTAssertFalse(applied.isEmpty, "renderer must ACK high-water with APPLIED")
    }

    func testAttachRestoreOnlyStillPresentsFirstCorrectFrame() throws {
        let host = FakeHost()
        let locator = makeTestLocator()
        let grant = host.makeGrant(locator: locator)
        let engine = FakeManualSurface()
        let client = AttachReplayClient(viewerId: "viewer-2", engine: engine)

        try host.enqueueWelcome(instanceId: locator.instanceId, connectionId: "h")
        try host.enqueueSnapshot(throughSeq: 4, payload: Data("snap".utf8))

        let outcome = try client.attach(
            grant: grant,
            geometry: makeGeometry(),
            afterSeq: 0,
            transport: host.clientTransport
        )
        guard case .firstCorrectFrame(let hw, _) = outcome else {
            XCTFail("expected firstCorrectFrame from checkpoint alone, got \(outcome)")
            return
        }
        XCTAssertEqual(hw, 4)
        XCTAssertEqual(client.state, .live)
    }

    func testViewAttachDoesNotStealFocusOnFirstFrame() throws {
        let host = FakeHost()
        let locator = makeTestLocator()
        let grant = host.makeGrant(locator: locator)
        let engine = FakeManualSurface()
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 100, height: 100),
            engine: engine
        )
        let other = NSView(frame: .zero)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 200, height: 200),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        let root = NSView(frame: window.contentView!.bounds)
        root.addSubview(view)
        root.addSubview(other)
        window.contentView = root
        window.makeFirstResponder(other)

        try host.enqueueWelcome(instanceId: locator.instanceId, connectionId: "h")
        try host.enqueueSnapshot(throughSeq: 2, payload: Data("ab".utf8))
        host.enqueueOutput(streamSeq: 2, bytes: Data("c".utf8))

        var firstFrameHW: UInt64?
        view.onFirstCorrectFrame = { firstFrameHW = $0 }

        let outcome = try view.attach(
            grant: grant,
            geometry: makeGeometry(),
            afterSeq: 0,
            transport: host.clientTransport
        )
        XCTAssertEqual(outcome, .firstCorrectFrame(highWater: 3, connectionId: host.clientTransport.connectionId))
        XCTAssertEqual(firstFrameHW, 3)
        XCTAssertTrue(window.firstResponder === other, "first correct frame must not steal focus")
        XCTAssertEqual(view.focusStealAttempts, 0)
    }

    func testFrameCodecRoundTripMatchesSection20Header() throws {
        let payload = Data("raw-output".utf8)
        let frame = WireFrame(
            type: .output,
            flags: [.contentSensitive],
            requestId: 0,
            streamSeq: 99,
            payload: payload
        )
        let encoded = try FrameCodec.encode(frame)
        XCTAssertEqual(encoded.count, FrameCodec.headerBytes + payload.count)
        XCTAssertEqual(Array(encoded.prefix(4)), FrameCodec.magic)
        let header = encoded.prefix(FrameCodec.headerBytes)
        let body = encoded.suffix(from: FrameCodec.headerBytes)
        let decoded = try FrameCodec.decodeFrame(header: Data(header), payload: Data(body))
        XCTAssertEqual(decoded, frame)
    }
}
