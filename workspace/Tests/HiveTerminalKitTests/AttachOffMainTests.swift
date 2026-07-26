import AppKit
import XCTest
@testable import HiveTerminalKit

/// A host that never answers. `AttachReplayClient.attach` blocks in
/// `transport.receive` until a frame arrives or `handshakeTimeout` (5 s)
/// expires, and a terminal that has produced nothing yet — a freshly created
/// one, an idle provider — sends nothing.
private final class SilentHostTransport: HostTransport, @unchecked Sendable {
    let connectionId: String
    private(set) var isClosed = false
    private(set) var receiveCalls = 0
    private let block: TimeInterval

    init(connectionId: String, block: TimeInterval) {
        self.connectionId = connectionId
        self.block = block
    }

    func send(_ frame: WireFrame) throws {}

    func receive(timeout: TimeInterval?) throws -> WireFrame? {
        receiveCalls += 1
        Thread.sleep(forTimeInterval: min(block, timeout ?? block))
        throw WireError.receiveTimeout
    }

    func close() { isClosed = true }
}

/// The attach handshake must not be main-thread work.
///
/// Measured with real vendor TUIs on real PTYs (`prototypes/terminal`,
/// proto-viewer): with the handshake on main, two panes attached to hosts that
/// had produced no output stalled the main queue for 10,000 ms — a ten-second
/// frozen workspace, five seconds per pane, serially. With the same run driven
/// off main the worst main-queue stall was 1.9 ms and the panes attached
/// concurrently.
///
/// `SessiondPaneTerminal` now runs `client.attach` on a background queue between
/// the two main-thread halves below. These rows pin what makes that safe: the
/// halves never touch the transport, so nothing that can block is left on main.
final class AttachOffMainTests: XCTestCase {
    func testTheMainThreadHalvesOfAttachNeverTouchTheTransport() throws {
        _ = NSApplication.shared
        let host = FakeHost(connectionId: "silent-attach")
        let transport = SilentHostTransport(connectionId: "silent-attach", block: 0.4)
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 800, height: 480),
            engine: FakeManualSurface(),
            viewerId: "silent-viewer"
        )
        let grant = host.makeGrant(locator: makeTestLocator())

        let prepareStarted = ProcessInfo.processInfo.systemUptime
        let client = try view.prepareAttach(grant: grant, afterSeq: 0, transport: transport)
        let prepareSeconds = ProcessInfo.processInfo.systemUptime - prepareStarted

        XCTAssertEqual(
            transport.receiveCalls,
            0,
            "prepareAttach read from the transport; the blocking wait is back on the main thread"
        )
        XCTAssertLessThan(prepareSeconds, 0.1, "prepareAttach took \(prepareSeconds)s on the main thread")
        XCTAssertEqual(view.surfaceState, .attaching)
        XCTAssertNotNil(view.binding, "the locator fence must be admitted before any byte is applied")

        // The wait itself: entirely inside client.attach, which the pane runs
        // off main. Driven here from a background thread, the main queue must
        // stay schedulable throughout.
        let finished = expectation(description: "handshake finished off main")
        DispatchQueue.global(qos: .userInitiated).async {
            _ = try? client.attach(
                grant: grant,
                geometry: makeGeometry(),
                afterSeq: 0,
                transport: transport
            )
            finished.fulfill()
        }

        var worstHop: TimeInterval = 0
        let sampled = expectation(description: "main queue sampled")
        DispatchQueue.global(qos: .userInitiated).async {
            for _ in 0 ..< 40 {
                let queuedAt = ProcessInfo.processInfo.systemUptime
                let hop = DispatchSemaphore(value: 0)
                DispatchQueue.main.async { hop.signal() }
                hop.wait()
                worstHop = max(worstHop, ProcessInfo.processInfo.systemUptime - queuedAt)
                Thread.sleep(forTimeInterval: 0.005)
            }
            sampled.fulfill()
        }

        wait(for: [finished, sampled], timeout: 10)
        XCTAssertGreaterThan(transport.receiveCalls, 0, "the handshake never reached the transport")
        XCTAssertLessThan(
            worstHop,
            0.100,
            "the main queue waited \(worstHop)s while a silent host was attached"
        )
    }

    /// The synchronous entry point still exists and still behaves: tests, the
    /// smoke harness and the live-host suites drive it directly.
    func testSynchronousAttachStillReturnsItsOutcome() throws {
        _ = NSApplication.shared
        let host = FakeHost(connectionId: "sync-attach")
        let locator = makeTestLocator()
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 800, height: 480),
            engine: FakeManualSurface(),
            viewerId: "sync-viewer"
        )
        try host.enqueueWelcome(instanceId: locator.instanceId, connectionId: host.hostTransport.connectionId)
        host.enqueueSnapshotEnvelope(throughSeq: 0, enginePayload: Data("snapshot".utf8))
        host.enqueueOutput(streamSeq: 0, bytes: Data("ready".utf8))

        let outcome = try view.attach(
            grant: host.makeGrant(locator: locator),
            geometry: makeGeometry(),
            transport: host.clientTransport
        )
        guard case .firstCorrectFrame(let highWater, _) = outcome else {
            return XCTFail("synchronous attach did not reach a first correct frame: \(outcome)")
        }
        XCTAssertEqual(highWater, UInt64("ready".utf8.count))
        XCTAssertEqual(view.highWater, highWater)
    }
}
