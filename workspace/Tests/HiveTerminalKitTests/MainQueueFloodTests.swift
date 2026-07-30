import AppKit
import XCTest
@testable import HiveTerminalKit

/// What a flooding pane is allowed to put on the main queue.
///
/// A keystroke is main-queue work, so every block the output path posts is
/// something the next keystroke queues behind. Bridge INVALIDATE deliveries
/// and accessibility exports must collapse and stay on-demand — unbounded
/// per-chunk posts put every keystroke behind a flood of main-queue work.
///
/// These rows pin the two policies in process, where the counts are exact.
///
/// Coalescing lives in `BridgeCallbackContext.enqueueEvent` — the point that
/// actually posts to the main queue. `HiveTerminalView` receives every bridge
/// event already on main, so a collapse there would never run.
final class MainQueueFloodTests: XCTestCase {
    /// Redundant INVALIDATEs that arrive while a delivery is already queued must
    /// collapse into that one delivery. INVALIDATE carries no payload and its
    /// handler is idempotent, so one delivery covers any number of them.
    func testBurstOfInvalidatesCollapsesIntoOneMainQueueDelivery() throws {
        _ = NSApplication.shared
        let engine = FakeManualSurface()
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 800, height: 480),
            engine: engine,
            viewerId: "flood-viewer"
        )
        let deliveriesBefore = engine.callbackContext.invalidateDeliveryCount

        // Posted from off-main, exactly like the terminal I/O thread, and with
        // the main queue unable to run in between: this is the saturated case
        // the coalescing exists for.
        let posted = 500
        let finished = expectation(description: "burst posted")
        DispatchQueue.global(qos: .userInitiated).async {
            for _ in 0 ..< posted {
                engine.callbackContext.enqueueEvent(BridgeEvent(type: .invalidate))
            }
            finished.fulfill()
        }
        wait(for: [finished], timeout: 5)
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))

        let delivered = engine.callbackContext.invalidateDeliveryCount - deliveriesBefore
        XCTAssertGreaterThan(delivered, 0, "the burst never reached the main thread at all")
        XCTAssertLessThan(
            delivered,
            posted / 10,
            "\(posted) INVALIDATEs produced \(delivered) main-queue deliveries; "
                + "redundant invalidates are not being collapsed"
        )
        XCTAssertGreaterThan(view.drawScheduledCount, 0, "collapsing dropped the draw entirely")
    }

    /// Output-driven invalidates must not export the viewport on the main thread
    /// while nothing is consuming accessibility. The export takes Ghostty's
    /// renderer mutex — the lock the I/O thread holds for a whole chunk parse.
    func testInvalidateDoesNotExportTheViewportUntilAnAccessibilityClientReads() throws {
        _ = NSApplication.shared
        let engine = FakeManualSurface()
        let view = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 800, height: 480),
            engine: engine,
            viewerId: "flood-ax-viewer"
        )

        for _ in 0 ..< 50 {
            view.accessibilitySemanticStateDidInvalidate()
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertEqual(
            view.accessibilityExportCount,
            0,
            "the viewport was exported on the main thread with no accessibility client present"
        )

        // A client reads: correctness is unchanged, because the read itself
        // re-exports on demand.
        XCTAssertNotNil(view.accessibilityValue(), "an accessibility read returned nothing")
        let exportsAfterFirstRead = view.accessibilityExportCount
        XCTAssertGreaterThan(exportsAfterFirstRead, 0, "an accessibility read did not export")

        // ...and from then on invalidates notify eagerly again, so a live
        // assistive client still hears output as it arrives.
        view.accessibilitySemanticStateDidInvalidate()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertGreaterThan(
            view.accessibilityExportCount,
            exportsAfterFirstRead,
            "after a client read, an invalidate no longer refreshes accessibility"
        )
    }
}
