import Foundation
@testable import HiveTerminalKit

/// Mock §20-wire host for L2 tests (NOT the real WP4 host).
final class FakeHost {
    let hostTransport: InMemoryHostTransport
    let clientTransport: InMemoryHostTransport
    private(set) var receivedFromViewer: [WireFrame] = []

    /// Real local engine id from GhosttyKit — production gate fails closed without it.
    let localEngineBuildId: String

    init(connectionId: String = "fake-host-conn") {
        let pair = InMemoryHostTransport.makePair(
            clientId: "fake-client-\(connectionId)",
            hostId: connectionId
        )
        clientTransport = pair.client
        hostTransport = pair.host
        localEngineBuildId = GhosttyManualSurface.engineBuildId()
        precondition(
            !localEngineBuildId.isEmpty,
            "FakeHost requires hive_ghostty_engine_build_id_v1 (GhosttyKit linked)"
        )
    }

    func harvestViewerFrames() throws {
        while true {
            do {
                guard let frame = try hostTransport.receive(timeout: 0.01) else { break }
                receivedFromViewer.append(frame)
            } catch WireError.receiveTimeout {
                break
            }
        }
    }

    func enqueueWelcome(instanceId: String, connectionId: String) throws {
        let payload: [String: Any] = [
            "schemaVersion": 1,
            "protocol": ["major": 1, "minor": 0],
            "instanceId": instanceId,
            "endpointRole": "host",
            "buildId": "fake-host",
            "engineBuildId": localEngineBuildId,
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
    /// Engine id is the real local digest — exercises the production gate (MF2).
    func enqueueSnapshotEnvelope(throughSeq: UInt64, enginePayload: Data, chunkSize: Int? = nil) {
        let envelope = CheckpointEnvelope.encode(
            throughSeq: throughSeq,
            payload: enginePayload,
            engineBuildId: localEngineRawBytes()
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
        outputSeq: UInt64 = 0
    ) -> AttachGrant {
        // Locator engine id must match grant/local for the fail-closed gate.
        let pinned = SessionLocator(
            schemaVersion: locator.schemaVersion,
            instanceId: locator.instanceId,
            subjectKind: locator.subjectKind,
            agentId: locator.agentId,
            generation: locator.generation,
            sessionId: locator.sessionId,
            hostKind: locator.hostKind,
            engineBuildId: localEngineBuildId
        )
        return AttachGrant(
            locator: pinned,
            endpoint: "unix:fake-host",
            token: token,
            expiresAt: "2099-01-01T00:00:00.000Z",
            engineBuildId: localEngineBuildId,
            checkpointSeq: checkpointSeq,
            outputSeq: outputSeq,
            operations: ["view", "human-input", "resize"]
        )
    }

    private func localEngineRawBytes() -> Data {
        // engineBuildId_v1 is lowercase hex; wire header stores raw 32 bytes.
        let hex = localEngineBuildId
        var data = Data()
        data.reserveCapacity(32)
        var i = hex.startIndex
        while i < hex.endIndex {
            let j = hex.index(i, offsetBy: 2, limitedBy: hex.endIndex) ?? hex.endIndex
            let byte = UInt8(hex[i..<j], radix: 16) ?? 0
            data.append(byte)
            i = j
        }
        while data.count < 32 { data.append(0) }
        return Data(data.prefix(32))
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
        engineBuildId: GhosttyManualSurface.engineBuildId()
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
