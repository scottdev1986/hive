import Foundation
@testable import HiveTerminalKit

/// Mock §20-wire host for L2 tests (NOT the real WP4 host).
///
/// Pre-queues the host→viewer stream a viewer expects after HOST_ATTACH:
/// WELCOME → SNAPSHOT_BEGIN/BYTES → OUTPUT… and records viewer→host frames.
///
/// Uses: FakeHost only (no GhosttyKit.xcframework).
final class FakeHost {
    let hostTransport: InMemoryHostTransport
    let clientTransport: InMemoryHostTransport
    private(set) var receivedFromViewer: [WireFrame] = []

    init(connectionId: String = "fake-host-conn") {
        let pair = InMemoryHostTransport.makePair(
            clientId: "fake-client-\(connectionId)",
            hostId: connectionId
        )
        clientTransport = pair.client
        hostTransport = pair.host
    }

    /// Drain any frames the viewer already sent (HELLO / HOST_ATTACH / APPLIED).
    func harvestViewerFrames() throws {
        while let frame = try hostTransport.receive() {
            receivedFromViewer.append(frame)
        }
    }

    func enqueueWelcome(instanceId: String, connectionId: String, engineBuildId: String = "engine-test") throws {
        let payload: [String: Any] = [
            "schemaVersion": 1,
            "protocol": ["major": 1, "minor": 0],
            "instanceId": instanceId,
            "endpointRole": "host",
            "buildId": "fake-host",
            "engineBuildId": engineBuildId,
            "connectionId": connectionId,
            "serverEpoch": "1",
            "limits": [
                "controlFrameMaxBytes": FrameCodec.controlFrameMaxBytes,
                "streamChunkMaxBytes": FrameCodec.streamChunkMaxBytes,
                "automatedMessageMaxBytes": 1_048_576,
                "viewerQueueMaxBytes": 4_194_304,
            ],
        ]
        try enqueueJSON(.welcome, object: payload, flags: [.response, .final], requestId: 1)
    }

    /// SNAPSHOT_BEGIN metadata + SNAPSHOT_BYTES opaque payload (§20).
    func enqueueSnapshot(throughSeq: UInt64, payload: Data, payloadSha256Hex: String? = nil) throws {
        let digest = payloadSha256Hex ?? sha256(payload).map { String(format: "%02x", $0) }.joined()
        let begin: [String: Any] = [
            "schemaVersion": 1,
            "throughSeq": String(throughSeq),
            "payloadLength": payload.count,
            "payloadSha256": digest,
        ]
        try enqueueJSON(.snapshotBegin, object: begin)
        let frame = WireFrame(
            type: .snapshotBytes,
            flags: [.final, .contentSensitive],
            requestId: 0,
            streamSeq: 0,
            payload: payload
        )
        clientTransport.enqueueInbound(frame)
    }

    func enqueueOutput(streamSeq: UInt64, bytes: Data) {
        let frame = WireFrame(
            type: .output,
            flags: [.contentSensitive],
            requestId: 0,
            streamSeq: streamSeq,
            payload: bytes
        )
        clientTransport.enqueueInbound(frame)
    }

    func makeGrant(
        locator: SessionLocator,
        token: String = "grant-token-test",
        checkpointSeq: UInt64 = 0,
        outputSeq: UInt64 = 0
    ) -> AttachGrant {
        AttachGrant(
            locator: locator,
            endpoint: "unix:fake-host",
            token: token,
            expiresAt: "2099-01-01T00:00:00.000Z",
            engineBuildId: locator.engineBuildId ?? "engine-test",
            checkpointSeq: checkpointSeq,
            outputSeq: outputSeq,
            operations: ["view", "human-input", "resize"]
        )
    }

    private func enqueueJSON(
        _ type: FrameType,
        object: [String: Any],
        flags: FrameFlags = [],
        requestId: UInt64 = 0
    ) throws {
        let payload = try FrameCodec.jsonPayload(object)
        clientTransport.enqueueInbound(
            WireFrame(type: type, flags: flags, requestId: requestId, payload: payload)
        )
    }
}

func makeTestLocator(generation: Int = 1, sessionSuffix: String = "aaaaaaaa-7bbb-4ccc-8ddd-eeeeeeeeeeee") -> SessionLocator {
    SessionLocator(
        instanceId: "inst-test",
        subjectKind: "agent",
        agentId: "agt_test",
        generation: generation,
        sessionId: "ses_\(sessionSuffix)",
        hostKind: "sessiond",
        engineBuildId: "engine-test"
    )
}

func makeGeometry() -> TerminalGeometry {
    TerminalGeometry(
        columns: 80,
        rows: 24,
        widthPx: 800,
        heightPx: 480,
        cellWidthPx: 10,
        cellHeightPx: 20
    )
}
