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

    func testDuplicateAckFloodHasBoundedTemporaryMemory() throws {
        let transport = CountingHostTransport(connectionId: "autorelease-flood")
        transport.enqueue(WireFrame(type: .welcome))
        let ready = Data("ready".utf8)
        transport.enqueue(WireFrame(type: .output, streamSeq: 0, payload: ready))

        let engine = FakeManualSurface()
        let client = AttachReplayClient(viewerId: "autorelease-flood", engine: engine)
        let locator = makeTestLocator()
        let grant = AttachGrant(
            locator: locator,
            endpoint: "memory:test",
            token: "autorelease-flood-token",
            expiresAt: "2099-01-01T00:00:00.000Z",
            engineBuildId: HiveTerminalEngineIdentity.current.buildId,
            checkpointSeq: 0,
            outputSeq: UInt64(ready.count),
            operations: ["view"]
        )
        let outcome = try client.attach(
            grant: grant,
            geometry: geometry,
            afterSeq: 0,
            transport: transport
        )
        guard case .firstCorrectFrame = outcome else {
            return XCTFail("expected first correct frame, got \(outcome)")
        }
        let binding = try XCTUnwrap(client.binding)
        let duplicate = WireFrame(type: .output, streamSeq: 0, payload: ready)
        let baseline = try physicalFootprintBytes()

        let duplicateCount = 30_000
        for _ in 0..<duplicateCount {
            XCTAssertEqual(
                try client.handleFrame(duplicate, frameBinding: binding),
                .firstCorrectFrame(highWater: UInt64(ready.count), connectionId: binding.connectionId)
            )
        }

        let settled = try physicalFootprintBytes()
        let growth = settled > baseline ? settled - baseline : 0
        XCTAssertLessThanOrEqual(
            growth,
            32 * 1024 * 1024,
            "temporary JSON acknowledgement objects must drain per frame; growth=\(growth)"
        )
        XCTAssertEqual(transport.appliedCount, duplicateCount + 1)
        XCTAssertEqual(engine.appliedRanges.count, 1)
    }

    private func physicalFootprintBytes() throws -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size
        )
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else {
            throw NSError(domain: NSMachErrorDomain, code: Int(result))
        }
        return info.phys_footprint
    }
}

private final class CountingHostTransport: HostTransport {
    let connectionId: String
    private(set) var isClosed = false
    private(set) var appliedCount = 0
    private var inbound: [WireFrame] = []

    init(connectionId: String) {
        self.connectionId = connectionId
    }

    func enqueue(_ frame: WireFrame) {
        inbound.append(frame)
    }

    func send(_ frame: WireFrame) throws {
        guard !isClosed else { throw WireError.closed }
        if frame.type == .applied { appliedCount += 1 }
    }

    func receive(timeout: TimeInterval?) throws -> WireFrame? {
        _ = timeout
        guard !isClosed else { return nil }
        guard !inbound.isEmpty else { throw WireError.receiveTimeout }
        return inbound.removeFirst()
    }

    func close() {
        isClosed = true
        inbound.removeAll()
    }
}
