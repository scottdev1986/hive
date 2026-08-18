import AppKit
import XCTest
@testable import HiveTerminalKit

/// Human keystrokes remain writable because they are raw terminal input, not a
/// viewer-side transaction that can be fenced by claim state or receipts.
final class InputNeverFrozenTests: XCTestCase {
    private let geometry = TerminalGeometry(
        columns: 80,
        rows: 24,
        widthPx: 800,
        heightPx: 480,
        cellWidthPx: 10,
        cellHeightPx: 20
    )

    func testInProcessKeyEventSendsGhosttyBytesDirectly() throws {
        _ = NSApplication.shared
        let host = FakeHost(connectionId: "direct-key-input")
        let engine = try GhosttyBridgeFactory.makeManualSurfaceForTesting()
        defer { engine.free() }
        let view = try attachView(host: host, engine: engine, snapshotPayload: nil)

        view.keyDown(with: Self.shiftEnterEvent())
        try waitForFrames(host, type: .userInput, count: 1)

        let input = try XCTUnwrap(host.receivedFromViewer.last { $0.type == .userInput })
        XCTAssertEqual(
            input.payload,
            Data("\u{1B}[27;2;13~".utf8),
            "the raw frame must contain Ghostty's exact encoded bytes"
        )
        XCTAssertFalse(host.receivedFromViewer.contains { $0.type == .inputSubmit })
    }

    private func inputAroundLegacyHostFrame(
        connectionId: String,
        makeFrame: () throws -> WireFrame
    ) throws -> [WireFrame] {
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
        view.pumpHostFrame(try makeFrame(), frameBinding: binding)

        view.insertText(
            "second\n",
            replacementRange: NSRange(location: NSNotFound, length: 0),
            associatedEvent: nil
        )
        drainMainQueue()
        try host.harvestViewerFrames()
        return host.receivedFromViewer.filter { $0.type == .userInput }
    }

    func testLegacyOrphanEventCannotFenceHumanInput() throws {
        let frames = try inputAroundLegacyHostFrame(connectionId: "never-frozen-orphan") {
            WireFrame(
                type: .event,
                payload: try FrameCodec.jsonPayload([
                    "schemaVersion": 1,
                    "kind": "USER_ORPHANED",
                    "claimId": "retired-claim",
                ])
            )
        }

        XCTAssertEqual(frames.map(\.payload), [Data("first\n".utf8), Data("second\n".utf8)])
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
