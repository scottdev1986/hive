import Foundation
@testable import HiveTerminalKit

/// Mock §20-wire host for L2 tests (NOT the real WP4 host).
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

    func harvestViewerFrames() throws {
        // Drain host side without blocking forever.
        while true {
            do {
                guard let frame = try hostTransport.receive(timeout: 0.01) else { break }
                receivedFromViewer.append(frame)
            } catch WireError.receiveTimeout {
                break
            }
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

    /// SNAPSHOT as HVTCP001 envelope bytes (may be multi-chunk).
    func enqueueSnapshotEnvelope(throughSeq: UInt64, enginePayload: Data, chunkSize: Int? = nil) {
        let envelope = CheckpointEnvelope.encode(
            throughSeq: throughSeq,
            payload: enginePayload
        )
        clientTransport.enqueueInbound(
            WireFrame(type: .snapshotBegin, payload: Data())
        )
        if let chunkSize, chunkSize > 0 {
            var offset = 0
            while offset < envelope.count {
                let end = min(offset + chunkSize, envelope.count)
                clientTransport.enqueueInbound(
                    WireFrame(
                        type: .snapshotBytes,
                        flags: [.contentSensitive],
                        streamSeq: UInt64(offset),
                        payload: envelope.subdata(in: offset..<end)
                    )
                )
                offset = end
            }
        } else {
            clientTransport.enqueueInbound(
                WireFrame(
                    type: .snapshotBytes,
                    flags: [.final, .contentSensitive],
                    payload: envelope
                )
            )
        }
    }

    func enqueueOutput(streamSeq: UInt64, bytes: Data) {
        clientTransport.enqueueInbound(
            WireFrame(type: .output, flags: [.contentSensitive], streamSeq: streamSeq, payload: bytes)
        )
    }

    func makeGrant(
        locator: SessionLocator,
        token: String = "grant-token-test",
        checkpointSeq: UInt64 = 0,
        outputSeq: UInt64 = 0,
        engineBuildId: String? = nil
    ) -> AttachGrant {
        AttachGrant(
            locator: locator,
            endpoint: "unix:fake-host",
            token: token,
            expiresAt: "2099-01-01T00:00:00.000Z",
            engineBuildId: engineBuildId ?? locator.engineBuildId ?? "engine-test",
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
