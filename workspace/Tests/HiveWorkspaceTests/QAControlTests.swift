import AppKit
import XCTest
@testable import HiveWorkspace

@MainActor
final class QAControlTests: XCTestCase {
    private final class Target: NSObject {
        var sender: NSButton?
        @objc func fire(_ sender: NSButton) { self.sender = sender }
    }

    func testInvokeFiresTheLiveControlsOwnTargetAction() {
        let target = Target()
        let button = NSButton(title: "Models & Quota", target: target, action: #selector(Target.fire(_:)))
        button.identifier = NSUserInterfaceItemIdentifier("shell-nav-models")
        button.frame = NSRect(x: 10, y: 10, width: 120, height: 30)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200),
                              styleMask: .titled, backing: .buffered, defer: false)
        window.contentView?.addSubview(button)

        let response = QAControl.process(
            verb: "invoke", identifier: "shell-nav-models", input: nil,
            window: window, route: "models", requestId: "request")

        XCTAssertEqual(response.status, "ok")
        XCTAssertTrue(target.sender === button)
        XCTAssertEqual(response.controls.first?.functionallyPresent, true)
        XCTAssertEqual(response.controls.first?.actionable, true)
    }

    func testAHiddenAncestorDefeatsFunctionalPresence() {
        let button = NSButton(title: "Models & Quota", target: nil, action: nil)
        button.identifier = NSUserInterfaceItemIdentifier("shell-nav-models")
        button.frame = NSRect(x: 10, y: 10, width: 120, height: 30)
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 200))
        container.addSubview(button)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200),
                              styleMask: .titled, backing: .buffered, defer: false)
        window.contentView?.addSubview(container)

        func present() -> Bool? {
            QAControl.process(
                verb: "enumerate", identifier: nil, input: nil,
                window: window, route: "models", requestId: "request"
            ).controls.first { $0.identifier == "shell-nav-models" }?.functionallyPresent
        }

        XCTAssertEqual(present(), true)
        container.isHidden = true
        XCTAssertEqual(present(), false)
    }

    func testUnknownIdentifierIsAMeasuredFailure() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200),
                              styleMask: .titled, backing: .buffered, defer: false)
        let response = QAControl.process(
            verb: "invoke", identifier: "mutated-identifier", input: nil,
            window: window, route: "run", requestId: "request")
        XCTAssertEqual(response.status, "fail")
        XCTAssertEqual(response.reason, "control not found")
    }
}
