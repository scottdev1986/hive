#if HIVE_QA_BUILD
import AppKit
import HiveTerminalKit

struct QAControlResponse: Codable {
    struct Control: Codable {
        let identifier: String
        let role: String
        let enabled: Bool
        let actionable: Bool
        let functionallyPresent: Bool
    }

    let requestId: String
    let status: String
    let root: String
    let route: String
    let controls: [Control]
    let count: Int
    let terminator: String
    let reason: String?
}

@MainActor
final class QAControl {
    private struct Request: Decodable {
        let requestId: String
        let verb: String
        let identifier: String?
        let input: String?
        let target: String?
        let text: String?
        let title: String?
        let index: Int?
    }

    private let directory: URL
    private weak var surface: WorkspaceShellWindowController?
    private var timer: Timer?

    // The mailbox belongs to the install, not to one run: this process's own
    // HIVE_HOME is its per-run instance directory, while the shell that sends
    // requests resolves the home that holds `instances/`. Both sides must name
    // that same directory or the request is never seen.
    init?(surface: WorkspaceShellWindowController) {
        let environment = ProcessInfo.processInfo.environment
        guard environment["HIVE_QA"] == "1",
              let home = environment["HIVE_DEFAULT_HOME"] else {
            return nil
        }
        directory = URL(fileURLWithPath: home).appendingPathComponent("qa-control")
        self.surface = surface
        try? FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) {
            [weak self] _ in Task { @MainActor in self?.serve() }
        }
    }

    deinit { timer?.invalidate() }

    private func serve() {
        let requestURL = directory.appendingPathComponent("request.json")
        guard let data = try? Data(contentsOf: requestURL),
              let request = try? JSONDecoder().decode(Request.self, from: data) else { return }
        try? FileManager.default.removeItem(at: requestURL)
        guard let surface else { return }
        guard let window = surface.window else { return }
        write(Self.process(
            verb: request.verb,
            identifier: request.identifier,
            input: request.input,
            target: request.target,
            text: request.text,
            itemTitle: request.title,
            itemIndex: request.index,
            window: window,
            terminal: surface.qaAttachedTerminalView,
            route: surface.qaCurrentRoute,
            requestId: request.requestId))
    }

    private func write(_ response: QAControlResponse) {
        guard let data = try? JSONEncoder().encode(response) else { return }
        let target = directory.appendingPathComponent("response.\(response.requestId).json")
        let temporary = directory.appendingPathComponent("response.\(response.requestId).tmp")
        do {
            try data.write(to: temporary, options: .atomic)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600], ofItemAtPath: temporary.path)
            try FileManager.default.moveItem(at: temporary, to: target)
        } catch {}
    }

    // Views are named by their accessibility identifier because that is how
    // the product assigns names: setAccessibilityIdentifier leaves NSView's
    // `identifier` nil, and the two properties never mirror each other, so
    // reading `identifier` here finds none of the shipped views. This reads
    // the property in-process; it drives no out-of-process accessibility API
    // and needs no permission.
    private func enumerate(window: NSWindow?) -> [QAControlResponse.Control] {
        liveViews(window: window).compactMap { view -> QAControlResponse.Control? in
            let identifier = view.accessibilityIdentifier()
            guard !identifier.isEmpty else { return nil }
            let present = functionallyPresent(view, in: window)
            return QAControlResponse.Control(
                identifier: identifier,
                role: view.accessibilityRole()?.rawValue ?? "view",
                enabled: (view as? NSControl)?.isEnabled ?? true,
                actionable: (view as? NSControl)?.action != nil,
                functionallyPresent: present)
        }
    }

    private func liveViews(window: NSWindow?) -> [NSView] {
        guard let root = window?.contentView else { return [] }
        root.layoutSubtreeIfNeeded()
        var views: [NSView] = []
        func visit(_ view: NSView) {
            views.append(view)
            view.subviews.forEach(visit)
        }
        visit(root)
        return views
    }

    private func functionallyPresent(_ view: NSView, in window: NSWindow?) -> Bool {
        guard view.window === window else { return false }
        var currentView: NSView? = view
        var visible = view.bounds
        while let current = currentView, let superview = current.superview {
            if current.isHidden { return false }
            visible = current.convert(visible, to: superview)
            if current is NSClipView || superview is NSClipView {
                visible = visible.intersection(superview.bounds)
            }
            currentView = current.superview
        }
        return !visible.isEmpty
    }

    static func process(
        verb: String,
        identifier: String?,
        input: String?,
        target: String? = nil,
        text: String? = nil,
        itemTitle: String? = nil,
        itemIndex: Int? = nil,
        window: NSWindow,
        terminal: HiveTerminalView? = nil,
        route: String,
        requestId: String
    ) -> QAControlResponse {
        let harness = QAControl(testingWindow: window)
        let controls = harness.enumerate(window: window)
        var status = "ok"
        var reason: String?
        if verb == "invoke" {
            guard let identifier,
                  let view = harness.liveViews(window: window).first(where: {
                      $0.accessibilityIdentifier() == identifier
                  }) else {
                return QAControlResponse(
                    requestId: requestId, status: "fail", root: "hive-workspace-qa-root",
                    route: route, controls: controls, count: controls.count,
                    terminator: "qa-control-end:\(requestId):\(controls.count)",
                    reason: "control not found")
            }
            if let input, let field = view as? NSTextField { field.stringValue = input }
            let control = view as? NSControl
            if control?.isEnabled != true || control?.action == nil
                || !NSApp.sendAction(control!.action!, to: control!.target, from: control!) {
                status = "fail"
                reason = "control is not actionable"
            }
        } else if verb == "select" {
            guard let identifier,
                  let popup = harness.liveViews(window: window).first(where: {
                      $0.accessibilityIdentifier() == identifier
                  }) as? NSPopUpButton else {
                return QAControlResponse(
                    requestId: requestId, status: "fail", root: "hive-workspace-qa-root",
                    route: route, controls: controls, count: controls.count,
                    terminator: "qa-control-end:\(requestId):\(controls.count)",
                    reason: "popup not found")
            }
            guard popup.isEnabled, popup.action != nil else {
                status = "fail"
                reason = "popup is not actionable"
                let after = harness.enumerate(window: window)
                return QAControlResponse(
                    requestId: requestId, status: status, root: "hive-workspace-qa-root",
                    route: route, controls: after, count: after.count,
                    terminator: "qa-control-end:\(requestId):\(after.count)", reason: reason)
            }
            let selected: Bool
            switch (itemTitle, itemIndex) {
            case let (.some(title), nil):
                popup.selectItem(withTitle: title)
                selected = popup.selectedItem?.title == title
            case let (nil, .some(index)) where popup.itemArray.indices.contains(index):
                popup.selectItem(at: index)
                selected = popup.indexOfSelectedItem == index
            case (.some, .some):
                return QAControlResponse(
                    requestId: requestId, status: "refused", root: "hive-workspace-qa-root",
                    route: route, controls: controls, count: controls.count,
                    terminator: "qa-control-end:\(requestId):\(controls.count)",
                    reason: "popup selection is ambiguous")
            default:
                return QAControlResponse(
                    requestId: requestId, status: "refused", root: "hive-workspace-qa-root",
                    route: route, controls: controls, count: controls.count,
                    terminator: "qa-control-end:\(requestId):\(controls.count)",
                    reason: "popup item not found")
            }
            guard selected else {
                return QAControlResponse(
                    requestId: requestId, status: "refused", root: "hive-workspace-qa-root",
                    route: route, controls: controls, count: controls.count,
                    terminator: "qa-control-end:\(requestId):\(controls.count)",
                    reason: "popup item not found")
            }
            if !NSApp.sendAction(popup.action!, to: popup.target, from: popup) {
                status = "fail"
                reason = "popup is not actionable"
            }
        } else if verb == "type" {
            guard target == "queen-terminal", let text, let terminal else {
                return QAControlResponse(
                    requestId: requestId, status: "fail", root: "hive-workspace-qa-root",
                    route: route, controls: controls, count: controls.count,
                    terminator: "qa-control-end:\(requestId):\(controls.count)",
                    reason: "queen terminal not attached")
            }
            terminal.insertText(
                text,
                replacementRange: NSRange(location: NSNotFound, length: 0)
            )
            guard let submit = NSEvent.keyEvent(
                with: .keyDown,
                location: .zero,
                modifierFlags: [],
                timestamp: 0,
                windowNumber: terminal.window?.windowNumber ?? 0,
                context: nil,
                characters: "\r",
                charactersIgnoringModifiers: "\r",
                isARepeat: false,
                keyCode: 0x24
            ) else {
                status = "fail"
                reason = "could not create Return event"
                let after = harness.enumerate(window: window)
                return QAControlResponse(
                    requestId: requestId, status: status, root: "hive-workspace-qa-root",
                    route: route, controls: after, count: after.count,
                    terminator: "qa-control-end:\(requestId):\(after.count)", reason: reason)
            }
            terminal.keyDown(with: submit)
        }
        let after = harness.enumerate(window: window)
        return QAControlResponse(
            requestId: requestId, status: status, root: "hive-workspace-qa-root",
            route: route, controls: after, count: after.count,
            terminator: "qa-control-end:\(requestId):\(after.count)", reason: reason)
    }

    private init(testingWindow: NSWindow) {
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
        surface = nil
    }
}
#endif
