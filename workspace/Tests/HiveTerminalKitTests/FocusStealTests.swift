import AppKit
import XCTest
@testable import HiveTerminalKit

/// FOCUS-STEAL positive control (§07/§26): fire output/status/reconnect and
/// prove first responder did NOT change.
///
/// Uses: FakeManualSurface + real NSWindow (no GhosttyKit).
final class FocusStealTests: XCTestCase {
    func testOutputStatusReconnectNeverStealFocus() {
        let engine = FakeManualSurface()
        let terminal = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 300),
            engine: engine
        )
        let other = NSView(frame: NSRect(x: 0, y: 0, width: 50, height: 50))

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 500, height: 400),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        let content = NSView(frame: window.contentView!.bounds)
        content.addSubview(terminal)
        content.addSubview(other)
        window.contentView = content
        window.makeKeyAndOrderFront(nil)

        // Explicitly put first responder on `other` — not the terminal.
        XCTAssertTrue(window.makeFirstResponder(other))
        XCTAssertTrue(window.firstResponder === other)

        // Fire the events that MUST NOT steal focus.
        terminal.notifyOutputStatusReconnect(reason: "output")
        terminal.applyStatusUpdate(evidence: "agent-busy")
        terminal.retarget(
            to: SurfaceBinding(locator: makeTestLocator(), connectionId: "reconnect-1"),
            highWater: 0
        )
        // Simulate first-correct-frame notification path.
        terminal.notifyOutputStatusReconnect(reason: "first-correct-frame")

        XCTAssertTrue(
            window.firstResponder === other,
            "output/status/reconnect must not change first responder"
        )
        XCTAssertEqual(
            terminal.focusStealAttempts,
            0,
            "production path must not attempt focus steal"
        )
        XCTAssertFalse(window.firstResponder === terminal)
    }

    func testPositiveControlBuggyPathWouldStealFocus() {
        // Positive control: when the test harness enables the steal path,
        // first responder DOES change — proving the assertion above can observe a steal.
        let engine = FakeManualSurface()
        let terminal = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 300),
            engine: engine
        )
        terminal.testingAllowFocusSteal = true
        let other = NSView(frame: NSRect(x: 0, y: 0, width: 50, height: 50))

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 500, height: 400),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        let content = NSView(frame: window.contentView!.bounds)
        content.addSubview(terminal)
        content.addSubview(other)
        window.contentView = content

        XCTAssertTrue(window.makeFirstResponder(other))
        terminal.notifyOutputStatusReconnect(reason: "output")
        XCTAssertEqual(terminal.focusStealAttempts, 1)
        XCTAssertTrue(
            window.firstResponder === terminal,
            "positive control: steal path must be observable as first-responder change"
        )
    }

    func testExplicitClickBecomesFirstResponder() {
        let engine = FakeManualSurface()
        let terminal = HiveTerminalView(
            frame: NSRect(x: 0, y: 0, width: 400, height: 300),
            engine: engine
        )
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 500, height: 400),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView = terminal
        terminal.focusExplicitly()
        XCTAssertTrue(window.firstResponder === terminal)
        XCTAssertEqual(engine.focusCalls.last, true)
    }
}
