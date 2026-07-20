import AppKit
import XCTest
@testable import HiveTerminalKit
@testable import HiveWorkspace
import WorkspaceCore

private let paneStressChunkBytes = 64 * 1024
private let paneStressTargetBytes = 100 * 1024 * 1024

@MainActor
final class PaneOrderedOutputStressTests: XCTestCase {
    func testRealPaneStaysResponsiveThroughOrdered100MiB() async throws {
        let fixture = try makeFixture()
        defer {
            fixture.terminal.userClose()
            fixture.controller.close()
        }

        let finished = expectation(description: "100 MiB pane stream finished")
        let outcome = LockedBox<StressOutcome>()
        let terminal = UnsafeSendable(fixture.terminal)
        let binding = fixture.binding
        let started = ProcessInfo.processInfo.systemUptime

        var heartbeatCount = 0
        var maxHeartbeatGap: TimeInterval = 0
        var lastHeartbeat = started
        let heartbeat = Timer(timeInterval: 0.01, repeats: true) { _ in
            let now = ProcessInfo.processInfo.systemUptime
            maxHeartbeatGap = max(maxHeartbeatGap, now - lastHeartbeat)
            lastHeartbeat = now
            heartbeatCount += 1
        }
        RunLoop.main.add(heartbeat, forMode: .common)

        DispatchQueue.global(qos: .userInitiated).async {
            var volumeBytes: UInt64 = 0
            var chunks = 0
            var failure: String?
            while Int(volumeBytes) < paneStressTargetBytes {
                let payload = Self.payload(block: chunks)
                let streamSeq = fixture.initialHighWater + volumeBytes
                let expected = streamSeq + UInt64(payload.count)
                let highWater = DispatchQueue.main.sync {
                    terminal.value.pumpHostFrame(
                        WireFrame(
                            type: .output,
                            flags: [.contentSensitive],
                            streamSeq: streamSeq,
                            payload: payload
                        ),
                        frameBinding: binding
                    )
                    return terminal.value.highWater
                }
                guard highWater == expected else {
                    failure = "chunk \(chunks) at \(streamSeq) ended at \(highWater), expected \(expected)"
                    break
                }
                volumeBytes += UInt64(payload.count)
                chunks += 1
            }
            outcome.set(StressOutcome(
                bytes: volumeBytes,
                chunks: chunks,
                finalHighWater: fixture.initialHighWater + volumeBytes,
                failure: failure
            ))
            finished.fulfill()
        }

        await fulfillment(of: [finished], timeout: 45)
        heartbeat.invalidate()
        let result = try XCTUnwrap(outcome.get())
        let duration = ProcessInfo.processInfo.systemUptime - started
        let runID = ProcessInfo.processInfo.environment["HIVE_B25_STRESS_RUN_ID"] ?? "direct"

        XCTAssertNil(result.failure)
        XCTAssertEqual(result.bytes, UInt64(paneStressTargetBytes))
        XCTAssertEqual(result.chunks, paneStressTargetBytes / paneStressChunkBytes)
        XCTAssertEqual(fixture.terminal.highWater, result.finalHighWater)
        XCTAssertEqual(fixture.engine.throughSeq, result.finalHighWater)
        XCTAssertGreaterThan(heartbeatCount, 10, "main run loop did not remain observably responsive")
        XCTAssertLessThan(maxHeartbeatGap, 0.5, "pane blocked the main thread for \(maxHeartbeatGap)s")
        XCTAssertEqual(
            fixture.transport.sent.filter { $0.type == .applied }.count,
            result.chunks + 1,
            "initial attach plus every pane frame must be acknowledged"
        )

        let sentinel = Data("\u{1B}[2J\u{1B}[HB25-PANE-100MIB-FINAL\r\n".utf8)
        fixture.terminal.pumpHostFrame(
            WireFrame(
                type: .output,
                flags: [.contentSensitive],
                streamSeq: result.finalHighWater,
                payload: sentinel
            ),
            frameBinding: fixture.binding
        )
        XCTAssertEqual(fixture.terminal.highWater, result.finalHighWater + UInt64(sentinel.count))
        XCTAssertTrue(fixture.engine.readScreenText().contains("B25-PANE-100MIB-FINAL"))
        XCTAssertTrue(fixture.terminal.window === fixture.controller.window)
        XCTAssertTrue(fixture.terminal.isDescendant(of: fixture.pane))

        print(
            "B25 PANE 100MIB: bytes=\(result.bytes) chunks=\(result.chunks) "
                + "runID=\(runID) "
                + "duration=\(String(format: "%.3f", duration))s "
                + "heartbeats=\(heartbeatCount) "
                + "maxHeartbeatGap=\(String(format: "%.4f", maxHeartbeatGap))s "
                + "streamHighWater=\(result.finalHighWater) "
                + "stressAppliedAcks=\(result.chunks + 1) "
                + "finalAppliedAcks=\(fixture.transport.sent.filter { $0.type == .applied }.count)"
        )
    }

    func testOneByteSequenceGapBreaksThePaneRow() throws {
        let fixture = try makeFixture()
        defer {
            fixture.terminal.userClose()
            fixture.controller.close()
        }

        let before = fixture.terminal.highWater
        fixture.terminal.pumpHostFrame(
            WireFrame(
                type: .output,
                flags: [.contentSensitive],
                streamSeq: before + 1,
                payload: Data("mutated-gap".utf8)
            ),
            frameBinding: fixture.binding
        )
        XCTAssertEqual(fixture.terminal.highWater, before)
        XCTAssertEqual(fixture.engine.throughSeq, before)
        XCTAssertEqual(fixture.terminal.surfaceState, .lost(evidence: "REBASE_REQUIRED"))
        print("B25 PANE MUTATION: one-byte sequence gap rejected at highWater=\(before)")
    }

    private func makeFixture() throws -> Fixture {
        _ = NSApplication.shared
        let controller = ProjectWindowController(
            state: ProjectState(projectID: "b25-stress", displayName: "B2.5 Stress"),
            attentionCenter: AttentionCenter(),
            projectDirectory: "/tmp",
            hivePath: "/usr/bin/false",
            daemonPort: 43_145,
            orchestrator: "claude",
            orchestratorSession: nil,
            instanceID: "b25-stress-instance",
            instanceHome: "/tmp/hb25-stress"
        )
        controller.window?.isReleasedWhenClosed = false
        controller.bootstrapOrchestrator()

        let engineBuildID = HiveTerminalEngineIdentity.current.buildId
        let locator = AgentSessionLocator(
            instanceId: "b25-stress-instance",
            subject: AgentSessionSubject(kind: "agent", agentId: "agent-aria"),
            generation: 1,
            sessionId: "ses_019f7e00-0000-7000-8000-000000000100",
            hostKind: "sessiond",
            engineBuildId: engineBuildID
        )
        controller.applyFeed([
            AgentSnapshot(
                id: "agent-aria",
                name: "aria",
                status: "working",
                sessionLocator: locator
            ),
        ])
        controller.window?.layoutIfNeeded()

        let paneID = ProjectState.paneID(forAgent: "aria")
        let root = try XCTUnwrap(controller.window?.contentView)
        let pane = try XCTUnwrap(findPane(paneID, in: root))
        let engine = try GhosttyBridgeFactory.makeManualSurfaceForTesting(
            widthPx: 800,
            heightPx: 480,
            terminalReplies: .disabled
        )
        let terminal = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 800, height: 480),
            engine: engine,
            viewerId: "b25-pane-stress"
        )
        pane.contentView.addSubview(terminal)
        let binding = SurfaceBinding(
            locator: SessionLocator(
                instanceId: locator.instanceId,
                subjectKind: locator.subject.kind,
                agentId: locator.subject.agentId,
                generation: locator.generation,
                sessionId: locator.sessionId,
                hostKind: locator.hostKind,
                engineBuildId: engineBuildID
            ),
            connectionId: "b25-pane-stress"
        )
        let transport = PaneStressHostTransport(connectionId: binding.connectionId)
        transport.enqueue(WireFrame(type: .welcome))
        let initial = Data("B25-PANE-ATTACHED\r\n".utf8)
        transport.enqueue(WireFrame(
            type: .output,
            flags: [.contentSensitive],
            streamSeq: 0,
            payload: initial
        ))
        terminal.prepareThemeBeforeAttach()
        let attach = try terminal.attach(
            grant: AttachGrant(
                locator: binding.locator,
                endpoint: "unix:b25-pane-stress",
                token: "b25-pane-stress-grant",
                expiresAt: "2099-01-01T00:00:00.000Z",
                engineBuildId: engineBuildID,
                checkpointSeq: 0,
                outputSeq: UInt64(initial.count),
                operations: ["view", "resize"]
            ),
            geometry: TerminalGeometry(
                columns: 80,
                rows: 24,
                widthPx: 800,
                heightPx: 480,
                cellWidthPx: 10,
                cellHeightPx: 20
            ),
            transport: transport
        )
        guard case .firstCorrectFrame(let highWater, _) = attach else {
            XCTFail("pane attach failed: \(attach)")
            throw PaneStressError.attachFailed
        }
        XCTAssertEqual(highWater, UInt64(initial.count))
        return Fixture(
            controller: controller,
            pane: pane,
            terminal: terminal,
            engine: engine,
            binding: binding,
            transport: transport,
            initialHighWater: highWater
        )
    }

    private func findPane(_ paneID: PaneID, in root: NSView) -> PaneView? {
        if let pane = root as? PaneView, pane.paneID == paneID { return pane }
        for child in root.subviews {
            if let pane = findPane(paneID, in: child) { return pane }
        }
        return nil
    }

    nonisolated private static func payload(block: Int) -> Data {
        var bytes = Data(count: paneStressChunkBytes)
        bytes.withUnsafeMutableBytes { raw in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return }
            for index in 0..<paneStressChunkBytes {
                base[index] = UInt8(33 + ((block &* 17 &+ index) % 90))
            }
        }
        let prefix = Data("\u{1B}[2J\u{1B}[HB25-PANE-BLOCK-\(block)\r\n".utf8)
        bytes.replaceSubrange(0..<prefix.count, with: prefix)
        return bytes
    }
}

private struct Fixture {
    let controller: ProjectWindowController
    let pane: PaneView
    let terminal: HiveTerminalView
    let engine: GhosttyManualSurface
    let binding: SurfaceBinding
    let transport: PaneStressHostTransport
    let initialHighWater: UInt64
}

private struct StressOutcome: Sendable {
    let bytes: UInt64
    let chunks: Int
    let finalHighWater: UInt64
    let failure: String?
}

private enum PaneStressError: Error {
    case attachFailed
}

private final class PaneStressHostTransport: HostTransport {
    let connectionId: String
    private(set) var isClosed = false
    private(set) var sent: [WireFrame] = []
    private var inbound: [WireFrame] = []

    init(connectionId: String) {
        self.connectionId = connectionId
    }

    func enqueue(_ frame: WireFrame) {
        inbound.append(frame)
    }

    func send(_ frame: WireFrame) throws {
        guard !isClosed else { throw WireError.closed }
        sent.append(frame)
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

private struct UnsafeSendable<Value>: @unchecked Sendable {
    let value: Value

    init(_ value: Value) {
        self.value = value
    }
}

private final class LockedBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value?

    func set(_ value: Value) {
        lock.lock()
        self.value = value
        lock.unlock()
    }

    func get() -> Value? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}
