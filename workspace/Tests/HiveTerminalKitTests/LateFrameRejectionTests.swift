import XCTest
@testable import HiveTerminalKit

/// LATE-FRAME positive control (§06/§26): deliver a frame bound to an OLD
/// locator/generation to a retargeted surface and prove it is rejected
/// (not applied).
///
/// Uses: FakeManualSurface (no GhosttyKit).
final class LateFrameRejectionTests: XCTestCase {
    func testLateFrameForOldBindingIsRejectedNotApplied() {
        let engine = FakeManualSurface()
        let view = HiveTerminalView(frame: NSRect(x: 0, y: 0, width: 200, height: 100), engine: engine)

        let oldLocator = makeTestLocator(generation: 1, sessionSuffix: "11111111-7111-4111-8111-111111111111")
        let newLocator = makeTestLocator(generation: 2, sessionSuffix: "22222222-7222-4222-8222-222222222222")
        let oldBinding = SurfaceBinding(locator: oldLocator, connectionId: "conn-old")
        let newBinding = SurfaceBinding(locator: newLocator, connectionId: "conn-new")

        // Bind to old, apply a frame successfully.
        view.retarget(to: oldBinding, highWater: 0)
        let first = view.applyOutput(
            bytes: Data("hello".utf8),
            streamSeq: 0,
            frameBinding: oldBinding
        )
        XCTAssertEqual(first, .applied(newHighWater: 5))
        XCTAssertEqual(engine.appliedRanges.count, 1)

        // Retarget to new generation/connection.
        view.retarget(to: newBinding, highWater: 0)
        XCTAssertEqual(view.binding, newBinding)

        // LATE FRAME: host still delivers a frame tagged for the old binding.
        let late = view.applyOutput(
            bytes: Data("LATE-FRAME-BYTES".utf8),
            streamSeq: 5,
            frameBinding: oldBinding
        )

        guard case .rejectedWrongBinding(let evidence) = late else {
            XCTFail("late frame must be rejectedWrongBinding, got \(late)")
            return
        }
        XCTAssertTrue(
            evidence.contains("conn-old") || evidence.contains(oldLocator.sessionId),
            "evidence should name the mismatched binding: \(evidence)"
        )
        // Positive control: engine must NOT have applied the late bytes.
        XCTAssertEqual(
            engine.appliedRanges.count,
            1,
            "late frame must not reach process_output on the retargeted surface"
        )
        XCTAssertEqual(engine.appliedRanges.last?.bytes, Data("hello".utf8))
        XCTAssertNotEqual(view.highWater, 5 + UInt64("LATE-FRAME-BYTES".utf8.count))
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
