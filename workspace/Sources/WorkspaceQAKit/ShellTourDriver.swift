import AppKit
import HiveWorkspace

/// Drives the visible QA shell through a request directory. A separate process
/// writes one request at a time; this timer stays in common modes so it can
/// close a menu or popup while AppKit is tracking it.
public final class ShellTourDriver {

    private static var active: ShellTourDriver?

    private let surface: any WorkspaceShellQASurface
    private let directory: URL
    private var timer: Timer?

    public static func installIfRequested(surface: any WorkspaceShellQASurface) {
        guard let directory = controlDirectory(arguments: CommandLine.arguments) else { return }
        active = ShellTourDriver(surface: surface, directory: URL(fileURLWithPath: directory))
        active?.start()
    }

    private static func controlDirectory(arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: "--workspace-shell-qa-control"),
              arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }

    private init(surface: any WorkspaceShellQASurface, directory: URL) {
        self.surface = surface
        self.directory = directory
    }

    private func start() {
        let timer = Timer(timeInterval: 0.05, target: self, selector: #selector(poll), userInfo: nil, repeats: true)
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    @objc private func poll() {
        guard let request = pendingRequest() else { return }
        let response = execute(request: request)
        let responseURL = directory.appendingPathComponent(
            request.lastPathComponent.replacingOccurrences(of: "request-", with: "response-"))
        try? response.write(to: responseURL, atomically: true, encoding: .utf8)
        try? FileManager.default.removeItem(at: request)
    }

    private func pendingRequest() -> URL? {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else {
            return nil
        }
        return names.filter { $0.hasPrefix("request-") }.sorted().first.map {
            directory.appendingPathComponent($0)
        }
    }

    private func execute(request: URL) -> String {
        guard let text = try? String(contentsOf: request, encoding: .utf8) else { return "0" }
        let fields = text.trimmingCharacters(in: .newlines).split(separator: "\t", omittingEmptySubsequences: false)
        guard let operation = fields.first else { return "0" }
        let values = fields.dropFirst().map(String.init)
        return execute(operation: String(operation), values: values)
    }

    private func execute(operation: String, values: [String]) -> String {
        guard let window = surface.shellQAWindow else { return "0" }
        switch operation {
        case "window-number":
            return "\(window.windowNumber)"
        case "window-frame":
            let frame = window.frame
            return "\(frame.origin.x),\(frame.origin.y),\(frame.width),\(frame.height)"
        case "window-chrome-hidden":
            return chromeIsHidden(window) ? "1" : "0"
        case "window-fills-screen":
            guard let screen = window.screen else { return "0" }
            return window.frame.width >= screen.visibleFrame.width
                && window.frame.height >= screen.visibleFrame.height ? "1" : "0"
        case "zoom-window":
            guard let screen = window.screen ?? NSScreen.main else { return "0" }
            window.setFrame(screen.visibleFrame, display: true)
            window.contentView?.layoutSubtreeIfNeeded()
            return "1"
        case "route":
            return values.count == 1 && surface.selectShellQARoute(named: values[0]) ? "1" : "0"
        case "live-run-workbench":
            return surface.shellQAHasLiveRunWorkbench ? "1" : "0"
        case "open-menu":
            return values.count == 1 && openMenu(named: values[0], in: window) ? "1" : "0"
        case "close-menu":
            return values.count == 1 && closeMenu(named: values[0]) ? "1" : "0"
        case "invoke-menu-item":
            return values.count == 2 && invokeMenuItem(menu: values[0], item: values[1]) ? "1" : "0"
        case "open-popup-exact":
            return values.count == 1 && openPopup(identifier: values[0], prefix: false, in: window) ? "1" : "0"
        case "open-popup-prefix":
            return values.count == 1 && openPopup(identifier: values[0], prefix: true, in: window) ? "1" : "0"
        case "close-popup-exact":
            return values.count == 1 && closePopup(identifier: values[0], prefix: false, in: window) ? "1" : "0"
        case "close-popup-prefix":
            return values.count == 1 && closePopup(identifier: values[0], prefix: true, in: window) ? "1" : "0"
        case "select-popup-exact":
            return values.count == 1 ? selectPopup(identifier: values[0], prefix: false, in: window) : "0"
        case "select-popup-prefix":
            return values.count == 1 ? selectPopup(identifier: values[0], prefix: true, in: window) : "0"
        case "popup-selected-exact":
            return popupSelection(values: values, prefix: false, window: window)
        case "popup-selected-prefix":
            return popupSelection(values: values, prefix: true, window: window)
        case "view-exists":
            return values.count == 1 && view(identifier: values[0], prefix: false, in: window) != nil ? "1" : "0"
        case "set-text":
            return values.count == 2 && setText(identifier: values[0], value: values[1], in: window) ? "1" : "0"
        case "attach-dialog":
            return attachVisibleDialog(to: window)
        case "close-dialog":
            return closeVisibleDialog(from: window) ? "1" : "0"
        case "capture":
            return values.count == 1 ? capture(window: window, path: values[0]) : "0"
        default:
            return "0"
        }
    }

    private func chromeIsHidden(_ window: NSWindow) -> Bool {
        window.toolbar == nil
            && window.titlebarAppearsTransparent
            && window.titleVisibility == .hidden
            && window.standardWindowButton(.closeButton)?.isHidden == true
            && window.standardWindowButton(.miniaturizeButton)?.isHidden == true
            && window.standardWindowButton(.zoomButton)?.isHidden == true
    }

    private func view(identifier: String, prefix: Bool, in window: NSWindow) -> NSView? {
        guard let root = window.contentView else { return nil }
        var queue = [root]
        while !queue.isEmpty {
            let candidate = queue.removeFirst()
            let candidateID = candidate.accessibilityIdentifier()
            if prefix ? candidateID.hasPrefix(identifier) : candidateID == identifier {
                return candidate
            }
            queue.append(contentsOf: candidate.subviews)
        }
        return nil
    }

    private func menu(named title: String) -> NSMenu? {
        NSApp.mainMenu?.items.first(where: { $0.submenu?.title == title })?.submenu
    }

    private func openMenu(named title: String, in window: NSWindow) -> Bool {
        guard let menu = menu(named: title), let host = window.contentView else { return false }
        DispatchQueue.main.async {
            menu.popUp(positioning: nil, at: NSPoint(x: 8, y: host.bounds.height - 8), in: host)
        }
        return true
    }

    private func closeMenu(named title: String) -> Bool {
        guard let menu = menu(named: title) else { return false }
        menu.cancelTrackingWithoutAnimation()
        return true
    }

    private func invokeMenuItem(menu title: String, item: String) -> Bool {
        guard let item = menu(named: title)?.items.first(where: { $0.title == item }),
              let action = item.action else {
            return false
        }
        DispatchQueue.main.async {
            NSApp.sendAction(action, to: item.target, from: item)
        }
        return true
    }

    private func popup(identifier: String, prefix: Bool, in window: NSWindow) -> NSPopUpButton? {
        guard let popup = view(identifier: identifier, prefix: prefix, in: window) as? NSPopUpButton,
              popup.isEnabled else { return nil }
        return popup
    }

    private func openPopup(identifier: String, prefix: Bool, in window: NSWindow) -> Bool {
        guard let popup = popup(identifier: identifier, prefix: prefix, in: window) else { return false }
        DispatchQueue.main.async { popup.performClick(nil) }
        return true
    }

    private func closePopup(identifier: String, prefix: Bool, in window: NSWindow) -> Bool {
        guard let popup = popup(identifier: identifier, prefix: prefix, in: window) else { return false }
        popup.menu?.cancelTrackingWithoutAnimation()
        return true
    }

    private func selectPopup(identifier: String, prefix: Bool, in window: NSWindow) -> String {
        guard let popup = popup(identifier: identifier, prefix: prefix, in: window), popup.numberOfItems > 1 else {
            return "0"
        }
        let index = (popup.indexOfSelectedItem + 1) % popup.numberOfItems
        popup.selectItem(at: index)
        popup.sendAction(popup.action, to: popup.target)
        return "\(index + 1)"
    }

    private func popupSelection(values: [String], prefix: Bool, window: NSWindow) -> String {
        guard values.count == 2, let index = Int(values[1]),
              let popup = popup(identifier: values[0], prefix: prefix, in: window) else { return "0" }
        return popup.indexOfSelectedItem == index ? "1" : "0"
    }

    private func setText(identifier: String, value: String, in window: NSWindow) -> Bool {
        guard let field = view(identifier: identifier, prefix: false, in: window) as? NSTextField else {
            return false
        }
        field.stringValue = value
        window.makeFirstResponder(field)
        return field.stringValue == value
    }

    private func visibleDialog(excluding window: NSWindow) -> NSWindow? {
        NSApp.windows.first(where: { $0 != window && $0.isVisible })
    }

    private func attachVisibleDialog(to window: NSWindow) -> String {
        guard let dialog = visibleDialog(excluding: window) else { return "0" }
        window.addChildWindow(dialog, ordered: .above)
        return "\(dialog.windowNumber)"
    }

    private func closeVisibleDialog(from window: NSWindow) -> Bool {
        guard let dialog = visibleDialog(excluding: window) else { return false }
        window.removeChildWindow(dialog)
        dialog.close()
        return !dialog.isVisible
    }

    private func capture(window: NSWindow, path: String) -> String {
        guard let screen = window.screen else { return "0" }
        let frame = window.frame.intersection(screen.visibleFrame)
        guard !frame.isNull, !frame.isEmpty else { return "0" }
        let captureRect = CGRect(
            x: frame.minX,
            y: screen.frame.maxY - frame.maxY,
            width: frame.width,
            height: frame.height)
        let options: CGWindowListOption = visibleDialog(excluding: window) == nil
            ? .optionIncludingWindow
            : [.optionOnScreenAboveWindow, .optionIncludingWindow]
        guard let image = CGWindowListCreateImage(
            captureRect,
            options,
            CGWindowID(window.windowNumber),
            .bestResolution),
            let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            return "0"
        }
        do {
            try data.write(to: URL(fileURLWithPath: path))
            return "\(image.width)x\(image.height)"
        } catch {
            return "0"
        }
    }
}
