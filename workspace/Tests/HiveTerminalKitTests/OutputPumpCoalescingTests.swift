import AppKit
import XCTest
@testable import HiveTerminalKit

/// Output coalescing (SessiondPaneTerminal pump): a burst of host frames must
/// reach the surface in bounded main-queue dispatches — one per drained batch
/// instead of one per 64 KiB frame — so queued scrollback cannot starve
/// keystrokes. Applied bytes and APPLIED acks must be byte-for-byte identical
/// to per-frame dispatch: ack only what was applied, in order.
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

    /// Mirrors the production pump turn in SessiondPaneTerminal.startPump:
    /// one blocking receive, one bounded drain, ONE main-queue block per turn.
    /// Returns the number of main-queue dispatches used.
    @discardableResult
    private func pumpCoalesced(
        view: HiveTerminalView,
        transport: InMemoryHostTransport,
        binding: SurfaceBinding,
        maxFramesPerTurn: Int
    ) -> Int {
        var dispatches = 0
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
            let batch = transport.drainAvailableFrames(
                first: first,
                maxFrames: maxFramesPerTurn
            )
            // One main-queue dispatch per batch in production; applied inline
            // here (tests already run on the main thread).
            dispatches += 1
            for frame in batch.frames {
                view.pumpHostFrame(frame, frameBinding: binding)
            }
            if batch.hostClosed { break }
        }
        return dispatches
    }

    func testBurstAppliesWithBoundedDispatchesAndIdenticalAckSequence() throws {
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

        let dispatches = pumpCoalesced(
            view: view,
            transport: host.clientTransport,
            binding: binding,
            maxFramesPerTurn: 32
        )
        XCTAssertEqual(
            dispatches,
            4,
            "100 buffered frames drain in ceil(100/32) main-queue dispatches, not 100"
        )

        // Applied output is identical to per-frame dispatch: every range in
        // wire order, byte-for-byte.
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

    /// An orderly host close mid-drain is reported: buffered frames deliver
    /// first, then the pump treats the connection as ended.
    func testDrainReportsOrderlyClose() throws {
        let pair = InMemoryHostTransport.makePair(clientId: "coalesce-c", hostId: "coalesce-h")
        let first = WireFrame(type: .output, streamSeq: 0, payload: Data("a".utf8))
        pair.client.close()

        let batch = pair.client.drainAvailableFrames(first: first, maxFrames: 32)
        XCTAssertEqual(batch.frames, [first])
        XCTAssertTrue(batch.hostClosed)
    }

    /// Nothing buffered behind `first` drains as a single-frame batch without
    /// blocking (the common steady-state turn).
    func testDrainWithEmptyQueueReturnsFirstOnly() throws {
        let pair = InMemoryHostTransport.makePair(clientId: "coalesce-c2", hostId: "coalesce-h2")
        let first = WireFrame(type: .output, streamSeq: 0, payload: Data("a".utf8))

        let batch = pair.client.drainAvailableFrames(first: first, maxFrames: 32)
        XCTAssertEqual(batch.frames, [first])
        XCTAssertFalse(batch.hostClosed)
    }
}
