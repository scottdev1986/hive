import AppKit
import HiveTerminalKit
import XCTest
@testable import HiveWorkspace
import WorkspaceCore

@MainActor
final class SessiondPaneInputFocusTests: XCTestCase {
    func testRootFeedInstallsAndReplacesExactSessiondGeneration() throws {
        _ = NSApplication.shared
        let buildID = HiveTerminalEngineIdentity.current.buildId
        let state = ProjectState(projectID: "project", displayName: "Project")
        let controller = ProjectWindowController(
            state: state,
            attentionCenter: AttentionCenter(),
            projectDirectory: "/tmp",
            hivePath: "/usr/bin/false",
            daemonPort: 1,
            orchestrator: "claude",
            instanceID: "instance",
            instanceHome: "/tmp")
        controller.window?.isReleasedWhenClosed = false
        defer { controller.close() }
        controller.bootstrapOrchestrator()
        func locator(generation: Int) -> AgentSessionLocator {
            AgentSessionLocator(
                instanceId: "instance",
                subject: AgentSessionSubject(kind: "root"),
                generation: generation,
                sessionId: "ses_0198a8f0-0000-7000-8000-00000000000\(generation)",
                hostKind: "sessiond",
                engineBuildId: buildID)
        }

        let first = locator(generation: 1)
        controller.applyFeed([], orchestrator: OrchestratorSnapshot(
            status: nil, host: "sessiond", hostState: "awaiting-visibility",
            sessionLocator: first))
        let provisionalView = try XCTUnwrap(controller.sessiondTerminalView(
            pane: ProjectState.orchestratorPaneID))
        XCTAssertFalse(controller.sessiondTerminalHasStarted(
            pane: ProjectState.orchestratorPaneID),
            "the provisional surface measures geometry but never attaches")

        controller.applyFeed([], orchestrator: OrchestratorSnapshot(
            status: nil, host: "sessiond", hostState: "awaiting-visibility",
            sessionLocator: first))
        XCTAssertTrue(controller.sessiondTerminalView(
            pane: ProjectState.orchestratorPaneID) === provisionalView)
        XCTAssertFalse(controller.sessiondTerminalHasStarted(
            pane: ProjectState.orchestratorPaneID))

        controller.applyFeed([], orchestrator: OrchestratorSnapshot(
            status: "idle", host: "sessiond", hostState: "running",
            sessionLocator: first))
        let firstView = try XCTUnwrap(controller.sessiondTerminalView(
            pane: ProjectState.orchestratorPaneID))
        XCTAssertTrue(firstView === provisionalView)
        XCTAssertTrue(controller.sessiondTerminalHasStarted(
            pane: ProjectState.orchestratorPaneID))

        controller.applyFeed([], orchestrator: OrchestratorSnapshot(
            status: "idle", host: "sessiond", hostState: "running",
            sessionLocator: locator(generation: 2)))
        let secondView = try XCTUnwrap(controller.sessiondTerminalView(
            pane: ProjectState.orchestratorPaneID))
        XCTAssertFalse(secondView === firstView)
        XCTAssertNil(firstView.superview,
                     "a relaunched root must detach the stale generation renderer")
    }

    func testFocusedSessiondPaneRoutesRealKeyEventThroughClaimAndOutput() throws {
        _ = NSApplication.shared
        let buildID = HiveTerminalEngineIdentity.current.buildId
        XCTAssertFalse(buildID.isEmpty)

        let state = ProjectState(projectID: "project", displayName: "Project")
        let controller = ProjectWindowController(
            state: state,
            attentionCenter: AttentionCenter(),
            projectDirectory: "/tmp",
            hivePath: "/usr/bin/false",
            daemonPort: 1,
            orchestrator: "claude",
            instanceID: "instance",
            instanceHome: "/tmp"
        )
        controller.window?.isReleasedWhenClosed = false
        defer { controller.close() }
        controller.bootstrapOrchestrator()

        let paneID = ProjectState.paneID(forAgent: "aria")
        let locator = AgentSessionLocator(
            instanceId: "instance",
            subject: AgentSessionSubject(kind: "agent", agentId: "agent-aria"),
            generation: 1,
            sessionId: "ses_0198a8f0-0000-7000-8000-000000000001",
            hostKind: "sessiond",
            engineBuildId: buildID
        )
        controller.applyFeed([
            AgentSnapshot(
                id: "agent-aria",
                name: "aria",
                status: "working",
                sessionLocator: locator
            ),
        ])

        let window = try XCTUnwrap(controller.window)
        let root = try XCTUnwrap(window.contentView)
        let terminal = try XCTUnwrap(firstSubview(of: HiveTerminalView.self, in: root))
        let transport = RecordingHostTransport(connectionId: "focus-input")
        let wireLocator = SessionLocator(
            instanceId: locator.instanceId,
            subjectKind: locator.subject.kind,
            agentId: locator.subject.agentId,
            generation: locator.generation,
            sessionId: locator.sessionId,
            hostKind: locator.hostKind,
            engineBuildId: buildID
        )
        transport.enqueue(try welcome(buildID: buildID, instanceID: locator.instanceId))
        transport.enqueue(WireFrame(
            type: .output,
            flags: [.contentSensitive],
            streamSeq: 0,
            payload: Data("ready".utf8)
        ))
        let outcome = try terminal.attach(
            grant: AttachGrant(
                locator: wireLocator,
                endpoint: "unix:test",
                token: "grant-token",
                expiresAt: "2099-01-01T00:00:00.000Z",
                engineBuildId: buildID,
                checkpointSeq: 0,
                outputSeq: 0,
                operations: ["view", "human-input", "resize"]
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
        guard case .firstCorrectFrame = outcome else {
            return XCTFail("sessiond pane did not attach: \(outcome)")
        }
        let binding = try XCTUnwrap(terminal.binding)

        controller.dispatch(.focusPane(paneID))
        XCTAssertTrue(
            window.firstResponder === terminal,
            "sessiond focus must target the actual HiveTerminalView"
        )

        let geometryBeforeResize = terminal.reportedGeometry
        window.setContentSize(NSSize(
            width: window.contentLayoutRect.width + 160,
            height: window.contentLayoutRect.height + 90
        ))
        window.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        XCTAssertNotEqual(terminal.reportedGeometry, geometryBeforeResize)
        XCTAssertTrue(window.firstResponder === terminal)

        let keyEvent = try XCTUnwrap(NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber,
            context: nil,
            characters: "x",
            charactersIgnoringModifiers: "x",
            isARepeat: false,
            keyCode: 7
        ))
        window.sendEvent(keyEvent)
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))

        let claim = try XCTUnwrap(transport.sent.last { $0.type == .claimAcquire })
        terminal.pumpHostFrame(
            WireFrame(
                type: .claimResult,
                flags: [.response, .final],
                requestId: claim.requestId,
                payload: try FrameCodec.jsonPayload([
                    "schemaVersion": 1,
                    "result": [
                        "state": "granted",
                        "claim": ["token": "focus-claim"],
                    ],
                ])
            ),
            frameBinding: binding
        )
        let inputDeadline = Date().addingTimeInterval(1)
        while !transport.sent.contains(where: { $0.type == .inputSubmit }),
              Date() < inputDeadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }

        let input = try XCTUnwrap(transport.sent.last { $0.type == .inputSubmit })
        let inputObject = try FrameCodec.parseJSONObject(input.payload)
        let operation = try XCTUnwrap(inputObject["operation"] as? [String: Any])
        XCTAssertEqual(
            Data(base64Encoded: try XCTUnwrap(operation["bytes"] as? String)),
            Data("x".utf8)
        )

        let transactionID = try XCTUnwrap(inputObject["transactionId"] as? String)
        terminal.pumpHostFrame(
            WireFrame(
                type: .applied,
                flags: [.response, .final],
                requestId: input.requestId,
                payload: try FrameCodec.jsonPayload([
                    "schemaVersion": 1,
                    "resultKind": "input",
                    "receipt": [
                        "transactionId": transactionID,
                        "stage": "written-to-terminal",
                    ],
                ])
            ),
            frameBinding: binding
        )
        let beforeOutput = terminal.highWater
        terminal.pumpHostFrame(
            WireFrame(
                type: .output,
                flags: [.contentSensitive],
                streamSeq: beforeOutput,
                payload: Data("round-trip:x".utf8)
            ),
            frameBinding: binding
        )

        XCTAssertEqual(
            terminal.inputSubmissionState,
            .applied(transactionId: transactionID, stage: "written-to-terminal")
        )
        XCTAssertGreaterThan(terminal.highWater, beforeOutput)
    }

    private func firstSubview<T: NSView>(of type: T.Type, in root: NSView) -> T? {
        if let match = root as? T { return match }
        for child in root.subviews {
            if let match = firstSubview(of: type, in: child) { return match }
        }
        return nil
    }

    private func welcome(buildID: String, instanceID: String) throws -> WireFrame {
        WireFrame(
            type: .welcome,
            flags: [.response, .final],
            requestId: 1,
            payload: try FrameCodec.jsonPayload([
                "schemaVersion": 1,
                "protocol": ["major": 1, "minor": 0],
                "instanceId": instanceID,
                "endpointRole": "host",
                "buildId": "focus-test-host",
                "engineBuildId": buildID,
                "connectionId": "focus-input",
                "serverEpoch": "1",
                "limits": [
                    "controlFrameMaxBytes": FrameCodec.controlFrameMaxBytes,
                    "streamChunkMaxBytes": FrameCodec.streamChunkMaxBytes,
                    "automatedMessageMaxBytes": 1_048_576,
                    "viewerQueueMaxBytes": 4_194_304,
                ],
            ])
        )
    }
}

private final class RecordingHostTransport: HostTransport {
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
        guard !isClosed else { return nil }
        guard !inbound.isEmpty else { throw WireError.receiveTimeout }
        return inbound.removeFirst()
    }

    func close() {
        isClosed = true
        inbound.removeAll()
    }
}
