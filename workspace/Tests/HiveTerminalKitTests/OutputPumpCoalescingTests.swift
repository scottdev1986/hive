import AppKit
import XCTest
@testable import HiveTerminalKit

/// Output pump ordering (SessiondPaneTerminal pump): a burst of host frames
/// must reach the surface in contiguous wire order with exactly one APPLIED
/// ack per applied frame, and an ack high-water that never regresses.
final class OutputPumpCoalescingTests: XCTestCase {
    private let geometry = TerminalGeometry(
        columns: 80,
        rows: 24,
        widthPx: 800,
        heightPx: 480,
        cellWidthPx: 10,
        cellHeightPx: 20
    )

    private func attachView(host: FakeHost, engine: FakeManualSurface) throws -> HiveTerminalView {
        let locator = makeTestLocator()
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 800, height: 480),
            engine: engine,
            viewerId: "coalesce-viewer"
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

    /// Mirrors the production pump loop in SessiondPaneTerminal.startPump:
    /// blocking receive, then apply that one frame. Returns the frame count.
    @discardableResult
    private func pumpAllFrames(
        view: HiveTerminalView,
        transport: InMemoryHostTransport,
        binding: SurfaceBinding
    ) -> Int {
        var applied = 0
        while true {
            let first: WireFrame
            do {
                guard let next = try transport.receive(timeout: 0.5) else { break }
                first = next
            } catch WireError.receiveTimeout {
                break
            } catch {
                break
            }
            view.pumpHostFrame(first, frameBinding: binding)
            applied += 1
        }
        return applied
    }

    func testBurstAppliesInWireOrderWithOneAckPerFrame() throws {
        let host = FakeHost(connectionId: "coalesce-burst")
        let engine = FakeManualSurface()
        let view = try attachView(host: host, engine: engine)
        let binding = try XCTUnwrap(view.binding)
        let highWaterAfterAttach = view.highWater

        // 100 contiguous output frames behind the attach, all buffered before
        // the pump starts — the scrollback-flood shape.
        var expected = Data()
        var streamSeq = highWaterAfterAttach
        for index in 0..<100 {
            let bytes = Data("chunk-\(index)\n".utf8)
            host.enqueueOutput(streamSeq: streamSeq, bytes: bytes)
            streamSeq += UInt64(bytes.count)
            expected.append(bytes)
        }

        let applied_count = pumpAllFrames(
            view: view,
            transport: host.clientTransport,
            binding: binding
        )
        XCTAssertEqual(applied_count, 100, "every buffered frame applies")

        // Every range in wire order, byte-for-byte.
        let applied = engine.appliedRanges.dropFirst() // attach's "ready"
        XCTAssertEqual(applied.count, 100)
        var expectedSeq = highWaterAfterAttach
        for range in applied {
            XCTAssertEqual(range.streamSeq, expectedSeq, "ranges apply in contiguous wire order")
            expectedSeq += UInt64(range.bytes.count)
        }
        XCTAssertEqual(applied.reduce(Data()) { $0 + $1.bytes }, expected)
        XCTAssertEqual(view.highWater, highWaterAfterAttach + UInt64(expected.count))

        // Acks: exactly one APPLIED per applied frame, throughSeq monotone,
        // final ack equal to the applied high-water (attach ack + 100 burst).
        try host.harvestViewerFrames()
        var ackSeqs: [UInt64] = []
        for frame in host.receivedFromViewer where frame.type == .applied {
            let object = try FrameCodec.parseJSONObject(frame.payload)
            guard object["resultKind"] as? String == "output",
                  let through = (object["throughSeq"] as? String).flatMap(UInt64.init)
            else { continue }
            ackSeqs.append(through)
        }
        XCTAssertEqual(ackSeqs.count, 101, "one ack per applied output frame")
        XCTAssertEqual(ackSeqs.first, highWaterAfterAttach)
        XCTAssertEqual(ackSeqs.last, view.highWater)
        XCTAssertEqual(ackSeqs, ackSeqs.sorted(), "ack high-water never regresses")
    }
}
