import XCTest
@testable import HiveTerminalKit

/// First-correct-frame + checkpoint envelope + multi-chunk (FakeHost).
final class AttachReplayTests: XCTestCase {
    func testFirstCorrectFrameAfterAttach() throws {
        let host = FakeHost(connectionId: "attach-conn-1")
        let locator = makeTestLocator()
        let grant = host.makeGrant(locator: locator)
        let engine = FakeManualSurface()
        let client = AttachReplayClient(viewerId: "viewer-1", engine: engine)

        try host.enqueueWelcome(instanceId: locator.instanceId, connectionId: host.hostTransport.connectionId)
        let enginePayload = Data("CHECKPOINT-ENGINE-PAYLOAD".utf8)
        host.enqueueSnapshotEnvelope(throughSeq: 10, enginePayload: enginePayload)
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
        XCTAssertEqual(engine.restored.first?.payload, enginePayload)
        XCTAssertTrue(engine.appliedRanges.contains { $0.bytes == Data("hello-from-pty".utf8) })
        try host.harvestViewerFrames()
        XCTAssertFalse(host.receivedFromViewer.filter { $0.type == .applied }.isEmpty)
    }

    func testMultiChunkSnapshotRestoresOnlyWhenComplete() throws {
        let host = FakeHost()
        let locator = makeTestLocator()
        let grant = host.makeGrant(locator: locator)
        let engine = FakeManualSurface()
        let client = AttachReplayClient(viewerId: "viewer-2", engine: engine)

        try host.enqueueWelcome(instanceId: locator.instanceId, connectionId: "h")
        let payload = Data(repeating: 0x42, count: 200)
        host.enqueueSnapshotEnvelope(throughSeq: 7, enginePayload: payload, chunkSize: 40)

        let outcome = try client.attach(
            grant: grant,
            geometry: makeGeometry(),
            afterSeq: 0,
            transport: host.clientTransport
        )
        guard case .firstCorrectFrame(let hw, _) = outcome else {
            XCTFail("expected firstCorrectFrame, got \(outcome)")
            return
        }
        XCTAssertEqual(hw, 7)
        XCTAssertEqual(engine.restored.first?.payload, payload)
    }

    func testPostRestoreDuplicateOutputIsIgnoredNotLost() throws {
        let engine = FakeManualSurface()
        let client = AttachReplayClient(viewerId: "v", engine: engine)
        let binding = SurfaceBinding(locator: makeTestLocator(), connectionId: "c")
        client.retarget(newBinding: binding, highWater: 0)

        // Restore to high-water 5.
        let r = client.applicator.restoreCheckpoint(
            payload: Data("snap".utf8),
            throughSeq: 5,
            frameBinding: binding
        )
        XCTAssertEqual(r, .applied(newHighWater: 5))

        // At-least-once retransmit fully behind high-water (M7).
        let late = try client.handleFrame(
            WireFrame(type: .output, streamSeq: 0, payload: Data("hello".utf8)),
            frameBinding: binding
        )
        XCTAssertEqual(late, .continueReplay)
        XCTAssertNotEqual(client.state, .lost(evidence: "REBASE_REQUIRED"))
        XCTAssertEqual(client.applicator.highWater, 5)
    }

    func testWelcomeRequiredBeforeHostAttach() throws {
        let host = FakeHost()
        let locator = makeTestLocator()
        let grant = host.makeGrant(locator: locator)
        let engine = FakeManualSurface()
        let client = AttachReplayClient(viewerId: "viewer-3", engine: engine)
        client.handshakeTimeout = 0.05
        // No WELCOME enqueued — must fail closed, never HOST_ATTACH.
        do {
            _ = try client.attach(
                grant: grant,
                geometry: makeGeometry(),
                afterSeq: 0,
                transport: host.clientTransport
            )
            XCTFail("attach without WELCOME must throw")
        } catch let err as WireError {
            XCTAssertTrue(
                err == .receiveTimeout || err == .protocolMismatch("transport closed before WELCOME")
                    || String(describing: err).contains("WELCOME")
                    || String(describing: err).contains("TIMEOUT")
                    || String(describing: err).contains("PROTOCOL"),
                "got \(err)"
            )
        }
        try host.harvestViewerFrames()
        let hostAttach = host.receivedFromViewer.filter { $0.type == .hostAttach }
        XCTAssertTrue(hostAttach.isEmpty, "must not send HOST_ATTACH without WELCOME")
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
        host.enqueueSnapshotEnvelope(throughSeq: 2, enginePayload: Data("ab".utf8))
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
        XCTAssertTrue(window.firstResponder === other)
        XCTAssertEqual(view.focusStealAttempts, 0)
    }

    func testViewAppliesHiveConfigurationOnceAtFirstCorrectFrameBeforePresentation() throws {
        let host = FakeHost(connectionId: "live-theme")
        let locator = makeTestLocator()
        let grant = host.makeGrant(locator: locator)
        let engine = FakeManualSurface()
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 800, height: 480),
            engine: engine
        )
        XCTAssertEqual(engine.hiveConfigurationApplyCount, 0)

        try host.enqueueWelcome(instanceId: locator.instanceId, connectionId: host.hostTransport.connectionId)
        host.enqueueOutput(streamSeq: 0, bytes: Data("ready".utf8))
        view.onFirstCorrectFrame = { _ in
            XCTAssertEqual(engine.hiveConfigurationApplyCount, 1)
            XCTAssertEqual(view.drawScheduledCount, 0)
        }

        let outcome = try view.attach(
            grant: grant,
            geometry: makeGeometry(),
            transport: host.clientTransport
        )
        guard case .firstCorrectFrame = outcome else {
            XCTFail("expected firstCorrectFrame, got \(outcome)")
            return
        }
        XCTAssertEqual(engine.hiveConfigurationApplyCount, 1)

        let binding = try XCTUnwrap(view.binding)
        view.pumpHostFrame(
            WireFrame(type: .output, streamSeq: 5, payload: Data("again".utf8)),
            frameBinding: binding
        )
        XCTAssertEqual(engine.hiveConfigurationApplyCount, 1)
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
        let header = encoded.prefix(FrameCodec.headerBytes)
        let body = encoded.suffix(from: FrameCodec.headerBytes)
        let decoded = try FrameCodec.decodeFrame(header: Data(header), payload: Data(body))
        XCTAssertEqual(decoded, frame)
    }

    func testCheckpointEnvelopeFixtureMatchesNativeAbi() throws {
        // Mirror native/tests/abi/checkpoint-envelope.c field reads via generated offsets.
        let off = CheckpointEnvelope.FieldOffset.self
        let payload = Data("abc".utf8)
        let engineHex = GhosttyManualSurface.engineBuildId()
        var engineRaw = Data()
        var i = engineHex.startIndex
        while i < engineHex.endIndex {
            let j = engineHex.index(i, offsetBy: 2, limitedBy: engineHex.endIndex) ?? engineHex.endIndex
            engineRaw.append(UInt8(engineHex[i..<j], radix: 16) ?? 0)
            i = j
        }
        while engineRaw.count < 32 { engineRaw.append(0) }
        let env = CheckpointEnvelope.encode(
            throughSeq: 42,
            payload: payload,
            engineBuildId: Data(engineRaw.prefix(32))
        )
        // Positive control: header fields land at SessionProtocolGenerated.Checkpoint.Offset.
        XCTAssertEqual(String(data: env.subdata(in: off.magic..<(off.magic + 8)), encoding: .utf8), "HVTCP001")
        XCTAssertEqual(readU16BE(env, off.version), CheckpointEnvelope.version)
        XCTAssertEqual(readU16BE(env, off.headerBytes), UInt16(CheckpointEnvelope.headerBytes))
        XCTAssertEqual(readU32BE(env, off.flags), CheckpointEnvelope.flags)
        XCTAssertEqual(readU64BE(env, off.throughSeq), 42)
        XCTAssertEqual(readU32BE(env, off.payloadLength), 3)
        let parsed = try CheckpointEnvelope.parse(env)
        XCTAssertEqual(parsed.throughSeq, 42)
        XCTAssertEqual(parsed.payload, payload)
        XCTAssertEqual(parsed.payloadLength, 3)
        XCTAssertEqual(parsed.engineBuildIdHex, engineHex.prefix(64).lowercased() == engineHex.lowercased()
            ? engineHex.lowercased()
            : parsed.engineBuildIdHex)
    }

    /// A4 drift guard: consumer FieldOffset aliases the generated projection.
    /// Wire values live only in CHECKPOINT_HEADER → CheckpointHeader.generated.swift;
    /// never re-transcribe bare offset literals here.
    func testCheckpointEnvelopeOffsetsMatchGeneratedProjection() {
        let off = CheckpointEnvelope.FieldOffset.self
        let gen = SessionProtocolGenerated.Checkpoint.Offset.self
        XCTAssertEqual(off.magic, gen.magic)
        XCTAssertEqual(off.version, gen.version)
        XCTAssertEqual(off.headerBytes, gen.headerBytes)
        XCTAssertEqual(off.flags, gen.flags)
        XCTAssertEqual(off.throughSeq, gen.throughSeq)
        XCTAssertEqual(off.createdMonoNanos, gen.createdMonoNanos)
        XCTAssertEqual(off.columns, gen.columns)
        XCTAssertEqual(off.rows, gen.rows)
        XCTAssertEqual(off.cellWidthPx, gen.cellWidthPx)
        XCTAssertEqual(off.cellHeightPx, gen.cellHeightPx)
        XCTAssertEqual(off.engineBuildId, gen.engineBuildId)
        XCTAssertEqual(off.payloadLength, gen.payloadLength)
        XCTAssertEqual(off.payloadSha256, gen.payloadSha256)
        XCTAssertEqual(
            off.payloadSha256 + SessionProtocolGenerated.Checkpoint.payloadSha256Bytes,
            CheckpointEnvelope.headerBytes
        )
    }

    private func readU16BE(_ data: Data, _ offset: Int) -> UInt16 {
        (UInt16(data[offset]) << 8) | UInt16(data[offset + 1])
    }
    private func readU32BE(_ data: Data, _ offset: Int) -> UInt32 {
        (UInt32(data[offset]) << 24) | (UInt32(data[offset + 1]) << 16) |
            (UInt32(data[offset + 2]) << 8) | UInt32(data[offset + 3])
    }
    private func readU64BE(_ data: Data, _ offset: Int) -> UInt64 {
        var v: UInt64 = 0
        for i in 0..<8 { v = (v << 8) | UInt64(data[offset + i]) }
        return v
    }

    func testForeignEngineCheckpointRejected() throws {
        let host = FakeHost()
        let locator = makeTestLocator()
        let grant = host.makeGrant(locator: locator)
        let engine = FakeManualSurface()
        let client = AttachReplayClient(viewerId: "viewer-x", engine: engine)
        try host.enqueueWelcome(instanceId: locator.instanceId, connectionId: "h")
        // Craft envelope with wrong engine id (32 zero bytes) — must fail closed.
        let bad = CheckpointEnvelope.encode(
            throughSeq: 1,
            payload: Data("x".utf8),
            engineBuildId: Data(repeating: 0, count: 32)
        )
        host.clientTransport.enqueueInbound(WireFrame(type: .snapshotBegin, payload: Data()))
        host.clientTransport.enqueueInbound(
            WireFrame(type: .snapshotBytes, flags: [.final], payload: bad)
        )
        let outcome = try client.attach(
            grant: grant,
            geometry: makeGeometry(),
            afterSeq: 0,
            transport: host.clientTransport
        )
        guard case .failed(let state) = outcome else {
            XCTFail("expected failed incompatibleEngine, got \(outcome)")
            return
        }
        if case .incompatibleEngine = state {
            // ok
        } else {
            XCTFail("expected incompatibleEngine, got \(state)")
        }
        XCTAssertEqual(engine.restored.count, 0, "must not restore foreign-engine checkpoint")
    }
}
