#if HIVE_QA_BUILD
import AppKit
import XCTest
@testable import HiveWorkspace

@MainActor
final class QAControlTests: XCTestCase {
    private final class Target: NSObject {
        var sender: NSButton?
        @objc func fire(_ sender: NSButton) { self.sender = sender }
    }

    private final class PopupTarget: NSObject {
        var sender: NSPopUpButton?
        @objc func choose(_ sender: NSPopUpButton) { self.sender = sender }
    }

    func testInvokeFiresTheLiveControlsOwnTargetAction() {
        let target = Target()
        let button = NSButton(title: "Models & Quota", target: target, action: #selector(Target.fire(_:)))
        button.setAccessibilityIdentifier("shell-nav-models")
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
        button.setAccessibilityIdentifier("shell-nav-models")
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

    func testSelectChoosesPopupItemByTitleAndFiresItsOwnTargetAction() {
        let target = PopupTarget()
        let popup = NSPopUpButton()
        popup.addItems(withTitles: ["First", "Second"])
        popup.setAccessibilityIdentifier("task-router-mode")
        popup.target = target
        popup.action = #selector(PopupTarget.choose(_:))
        popup.frame = NSRect(x: 10, y: 10, width: 120, height: 30)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200),
                              styleMask: .titled, backing: .buffered, defer: false)
        window.contentView?.addSubview(popup)

        let response = QAControl.process(
            verb: "select", identifier: "task-router-mode", input: nil,
            itemTitle: "Second", itemIndex: nil,
            window: window, route: "router", requestId: "request")

        XCTAssertEqual(response.status, "ok")
        XCTAssertEqual(popup.selectedItem?.title, "Second")
        XCTAssertTrue(target.sender === popup)
    }

    func testSelectChoosesPopupItemByIndexAndFiresItsOwnTargetAction() {
        let target = PopupTarget()
        let popup = NSPopUpButton()
        popup.addItems(withTitles: ["First", "Second"])
        popup.setAccessibilityIdentifier("task-router-mode")
        popup.target = target
        popup.action = #selector(PopupTarget.choose(_:))
        popup.frame = NSRect(x: 10, y: 10, width: 120, height: 30)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200),
                              styleMask: .titled, backing: .buffered, defer: false)
        window.contentView?.addSubview(popup)

        let response = QAControl.process(
            verb: "select", identifier: "task-router-mode", input: nil,
            itemTitle: nil, itemIndex: 1,
            window: window, route: "router", requestId: "request")

        XCTAssertEqual(response.status, "ok")
        XCTAssertEqual(popup.indexOfSelectedItem, 1)
        XCTAssertTrue(target.sender === popup)
    }

    func testSelectRefusesAnUnknownTitleAndOutOfRangeIndex() {
        let popup = NSPopUpButton()
        popup.addItem(withTitle: "First")
        popup.setAccessibilityIdentifier("task-router-mode")
        popup.target = self
        popup.action = #selector(select(_:))
        popup.frame = NSRect(x: 10, y: 10, width: 120, height: 30)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200),
                              styleMask: .titled, backing: .buffered, defer: false)
        window.contentView?.addSubview(popup)

        let unknownTitle = QAControl.process(
            verb: "select", identifier: "task-router-mode", input: nil,
            itemTitle: "Missing", itemIndex: nil,
            window: window, route: "router", requestId: "title")
        let outOfRangeIndex = QAControl.process(
            verb: "select", identifier: "task-router-mode", input: nil,
            itemTitle: nil, itemIndex: 1,
            window: window, route: "router", requestId: "index")

        XCTAssertEqual(unknownTitle.status, "refused")
        XCTAssertEqual(outOfRangeIndex.status, "refused")
    }

    @objc private func select(_ sender: NSPopUpButton) {}
}
#endif
