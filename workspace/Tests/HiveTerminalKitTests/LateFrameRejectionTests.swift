import XCTest
@testable import HiveTerminalKit

/// Exact-mapping positive controls (§06/§26): one view never changes locator
/// or generation; reconnect changes only the connection fence.
///
/// Uses: FakeManualSurface (no GhosttyKit).
final class LateFrameRejectionTests: XCTestCase {
    func testDifferentLocatorIsRejectedWithoutMutatingSurface() throws {
        let engine = FakeManualSurface()
        let view = HiveTerminalView(frame: NSRect(x: 0, y: 0, width: 200, height: 100), engine: engine)

        let oldLocator = makeTestLocator(generation: 1, sessionSuffix: "11111111-7111-4111-8111-111111111111")
        let newLocator = makeTestLocator(generation: 2, sessionSuffix: "22222222-7222-4222-8222-222222222222")
        let oldBinding = SurfaceBinding(locator: oldLocator, connectionId: "conn-old")
        let newBinding = SurfaceBinding(locator: newLocator, connectionId: "conn-new")

        // Bind to old, apply a frame successfully.
        try view.bind(to: oldBinding, highWater: 0)
        let first = view.applyOutput(
            bytes: Data("hello".utf8),
            streamSeq: 0,
            frameBinding: oldBinding
        )
        XCTAssertEqual(first, .applied(newHighWater: 5))
        XCTAssertEqual(engine.appliedRanges.count, 1)

        XCTAssertThrowsError(try view.bind(to: newBinding, highWater: 0)) { error in
            guard case HiveTerminalBindingError.locatorChanged(let expected, let attempted) = error else {
                return XCTFail("expected locatorChanged, got \(error)")
            }
            XCTAssertEqual(expected, oldLocator)
            XCTAssertEqual(attempted, newLocator)
        }
        XCTAssertEqual(view.binding, oldBinding)
        XCTAssertEqual(view.sessionLocator, oldLocator)

        // A frame for the refused locator must never reach the existing surface.
        let late = view.applyOutput(
            bytes: Data("LATE-FRAME-BYTES".utf8),
            streamSeq: 5,
            frameBinding: newBinding
        )

        guard case .rejectedWrongBinding(let evidence) = late else {
            XCTFail("late frame must be rejectedWrongBinding, got \(late)")
            return
        }
        XCTAssertTrue(
            evidence.contains("conn-new") || evidence.contains(newLocator.sessionId),
            "evidence should name the mismatched binding: \(evidence)"
        )
        // Positive control: engine must NOT have applied the late bytes.
        XCTAssertEqual(
            engine.appliedRanges.count,
            1,
            "foreign-locator frame must not reach process_output on the fixed surface"
        )
        XCTAssertEqual(engine.appliedRanges.last?.bytes, Data("hello".utf8))
        XCTAssertNotEqual(view.highWater, 5 + UInt64("LATE-FRAME-BYTES".utf8.count))
    }

    func testSameLocatorReconnectRejectsOldConnectionFrame() throws {
        let engine = FakeManualSurface()
        let view = HiveTerminalView(frame: NSRect(x: 0, y: 0, width: 200, height: 100), engine: engine)
        let locator = makeTestLocator(generation: 1)
        let oldBinding = SurfaceBinding(locator: locator, connectionId: "c-old")
        let newBinding = SurfaceBinding(locator: locator, connectionId: "c-new")

        try view.bind(to: oldBinding)
        try view.bind(to: newBinding)
        XCTAssertEqual(view.sessionLocator, locator)
        XCTAssertEqual(view.binding, newBinding)

        let late = view.applyOutput(
            bytes: Data("late".utf8),
            streamSeq: 0,
            frameBinding: oldBinding
        )
        guard case .rejectedWrongBinding = late else {
            return XCTFail("old connection must be rejected, got \(late)")
        }
        XCTAssertTrue(engine.appliedRanges.isEmpty)
    }

    func testLateFrameViaAttachClientHandleFrame() throws {
        let engine = FakeManualSurface()
        let client = AttachReplayClient(viewerId: "viewer-1", engine: engine)
        let oldLocator = makeTestLocator(generation: 1)
        let newLocator = makeTestLocator(generation: 2, sessionSuffix: "33333333-7333-4333-8333-333333333333")
        let oldBinding = SurfaceBinding(locator: oldLocator, connectionId: "c-old")
        let newBinding = SurfaceBinding(locator: newLocator, connectionId: "c-new")

        client.retarget(newBinding: oldBinding, highWater: 0)
        // Simulate live on old binding.
        let ok = try client.handleFrame(
            WireFrame(type: .output, streamSeq: 0, payload: Data("x".utf8)),
            frameBinding: oldBinding
        )
        XCTAssertEqual(ok, .firstCorrectFrame(highWater: 1, connectionId: "c-old"))

        client.retarget(newBinding: newBinding, highWater: 0)
        let late = try client.handleFrame(
            WireFrame(type: .output, streamSeq: 1, payload: Data("late".utf8)),
            frameBinding: oldBinding
        )
        XCTAssertEqual(late, .rejectedLateFrame)
        XCTAssertEqual(engine.appliedRanges.map(\.bytes), [Data("x".utf8)])
    }
}
